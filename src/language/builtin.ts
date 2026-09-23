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
    renderDatePart, renderDateAdd, renderDateDiff, renderDateTrunc,
    renderDateFormat, renderDateParse, renderToUnixtime, renderFromUnixtime,
} from '../core/date-lowering.js';
import {
    type PrimName, type Scheme, type Type, type TypeUniverse, type VarKind,
    fun, listOf, maybeOf, nullRowOf, prim, queryOf, rowOf,
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
    | 'scalar'          // toUpper, toLower, length, abs, coalesce, trim, ...
    | 'date'            // current_date, extract, year, date_add, ...
    | 'math'            // ceil, floor, sqrt, pow, mod
    | 'string'          // concat, substring, lpad, rpad, ...
    | 'list'            // pure in-memory list combinators (list.* namespace)
    | 'window'          // over, row_number, rank, lag, lead, ...
    | 'cast'            // cast
    | 'constant';       // current_timestamp

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
     * rendered (and quoted) like a value; `extract`'s field and `date_add`'s
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
     * the dialect's `functions` name map, then the upper-cased name.
     */
    lower?: Lowering;
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
    // `asc`/`desc` are TRANSPARENT in the type system: they return the very
    // type of their argument (`asc u.name : string`). "This is an ORDER BY
    // item" is a property of the EXPRESSION, checked syntactically at the
    // application site (inference's sort check), not a tag carried in `Type` —
    // the two would otherwise be indistinguishable to every other rule, which
    // is why the old `order` tag needed special transparency in unification.
    { name: 'asc', category: 'order', doc: 'an ascending ORDER BY item', scheme: u => poly(u, [tVar], t => fun(t, t)) },
    { name: 'desc', category: 'order', doc: 'a descending ORDER BY item', scheme: u => poly(u, [tVar], t => fun(t, t)) },

    // --- aggregates & grouping (aggregate/group MODES) -------------------
    { name: 'count_distinct', category: 'aggregate', doc: 'COUNT(DISTINCT x) — aggregate mode', scheme: u => poly(u, [tVar], t => fun(t, p('int'))) },
    { name: 'count_where', category: 'aggregate', doc: 'count_where cond x — filtered COUNT', scheme: u => poly(u, [tVar], t => fun(p('bool'), fun(t, p('int')))) },
    { name: 'sum_where', category: 'aggregate', doc: 'sum_where cond x — filtered SUM', scheme: u => poly(u, [tVar], t => fun(p('bool'), fun(t, maybeOf(t)))) },
    { name: 'avg_where', category: 'aggregate', doc: 'avg_where cond x — filtered AVG', scheme: u => poly(u, [tVar], t => fun(p('bool'), fun(t, maybeOf(p('float'))))) },
    { name: 'min_where', category: 'aggregate', doc: 'min_where cond x — filtered MIN', scheme: u => poly(u, [tVar], t => fun(p('bool'), fun(t, maybeOf(t)))) },
    { name: 'max_where', category: 'aggregate', doc: 'max_where cond x — filtered MAX', scheme: u => poly(u, [tVar], t => fun(p('bool'), fun(t, maybeOf(t)))) },
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
    { name: 'in_query', category: 'logic', doc: 'IN (SELECT ...) — in_query x subquery', scheme: u => poly(u, [tVar, rowVar], (t, r) => fun(t, fun(queryOf(r), p('bool')))) },
    { name: 'is_in', category: 'logic', doc: 'IN — is_in x [a, b, ...]', scheme: u => poly(u, [tVar], t => fun(t, fun(listOf(t), p('bool')))) },
    // `like` (binary operator) lives in prelude.tetaue as sql_infix "LIKE".

    // --- scalar functions ------------------------------------------------
    // `toUpper`, `toLower`, `length`, `trim` live in prelude.tetaue; `abs`,
    // `ceil`, `floor`, `sqrt` live there too (Num-constrained, sql_func).
    { name: 'coalesce', category: 'scalar', doc: 'COALESCE', scheme: u => poly(u, [tVar], t => fun(maybeOf(t), fun(maybeOf(t), maybeOf(t)))) },

    // --- date & time -----------------------------------------------------
    { name: 'date', category: 'constant', doc: 'date "2024-01-01" — ISO date literal', scheme: () => mono(fun(p('string'), p('date'))) },
    { name: 'timestamp', category: 'constant', doc: 'timestamp "2024-01-01 12:00:00" — ISO timestamp literal', scheme: () => mono(fun(p('string'), p('timestamp'))) },
    { name: 'current_date', category: 'date', doc: 'CURRENT_DATE', scheme: () => mono(p('date')) },
    { name: 'current_timestamp', category: 'constant', doc: 'CURRENT_TIMESTAMP', scheme: () => mono(p('timestamp')) },
    { name: 'extract', category: 'date', doc: 'extract x "field"', scheme: u => poly(u, [tVar], t => fun(t, fun(p('string'), p('int')))), lower: (ctx) => {
        return renderDatePart(ctx, ctx.literal(1) ?? 'day', ctx.arg(0));
        }
    },
    { name: 'year', category: 'date', doc: 'year of a date', scheme: u => poly(u, [tVar], t => fun(t, p('int'))), lower: (ctx) => {
        return renderDatePart(ctx, 'year', ctx.arg(0));
        }
    },
    { name: 'month', category: 'date', doc: 'month of a date', scheme: u => poly(u, [tVar], t => fun(t, p('int'))), lower: (ctx) => {
        return renderDatePart(ctx, 'month', ctx.arg(0));
        }
    },
    { name: 'day', category: 'date', doc: 'day of a date', scheme: u => poly(u, [tVar], t => fun(t, p('int'))), lower: (ctx) => {
        return renderDatePart(ctx, 'day', ctx.arg(0));
        }
    },
    { name: 'day_of_week', category: 'date', doc: 'day of week of a date', scheme: u => poly(u, [tVar], t => fun(t, p('int'))), lower: (ctx) => {
        return renderDatePart(ctx, 'day_of_week', ctx.arg(0));
        }
    },
    { name: 'hour', category: 'date', doc: 'hour of a timestamp', scheme: u => poly(u, [tVar], t => fun(t, p('int'))), lower: (ctx) => {
        return renderDatePart(ctx, 'hour', ctx.arg(0));
        }
    },
    { name: 'minute', category: 'date', doc: 'minute of a timestamp', scheme: u => poly(u, [tVar], t => fun(t, p('int'))), lower: (ctx) => {
        return renderDatePart(ctx, 'minute', ctx.arg(0));
        }
    },
    { name: 'second', category: 'date', doc: 'second of a timestamp', scheme: u => poly(u, [tVar], t => fun(t, p('int'))), lower: (ctx) => {
        return renderDatePart(ctx, 'second', ctx.arg(0));
        }
    },
    { name: 'date_add', category: 'date', doc: 'date_add x "day" 1', scheme: u => poly(u, [tVar, aVar], (t, n) => fun(t, fun(p('string'), fun(n, t)))), lower: (ctx) => {
        return renderDateAdd(ctx, ctx.arg(0), ctx.literal(1) ?? 'day', ctx.arg(2), ctx.numberLiteral(2));
        }
    },
    { name: 'date_diff', category: 'date', doc: 'date_diff x "day" other', scheme: u => poly(u, [tVar, aVar], (t, other) => fun(t, fun(p('string'), fun(other, p('int'))))), lower: (ctx) => {
        return renderDateDiff(ctx, ctx.arg(0), ctx.literal(1) ?? 'day', ctx.arg(2));
        }
    },
    { name: 'date_trunc', category: 'date', doc: 'date_trunc x "month" — date stays date, timestamp stays timestamp', scheme: u => poly(u, [tVar], t => fun(t, fun(p('string'), t))), lower: (ctx) => {
        return renderDateTrunc(ctx, ctx.arg(0), ctx.literal(1) ?? 'day');
        }
    },
    { name: 'date_format', category: 'date', doc: 'date_format x "%Y-%m-%d"', scheme: u => poly(u, [tVar], t => fun(t, fun(p('string'), p('string')))), lower: (ctx) => {
        return renderDateFormat(ctx, ctx.arg(0), ctx.literal(1) ?? '%Y-%m-%d');
        }
    },
    { name: 'date_parse', category: 'date', doc: 'date_parse x "%Y-%m-%d"', scheme: () => mono(fun(p('string'), fun(p('string'), p('date')))), lower: (ctx) => {
        return renderDateParse(ctx, ctx.arg(0), ctx.literal(1) ?? '%Y-%m-%d');
        }
    },
    { name: 'to_unixtime', category: 'date', doc: 'date to unix seconds', scheme: u => poly(u, [tVar], t => fun(t, p('int'))), lower: (ctx) => {
        return renderToUnixtime(ctx, ctx.arg(0));
        }
    },
    { name: 'from_unixtime', category: 'date', doc: 'unix seconds to timestamp', scheme: u => poly(u, [tVar], t => fun(p('int'), p('timestamp'))), lower: (ctx) => {
        return renderFromUnixtime(ctx, ctx.arg(0));
        }
    },

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
    // `sql_infix op left right` emits an uninterpreted infix SQL expression
    // (`left op right`, e.g. `sql_infix "IN" n x` -> `n IN x`). The result
    // type is left open (`c`) — a comparison is bool, `div` is int, etc. —
    // and the prelude annotation pins it at the use site.
    { name: 'sql_infix', category: 'scalar', doc: 'sql_infix op left right — an uninterpreted infix SQL expression (left op right)', scheme: u => poly(u, [aVar, bVar], (a, b) => fun(p('string'), fun(a, fun(b, u.fresh())))) },
    // `sql_cast value "target"` emits an uninterpreted CAST(value AS target).
    // The result type is left open (`b`) — the prelude definition pins it via
    // its annotation (e.g. `year: date -> int`).
    { name: 'sql_cast', category: 'scalar', doc: 'sql_cast value "target" — an uninterpreted CAST(value AS target)', scheme: u => poly(u, [tVar], t => fun(t, fun(p('string'), u.fresh()))) },
    // `sql_bare "YEAR"` emits an unquoted SQL identifier/word (EXTRACT(YEAR
    // FROM x) needs a bare field name, not a quoted string).
    { name: 'sql_bare', category: 'scalar', doc: 'sql_bare "YEAR" — an unquoted SQL word (e.g. an EXTRACT field)', scheme: () => mono(fun(p('string'), p('string'))) },

    // --- strings ---------------------------------------------------------
    // `trim` lives in prelude.tetaue (a plain `sql_func "TRIM"` wrapper).
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
    { name: 'from_maybe', category: 'scalar', doc: 'from_maybe default maybe_value — COALESCE', scheme: u => poly(u, [tVar], t => fun(t, fun(maybeOf(t), t))), lower: ({ arg }) => `COALESCE(${arg(0)}, ${arg(1)})` },
    { name: 'null_if', category: 'scalar', doc: 'NULLIF', scheme: u => poly(u, [tVar], t => fun(maybeOf(t), fun(maybeOf(t), maybeOf(t)))) },
    { name: 'is_null', category: 'logic', doc: 'IS NULL', scheme: u => poly(u, [tVar], t => fun(maybeOf(t), p('bool'))) },
    { name: 'maybe_isJust', category: 'logic', doc: 'maybe.isJust x — not (is_null x); the Data.Maybe isJust', scheme: u => poly(u, [tVar], t => fun(maybeOf(t), p('bool'))) },
    { name: 'is_true', category: 'logic', doc: 'SQL three-valued logic: IS TRUE', scheme: u => poly(u, [tVar], t => fun(t, p('bool'))), lower: ({ arg }) => `${arg(0)} IS TRUE` },
    { name: 'is_false', category: 'logic', doc: 'SQL three-valued logic: IS FALSE', scheme: u => poly(u, [tVar], t => fun(t, p('bool'))), lower: ({ arg }) => `${arg(0)} IS FALSE` },
    { name: 'is_unknown', category: 'logic', doc: 'SQL three-valued logic: IS UNKNOWN / NULL', scheme: u => poly(u, [tVar], t => fun(t, p('bool'))), lower: ({ arg }) => `${arg(0)} IS NULL` },

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

    // --- list-argument builtins (homogeneous variadic: the list types exactly
    // what they consume — a sound pure-functional encoding of variadic application)
    { name: 'concat', category: 'string', doc: 'concat [a, b, ...]', scheme: () => mono(fun(listOf(p('string')), p('string'))), lower: ({ dialect, arg, arity }) => {
        const parts = Array.from({ length: arity }, (_, i) => arg(i));
        if (dialect === 'sqlite') {
            // SQLite has no CONCAT; || propagates NULL, so COALESCE each
            // argument to the empty string to match CONCAT semantics.
            return parts.map(p => `COALESCE(${p}, '')`).join(' || ');
        }
        return `CONCAT(${parts.join(', ')})`;
    } },
    { name: 'greatest', category: 'scalar', doc: 'greatest [a, b, ...]', scheme: u => poly(u, [tVar], t => fun(listOf(t), t)), lower: ({ name, dialect, arg, arity }) => {
        if (dialect !== 'sqlite') return null; // GREATEST via the default path
        // SQLite has scalar MAX/MIN with GREATEST/LEAST-like NULL semantics.
        // `least` is an ALIAS for `greatest` and keeps its own spelling in the
        // IR, so the direction is decided by the NAME rather than by assuming
        // the entry's own spelling.
        const fn = name === 'least' ? 'MIN' : 'MAX';
        const parts = Array.from({ length: arity }, (_, i) => arg(i));
        return `${fn}(${parts.join(', ')})`;
    } },

    // --- curried builtins with heterogeneous arguments -------------------
    // Every position is curried with its exact type. An argument is
    // `maybe`-typed only when omitting it changes the meaning; arguments
    // whose SQL default value makes them "optional" are required instead.
    { name: 'round', category: 'math', doc: 'round x scale — scale is required (0 rounds to integer)', scheme: u => poly(u, [tVar], t => fun(t, fun(p('int'), t))) },
    { name: 'substring', category: 'string', doc: 'substring s start (just length) — length optional (omitted = to the end)', scheme: () => mono(fun(p('string'), fun(p('int'), fun(maybeOf(p('int')), p('string'))))), lower: ({ dialect, arg, arity }) => {
        // value, start, optional length
        const name = dialect === 'sqlite' ? 'SUBSTR' : 'SUBSTRING';
        const args = [arg(0), arg(1)];
        if (arity > 2) args.push(arg(2));
        return `${name}(${args.join(', ')})`;
    } },
    { name: 'lpad', category: 'string', doc: 'lpad s n pad — pad is required (SQL defaults to a space)', scheme: () => mono(fun(p('string'), fun(p('int'), fun(p('string'), p('string'))))), lower: (ctx) => {
        const { name, dialect, arg, arity } = ctx;
        // `rpad` is an alias for `lpad` but keeps its own spelling in the IR,
        // so the direction is decided by the NAME, not by an assumed entry.
        const fnName = name === 'rpad' ? 'RPAD' : 'LPAD';
        const isLeft = name !== 'rpad';
        if (dialect === 'sqlite') {
            // SQLite has no LPAD/RPAD. printf() produces a run of spaces and
            // replace() turns it into the requested pad string. CASE handles
            // native LPAD/RPAD behaviour when the input is already too long.
            const value = arg(0);
            const width = arg(1);
            const pad = arity > 2 ? arg(2) : ctx.stringLiteral(' ');
            const fill = `REPLACE(PRINTF('%*s', ${width}, ''), ' ', ${pad})`;
            const missing = `${width} - LENGTH(${value})`;
            const truncated = `SUBSTR(${value}, 1, ${width})`;
            const padded = `SUBSTR(${fill}, 1, ${missing})`;
            return `CASE WHEN LENGTH(${value}) >= ${width} THEN ${truncated} ELSE ${isLeft ? `${padded} || ${value}` : `${value} || ${padded}`} END`;
        }
        if (arity === 2) {
            // MySQL/Trino/Hive require the pad string; PostgreSQL defaults to a
            // space. Make the default explicit for a uniform lowering.
            return `${fnName}(${arg(0)}, ${arg(1)}, ' ')`;
        }
        return null;
    } },
    { name: 'lag', category: 'window', doc: 'lag x offset (just default) — offset required, default optional (NULL)', scheme: u => poly(u, [tVar], t => fun(t, fun(p('int'), fun(maybeOf(t), t)))) },

    // --- window functions ------------------------------------------------
    { name: 'over', category: 'window', doc: 'over (fn) { partition = [...], order = [...] }', scheme: u => poly(u, [aVar, bVar], (a, b) => fun(a, fun(b, a))) },
    { name: 'row_number', category: 'window', doc: 'ROW_NUMBER — window-only', scheme: () => mono(p('int')) },
    { name: 'rank', category: 'window', doc: 'RANK — window-only', scheme: () => mono(p('int')) },
    { name: 'dense_rank', category: 'window', doc: 'DENSE_RANK — window-only', scheme: () => mono(p('int')) },
    { name: 'percent_rank', category: 'window', doc: 'PERCENT_RANK — window-only', scheme: () => mono(p('int')) },
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
 * behavior differs (for example `is_not_in` and `is_in`). The inference pass
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
