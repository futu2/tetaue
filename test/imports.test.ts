import { describe, expect, test } from 'bun:test';
import { collectModuleTree } from '../src/language/imports.ts';
import { analyzeProject } from '../src/language/interpreter.ts';
import { renderQuery, DIALECTS } from '../src/language/render.ts';
import { parseModel, services } from './helpers.ts';

/** Analyze a set of in-memory files; `main` is the entry file. */
function analyzeFiles(files: Record<string, string>, main: string) {
    const resolve = (importer: string | undefined, spec: string): string => {
        if (importer === undefined) return spec;
        const slash = importer.lastIndexOf('/');
        const base = slash >= 0 ? importer.slice(0, slash + 1) : '';
        return base + spec;
    };
    const tree = collectModuleTree({ model: parseModel(files[main]!), uri: main }, {
        resolve,
        read: uri => files[uri],
        parse: (text, uri) => parseModel(text),
    });
    const result = analyzeProject(tree.modules.map(m => m.model), { requireQuery: true });
    return { tree, result };
}

function renderFiles(files: Record<string, string>, main: string, dialect = 'sqlite'): string {
    const { result } = analyzeFiles(files, main);
    if (result.diagnostics.length > 0) {
        throw new Error(`invalid: ${result.diagnostics.map(d => d.message).join(' | ')}`);
    }
    if (result.value.kind !== 'query') throw new Error('not a query');
    return renderQuery(result.value.query, DIALECTS[dialect]!);
}

describe('multi-file modules', () => {
    const TABLES = `
        users = table "users" { id = int, name = string, age = int, active = bool }
        orders = table "orders" { id = int, user_id = int, total = float }
    `;

    test("import brings the module's bindings into scope", () => {
        const sql = renderFiles({
            'tables.tetaue': TABLES,
            'main.tetaue': `
                import "tables.tetaue"
                adults = users & filter (u => u.active) & take 5
            `,
        }, 'main.tetaue');
        expect(sql).toContain('FROM "users"');
        expect(sql).toContain('WHERE ("active")');
        expect(sql).toContain('LIMIT 5');
    });

    test('nested imports resolve relative to the importer', () => {
        const sql = renderFiles({
            'shared/columns.tetaue': `users = table "users" { id = int }`,
            'shared/base.tetaue': `import "columns.tetaue"`,
            'main.tetaue': `
                import "shared/base.tetaue"
                q = users & take 1
            `,
        }, 'main.tetaue');
        expect(sql).toContain('FROM "users"');
    });

    test("join composes with an imported table as the right value", () => {
        const sql = renderFiles({
            'tables.tetaue': TABLES,
            'main.tetaue': `
                import "tables.tetaue"
                q = users
                    & map (u => { uid = u.id })
                    & join { right = orders, on = (u, o) => u.uid == o.user_id }
            `,
        }, 'main.tetaue');
        expect(sql).toContain('INNER JOIN "orders" ON "users"."id" = "orders"."user_id"');
    });

    test('unresolved import is reported', () => {
        const { tree, result } = analyzeFiles({ 'main.tetaue': `import "nope.tetaue"\nq = 1` }, 'main.tetaue');
        expect(tree.diagnostics[0]!.message).toContain("cannot resolve import 'nope.tetaue'");
        expect(result.diagnostics.length).toBeGreaterThan(0);
    });

    test('circular imports are reported', () => {
        const { tree } = analyzeFiles({
            'a.tetaue': `import "b.tetaue"\nq = 1`,
            'b.tetaue': `import "a.tetaue"\nq = 2`,
        }, 'a.tetaue');
        expect(tree.diagnostics.map(d => d.message).join('\n')).toContain('circular import');
    });

    test('imported modules are deduplicated when reached twice', () => {
        const { tree } = analyzeFiles({
            'common.tetaue': `users = table "users" { id = int }`,
            'a.tetaue': `import "common.tetaue"\nq = 1`,
            'b.tetaue': `import "common.tetaue"\nq = 2`,
            'main.tetaue': `import "a.tetaue"\nimport "b.tetaue"\nq = users & take 1`,
        }, 'main.tetaue');
        // common.tetaue appears once in the module list
        const count = tree.modules.filter(m => m.uri === 'common.tetaue').length;
        expect(count).toBe(1);
        expect(tree.diagnostics).toEqual([]);
    });

    test('errors in imported files surface', () => {
        const { result } = analyzeFiles({
            'tables.tetaue': `users = table "users" { id = int, age = int }`,
            'main.tetaue': `
                import "tables.tetaue"
                q = users & filter (u => u.age == "x")
            `,
        }, 'main.tetaue');
        expect(result.diagnostics.map(d => d.message).join('\n')).toContain('cannot compare int with string');
    });

    test("the root module's last binding is the query, not the imports", () => {
        const { result } = analyzeFiles({
            'tables.tetaue': `users = table "users" { id = int }`,
            'main.tetaue': `import "tables.tetaue"\nq = users & take 1`,
        }, 'main.tetaue');
        expect(result.diagnostics).toEqual([]);
        expect(result.value.kind).toBe('query');
    });

    test('imports must come before bindings (parse error otherwise)', () => {
        expect(() => parseModel(`q = 1\nimport "x.tetaue"`)).toThrow();
    });
});

