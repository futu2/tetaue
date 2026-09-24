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
import { BUILTIN_ALIASES, BUILTIN_NAMES, BUILTIN_SPECS, builtinModeOf, type BuiltinSpec } from '../src/language/catalog.js';
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

    test('the scalar surface is ordinary base code, not primitive catalog code', async () => {
        const moved = ['coalesce', 'concat', 'greatest', 'least', 'round', 'substring', 'lpad', 'rpad', 'nullIf', 'isTrue', 'isFalse', 'isUnknown'];
        for (const name of moved) {
            expect(BUILTIN_NAMES, `${name} must not be a primitive`).not.toContain(name);
            expect(Object.keys(BUILTINS), `${name} must not have a runtime builtin`).not.toContain(name);
        }
        const { baseLibraryModuleTypes } = await import('./helpers.ts');
        const sql = baseLibraryModuleTypes('base/sql.tetaue');
        for (const name of moved) {
            expect(sql.has(name), `${name} must be exported by base/sql.tetaue`).toBe(true);
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
        for (const [name, mode] of [['sum', 'agg'], ['count', 'agg'], ['group', 'group'], ['rowNumber', 'window'], ['lag', 'window']] as const) {
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

    test('every builtin whose SQL word is not the upper-cased name declares sqlName', () => {
        // tetaue names are camelCase, so the renderer cannot recover the SQL
        // word by upper-casing. A spec that needs a different word MUST carry
        // it, or the renderer emits a name no dialect has (`rowNumber` would
        // render `ROWNUMBER()`). This is the guard that keeps a new builtin
        // from silently regressing to that.
        // `BUILTIN_SPECS` is `as const` (so `BuiltinName` stays a precise
        // union), which hides the OPTIONAL `lower`/`sqlName` on entries that
        // omit them; widen to the declared interface for this read.
        const specs: readonly BuiltinSpec[] = BUILTIN_SPECS;
        const spec = new Map(specs.map(s => [s.name, s]));
        const expected: Record<string, string> = {
            countDistinct: 'COUNT',
            inQuery: 'IN',
            isIn: 'IN',
            rowNumber: 'ROW_NUMBER',
            denseRank: 'DENSE_RANK',
            percentRank: 'PERCENT_RANK',
        };
        for (const [name, sqlName] of Object.entries(expected)) {
            expect(spec.get(name)?.sqlName, name).toBe(sqlName);
        }
        // The converse, stated as the property the renderer actually needs:
        // every name that can reach the default `NAME(args)` path must resolve
        // to a SQL word. The reachable set is the builtins the evaluator turns
        // into `call` nodes under their own name (`rowNumber`, `dateAdd`,
        // ...); query steps and dedicated IR nodes (`currentDate`,
        // `joinLateral`) never become a function word, so they are not in it.
        // The date family is no longer in the catalog: every date/time
        // function is a definition in `base/sql/time.tetaue` (see the test
        // below), so it reaches the renderer as a `fragment`/`call` the
        // library built rather than as a builtin name.
        const CALL_NODE_NAMES = [
            'cast', 'denseRank', 'fromMaybe', 'ntile', 'percentRank', 'rank',
            'rowNumber', 'tryCast',
        ] as const;
        for (const name of CALL_NODE_NAMES) {
            const s = spec.get(name);
            expect(s, `${name} must be a catalog spec`).toBeDefined();
            // Either it declares the word, or owns a special lowering (the
            // date family, which never reaches the fallback), or the name has
            // no interior capital — so upper-casing it IS the SQL word
            // (`rank` -> RANK). Never a made-up
            // `ROWNUMBER`.
            const handled = s!.lower !== undefined
                || s!.sqlName !== undefined
                || !/[a-z][A-Z]/.test(name);
            expect(
                handled,
                `${name} renders through NAME(args) but neither declares a sqlName nor upper-cases to its SQL word`,
            ).toBe(true);
        }
    });

    test('the date family lives in the base library, not the primitive catalog', async () => {
        // The whole date/time FUNCTION family is defined in
        // `base/sql/time.tetaue` over the lowering vocabulary, so its
        // signatures are the exported bindings' inferred types — and none of
        // it is a primitive. Only the constants (`date`, `timestamp`,
        // `currentDate`, `currentTimestamp`) stay in the catalog, because they
        // map to their own IR nodes and no lowering can express them.
        const { TypeUniverse } = await import('../src/language/types.js');
        const spec = new Map<string, BuiltinSpec>(BUILTIN_SPECS.map(s => [s.name, s]));
        const u = new TypeUniverse();
        expect(u.pretty(spec.get('currentDate')!.scheme(u).type)).toBe('date');
        expect(u.pretty(spec.get('currentTimestamp')!.scheme(u).type)).toBe('timestamp');
        for (const name of ['year', 'extract', 'dateTrunc', 'dateFormat', 'toUnixtime', 'dateAdd', 'dateDiff']) {
            expect(spec.has(name), `${name} must NOT be a catalog spec`).toBe(false);
        }
        const { baseLibraryModuleTypes } = await import('./helpers.ts');
        const types = baseLibraryModuleTypes('base/sql/time.tetaue');
        // The calendar type is an ordinary variable: it threads through from
        // the argument to the result, which is what makes
        // `dateTrunc o.created_at "month"` a timestamp and
        // `dateTrunc o.order_date "month"` a date (see tests/dates.test.ts).
        expect(types.get('year')).toEqual(['a -> int']);
        expect(types.get('extract')).toEqual(['a -> string -> int']);
        expect(types.get('dateTrunc')).toEqual(['a -> string -> a']);
        expect(types.get('dateFormat')).toEqual(['a -> string -> string']);
        expect(types.get('toUnixtime')).toEqual(['a -> int']);
        expect(types.get('dateDiff')).toEqual(['a -> string -> b -> int']);
        expect(types.get('dateAdd')).toEqual(['a -> string -> int -> a']);
    });
});
