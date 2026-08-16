/******************************************************************************
 * CLI tests — format / build / watch / lsp, the [build] manifest config, and
 * the requireQuery:false compile mode that build relies on.
 ******************************************************************************/
import { describe, expect, test } from 'bun:test';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { NodeFileSystem } from 'langium/node';
import { createTetaueServices } from '../src/language/tetaue-module.ts';
import type { TetaueServices } from '../src/language/tetaue-module.ts';
import { compileModuleText } from '../src/language/compile.ts';
import { buildProject, findTetaueFiles, main, startWatch } from '../src/cli.ts';
import { parseManifest } from '../src/language/resolve.ts';

const services: TetaueServices = createTetaueServices(NodeFileSystem).tetaue;

const QUERY_1 = `users: query { id: int, age: int } = table "users"
adults = users & filter (u => u.age >= 18) & take 5
`;

const QUERY_2 = `users: query { id: int, age: int, name: string } = table "users"
adults = users & filter (u => u.age >= 18) & take 7
`;

function tempDir(prefix: string): string {
    return mkdtempSync(join(tmpdir(), prefix));
}

/** Write a file (creating parents), returning its absolute path. */
function write(dir: string, rel: string, content: string): string {
    const file = join(dir, rel);
    mkdirSync(join(file, '..'), { recursive: true });
    writeFileSync(file, content);
    return file;
}

/** Replace console.error/log with collectors; restore() puts them back. */
function captureConsole(): { restore: () => void; error: string[]; log: string[] } {
    const error: string[] = [];
    const log: string[] = [];
    const originalError = console.error;
    const originalLog = console.log;
    console.error = (...args: unknown[]) => { error.push(args.join(' ')); };
    console.log = (...args: unknown[]) => { log.push(args.join(' ')); };
    return {
        restore: () => { console.error = originalError; console.log = originalLog; },
        error,
        log,
    };
}

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
    const start = Date.now();
    while (!predicate()) {
        if (Date.now() - start > timeoutMs) throw new Error(`timed out after ${timeoutMs}ms`);
        await new Promise(r => setTimeout(r, 25));
    }
}

