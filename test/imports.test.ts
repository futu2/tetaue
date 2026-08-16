import { describe, expect, test } from 'bun:test';
import { collectModuleTree } from '../src/language/imports.ts';
import { analyzeProject } from '../src/language/interpreter.ts';
import { inferProject } from '../src/language/inference.ts';
import { renderQuery, DIALECTS } from '../src/language/render.ts';
import { parseModel, services } from './helpers.ts';

/** Analyze a set of in-memory files; `main` is the entry file. */
function analyzeFiles(files: Record<string, string>, main: string) {
    const resolve = (importer: string | undefined, spec: string): { uri: string; searched: string[] } => {
        if (importer === undefined) return { uri: spec, searched: [] };
        const slash = importer.lastIndexOf('/');
        const base = slash >= 0 ? importer.slice(0, slash + 1) : '';
        return { uri: base + spec, searched: [base] };
    };
    const tree = collectModuleTree({ model: parseModel(files[main]!), uri: main, imports: [] }, {
        resolve,
        read: uri => files[uri],
        parse: (text, uri) => parseModel(text),
    });
    const result = analyzeProject(tree.modules, { requireQuery: true });
    return { tree, result };
}

function renderFiles(files: Record<string, string>, main: string, dialect = 'sqlite'): string {
    const { result } = analyzeFiles(files, main);
    if (result.diagnostics.length > 0) {
        throw new Error(`invalid: ${result.diagnostics.map(d => d.message).join(' | ')}`);
    }
    if (result.value.kind !== 'query') throw new Error('not a query');
    const rendered = renderQuery(result.value.query, DIALECTS[dialect]!);
    if (!rendered.ok) throw new Error(`render failed: ${rendered.diagnostics.map(d => d.message).join(' | ')}`);
    return rendered.sql;
}

