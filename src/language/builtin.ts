/******************************************************************************
 * tetaue builtin catalog — the single source of truth for the prelude.
 *
 * Every builtin's STATIC TYPE SCHEME lives here, declared once, and the type
 * inference pass builds its environment from this table (see inference.ts
 * `prelude()`). The interpreter's runtime implementations stay in
 * interpreter.ts (`BUILTINS`) — this catalog and that table are checked for
 * name parity by test/catalog.test.ts, so a builtin can never exist on one
 * side without the other.
 *
 * The schemes encode the DSL's MODES as types:
 *   - join kinds are a dedicated `jkind` type, so `join "inner"` is a type
 *     error (the kind is a constant, not a string);
 *   - aggregates return `agg t` and `group` returns `group t`, so a fold's
 *     entries must be aggregate/group mode (a plain column is a type error);
 *   - `asc`/`desc` return the `order` type, so sort's lambda must produce
 *     order items (see the sort post-check in inference.ts).
 *
 * `agg`/`group` are transparent in unification (like `?`), so comparing or
 * computing on aggregate results works; the fold/map mode checks in
 * inference.ts inspect the raw field types.
 *
 * The list-argument builtins (concat, greatest, least, round, substring,
 * lpad, rpad, regex_extract, lag, lead) take a SINGLE list argument —
 * `concat [u.first, u.last]` — instead of the old variadic application, so
 * they are ordinary curried functions: composable, partially applicable and
 * typed uniformly. The interpreter validates element kinds/arity at runtime;
 * inference checks each element's static kind (checkListBuiltin).
 ******************************************************************************/
import {
    type PrimName, type Scheme, type Type, type TypeUniverse, type VarKind,
    aggOf, fun, groupOf, jkindType, listOf, nullable, prim, queryOf, rowOf, windowOf,
} from './types.js';

export type BuiltinCategory =
    | 'query-root'      // table
    | 'query-step'      // filter, map, sort, take, distinct, fold, join
    | 'set'              // union, union_all, intersect, except
    | 'join-kind'       // inner, left, right, full
    | 'aggregate'       // count, sum, avg, min, max, list
    | 'group'           // group
    | 'order'           // asc, desc
    | 'record'          // merge
    | 'logic'           // not, is_in, is_not_in, like, case helpers
    | 'scalar'          // upper, lower, length, abs, coalesce, trim, ...
    | 'date'            // current_date, extract, year, date_add, ...
    | 'math'            // ceil, floor, sqrt, pow, mod
    | 'string'          // concat, substring, lpad, rpad, regex_*, ...
    | 'window'          // over, row_number, rank, lag, lead, ...
    | 'cast'            // cast, try_cast
    | 'constant';       // current_timestamp

export interface BuiltinSpec {
    name: string;
    category: BuiltinCategory;
    /** One-line doc for completion/hover (optional). */
    doc?: string;
    /** Build the type scheme; needs the universe for fresh variables. */
    scheme: (u: TypeUniverse) => Scheme;
}

/** Build a polymorphic scheme: named free variables, generalized. */
function poly(u: TypeUniverse, vars: [string, VarKind][], build: (...types: Type[]) => Type): Scheme {
    const types: Type[] = [];
    for (const [name, kind] of vars) {
        types.push(u.fresh(kind === 'row' ? 'row' : 'flex', name));
    }
    return u.generalize([], build(...types));
}

const mono = (t: Type): Scheme => ({ vars: [], type: t });
const p = (n: PrimName) => prim(n);

const rowVar = ['r', 'row'] as [string, VarKind];
const sRowVar = ['s', 'row'] as [string, VarKind];
const tVar = ['t', 'type'] as [string, VarKind];
const aVar = ['a', 'type'] as [string, VarKind];
const bVar = ['b', 'type'] as [string, VarKind];

/** The scheme of a one-argument step that maps rows (`map`, `fold`). */
function projectionScheme(u: TypeUniverse): Scheme {
    return poly(u, [rowVar, sRowVar], (r, s) =>
        fun(fun(r, rowOf([], s)), fun(queryOf(r), queryOf(rowOf([], s)))));
}

