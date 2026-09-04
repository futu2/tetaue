/******************************************************************************
 * tetaue primitive builtin catalog — the single source of truth for the core.
 *
 * Every core primitive's STATIC TYPE SCHEME lives here, declared once, and the
 * type inference pass builds its primitive environment from this table (see
 * inference.ts `prelude()`). The runtime implementations stay in
 * interpreter.ts (`BUILTINS`) — this catalog and that table are checked for
 * name parity by test/catalog.test.ts. Derived public functions live in
 * prelude.tetaue and therefore do not appear in either table.
 *
 * The schemes encode the DSL's MODES as types:
 *   - aggregates return `agg t` and `group` returns `group t`, so a fold's
 *     entries must be aggregate/group mode (a plain column is a type error);
 *   - `asc`/`desc` return the `order` type, so sort's lambda must produce
 *     order items (see the sort post-check in inference.ts).
 *
 * `agg`/`group` are transparent in unification (like `?`), so comparing or
 * computing on aggregate results works; the fold/map mode checks in
 * inference.ts inspect the raw field types.
 *
 * Argument-passing for many-argument builtins:
 *   - The genuinely variadic, homogeneous builtins (concat, greatest, least)
 *     take a SINGLE list argument — `concat [u.first, u.last]` — which is the
 *     sound pure-functional encoding of variadic application: a homogeneous
 *     `[string]` / `[t]` list types exactly what they consume. The
 *     interpreter validates element kinds/arity at runtime; inference checks
 *     each element's static kind (checkListBuiltin).
 *   - Builtins with heterogeneous arguments (round, substring, lpad, rpad,
 *     lag, lead) are ordinary curried functions whose types state every
 *     position exactly. An argument is `maybe`-typed only when OMITTING it
 *     changes the meaning (`substring`'s length: `substring u.name 1 nothing`
 *     means to the end; `lag`'s default is NULL, i.e. `nothing`). An argument
 *     that is optional merely because SQL has a DEFAULT VALUE for it is
 *     required instead, so the caller writes the default explicitly:
 *     `round u.balance 0` (scale defaults to 0 in SQL), `lpad u.code 8 "0"`
 *     (pad defaults to ' '), `lag u.salary 1 nothing` (offset defaults to 1).
 *     A list of heterogeneous arguments would be unsound — one element type
 *     cannot express `[string, int, ...]` — so these builtins never take a
 *     list.
 ******************************************************************************/
import {
    type PrimName, type Scheme, type Type, type TypeClass, type TypeUniverse, type VarKind,
    fun, listOf, maybeOf, modeOf, prim, queryOf, rowOf, truthType,
} from './types.js';

export type BuiltinCategory =
    | 'query-root'      // table
    | 'query-step'      // filter, map, sort, take, distinct, fold, joins
    | 'set'              // union, union_all, intersect, except
    | 'aggregate'       // count, sum, avg, min, max, list
    | 'group'           // group
    | 'order'           // asc, desc
    | 'record'          // merge
    | 'logic'           // not, is_in, is_not_in, like, case helpers
    | 'scalar'          // upper, lower, length, abs, coalesce, trim, ...
    | 'date'            // current_date, extract, year, date_add, ...
    | 'math'            // ceil, floor, sqrt, pow, mod
    | 'string'          // concat, substring, lpad, rpad, ...
    | 'list'            // pure in-memory list combinators (list.* namespace)
    | 'window'          // over, row_number, rank, lag, lead, ...
    | 'cast'            // cast
    | 'constant';       // current_timestamp

export interface BuiltinSpec {
    name: string;
    category: BuiltinCategory;
    /** One-line doc for completion/hover (optional). */
    doc?: string;
    /** Build the type scheme; needs the universe for fresh variables. */
    scheme: (u: TypeUniverse) => Scheme;
}

/** Primitive scalar types supplied by the core. */
export const CORE_TYPE_NAMES = ['int', 'float', 'decimal', 'string', 'bool', 'date', 'timestamp'] as const;
export type CoreTypeName = (typeof CORE_TYPE_NAMES)[number];

/** Build a polymorphic scheme: named free variables, generalized.
 *  `constraints` attach type classes to the variables by position
 *  (`['DateTime']` on the first variable makes it `DateTime t => ...`). */
