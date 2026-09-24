/******************************************************************************
 * tetaue primitive builtin catalog — the single source of truth for the core.
 *
 * Every core primitive's STATIC TYPE SCHEME lives here, declared once, and the
 * type inference pass builds its primitive environment from this table (see
 * inference.ts `prelude()`). The runtime implementations stay in
 * interpreter.ts (`BUILTINS`) — this catalog and that table are checked for
 * name parity by test/catalog.test.ts. Derived public functions live in
 * base/sql.tetaue and therefore do not appear in either table.
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
 * The scalar and string helpers intentionally do not appear here. They are
 * ordinary overloaded/curried definitions in `base/sql.tetaue`; this table
 * keeps only primitives whose evaluator must understand query shape or an
 * IR node that a generic SQL call cannot express. `lag`/`lead` remain core
 * because they are window nodes and their legality depends on `over`.
 ******************************************************************************/
import {
    type PrimName, type Scheme, type Type, type TypeUniverse, type VarKind,
    fun, listOf, maybeOf, nullRowOf, prim, queryOf, rowOf,
} from './types.js';

export type BuiltinCategory =
    | 'query-root'      // table
    | 'query-step'      // filter, map, sort, take, distinct, fold, joins
    | 'set'              // union, unionAll, intersect, except
    | 'aggregate'       // count, sum, avg, min, max, list
    | 'group'           // group
    | 'order'           // asc, desc
    | 'record'          // merge
    | 'logic'           // not, isIn, isNotIn, like, case helpers
    | 'scalar'          // toUpper, toLower, length, abs, coalesce, trim, ...
    | 'date'            // currentDate, extract, year, dateAdd, ...
    | 'math'            // ceil, floor, sqrt, pow, mod
    | 'string'          // concat, substring, lpad, rpad, ...
    | 'list'            // pure in-memory list combinators (list.* namespace)
    | 'window'          // over, rowNumber, rank, lag, lead, ...
    | 'cast'            // cast
    | 'constant';       // currentTimestamp

/**
 * What a per-dialect lowering is given: the call's ARGUMENTS ALREADY RENDERED
 * to SQL text, the dialect name, and a couple of helpers. Passing text rather
 * than IR nodes is deliberate — it keeps a lowering a pure string function
 * that cannot reach back into the plan or the evaluator, which is what makes
 * lowerings data instead of a code path.
 *
 * This is the ONLY place a special SQL wrapper should live. Before the
 * registry these were `renderCall`'s switch arms plus the hand-kept
 * `SPECIAL_CALLS` membership set, which had to be kept in sync by hand.
 */
export interface LowerCtx {
    /**
     * The call's name AS IT APPEARS IN THE IR. This is usually the canonical
     * name, but an alias keeps its own spelling (`rpad` stays `rpad`, not
     * `lpad`) — verified against the evaluator, which resolves aliases for
     * argument-index purposes but stores the written name in the call node.
     * Lowerings that differ between a name and its alias must read this.
     */
    readonly name: string;
    /** The dialect name: `'sqlite'`, `'postgresql'`, `'mysql'`, `'trino'`, `'hive'`. */
    readonly dialect: string;
    /** Argument `i`, already rendered (call precedence applied). */
    arg(i: number): string;
    /**
     * The raw value of argument `i` when it is a literal, else null. Needed by
     * lowerings that treat an argument as METADATA rather than data — `cast`'s
     * target type is a string literal naming a SQL type, so it must not be
     * rendered (and quoted) like a value; `extract`'s field and `dateAdd`'s
     * unit are likewise keywords rather than values.
     */
    literal(i: number): string | null;
    /** The numeric value of argument `i` when it is a numeric literal, else null. */
    numberLiteral(i: number): number | null;
    /** Number of arguments the call has. */
    readonly arity: number;
    /** Render a string literal in this dialect (quoting/escape differences). */
    stringLiteral(value: string): string;
    /** The dialect's SQL type name for a `cast` target. */
    castTypeName(tetaueType: string): string;
}

/** A per-dialect SQL lowering. Return null to fall back to the default form. */
export type Lowering = (ctx: LowerCtx) => string | null;