export const BUILTIN_SPECS = [
    // --- query roots -----------------------------------------------------
    { name: 'table', category: 'query-root', doc: 'a query root: table "users"', scheme: u => poly(u, [rowVar], r => fun(p('string'), queryOf(r))) },

    // --- query steps -----------------------------------------------------
    { name: 'filter', category: 'query-step', doc: 'keep rows matching a predicate (WHERE / HAVING)', scheme: u => poly(u, [rowVar], r => fun(fun(r, p('bool')), fun(queryOf(r), queryOf(r)))) },
    { name: 'map', category: 'query-step', doc: 'project one record per row (SELECT)', scheme: projectionScheme },
    { name: 'fold', category: 'query-step', doc: 'aggregate rows (SELECT ... GROUP BY ...)', scheme: projectionScheme },
    { name: 'sort', category: 'query-step', doc: 'ORDER BY — the lambda must return asc/desc items', scheme: u => poly(u, [rowVar, tVar], (r, t) => fun(fun(r, t), fun(queryOf(r), queryOf(r)))) },
    { name: 'take', category: 'query-step', doc: 'LIMIT n', scheme: u => poly(u, [rowVar], r => fun(p('int'), fun(queryOf(r), queryOf(r)))) },
    { name: 'distinct', category: 'query-step', doc: 'dedupe rows (SELECT DISTINCT)', scheme: u => poly(u, [rowVar], r => fun(queryOf(r), queryOf(r))) },
    { name: 'join', category: 'query-step', doc: 'join <kind> <right> <on> <merger>', scheme: u => poly(u, [rowVar, sRowVar, tVar], (r, s, t) => {
        const on = fun(r, fun(s, p('bool')));       // l => r => bool
        const merger = fun(r, fun(s, t));           // l => r => row t
        return fun(jkindType(), fun(queryOf(s), fun(on, fun(merger, fun(queryOf(r), queryOf(t))))));
    }) },

    // --- set operations (pure query -> query functions) -----------------
    { name: 'union', category: 'set', doc: 'UNION (distinct set union)', scheme: u => poly(u, [rowVar], r => fun(queryOf(r), fun(queryOf(r), queryOf(r)))) },
    { name: 'union_all', category: 'set', doc: 'UNION ALL', scheme: u => poly(u, [rowVar], r => fun(queryOf(r), fun(queryOf(r), queryOf(r)))) },
    { name: 'intersect', category: 'set', doc: 'INTERSECT (distinct set intersection)', scheme: u => poly(u, [rowVar], r => fun(queryOf(r), fun(queryOf(r), queryOf(r)))) },
    { name: 'except', category: 'set', doc: 'EXCEPT (distinct set difference)', scheme: u => poly(u, [rowVar], r => fun(queryOf(r), fun(queryOf(r), queryOf(r)))) },

    // --- join kinds (a dedicated type, not strings) ----------------------
    { name: 'inner', category: 'join-kind', doc: 'INNER JOIN', scheme: () => mono(jkindType()) },
    { name: 'left', category: 'join-kind', doc: 'LEFT JOIN', scheme: () => mono(jkindType()) },
    { name: 'right', category: 'join-kind', doc: 'RIGHT JOIN', scheme: () => mono(jkindType()) },
    { name: 'full', category: 'join-kind', doc: 'FULL JOIN', scheme: () => mono(jkindType()) },

    // --- ordering --------------------------------------------------------
    { name: 'asc', category: 'order', doc: 'an ascending ORDER BY item', scheme: u => poly(u, [tVar], t => fun(nullable(t), { kind: 'order' })) },
    { name: 'desc', category: 'order', doc: 'a descending ORDER BY item', scheme: u => poly(u, [tVar], t => fun(nullable(t), { kind: 'order' })) },

    // --- aggregates & grouping (aggregate/group MODES) -------------------
    { name: 'count', category: 'aggregate', doc: 'COUNT — aggregate mode', scheme: u => poly(u, [tVar], t => fun(nullable(t), aggOf(p('int')))) },
    { name: 'sum', category: 'aggregate', doc: 'SUM — aggregate mode', scheme: u => poly(u, [tVar], t => fun(nullable(t), aggOf(t))) },
    { name: 'avg', category: 'aggregate', doc: 'AVG — aggregate mode', scheme: u => poly(u, [tVar], t => fun(nullable(t), aggOf(p('float')))) },
    { name: 'min', category: 'aggregate', doc: 'MIN — aggregate mode', scheme: u => poly(u, [tVar], t => fun(nullable(t), aggOf(t))) },
    { name: 'max', category: 'aggregate', doc: 'MAX — aggregate mode', scheme: u => poly(u, [tVar], t => fun(nullable(t), aggOf(t))) },
    { name: 'list', category: 'aggregate', doc: 'collect values into a list — aggregate mode', scheme: u => poly(u, [tVar], t => fun(nullable(t), aggOf(listOf(nullable(t))))) },
    { name: 'group', category: 'group', doc: 'a GROUP BY key — group mode', scheme: u => poly(u, [tVar], t => fun(nullable(t), groupOf(t))) },

    // --- records ---------------------------------------------------------
    { name: 'merge', category: 'record', doc: 'record union — the right record wins on overlap', scheme: u => poly(u, [aVar, bVar], (a, b) => fun(a, fun(b, u.fresh('row')))) },

    // --- logic -----------------------------------------------------------
    { name: 'not', category: 'logic', doc: 'NOT', scheme: () => mono(fun(p('bool'), p('bool'))) },
    { name: 'is_in', category: 'logic', doc: 'IN — is_in x [a, b, ...]', scheme: u => poly(u, [tVar], t => fun(nullable(t), fun(listOf(nullable(t)), p('bool')))) },

    // --- scalar functions ------------------------------------------------
    { name: 'upper', category: 'scalar', doc: 'UPPER', scheme: () => mono(fun(nullable(p('string')), nullable(p('string')))) },
    { name: 'lower', category: 'scalar', doc: 'LOWER', scheme: () => mono(fun(nullable(p('string')), nullable(p('string')))) },
    { name: 'length', category: 'scalar', doc: 'LENGTH', scheme: () => mono(fun(nullable(p('string')), nullable(p('int')))) },
    { name: 'abs', category: 'math', doc: 'ABS', scheme: u => poly(u, [tVar], t => fun(nullable(t), nullable(t))) },
    { name: 'coalesce', category: 'scalar', doc: 'COALESCE', scheme: u => poly(u, [tVar], t => fun(nullable(t), fun(nullable(t), nullable(t)))) },

    // --- date & time -----------------------------------------------------
    { name: 'current_date', category: 'date', doc: 'CURRENT_DATE', scheme: () => mono(p('date')) },
    { name: 'current_timestamp', category: 'constant', doc: 'CURRENT_TIMESTAMP', scheme: () => mono(p('timestamp')) },
    { name: 'extract', category: 'date', doc: 'extract x "month"', scheme: u => poly(u, [tVar], t => fun(nullable(t), fun(p('string'), p('int')))) },
    { name: 'year', category: 'date', doc: 'year of a date', scheme: u => poly(u, [tVar], t => fun(nullable(t), p('int'))) },
    { name: 'month', category: 'date', doc: 'month of a date', scheme: u => poly(u, [tVar], t => fun(nullable(t), p('int'))) },
    { name: 'day', category: 'date', doc: 'day of a date', scheme: u => poly(u, [tVar], t => fun(nullable(t), p('int'))) },
    { name: 'day_of_week', category: 'date', doc: 'day of week of a date', scheme: u => poly(u, [tVar], t => fun(nullable(t), p('int'))) },
    { name: 'hour', category: 'date', doc: 'hour of a timestamp', scheme: u => poly(u, [tVar], t => fun(nullable(t), p('int'))) },
    { name: 'minute', category: 'date', doc: 'minute of a timestamp', scheme: u => poly(u, [tVar], t => fun(nullable(t), p('int'))) },
    { name: 'second', category: 'date', doc: 'second of a timestamp', scheme: u => poly(u, [tVar], t => fun(nullable(t), p('int'))) },
    { name: 'date_add', category: 'date', doc: 'date_add x "day" 1', scheme: u => poly(u, [tVar, aVar], (t, n) => fun(nullable(t), fun(p('string'), fun(nullable(n), nullable(t))))) },
    { name: 'date_diff', category: 'date', doc: 'date_diff x "day" other', scheme: u => poly(u, [tVar, aVar], (t, other) => fun(nullable(t), fun(p('string'), fun(nullable(other), p('int'))))) },
    { name: 'date_trunc', category: 'date', doc: 'date_trunc x "month"', scheme: u => poly(u, [tVar], t => fun(nullable(t), fun(p('string'), p('timestamp')))) },
    { name: 'date_format', category: 'date', doc: 'date_format x "%Y-%m-%d"', scheme: u => poly(u, [tVar], t => fun(nullable(t), fun(p('string'), nullable(p('string'))))) },
    { name: 'date_parse', category: 'date', doc: 'date_parse x "%Y-%m-%d"', scheme: () => mono(fun(nullable(p('string')), fun(p('string'), p('date')))) },
    { name: 'to_unixtime', category: 'date', doc: 'date to unix seconds', scheme: u => poly(u, [tVar], t => fun(nullable(t), p('int'))) },
    { name: 'from_unixtime', category: 'date', doc: 'unix seconds to timestamp', scheme: u => poly(u, [tVar], t => fun(nullable(p('int')), p('timestamp'))) },

    // --- math ------------------------------------------------------------
    { name: 'ceil', category: 'math', doc: 'CEIL', scheme: u => poly(u, [tVar], t => fun(nullable(t), nullable(t))) },
    { name: 'floor', category: 'math', doc: 'FLOOR', scheme: u => poly(u, [tVar], t => fun(nullable(t), nullable(t))) },
    { name: 'sqrt', category: 'math', doc: 'SQRT', scheme: u => poly(u, [tVar], t => fun(nullable(t), nullable(t))) },
    { name: 'pow', category: 'math', doc: 'POW', scheme: u => poly(u, [aVar, bVar], (a, b) => fun(nullable(a), fun(nullable(b), nullable(p('float'))))) },
    { name: 'mod', category: 'math', doc: 'MOD (the % operator)', scheme: u => poly(u, [aVar, bVar], (a, b) => fun(nullable(a), fun(nullable(b), nullable(a)))) },

    // --- strings ---------------------------------------------------------
    { name: 'trim', category: 'string', doc: 'TRIM', scheme: () => mono(fun(nullable(p('string')), nullable(p('string')))) },
    { name: 'reverse', category: 'string', doc: 'REVERSE (not sqlite)', scheme: () => mono(fun(nullable(p('string')), nullable(p('string')))) },
    { name: 'position', category: 'string', doc: 'POSITION / LOCATE / INSTR', scheme: () => mono(fun(nullable(p('string')), fun(nullable(p('string')), p('int')))) },
    { name: 'replace', category: 'string', doc: 'REPLACE', scheme: () => mono(fun(nullable(p('string')), fun(nullable(p('string')), fun(nullable(p('string')), nullable(p('string')))))) },
    { name: 'left_substring', category: 'string', doc: 'LEFT / SUBSTR', scheme: () => mono(fun(nullable(p('string')), fun(nullable(p('int')), nullable(p('string'))))) },
    { name: 'regex_like', category: 'string', doc: 'regex match', scheme: () => mono(fun(nullable(p('string')), fun(nullable(p('string')), p('bool')))) },
    { name: 'regex_replace', category: 'string', doc: 'regex replace', scheme: () => mono(fun(nullable(p('string')), fun(nullable(p('string')), fun(nullable(p('string')), nullable(p('string')))))) },

    // --- null handling ---------------------------------------------------
    { name: 'null_if', category: 'scalar', doc: 'NULLIF', scheme: u => poly(u, [tVar], t => fun(nullable(t), fun(nullable(t), nullable(t)))) },
    { name: 'is_null', category: 'logic', doc: 'IS NULL', scheme: u => poly(u, [tVar], t => fun(nullable(t), p('bool'))) },

    // --- casts -----------------------------------------------------------
    { name: 'cast', category: 'cast', doc: 'cast x "int"', scheme: u => poly(u, [tVar], t => fun(nullable(t), fun(p('string'), u.fresh()))) },

    // --- list-argument builtins (single list argument, curried) ----------
    { name: 'concat', category: 'string', doc: 'concat [a, b, ...]', scheme: () => mono(fun(listOf(nullable(p('string'))), nullable(p('string')))) },
    { name: 'greatest', category: 'scalar', doc: 'greatest [a, b, ...]', scheme: u => poly(u, [tVar], t => fun(listOf(nullable(t)), nullable(t))) },
    { name: 'round', category: 'math', doc: 'round [x] or round [x, scale]', scheme: u => poly(u, [tVar], t => fun(listOf(nullable(t)), nullable(t))) },
    { name: 'substring', category: 'string', doc: 'substring [s, start, length?]', scheme: () => mono(fun(listOf(nullable(p('string'))), nullable(p('string')))) },
    { name: 'lpad', category: 'string', doc: 'lpad [s, n, pad?]', scheme: () => mono(fun(listOf(nullable(p('string'))), nullable(p('string')))) },
    { name: 'regex_extract', category: 'string', doc: 'regex_extract [s, pattern, group?]', scheme: () => mono(fun(listOf(nullable(p('string'))), nullable(p('string')))) },
    { name: 'lag', category: 'window', doc: 'lag [x, offset?, default?] — window-only', scheme: u => poly(u, [tVar], t => fun(listOf(nullable(t)), windowOf(nullable(t)))) },

    // --- window functions ------------------------------------------------
    { name: 'over', category: 'window', doc: 'over (fn) { partition = [...], order = [...] }', scheme: u => poly(u, [aVar, bVar], (a, b) => fun(a, fun(b, a))) },
    { name: 'row_number', category: 'window', doc: 'ROW_NUMBER — window-only', scheme: () => mono(windowOf(p('int'))) },
    { name: 'rank', category: 'window', doc: 'RANK — window-only', scheme: () => mono(windowOf(p('int'))) },
    { name: 'dense_rank', category: 'window', doc: 'DENSE_RANK — window-only', scheme: () => mono(windowOf(p('int'))) },
    { name: 'percent_rank', category: 'window', doc: 'PERCENT_RANK — window-only', scheme: () => mono(windowOf(p('int'))) },
    { name: 'ntile', category: 'window', doc: 'NTILE — window-only', scheme: () => mono(fun(nullable(p('int')), windowOf(p('int')))) },
] as const satisfies readonly BuiltinSpec[];

