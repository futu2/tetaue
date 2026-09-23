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
import { BUILTIN_ALIASES, BUILTIN_NAMES, BUILTIN_SPECS, builtinModeOf } from '../src/language/catalog.js';
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
        // The SQL mode of an aggregate / group key / window function is a
        // property of the NAME (see BUILTIN_MODES), not a wrapper around the
        // scheme's result type: `Type` has no `agg`/`group`/`window` variant, so
        // the schemes are plain functions and the mode is checked from the
        // entry's syntax at the fold/map/over call sites.
        const u = new TypeUniverse();
        expect(spec.get('sum')!.scheme(u).type).toMatchObject({ kind: 'fun', to: { kind: 'maybe' } });
        expect(spec.get('group')!.scheme(u).type).toMatchObject({ kind: 'fun' });
        for (const [name, mode] of [['sum', 'agg'], ['count', 'agg'], ['group', 'group'], ['row_number', 'window'], ['lag', 'window']] as const) {
            expect(builtinModeOf(name)).toBe(mode);
        }
        expect(builtinModeOf('lead')).toBe('window');   // via the lag alias
        expect(builtinModeOf('over')).toBeNull();       // strips window mode
        expect(builtinModeOf('filter')).toBeNull();
        const names = BUILTIN_SPECS.map(item => item.name) as string[];
        for (const removed of ['join', 'inner', 'left', 'right', 'full']) {
            expect(names).not.toContain(removed);
        }
    });

    test('the date family threads one calendar variable through its argument and result', async () => {
        const { TypeUniverse } = await import('../src/language/types.js');
        const spec = new Map(BUILTIN_SPECS.map(s => [s.name, s]));
        const u = new TypeUniverse();
        // There is no DateTime class to state: the calendar type is an
        // ordinary variable now, and `postCheckArg` is what rejects a
        // non-calendar concrete primitive (see tests/dates.test.ts).
        expect(u.pretty(spec.get('year')!.scheme(u).type)).toBe('t -> int');
        expect(u.pretty(spec.get('extract')!.scheme(u).type)).toBe('t -> string -> int');
        // date_trunc preserves its input's date-ness (t in, t out).
        expect(u.pretty(spec.get('date_trunc')!.scheme(u).type)).toBe('t -> string -> t');
        expect(u.pretty(spec.get('date_format')!.scheme(u).type)).toBe('t -> string -> string');
        expect(u.pretty(spec.get('to_unixtime')!.scheme(u).type)).toBe('t -> int');
        // date_diff keeps two independent variables (no type pollution).
        expect(u.pretty(spec.get('date_diff')!.scheme(u).type)).toBe('t -> string -> a -> int');
        // date_add's amount is an independent variable, so a
        // partially-applied `date_add current_date "day"` stays polymorphic
        // in the amount and the numeric check happens per argument.
        expect(u.pretty(spec.get('date_add')!.scheme(u).type)).toBe('t -> string -> a -> t');
    });
});