function poly(u: TypeUniverse, vars: [string, VarKind][], build: (...types: Type[]) => Type, constraints: Record<number, TypeClass> = {}): Scheme {
    const types: Type[] = [];
    for (const [i, [name, kind]] of vars.entries()) {
        types.push(u.fresh(kind === 'row' ? 'row' : 'flex', name, i in constraints ? [constraints[i]!] : []));
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

/** Fixed-kind join scheme, including the side null-extended by an outer join. */
function joinScheme(kind: 'inner' | 'left' | 'right' | 'full'): (u: TypeUniverse) => Scheme {
    return u => poly(u, [rowVar, sRowVar, tVar], (r, s, t) => {
        const on = fun(r, fun(s, p('bool')));       // l => r => bool
        const mergerLeft = kind === 'right' || kind === 'full' ? maybeOf(r) : r;
        const mergerRight = kind === 'left' || kind === 'full' ? maybeOf(s) : s;
        const merger = fun(mergerLeft, fun(mergerRight, t));
        return fun(queryOf(s), fun(on, fun(merger, fun(queryOf(r), queryOf(t)))));
    });
}

export const BUILTIN_SPECS = [
    // --- query roots -----------------------------------------------------
    { name: 'param', category: 'scalar', doc: 'param "name" — a query parameter placeholder', scheme: u => poly(u, [tVar], t => fun(p('string'), t)) },
    { name: 'table', category: 'query-root', doc: 'a query root: table "users"', scheme: u => poly(u, [rowVar], r => fun(p('string'), queryOf(r))) },

    // --- query steps -----------------------------------------------------
    { name: 'filter', category: 'query-step', doc: 'keep rows matching a predicate (WHERE / HAVING)', scheme: u => poly(u, [rowVar], r => fun(fun(r, p('bool')), fun(queryOf(r), queryOf(r)))) },
    { name: 'select', category: 'query-step', doc: 'select ["id", "name"] — project only the listed columns', scheme: u => poly(u, [rowVar], r => fun(listOf(p('string')), fun(queryOf(r), queryOf(r)))) },
    { name: 'map', category: 'query-step', doc: 'project one record per row (SELECT)', scheme: projectionScheme },
    { name: 'fold', category: 'query-step', doc: 'group or aggregate rows (SELECT ... GROUP BY ...)', scheme: projectionScheme },
    { name: 'sort', category: 'query-step', doc: 'ORDER BY — the lambda must return asc/desc items', scheme: u => poly(u, [rowVar, tVar], (r, t) => fun(fun(r, t), fun(queryOf(r), queryOf(r)))) },
    { name: 'take', category: 'query-step', doc: 'LIMIT n', scheme: u => poly(u, [rowVar], r => fun(p('int'), fun(queryOf(r), queryOf(r)))) },
    { name: 'drop', category: 'query-step', doc: 'OFFSET n — skip the first n rows', scheme: u => poly(u, [rowVar], r => fun(p('int'), fun(queryOf(r), queryOf(r)))) },
    { name: 'recursive', category: 'query-step', doc: 'recursive f — WITH RECURSIVE fixed point (UNION ALL)', scheme: u => poly(u, [rowVar], r => fun(fun(queryOf(r), queryOf(r)), fun(queryOf(r), queryOf(r)))) },
    { name: 'distinct', category: 'query-step', doc: 'dedupe rows (SELECT DISTINCT)', scheme: u => poly(u, [rowVar], r => fun(queryOf(r), queryOf(r))) },
    { name: 'join_lateral', category: 'query-step', doc: 'join_lateral right_fn on merger — LATERAL join (PG/MySQL)', scheme: u => poly(u, [rowVar, sRowVar, tVar], (r, s, t) => {
        const rightFn = fun(r, queryOf(s));     // l => query over right rows
        const on = fun(r, fun(s, p('bool')));   // l => r => bool
        const merger = fun(r, fun(s, t));       // l => r => row t
        return fun(rightFn, fun(on, fun(merger, fun(queryOf(r), queryOf(t)))));
    }) },
    { name: 'joinInner', category: 'query-step', doc: 'joinInner right on merger — INNER JOIN', scheme: joinScheme('inner') },
    { name: 'joinLeft', category: 'query-step', doc: 'joinLeft right on merger — LEFT JOIN', scheme: joinScheme('left') },
    { name: 'joinRight', category: 'query-step', doc: 'joinRight right on merger — RIGHT JOIN', scheme: joinScheme('right') },
    { name: 'joinFull', category: 'query-step', doc: 'joinFull right on merger — FULL JOIN', scheme: joinScheme('full') },

    // --- set operations (pure query -> query functions) -----------------
    { name: 'union', category: 'set', doc: 'UNION (distinct set union)', scheme: u => poly(u, [rowVar], r => fun(queryOf(r), fun(queryOf(r), queryOf(r)))) },
    { name: 'union_all', category: 'set', doc: 'UNION ALL', scheme: u => poly(u, [rowVar], r => fun(queryOf(r), fun(queryOf(r), queryOf(r)))) },
    { name: 'intersect', category: 'set', doc: 'INTERSECT (distinct set intersection)', scheme: u => poly(u, [rowVar], r => fun(queryOf(r), fun(queryOf(r), queryOf(r)))) },
    { name: 'except', category: 'set', doc: 'EXCEPT (distinct set difference)', scheme: u => poly(u, [rowVar], r => fun(queryOf(r), fun(queryOf(r), queryOf(r)))) },

    // --- ordering --------------------------------------------------------
    { name: 'asc', category: 'order', doc: 'an ascending ORDER BY item', scheme: u => poly(u, [tVar], t => fun(t, { kind: 'order' })) },
    { name: 'desc', category: 'order', doc: 'a descending ORDER BY item', scheme: u => poly(u, [tVar], t => fun(t, { kind: 'order' })) },

    // --- aggregates & grouping (aggregate/group MODES) -------------------
    { name: 'count_distinct', category: 'aggregate', doc: 'COUNT(DISTINCT x) — aggregate mode', scheme: u => poly(u, [tVar], t => fun(t, modeOf('agg', p('int')))) },
    { name: 'count_where', category: 'aggregate', doc: 'count_where cond x — filtered COUNT', scheme: u => poly(u, [tVar], t => fun(p('bool'), fun(t, modeOf('agg', p('int'))))) },
    { name: 'sum_where', category: 'aggregate', doc: 'sum_where cond x — filtered SUM', scheme: u => poly(u, [tVar], t => fun(p('bool'), fun(t, modeOf('agg', maybeOf(t))))) },
    { name: 'avg_where', category: 'aggregate', doc: 'avg_where cond x — filtered AVG', scheme: u => poly(u, [tVar], t => fun(p('bool'), fun(t, modeOf('agg', maybeOf(p('float')))))) },
    { name: 'min_where', category: 'aggregate', doc: 'min_where cond x — filtered MIN', scheme: u => poly(u, [tVar], t => fun(p('bool'), fun(t, modeOf('agg', maybeOf(t))))) },
    { name: 'max_where', category: 'aggregate', doc: 'max_where cond x — filtered MAX', scheme: u => poly(u, [tVar], t => fun(p('bool'), fun(t, modeOf('agg', maybeOf(t))))) },
    { name: 'count', category: 'aggregate', doc: 'COUNT — aggregate mode', scheme: u => poly(u, [tVar], t => fun(t, modeOf('agg', p('int')))) },
    { name: 'sum', category: 'aggregate', doc: 'SUM — aggregate mode (maybe result: empty/all-null input is NULL)', scheme: u => poly(u, [tVar], t => fun(t, modeOf('agg', maybeOf(t)))) },
    { name: 'avg', category: 'aggregate', doc: 'AVG — aggregate mode (maybe result)', scheme: u => poly(u, [tVar], t => fun(t, modeOf('agg', maybeOf(p('float'))))) },
    { name: 'min', category: 'aggregate', doc: 'MIN — aggregate mode (maybe result)', scheme: u => poly(u, [tVar], t => fun(t, modeOf('agg', maybeOf(t)))) },
    { name: 'max', category: 'aggregate', doc: 'MAX — aggregate mode (maybe result)', scheme: u => poly(u, [tVar], t => fun(t, modeOf('agg', maybeOf(t)))) },
    { name: 'array', category: 'aggregate', doc: 'collect values into a list/array — aggregate mode', scheme: u => poly(u, [tVar], t => fun(t, modeOf('agg', listOf(t)))) },
    { name: 'group', category: 'group', doc: 'a GROUP BY key — group mode', scheme: u => poly(u, [tVar], t => fun(t, modeOf('group', t))) },

    // --- records ---------------------------------------------------------
    { name: 'merge', category: 'record', doc: 'record union — the right record wins on overlap', scheme: u => poly(u, [aVar, bVar], (a, b) => fun(a, fun(b, u.fresh('row')))) },
    // Record transformers (teta-style pure record helpers), used inside map:
    //   map (rename (k => "user_" <> k))  — rename every field via a rule
    //   map (pick ["id", "email"])        — keep the listed fields in order
    //   map (omit ["password_hash"])      — remove the listed fields
    // `rename` is fully generic; `pick`/`omit` get a precise special case in
    // inference.ts (inferRecordPicker) so their static output row is known.
    { name: 'rename', category: 'record', doc: 'rename every record field with a key rule — map (rename (k => "user_" <> k))', scheme: u => poly(u, [rowVar], r => fun(fun(p('string'), p('string')), fun(r, u.fresh('row')))) },
    { name: 'pick', category: 'record', doc: 'keep only the listed record fields, in order — map (pick ["id", "email"])', scheme: u => poly(u, [rowVar], r => fun(listOf(p('string')), fun(r, u.fresh('row')))) },
    { name: 'omit', category: 'record', doc: 'remove the listed record fields — map (omit ["password_hash"])', scheme: u => poly(u, [rowVar], r => fun(listOf(p('string')), fun(r, u.fresh('row')))) },

    // --- logic -----------------------------------------------------------
    { name: 'exists', category: 'logic', doc: 'exists query — correlated EXISTS subquery', scheme: u => poly(u, [rowVar], r => fun(queryOf(r), p('bool'))) },
    { name: 'scalar', category: 'logic', doc: 'scalar query — a correlated scalar subquery returning one nullable column', scheme: u => poly(u, [rowVar, tVar], (r, t) => fun(queryOf(r), t)) },
    { name: 'not', category: 'logic', doc: 'NOT', scheme: () => mono(fun(p('bool'), p('bool'))) },
    { name: 'in_query', category: 'logic', doc: 'IN (SELECT ...) — in_query x subquery', scheme: u => poly(u, [tVar, rowVar], (t, r) => fun(t, fun(queryOf(r), p('bool')))) },
    { name: 'is_in', category: 'logic', doc: 'IN — is_in x [a, b, ...]', scheme: u => poly(u, [tVar], t => fun(t, fun(listOf(t), p('bool')))) },
    // `like` (binary operator) lives in prelude.tetaue as sql_infix "LIKE".

    // --- scalar functions ------------------------------------------------
    // `upper`, `lower`, `length`, `trim` live in prelude.tetaue; `abs`,
    // `ceil`, `floor`, `sqrt` live there too (Num-constrained, sql_func).
    { name: 'coalesce', category: 'scalar', doc: 'COALESCE', scheme: u => poly(u, [tVar], t => fun(maybeOf(t), fun(maybeOf(t), maybeOf(t)))) },

    // --- date & time -----------------------------------------------------
    { name: 'date', category: 'constant', doc: 'date "2024-01-01" — ISO date literal', scheme: () => mono(fun(p('string'), p('date'))) },
    { name: 'timestamp', category: 'constant', doc: 'timestamp "2024-01-01 12:00:00" — ISO timestamp literal', scheme: () => mono(fun(p('string'), p('timestamp'))) },
    { name: 'current_date', category: 'date', doc: 'CURRENT_DATE', scheme: () => mono(p('date')) },
    { name: 'current_timestamp', category: 'constant', doc: 'CURRENT_TIMESTAMP', scheme: () => mono(p('timestamp')) },
    { name: 'extract', category: 'date', doc: 'extract x "field"', scheme: u => poly(u, [tVar], t => fun(t, fun(p('string'), p('int'))), { 0: 'DateTime' }) },
    { name: 'year', category: 'date', doc: 'year of a date', scheme: u => poly(u, [tVar], t => fun(t, p('int')), { 0: 'DateTime' }) },
    { name: 'month', category: 'date', doc: 'month of a date', scheme: u => poly(u, [tVar], t => fun(t, p('int')), { 0: 'DateTime' }) },
    { name: 'day', category: 'date', doc: 'day of a date', scheme: u => poly(u, [tVar], t => fun(t, p('int')), { 0: 'DateTime' }) },
    { name: 'day_of_week', category: 'date', doc: 'day of week of a date', scheme: u => poly(u, [tVar], t => fun(t, p('int')), { 0: 'DateTime' }) },
    { name: 'hour', category: 'date', doc: 'hour of a timestamp', scheme: u => poly(u, [tVar], t => fun(t, p('int')), { 0: 'DateTime' }) },
    { name: 'minute', category: 'date', doc: 'minute of a timestamp', scheme: u => poly(u, [tVar], t => fun(t, p('int')), { 0: 'DateTime' }) },
    { name: 'second', category: 'date', doc: 'second of a timestamp', scheme: u => poly(u, [tVar], t => fun(t, p('int')), { 0: 'DateTime' }) },
    { name: 'date_add', category: 'date', doc: 'date_add x "day" 1', scheme: u => poly(u, [tVar, aVar], (t, n) => fun(t, fun(p('string'), fun(n, t))), { 0: 'DateTime', 1: 'Num' }) },
    { name: 'date_diff', category: 'date', doc: 'date_diff x "day" other', scheme: u => poly(u, [tVar, aVar], (t, other) => fun(t, fun(p('string'), fun(other, p('int')))), { 0: 'DateTime', 1: 'DateTime' }) },
    { name: 'date_trunc', category: 'date', doc: 'date_trunc x "month" — date stays date, timestamp stays timestamp', scheme: u => poly(u, [tVar], t => fun(t, fun(p('string'), t)), { 0: 'DateTime' }) },
    { name: 'date_format', category: 'date', doc: 'date_format x "%Y-%m-%d"', scheme: u => poly(u, [tVar], t => fun(t, fun(p('string'), p('string'))), { 0: 'DateTime' }) },
    { name: 'date_parse', category: 'date', doc: 'date_parse x "%Y-%m-%d"', scheme: () => mono(fun(p('string'), fun(p('string'), p('date')))) },
    { name: 'to_unixtime', category: 'date', doc: 'date to unix seconds', scheme: u => poly(u, [tVar], t => fun(t, p('int')), { 0: 'DateTime' }) },
    { name: 'from_unixtime', category: 'date', doc: 'unix seconds to timestamp', scheme: u => poly(u, [tVar], t => fun(p('int'), p('timestamp'))) },

    // --- math ------------------------------------------------------------
    // All math builtins are now prelude definitions: abs/ceil/floor/sqrt
    // (Num-constrained), pow (Num a => Num b =>), div/mod.

    // --- pure list combinators (the list.* namespace) --------------------
    // Pure, in-memory operations over list values — the Haskell base List
    // vocabulary, kept out of the unqualified (relational/SQL) namespace so
    // the two never collide. `elem`/`map`/`filter` here are the list
    // functions; their SQL counterparts are the query steps.
    { name: 'list_map', category: 'list', doc: 'list.map f xs — apply f to every element (a -> b) -> [a] -> [b]', scheme: u => poly(u, [aVar, bVar], (a, b) => fun(fun(a, b), fun(listOf(a), listOf(b)))) },
    { name: 'list_filter', category: 'list', doc: 'list.filter p xs — keep elements matching a predicate (a -> Bool) -> [a] -> [a]', scheme: u => poly(u, [aVar], a => fun(fun(a, p('bool')), fun(listOf(a), listOf(a)))) },
    { name: 'list_fold', category: 'list', doc: 'list.fold f z xs — left fold (b -> a -> b) -> b -> [a] -> b', scheme: u => poly(u, [aVar, bVar], (a, b) => fun(fun(b, fun(a, b)), fun(b, fun(listOf(a), b)))) },
    { name: 'list_foldr', category: 'list', doc: 'list.foldr f z xs — right fold (a -> b -> b) -> b -> [a] -> b', scheme: u => poly(u, [aVar, bVar], (a, b) => fun(fun(a, fun(b, b)), fun(b, fun(listOf(a), b)))) },
    { name: 'list_sum', category: 'list', doc: 'list.sum xs — fold (+) over numeric elements', scheme: u => poly(u, [aVar], a => fun(listOf(a), a), { 0: 'Num' }) },
    { name: 'list_product', category: 'list', doc: 'list.product xs — fold (*) over numeric elements', scheme: u => poly(u, [aVar], a => fun(listOf(a), a), { 0: 'Num' }) },
    { name: 'list_length', category: 'list', doc: 'list.length xs — element count (empty = 0)', scheme: u => poly(u, [aVar], a => fun(listOf(a), p('int'))) },
    { name: 'list_reverse', category: 'list', doc: 'list.reverse xs — elements in reverse order', scheme: u => poly(u, [aVar], a => fun(listOf(a), listOf(a))) },
    { name: 'list_concat', category: 'list', doc: 'list.concat xss — flatten a list of lists', scheme: u => poly(u, [aVar], a => fun(listOf(listOf(a)), listOf(a))) },
    { name: 'list_append', category: 'list', doc: 'list.append xs ys — join two lists (++) [a] -> [a] -> [a]', scheme: u => poly(u, [aVar], a => fun(listOf(a), fun(listOf(a), listOf(a)))) },
    { name: 'list_take', category: 'list', doc: 'list.take n xs — first n elements', scheme: u => poly(u, [aVar], a => fun(p('int'), fun(listOf(a), listOf(a)))) },
    { name: 'list_drop', category: 'list', doc: 'list.drop n xs — all but the first n elements', scheme: u => poly(u, [aVar], a => fun(p('int'), fun(listOf(a), listOf(a)))) },
    { name: 'list_head', category: 'list', doc: 'list.head xs — first element (empty is an error)', scheme: u => poly(u, [aVar], a => fun(listOf(a), a)) },
    { name: 'list_last', category: 'list', doc: 'list.last xs — last element (empty is an error)', scheme: u => poly(u, [aVar], a => fun(listOf(a), a)) },
    { name: 'list_null', category: 'list', doc: 'list.isEmpty xs — true iff the list is empty', scheme: u => poly(u, [aVar], a => fun(listOf(a), p('bool'))) },
    { name: 'list_elem', category: 'list', doc: 'list.elem x xs — whether x appears in xs', scheme: u => poly(u, [aVar], a => fun(a, fun(listOf(a), p('bool')))) },

    // --- generic SQL call builder (prelude lowering) --------------------
    // `sql_func name [args]` emits an uninterpreted SQL function call. It is
    // the building block the source prelude uses to express per-dialect
    // lowerings (branched on the hidden `sql_dialect` value) without a new TS
    // builtin per function. The result type is left open (`b`) — the prelude
    // definition that wraps it pins the type at its use site.
    { name: 'sql_func', category: 'scalar', doc: 'sql_func name [args] — an uninterpreted SQL function call', scheme: u => poly(u, [tVar], t => fun(p('string'), fun(listOf(t), u.fresh()))) },
    // `sql_infix op left right` emits an uninterpreted infix SQL expression
    // (`left op right`, e.g. `sql_infix "IN" n x` -> `n IN x`). The result
    // type is left open (`c`) — a comparison is bool, `div` is int, etc. —
    // and the prelude annotation pins it at the use site.
    { name: 'sql_infix', category: 'scalar', doc: 'sql_infix op left right — an uninterpreted infix SQL expression (left op right)', scheme: u => poly(u, [aVar, bVar], (a, b) => fun(p('string'), fun(a, fun(b, u.fresh())))) },
    // `sql_cast value "target"` emits an uninterpreted CAST(value AS target).
    // The result type is left open (`b`) — the prelude definition pins it via
    // its annotation (e.g. `year: date -> int`).
    { name: 'sql_cast', category: 'scalar', doc: 'sql_cast value "target" — an uninterpreted CAST(value AS target)', scheme: u => poly(u, [tVar], t => fun(t, fun(p('string'), u.fresh()))) },

    // --- strings ---------------------------------------------------------
    // `trim` lives in prelude.tetaue (a plain `sql_func "TRIM"` wrapper).
    // `reverse` stays a core builtin: sqlite lowers it to a recursive CTE,
    // which sql_func cannot express yet (see sql-dialect.md).
    { name: 'reverse', category: 'string', doc: 'REVERSE (dialect fallback where needed)', scheme: () => mono(fun(p('string'), p('string'))) },
    // `replace`, `left_substring`/`right_substring` live in prelude.tetaue
    // (dialect-branching over sql_func/sql_infix).

    // --- closed Functor / Applicative / Alternative / Monad operations ----
    // Catalog schemes keep a Maybe shape for tooling and fallback application;
    // inference specializes complete calls to the closed list/query variants.
    { name: 'fmap', category: 'scalar', doc: 'fmap f value — closed Functor lift over maybe values, lists, and queries', scheme: u => poly(u, [aVar, bVar], (a, b) => fun(fun(a, b), fun(maybeOf(a), maybeOf(b)))) },
    { name: 'replaceWith', category: 'scalar', doc: 'replaceWith x value — closed (<$) over maybe values, lists, and queries', scheme: u => poly(u, [aVar, bVar], (a, b) => fun(a, fun(maybeOf(b), maybeOf(a)))) },
    { name: 'ap', category: 'scalar', doc: 'ap functions values — closed Applicative application for maybe values and lists', scheme: u => poly(u, [aVar, bVar], (a, b) => fun(maybeOf(fun(a, b)), fun(maybeOf(a), maybeOf(b)))) },
    { name: 'applyLeft', category: 'scalar', doc: 'applyLeft left right — sequence two maybe values or lists, keeping the left', scheme: u => poly(u, [aVar, bVar], (a, b) => fun(maybeOf(a), fun(maybeOf(b), maybeOf(a)))) },
    { name: 'applyRight', category: 'scalar', doc: 'applyRight left right — sequence two maybe values or lists, keeping the right', scheme: u => poly(u, [aVar, bVar], (a, b) => fun(maybeOf(a), fun(maybeOf(b), maybeOf(b)))) },
    { name: 'orElse', category: 'scalar', doc: 'orElse first second — closed Alternative choice for maybe values and lists', scheme: u => poly(u, [aVar], a => fun(maybeOf(a), fun(maybeOf(a), maybeOf(a)))) },
    { name: 'bind', category: 'scalar', doc: 'bind value function — closed Monad bind for maybe values and lists', scheme: u => poly(u, [aVar, bVar], (a, b) => fun(maybeOf(a), fun(fun(a, maybeOf(b)), maybeOf(b)))) },
    { name: 'then', category: 'scalar', doc: 'then first second — closed Monad sequencing for maybe values and lists', scheme: u => poly(u, [aVar, bVar], (a, b) => fun(maybeOf(a), fun(maybeOf(b), maybeOf(b)))) },
    { name: 'just', category: 'scalar', doc: 'just x — lift a non-null SQL value into maybe', scheme: u => poly(u, [tVar], t => fun(t, maybeOf(t))) },
    { name: 'nothing', category: 'constant', doc: 'nothing — SQL NULL as maybe', scheme: u => poly(u, [tVar], t => maybeOf(t)) },
    { name: 'from_maybe', category: 'scalar', doc: 'from_maybe default maybe_value — COALESCE', scheme: u => poly(u, [tVar], t => fun(t, fun(maybeOf(t), t))) },
    { name: 'null_if', category: 'scalar', doc: 'NULLIF', scheme: u => poly(u, [tVar], t => fun(maybeOf(t), fun(maybeOf(t), maybeOf(t)))) },
    { name: 'is_null', category: 'logic', doc: 'IS NULL', scheme: u => poly(u, [tVar], t => fun(maybeOf(t), p('bool'))) },
    { name: 'maybe_isJust', category: 'logic', doc: 'maybe.isJust x — not (is_null x); the Data.Maybe isJust', scheme: u => poly(u, [tVar], t => fun(maybeOf(t), p('bool'))) },
    { name: 'is_true', category: 'logic', doc: 'SQL three-valued logic: IS TRUE', scheme: () => mono(fun(truthType(), p('bool'))) },
    { name: 'is_false', category: 'logic', doc: 'SQL three-valued logic: IS FALSE', scheme: () => mono(fun(truthType(), p('bool'))) },
    { name: 'is_unknown', category: 'logic', doc: 'SQL three-valued logic: IS UNKNOWN / NULL', scheme: () => mono(fun(truthType(), p('bool'))) },

    // --- casts -----------------------------------------------------------
    { name: 'cast', category: 'cast', doc: 'cast x "int"', scheme: u => poly(u, [tVar], t => fun(t, fun(p('string'), u.fresh()))) },

    // --- list-argument builtins (homogeneous variadic: the list types exactly
    // what they consume — a sound pure-functional encoding of variadic application)
    { name: 'concat', category: 'string', doc: 'concat [a, b, ...]', scheme: () => mono(fun(listOf(p('string')), p('string'))) },
    { name: 'greatest', category: 'scalar', doc: 'greatest [a, b, ...]', scheme: u => poly(u, [tVar], t => fun(listOf(t), t)) },

    // --- curried builtins with heterogeneous arguments -------------------
    // Every position is curried with its exact type. An argument is
    // `maybe`-typed only when omitting it changes the meaning; arguments
    // whose SQL default value makes them "optional" are required instead.
    { name: 'round', category: 'math', doc: 'round x scale — scale is required (0 rounds to integer)', scheme: u => poly(u, [tVar], t => fun(t, fun(p('int'), t))) },
    { name: 'substring', category: 'string', doc: 'substring s start (just length) — length optional (omitted = to the end)', scheme: () => mono(fun(p('string'), fun(p('int'), fun(maybeOf(p('int')), p('string'))))) },
    { name: 'lpad', category: 'string', doc: 'lpad s n pad — pad is required (SQL defaults to a space)', scheme: () => mono(fun(p('string'), fun(p('int'), fun(p('string'), p('string'))))) },
    { name: 'lag', category: 'window', doc: 'lag x offset (just default) — offset required, default optional (NULL)', scheme: u => poly(u, [tVar], t => fun(t, fun(p('int'), fun(maybeOf(t), modeOf('window', t))))) },

    // --- window functions ------------------------------------------------
    { name: 'over', category: 'window', doc: 'over (fn) { partition = [...], order = [...] }', scheme: u => poly(u, [aVar, bVar], (a, b) => fun(a, fun(b, a))) },
    { name: 'row_number', category: 'window', doc: 'ROW_NUMBER — window-only', scheme: () => mono(modeOf('window', p('int'))) },
    { name: 'rank', category: 'window', doc: 'RANK — window-only', scheme: () => mono(modeOf('window', p('int'))) },
    { name: 'dense_rank', category: 'window', doc: 'DENSE_RANK — window-only', scheme: () => mono(modeOf('window', p('int'))) },
    { name: 'percent_rank', category: 'window', doc: 'PERCENT_RANK — window-only', scheme: () => mono(modeOf('window', p('int'))) },
    { name: 'ntile', category: 'window', doc: 'NTILE — window-only', scheme: () => mono(fun(p('int'), modeOf('window', p('int')))) },

    // --- monoid identity ---------------------------------------------------
    // Type-directed: inference resolves the instance at the use site (string,
    // list, record) and the interpreter produces the matching empty value.
    // A BARE flexible variable: the kind adapts to the use site (row for
    // records, type for string/list), and the closed Monoid instance table is
    // enforced by the pending-use check in inference.ts (checkMemptyResolved),
    // not by a static constraint (which could not express row-kind instances).
    { name: 'mempty', category: 'constant', doc: 'monoid identity — "" for string, [] for lists, {} for records', scheme: u => mono(u.fresh()) },
] as const satisfies readonly BuiltinSpec[];

/**
 * Core names whose scheme matches another primitive even though their runtime
 * behavior differs (for example `is_not_in` and `is_in`). The inference pass
 * copies the target's scheme under the second name.
 */
export const BUILTIN_ALIASES = {
    is_not_in: 'is_in',
    least: 'greatest',
    rpad: 'lpad',
    lead: 'lag',
    not_in_query: 'in_query',
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

/** Min/max element counts of the list-argument builtins (homogeneous variadic only). */
export const LIST_ARITY = {
    concat: [2, Infinity], greatest: [2, Infinity], least: [2, Infinity],
} as Readonly<Record<string, readonly [number, number]>>;

/** Target type names accepted by cast. */
export const CAST_TYPES = ['int', 'float', 'decimal', 'string', 'bool', 'date', 'timestamp'] as const;
