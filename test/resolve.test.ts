/******************************************************************************
 * tetaue.toml library resolution tests.
 *
 * Unit tests drive resolveImport directly against temp directories; the CLI
 * end-to-end tests spawn `tetaue render/check` on a real manifest project.
 ******************************************************************************/
import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { URI } from 'langium';
import { resolveImport } from '../src/language/resolve.ts';

function project(): { dir: string; cleanup: () => void; uri: (rel: string) => string } {
    const dir = mkdtempSync(join(tmpdir(), 'tetaue-manifest-'));
    const uri = (rel: string) => URI.file(join(dir, rel)).toString();
    const cleanup = () => rmSync(dir, { recursive: true, force: true });
    return { dir, cleanup, uri };
}

function write(dir: string, rel: string, content: string): void {
    const file = join(dir, rel);
    mkdirSync(join(file, '..'), { recursive: true });
    writeFileSync(file, content);
}

describe('tetaue.toml dependency resolution', () => {
    test('relative imports win over dependencies', () => {
        const p = project();
        try {
            write(p.dir, 'tetaue.toml', `[dependencies]\nacme = { path = "vendor/acme" }\n`);
            write(p.dir, 'vendor/acme/tables.tetaue', `export users: query { id: int } = table "users"\n`);
            write(p.dir, 'tables.tetaue', `export users: query { id: int } = table "local"\n`);
            const r = resolveImport(p.uri('main.tetaue'), 'tables.tetaue');
            expect(r.uri).toBe(p.uri('tables.tetaue'));
        } finally {
            p.cleanup();
        }
    });

    test('import "acme/tables" resolves inside the declared dependency (extension inferred)', () => {
        const p = project();
        try {
            write(p.dir, 'tetaue.toml', `[dependencies]\nacme = { path = "vendor/acme" }\n`);
            write(p.dir, 'vendor/acme/tables.tetaue', `export users: query { id: int } = table "users"\n`);
            const r = resolveImport(p.uri('main.tetaue'), 'acme/tables');
            expect(r.uri).toBe(p.uri('vendor/acme/tables.tetaue'));
        } finally {
            p.cleanup();
        }
    });

    test('import "acme" (bare name) finds the dependency index.tetaue', () => {
        const p = project();
        try {
            write(p.dir, 'tetaue.toml', `[dependencies]\nacme = { path = "vendor/acme" }\n`);
            write(p.dir, 'vendor/acme/index.tetaue', `export users: query { id: int } = table "users"\n`);
            const r = resolveImport(p.uri('main.tetaue'), 'acme');
            expect(r.uri).toBe(p.uri('vendor/acme/index.tetaue'));
        } finally {
            p.cleanup();
        }
    });

    test('dependency paths resolve relative to the manifest directory', () => {
        const p = project();
        try {
            write(p.dir, 'tetaue.toml', `[dependencies]\nacme = { path = "vendor/acme" }\n`);
            write(p.dir, 'vendor/acme/tables.tetaue', `export users: query { id: int } = table "users"\n`);
            const r = resolveImport(p.uri('queries/main.tetaue'), 'acme/tables');
            expect(r.uri).toBe(p.uri('vendor/acme/tables.tetaue'));
        } finally {
            p.cleanup();
        }
    });

    test('a lib with its own tetaue.toml resolves ITS imports against its own dependencies', () => {
        const p = project();
        try {
            write(p.dir, 'tetaue.toml', `[dependencies]\nacme = { path = "vendor/acme" }\n`);
            write(p.dir, 'vendor/acme/tetaue.toml', `[dependencies]\nshared = { path = "../shared" }\n`);
            write(p.dir, 'vendor/acme/tables.tetaue', `export users: query { id: int } = table "users"\n`);
            write(p.dir, 'vendor/shared/columns.tetaue', `export columns: query { id: int } = table "columns"\n`);
            // Imported from INSIDE the lib: nearest manifest is acme's own.
            const r = resolveImport(p.uri('vendor/acme/tables.tetaue'), 'shared/columns');
            expect(r.uri).toBe(p.uri('vendor/shared/columns.tetaue'));
        } finally {
            p.cleanup();
        }
    });

    test('a lib without its own manifest uses the project manifest', () => {
        const p = project();
        try {
            write(p.dir, 'tetaue.toml', `[dependencies]\nacme = { path = "vendor/acme" }\nshared = { path = "vendor/shared" }\n`);
            write(p.dir, 'vendor/acme/tables.tetaue', `export users: query { id: int } = table "users"\n`);
            write(p.dir, 'vendor/shared/columns.tetaue', `export columns: query { id: int } = table "columns"\n`);
            const r = resolveImport(p.uri('vendor/acme/tables.tetaue'), 'shared/columns');
            expect(r.uri).toBe(p.uri('vendor/shared/columns.tetaue'));
        } finally {
            p.cleanup();
        }
    });

    test('path-ish specs never consult dependencies', () => {
        const p = project();
        try {
            write(p.dir, 'tetaue.toml', `[dependencies]\nacme = { path = "vendor/acme" }\n`);
            write(p.dir, 'vendor/acme/tables.tetaue', `export users: query { id: int } = table "users"\n`);
            // A relative-looking spec resolves next to the file ONLY — even
            // though `acme` is a declared dependency.
            const r = resolveImport(p.uri('main.tetaue'), './acme/tables');
            expect(r.uri).toBeUndefined();
            expect(r.error).toBeUndefined();
        } finally {
            p.cleanup();
        }
    });
});

