/******************************************************************************
 * End-to-end language server test.
 *
 * Spawns the bundled server (extension/server/server.mjs) as a child process
 * and talks JSON-RPC (LSP framing) over stdio: initialize → initialized →
 * tetaue/render → shutdown.
 *
 * Requires `bun run build:server` first (the bundle is git-ignored).
 ******************************************************************************/
import { spawn, execFileSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { URI } from 'langium';

const ROOT = resolve(import.meta.dir, '..');
const SERVER = resolve(ROOT, 'extension', 'server', 'server.mjs');
// Prefer a real node binary when present; otherwise run the bundle with the
// current bun executable so `bun test` works in bun-only environments.
const NODE = process.env.TETAUE_TEST_NODE ?? (Bun.which('node') ?? process.execPath);
// examples/strings.tetaue is the one example that parses with the current grammar.
const EXAMPLE = resolve(ROOT, 'examples', 'strings.tetaue');

// The server bundle is a git-ignored build artifact: build it on demand so a
// fresh clone can run `bun test` without manual steps.
if (!existsSync(SERVER)) {
    execFileSync('bun', ['run', 'build:server'], { cwd: ROOT, stdio: 'inherit' });
}

function frame(message: unknown): Buffer {
    const body = JSON.stringify(message);
    return Buffer.from(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
}

interface RpcResponse {
    id: number;
    result?: Record<string, unknown>;
    error?: { message: string };
}

/** Send a request and await the response with the matching id. */
function request(server: ChildProcessWithoutNullStreams, id: number, method: string, params: unknown): Promise<RpcResponse> {
    server.stdin.write(frame({ jsonrpc: '2.0', id, method, params }));
    return new Promise((resolvePromise, reject) => {
        const timeout = setTimeout(() => reject(new Error(`timeout waiting for response to ${method}`)), 15_000);
        let buffer = Buffer.alloc(0);
        const onData = (chunk: Buffer): void => {
            buffer = Buffer.concat([buffer, chunk]);
            // Parse every complete message currently in the buffer; skip
            // server->client notifications (they carry a `method` field).
            for (;;) {
                const headerEnd = buffer.indexOf('\r\n\r\n');
                if (headerEnd === -1) return;
                const match = /Content-Length: (\d+)/i.exec(buffer.subarray(0, headerEnd).toString('utf8'));
                if (!match) return;
                const length = Number(match[1]);
                if (buffer.length < headerEnd + 4 + length) return;
                const body = buffer.subarray(headerEnd + 4, headerEnd + 4 + length).toString('utf8');
                buffer = buffer.subarray(headerEnd + 4 + length);
                const message = JSON.parse(body) as { id?: number; method?: string };
                if (message.method === undefined && message.id === id) {
                    clearTimeout(timeout);
                    server.stdout.off('data', onData);
                    resolvePromise(message as RpcResponse);
                    return;
                }
            }
        };
        server.stdout.on('data', onData);
    });
}

/** Resolve on the next server→client notification with `method` matching `predicate`. */
function nextNotification<T = Record<string, unknown>>(
    server: ChildProcessWithoutNullStreams,
    method: string,
    predicate: (params: T) => boolean = () => true,
    timeoutMs = 15_000,
): Promise<T> {
    return new Promise((resolvePromise, reject) => {
        const timeout = setTimeout(() => reject(new Error(`timeout waiting for notification ${method}`)), timeoutMs);
        let buffer = Buffer.alloc(0);
        const onData = (chunk: Buffer): void => {
            buffer = Buffer.concat([buffer, chunk]);
            for (;;) {
                const headerEnd = buffer.indexOf('\r\n\r\n');
                if (headerEnd === -1) return;
                const match = /Content-Length: (\d+)/i.exec(buffer.subarray(0, headerEnd).toString('utf8'));
                if (!match) return;
                const length = Number(match[1]);
                if (buffer.length < headerEnd + 4 + length) return;
                const body = buffer.subarray(headerEnd + 4, headerEnd + 4 + length).toString('utf8');
                buffer = buffer.subarray(headerEnd + 4 + length);
                const message = JSON.parse(body) as { method?: string; params?: T };
                if (message.method === method && predicate(message.params as T)) {
                    clearTimeout(timeout);
                    server.stdout.off('data', onData);
                    resolvePromise(message.params as T);
                    return;
                }
            }
        };
        server.stdout.on('data', onData);
    });
}

describe('tetaue language server (LSP over stdio)', () => {
    test('open importers revalidate when a lib file changes', async () => {
        const { mkdtempSync, writeFileSync, rmSync, readFileSync } = require('node:fs') as typeof import('node:fs');
        const { tmpdir } = require('node:os') as typeof import('node:os');
        const { join } = require('node:path') as typeof import('node:path');
        const dir = mkdtempSync(join(tmpdir(), 'tetaue-lsp-'));
        const server = spawn(NODE, [SERVER], { stdio: ['pipe', 'pipe', 'pipe'] });
        const stderr: string[] = [];
        server.stderr.on('data', chunk => stderr.push(chunk.toString('utf8')));
        try {
            const lib = join(dir, 'tables.tetaue');
            writeFileSync(lib, 'export users: query { id: int } = table "users"\n');
            const main = join(dir, 'main.tetaue');
            writeFileSync(main, 'import "tables.tetaue"\nq = users & take 1\n');
            const mainUri = URI.file(main).toString();

            const init = await request(server, 1, 'initialize', { processId: null, rootUri: null, capabilities: {} });
            expect(init.error).toBeUndefined();
            server.stdin.write(frame({ jsonrpc: '2.0', method: 'initialized', params: {} }));

            // Attach the diagnostic listeners BEFORE the events that trigger
            // them (didOpen and the watched-file change both push
            // publishDiagnostics asynchronously).
            const initialP = nextNotification<{ uri: string; diagnostics: { message: string }[] }>(
                server, 'textDocument/publishDiagnostics', p => p.uri === mainUri,
            );
            server.stdin.write(frame({
                jsonrpc: '2.0', method: 'textDocument/didOpen',
                params: { textDocument: { uri: mainUri, languageId: 'tetaue', version: 1, text: readFileSync(main, 'utf8') } },
            }));

            // Initial validation: the open document is clean.
            const initial = await initialP;
            expect(initial.diagnostics).toEqual([]);

            // Introduce an error in the lib, then tell the server the file
            // changed (the client forwards watched-file events).
            const updatedP = nextNotification<{ uri: string; diagnostics: { message: string }[] }>(
                server, 'textDocument/publishDiagnostics',
                p => p.uri === mainUri && p.diagnostics.length > 0,
            );
            writeFileSync(lib, 'export users: query { id: int } = table "users"\nbad = users & filter (u => u.id == "x")\n');
            server.stdin.write(frame({
                jsonrpc: '2.0', method: 'workspace/didChangeWatchedFiles',
                params: { changes: [{ uri: URI.file(lib).toString(), type: 2 }] },
            }));

            const updated = await updatedP;
            expect(updated.diagnostics.map(d => d.message).join('\n')).toContain('cannot compare int with string');

            const shutdown = await request(server, 2, 'shutdown', null);
            expect(shutdown.error).toBeUndefined();
        } finally {
            server.kill();
            rmSync(dir, { recursive: true, force: true });
            if (stderr.length > 0) {
                // eslint-disable-next-line no-console
                console.error('server stderr:\n' + stderr.join(''));
            }
        }
    });

    test('module-qualified completion, definition, and hover across a lib', async () => {
        const { mkdtempSync, writeFileSync, rmSync, readFileSync } = require('node:fs') as typeof import('node:fs');
        const { tmpdir } = require('node:os') as typeof import('node:os');
        const { join } = require('node:path') as typeof import('node:path');
        const dir = mkdtempSync(join(tmpdir(), 'tetaue-lsp-'));
        const server = spawn(NODE, [SERVER], { stdio: ['pipe', 'pipe', 'pipe'] });
        const stderr: string[] = [];
        server.stderr.on('data', chunk => stderr.push(chunk.toString('utf8')));
        try {
            const lib = join(dir, 'tables.tetaue');
            writeFileSync(lib, [
                '# shared table definitions',
                '# doc for users',
                'export users: query { id: int, active: bool } = table "users"',
                'export orders: query { id: int } = table "orders"',
                '',
            ].join('\n'));
            const main = join(dir, 'main.tetaue');
            writeFileSync(main, [
                'import "tables.tetaue" as t',
                'q = t.users & take 1',
                'q2 = t.',
                '',
            ].join('\n'));
            const libUri = URI.file(lib).toString();
            const mainUri = URI.file(main).toString();

            const init = await request(server, 1, 'initialize', { processId: null, rootUri: null, capabilities: {} });
            expect(init.error).toBeUndefined();
            server.stdin.write(frame({ jsonrpc: '2.0', method: 'initialized', params: {} }));
            server.stdin.write(frame({
                jsonrpc: '2.0', method: 'textDocument/didOpen',
                params: { textDocument: { uri: mainUri, languageId: 'tetaue', version: 1, text: readFileSync(main, 'utf8') } },
            }));

            // Completion after `t.` (line 2, cursor just past the dot).
            const completion = await request(server, 2, 'textDocument/completion', {
                textDocument: { uri: mainUri },
                position: { line: 2, character: 7 },
                context: { triggerKind: 2, triggerCharacter: '.' },
            });
            const items = (completion.result as { items: { label: string }[] }).items;
            expect(completion.error).toBeUndefined();
            expect(items.map(i => i.label)).toContain('users');
            expect(items.map(i => i.label)).toContain('orders');

            // Go-to-definition on `users` in `t.users` (line 1) → the lib binding.
            const def = await request(server, 3, 'textDocument/definition', {
                textDocument: { uri: mainUri },
                position: { line: 1, character: 7 },
            });
            const links = (def.result as unknown as { targetUri: string }[] | undefined) ?? [];
            expect(def.error).toBeUndefined();
            expect(links.some(l => l.targetUri === libUri)).toBe(true);

            // Hover on `users` in `t.users` shows the LIB's doc comment + type.
            const hover = await request(server, 4, 'textDocument/hover', {
                textDocument: { uri: mainUri },
                position: { line: 1, character: 7 },
            });
            const hoverContents = (hover.result as { contents: { value: string } }).contents;
            expect(hover.error).toBeUndefined();
            expect(hoverContents.value).toContain('doc for users');
            expect(hoverContents.value).toContain('query');

            const shutdown = await request(server, 5, 'shutdown', null);
            expect(shutdown.error).toBeUndefined();
        } finally {
            server.kill();
            rmSync(dir, { recursive: true, force: true });
            if (stderr.length > 0) {
                // eslint-disable-next-line no-console
                console.error('server stderr:\n' + stderr.join(''));
            }
        }
    });

    test('initialize, render an example to SQL, shutdown', async () => {
        const server = spawn(NODE, [SERVER], { stdio: ['pipe', 'pipe', 'pipe'] });
        const stderr: string[] = [];
        server.stderr.on('data', chunk => stderr.push(chunk.toString('utf8')));
        try {
            const init = await request(server, 1, 'initialize', {
                processId: null,
                rootUri: null,
                capabilities: {},
            });
            expect(init.error).toBeUndefined();
            const capabilities = (init.result as { capabilities: { textDocumentSync?: unknown } }).capabilities;
            expect(capabilities.textDocumentSync).toBeDefined();

            server.stdin.write(frame({ jsonrpc: '2.0', method: 'initialized', params: {} }));

            const render = await request(server, 2, 'tetaue/render', {
                uri: URI.file(EXAMPLE).toString(),
                dialect: 'postgresql',
            });
            const result = render.result as { ok: boolean; sql?: string; message?: string };
            expect(render.error).toBeUndefined();
            expect(result.ok).toBe(true);
            expect(result.sql).toContain('FROM users');
            expect(result.sql).toContain('SELECT DISTINCT');
            expect(result.sql).toContain("LOWER(COALESCE(email, ''))");
            expect(result.sql).toContain([
                'WHERE',
                '    email IS NOT NULL',
                '    AND nickname IS NULL',
            ].join('\n'));

            // The new dialects must be accepted by the same render path the
            // extension's output panel uses (settings enum: tetaue.dialect).
            let nextId = 4;
            for (const dialect of ['hive', 'trino'] as const) {
                const render2 = await request(server, nextId++, 'tetaue/render', {
                    uri: URI.file(EXAMPLE).toString(),
                    dialect,
                });
                const result2 = render2.result as { ok: boolean; sql?: string; message?: string };
                expect(render2.error).toBeUndefined();
                expect(result2.ok, dialect).toBe(true);
                // plain identifiers render unquoted in every dialect
                expect(result2.sql).toContain('SELECT DISTINCT\n    id,');
                expect(result2.sql).toContain('FROM users');
            }

            const shutdown = await request(server, nextId, 'shutdown', null);
            expect(shutdown.error).toBeUndefined();
        } finally {
            server.kill();
            if (stderr.length > 0) {
                // eslint-disable-next-line no-console
                console.error('server stderr:\n' + stderr.join(''));
            }
        }
    });

    test('hover shows types and docs; completion suggests row fields after `.`', async () => {
        const server = spawn(NODE, [SERVER], { stdio: ['pipe', 'pipe', 'pipe'] });
        const stderr: string[] = [];
        server.stderr.on('data', chunk => stderr.push(chunk.toString('utf8')));
        try {
            const init = await request(server, 1, 'initialize', {
                processId: null,
                rootUri: null,
                capabilities: {},
            });
            expect(init.error).toBeUndefined();
            server.stdin.write(frame({ jsonrpc: '2.0', method: 'initialized', params: {} }));

            // Lines (0-based): 0 = table schema, 1 = doc comment, 2 = adult lambda,
            // 3 = adults pipeline, 4 = incomplete line used for completion.
            const uri = 'file:///virtual/hover-test.tetaue';
            const doc = [
                'users: query { id: int, name: string, age: int, active: bool } = table "users"',
                '# keeps users who are active and at least 18 years old',
                'adult = u => u.active && u.age >= 18',
                'adults = users & filter (adult) & map (u => { id = u.id, age = u.age })',
                'q = users & map (u => u.age',
            ].join('\n');
            server.stdin.write(frame({
                jsonrpc: '2.0', method: 'textDocument/didOpen',
                params: { textDocument: { uri, languageId: 'tetaue', version: 1, text: doc } },
            }));

            // Hover over `age` in `u.age` (line 2, char 28 is inside `age`):
            // show the field's type. With polymorphic numeric literals the
            // comparison against `18` leaves `u.age` a class-constrained
            // variable at the definition site (it pins to `int` where the
            // binding is applied to `users`).
            const hover = await request(server, 2, 'textDocument/hover', {
                textDocument: { uri },
                position: { line: 2, character: 28 },
            });
            const hoverContents = (hover.result as { contents: { value: string } }).contents;
            expect(hover.error).toBeUndefined();
            expect(hoverContents.value).toContain('u.age');
            expect(hoverContents.value).toContain('Num t, Ord t => t');

            // Hover over the `u` lambda parameter (line 2, char 8): the lambda
            // type's input row must be flat — open rows render as one `{ ... }`
            // record with a single `| r` tail, never as nested `| { ... }`.
            const hoverRow = await request(server, 9, 'textDocument/hover', {
                textDocument: { uri },
                position: { line: 2, character: 8 },
            });
            const hoverRowContents = (hoverRow.result as { contents: { value: string } }).contents;
            expect(hoverRow.error).toBeUndefined();
            expect(hoverRowContents.value).toContain('Num t, Ord t => { active: bool, age: t | r } -> bool');
            expect(hoverRowContents.value).not.toContain('| {');

            // Hover over the `adult` reference in `filter (adult)` (line 3):
            // the binding's doc comment plus its function type.
            const hover2 = await request(server, 3, 'textDocument/hover', {
                textDocument: { uri },
                position: { line: 3, character: 27 },
            });
            const hover2Contents = (hover2.result as { contents: { value: string } }).contents;
            expect(hover2.error).toBeUndefined();
            expect(hover2Contents.value).toContain('keeps users who are active');
            expect(hover2Contents.value).toContain('bool');

            // Completion at the end of `u.age` (line 4): suggest the row's fields.
            const completion = await request(server, 4, 'textDocument/completion', {
                textDocument: { uri },
                position: { line: 4, character: 27 },
                context: { triggerKind: 2, triggerCharacter: '.' },
            });
            const items = (completion.result as { items: { label: string; detail?: string }[] }).items;
            expect(completion.error).toBeUndefined();
            const labels = items.map(item => item.label);
            expect(labels).toContain('id');
            expect(labels).toContain('name');
            expect(labels).toContain('age');
            expect(labels).toContain('active');
            const age = items.find(item => item.label === 'age');
            expect(age?.detail).toContain('int');

            const shutdown = await request(server, 5, 'shutdown', null);
            expect(shutdown.error).toBeUndefined();
        } finally {
            server.kill();
            if (stderr.length > 0) {
                // eslint-disable-next-line no-console
                console.error('server stderr:\n' + stderr.join(''));
            }
        }
    });

    test('semantic tokens classify keywords, types, functions, and variables', async () => {
        const server = spawn(NODE, [SERVER], { stdio: ['pipe', 'pipe', 'pipe'] });
        const stderr: string[] = [];
        server.stderr.on('data', chunk => stderr.push(chunk.toString('utf8')));
        try {
            const init = await request(server, 1, 'initialize', { processId: null, rootUri: null, capabilities: {} });
            expect(init.error).toBeUndefined();
            const capabilities = (init.result as {
                capabilities: {
                    semanticTokensProvider?: { legend: { tokenTypes: string[]; tokenModifiers: string[] } };
                };
            }).capabilities;

            // The server must advertise semantic tokens and serve a full-document legend.
            const legend = capabilities.semanticTokensProvider?.legend;
            expect(legend).toBeDefined();
            expect(legend!.tokenTypes).toContain('keyword');
            expect(legend!.tokenTypes).toContain('type');
            expect(legend!.tokenTypes).toContain('function');
            expect(legend!.tokenTypes).toContain('parameter');
            expect(legend!.tokenTypes).toContain('property');

            server.stdin.write(frame({ jsonrpc: '2.0', method: 'initialized', params: {} }));

            const uri = 'file:///virtual/semantic-test.tetaue';
            const doc = [
                'import "lib.tetaue" as lib',
                'users: query { id: int, age: int } = table "users"',
                'adult = u => u.active && u.age >= 18',
                'adults = users & filter (adult) & map (u => { id = u.id, age = u.age })',
                'q = adults & take ($1 + 3)',
                'done: (maybe bool) = null',
                'always = true',
                'cased = map (u => { x = case { u.age > 18 => "adult", _ => "minor" } })',
            ].join('\n');
            server.stdin.write(frame({
                jsonrpc: '2.0', method: 'textDocument/didOpen',
                params: { textDocument: { uri, languageId: 'tetaue', version: 1, text: doc } },
            }));

            const tokens = await request(server, 2, 'textDocument/semanticTokens/full', { textDocument: { uri } });
            expect(tokens.error).toBeUndefined();
            const data = (tokens.result as { data: number[] }).data;
            expect(data.length).toBeGreaterThan(0);

            // Decode delta-encoded tokens: [deltaLine, deltaChar, length, typeIndex, modifiersBitmask].
            const decoded: { line: number; char: number; length: number; type: string; modifier: string }[] = [];
            let line = 0;
            let char = 0;
            for (let i = 0; i + 4 < data.length; i += 5) {
                line += data[i]!;
                if (data[i] !== 0) char = 0;
                char += data[i + 1]!;
                const mods = data[i + 4]!;
                decoded.push({
                    line,
                    char,
                    length: data[i + 2]!,
                    type: legend!.tokenTypes[data[i + 3]!]!,
                    modifier: mods === 0 ? '' : legend!.tokenModifiers[Math.trunc(Math.log2(mods))] ?? '',
                });
            }
            const at = (line: number, char: number): { type: string; modifier: string; text: string } => {
                const token = decoded.find(t => t.line === line && t.char === char);
                expect(token, `no token at ${line}:${char}`).toBeDefined();
                return {
                    type: token!.type,
                    modifier: token!.modifier,
                    text: doc.split('\n')[line]!.slice(char, char + token!.length),
                };
            };

            // Keywords and namespace aliases.
            const imp = at(0, 0);
            expect(imp.type).toBe('keyword');
            expect(imp.text).toBe('import');
            expect(at(0, 23).text).toBe('lib');
            expect(at(0, 23).type).toBe('namespace');
            expect(at(1, 7).text).toBe('query');
            expect(at(1, 7).type).toBe('keyword');

            // Types, record fields, and annotations.
            expect(at(1, 15).text).toBe('id');
            expect(at(1, 15).type).toBe('property');
            expect(at(1, 19).text).toBe('int');
            expect(at(1, 19).type).toBe('type');
            expect(at(5, 7).text).toBe('maybe');
            expect(at(5, 7).type).toBe('keyword');
            expect(at(5, 13).text).toBe('bool');
            expect(at(5, 13).type).toBe('type');

            // Builtins are functions with the defaultLibrary modifier.
            const table = at(1, 37);
            expect(table.text).toBe('table');
            expect(table.type).toBe('function');
            expect(table.modifier).toBe('defaultLibrary');
            expect(at(3, 17).text).toBe('filter');
            expect(at(3, 17).type).toBe('function');

            // Data bindings are variables; lambda bindings are functions.
            expect(at(1, 0).text).toBe('users');
            expect(at(1, 0).type).toBe('variable');
            expect(at(1, 0).modifier).toBe('declaration');
            expect(at(2, 0).text).toBe('adult');
            expect(at(2, 0).type).toBe('function');
            expect(at(2, 0).modifier).toBe('declaration');
            expect(at(3, 0).text).toBe('adults');
            expect(at(3, 0).type).toBe('variable');
            expect(at(4, 0).text).toBe('q');
            expect(at(4, 0).type).toBe('variable');
            expect(at(3, 9).text).toBe('users');
            expect(at(3, 9).type).toBe('variable');
            // A reference to the lambda binding resolves to function.
            expect(at(3, 25).text).toBe('adult');
            expect(at(3, 25).type).toBe('function');

            // Lambda parameters: declaration and every use, incl. $n.
            expect(at(2, 8).text).toBe('u');
            expect(at(2, 8).type).toBe('parameter');
            expect(at(2, 8).modifier).toBe('declaration');
            expect(at(2, 13).text).toBe('u');
            expect(at(2, 13).type).toBe('parameter');
            expect(at(3, 39).text).toBe('u');
            expect(at(3, 39).type).toBe('parameter');
            expect(at(4, 19).text).toBe('$1');
            expect(at(4, 19).type).toBe('parameter');

            // Property access, literals, null/booleans, operators.
            expect(at(2, 15).text).toBe('active');
            expect(at(2, 15).type).toBe('property');
            expect(at(2, 22).text).toBe('&&');
            expect(at(2, 22).type).toBe('operator');
            expect(at(2, 34).text).toBe('18');
            expect(at(2, 34).type).toBe('number');
            expect(at(1, 43).text).toBe('"users"');
            expect(at(1, 43).type).toBe('string');
            expect(at(5, 21).text).toBe('null');
            expect(at(5, 21).type).toBe('keyword');
            expect(at(6, 9).text).toBe('true');
            expect(at(6, 9).type).toBe('keyword');

            // `case` keyword, `_` wildcard, and `=>` operator in a case expression.
            expect(at(7, 24).text).toBe('case');
            expect(at(7, 24).type).toBe('keyword');
            expect(at(7, 54).text).toBe('_');
            expect(at(7, 54).type).toBe('keyword');
            expect(at(7, 42).text).toBe('=>');
            expect(at(7, 42).type).toBe('operator');

            const shutdown = await request(server, 3, 'shutdown', null);
            expect(shutdown.error).toBeUndefined();
        } finally {
            server.kill();
            if (stderr.length > 0) {
                // eslint-disable-next-line no-console
                console.error('server stderr:\n' + stderr.join(''));
            }
        }
    });

    test('formatting returns canonical text', async () => {
        const server = spawn(NODE, [SERVER], { stdio: ['pipe', 'pipe', 'pipe'] });
        const stderr: string[] = [];
        server.stderr.on('data', chunk => stderr.push(chunk.toString('utf8')));
        try {
            const init = await request(server, 1, 'initialize', {
                processId: null,
                rootUri: null,
                capabilities: {},
            });
            expect(init.error).toBeUndefined();
            server.stdin.write(frame({ jsonrpc: '2.0', method: 'initialized', params: {} }));

            const uri = 'file:///virtual/format-test.tetaue';
            const messy = [
                'users: query {id: int,name: string} = table  "users"   ',
                '',
                'q = users&filter (u => u.age>=18)&take 3',
            ].join('\n');
            server.stdin.write(frame({
                jsonrpc: '2.0', method: 'textDocument/didOpen',
                params: { textDocument: { uri, languageId: 'tetaue', version: 1, text: messy } },
            }));

            const formatting = await request(server, 2, 'textDocument/formatting', {
                textDocument: { uri },
                options: { tabSize: 4, insertSpaces: true },
            });
            const edits = formatting.result as unknown as { range: { start: { line: number; character: number }; end: { line: number; character: number } }; newText: string }[];
            expect(formatting.error).toBeUndefined();
            expect(edits.length).toBeGreaterThan(0);

            // Apply the edits to the original text (splice from the end).
            const lines = messy.split('\n');
            for (const edit of [...edits].sort((a, b) =>
                b.range.start.line - a.range.start.line || b.range.start.character - a.range.start.character,
            )) {
                const line = lines[edit.range.start.line]!;
                lines[edit.range.start.line] = line.slice(0, edit.range.start.character)
                    + edit.newText
                    + line.slice(edit.range.end.character);
            }
            const formatted = lines.join('\n');
            expect(formatted).toBe('users: query { id: int, name: string } = table "users"\n\nq = users & filter (u => u.age >= 18) & take 3');

            const shutdown = await request(server, 3, 'shutdown', null);
            expect(shutdown.error).toBeUndefined();
        } finally {
            server.kill();
            if (stderr.length > 0) {
                // eslint-disable-next-line no-console
                console.error('server stderr:\n' + stderr.join(''));
            }
        }
    });
});
