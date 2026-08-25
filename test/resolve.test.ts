/******************************************************************************
 * Import resolution tests — relative-path only.
 *
 * Unit tests drive resolveImport directly against temp directories; the CLI
 * end-to-end tests spawn `tetaue render/check` on a real module tree.
 ******************************************************************************/
import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { URI } from 'langium';
import { resolveImport } from '../src/language/resolve.ts';

function project(): { dir: string; cleanup: () => void; uri: (rel: string) => string } {
    const dir = mkdtempSync(join(tmpdir(), 'tetaue-resolve-'));
    const uri = (rel: string) => URI.file(join(dir, rel)).toString();
    const cleanup = () => rmSync(dir, { recursive: true, force: true });
    return { dir, cleanup, uri };
}

function write(dir: string, rel: string, content: string): void {
    const file = join(dir, rel);
    mkdirSync(join(file, '..'), { recursive: true });
    writeFileSync(file, content);
}

describe('relative-path import resolution', () => {
    test('a bare spec resolves next to the importing file', () => {
        const p = project();
        try {
            write(p.dir, 'tables.tetaue', `export users: query { id: int } = table "users"\n`);
            const r = resolveImport(p.uri('main.tetaue'), 'tables.tetaue');
            expect(r.uri).toBe(p.uri('tables.tetaue'));
        } finally {
            p.cleanup();
        }
    });

    test('the .tetaue extension is inferred', () => {
        const p = project();
        try {
            write(p.dir, 'tables.tetaue', `export users: query { id: int } = table "users"\n`);
            const r = resolveImport(p.uri('main.tetaue'), 'tables');
            expect(r.uri).toBe(p.uri('tables.tetaue'));
        } finally {
            p.cleanup();
        }
    });

    test('a folder import finds the index.tetaue (package folders work)', () => {
        const p = project();
        try {
            write(p.dir, 'vendor/acme/index.tetaue', `export users: query { id: int } = table "users"\n`);
            const r = resolveImport(p.uri('main.tetaue'), 'vendor/acme');
            expect(r.uri).toBe(p.uri('vendor/acme/index.tetaue'));
        } finally {
            p.cleanup();
        }
    });

    test('a path into a subfolder resolves relative to the importer', () => {
        const p = project();
        try {
            write(p.dir, 'vendor/acme/tables.tetaue', `export users: query { id: int } = table "users"\n`);
            const r = resolveImport(p.uri('main.tetaue'), 'vendor/acme/tables');
            expect(r.uri).toBe(p.uri('vendor/acme/tables.tetaue'));
        } finally {
            p.cleanup();
        }
    });

    test('relative specs resolve from the importing file, not the cwd', () => {
        const p = project();
        try {
            write(p.dir, 'queries/helpers.tetaue', `export h = 1\n`);
            const r = resolveImport(p.uri('queries/main.tetaue'), './helpers');
            expect(r.uri).toBe(p.uri('queries/helpers.tetaue'));
        } finally {
            p.cleanup();
        }
    });

    test('../ walks up from the importing file', () => {
        const p = project();
        try {
            // `vendor/acme/../shared/columns` == `vendor/shared/columns`.
            write(p.dir, 'vendor/shared/columns.tetaue', `export columns: query { id: int } = table "columns"\n`);
            const r = resolveImport(p.uri('vendor/acme/tables.tetaue'), '../shared/columns');
            expect(r.uri).toBe(p.uri('vendor/shared/columns.tetaue'));
        } finally {
            p.cleanup();
        }
    });

    test('resolution is a pure function of the file path (nested import)', () => {
        const p = project();
        try {
            write(p.dir, 'vendor/acme/tables.tetaue', `export users: query { id: int } = table "users"\n`);
            // An import INSIDE vendor/acme sees files relative to vendor/acme.
            const r = resolveImport(p.uri('vendor/acme/tables.tetaue'), './predicates');
            expect(r.uri).toBeUndefined();
            expect(r.searched).toEqual([join(p.dir, 'vendor/acme')]);
        } finally {
            p.cleanup();
        }
    });
});