describe('tetaue.toml resolution errors', () => {
    test('undeclared dependency', () => {
        const p = project();
        try {
            write(p.dir, 'tetaue.toml', `[dependencies]\nacme = { path = "vendor/acme" }\n`);
            const r = resolveImport(p.uri('main.tetaue'), 'nope/tables');
            expect(r.uri).toBeUndefined();
            expect(r.error).toContain("dependency 'nope' is not declared");
            expect(r.error).toContain('declared: acme');
        } finally {
            p.cleanup();
        }
    });

    test('broken dependency path', () => {
        const p = project();
        try {
            write(p.dir, 'tetaue.toml', `[dependencies]\nacme = { path = "missing" }\n`);
            const r = resolveImport(p.uri('main.tetaue'), 'acme/tables');
            expect(r.uri).toBeUndefined();
            expect(r.error).toContain("cannot read dependency 'acme'");
            expect(r.error).toContain('does not exist');
        } finally {
            p.cleanup();
        }
    });

    test('missing file inside a dependency', () => {
        const p = project();
        try {
            write(p.dir, 'tetaue.toml', `[dependencies]\nacme = { path = "vendor/acme" }\n`);
            write(p.dir, 'vendor/acme/tables.tetaue', `export users: query { id: int } = table "users"\n`);
            const r = resolveImport(p.uri('main.tetaue'), 'acme/nope');
            expect(r.uri).toBeUndefined();
            expect(r.error).toContain("no file 'nope' in dependency 'acme'");
        } finally {
            p.cleanup();
        }
    });

    test('malformed tetaue.toml', () => {
        const p = project();
        try {
            write(p.dir, 'tetaue.toml', '[dependencies\nbroken');
            const r = resolveImport(p.uri('main.tetaue'), 'acme/tables');
            expect(r.uri).toBeUndefined();
            expect(r.error).toContain('error in tetaue.toml');
        } finally {
            p.cleanup();
        }
    });

    test('no manifest anywhere above the file', () => {
        const p = project();
        try {
            const r = resolveImport(p.uri('main.tetaue'), 'nope.tetaue');
            expect(r.uri).toBeUndefined();
            expect(r.error).toContain('no tetaue.toml found');
        } finally {
            p.cleanup();
        }
    });

    test('a rest path that escapes the dependency is rejected', () => {
        const p = project();
        try {
            write(p.dir, 'tetaue.toml', `[dependencies]\nacme = { path = "vendor/acme" }\n`);
            write(p.dir, 'vendor/acme/tables.tetaue', `export users: query { id: int } = table "users"\n`);
            // vendor/tables.tetaue sits OUTSIDE the acme dependency; a `..`
            // rest must not reach it through the dependency mechanism.
            write(p.dir, 'vendor/tables.tetaue', `export users: query { id: int } = table "outside"\n`);
            const r = resolveImport(p.uri('main.tetaue'), 'acme/../tables');
            expect(r.uri).toBeUndefined();
            expect(r.error).toContain("escapes dependency 'acme'");
        } finally {
            p.cleanup();
        }
    });

    test('a malformed manifest entry is reported, not treated as undeclared', () => {
        const p = project();
        try {
            write(p.dir, 'tetaue.toml', `[dependencies]\nacme = "vendor/acme"\n`);
            const r = resolveImport(p.uri('main.tetaue'), 'acme/tables');
            expect(r.uri).toBeUndefined();
            expect(r.error).toContain("dependency 'acme' in tetaue.toml must be { path = \"…\" }");
        } finally {
            p.cleanup();
        }
    });
});