describe('imports through the Langium validation pipeline', () => {
    test('validator folds imported-module errors onto the import statement', async () => {
        const { mkdtempSync, writeFileSync, rmSync, readFileSync } = require('node:fs') as typeof import('node:fs');
        const { tmpdir } = require('node:os') as typeof import('node:os');
        const { join } = require('node:path') as typeof import('node:path');
        const { URI } = await import('langium');
        const dir = mkdtempSync(join(tmpdir(), 'tetaue-'));
        try {
            writeFileSync(join(dir, 'tables.tetaue'), 'users = table "users" { id = int }\nbad = users & filter (u => u.id == "x")\n');
            writeFileSync(join(dir, 'main.tetaue'), 'import "tables.tetaue"\nq = users & take 1\n');
            const uri = URI.file(join(dir, 'main.tetaue'));
            const doc = await services.shared.workspace.LangiumDocumentFactory.fromString(
                readFileSync(join(dir, 'main.tetaue'), 'utf8'), uri,
            );
            await services.shared.workspace.DocumentBuilder.build([doc], { validation: true });
            const messages = (doc.diagnostics ?? []).map(d => d.message);
            expect(messages.join('\n')).toContain("in imported module 'tables.tetaue': cannot compare int with string");
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    test('a valid imported module produces no diagnostics', async () => {
        const { mkdtempSync, writeFileSync, rmSync, readFileSync } = require('node:fs') as typeof import('node:fs');
        const { tmpdir } = require('node:os') as typeof import('node:os');
        const { join } = require('node:path') as typeof import('node:path');
        const { URI } = await import('langium');
        const dir = mkdtempSync(join(tmpdir(), 'tetaue-'));
        try {
            writeFileSync(join(dir, 'tables.tetaue'), 'users = table "users" { id = int }\n');
            writeFileSync(join(dir, 'main.tetaue'), 'import "tables.tetaue"\nq = users & take 1\n');
            const uri = URI.file(join(dir, 'main.tetaue'));
            const doc = await services.shared.workspace.LangiumDocumentFactory.fromString(
                readFileSync(join(dir, 'main.tetaue'), 'utf8'), uri,
            );
            await services.shared.workspace.DocumentBuilder.build([doc], { validation: true });
            expect(doc.diagnostics ?? []).toEqual([]);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});

describe('imports through the CLI (end to end)', () => {    test('render resolves imports from real files', () => {
        const { mkdtempSync, writeFileSync, rmSync } = require('node:fs') as typeof import('node:fs');
        const { tmpdir } = require('node:os') as typeof import('node:os');
        const { join, resolve } = require('node:path') as typeof import('node:path');
        const { execFileSync } = require('node:child_process') as typeof import('node:child_process');
        const dir = mkdtempSync(join(tmpdir(), 'tetaue-'));
        try {
            writeFileSync(join(dir, 'tables.tetaue'), 'users = table "users" { id = int, active = bool }\n');
            writeFileSync(join(dir, 'main.tetaue'), 'import "tables.tetaue"\nq = users & filter (u => u.active) & take 3\n');
            const out = execFileSync('bun', ['run', 'src/cli.ts', 'render', join(dir, 'main.tetaue')], {
                cwd: resolve(import.meta.dir, '..'),
                encoding: 'utf8',
            });
            expect(out).toContain('FROM "users"');
            expect(out).toContain('WHERE ("active")');
            expect(out).toContain('LIMIT 3');
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    test('check reports an unresolved import with its path', () => {
        const { mkdtempSync, writeFileSync, rmSync } = require('node:fs') as typeof import('node:fs');
        const { tmpdir } = require('node:os') as typeof import('node:os');
        const { join, resolve } = require('node:path') as typeof import('node:path');
        const { execFileSync } = require('node:child_process') as typeof import('node:child_process');
        const dir = mkdtempSync(join(tmpdir(), 'tetaue-'));
        try {
            writeFileSync(join(dir, 'main.tetaue'), 'import "nope.tetaue"\nq = 1\n');
            let failed = false;
            let out = '';
            try {
                out = execFileSync('bun', ['run', 'src/cli.ts', 'check', join(dir, 'main.tetaue')], {
                    cwd: resolve(import.meta.dir, '..'),
                    encoding: 'utf8',
                });
            } catch (err) {
                failed = true;
                out = String((err as { stderr?: Buffer }).stderr ?? err);
            }
            expect(failed).toBe(true);
            expect(out).toContain("cannot resolve import 'nope.tetaue'");
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});