describe('resolution errors', () => {
    test('a missing module reports the searched directory', () => {
        const p = project();
        try {
            const r = resolveImport(p.uri('main.tetaue'), 'nope/tables');
            expect(r.uri).toBeUndefined();
            expect(r.searched).toEqual([join(p.dir)]);
        } finally {
            p.cleanup();
        }
    });

    test('candidate forms (bare, .tetaue, index.tetaue) are all tried', () => {
        const p = project();
        try {
            write(p.dir, 'acme/index.tetaue', `export users: query { id: int } = table "users"\n`);
            // `acme/tables` matches neither `acme/tables`, `acme/tables.tetaue`
            // nor `acme/tables/index.tetaue` — only the bare `acme` folder does.
            const r = resolveImport(p.uri('main.tetaue'), 'acme/tables');
            expect(r.uri).toBeUndefined();
            expect(r.searched).toEqual([join(p.dir)]);
            expect(resolveImport(p.uri('main.tetaue'), 'acme').uri).toBe(p.uri('acme/index.tetaue'));
        } finally {
            p.cleanup();
        }
    });
});

describe('relative resolution through the CLI (end to end)', () => {
    const ROOT = resolve(import.meta.dir, '..');

    test('render resolves a relative import', () => {
        const p = project();
        try {
            write(p.dir, 'vendor/acme/tables.tetaue', `export users: query { id: int, active: bool } = table "users"\n`);
            write(p.dir, 'main.tetaue', `import "./vendor/acme/tables"\nmain = users & filter (u => u.active) & take 3\n`);
            const out = execFileSync('bun', ['run', 'src/cli.ts', 'render', join(p.dir, 'main.tetaue')], {
                cwd: ROOT,
                encoding: 'utf8',
                env: { ...process.env, BUN_TMPDIR: '/tmp/buntmp', BUN_INSTALL: '/tmp/buninstall' },
            });
            expect(out).toContain('FROM users');
            expect(out).toContain('WHERE active');
            expect(out).toContain('LIMIT 3');
        } finally {
            p.cleanup();
        }
    });

    test('check reports an unresolvable import', () => {
        const p = project();
        try {
            write(p.dir, 'main.tetaue', `import "nope/tables"\nq = 1\n`);
            let failed = false;
            let out = '';
            try {
                out = execFileSync('bun', ['run', 'src/cli.ts', 'check', join(p.dir, 'main.tetaue')], {
                    cwd: ROOT,
                    encoding: 'utf8',
                    env: { ...process.env, BUN_TMPDIR: '/tmp/buntmp', BUN_INSTALL: '/tmp/buninstall' },
                });
            } catch (err) {
                failed = true;
                out = String((err as { stderr?: Buffer }).stderr ?? err);
            }
            expect(failed).toBe(true);
            expect(out).toContain("cannot resolve import 'nope/tables'");
        } finally {
            p.cleanup();
        }
    });

    test('render through an index module that re-exports', () => {
        const p = project();
        try {
            write(p.dir, 'lib/tables.tetaue', `export users: query { id: int, active: bool } = table "users"\n`);
            write(p.dir, 'lib/index.tetaue', `export * from "./tables"\n`);
            write(p.dir, 'main.tetaue', `import "./lib"\nmain = users & filter (u => u.active) & take 2\n`);
            const out = execFileSync('bun', ['run', 'src/cli.ts', 'render', join(p.dir, 'main.tetaue')], {
                cwd: ROOT,
                encoding: 'utf8',
                env: { ...process.env, BUN_TMPDIR: '/tmp/buntmp', BUN_INSTALL: '/tmp/buninstall' },
            });
            expect(out).toContain('FROM users');
            expect(out).toContain('LIMIT 2');
        } finally {
            p.cleanup();
        }
    });
});