export interface BuiltinSpec {
    name: string;
    category: BuiltinCategory;
    /** One-line doc for completion/hover (optional). */
    doc?: string;
    /** Build the type scheme; needs the universe for fresh variables. */
    scheme: (u: TypeUniverse) => Scheme;
    /**
     * A special SQL lowering, when the default `NAME(arg, ...)` form is wrong
     * for at least one dialect. Absent (the common case) → the renderer uses
     * the dialect's `functions` name map, then `sqlName`.
     */
    lower?: Lowering;
    /**
     * The SQL word(s) the default `NAME(args)` render emits — `ROW_NUMBER`
     * for `rowNumber`, `CURRENT_DATE` for `currentDate`, `IS NULL` for
     * `isNull`.
     *
     * REQUIRED for every builtin whose tetaue name is not already the SQL name
     * in upper case: tetaue names are camelCase, so the renderer can no longer
     * derive the SQL word by upper-casing (`rowNumber` -> `ROWNUMBER` is not a
     * function any dialect has). Keeping this next to the spec — rather than
     * as a second table in the renderer — is what stops the two drifting.
     *
     * Omit it when `name.toUpperCase()` IS the SQL name (`sum`, `count`,
     * `rank`, `ntile`, ...).
     */
    sqlName?: string;
}

/** Primitive scalar types supplied by the core. */
export const CORE_TYPE_NAMES = ['int', 'float', 'decimal', 'string', 'bool', 'date', 'timestamp'] as const;
export type CoreTypeName = (typeof CORE_TYPE_NAMES)[number];

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

/** Fixed-kind join scheme, including the side null-extended by an outer join. */
function joinScheme(kind: 'inner' | 'left' | 'right' | 'full'): (u: TypeUniverse) => Scheme {
    return u => poly(u, [rowVar, sRowVar, tVar], (r, s, t) => {
        const on = fun(r, fun(s, p('bool')));       // l => r => bool
        // SQL null extension is FIELD-WISE: an outer join never makes the whole
        // row absent, it makes each of its fields NULL. So the merger sees
        // `nullRow s` (each field maybe), not `maybe s` (whole row maybe).
        const mergerLeft = kind === 'right' || kind === 'full' ? nullRowOf(r) : r;
        const mergerRight = kind === 'left' || kind === 'full' ? nullRowOf(s) : s;
        const merger = fun(mergerLeft, fun(mergerRight, t));
        return fun(queryOf(s), fun(on, fun(merger, fun(queryOf(r), queryOf(t)))));
    });
}