/**
 * Names whose scheme is an alias of another builtin's (same typing, e.g.
 * `filtered` = `filter`, `is_not_in` = `is_in`). The inference pass copies
 * the target's scheme under the alias name.
 */
export const BUILTIN_ALIASES = {
    filtered: 'filter',
    is_not_in: 'is_in',
    right_substring: 'left_substring',
    like: 'regex_like',
    is_not_null: 'is_null',
    try_cast: 'cast',
    least: 'greatest',
    rpad: 'lpad',
    lead: 'lag',
} as const;

/** Every builtin name the type system knows (specs + aliases). */
export type BuiltinSpecName = (typeof BUILTIN_SPECS)[number]['name'];
export type BuiltinAliasName = keyof typeof BUILTIN_ALIASES;
export type BuiltinName = BuiltinSpecName | BuiltinAliasName;

export const BUILTIN_NAMES = [
    ...BUILTIN_SPECS.map(s => s.name),
    ...Object.keys(BUILTIN_ALIASES),
];

// ---------------------------------------------------------------------------
// Shared argument-shape metadata (used by both interpreter and inference)
// ---------------------------------------------------------------------------

/** Min/max element counts of the list-argument builtins. */
export const LIST_ARITY = {
    concat: [2, Infinity], greatest: [2, Infinity], least: [2, Infinity],
    round: [1, 2], substring: [2, 3], lpad: [2, 3], rpad: [2, 3],
    regex_extract: [2, 3], lag: [1, 3], lead: [1, 3],
} as Readonly<Record<string, readonly [number, number]>>;

/** Target type names accepted by cast/try_cast. */
export const CAST_TYPES = ['int', 'float', 'string', 'bool', 'date', 'timestamp'] as const;
