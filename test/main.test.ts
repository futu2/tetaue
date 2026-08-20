/******************************************************************************
 * `main` module entry — the module's query is its `main` binding.
 *
 * A module without `main` is a library: it type-checks (no SQL requiring), and
 * `build` does not emit SQL for it. `--binding` overrides the entry to render
 * a specific named binding.
 ******************************************************************************/
import { describe, expect, test } from 'bun:test';
import { compileModuleText } from '../src/language/compile.ts';
import { standardPrelude } from '../src/language/prelude.ts';
import { createTetaueServices } from '../src/language/tetaue-module.ts';
import { NodeFileSystem } from 'langium/node';
import { checkProject } from '../src/language/checker.ts';
import { parseModel } from './helpers.ts';

const services = createTetaueServices(NodeFileSystem).tetaue;
const prelude = standardPrelude(services);

function check(src: string, options?: Parameters<typeof checkProject>[1]) {
    const model = parseModel(src);
    return checkProject([{ model, uri: undefined, imports: [] }], {
        prelude,
        importsByModule: new Map(),
        ...options,
    });
}

describe('main module entry', () => {
    test('main is the module query', () => {
        const { value, diagnostics } = check(
            `t: query { id: int } = table "t"\nlib = t & take 99\nmain = t & take 3`,
        );
        expect(diagnostics.map(d => d.message)).toEqual([]);
        expect(value.kind).toBe('query');
        // Render picks `main` (take 3), not the earlier lib binding.
        const out = compileModuleText('mem', `t: query { id: int } = table "t"\nlib = t & take 99\nmain = t & take 3`, services, {});
        expect(out).toMatchObject({ ok: true });
        if (out.ok) expect(out.sql).toContain('LIMIT 3');
    });

    test('without main, a query module is a library (lenient fallback still validates last binding)', () => {
        // Lenient (default requireMain=false): last binding is treated as the
        // query so tooling/tests keep working.
        const lenient = check(`t: query { id: int } = table "t"\nq = t & take 5`);
        expect(lenient.diagnostics.map(d => d.message)).toEqual([]);
        expect(lenient.value.kind).toBe('query');
        // Strict (requireMain): no main => library / error.
        const strict = check(`t: query { id: int } = table "t"\nq = t & take 5`, { requireMain: true });
        expect(strict.value.kind).toBe('error');
        expect(strict.diagnostics.map(d => d.message).join('\n')).toContain("`main` binding");
    });

    test('strict main still allows --binding to render a named binding', () => {
        const { value, diagnostics } = check(
            `a: query { id: int } = table "a"\nmain = a & take 2`,
            { requireMain: true, entryBinding: 'a' },
        );
        expect(diagnostics.map(d => d.message)).toEqual([]);
        expect(value.kind).toBe('query');
    });

    test("a main binding that isn't a query is an error", () => {
        const { diagnostics } = check(`main = 42`, { requireMain: true });
        expect(diagnostics.map(d => d.message).join('\n')).toContain("binding 'main' must be a query");
    });

    test('build treats a clean no-main module as a library', () => {
        const outcome = compileModuleText('mem', `export double = x => x * 2\n`, services, {
            requireMain: true,
            requireQuery: false,
        });
        expect(outcome.ok).toBe(false);
        expect('diagnostics' in outcome && outcome.diagnostics.length).toBe(0);
    });
});
