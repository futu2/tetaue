/******************************************************************************
 * Builtin catalog parity — the single source of truth.
 *
 * Every builtin's static type scheme lives in src/language/catalog.ts; the
 * interpreter's runtime implementations live in src/language/interpreter.ts
 * (BUILTINS). These tests pin the two to each other: a builtin can never
 * exist on one side without the other, so the inference pass and the
 * interpreter cannot drift apart.
 ******************************************************************************/
import { describe, expect, test } from 'bun:test';
import { BUILTIN_ALIASES, BUILTIN_NAMES, BUILTIN_SPECS } from '../src/language/catalog.js';
import { BUILTINS } from '../src/language/interpreter.js';

describe('builtin catalog', () => {
    test('every catalog name is unique', () => {
        const names = BUILTIN_SPECS.map(s => s.name);
        expect(new Set(names).size).toBe(names.length);
        // Aliases must not collide with specs (a name is either a spec or an alias).
        for (const alias of Object.keys(BUILTIN_ALIASES)) {
            expect(names).not.toContain(alias);
        }
    });

    test('every alias target is a catalog spec', () => {
        const names = new Set(BUILTIN_SPECS.map(s => s.name));
        for (const target of Object.values(BUILTIN_ALIASES)) {
            expect(names).toContain(target);
        }
    });

    test('the catalog and the interpreter implement the same builtin set', () => {
        const catalog = new Set(BUILTIN_NAMES);
        const interpreter = new Set(Object.keys(BUILTINS));
        const onlyCatalog = [...catalog].filter(n => !interpreter.has(n)).sort();
        const onlyInterpreter = [...interpreter].filter(n => !catalog.has(n)).sort();
        expect(onlyCatalog, 'catalog-only names (missing interpreter impl)').toEqual([]);
        expect(onlyInterpreter, 'interpreter-only names (missing type scheme)').toEqual([]);
    });

    test('the list-argument builtins are the catalog + interpreter list', () => {
        const list = ['concat', 'greatest', 'least', 'round', 'substring', 'lpad', 'rpad', 'lag', 'lead'];
        for (const name of list) {
            expect(BUILTIN_NAMES).toContain(name);
            expect(Object.keys(BUILTINS)).toContain(name);
        }
    });

    test('fixed-kind joins and aggregate modes have the expected schemes', async () => {
        const { TypeUniverse } = await import('../src/language/types.js');
        const spec = new Map(BUILTIN_SPECS.map(s => [s.name, s]));
        for (const name of ['joinInner', 'joinLeft', 'joinRight', 'joinFull'] as const) {
            const t = spec.get(name)!.scheme(new TypeUniverse());
            expect(t.type).toMatchObject({
                kind: 'fun',
                from: { kind: 'query' },
                to: { kind: 'fun' },
            });
        }
        const u = new TypeUniverse();
        expect(spec.get('sum')!.scheme(u).type).toMatchObject({ kind: 'fun', to: { kind: 'agg' } });
        expect(spec.get('group')!.scheme(u).type).toMatchObject({ kind: 'fun', to: { kind: 'group' } });
        const names = BUILTIN_SPECS.map(item => item.name) as string[];
        for (const removed of ['join', 'inner', 'left', 'right', 'full']) {
            expect(names).not.toContain(removed);
        }
    });
});