describe('tetaue.toml resolution warnings', () => {
    test('a local file shadowing a declared dependency warns', () => {
        const p = project();
        try {
            write(p.dir, 'tetaue.toml', `[dependencies]\nacme = { path = "vendor/acme" }\n`);
            write(p.dir, 'vendor/acme/tables.tetaue', `export users: query { id: int } = table "users"\n`);
            write(p.dir, 'acme/index.tetaue', `export users: query { id: int } = table "local"\n`);
            const r = resolveImport(p.uri('main.tetaue'), 'acme');
            expect(r.uri).toBe(p.uri('acme/index.tetaue')); // local wins
            expect(r.warning).toContain("local 'acme' shadows the declared dependency 'acme'");
        } finally {
            p.cleanup();
        }
    });

    test('a lib without its own manifest warns when its import falls through to the outer manifest', () => {
        const p = project();
        try {
            write(p.dir, 'tetaue.toml', `[dependencies]\nacme = { path = "vendor/acme" }\nshared = { path = "vendor/shared" }\n`);
            write(p.dir, 'vendor/acme/tables.tetaue', `export users: query { id: int } = table "users"\n`);
            write(p.dir, 'vendor/shared/columns.tetaue', `export columns: query { id: int } = table "columns"\n`);
            const r = resolveImport(p.uri('vendor/acme/tables.tetaue'), 'shared/columns');
            expect(r.uri).toBe(p.uri('vendor/shared/columns.tetaue'));
            expect(r.warning).toContain("inside dependency 'acme'");
            expect(r.warning).toContain('has no tetaue.toml');
        } finally {
            p.cleanup();
        }
    });

    test('a self-contained lib (own manifest) produces no warning', () => {
        const p = project();
        try {
            write(p.dir, 'tetaue.toml', `[dependencies]\nacme = { path = "vendor/acme" }\n`);
            write(p.dir, 'vendor/acme/tetaue.toml', `[dependencies]\nshared = { path = "../shared" }\n`);
            write(p.dir, 'vendor/acme/tables.tetaue', `export users: query { id: int } = table "users"\n`);
            write(p.dir, 'vendor/shared/columns.tetaue', `export columns: query { id: int } = table "columns"\n`);
            const r = resolveImport(p.uri('vendor/acme/tables.tetaue'), 'shared/columns');
            expect(r.uri).toBe(p.uri('vendor/shared/columns.tetaue'));
            expect(r.warning).toBeUndefined();
        } finally {
            p.cleanup();
        }
    });
});

describe('tetaue.toml through the CLI (end to end)', () => {
    const ROOT = resolve(import.meta.dir, '..');

    test('render resolves a declared dependency', () => {
        const p = project();
        try {
            write(p.dir, 'tetaue.toml', `[dependencies]\nacme = { path = "vendor/acme" }\n`);
            write(p.dir, 'vendor/acme/tables.tetaue', `export users: query { id: int, active: bool } = table "users"\n`);
            write(p.dir, 'main.tetaue', `import "acme/tables"\nmain = users & filter (u => u.active) & take 3\n`);
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

    test('check reports an undeclared dependency', () => {
        const p = project();
        try {
            write(p.dir, 'tetaue.toml', `[dependencies]\nacme = { path = "vendor/acme" }\n`);
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
            expect(out).toContain("dependency 'nope' is not declared");
            expect(out).toContain('declared: acme');
        } finally {
            p.cleanup();
        }
    });
});