/**
 * Every core primitive, declared once. The `satisfies` clause keeps each
 * entry's NAME as a string literal (so `BuiltinSpecName` stays a precise
 * union) while still checking every entry against `BuiltinSpec` — including
 * the optional `lower` field. A plain type annotation would widen the names to
 * `string` and break the `DialectSpec.functions` key map.
 */
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
    { name: 'joinLateral', category: 'query-step', doc: 'joinLateral right_fn on merger — LATERAL join (PG/MySQL)', scheme: u => poly(u, [rowVar, sRowVar, tVar], (r, s, t) => {
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
    { name: 'unionAll', category: 'set', doc: 'UNION ALL', scheme: u => poly(u, [rowVar], r => fun(queryOf(r), fun(queryOf(r), queryOf(r)))) },
    { name: 'intersect', category: 'set', doc: 'INTERSECT (distinct set intersection)', scheme: u => poly(u, [rowVar], r => fun(queryOf(r), fun(queryOf(r), queryOf(r)))) },
    { name: 'except', category: 'set', doc: 'EXCEPT (distinct set difference)', scheme: u => poly(u, [rowVar], r => fun(queryOf(r), fun(queryOf(r), queryOf(r)))) },

    // --- ordering --------------------------------------------------------
    // `asc`/`desc` are TRANSPARENT in the type system: they return the very
    // type of their argument (`asc u.name : string`). "This is an ORDER BY
    // item" is a property of the EXPRESSION, checked syntactically at the
    // application site (inference's sort check), not a tag carried in `Type` —
    // the two would otherwise be indistinguishable to every other rule, which
    // is why the old `order` tag needed special transparency in unification.
    { name: 'asc', category: 'order', doc: 'an ascending ORDER BY item', scheme: u => poly(u, [tVar], t => fun(t, t)) },
    { name: 'desc', category: 'order', doc: 'a descending ORDER BY item', scheme: u => poly(u, [tVar], t => fun(t, t)) },

    // --- aggregates & grouping (aggregate/group MODES) -------------------
    { name: 'countDistinct', category: 'aggregate', doc: 'COUNT(DISTINCT x) — aggregate mode', scheme: u => poly(u, [tVar], t => fun(t, p('int'))), sqlName: 'COUNT' },
    { name: 'countWhere', category: 'aggregate', doc: 'countWhere cond x — filtered COUNT', scheme: u => poly(u, [tVar], t => fun(p('bool'), fun(t, p('int')))) },
    { name: 'sumWhere', category: 'aggregate', doc: 'sumWhere cond x — filtered SUM', scheme: u => poly(u, [tVar], t => fun(p('bool'), fun(t, maybeOf(t)))) },
    { name: 'avgWhere', category: 'aggregate', doc: 'avgWhere cond x — filtered AVG', scheme: u => poly(u, [tVar], t => fun(p('bool'), fun(t, maybeOf(p('float'))))) },
    { name: 'minWhere', category: 'aggregate', doc: 'minWhere cond x — filtered MIN', scheme: u => poly(u, [tVar], t => fun(p('bool'), fun(t, maybeOf(t)))) },
    { name: 'maxWhere', category: 'aggregate', doc: 'maxWhere cond x — filtered MAX', scheme: u => poly(u, [tVar], t => fun(p('bool'), fun(t, maybeOf(t)))) },
    { name: 'count', category: 'aggregate', doc: 'COUNT — aggregate mode', scheme: u => poly(u, [tVar], t => fun(t, p('int'))) },
    { name: 'sum', category: 'aggregate', doc: 'SUM — aggregate mode (maybe result: empty/all-null input is NULL)', scheme: u => poly(u, [tVar], t => fun(t, maybeOf(t))) },
    { name: 'avg', category: 'aggregate', doc: 'AVG — aggregate mode (maybe result)', scheme: u => poly(u, [tVar], t => fun(t, maybeOf(p('float')))) },
    { name: 'min', category: 'aggregate', doc: 'MIN — aggregate mode (maybe result)', scheme: u => poly(u, [tVar], t => fun(t, maybeOf(t))) },
    { name: 'max', category: 'aggregate', doc: 'MAX — aggregate mode (maybe result)', scheme: u => poly(u, [tVar], t => fun(t, maybeOf(t))) },
    { name: 'array', category: 'aggregate', doc: 'collect values into a list/array — aggregate mode', scheme: u => poly(u, [tVar], t => fun(t, listOf(t))) },
    { name: 'group', category: 'group', doc: 'a GROUP BY key — group mode', scheme: u => poly(u, [tVar], t => fun(t, t)) },

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
    { name: 'inQuery', category: 'logic', doc: 'IN (SELECT ...) — inQuery x subquery', scheme: u => poly(u, [tVar, rowVar], (t, r) => fun(t, fun(queryOf(r), p('bool')))), sqlName: 'IN' },
    { name: 'isIn', category: 'logic', doc: 'IN — isIn x [a, b, ...]', scheme: u => poly(u, [tVar], t => fun(t, fun(listOf(t), p('bool')))), sqlName: 'IN' },
    // `like` (binary operator) lives in base/sql.tetaue as sql_infix "LIKE".

    // --- scalar functions ------------------------------------------------
    // `toUpper`, `toLower`, `length`, `trim` live in base/sql.tetaue; `abs`,
    // `ceil`, `floor`, `sqrt` live there too (Num-constrained, sql_func).
    // --- date & time -----------------------------------------------------
    // Only the CONSTANTS stay core: they map to their own IR nodes
    // (`date-literal`, `current-date`, ...), which no lowering can express.
    // The whole date/time FUNCTION family (year, extract, dateAdd, dateDiff,
    // dateTrunc, dateFormat, dateParse, toUnixtime, fromUnixtime) lives in
    // `base/sql/time.tetaue`, written as ordinary tetaue over the lowering
    // vocabulary.
    { name: 'date', category: 'constant', doc: 'date "2024-01-01" — ISO date literal', scheme: () => mono(fun(p('string'), p('date'))) },
    { name: 'timestamp', category: 'constant', doc: 'timestamp "2024-01-01 12:00:00" — ISO timestamp literal', scheme: () => mono(fun(p('string'), p('timestamp'))) },
    { name: 'currentDate', category: 'constant', doc: 'CURRENT_DATE', scheme: () => mono(p('date')) },
    { name: 'currentTimestamp', category: 'constant', doc: 'CURRENT_TIMESTAMP', scheme: () => mono(p('timestamp')) },

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
    { name: 'list_sum', category: 'list', doc: 'list.sum xs — fold (+) over numeric elements', scheme: u => poly(u, [aVar], a => fun(listOf(a), a)) },
    { name: 'list_product', category: 'list', doc: 'list.product xs — fold (*) over numeric elements', scheme: u => poly(u, [aVar], a => fun(listOf(a), a)) },
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
    // builtin per function. The arguments are *scalars* — never records,
    // queries, or lists — which is what keeps `abs u.some_record` a static
    // error even without type classes; the concrete scalar (int vs string) is
    // only known once the prelude wrapper pins it. The result type is left
    // open (`b`) for the same reason.
    { name: 'sql_func', category: 'scalar', doc: 'sql_func name [args] — an uninterpreted SQL function call', scheme: u => {
        const a = u.fresh('flex', 'a');
        return poly(u, [tVar], b => fun(p('string'), fun(listOf(a), b)));
    } },
    { name: 'sql_is_null', category: 'logic', doc: 'sql_is_null x — primitive NULL predicate for the base library', scheme: u => poly(u, [tVar], t => fun(t, p('bool'))) },
    { name: 'sql_same_type', category: 'logic', doc: 'sql_same_type x y — compile-time SQL type comparison for the base library', scheme: u => poly(u, [tVar], t => fun(t, fun(t, p('bool')))) },
    // `sql_infix op left right` emits an uninterpreted infix SQL expression
    // (`left op right`, e.g. `sql_infix "IN" n x` -> `n IN x`). The result
    // type is left open (`c`) — a comparison is bool, `div` is int, etc. —
    // and the prelude annotation pins it at the use site.
    { name: 'sql_infix', category: 'scalar', doc: 'sql_infix op left right — an uninterpreted infix SQL expression (left op right)', scheme: u => poly(u, [aVar, bVar], (a, b) => fun(p('string'), fun(a, fun(b, u.fresh())))) },
    // `sql_cast value "target"` emits an uninterpreted CAST(value AS target).
    // The result type is left open (`b`) — the prelude definition pins it via
    // its annotation (e.g. `year: date -> int`).
    { name: 'sql_cast', category: 'scalar', doc: 'sql_cast value "target" — an uninterpreted CAST(value AS target)', scheme: u => poly(u, [tVar], t => fun(t, fun(p('string'), u.fresh()))) },
    // `sql_try_cast value "target"` emits an uninterpreted TRY_CAST(value AS
    // target) — NULL rather than an error when the conversion fails. Like
    // sql_cast, the result type is left open for the prelude annotation.
    { name: 'sql_try_cast', category: 'scalar', doc: 'sql_try_cast value "target" — an uninterpreted TRY_CAST(value AS target)', scheme: u => poly(u, [tVar], t => fun(t, fun(p('string'), u.fresh()))) },
    // `sql_bare "YEAR"` emits an unquoted SQL identifier/word (EXTRACT(YEAR
    // FROM x) needs a bare field name, not a quoted string).
    { name: 'sql_bare', category: 'scalar', doc: 'sql_bare "YEAR" — an unquoted SQL word (e.g. an EXTRACT field)', scheme: () => mono(fun(p('string'), p('string'))) },
    // `sql_literal x` reports whether an argument is a LITERAL — a numeric
    // literal or a string literal — as that literal's SQL text, and the empty
    // string when the argument is a computed expression.
    //
    // A library definition receives VALUES, not syntax, so it cannot other-
    // wise tell `dateAdd x "day" 7` from `dateAdd x "day" u.n`; the two need
    // different SQL (`INTERVAL 7 DAY` vs `INTERVAL (n) DAY`, `DATETIME(x,
    // '+7 days')` vs `DATETIME(x, PRINTF(...))`). This is the one piece of
    // introspection the date layer needs, and it keeps the DECISION in
    // tetaue: the library branches on the returned text ("" or not) and on
    // the literal's own value, and no dialect rule lives in TypeScript.
    //
    // The text is the literal's SQL spelling, NOT quoted — `-7` for the
    // literal `-7`, `%Y` for the literal `"%Y"`. A caller that needs a quoted
    // form passes it to `sql_func`/`sql_bare`, which quote it the usual way.
    { name: 'sql_literal', category: 'scalar', doc: 'sql_literal x — the SQL text of a literal argument, or "" when the argument is computed', scheme: u => mono(fun(u.fresh(), p('string'))) },
    // `sql_literal_amount x scale` — the same literal report, but FORMATTED as
    // a signed SQL interval amount. Tests path:
    //
    //     sql_literal_amount (-7) 1   -> "-7"
    //     sql_literal_amount   7  7   -> "+49"
    //     sql_literal_amount u.n  1   -> ""      (computed: not a literal)
    //
    // The SIGN is what sqlite's DATETIME modifier needs (`DATETIME(x, '-7
    // days')`): SQL spells a positive modifier with an explicit `+`, and a
    // tetaue string cannot be assembled from parts (there is no string
    // concatenation — `<>` is the SQL `||` operator). `scale` folds a week
    // amount into days, which is the one piece of arithmetic the sqlite
    // branch needs. Everything about WHICH dialect uses which form stays in
    // `base/sql/time.tetaue`.
    { name: 'sql_literal_amount', category: 'scalar', doc: 'sql_literal_amount x scale — the signed SQL text of a literal amount, or "" when it is computed', scheme: u => mono(fun(u.fresh(), fun(p('int'), p('string')))) },
    // `sql_fragment template [args]` — an uninterpreted SQL FRAGMENT: the
    // template's literal text with each `{}` replaced by the corresponding
    // rendered argument.
    //
    // The other primitives can only emit two shapes, `NAME(a, b)` and
    // `a OP b`. A few SQL forms are neither — `INTERVAL 7 DAY`,
    // `INTERVAL '-7' DAY`, `(-7)` — and they are exactly the shapes the
    // postgres/hive interval arithmetic needs. `{}` rather than named
    // placeholders keeps it positional, like every other application.
    //
    // The template is SQL text, so a literal brace in it is written `{{` (the
    // same escape as a format string). It is otherwise opaque: this primitive
    // widens what a library definition can EMIT, and the safety argument is
    // the library boundary, not the primitive — user modules cannot reach it.
    { name: 'sql_fragment', category: 'scalar', doc: 'sql_fragment "INTERVAL {} DAY" [x] — an uninterpreted SQL fragment with rendered holes', scheme: u => {
        const a = u.fresh('flex', 'a');
        return poly(u, [tVar], b => fun(p('string'), fun(listOf(a), b)));
    } },
    // `sql_error message` — REJECT a definition at analysis time with `message`.
    //
    // A library definition that dispatches on a compile-time NAME (`extract x
    // "month"`, `dateAdd x "day" 7`) must be able to reject a name it does not
    // know, or the mistake would silently lower to wrong SQL instead of being
    // reported. This is that rejection: evaluation stops with the message, so
    // the whole contract — which names are valid and what each lowers to —
    // stays in the library rather than splitting into a TypeScript table.
    //
    // It is only reachable from the fallback arm of such a dispatch, and only
    // from a base module: user modules cannot name it.
    //
    // The result is a POLYMORPHIC variable, generalized at the definition of
    // the library binding that wraps it (`fail = sql_error`). Its use in a
    // `case` arm is then independent per arm, and — crucially — it never
    // forces the SIBLING arms' type: the arm that produces real SQL settles
    // the case's type on its own.
    { name: 'sql_error', category: 'scalar', doc: 'sql_error "message" — reject a library definition with a diagnostic', scheme: u => poly(u, [tVar], t => fun(p('string'), t)) },

    // --- strings ---------------------------------------------------------
    // `trim` lives in base/sql.tetaue (a plain `sql_func "TRIM"` wrapper).
    // `reverse` stays a core builtin: sqlite lowers it to a recursive CTE,
    // which sql_func cannot express yet (see sql-dialect.md).
    { name: 'reverse', category: 'string', doc: 'REVERSE (dialect fallback where needed)', scheme: () => mono(fun(p('string'), p('string'))), lower: ({ dialect, arg }) => {
        if (dialect !== 'sqlite') return null; // REVERSE via the default path
        // A scalar recursive CTE reverses one character per step and stays
        // correlated with the current row expression.
        const x = arg(0);
        return `(WITH RECURSIVE __tetaue_reverse(i, value) AS (`
            + `SELECT LENGTH(${x}), '' UNION ALL `
            + `SELECT i - 1, value || SUBSTR(${x}, i, 1) `
            + `FROM __tetaue_reverse WHERE i > 0`
            + `) SELECT value FROM __tetaue_reverse WHERE i = 0)`;
    } },
    // `replace`, `leftSubstring`/`rightSubstring` live in base/sql.tetaue
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
    { name: 'fromMaybe', category: 'scalar', doc: 'fromMaybe default maybe_value — COALESCE', scheme: u => poly(u, [tVar], t => fun(t, fun(maybeOf(t), t))), lower: ({ arg }) => `COALESCE(${arg(0)}, ${arg(1)})` },
    // --- casts -----------------------------------------------------------
    { name: 'cast', category: 'cast', doc: 'cast x "int"', scheme: u => poly(u, [tVar], t => fun(t, fun(p('string'), u.fresh()))), lower: (ctx) => {
        // The cast target is a string literal naming a TYPE, not a value to
        // render: `cast x "int"` must become `CAST(x AS INTEGER)`, never
        // `CAST(x AS 'int')` — hence literal() rather than arg(). Falls back to
        // INTEGER when the argument is not a literal (the evaluator validates
        // the target before rendering is reached).
        const target = ctx.literal(1) ?? 'int';
        return `CAST(${ctx.arg(0)} AS ${ctx.castTypeName(target)})`;
    } },
    // TRY_CAST returns NULL instead of raising when the value cannot be
    // converted. Two dialect groups:
    //   - postgresql/trino/mysql/hive spell it TRY_CAST;
    //   - sqlite has no TRY_CAST, so it is emulated with the round-trip
    //     idiom: CAST the value, then CAST the result back to TEXT and keep
    //     it only when that reproduces the input. A value that does not
    //     survive the round trip was not convertible → NULL.
    //     `decimal`/`timestamp` are excluded from the round-trip check: they
    //     do not compare as text (SQLite has no decimal type, and its
    //     numeric affinity makes the reverse conversion lossy by design), so
    //     those fall back to a plain CAST.
    { name: 'tryCast', category: 'cast', doc: 'tryCast x "int" — NULL when the conversion fails', scheme: u => poly(u, [tVar], t => fun(t, fun(p('string'), u.fresh()))), lower: (ctx) => {
        const target = ctx.literal(1) ?? 'int';
        const value = ctx.arg(0);
        if (ctx.dialect !== 'sqlite') {
            return `TRY_CAST(${value} AS ${ctx.castTypeName(target)})`;
        }
        const casted = `CAST(${value} AS ${ctx.castTypeName(target)})`;
        if (target === 'decimal' || target === 'timestamp') return casted;
        // Note the CAST(... AS TEXT) of an already-cast value: comparing the
        // two conversions as text is what detects the lossy conversion.
        return `CASE WHEN CAST(${casted} AS TEXT) = CAST(${value} AS TEXT) THEN ${casted} ELSE NULL END`;
    } },

    // --- window arguments ------------------------------------------------
    { name: 'lag', category: 'window', doc: 'lag x offset (just default) — offset required, default optional (NULL)', scheme: u => poly(u, [tVar], t => fun(t, fun(p('int'), fun(maybeOf(t), t)))) },

    // --- window functions ------------------------------------------------
    { name: 'over', category: 'window', doc: 'over (fn) { partition = [...], order = [...] }', scheme: u => poly(u, [aVar, bVar], (a, b) => fun(a, fun(b, a))) },
    { name: 'rowNumber', category: 'window', doc: 'ROW_NUMBER — window-only', scheme: () => mono(p('int')), sqlName: 'ROW_NUMBER' },
    { name: 'rank', category: 'window', doc: 'RANK — window-only', scheme: () => mono(p('int')) },
    { name: 'denseRank', category: 'window', doc: 'DENSE_RANK — window-only', scheme: () => mono(p('int')), sqlName: 'DENSE_RANK' },
    { name: 'percentRank', category: 'window', doc: 'PERCENT_RANK — window-only', scheme: () => mono(p('int')), sqlName: 'PERCENT_RANK' },
    { name: 'ntile', category: 'window', doc: 'NTILE — window-only', scheme: () => mono(fun(p('int'), p('int'))) },

    // --- monoid identity ---------------------------------------------------
    // Type-directed: inference resolves the instance at the use site (string,
    // list, record) and the interpreter produces the matching empty value.
    // A BARE flexible variable: the kind adapts to the use site (row for
    // records, type for string/list), and the closed Monoid instance table is
    // enforced by the pending-use check in inference.ts (checkMemptyResolved),
    // not by a static constraint (which could not express row-kind instances).
    { name: 'mempty', category: 'constant', doc: 'monoid identity — "" for string, [] for lists, {} for records', scheme: u => mono(u.fresh()) }
] as const satisfies readonly BuiltinSpec[];

/**
 * Core names whose scheme matches another primitive even though their runtime
 * behavior differs (for example `isNotIn` and `isIn`). The inference pass
 * copies the target's scheme under the second name.
 */
/**
 * The SQL mode (`agg` / `group` / `window`) of each mode-carrying builtin.
 *
 * An aggregate, a group key and a window function are distinguished by NAME,
 * not by a marker in their type: `count u.id` is an aggregate because `count`
 * is, and the fold/map legality checks read the entry's syntax to recover that.
 * Keeping the mode here — derived from `category`, the same field the schemes
 * sit beside — means the two cannot drift, and `Type` needs no `agg`/`group`/
 * `window` variant.
 *
 * `over` is category `window` but is NOT in this table: it is the wrapper that
 * STRIPS window mode, an ordinary `a -> b -> a`.
 */
export type SqlMode = 'agg' | 'group' | 'window';

const CATEGORY_MODE: Readonly<Record<string, SqlMode>> = {
    aggregate: 'agg',
    group: 'group',
    window: 'window',
};

export const BUILTIN_MODES: Readonly<Record<string, SqlMode>> = Object.freeze(
    Object.fromEntries(
        BUILTIN_SPECS
            .filter(spec => spec.name !== 'over' && CATEGORY_MODE[spec.category] !== undefined)
            .map(spec => [spec.name, CATEGORY_MODE[spec.category]!]),
    ),
);

/** The SQL mode of a builtin name, following aliases, or null when it has none. */
export function builtinModeOf(name: string): SqlMode | null {
    const direct = BUILTIN_MODES[name];
    if (direct) return direct;
    const target = (BUILTIN_ALIASES as Readonly<Record<string, string>>)[name];
    return target ? BUILTIN_MODES[target] ?? null : null;
}

export const BUILTIN_ALIASES = {
    isNotIn: 'isIn',
    lead: 'lag',
    notInQuery: 'inQuery',
} as const;

/** Every builtin name the type system knows (specs + aliases). */
export type BuiltinSpecName = (typeof BUILTIN_SPECS)[number]['name'];
export type BuiltinAliasName = keyof typeof BUILTIN_ALIASES;
export type BuiltinName = BuiltinSpecName | BuiltinAliasName;

export const BUILTIN_NAMES = [
    ...BUILTIN_SPECS.map(s => s.name),
    ...Object.keys(BUILTIN_ALIASES),
];

/** Target type names accepted by cast. */
export const CAST_TYPES = ['int', 'float', 'decimal', 'string', 'bool', 'date', 'timestamp'] as const;