describe('findTetaueFiles', () => {
    test('finds .tetaue files recursively, skipping build/vendor dirs', () => {
        const dir = tempDir('tetaue-find-');
        try {
            write(dir, 'a.tetaue', '');
            write(dir, 'sub/b.tetaue', '');
            write(dir, 'node_modules/c.tetaue', '');
            write(dir, 'out/d.tetaue', '');
            write(dir, 'dist/e.tetaue', '');
            write(dir, 'notes.txt', '');
            expect(findTetaueFiles(dir)).toEqual([join(dir, 'a.tetaue'), join(dir, 'sub/b.tetaue')]);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});

describe('compileModuleText requireQuery', () => {
    test('a library module (no query) is not an error when requireQuery is false', () => {
        const outcome = compileModuleText('file:///lib.tetaue', 'export add = x => x + 1\n', services, { requireQuery: false });
        if (outcome.ok) throw new Error('expected ok:false for a library module');
        expect(outcome.diagnostics).toHaveLength(0);
    });

    test('the same module is an error with the default requireQuery', () => {
        const outcome = compileModuleText('file:///lib.tetaue', 'export add = x => x + 1\n', services);
        if (outcome.ok) throw new Error('expected ok:false');
        expect(outcome.diagnostics.length).toBeGreaterThan(0);
    });
});

describe('buildProject', () => {
    test('renders query modules, counts libraries, reports errors', () => {
        const dir = tempDir('tetaue-build-');
        const out = join(dir, 'dist');
        try {
            write(dir, 'main.tetaue', QUERY_1);
            write(dir, 'lib.tetaue', 'export double = x => x * 2\n');
            write(dir, 'broken.tetaue', 'q = users & filter u.age\n');
            const result = buildProject(dir, { dialect: 'sqlite', format: 'pretty', out }, services);
            expect(result.built).toBe(1);
            expect(result.library).toBe(1);
            expect(result.errors).toBe(1);
            expect(result.files).toHaveLength(3);
            expect(result.sqlFiles).toEqual([join(out, 'main.sql')]);
            expect(readFileSync(join(out, 'main.sql'), 'utf8')).toContain('LIMIT 5');
            expect(existsSync(join(out, 'lib.sql'))).toBe(false);
            expect(existsSync(join(out, 'broken.sql'))).toBe(false);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    test('mirrors the source tree into the output directory', () => {
        const dir = tempDir('tetaue-build-tree-');
        try {
            write(dir, 'nested/deep/q.tetaue', QUERY_1);
            const result = buildProject(dir, { dialect: 'sqlite', format: 'pretty', out: join(dir, 'sql') }, services);
            expect(result.sqlFiles).toEqual([join(dir, 'sql', 'nested', 'deep', 'q.sql')]);
            expect(readFileSync(join(dir, 'sql', 'nested', 'deep', 'q.sql'), 'utf8')).toContain('SELECT');
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});

describe('format', () => {
    test('formats files in place', async () => {
        const dir = tempDir('tetaue-fmt-');
        try {
            const file = write(dir, 'q.tetaue', 'q=users & filter (u=>u.active)&take 3\n');
            const captured = captureConsole();
            let code: number;
            try {
                code = await main(['format', file]);
            } finally {
                captured.restore();
            }
            expect(code).toBe(0);
            expect(readFileSync(file, 'utf8')).toBe('q = users & filter (u => u.active) & take 3\n');
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    test('--check reports files that would change and leaves them untouched', async () => {
        const dir = tempDir('tetaue-fmt-check-');
        try {
            const file = write(dir, 'q.tetaue', 'q=1\n');
            const captured = captureConsole();
            let code: number;
            try {
                code = await main(['format', '--check', file]);
            } finally {
                captured.restore();
            }
            expect(code).toBe(1);
            expect(captured.error.join('\n')).toContain('would be reformatted');
            expect(readFileSync(file, 'utf8')).toBe('q=1\n');
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    test('fmt is an alias', async () => {
        const dir = tempDir('tetaue-fmt-alias-');
        try {
            const file = write(dir, 'q.tetaue', 'q=1\n');
            const captured = captureConsole();
            try {
                expect(await main(['fmt', file])).toBe(0);
            } finally {
                captured.restore();
            }
            expect(readFileSync(file, 'utf8')).toBe('q = 1\n');
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});

describe('tetaue.toml [build]', () => {
    test('parses build defaults', () => {
        const manifest = parseManifest([
            '[build]',
            'out = "sql"',
            'dialect = "postgresql"',
            'format = "compact"',
            'pre = "echo pre"',
            'post = "echo post"',
            '',
        ].join('\n'));
        expect(manifest.build).toEqual({
            out: 'sql',
            dialect: 'postgresql',
            format: 'compact',
            pre: 'echo pre',
            post: 'echo post',
        });
    });

    test('malformed [build] entries are dropped', () => {
        expect(parseManifest('[build]\nout = 42\npre = ""\n').build).toBeUndefined();
    });
});

describe('build command', () => {
    test('uses tetaue.toml [build] defaults and runs hooks in order', async () => {
        const dir = tempDir('tetaue-build-cfg-');
        try {
            write(dir, 'q.tetaue', QUERY_1);
            const markers = join(dir, 'markers.txt');
            write(dir, 'tetaue.toml', [
                '[build]',
                'out = "generated"',
                'dialect = "postgresql"',
                `pre = "echo pre >> ${markers}"`,
                `post = "echo post >> ${markers}"`,
                '',
            ].join('\n'));
            const captured = captureConsole();
            let code: number;
            try {
                code = await main(['build', dir]);
            } finally {
                captured.restore();
            }
            expect(code).toBe(0);
            expect(existsSync(join(dir, 'generated', 'q.sql'))).toBe(true);
            expect(readFileSync(join(dir, 'generated', 'q.sql'), 'utf8')).toContain('LIMIT 5');
            expect(readFileSync(markers, 'utf8').trim().split('\n')).toEqual(['pre', 'post']);
            expect(captured.error.join('\n')).toContain('0 error(s)');
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    test('--no-hooks skips hooks and --out overrides the manifest', async () => {
        const dir = tempDir('tetaue-build-nohook-');
        try {
            write(dir, 'q.tetaue', QUERY_1);
            const markers = join(dir, 'markers.txt');
            write(dir, 'tetaue.toml', `[build]\nout = "generated"\npre = "echo pre >> ${markers}"\n`);
            const captured = captureConsole();
            let code: number;
            try {
                code = await main(['build', dir, '--no-hooks', '--out', join(dir, 'cli-out')]);
            } finally {
                captured.restore();
            }
            expect(code).toBe(0);
            expect(existsSync(join(dir, 'cli-out', 'q.sql'))).toBe(true);
            expect(existsSync(join(dir, 'generated'))).toBe(false);
            expect(existsSync(markers)).toBe(false);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    test('failing modules make the build exit 1', async () => {
        const dir = tempDir('tetaue-build-fail-');
        try {
            write(dir, 'broken.tetaue', 'q = users & filter u.age\n');
            const captured = captureConsole();
            let code: number;
            try {
                code = await main(['build', dir]);
            } finally {
                captured.restore();
            }
            expect(code).toBe(1);
            expect(captured.error.join('\n')).toContain('error:');
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});

describe('watch', () => {
    test('re-renders a file when it changes', async () => {
        const dir = tempDir('tetaue-watch-file-');
        try {
            const file = write(dir, 'q.tetaue', QUERY_1);
            const results: string[] = [];
            const session = startWatch(file, false, { dialect: 'sqlite', format: 'pretty' }, services, (_f, outcome) => {
                if (outcome.ok) results.push(outcome.sql);
            });
            let rewriter: ReturnType<typeof setTimeout> | undefined;
            try {
                session.runAll();
                expect(results).toHaveLength(1);
                writeFileSync(file, QUERY_2);
                // Re-write once after a tick: some watchers catch the first
                // event before the new content is fully visible.
                rewriter = setTimeout(() => writeFileSync(file, QUERY_2), 300);
                await waitFor(() => results.some(sql => sql.includes('LIMIT 7')), 5000);
            } finally {
                if (rewriter !== undefined) clearTimeout(rewriter);
                session.stop();
            }
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    test('picks up a newly created file in a watched directory', async () => {
        const dir = tempDir('tetaue-watch-dir-');
        try {
            write(dir, 'a.tetaue', QUERY_1);
            const seen: string[] = [];
            const session = startWatch(dir, true, { dialect: 'sqlite', format: 'pretty' }, services, (file, outcome) => {
                if (outcome.ok) seen.push(file);
            });
            try {
                session.runAll();
                expect(seen).toHaveLength(1);
                const newFile = write(dir, 'b.tetaue', QUERY_2);
                await waitFor(() => seen.includes(newFile), 5000);
            } finally {
                session.stop();
            }
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});

// --- LSP over stdio: the CLI `lsp` command serves the same protocol. -------

function frame(message: unknown): Buffer {
    const body = JSON.stringify(message);
    return Buffer.from(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
}

function request(server: ChildProcessWithoutNullStreams, id: number, method: string, params: unknown): Promise<{ id: number; result?: unknown }> {
    server.stdin.write(frame({ jsonrpc: '2.0', id, method, params }));
    return new Promise((resolvePromise, reject) => {
        const timeout = setTimeout(() => reject(new Error(`timeout waiting for response to ${method}`)), 15_000);
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
                const message = JSON.parse(body) as { id?: number; method?: string };
                if (message.method === undefined && message.id === id) {
                    clearTimeout(timeout);
                    server.stdout.off('data', onData);
                    resolvePromise(message as { id: number; result?: unknown });
                    return;
                }
            }
        };
        server.stdout.on('data', onData);
    });
}

describe('tetaue lsp', () => {
    test('starts the language server over stdio', async () => {
        const ROOT = resolve(import.meta.dir, '..');
        const server = spawn('bun', ['run', 'src/cli.ts', 'lsp'], { cwd: ROOT, stdio: ['pipe', 'pipe', 'pipe'] });
        try {
            const response = await request(server, 1, 'initialize', { processId: null, rootUri: null, capabilities: {} });
            expect(response.id).toBe(1);
            expect(response.result).toBeDefined();
            server.stdin.write(frame({ jsonrpc: '2.0', id: 2, method: 'shutdown', params: null }));
            server.stdin.write(frame({ jsonrpc: '2.0', method: 'exit', params: null }));
            await new Promise<void>(r => server.on('exit', () => r()));
        } finally {
            if (server.exitCode === null) server.kill();
        }
    });
});

describe('render entrypoint and parameter metadata', () => {
    test('--binding renders a named root binding instead of the last one', async () => {
        const dir = tempDir('tetaue-binding-');
        try {
            const file = write(dir, 'multi.tetaue', `a: query { id: int } = table "a"\nhelper = 42\nb: query { id: int } = table "b"\n`);
            const cap = captureConsole();
            try {
                expect(await main(['render', file, '--binding', 'a', '--format', 'compact'])).toBe(0);
                expect(cap.log.join('\n')).toContain('SELECT * FROM a');
            } finally {
                cap.restore();
            }
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    test('--binding rejects non-query bindings', async () => {
        const dir = tempDir('tetaue-binding-bad-');
        try {
            const file = write(dir, 'multi.tetaue', `a: query { id: int } = table "a"\nhelper = 42\n`);
            const cap = captureConsole();
            try {
                expect(await main(['render', file, '--binding', 'helper'])).toBe(1);
                expect(cap.error.join('\n')).toContain("binding 'helper' must be a query");
            } finally {
                cap.restore();
            }
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    test('render --json exposes sql and named parameters', async () => {
        const dir = tempDir('tetaue-json-');
        try {
            const file = write(dir, 'param.tetaue', `a: query { id: int } = table "a"\nq = a & filter (u => u.id == param "user_id")\n`);
            const cap = captureConsole();
            try {
                expect(await main(['render', file, '--json'])).toBe(0);
                const parsed = JSON.parse(cap.log.join('\n')) as { sql: string; parameters: string[] };
                expect(parsed.sql).toContain('WHERE');
                expect(parsed.parameters).toEqual(['user_id']);
            } finally {
                cap.restore();
            }
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});