describe('multi-file modules', () => {
    const TABLES = `
        export users: query { id: int, name: string, age: int, active: bool } = table "users"
        export orders: query { id: int, user_id: int, total: float } = table "orders"
    `;

    test("import brings the module's bindings into scope", () => {
        const sql = renderFiles({
            'tables.tetaue': TABLES,
            'main.tetaue': `
                import "tables.tetaue"
                adults = users & filter (u => u.active) & take 5
            `,
        }, 'main.tetaue');
        expect(sql).toContain('FROM users');
        expect(sql).toContain('WHERE active');
        expect(sql).toContain('LIMIT 5');
    });

    test('nested imports resolve relative to the importer', () => {
        const sql = renderFiles({
            'shared/columns.tetaue': `export users: query { id: int } = table "users"`,
            // Re-export through a namespace: base imports columns qualified
            // and re-exports the binding — main sees only what base exports.
            'shared/base.tetaue': `import "columns.tetaue" as c\nexport users = c.users`,
            'main.tetaue': `
                import "shared/base.tetaue"
                q = users & take 1
            `,
        }, 'main.tetaue');
        expect(sql).toContain('FROM users');
    });

    test("join composes with an imported table as the right value", () => {
        const sql = renderFiles({
            'tables.tetaue': TABLES,
            'main.tetaue': `
                import "tables.tetaue"
                q = users
                    & map (u => { uid = u.id })
                    & join inner orders (u => o => u.uid == o.user_id) (u => o => { uid = u.uid, oid = o.user_id })
            `,
        }, 'main.tetaue');
        expect(sql).toContain('INNER JOIN orders ON users.id = orders.user_id');
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

    test('cycle messages name the edge that closes the loop', () => {
        // A -> B -> A: the loop closes with B importing A.
        const { tree } = analyzeFiles({
            'a.tetaue': `import "b.tetaue"\nq = 1`,
            'b.tetaue': `import "a.tetaue"\nq = 2`,
        }, 'a.tetaue');
        expect(tree.diagnostics.map(d => d.message).join('\n')).toContain("circular import: 'b.tetaue' -> 'a.tetaue'");

        // A -> B -> C -> B: the loop closes with C importing B (B was first
        // reached via A, which must not appear in the message).
        const { tree: t2 } = analyzeFiles({
            'a.tetaue': `import "b.tetaue"\nq = 1`,
            'b.tetaue': `import "c.tetaue"\nq = 2`,
            'c.tetaue': `import "b.tetaue"\nq = 3`,
        }, 'a.tetaue');
        expect(t2.diagnostics.map(d => d.message).join('\n')).toContain("circular import: 'c.tetaue' -> 'b.tetaue'");
    });

    test('imported modules are deduplicated when reached twice', () => {
        const { tree } = analyzeFiles({
            'common.tetaue': `export users: query { id: int } = table "users"`,
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
            'tables.tetaue': `export users: query { id: int, age: int } = table "users"`,
            'main.tetaue': `
                import "tables.tetaue"
                q = users & filter (u => u.age == "x")
            `,
        }, 'main.tetaue');
        expect(result.diagnostics.map(d => d.message).join('\n')).toContain('cannot compare int with string');
    });

    test("the root module's last binding is the query, not the imports", () => {
        const { result } = analyzeFiles({
            'tables.tetaue': `export users: query { id: int } = table "users"`,
            'main.tetaue': `import "tables.tetaue"\nq = users & take 1`,
        }, 'main.tetaue');
        expect(result.diagnostics).toEqual([]);
        expect(result.value.kind).toBe('query');
    });

    test('imports must come before bindings (parse error otherwise)', () => {
        expect(() => parseModel(`q = 1\nimport "x.tetaue"`)).toThrow();
    });
});

describe('exports and namespaced imports', () => {
    test('import ... as t binds a namespace; t.binding reads an export', () => {
        const sql = renderFiles({
            'tables.tetaue': `export users: query { id: int, active: bool } = table "users"\nexport orders: query { id: int } = table "orders"`,
            'main.tetaue': `
                import "tables.tetaue" as t
                q = t.users & filter (u => u.active) & take 5
            `,
        }, 'main.tetaue');
        expect(sql).toContain('FROM users');
        expect(sql).toContain('WHERE active');
        expect(sql).toContain('LIMIT 5');
    });

    test('a non-exported binding is invisible to importers', () => {
        const { result } = analyzeFiles({
            'lib.tetaue': `
                helper = u => u.active
                export users: query { id: int, active: bool } = table "users"
            `,
            'main.tetaue': `import "lib.tetaue"\nq = users & filter helper & take 1`,
        }, 'main.tetaue');
        expect(result.diagnostics.map(d => d.message).join('\n')).toContain("unknown identifier 'helper'");
    });

    test("qualified access to a non-exported (or missing) binding is an error", () => {
        const { result } = analyzeFiles({
            'lib.tetaue': `helper = u => u.active\nexport users: query { id: int } = table "users"`,
            'main.tetaue': `import "lib.tetaue" as l\nq = l.helper & take 1`,
        }, 'main.tetaue');
        expect(result.diagnostics.map(d => d.message).join('\n')).toContain("module 'l' has no exported binding 'helper'");
    });

    test('qualified access preserves row polymorphism', () => {
        const sql = renderFiles({
            'predicates.tetaue': `export adult = u => u.age >= 18`,
            'main.tetaue': `
                import "predicates.tetaue" as p
                users: query { id: int, age: int } = table "users"
                kids: query { id: int, age: int, guardian: string } = table "kids"
                q = users & filter (p.adult) & take 1
            `,
        }, 'main.tetaue');
        expect(sql).toContain('WHERE age >= 18');
        // Same helper through the namespace against a different schema: no errors.
        const { result } = analyzeFiles({
            'predicates.tetaue': `export adult = u => u.age >= 18`,
            'main.tetaue': `
                import "predicates.tetaue" as p
                kids: query { id: int, age: int, guardian: string } = table "kids"
                q = kids & filter (p.adult) & take 1
            `,
        }, 'main.tetaue');
        expect(result.diagnostics).toEqual([]);
    });

    test('flat imports re-export nothing; re-export must be explicit', () => {
        const { result } = analyzeFiles({
            'columns.tetaue': `export users: query { id: int } = table "users"`,
            'base.tetaue': `import "columns.tetaue"`,
            'main.tetaue': `import "base.tetaue"\nq = users & take 1`,
        }, 'main.tetaue');
        expect(result.diagnostics.map(d => d.message).join('\n')).toContain("unknown identifier 'users'");
    });

    test('a namespaced import does not leak names into the flat scope', () => {
        const { result } = analyzeFiles({
            'tables.tetaue': `export users: query { id: int } = table "users"`,
            'main.tetaue': `import "tables.tetaue" as t\nq = users & take 1`,
        }, 'main.tetaue');
        expect(result.diagnostics.map(d => d.message).join('\n')).toContain("unknown identifier 'users'");
    });
});

describe('scope collisions are errors, never silent shadowing', () => {
    test('two flat imports exporting the same name conflict', () => {
        const { result } = analyzeFiles({
            'a.tetaue': `export users: query { id: int } = table "users_a"\nq = 1`,
            'b.tetaue': `export users: query { id: int, name: string } = table "users_b"\nq = 2`,
            'main.tetaue': `import "a.tetaue"\nimport "b.tetaue"\nq = users & take 1`,
        }, 'main.tetaue');
        const msgs = result.diagnostics.map(d => d.message).join('\n');
        expect(msgs).toContain("name 'users' (imported from 'b.tetaue') conflicts with 'users' imported from 'a.tetaue'");
        // The conflict is reported (it is NOT a silent last-wins).
        expect(result.diagnostics.length).toBeGreaterThan(0);
    });

    test('a local binding colliding with an imported name is an error', () => {
        const { result } = analyzeFiles({
            'tables.tetaue': `export users: query { id: int } = table "users"`,
            'main.tetaue': `import "tables.tetaue"\nusers = table "mine"\nq = users & take 1`,
        }, 'main.tetaue');
        expect(result.diagnostics.map(d => d.message).join('\n')).toContain("name 'users' (a local binding) conflicts with 'users' imported from 'tables.tetaue'");
    });

    test('two imports with the same alias conflict', () => {
        const { result } = analyzeFiles({
            'a.tetaue': `export x: query { id: int } = table "a"\nq = 1`,
            'b.tetaue': `export y: query { id: int } = table "b"\nq = 2`,
            'main.tetaue': `import "a.tetaue" as t\nimport "b.tetaue" as t\nq = t.x & take 1`,
        }, 'main.tetaue');
        expect(result.diagnostics.map(d => d.message).join('\n')).toContain("name 't' (import alias) conflicts with import alias 't'");
    });

    test('a module cannot see a sibling module (no scope leakage, either order)', () => {
        const files = {
            'a.tetaue': `q = secret & take 1`,
            'b.tetaue': `secret: query { id: int } = table "secret"\nq = 2`,
            'main.tetaue': `import "a.tetaue"\nimport "b.tetaue"\nq = 1`,
        };
        // b evaluated BEFORE a (DFS order) — the old shared-env behavior would
        // have resolved `secret`; now a's scope is exactly its own imports.
        const { result } = analyzeFiles(files, 'main.tetaue');
        expect(result.diagnostics.map(d => d.message).join('\n')).toContain("unknown identifier 'secret'");
        // And with b first in the root, same outcome.
        const { result: r2 } = analyzeFiles({ ...files, 'main.tetaue': `import "b.tetaue"\nimport "a.tetaue"\nq = 1` }, 'main.tetaue');
        expect(r2.diagnostics.map(d => d.message).join('\n')).toContain("unknown identifier 'secret'");
    });

    test('importing the same file twice (same form) is a no-op', () => {
        const { result } = analyzeFiles({
            'lib.tetaue': `export users: query { id: int } = table "users"`,
            'main.tetaue': `import "lib.tetaue"\nimport "lib.tetaue"\nq = users & take 1`,
        }, 'main.tetaue');
        // No phantom self-collision; the first import's names just apply.
        expect(result.diagnostics).toEqual([]);
        expect(result.value.kind).toBe('query');
    });

    test('a name from a sibling module is unknown, not "defined later"', () => {
        const { result } = analyzeFiles({
            'a.tetaue': `q = secret & take 1`,
            'b.tetaue': `secret: query { id: int } = table "secret"\nq = 2`,
            'main.tetaue': `import "a.tetaue"\nimport "b.tetaue"\nq = 1`,
        }, 'main.tetaue');
        // The old shared-env hint said "bindings must be defined before use";
        // with per-module scoping a sibling's name is simply unknown.
        const msgs = result.diagnostics.map(d => d.message).join('\n');
        expect(msgs).toContain("unknown identifier 'secret'");
        expect(msgs).not.toContain('must be defined before use');
    });

    test('export and as are reserved words', () => {
        // Not usable as binding names, field keys, or map keys.
        expect(() => parseModel(`export = table "users"`)).toThrow();
        expect(() => parseModel(`users: query { export: int } = table "users"\nq = users`)).toThrow();
        expect(() => parseModel(`import "a.tetaue" as as\nq = 1`)).toThrow();
    });
});

describe('selective imports', () => {
    test('import "x" (a, b) brings exactly those exports', () => {
        const sql = renderFiles({
            'tables.tetaue': `export users: query { id: int, active: bool } = table "users"\nexport orders: query { id: int } = table "orders"`,
            'main.tetaue': `
                import "tables.tetaue" (users)
                q = users & filter (u => u.active) & take 3
            `,
        }, 'main.tetaue');
        expect(sql).toContain('FROM users');
        expect(sql).toContain('LIMIT 3');
    });

    test('qualified type aliases work through a namespace import', () => {
        const sql = renderFiles({
            'schema.tetaue': `export type UserRow = query { id: int, name: string }`,
            'main.tetaue': `import "schema.tetaue" as s\nusers: s.UserRow = table "users"\nq = users & take 1`,
        }, 'main.tetaue');
        expect(sql).toContain('FROM users');
        const renamed = renderFiles({
            'schema.tetaue': `export type UserRow = query { id: int }`,
            'main.tetaue': `import "schema.tetaue" as s (UserRow as Row)\nusers: s.Row = table "users"\nq = users & take 1`,
        }, 'main.tetaue');
        expect(renamed).toContain('FROM users');
        const missing = analyzeFiles({
            'schema.tetaue': `export type UserRow = query { id: int }`,
            'main.tetaue': `import "schema.tetaue" as s\nusers: s.Nope = table "users"\nq = users & take 1`,
        }, 'main.tetaue');
        const typeDiags = inferProject(missing.tree.modules, missing.tree.importsByModule).diagnostics.map(d => d.message).join('\n');
        expect(typeDiags).toContain("unknown type 's.Nope'");
    });

    test('exported type aliases are imported flat and can be renamed', () => {
        const sql = renderFiles({
            'schema.tetaue': `export type UserRow = query { id: int, name: string }`,
            'main.tetaue': `import "schema.tetaue" (UserRow as Row)\nusers: Row = table "users"\nq = users & take 1`,
        }, 'main.tetaue');
        expect(sql).toContain('FROM users');
        const { result } = analyzeFiles({
            'schema.tetaue': `export type UserRow = query { id: int }`,
            'main.tetaue': `import "schema.tetaue"\nusers: UserRow = table "users"\nq = users & take 1`,
        }, 'main.tetaue');
        expect(result.diagnostics).toEqual([]);
    });

    test('import "x" (a as b) renames a flat selective import', () => {
        const sql = renderFiles({
            'tables.tetaue': `export users: query { id: int } = table "users"`,
            'main.tetaue': `import "tables.tetaue" (users as people)\nq = people & take 1`,
        }, 'main.tetaue');
        expect(sql).toContain('FROM users');
        expect(sql).toContain('LIMIT 1');
    });

    test('namespaced selective import renaming exposes the new name', () => {
        const { result } = analyzeFiles({
            'tables.tetaue': `export users: query { id: int } = table "users"`,
            'main.tetaue': `import "tables.tetaue" as t (users as people)\nq = t.people & take 1`,
        }, 'main.tetaue');
        expect(result.diagnostics).toEqual([]);
        const missing = analyzeFiles({
            'tables.tetaue': `export users: query { id: int } = table "users"`,
            'main.tetaue': `import "tables.tetaue" as t (users as people)\nq = t.users & take 1`,
        }, 'main.tetaue');
        expect(missing.result.diagnostics.map(d => d.message).join('\n')).toContain("module 't' has no exported binding 'users'");
    });

    test('an unlisted export stays invisible', () => {
        const { result } = analyzeFiles({
            'tables.tetaue': `export users: query { id: int } = table "users"\nexport orders: query { id: int } = table "orders"`,
            'main.tetaue': `import "tables.tetaue" (users)\nq = orders & take 1`,
        }, 'main.tetaue');
        expect(result.diagnostics.map(d => d.message).join('\n')).toContain("unknown identifier 'orders'");
    });

    test('a listed name that is not exported is an error', () => {
        const { result } = analyzeFiles({
            'tables.tetaue': `export users: query { id: int } = table "users"\nhelper = 1`,
            'main.tetaue': `import "tables.tetaue" (users, helper)\nq = users & take 1`,
        }, 'main.tetaue');
        const msgs = result.diagnostics.map(d => d.message).join('\n');
        expect(msgs).toContain("'helper' is not exported by 'tables.tetaue'");
        expect(msgs).toContain('exported: users');
    });

    test('namespaced selective import restricts the namespace', () => {
        const { tree } = analyzeFiles({
            'tables.tetaue': `export users: query { id: int } = table "users"\nexport orders: query { id: int } = table "orders"`,
            'main.tetaue': `import "tables.tetaue" as t (users)\nq = t.users & take 1\nq2 = t.orders & take 1`,
        }, 'main.tetaue');
        const r2 = analyzeProject(tree.modules, { requireQuery: false });
        expect(r2.diagnostics.map(d => d.message).join('\n')).toContain("module 't' has no exported binding 'orders'");
    });

    test('selective imports only collide on the names actually brought', () => {
        const { result } = analyzeFiles({
            'a.tetaue': `export users: query { id: int } = table "users_a"\nexport orders: query { id: int } = table "orders_a"\nq = 1`,
            'b.tetaue': `export users: query { id: int } = table "users_b"\nexport orders: query { id: int } = table "orders_b"\nq = 2`,
            'main.tetaue': `import "a.tetaue" (users)\nimport "b.tetaue" (orders)\nq = users & take 1\nq2 = orders & take 1`,
        }, 'main.tetaue');
        expect(result.diagnostics).toEqual([]);
        expect(result.value.kind).toBe('query');
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
            writeFileSync(join(dir, 'tables.tetaue'), 'export users: query { id: int } = table "users"\nbad = users & filter (u => u.id == "x")\n');
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
            writeFileSync(join(dir, 'tables.tetaue'), 'export users: query { id: int } = table "users"\n');
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

    test('validator resolves imports through a tetaue.toml dependency', async () => {
        const { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } = require('node:fs') as typeof import('node:fs');
        const { tmpdir } = require('node:os') as typeof import('node:os');
        const { join } = require('node:path') as typeof import('node:path');
        const { URI } = await import('langium');
        const dir = mkdtempSync(join(tmpdir(), 'tetaue-'));
        try {
            mkdirSync(join(dir, 'vendor', 'acme'), { recursive: true });
            writeFileSync(join(dir, 'tetaue.toml'), '[dependencies]\nacme = { path = "vendor/acme" }\n');
            writeFileSync(join(dir, 'vendor/acme/tables.tetaue'), 'export users: query { id: int } = table "users"\n');
            writeFileSync(join(dir, 'main.tetaue'), 'import "acme/tables"\nq = users & take 1\n');
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

    test('validator folds an undeclared dependency onto the import statement', async () => {
        const { mkdtempSync, writeFileSync, rmSync, readFileSync } = require('node:fs') as typeof import('node:fs');
        const { tmpdir } = require('node:os') as typeof import('node:os');
        const { join } = require('node:path') as typeof import('node:path');
        const { URI } = await import('langium');
        const dir = mkdtempSync(join(tmpdir(), 'tetaue-'));
        try {
            writeFileSync(join(dir, 'tetaue.toml'), '[dependencies]\nacme = { path = "vendor/acme" }\n');
            writeFileSync(join(dir, 'main.tetaue'), 'import "nope/tables"\nq = 1\n');
            const uri = URI.file(join(dir, 'main.tetaue'));
            const doc = await services.shared.workspace.LangiumDocumentFactory.fromString(
                readFileSync(join(dir, 'main.tetaue'), 'utf8'), uri,
            );
            await services.shared.workspace.DocumentBuilder.build([doc], { validation: true });
            const messages = (doc.diagnostics ?? []).map(d => d.message);
            expect(messages.join('\n')).toContain("dependency 'nope' is not declared in tetaue.toml");
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
            writeFileSync(join(dir, 'tables.tetaue'), 'export users: query { id: int, active: bool } = table "users"\n');
            writeFileSync(join(dir, 'main.tetaue'), 'import "tables.tetaue"\nq = users & filter (u => u.active) & take 3\n');
            const out = execFileSync('bun', ['run', 'src/cli.ts', 'render', join(dir, 'main.tetaue')], {
                cwd: resolve(import.meta.dir, '..'),
                encoding: 'utf8',
            });
            expect(out).toContain('FROM users');
            expect(out).toContain('WHERE active');
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
