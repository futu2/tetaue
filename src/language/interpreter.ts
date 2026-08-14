/******************************************************************************
 * tetaue interpreter — symbolic evaluation of a tetaue module.
 *
 * Evaluation is "symbolic": expressions over query rows become SQL expression
 * trees (SqlNode), and query pipelines become a logical Query plan. The same
 * evaluator powers both the Langium validator (collecting diagnostics) and
 * the CLI renderer (producing a Query value to render to SQL).
 ******************************************************************************/
import type { AstNode } from 'langium';
import type { NumberLiteral } from './generated/ast.js';
import { AstUtils } from 'langium';
import {
    isAccessExpression, isApplication, isAscription, isBinaryExpression, isBooleanLiteral,
    isCaseExpression, isIdentifier, isLambda, isLambdaBinaryExpression, isDollarParam, isListLiteral,
    isListType, isMapLiteral,
    isNullLiteral, isNullType, isNumberLiteral, isQueryType, isStringLiteral,
    isTypeParen, isTypeVar, isUnaryMinus,
    type Binding, type CaseExpression, type Expr, type Lambda, type Model, type QueryType, type UnaryExpression,
} from './generated/ast.js';
import type { ProjectModule } from './imports.js';

// ---------------------------------------------------------------------------
// SQL model
// ---------------------------------------------------------------------------

export type SqlType = 'int' | 'float' | 'string' | 'bool' | 'date' | 'timestamp' | 'array' | 'unknown';
export type TypeOrNull = SqlType | 'null';

export interface SqlColumn {
    type: SqlType;
    /** Table name for qualification, or null for computed columns. */
    table: string | null;
    /**
     * For derived columns (projections from map/fold): the defining SQL
     * expression, inlined whenever the column is referenced later in the
     * pipeline (teta-style). Undefined for base table columns.
     */
    expr?: SqlNode;
}
export type Schema = Map<string, SqlColumn>;

export type SqlNode =
    | { kind: 'col'; name: string; table: string | null; type: SqlType }
    | { kind: 'lit'; value: number | string | boolean | null; type: TypeOrNull }
    | { kind: 'bin'; op: string; left: SqlNode; right: SqlNode; type: SqlType }
    | { kind: 'is-null'; expr: SqlNode; negated: boolean; type: 'bool' }
    | { kind: 'not'; expr: SqlNode; type: 'bool' }
    | { kind: 'call'; name: string; args: SqlNode[]; type: SqlType }
    | { kind: 'current-date'; type: 'date' }
    | { kind: 'current-timestamp'; type: 'timestamp' }
    | { kind: 'in'; expr: SqlNode; list: SqlNode[]; negated: boolean; type: 'bool' }
    | { kind: 'agg'; name: string; arg: SqlNode; type: SqlType }
    | { kind: 'group'; expr: SqlNode; table: string | null; type: SqlType }
    | { kind: 'order'; expr: SqlNode; dir: 'ASC' | 'DESC'; type: SqlType }
    | { kind: 'window'; fn: SqlNode; partition: SqlNode[]; order: { node: SqlNode; dir: 'ASC' | 'DESC' }[]; type: SqlType }
    | { kind: 'case'; branches: { cond: SqlNode; value: SqlNode }[]; elseValue: SqlNode | null; type: SqlType };

export interface RowNode {
    fields: { key: string; node: SqlNode }[];
}

export type JoinKind = 'inner' | 'left' | 'right' | 'full';

export type QueryStep =
    | { kind: 'filter'; cond: SqlNode; having: boolean }
    | { kind: 'map'; proj: RowNode }
    | { kind: 'sort'; items: { node: SqlNode; dir: 'ASC' | 'DESC' }[] }
    | { kind: 'take'; n: number }
    | { kind: 'fold'; proj: RowNode }
    | { kind: 'join'; joinKind: JoinKind; right: Query; on: SqlNode; proj: RowNode };

export interface Query {
    /**
     * The tetaue binding name this query was assigned, when it came from a
     * binding (`paid = orders & filter ...`). Rendered SQL prefers it for
     * generated aliases (derived tables, joined subqueries) over invented
     * names, so the output reads like the source.
     */
    name?: string;
    root: {
        name: string;
        schema: Schema;
        /**
         * A derived table: the query is `(SELECT ... FROM ... ) AS name` rather
         * than a real table. Set when a pipeline step is applied after a fold
         * (map/join wrap the aggregated result so it can be projected or
         * joined again, teta-style — a fold ends the flat FROM scope).
         */
        from?: Query;
    };
    /**
     * Whether the query's schema is complete. A bare `table "users"` with no
     * binding annotation has an unknown schema (`known: false`): columns are
     * synthesized lazily and type checks relax. `map`/`fold` projections and
     * a schema annotation make it known again.
     */
    known: boolean;
    /**
     * Table aliases in FROM-clause order (root first). A table name that
     * appears more than once in one query gets suffixed aliases (users,
     * users_1, ...) so self-joins stay unambiguous. Column nodes carry the
     * alias in their `table` field.
     */
    aliases: string[];
    steps: QueryStep[];
    distinct: boolean;
}

// ---------------------------------------------------------------------------
// Interpreter values
// ---------------------------------------------------------------------------

export interface Diagnostic {
    node: AstNode | undefined;
    message: string;
}

export type Value =
    | { kind: 'query'; query: Query; ast?: AstNode }
    | { kind: 'fn'; name: string; apply: (arg: Value, at: AstNode | undefined, ctx: Ctx) => Value; ast?: AstNode; variadic?: boolean }
    | { kind: 'step'; name: string; apply: (q: Query, at: AstNode | undefined, ctx: Ctx) => Query | null; ast?: AstNode }
    | { kind: 'lambda'; params: string[]; body: Expr; closure: Map<string, Value>; ast?: AstNode }
    | { kind: 'jkind'; name: JoinKind; ast?: AstNode }
    /**
     * A first-class record value. Field access (`r.name`) works over records.
     * A row inside a lambda is a record whose schema comes from the pipeline
     * and whose `fields` are empty (columns are synthesized on access); a
     * materialized record (a `{ ... }` literal) carries its evaluated fields.
     */
    | { kind: 'record'; schema: Schema; fields: { key: string; value: Value }[]; ast?: AstNode;
        /** Unknown-schema row: missing columns are synthesized instead of erroring. */
        open?: boolean;
        /** Table used to qualify synthesized columns. */
        defaultTable?: string | null }
    | { kind: 'expr'; node: SqlNode; ast?: AstNode }
    | { kind: 'list'; items: Value[]; ast?: AstNode }
    | { kind: 'error'; ast?: AstNode }
    /**
     * An imported module namespace (`import "x.tetaue" as t`). Qualified
     * access `t.binding` reads the module's EXPORTED bindings. Values are
     * already evaluated and shared by reference; polymorphism is only a
     * type-level concern (handled by inference).
     */
    | { kind: 'module'; name: string; exports: Map<string, Value>; ast?: AstNode };

export interface Ctx {
    env: Map<string, Value>;
    diagnostics: Diagnostic[];
    /** Names bound anywhere in the module (for forward-reference hints). */
    moduleBindings: Set<string>;
}

const ERROR: Value = { kind: 'error' };

export function isError(v: Value): v is { kind: 'error'; ast?: AstNode } {
    return v.kind === 'error';
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TYPE_NAMES: Record<TypeOrNull, string> = {
    int: 'int', float: 'float', string: 'string', bool: 'bool',
    date: 'date', timestamp: 'timestamp', array: 'array', null: 'null', unknown: 'unknown',
};

export function typeName(t: TypeOrNull): string {
    return TYPE_NAMES[t] ?? String(t);
}

export function isNumeric(t: TypeOrNull): boolean {
    return t === 'int' || t === 'float';
}

export function comparable(a: TypeOrNull, b: TypeOrNull): boolean {
    // 'unknown' (columns of un-annotated tables) is comparable to anything:
    // the schema is inferred from use, so the interpreter stays silent and
    // the inference pass owns whatever checking is possible.
    if (a === 'unknown' || b === 'unknown') return true;
    if (a === 'null' || b === 'null') return true;
    if (isNumeric(a) && isNumeric(b)) return true;
    return a === b;
}

export function describe(v: Value): string {
    switch (v.kind) {
        case 'query': return 'a query';
        case 'fn': return `a function (${v.name})`;
        case 'step': return `a query step (${v.name})`;
        case 'lambda': return 'a lambda';
        case 'jkind': return `the join kind '${v.name}'`;
        case 'record': return 'a record';
        case 'expr': return `an expression of type ${typeName(v.node.type)}`;
        case 'list': return 'a list';
        case 'module': return `module '${v.name}'`;

        case 'error': return 'an error';
    }
}

export function exprNode(v: Value): SqlNode | null {
    return v.kind === 'expr' ? v.node : null;
}

function mkExpr(node: SqlNode, ast?: AstNode): Value {
    return { kind: 'expr', node, ast };
}

/** A literal is `float` iff its source text contains '.', so `100.0` is float. */
function numberLiteralType(e: NumberLiteral): 'int' | 'float' {
    return e.$cstNode?.text.includes('.') ? 'float' : 'int';
}

function lit(value: number | string | boolean | null, type: TypeOrNull): SqlNode {
    return { kind: 'lit', value, type };
}

function colNode(name: string, table: string | null, type: SqlType): SqlNode {
    return { kind: 'col', name, table, type };
}

function stringValue(v: Value): string | null {
    const node = exprNode(v);
    if (node?.kind === 'lit' && typeof node.value === 'string') return node.value;
    return null;
}

function numberValue(v: Value): number | null {
    const node = exprNode(v);
    if (node?.kind === 'lit' && typeof node.value === 'number') return node.value;
    return null;
}

/** Unescape a STRING terminal value, including the surrounding quotes. */
export function parseStringLiteral(raw: string): string {
    const inner = raw.startsWith('"') && raw.endsWith('"') ? raw.slice(1, -1) : raw;
    let out = '';
    for (let i = 0; i < inner.length; i++) {
        const ch = inner[i]!;
        if (ch === '\\' && i + 1 < inner.length) {
            const next = inner[i + 1]!;
            i++;
            switch (next) {
                case 'n': out += '\n'; break;
                case 't': out += '\t'; break;
                case 'r': out += '\r'; break;
                case '"': out += '"'; break;
                case '\\': out += '\\'; break;
                default: out += '\\' + next; // unknown escapes are preserved verbatim
            }
        } else {
            out += ch;
        }
    }
    return out;
}

function lambdaParam(l: Lambda): string {
    return l.param?.name ?? '';
}

/** Walk a SqlNode tree; call `visit` for every node. */
function forEachNode(node: SqlNode, visit: (n: SqlNode) => void): void {
    visit(node);
    switch (node.kind) {
        case 'col': case 'lit':
        case 'current-date': case 'current-timestamp': break;
        case 'bin': forEachNode(node.left, visit); forEachNode(node.right, visit); break;
        case 'is-null': case 'not': case 'group': case 'order':
            forEachNode(node.expr, visit); break;
        case 'agg': forEachNode(node.arg, visit); break;
        case 'call': node.args.forEach(a => forEachNode(a, visit)); break;
        case 'window':
            forEachNode(node.fn, visit);
            node.partition.forEach(p => forEachNode(p, visit));
            node.order.forEach(o => forEachNode(o.node, visit));
            break;
        case 'in': forEachNode(node.expr, visit); node.list.forEach(a => forEachNode(a, visit)); break;
        case 'case':
            node.branches.forEach(b => { forEachNode(b.cond, visit); forEachNode(b.value, visit); });
            if (node.elseValue) forEachNode(node.elseValue, visit);
            break;
    }
}

/** Error if the expression contains any of the forbidden node kinds. */
function forbid(node: SqlNode, kinds: SqlNode['kind'][], what: string, at: AstNode | undefined, ctx: Ctx): boolean {
    let bad = false;
    forEachNode(node, n => {
        if (kinds.includes(n.kind)) {
            if (!bad) {
                ctx.diagnostics.push({ node: at ?? node as unknown as AstNode, message: `${what} cannot contain ${kindLabel(n.kind)}` });
                bad = true;
            }
        }
    });
    return bad;
}

function kindLabel(kind: SqlNode['kind']): string {
    switch (kind) {
        case 'agg': return 'aggregates (sum, count, ...)';
        case 'group': return 'group';
        case 'order': return 'order items (asc/desc)';
        case 'window': return 'window functions (over ...)';
        default: return kind;
    }
}

// ---------------------------------------------------------------------------
// Query helpers
// ---------------------------------------------------------------------------

function nodeTable(node: SqlNode): string | null {
    return node.kind === 'col' ? node.table : (node.kind === 'group' ? node.table : null);
}

export function rowNodeSchema(row: RowNode): Schema {
    const schema: Schema = new Map();
    for (const field of row.fields) {
        if (field.node.type === 'null') continue;
        schema.set(field.key, {
            type: field.node.type as SqlType,
            table: nodeTable(field.node),
            expr: field.node,
        });
    }
    return schema;
}

export function querySchema(q: Query): Schema {
    let schema = new Map(q.root.schema);
    for (const step of q.steps) {
        switch (step.kind) {
            case 'filter': case 'sort': case 'take': break;
            case 'map': case 'fold': schema = rowNodeSchema(step.proj); break;
            // The join's merger lambda projects the result row (like map).
            case 'join': schema = rowNodeSchema(step.proj); break;
        }
    }
    return schema;
}

function addStep(q: Query, step: QueryStep): Query {
    // A projection (map/fold/join-merger) defines the complete schema;
    // other steps preserve it.
    let known = q.known;
    if (step.kind === 'map' || step.kind === 'fold' || step.kind === 'join') known = true;
    return { ...q, known, steps: [...q.steps, step] };
}

function hasFoldStep(q: Query): boolean {
    return q.steps.some(s => s.kind === 'fold');
}

/**
 * Does the query's output schema carry aggregate expressions? True after a
 * fold (covered by `hasFoldStep` too) and after a map that wrapped an
 * aggregate on the aggregated result (nested aggregation). Such a query has
 * no GROUP BY, so a later predicate referencing those columns must render as
 * HAVING, not WHERE.
 */
function schemaHasAggregates(q: Query): boolean {
    for (const col of querySchema(q).values()) {
        if (!col.expr) continue;
        let agg = false;
        forEachNode(col.expr, n => { if (n.kind === 'agg') agg = true; });
        if (agg) return true;
    }
    return false;
}

/**
 * Wrap a folded pipeline as a derived table so later steps (map, join) can
 * run on the aggregated result, teta-style:
 *
 *     q = orders & fold (o => { user_id = group o.user_id, total = sum o.total })
 *     r = q & join inner users ...
 *     -- SELECT ... FROM (SELECT user_id, SUM(total) AS total FROM orders
 *     --                 GROUP BY user_id) AS q JOIN users ...
 *
 * The fold ends the flat FROM scope: everything so far becomes a subquery and
 * the outer query starts fresh, referencing the fold's output columns by the
 * derived table's alias. Any step after a fold — map, join, even another
 * fold (nested aggregation) — runs on the derived table.
 *
 * The derived alias is the query's tetaue binding name when it has one
 * (`totals & map ...` → `AS totals`), falling back to the wrapped table's
 * name for an anonymous in-pipeline fold.
 */
function wrapAsDerived(q: Query): Query {
    const alias = q.name ?? 'folded';
    // The subquery's SELECT aliases every fold output column, so the outer
    // query references them as plain columns of the derived table — the
    // inlined `expr` (e.g. `SUM(total)`) must not leak into the outer scope.
    const schema: Schema = new Map();
    for (const [key, col] of querySchema(q)) {
        schema.set(key, { type: col.type, table: alias });
    }
    return {
        root: { name: alias, schema, from: q },
        known: true,
        aliases: [alias],
        steps: [],
        distinct: false,
    };
}

// ---------------------------------------------------------------------------
// Application
// ---------------------------------------------------------------------------

export function apply(f: Value, arg: Value, at: AstNode | undefined, ctx: Ctx): Value {
    if (isError(f) || isError(arg)) return ERROR;
    switch (f.kind) {
        case 'fn':
            return f.apply(arg, at, ctx);
        case 'step': {
            if (arg.kind !== 'query') {
                ctx.diagnostics.push({ node: at ?? astOf(arg) ?? f.ast ?? fallbackNode(ctx), message: `step '${f.name}' expects a query, got ${describe(arg)} — use it in a pipeline: query & ${f.name} ...` });
                return ERROR;
            }
            const next = f.apply(arg.query, at, ctx);
            return next ? { kind: 'query', query: next, ast: at } : ERROR;
        }
        case 'lambda': {
            const remaining = f.params.slice(1);
            const env = new Map(f.closure);
            env.set(f.params[0]!, arg);
            if (remaining.length === 0) {
                return evalExpr(f.body, { env, diagnostics: ctx.diagnostics, moduleBindings: ctx.moduleBindings });
            }
            return { kind: 'lambda', params: remaining, body: f.body, closure: env, ast: f.ast };
        }
        default:
            ctx.diagnostics.push({ node: at ?? fallbackNode(ctx), message: `cannot apply ${describe(f)}` });
            return ERROR;
    }
}

function astOf(v: Value): AstNode | undefined {
    return 'ast' in v ? v.ast : undefined;
}

// ---------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------

/** Derive a record's schema from its evaluated fields (types only where known). */
function recordSchemaOf(fields: { key: string; value: Value }[]): Schema {
    const schema: Schema = new Map();
    for (const { key, value } of fields) {
        if (value.kind === 'expr') {
            schema.set(key, { type: value.node.type as SqlType, table: nodeTable(value.node), expr: value.node });
        }
    }
    return schema;
}

/** A row-shaped record: the query's schema with no materialized fields (lambda parameter). */
function rowRecord(q: Query, ast?: AstNode): Value {
    return {
        kind: 'record',
        schema: querySchema(q),
        open: !q.known,
        // Qualify synthesized columns by the root's plain alias (the last
        // segment of a schema-qualified name), never `schema.table.column`.
        defaultTable: q.aliases[0] ?? q.root.name,
        fields: [],
        ast,
    };
}

/** A materialized record value: evaluated fields plus a derived schema. */
function recordValue(fields: { key: string; value: Value }[], ast?: AstNode): Value {
    return { kind: 'record', schema: recordSchemaOf(fields), fields, ast };
}

/**
 * Materialize a record's fields: literal fields as-is; a row-shaped record
 * (a lambda parameter) synthesizes a column expression per schema column.
 * Rows with an unknown schema (un-annotated tables) cannot be enumerated —
 * return null so the caller can diagnose.
 */
function recordFields(rec: Value, at: AstNode | undefined, ctx: Ctx): { key: string; value: Value }[] | null {
    if (rec.kind !== 'record') return null; // callers diagnose the kind
    if (rec.fields.length > 0) return rec.fields;
    // Row-shaped records (lambda parameters) synthesize a column expression
    // per schema column. A row with an unknown schema (an un-annotated
    // table) has nothing to enumerate; an empty record literal `{}` is a
    // valid (empty) materialized record.
    if (rec.open) {
        ctx.diagnostics.push({ node: at ?? rec.ast, message: `cannot merge a row with an unknown schema — annotate the table, e.g. users: query { id: int } = table "users"` });
        return null;
    }
    const out: { key: string; value: Value }[] = [];
    for (const key of rec.schema.keys()) {
        out.push({ key, value: readField(key, rec, at, ctx) });
    }
    return out;
}

/**
 * Combine two records; the right record's fields win on overlap (the
 * `merge` builtin and the `<>` operator). Callers check both operands are
 * records; this only materializes and unions.
 */
function mergeValues(l: Value, r: Value, at: AstNode | undefined, ctx: Ctx): Value {
    const lFields = recordFields(l, at, ctx);
    const rFields = recordFields(r, at, ctx);
    if (lFields === null || rFields === null) return ERROR;
    const byKey = new Map<string, { key: string; value: Value }>();
    for (const f of lFields) byKey.set(f.key, f);
    for (const f of rFields) byKey.set(f.key, f); // right wins on overlap
    return recordValue([...byKey.values()], at);
}

/**
 * Read the field `name` off a record. Row-shaped records (no materialized
 * fields) synthesize the column expression from the schema, inlining derived
 * columns exactly like the previous row access did.
 */
function readField(name: string, rec: Value, at: AstNode | undefined, ctx: Ctx): Value {
    if (rec.kind !== 'record') {
        ctx.diagnostics.push({
            node: at ?? rec.ast,
            message: rec.kind === 'query'
                ? `cannot view field '${name}' on a query — access columns through a row parameter inside a lambda, e.g. map (u => u.${name})`
                : `cannot view field '${name}' on ${describe(rec)} — expected a record`,
        });
        return ERROR;
    }
    if (rec.fields.length > 0) {
        const f = rec.fields.find(f => f.key === name);
        if (f) return f.value;
        ctx.diagnostics.push({ node: at ?? rec.ast, message: `unknown field '${name}' — available: ${rec.fields.map(f => f.key).join(', ')}` });
        return ERROR;
    }
    const col = rec.schema.get(name);
    if (!col) {
        // Unknown-schema rows (un-annotated tables): the column may exist in
        // SQL — synthesize it lazily, qualified by the query's root table.
        if (rec.open && rec.defaultTable) {
            return mkExpr(colNode(name, rec.defaultTable, 'unknown'), at);
        }
        ctx.diagnostics.push({ node: at ?? rec.ast, message: `unknown column '${name}' — available: ${[...rec.schema.keys()].join(', ')}` });
        return ERROR;
    }
    return col.expr
        // Window results must be referenced by their projection alias —
        // inlining the OVER expression into a later WHERE/ORDER BY would be
        // invalid SQL, so a window-derived column reads back as its alias.
        ? (col.expr.kind === 'window' ? mkExpr(colNode(name, null, col.type), at) : mkExpr(col.expr, at))
        : mkExpr(colNode(name, col.table, col.type), at);
}

/** Is the value applicable as a function (fn or lambda)? */
function isApplicable(v: Value): v is Extract<Value, { kind: 'fn' }> | Extract<Value, { kind: 'lambda' }> {
    return v.kind === 'fn' || v.kind === 'lambda';
}

/**
 * `l1 <<< l2` / `l1 >>> l2` — PureScript function composition:
 * `f <<< g` = `x => f (g x)`, `f >>> g` = `x => g (f x)`.
 */
function composeValues(l: Value, r: Value, op: '>>>' | '<<<', at: AstNode, ctx: Ctx): Value {
    if (isApplicable(l) && isApplicable(r)) {
        const lName = l.kind === 'fn' ? l.name : 'λ';
        const rName = r.kind === 'fn' ? r.name : 'λ';
        return fn(`(${lName} ${op} ${rName})`, (x, at2, ctx2) => {
            const first = op === '<<<' ? r : l;
            const second = op === '<<<' ? l : r;
            const v = apply(first, x, at2, ctx2);
            return isError(v) ? ERROR : apply(second, v, at2, ctx2);
        });
    }
    ctx.diagnostics.push({ node: at, message: `cannot compose ${describe(l)} with ${describe(r)} — both must be functions` });
    return ERROR;
}

/** Turn a row transformer (lambda or function) into a `map` query step. */
function mapStepFromTransformer(q: Query, f: Value, at: AstNode | undefined, ctx: Ctx): Query | null {
    // After a fold the pipeline is aggregated; projecting the result again
    // (or wrapping an aggregate) wraps the folded part as a derived table
    // instead of nesting aggregates in one flat SELECT.
    let afterFold = false;
    if (hasFoldStep(q)) {
        q = wrapAsDerived(q);
        afterFold = true;
    }
    const row = rowRecord(q, at);
    const v = apply(f, row, at, ctx);
    if (isError(v)) return null;
    const proj = rowFromRecord(v, at, ctx, 'projection', afterFold);
    if (!proj) return null;
    if (proj.fields.length === 0) {
        ctx.diagnostics.push({ node: at ?? f.ast, message: `map projection must contain at least one field` });
        return null;
    }
    // Window-only functions (row_number, rank, lag, ...) are invalid outside
    // `over (...)` — catch them here so they never render broken SQL.
    if (validateWindowUses(proj.fields, at ?? f.ast, ctx)) return null;
    return addStep(q, { kind: 'map', proj });
}

function fallbackNode(ctx: Ctx): AstNode {
    // Best-effort: the last registered diagnostic's node, or a synthetic marker.
    const last = ctx.diagnostics[ctx.diagnostics.length - 1];
    return last ? (last.node ?? dummyNode) : dummyNode;
}

const dummyNode = { $type: 'Placeholder' } as unknown as AstNode;

// ---------------------------------------------------------------------------
// Expression evaluation
// ---------------------------------------------------------------------------

function evalBinary(op: string, l: Value, r: Value, at: AstNode, ctx: Ctx): Value {
    // `<>` — the record-merge monoid (right record wins on overlap); the
    // operands are records, not scalar expressions.
    if (op === '<>') {
        if (l.kind !== 'record' || r.kind !== 'record') {
            ctx.diagnostics.push({ node: at, message: `'<>' expects two records, got ${describe(l)} and ${describe(r)}` });
            return ERROR;
        }
        return mergeValues(l, r, at, ctx);
    }
    const ln = exprNode(l);
    const rn = exprNode(r);
    if (!ln || !rn) {
        ctx.diagnostics.push({ node: at, message: `'${op}' expects two expressions, got ${describe(l)} and ${describe(r)}` });
        return ERROR;
    }

    if (op === '==' || op === '!=') {
        const lNull = ln.kind === 'lit' && ln.value === null;
        const rNull = rn.kind === 'lit' && rn.value === null;
        if (lNull && rNull) {
            ctx.diagnostics.push({ node: at, message: `cannot compare null with null` });
            return ERROR;
        }
        if (lNull || rNull) {
            const expr = lNull ? rn : ln;
            return mkExpr({ kind: 'is-null', expr, negated: op === '!=', type: 'bool' }, at);
        }
        if (!comparable(ln.type, rn.type)) {
            ctx.diagnostics.push({ node: at, message: `cannot compare ${typeName(ln.type)} with ${typeName(rn.type)}` });
            return ERROR;
        }
        return mkExpr({ kind: 'bin', op: op === '==' ? '=' : '!=', left: ln, right: rn, type: 'bool' }, at);
    }

    if (op === '<' || op === '<=' || op === '>' || op === '>=') {
        if (!comparable(ln.type, rn.type)) {
            ctx.diagnostics.push({ node: at, message: `cannot compare ${typeName(ln.type)} with ${typeName(rn.type)}` });
            return ERROR;
        }
        return mkExpr({ kind: 'bin', op, left: ln, right: rn, type: 'bool' }, at);
    }

    if (op === '&&' || op === '||') {
        if ((ln.type !== 'bool' && ln.type !== 'unknown') || (rn.type !== 'bool' && rn.type !== 'unknown')) {
            ctx.diagnostics.push({ node: at, message: `'${op}' requires boolean operands, got ${typeName(ln.type)} and ${typeName(rn.type)}` });
            return ERROR;
        }
        const sqlOp = op === '&&' ? 'AND' : 'OR';
        return mkExpr({ kind: 'bin', op: sqlOp, left: ln, right: rn, type: 'bool' }, at);
    }

    if (op === '+' || op === '-' || op === '*' || op === '/' || op === '%') {
        if ((!isNumeric(ln.type) && ln.type !== 'unknown') || (!isNumeric(rn.type) && rn.type !== 'unknown')) {
            ctx.diagnostics.push({ node: at, message: `'${op}' requires numeric operands, got ${typeName(ln.type)} and ${typeName(rn.type)}` });
            return ERROR;
        }
        const t: SqlType = (ln.type === 'unknown' || rn.type === 'unknown')
            ? 'unknown'
            : (op === '/' || ln.type === 'float' || rn.type === 'float' ? 'float' : 'int');
        return mkExpr({ kind: 'bin', op, left: ln, right: rn, type: t }, at);
    }

    ctx.diagnostics.push({ node: at, message: `unknown operator '${op}'` });
    return ERROR;
}

function access(recv: Value, prop: string, at: AstNode, ctx: Ctx): Value {
    if (recv.kind === 'record') {
        return readField(prop, recv, at, ctx);
    }
    if (recv.kind === 'module') {
        // Qualified access `t.binding`: read an exported binding of the
        // namespace (import "x.tetaue" as t).
        const v = recv.exports.get(prop);
        if (v) return v;
        const keys = [...recv.exports.keys()];
        ctx.diagnostics.push({ node: at, message: `module '${recv.name}' has no exported binding '${prop}' — exported: ${keys.length > 0 ? keys.join(', ') : '(none)'}` });
        return ERROR;
    }
    if (recv.kind === 'query') {
        ctx.diagnostics.push({ node: at, message: `tables have no fields — access columns through a row parameter inside a lambda, e.g. map (u => u.${prop})` });
        return ERROR;
    }
    ctx.diagnostics.push({ node: at, message: `cannot access field '${prop}' on ${describe(recv)}` });
    return ERROR;
}

// ---------------------------------------------------------------------------
// $n implicit lambda parameters
// ---------------------------------------------------------------------------

/**
 * Highest $n index in `node` that is NOT bound in `env` and not hidden inside
 * an explicit lambda body (explicit lambdas are their own scope).
 */
function dollarArity(node: AstNode, env: Map<string, Value>): number {
    let arity = 0;
    for (const n of AstUtils.streamAst(node)) {
        if (!isDollarParam(n) || env.has(n.value)) continue;
        let cur: AstNode | undefined = n;
        let hidden = false;
        while (cur) {
            const parent: AstNode | undefined = cur.$container;
            if (!parent) break;
            if (isLambda(parent) && parent.body === cur) { hidden = true; break; }
            cur = parent;
        }
        if (!hidden) arity = Math.max(arity, Number(n.value.slice(1)));
    }
    return arity;
}

/**
 * Evaluate an expression as a value, but if it uses $n parameters that are not
 * bound in the current environment, abstract it into an implicit lambda:
 *   ($1 + 3)   ≡   u => u + 3
 *   ($1 + $2)  ≡   (u, v) => u + v
 * Lambda bodies are parenthesized, e.g. `filter ($1.active)`,
 * `join inner orders ($1.id == $2.user_id) { uid = $1.id }`.
 */
function evalArg(expr: Expr, ctx: Ctx): Value {
    const arity = dollarArity(expr, ctx.env);
    if (arity > 0) return dollarLambda(expr, arity, ctx);
    return evalUnary(expr as UnaryExpression, ctx);
}

function dollarLambda(body: Expr, arity: number, ctx: Ctx): Value {
    const params = Array.from({ length: arity }, (_, i) => `$${i + 1}`);
    return { kind: 'lambda', params, body, closure: new Map(ctx.env), ast: body };
}

export function evalExpr(e: Expr, ctx: Ctx): Value {
    if (isAscription(e)) return evalExpr(e.operand!, ctx); // type annotations are erased
    if (isUnaryMinus(e)) return evalUnary(e, ctx);
    if (isBinaryExpression(e) || isLambdaBinaryExpression(e)) {
        // (LambdaBinaryExpression is the `&`/`$`-free chain used for lambda
        // bodies — structurally identical to BinaryExpression.)
        if (e.operator === '&') {
            // pipeline: `left & right` ⇔ apply right to left
            const left = evalUnary(e.left, ctx);
            const right = evalUnary(e.right, ctx);
            return apply(right, left, e, ctx);
        }
        if (e.operator === '$') {
            // application: `left $ right` ⇔ apply left to right (right-assoc)
            const left = evalUnary(e.left, ctx);
            const right = evalArg(e.right as Expr, ctx);
            return apply(left, right, e, ctx);
        }
        if (e.operator === '>>>' || e.operator === '<<<') {
            // PureScript function composition: `f <<< g` = `x => f (g x)`,
            // `f >>> g` = `x => g (f x)`.
            const l = evalUnary(e.left, ctx);
            if (isError(l)) return ERROR;
            const r = evalUnary(e.right, ctx);
            if (isError(r)) return ERROR;
            return composeValues(l, r, e.operator, e, ctx);
        }
        const l = evalUnary(e.left, ctx);
        const r = evalUnary(e.right, ctx);
        return evalBinary(e.operator, l, r, e, ctx);
    }
    if (isAccessExpression(e)) {
        const recv = evalExpr(e.receiver, ctx);
        if (isError(recv)) return ERROR;
        return access(recv, e.property, e, ctx);
    }
    if (isApplication(e)) {
        // Variadic builtins (concat, greatest, least, round, substring,
        // lpad/rpad, regex_extract) take ALL their arguments at once from the
        // application spine — they cannot be curried. Resolve through the
        // environment so user bindings may shadow them like any builtin.
        const head = isIdentifier(e.func) ? ctx.env.get(e.func.name) : undefined;
        // A bare identifier (`greatest` alone) parses as a 0-argument
        // Application — that is the function VALUE, not a variadic call.
        if (head?.kind === 'fn' && head.variadic && e.arguments.length > 0) {
            const spec = VARIADIC[head.name]!; // variadic fns are only created for registered names
            const args: Value[] = [];
            for (const argExpr of e.arguments) {
                const arg = evalArg(argExpr, ctx);
                if (isError(arg)) return ERROR;
                args.push(arg);
            }
            if (args.length < spec.min || args.length > spec.max) {
                ctx.diagnostics.push({ node: e, message: `${head.name} expects ${spec.min}${spec.max === Infinity ? ' or more' : ` to ${spec.max}`} arguments, got ${args.length}` });
                return ERROR;
            }
            return spec.apply(args, e, ctx);
        }
        let f = evalExpr(e.func, ctx);
        for (const argExpr of e.arguments) {
            if (isError(f)) {
                evalArg(argExpr, ctx); // keep collecting diagnostics
                continue;
            }
            const arg = evalArg(argExpr, ctx);
            f = apply(f, arg, argExpr, ctx);
        }
        return f;
    }
    if (isNumberLiteral(e)) {
        const t: SqlType = numberLiteralType(e);
        return mkExpr(lit(e.value, t), e);
    }
    if (isStringLiteral(e)) {
        return mkExpr(lit(parseStringLiteral(e.value), 'string'), e);
    }
    if (isBooleanLiteral(e)) {
        return mkExpr(lit(e.value === 'true', 'bool'), e);
    }
    if (isNullLiteral(e)) {
        return mkExpr(lit(null, 'null'), e);
    }
    if (isCaseExpression(e)) {
        return evalCase(e, ctx);
    }
    if (isListLiteral(e)) {
        const items = e.elements.map(el => evalExpr(el, ctx));
        if (items.some(isError)) return ERROR;
        return { kind: 'list', items, ast: e };
    }
    if (isMapLiteral(e)) {
        const fields: { key: string; value: Value }[] = [];
        const seen = new Set<string>();
        for (const entry of e.entries) {
            if (seen.has(entry.key)) {
                ctx.diagnostics.push({ node: entry, message: `duplicate map key '${entry.key}'` });
            }
            seen.add(entry.key);
            fields.push({ key: entry.key, value: evalExpr(entry.value, ctx) });
        }
        return recordValue(fields, e);
    }
    if (isLambda(e)) {
        // Snapshot the current scope: lambdas see only bindings defined so far.
        return { kind: 'lambda', params: [lambdaParam(e)], body: e.body as unknown as Expr, closure: new Map(ctx.env), ast: e };
    }
    if (isIdentifier(e)) {
        const v = ctx.env.get(e.name);
        if (v) return v;
        if (ctx.moduleBindings.has(e.name)) {
            ctx.diagnostics.push({ node: e, message: `unknown identifier '${e.name}' — bindings must be defined before use` });
            return ERROR;
        }
        const known = [...ctx.env.keys()].filter(k => !Object.hasOwn(BUILTINS, k));
        ctx.diagnostics.push({ node: e, message: `unknown identifier '${e.name}'${known.length ? ` — defined: ${known.join(', ')}` : ''}` });
        return ERROR;
    }
    if (isDollarParam(e)) {
        const v = ctx.env.get(e.value);
        if (v) return v;
        ctx.diagnostics.push({ node: e, message: `unknown lambda parameter '${e.value}' — $n refers to the implicit parameters of the enclosing lambda, e.g. filter ($1.active)` });
        return ERROR;
    }
    ctx.diagnostics.push({ node: e, message: 'unexpected expression' });
    return ERROR;
}

/** Evaluate a UnaryExpression (a BinaryExpression operand): unary minus or a plain expression. */
function evalUnary(u: UnaryExpression, ctx: Ctx): Value {
    if (isUnaryMinus(u)) {
        const v = evalUnary(u.operand, ctx);
        const node = exprNode(v);
        if (!node) return ERROR;
        if (node.type === 'null' || (!isNumeric(node.type) && node.type !== 'unknown')) {
            ctx.diagnostics.push({ node: u, message: `unary '-' requires a numeric expression, got ${typeName(node.type)}` });
            return ERROR;
        }
        if (node.kind === 'lit' && typeof node.value === 'number') {
            return mkExpr({ ...node, value: -node.value, type: node.type }, u);
        }
        return mkExpr({ kind: 'bin', op: '-', left: lit(0, node.type), right: node, type: node.type }, u);
    }
    return evalExpr(u, ctx);
}

// ---------------------------------------------------------------------------
// `case { cond => value, ..., _ => value }` — SQL CASE WHEN
// ---------------------------------------------------------------------------

/**
 * Evaluate a `case` expression into a `case` SqlNode:
 *
 *   case { u.active => u.name, _ => "inactive" }
 *       → CASE WHEN active THEN name ELSE 'inactive' END
 *   case { u.age < 18 => "minor", u.age >= 65 => "senior", _ => "adult" }
 *       → CASE WHEN age < 18 THEN 'minor' WHEN age >= 65 THEN 'senior' ELSE 'adult' END
 *
 * The searched form checks each condition directly. The SIMPLE form carries a
 * subject and sugar-expands every branch condition into a `==` comparison
 * with it (SQL `CASE subject WHEN value THEN ...`):
 *
 *   case u.code { "101" => "法定代表人", "102" => "总经理", _ => u.code }
 *       → CASE WHEN code = '101' THEN '法定代表人' WHEN code = '102' THEN '总经理' ELSE code END
 *
 * (`subject == null` becomes IS NULL via evalBinary.) Branches are evaluated
 * in order; the `_` fallback branch (optional) must be last and becomes the
 * ELSE value. Values must share a comparable type (a `null` literal absorbs
 * like coalesce). Aggregates/group/order items are rejected, like coalesce.
 */
function evalCase(e: CaseExpression, ctx: Ctx): Value {
    if (e.branches.length === 0) {
        ctx.diagnostics.push({ node: e, message: `case requires at least one branch, e.g. case { u.active => u.name, _ => "inactive" }` });
        return ERROR;
    }
    const branches: { cond: SqlNode; value: SqlNode }[] = [];
    let elseValue: SqlNode | null = null;
    let resultType: SqlType | null = null;

    const valueNode = (branch: import('./generated/ast.js').CaseBranch, value: Value): SqlNode | null => {
        const node = exprNode(value);
        if (!node) {
            ctx.diagnostics.push({ node: branch, message: `case branch values must be scalar expressions, got ${describe(value)}` });
            return null;
        }
        if (forbid(node, ['agg', 'group', 'order'], 'case', branch, ctx)) return null;
        if (node.type !== 'null') {
            if (resultType === null) resultType = node.type as SqlType;
            else if (!comparable(resultType, node.type)) {
                ctx.diagnostics.push({ node: branch, message: `case requires matching value types, got ${typeName(resultType)} and ${typeName(node.type)}` });
                return null;
            }
        }
        return node;
    };

    for (let i = 0; i < e.branches.length; i++) {
        const b = e.branches[i]!;
        const value = evalExpr(b.value!, ctx);
        if (isError(value)) return ERROR;
        if (b.fallback) {
            if (i !== e.branches.length - 1) {
                ctx.diagnostics.push({ node: b, message: `the '_' fallback branch must be last in a case expression` });
                return ERROR;
            }
            const v = valueNode(b, value);
            if (!v) return ERROR;
            elseValue = v;
            continue;
        }
        let condValue: Value;
        if (e.subject) {
            // Simple case: `case subject { c1 => v1, ..., _ => v }` is sugar for
            // the searched form with `subject == c1` conditions. Reuse evalBinary
            // so `== null` becomes IS NULL and type checks match the operator.
            const subject = evalExpr(e.subject, ctx);
            if (isError(subject)) return ERROR;
            const condExpr = evalExpr(b.cond!, ctx);
            if (isError(condExpr)) return ERROR;
            condValue = evalBinary('==', subject, condExpr, b.cond ?? e, ctx);
            if (isError(condValue)) return ERROR;
        } else {
            condValue = evalExpr(b.cond!, ctx);
            if (isError(condValue)) return ERROR;
        }
        const cond = exprNode(condValue);
        if (!cond || (cond.type !== 'bool' && cond.type !== 'unknown')) {
            ctx.diagnostics.push({ node: b.cond, message: `case condition must be a boolean expression, got ${cond ? `type ${typeName(cond.type)}` : describe(condValue)}` });
            return ERROR;
        }
        if (forbid(cond, ['agg', 'group', 'order'], 'case', b.cond ?? b, ctx)) return ERROR;
        const v = valueNode(b, value);
        if (!v) return ERROR;
        branches.push({ cond, value: v });
    }

    const t: SqlType = resultType ?? 'string'; // all-null branches → string, like coalesce
    return mkExpr({ kind: 'case', branches, elseValue, type: t }, e);
}

// ---------------------------------------------------------------------------
// Builtins
// ---------------------------------------------------------------------------

function fn(name: string, impl: (arg: Value, at: AstNode | undefined, ctx: Ctx) => Value): Value {
    return { kind: 'fn', name, apply: impl };
}

function step(name: string, impl: (q: Query, at: AstNode | undefined, ctx: Ctx) => Query | null): Value {
    return { kind: 'step', name, apply: impl };
}

const JOIN_KINDS: Record<string, JoinKind> = {
    inner: 'inner', left: 'left', right: 'right', full: 'full',
};

/** The join kind argument: a bare-identifier constant (`inner`, `left`, `right`, `full`). */
function joinKindOf(v: Value): JoinKind | null {
    return v.kind === 'jkind' ? (JOIN_KINDS[v.name] ?? null) : null;
}

const AGG_TYPES: Record<string, SqlType> = {
    count: 'int', sum: 'int', avg: 'float', min: 'int', max: 'int', list: 'array',
};

export const BUILTINS: Record<string, () => Value> = {
    // --- join kinds (bare identifiers, usable as `join`'s first argument) ---
    inner: () => ({ kind: 'jkind', name: 'inner' }),
    left: () => ({ kind: 'jkind', name: 'left' }),
    right: () => ({ kind: 'jkind', name: 'right' }),
    full: () => ({ kind: 'jkind', name: 'full' }),

    // --- query roots -----------------------------------------------------
    table: () => fn('table', (arg1, at1, ctx) => {
        // `table : string -> query r` — the schema comes from the binding's
        // type annotation (checkBinding) or is inferred from use. Until then
        // the schema is unknown (`known: false`), so columns are synthesized
        // lazily and type checks relax.
        const name = stringValue(arg1);
        if (name === null) {
            ctx.diagnostics.push({ node: at1 ?? arg1.ast, message: `table expects a table name string, e.g. table "users"` });
            return ERROR;
        }
        // A schema-qualified table name (`ecs.dcm_ecs_c_ecis_m_tb1150_sf_f`)
        // aliases as its last segment, so column references render as
        // `alias.column` — `schema.table.column` is invalid in many engines
        // (Hive, SQLite, ...). The FROM clause adds `AS alias` when needed.
        const baseAlias = name.split('.').at(-1) ?? name;
        return {
            kind: 'query',
            query: { root: { name, schema: new Map() }, known: false, aliases: [baseAlias], steps: [], distinct: false },
            ast: at1,
        };
    }),

    // --- query steps ----------------------------------------------------
    // `filtered` keeps the rows that satisfy a predicate; `filter` is a synonym.
    filtered: filterBuiltin('filtered'),
    filter: filterBuiltin('filter'),

    map: () => fn('map', (sel, at, ctx) => {
        if (!isApplicable(sel) || (sel.kind === 'lambda' && sel.params.length !== 1)) {
            ctx.diagnostics.push({ node: at ?? sel.ast, message: `map expects a one-parameter projection lambda or function, e.g. map (u => { id = u.id })` });
            return ERROR;
        }
        return step('map', (q, at2, ctx2) => mapStepFromTransformer(q, sel, at2 ?? sel.ast, ctx2));
    }),

    sort: () => fn('sort', (sel, at, ctx) => {
        if (!isApplicable(sel) || (sel.kind === 'lambda' && sel.params.length !== 1)) {
            ctx.diagnostics.push({ node: at ?? sel.ast, message: `sort expects a one-parameter lambda or function, e.g. sort (u => [asc u.name])` });
            return ERROR;
        }
        return step('sort', (q, at2, ctx2) => {
            const row = rowRecord(q, at2);
            const v = apply(sel, row, at2, ctx2);
            // Ordering by an aggregate is allowed after a fold (ORDER BY
            // SUM(...)) and after a nested-aggregate map (the derived table's
            // columns are aggregate expressions).
            const items = orderItems(v, at2 ?? sel.ast, ctx2, hasFoldStep(q) || schemaHasAggregates(q));
            if (!items) return null;
            return addStep(q, { kind: 'sort', items });
        });
    }),

    take: () => fn('take', (arg, at, ctx) => {
        const n = numberValue(arg);
        if (n === null || !Number.isInteger(n) || n < 0) {
            ctx.diagnostics.push({ node: at ?? arg.ast, message: `take expects a non-negative integer literal, got ${n === null ? describe(arg) : String(n)}` });
            return ERROR;
        }
        return step('take', (q) => addStep(q, { kind: 'take', n }));
    }),

    distinct: () => fn('distinct', (arg, at, ctx) => {
        if (arg.kind !== 'query') {
            ctx.diagnostics.push({ node: at ?? arg.ast, message: `distinct expects a query, got ${describe(arg)} — use it in a pipeline: query & distinct` });
            return ERROR;
        }
        return { kind: 'query', query: { ...arg.query, distinct: true }, ast: at };
    }),

    // --- records -------------------------------------------------------
    // `merge l r` combines two records; the right record's fields win on
    // overlap (JS/Nix object-spread style). Used in projections to extend a
    // row with computed fields:
    //   map (u => merge u { active = u.balance > 100 })
    // The infix form is `<>` (the record-merge monoid, Haskell-style):
    //   map (u => u <> { active = u.balance > 100 })
    merge: () => fn('merge', (l, at, ctx) => {
        if (l.kind !== 'record') {
            ctx.diagnostics.push({ node: at ?? l.ast, message: `merge expects a record as its first argument, got ${describe(l)}` });
            return ERROR;
        }
        return fn('merge', (r, at2, ctx2) => {
            if (r.kind !== 'record') {
                ctx2.diagnostics.push({ node: at2 ?? r.ast, message: `merge expects a record as its second argument, got ${describe(r)}` });
                return ERROR;
            }
            return mergeValues(l, r, at2, ctx2);
        });
    }),

    fold: () => fn('fold', (sel, at, ctx) => {
        if (!isApplicable(sel) || (sel.kind === 'lambda' && sel.params.length !== 1)) {
            ctx.diagnostics.push({ node: at ?? sel.ast, message: `fold expects a projection function, e.g. fold (o => { user_id = group o.user_id, total = sum o.total })` });
            return ERROR;
        }
        return step('fold', (q, at2, ctx2) => {
            // A second fold aggregates the aggregated result: the first fold
            // becomes a derived table (nested aggregation), teta-style.
            if (hasFoldStep(q)) q = wrapAsDerived(q);
            const v = apply(sel, rowRecord(q, at2), at2, ctx2);
            if (v.kind !== 'record') {
                ctx2.diagnostics.push({ node: at2 ?? sel.ast, message: `fold expects a projection record, got ${describe(v)}` });
                return null;
            }
            const row: RowNode = { fields: [] };
            let aggregates = 0;
            for (const { key, value } of v.fields) {
                const node = exprNode(value);
                if (!node) {
                    ctx2.diagnostics.push({ node: value.ast ?? at2, message: `fold entry '${key}' must be an aggregate (count, sum, ...) or group, got ${describe(value)}` });
                    return null;
                }
                if (node.kind === 'agg') aggregates++;
                if (node.kind !== 'agg' && node.kind !== 'group') {
                    ctx2.diagnostics.push({ node: value.ast ?? at2, message: `fold entry '${key}' must be wrapped in an aggregate (count, sum, ...) or group` });
                    return null;
                }
                row.fields.push({ key, node });
            }
            if (aggregates === 0) {
                ctx2.diagnostics.push({ node: at2 ?? sel.ast, message: `fold must contain at least one aggregate (count, sum, ...)` });
                return null;
            }
            return addStep(q, { kind: 'fold', proj: row });
        });
    }),

    join: () => fn('join', (kindArg, at, ctx) => {
        // `join` takes FOUR positional arguments: the join kind (inner, left,
        // right or full — a bare-identifier constant), the right-hand query,
        // the two-parameter `on` condition lambda, and the two-parameter
        // `merger` lambda that projects the result row:
        //   join inner orders (l, r) => l.id == r.user_id (l, r) => { id = l.id }
        // The right side is a first-class query VALUE (any query — pipelines
        // render as subqueries), so joins compose like every other step. The
        // merger replaces the old disjoint-union of both rows: the result row
        // is exactly what it projects (like `map`, with both rows in scope).
        const joinKind = joinKindOf(kindArg);
        if (joinKind === null) {
            ctx.diagnostics.push({ node: at ?? kindArg.ast, message: `join expects a join kind as its first argument: inner, left, right or full (a bare identifier, e.g. inner), got ${describe(kindArg)}` });
            return ERROR;
        }
        return fn('join', (right, at2, ctx2) => {
            if (right.kind !== 'query') {
                ctx2.diagnostics.push({ node: at2 ?? right.ast, message: `join expects a query as its second argument, got ${describe(right)} — bind a table or pipeline first, e.g. join inner orders (l, r) => ...` });
                return ERROR;
            }
            return fn('join', (on, at3, ctx3) => {
                if (!isApplicable(on)) {
                    ctx3.diagnostics.push({ node: at3 ?? on.ast, message: `join 'on' must be a two-argument function (curried), e.g. (l => r => l.id == r.user_id) or ($1.id == $2.user_id), got ${describe(on)}` });
                    return ERROR;
                }
                return fn('join', (merge, at4, ctx4) => {
                    if (!isApplicable(merge)) {
                        ctx4.diagnostics.push({ node: at4 ?? merge.ast, message: `join 'merger' must be a two-argument function (curried), e.g. (l => r => merge l r) or merge, got ${describe(merge)}` });
                        return ERROR;
                    }
                    return step('join', (q, at5, ctx5) => {
                        // A fold ends the flat FROM scope: joining the
                        // aggregated result wraps the folded part as a derived
                        // table — `JOIN ... FROM (fold) AS <name>`.
                        if (hasFoldStep(q)) q = wrapAsDerived(q);
                        // Assign a unique alias for the right-hand side (self-joins).
                        // The ON condition and merger reference the right side's
                        // OUTPUT columns by alias — a stepped right side renders
                        // as a subquery.
                        const rightName = right.query.root.name;
                        // A schema-qualified table name (`public.orders`) uses
                        // its last segment as the base alias, so the SQL alias
                        // stays a plain identifier (`AS "orders"`), and the
                        // columns of the joined side qualify by that alias.
                        // A right side that is a named binding (`paid = ...`)
                        // reuses the binding name instead — `JOIN (...) AS paid`
                        // reads like the source.
                        const baseAlias = right.query.name ?? (rightName.split('.').at(-1) ?? rightName);
                        let alias = baseAlias;
                        let suffix = 1;
                        while (q.aliases.includes(alias)) {
                            alias = `${baseAlias}_${suffix++}`;
                        }
                        const rightSchema: Schema = new Map(
                            [...querySchema(right.query)].map(([key, col]) => [key, { type: col.type, table: alias }]),
                        );
                        const rightQuery: Query = {
                            ...right.query,
                            root: { name: rightName, schema: rightSchema },
                            aliases: [alias],
                        };
                        const rightRow: Value = { kind: 'record', schema: rightSchema, open: !right.query.known, defaultTable: alias, fields: [], ast: at5 };
                        const leftRow = rowRecord(q, at5);
                        // The ON condition: both rows in scope, must be boolean.
                        // Functions are curried: apply once per row.
                        const on1 = apply(on, leftRow, at5, ctx5);
                        if (isError(on1)) return null;
                        if (!isApplicable(on1)) {
                            ctx5.diagnostics.push({ node: at5 ?? on.ast, message: `join 'on' must be a two-argument function (curried), e.g. (l => r => l.id == r.user_id) or ($1.id == $2.user_id), got a one-argument function` });
                            return null;
                        }
                        const onVal = apply(on1, rightRow, at5, ctx5);
                        const node = exprNode(onVal);
                        if (!node || (node.type !== 'bool' && node.type !== 'unknown')) {
                            ctx5.diagnostics.push({ node: at5 ?? on.ast, message: `join 'on' condition must be a boolean expression, got ${node ? `type ${typeName(node.type)}` : describe(onVal)}` });
                            return null;
                        }
                        if (forbid(node, ['agg', 'group', 'order', 'window'], 'the join condition', at5 ?? on.ast, ctx5)) return null;
                        // The merger: projects the result row (like `map`),
                        // applied curried to both rows (a plain `merge` works).
                        const m1 = apply(merge, leftRow, at5, ctx5);
                        if (isError(m1)) return null;
                        if (!isApplicable(m1)) {
                            ctx5.diagnostics.push({ node: at5 ?? merge.ast, message: `join 'merger' must be a two-argument function (curried), e.g. (l => r => merge l r) or merge, got a one-argument function` });
                            return null;
                        }
                        const mv = apply(m1, rightRow, at5, ctx5);
                        if (isError(mv)) return null;
                        const proj = rowFromRecord(mv, at5, ctx5, 'join merger');
                        if (!proj) return null;
                        if (proj.fields.length === 0) {
                            ctx5.diagnostics.push({ node: at5 ?? merge.ast, message: `join merger must produce a record with at least one field` });
                            return null;
                        }
                        const next: Query = { ...q, aliases: [...q.aliases, alias] };
                        return addStep(next, { kind: 'join', joinKind, right: rightQuery, on: node, proj });
                    });
                });
            });
        });
    }),

    // --- ordering --------------------------------------------------------
    asc: () => fn('asc', (arg, at, ctx) => {
        const node = exprNode(arg);
        if (!node) {
            ctx.diagnostics.push({ node: at ?? arg.ast, message: `asc expects an expression, e.g. asc u.name` });
            return ERROR;
        }
        if (node.kind === 'order' || node.type === 'null') {
            ctx.diagnostics.push({ node: at ?? arg.ast, message: `asc cannot wrap ${node.type === 'null' ? 'null' : kindLabel(node.kind)}` });
            return ERROR;
        }
        return mkExpr({ kind: 'order', expr: node, dir: 'ASC', type: node.type }, at);
    }),
    desc: () => fn('desc', (arg, at, ctx) => {
        const node = exprNode(arg);
        if (!node) {
            ctx.diagnostics.push({ node: at ?? arg.ast, message: `desc expects an expression, e.g. desc u.age` });
            return ERROR;
        }
        if (node.kind === 'order' || node.type === 'null') {
            ctx.diagnostics.push({ node: at ?? arg.ast, message: `desc cannot wrap ${node.type === 'null' ? 'null' : kindLabel(node.kind)}` });
            return ERROR;
        }
        return mkExpr({ kind: 'order', expr: node, dir: 'DESC', type: node.type }, at);
    }),

    // --- aggregates & grouping ------------------------------------------
    count: aggBuiltin('count', 'any'),
    sum: aggBuiltin('sum', 'numeric'),
    avg: aggBuiltin('avg', 'numeric'),
    min: aggBuiltin('min', 'any'),
    max: aggBuiltin('max', 'any'),
    list: aggBuiltin('list', 'any'),
    group: () => fn('group', (arg, at, ctx) => {
        const node = exprNode(arg);
        if (!node) {
            ctx.diagnostics.push({ node: at ?? arg.ast, message: `group expects an expression, e.g. group o.user_id` });
            return ERROR;
        }
        if (node.kind === 'agg' || node.kind === 'group' || node.kind === 'order' || node.type === 'null') {
            ctx.diagnostics.push({ node: at ?? arg.ast, message: `group cannot wrap ${node.type === 'null' ? 'null' : kindLabel(node.kind)}` });
            return ERROR;
        }
        return mkExpr({ kind: 'group', expr: node, table: nodeTable(node), type: node.type }, at);
    }),

    // --- logic -----------------------------------------------------------
    not: () => fn('not', (arg, at, ctx) => {
        const node = exprNode(arg);
        if (!node || (node.type !== 'bool' && node.type !== 'unknown')) {
            ctx.diagnostics.push({ node: at ?? arg.ast, message: `not expects a boolean expression, got ${node ? `type ${typeName(node.type)}` : describe(arg)}` });
            return ERROR;
        }
        if (forbid(node, ['agg', 'group', 'order'], 'not', at ?? arg.ast, ctx)) return ERROR;
        return mkExpr({ kind: 'not', expr: node, type: 'bool' }, at);
    }),

    // --- set membership --------------------------------------------------
    is_in: inBuiltin(false),
    is_not_in: inBuiltin(true),

    // --- string & scalar functions --------------------------------------
    upper: stringFnBuiltin('upper', 'string'),
    lower: stringFnBuiltin('lower', 'string'),
    length: stringFnBuiltin('length', 'int'),
    abs: () => fn('abs', (arg, at, ctx) => {
        const node = exprNode(arg);
        if (!node || (!isNumeric(node.type) && node.type !== 'unknown')) {
            ctx.diagnostics.push({ node: at ?? arg.ast, message: `abs expects a numeric expression, got ${node ? `type ${typeName(node.type)}` : describe(arg)}` });
            return ERROR;
        }
        if (forbid(node, ['agg', 'group', 'order'], 'abs', at ?? arg.ast, ctx)) return ERROR;
        return mkExpr({ kind: 'call', name: 'abs', args: [node], type: node.type as SqlType }, at);
    }),
    coalesce: () => fn('coalesce', (arg1, at1, ctx) => {
        const node1 = exprNode(arg1);
        if (!node1) {
            ctx.diagnostics.push({ node: at1 ?? arg1.ast, message: `coalesce expects expressions, e.g. coalesce u.nickname u.name` });
            return ERROR;
        }
        return fn('coalesce', (arg2, at2, ctx2) => {
            const node2 = exprNode(arg2);
            if (!node2) {
                ctx2.diagnostics.push({ node: at2 ?? arg2.ast, message: `coalesce expects two expressions, got ${describe(arg2)}` });
                return ERROR;
            }
            if (node1.kind === 'agg' || node2.kind === 'agg') {
                ctx2.diagnostics.push({ node: at2 ?? arg2.ast, message: `coalesce cannot wrap aggregates` });
                return ERROR;
            }
            const t = (node1.type === 'null') ? node2.type : node1.type;
            if (node1.type !== 'null' && node2.type !== 'null' && !comparable(node1.type, node2.type)) {
                ctx2.diagnostics.push({ node: at2 ?? arg2.ast, message: `coalesce requires matching types, got ${typeName(node1.type)} and ${typeName(node2.type)}` });
                return ERROR;
            }
            return mkExpr({ kind: 'call', name: 'coalesce', args: [node1, node2], type: t === 'null' ? 'string' : t }, at2);
        });
    }),

    // --- date & time ---------------------------------------------------
    // Zero-argument constants (SQL keywords, rendered bare — no parens).
    current_date: () => mkExpr({ kind: 'current-date', type: 'date' }),
    current_timestamp: () => mkExpr({ kind: 'current-timestamp', type: 'timestamp' }),

    // Date-part helpers (teta's convenience helpers over extract):
    //   year u.created_at, month u.created_at, day u.created_at, ...
    extract: extractBuiltin(),
    year: datePartBuiltin('year'),
    month: datePartBuiltin('month'),
    day: datePartBuiltin('day'),
    day_of_week: datePartBuiltin('day_of_week'),
    hour: datePartBuiltin('hour'),
    minute: datePartBuiltin('minute'),
    second: datePartBuiltin('second'),

    // Date arithmetic and formatting — lowering varies per dialect (see
    // render.ts, following teta's function support matrix).
    date_add: dateAddBuiltin(),
    date_diff: dateDiffBuiltin(),
    date_trunc: dateTruncBuiltin(),
    date_format: dateFormatBuiltin(),
    date_parse: dateParseBuiltin(),
    to_unixtime: unixTimeBuiltin('to_unixtime'),
    from_unixtime: unixTimeBuiltin('from_unixtime'),

    // --- math -------------------------------------------------------------
    // add/sub/mul/div are the `+ - * /` operators; mod is the `%` operator.
    ceil: numericUnaryBuiltin('ceil'),
    floor: numericUnaryBuiltin('floor'),
    sqrt: numericUnaryBuiltin('sqrt'),
    pow: numericBinaryBuiltin('pow', 'float'),
    mod: numericBinaryBuiltin('mod', 'first'),

    // --- strings ----------------------------------------------------------
    trim: stringFnBuiltin('trim', 'string'),
    reverse: stringFnBuiltin('reverse', 'string'),
    position: () => fn('position', (arg, at, ctx) => {
        const node = exprNode(arg);
        if (!node || (node.type !== 'string' && node.type !== 'unknown')) {
            ctx.diagnostics.push({ node: at ?? arg.ast, message: `position expects a string expression, got ${node ? `type ${typeName(node.type)}` : describe(arg)}` });
            return ERROR;
        }
        if (forbid(node, ['agg', 'group', 'order'], 'position', at ?? arg.ast, ctx)) return ERROR;
        return fn('position', (needleArg, at2, ctx2) => {
            const needle = exprNode(needleArg);
            if (!needle || (needle.type !== 'string' && needle.type !== 'unknown')) {
                ctx2.diagnostics.push({ node: at2 ?? needleArg.ast, message: `position expects a string pattern, got ${needle ? `type ${typeName(needle.type)}` : describe(needleArg)}` });
                return ERROR;
            }
            if (forbid(needle, ['agg', 'group', 'order'], 'position', at2 ?? needleArg.ast, ctx2)) return ERROR;
            return mkExpr({ kind: 'call', name: 'position', args: [node, needle], type: 'int' }, at2);
        });
    }),
    replace: () => fn('replace', (arg, at, ctx) => {
        const node = exprNode(arg);
        if (!node || (node.type !== 'string' && node.type !== 'unknown')) {
            ctx.diagnostics.push({ node: at ?? arg.ast, message: `replace expects a string expression, got ${node ? `type ${typeName(node.type)}` : describe(arg)}` });
            return ERROR;
        }
        if (forbid(node, ['agg', 'group', 'order'], 'replace', at ?? arg.ast, ctx)) return ERROR;
        return fn('replace', (searchArg, at2, ctx2) => {
            const search = exprNode(searchArg);
            if (!search || (search.type !== 'string' && search.type !== 'unknown')) {
                ctx2.diagnostics.push({ node: at2 ?? searchArg.ast, message: `replace expects a string search term, got ${search ? `type ${typeName(search.type)}` : describe(searchArg)}` });
                return ERROR;
            }
            if (forbid(search, ['agg', 'group', 'order'], 'replace', at2 ?? searchArg.ast, ctx2)) return ERROR;
            return fn('replace', (replArg, at3, ctx3) => {
                const repl = exprNode(replArg);
                if (!repl || (repl.type !== 'string' && repl.type !== 'unknown')) {
                    ctx3.diagnostics.push({ node: at3 ?? replArg.ast, message: `replace expects a string replacement, got ${repl ? `type ${typeName(repl.type)}` : describe(replArg)}` });
                    return ERROR;
                }
                if (forbid(repl, ['agg', 'group', 'order'], 'replace', at3 ?? replArg.ast, ctx3)) return ERROR;
                return mkExpr({ kind: 'call', name: 'replace', args: [node, search, repl], type: 'string' }, at3);
            });
        });
    }),
    left_substring: () => fn('left_substring', (arg, at, ctx) => {
        const node = exprNode(arg);
        if (!node || (node.type !== 'string' && node.type !== 'unknown')) {
            ctx.diagnostics.push({ node: at ?? arg.ast, message: `left_substring expects a string expression, got ${node ? `type ${typeName(node.type)}` : describe(arg)}` });
            return ERROR;
        }
        if (forbid(node, ['agg', 'group', 'order'], 'left_substring', at ?? arg.ast, ctx)) return ERROR;
        return fn('left_substring', (lenArg, at2, ctx2) => {
            const len = exprNode(lenArg);
            if (!len || (!isNumeric(len.type) && len.type !== 'unknown')) {
                ctx2.diagnostics.push({ node: at2 ?? lenArg.ast, message: `left_substring expects a numeric length, got ${len ? `type ${typeName(len.type)}` : describe(lenArg)}` });
                return ERROR;
            }
            if (forbid(len, ['agg', 'group', 'order'], 'left_substring', at2 ?? lenArg.ast, ctx2)) return ERROR;
            return mkExpr({ kind: 'call', name: 'left_substring', args: [node, len], type: 'string' }, at2);
        });
    }),
    right_substring: () => fn('right_substring', (arg, at, ctx) => {
        const node = exprNode(arg);
        if (!node || (node.type !== 'string' && node.type !== 'unknown')) {
            ctx.diagnostics.push({ node: at ?? arg.ast, message: `right_substring expects a string expression, got ${node ? `type ${typeName(node.type)}` : describe(arg)}` });
            return ERROR;
        }
        if (forbid(node, ['agg', 'group', 'order'], 'right_substring', at ?? arg.ast, ctx)) return ERROR;
        return fn('right_substring', (lenArg, at2, ctx2) => {
            const len = exprNode(lenArg);
            if (!len || (!isNumeric(len.type) && len.type !== 'unknown')) {
                ctx2.diagnostics.push({ node: at2 ?? lenArg.ast, message: `right_substring expects a numeric length, got ${len ? `type ${typeName(len.type)}` : describe(lenArg)}` });
                return ERROR;
            }
            if (forbid(len, ['agg', 'group', 'order'], 'right_substring', at2 ?? lenArg.ast, ctx2)) return ERROR;
            return mkExpr({ kind: 'call', name: 'right_substring', args: [node, len], type: 'string' }, at2);
        });
    }),
    regex_like: () => fn('regex_like', (arg, at, ctx) => {
        const node = exprNode(arg);
        if (!node || (node.type !== 'string' && node.type !== 'unknown')) {
            ctx.diagnostics.push({ node: at ?? arg.ast, message: `regex_like expects a string expression, got ${node ? `type ${typeName(node.type)}` : describe(arg)}` });
            return ERROR;
        }
        if (forbid(node, ['agg', 'group', 'order'], 'regex_like', at ?? arg.ast, ctx)) return ERROR;
        return fn('regex_like', (patternArg, at2, ctx2) => {
            const pattern = exprNode(patternArg);
            if (!pattern || (pattern.type !== 'string' && pattern.type !== 'unknown')) {
                ctx2.diagnostics.push({ node: at2 ?? patternArg.ast, message: `regex_like expects a string pattern, got ${pattern ? `type ${typeName(pattern.type)}` : describe(patternArg)}` });
                return ERROR;
            }
            if (forbid(pattern, ['agg', 'group', 'order'], 'regex_like', at2 ?? patternArg.ast, ctx2)) return ERROR;
            return mkExpr({ kind: 'call', name: 'regex_like', args: [node, pattern], type: 'bool' }, at2);
        });
    }),
    regex_replace: () => fn('regex_replace', (arg, at, ctx) => {
        const node = exprNode(arg);
        if (!node || (node.type !== 'string' && node.type !== 'unknown')) {
            ctx.diagnostics.push({ node: at ?? arg.ast, message: `regex_replace expects a string expression, got ${node ? `type ${typeName(node.type)}` : describe(arg)}` });
            return ERROR;
        }
        if (forbid(node, ['agg', 'group', 'order'], 'regex_replace', at ?? arg.ast, ctx)) return ERROR;
        return fn('regex_replace', (patternArg, at2, ctx2) => {
            const pattern = exprNode(patternArg);
            if (!pattern || (pattern.type !== 'string' && pattern.type !== 'unknown')) {
                ctx2.diagnostics.push({ node: at2 ?? patternArg.ast, message: `regex_replace expects a string pattern, got ${pattern ? `type ${typeName(pattern.type)}` : describe(patternArg)}` });
                return ERROR;
            }
            if (forbid(pattern, ['agg', 'group', 'order'], 'regex_replace', at2 ?? patternArg.ast, ctx2)) return ERROR;
            return fn('regex_replace', (replArg, at3, ctx3) => {
                const repl = exprNode(replArg);
                if (!repl || (repl.type !== 'string' && repl.type !== 'unknown')) {
                    ctx3.diagnostics.push({ node: at3 ?? replArg.ast, message: `regex_replace expects a string replacement, got ${repl ? `type ${typeName(repl.type)}` : describe(replArg)}` });
                    return ERROR;
                }
                if (forbid(repl, ['agg', 'group', 'order'], 'regex_replace', at3 ?? replArg.ast, ctx3)) return ERROR;
                return mkExpr({ kind: 'call', name: 'regex_replace', args: [node, pattern, repl], type: 'string' }, at3);
            });
        });
    }),

    // --- logical ----------------------------------------------------------
    like: () => fn('like', (arg, at, ctx) => {
        const node = exprNode(arg);
        if (!node || (node.type !== 'string' && node.type !== 'unknown')) {
            ctx.diagnostics.push({ node: at ?? arg.ast, message: `like expects a string expression, got ${node ? `type ${typeName(node.type)}` : describe(arg)}` });
            return ERROR;
        }
        if (forbid(node, ['agg', 'group', 'order'], 'like', at ?? arg.ast, ctx)) return ERROR;
        return fn('like', (patternArg, at2, ctx2) => {
            const pattern = exprNode(patternArg);
            if (!pattern || (pattern.type !== 'string' && pattern.type !== 'unknown')) {
                ctx2.diagnostics.push({ node: at2 ?? patternArg.ast, message: `like expects a string pattern, got ${pattern ? `type ${typeName(pattern.type)}` : describe(patternArg)}` });
                return ERROR;
            }
            if (forbid(pattern, ['agg', 'group', 'order'], 'like', at2 ?? patternArg.ast, ctx2)) return ERROR;
            return mkExpr({ kind: 'bin', op: 'LIKE', left: node, right: pattern, type: 'bool' }, at2);
        });
    }),

    // --- null handling ----------------------------------------------------
    null_if: () => fn('null_if', (arg, at, ctx) => {
        const node = exprNode(arg);
        if (!node) {
            ctx.diagnostics.push({ node: at ?? arg.ast, message: `null_if expects expressions, e.g. null_if u.nickname ""` });
            return ERROR;
        }
        if (forbid(node, ['agg', 'group', 'order'], 'null_if', at ?? arg.ast, ctx)) return ERROR;
        return fn('null_if', (otherArg, at2, ctx2) => {
            const other = exprNode(otherArg);
            if (!other || !comparable(node.type, other.type)) {
                ctx2.diagnostics.push({ node: at2 ?? otherArg.ast, message: `null_if requires matching types, got ${node.type === 'null' ? 'null' : typeName(node.type)} and ${other ? (other.type === 'null' ? 'null' : typeName(other.type)) : describe(otherArg)}` });
                return ERROR;
            }
            if (forbid(other, ['agg', 'group', 'order'], 'null_if', at2 ?? otherArg.ast, ctx2)) return ERROR;
            const t = node.type === 'null' ? other.type : node.type;
            return mkExpr({ kind: 'call', name: 'null_if', args: [node, other], type: t === 'null' ? 'string' : t }, at2);
        });
    }),
    is_null: () => fn('is_null', (arg, at, ctx) => {
        const node = exprNode(arg);
        if (!node) {
            ctx.diagnostics.push({ node: at ?? arg.ast, message: `is_null expects an expression, e.g. is_null u.nickname` });
            return ERROR;
        }
        if (forbid(node, ['agg', 'group', 'order'], 'is_null', at ?? arg.ast, ctx)) return ERROR;
        return mkExpr({ kind: 'is-null', expr: node, negated: false, type: 'bool' }, at);
    }),
    is_not_null: () => fn('is_not_null', (arg, at, ctx) => {
        const node = exprNode(arg);
        if (!node) {
            ctx.diagnostics.push({ node: at ?? arg.ast, message: `is_not_null expects an expression, e.g. is_not_null u.nickname` });
            return ERROR;
        }
        if (forbid(node, ['agg', 'group', 'order'], 'is_not_null', at ?? arg.ast, ctx)) return ERROR;
        return mkExpr({ kind: 'is-null', expr: node, negated: true, type: 'bool' }, at);
    }),

    // --- type conversion --------------------------------------------------
    cast: castBuiltin('cast'),
    try_cast: castBuiltin('try_cast'),

    // --- variadic builtins (take all arguments at once) -------------------
    concat: variadicFn('concat'),
    greatest: variadicFn('greatest'),
    least: variadicFn('least'),
    round: variadicFn('round'),
    substring: variadicFn('substring'),
    lpad: variadicFn('lpad'),
    rpad: variadicFn('rpad'),
    regex_extract: variadicFn('regex_extract'),

    // --- window functions ------------------------------------------------
    // Window-only functions must be wrapped in `over (...)` — a bare
    // `row_number` in a projection is an error (see validateWindowUses).
    // `sum u.x`, `avg u.x`, ... become windowed aggregates via over too.
    over: () => fn('over', (fnArg, at, ctx) => {
        const fnNode = exprNode(fnArg);
        // Window functions are aggregates (sum, avg, ...) or the window-only
        // ranking/offset functions — never plain scalar calls like upper.
        const ok = fnNode !== null && (fnNode.kind === 'agg' || (fnNode.kind === 'call' && WINDOW_ONLY.has(fnNode.name)));
        if (!ok) {
            // A bare `over lag u.salary 1 0 {...}` flattens the arguments into
            // the application, so the first argument arrives as a function —
            // hint at wrapping multi-argument window functions in parens.
            const hint = fnArg.kind === 'fn'
                ? ` — wrap it in parens when it takes arguments, e.g. over (${fnArg.name} u.x 1 0) { partition = [u.dept], order = [desc u.salary] }`
                : '';
            ctx.diagnostics.push({ node: at ?? fnArg.ast, message: `over expects a window function (row_number, rank, sum, lag, ...), got ${fnNode ? `an expression of type ${typeName(fnNode.type)}` : describe(fnArg)}${hint}` });
            return ERROR;
        }
        if (forbid(fnNode!, ['window'], 'over', at ?? fnArg.ast, ctx)) return ERROR;
        return fn('over', (specArg, at2, ctx2) => {
            const spec = windowSpec(specArg, at2, ctx2);
            if (spec === null) return ERROR;
            return mkExpr({ kind: 'window', fn: fnNode!, partition: spec.partition, order: spec.order, type: fnNode!.type as SqlType }, at2);
        });
    }),
    row_number: () => mkExpr({ kind: 'call', name: 'row_number', args: [], type: 'int' }),
    rank: () => mkExpr({ kind: 'call', name: 'rank', args: [], type: 'int' }),
    dense_rank: () => mkExpr({ kind: 'call', name: 'dense_rank', args: [], type: 'int' }),
    percent_rank: () => mkExpr({ kind: 'call', name: 'percent_rank', args: [], type: 'int' }),
    ntile: () => fn('ntile', (arg, at, ctx) => {
        const node = exprNode(arg);
        if (!node || (!isNumeric(node.type) && node.type !== 'unknown')) {
            ctx.diagnostics.push({ node: at ?? arg.ast, message: `ntile expects a numeric bucket count, got ${node ? `type ${typeName(node.type)}` : describe(arg)}` });
            return ERROR;
        }
        if (forbid(node, ['agg', 'group', 'order', 'window'], 'ntile', at ?? arg.ast, ctx)) return ERROR;
        return mkExpr({ kind: 'call', name: 'ntile', args: [node], type: 'int' }, at);
    }),
    lag: variadicFn('lag'),
    lead: variadicFn('lead'),
};

function filterBuiltin(name: string): () => Value {
    return () => fn(name, (pred, at, ctx) => {
        if (!isApplicable(pred) || (pred.kind === 'lambda' && pred.params.length !== 1)) {
            ctx.diagnostics.push({ node: at ?? pred.ast, message: `${name} expects a one-parameter predicate lambda or function, e.g. ${name} (u => u.age >= 18)` });
            return ERROR;
        }
        return step(name, (q, at2, ctx2) => {
            // After a fold the predicate becomes HAVING, where aggregates are
            // allowed. A nested-aggregate map (aggregate on the aggregated
            // result) has no GROUP BY but its columns are aggregate
            // expressions, so predicates over them still belong in HAVING.
            const having = hasFoldStep(q) || schemaHasAggregates(q);
            const v = apply(pred, rowRecord(q, at2), at2, ctx2);
            const node = exprNode(v);
            if (!node || (node.type !== 'bool' && node.type !== 'unknown')) {
                ctx2.diagnostics.push({ node: at2 ?? pred.ast, message: `${name} predicate must be a boolean expression, got ${node ? `type ${typeName(node.type)}` : describe(v)}` });
                return null;
            }
            // After fold the predicate becomes HAVING, where aggregates are allowed.
            const forbidden: SqlNode['kind'][] = having ? ['order', 'window'] : ['agg', 'group', 'order', 'window'];
            if (forbid(node, forbidden, `the ${name} predicate`, at2 ?? pred.ast, ctx2)) return null;
            return addStep(q, { kind: 'filter', cond: node, having });
        });
    });
}

function aggBuiltin(name: string, numeric: 'numeric' | 'any'): () => Value {
    return () => fn(name, (arg, at, ctx) => {
        const node = exprNode(arg);
        if (!node) {
            ctx.diagnostics.push({ node: at ?? arg.ast, message: `${name} expects an expression, e.g. ${name} o.total` });
            return ERROR;
        }
        if (node.kind === 'agg' || node.kind === 'group' || node.kind === 'order') {
            ctx.diagnostics.push({ node: at ?? arg.ast, message: `${name} cannot wrap ${kindLabel(node.kind)}` });
            return ERROR;
        }
        if (numeric === 'numeric' && !isNumeric(node.type) && node.type !== 'unknown') {
            ctx.diagnostics.push({ node: at ?? arg.ast, message: `${name} expects a numeric expression, got type ${typeName(node.type)}` });
            return ERROR;
        }
        let type: SqlType = node.type as SqlType;
        if (name === 'count') type = 'int';
        if (name === 'avg') type = 'float';
        if (name === 'list') type = 'array';
        return mkExpr({ kind: 'agg', name, arg: node, type }, at);
    });
}

function stringFnBuiltin(name: string, result: SqlType): () => Value {
    return () => fn(name, (arg, at, ctx) => {
        const node = exprNode(arg);
        if (!node || (node.type !== 'string' && node.type !== 'unknown')) {
            ctx.diagnostics.push({ node: at ?? arg.ast, message: `${name} expects a string expression, got ${node ? `type ${typeName(node.type)}` : describe(arg)}` });
            return ERROR;
        }
        if (forbid(node, ['agg', 'group', 'order'], `${name}`, at ?? arg.ast, ctx)) return ERROR;
        return mkExpr({ kind: 'call', name, args: [node], type: result }, at);
    });
}

// ---------------------------------------------------------------------------
// Date & time builtins — the tetaue names are general SQL functions whose
// lowering varies per dialect (render.ts owns the per-dialect SQL).
// ---------------------------------------------------------------------------

const DATE_PARTS = ['year', 'month', 'day', 'day_of_week', 'hour', 'minute', 'second'] as const;

const DATE_UNITS = ['year', 'month', 'week', 'day', 'hour', 'minute', 'second'] as const;

/** True for expressions that carry a date or timestamp value. */
function dateLike(node: SqlNode): boolean {
    return node.type === 'date' || node.type === 'timestamp' || node.type === 'unknown';
}

function dateLikeError(name: string, v: Value, node: SqlNode | null, at: AstNode | undefined, ctx: Ctx): boolean {
    if (node && dateLike(node)) return false;
    ctx.diagnostics.push({ node: at ?? v.ast, message: `${name} expects a date or timestamp expression, got ${node ? `type ${typeName(node.type)}` : describe(v)}` });
    return true;
}

/** A string literal argument that must be one of `allowed` (date parts/units). */
function datePartArg(name: string, v: Value, allowed: readonly string[], at: AstNode | undefined, ctx: Ctx): string | null {
    const s = stringValue(v);
    if (s !== null && (allowed as readonly string[]).includes(s)) return s;
    ctx.diagnostics.push({ node: at ?? v.ast, message: `${name} expects a string literal — one of: ${allowed.join(', ')}` });
    return null;
}

/** `year x`, `month x`, ... — a fixed date part over a date/timestamp value. */
function datePartBuiltin(part: (typeof DATE_PARTS)[number]): () => Value {
    return () => fn(part, (arg, at, ctx) => {
        const node = exprNode(arg);
        if (dateLikeError(part, arg, node, at, ctx)) return ERROR;
        if (forbid(node!, ['agg', 'group', 'order'], part, at ?? arg.ast, ctx)) return ERROR;
        return mkExpr({ kind: 'call', name: part, args: [node!], type: 'int' }, at);
    });
}

/** `extract u.created_at "year"` — the generic form of the date-part helpers. */
function extractBuiltin(): () => Value {
    return () => fn('extract', (arg, at, ctx) => {
        const node = exprNode(arg);
        if (dateLikeError('extract', arg, node, at, ctx)) return ERROR;
        if (forbid(node!, ['agg', 'group', 'order'], 'extract', at ?? arg.ast, ctx)) return ERROR;
        return fn('extract', (fieldArg, at2, ctx2) => {
            const field = datePartArg('extract', fieldArg, DATE_PARTS, at2, ctx2);
            if (field === null) return ERROR;
            return mkExpr({ kind: 'call', name: 'extract', args: [node!, lit(field, 'string')], type: 'int' }, at2);
        });
    });
}

/** `date_add u.created_at "day" 1` — value, unit, amount. */
function dateAddBuiltin(): () => Value {
    return () => fn('date_add', (arg, at, ctx) => {
        const node = exprNode(arg);
        if (dateLikeError('date_add', arg, node, at, ctx)) return ERROR;
        if (forbid(node!, ['agg', 'group', 'order'], 'date_add', at ?? arg.ast, ctx)) return ERROR;
        return fn('date_add', (unitArg, at2, ctx2) => {
            const unit = datePartArg('date_add', unitArg, DATE_UNITS, at2, ctx2);
            if (unit === null) return ERROR;
            return fn('date_add', (amountArg, at3, ctx3) => {
                const amount = exprNode(amountArg);
                if (!amount || (!isNumeric(amount.type) && amount.type !== 'unknown')) {
                    ctx3.diagnostics.push({ node: at3 ?? amountArg.ast, message: `date_add expects a numeric amount, got ${amount ? `type ${typeName(amount.type)}` : describe(amountArg)}` });
                    return ERROR;
                }
                if (forbid(amount, ['agg', 'group', 'order'], 'date_add', at3 ?? amountArg.ast, ctx3)) return ERROR;
                const t: SqlType = node!.type === 'date' ? 'date' : 'timestamp';
                return mkExpr({ kind: 'call', name: 'date_add', args: [node!, lit(unit, 'string'), amount], type: t }, at3);
            });
        });
    });
}

/** `date_diff u.created_at "day" current_date` — value, unit, other. */
function dateDiffBuiltin(): () => Value {
    return () => fn('date_diff', (arg, at, ctx) => {
        const node = exprNode(arg);
        if (dateLikeError('date_diff', arg, node, at, ctx)) return ERROR;
        if (forbid(node!, ['agg', 'group', 'order'], 'date_diff', at ?? arg.ast, ctx)) return ERROR;
        return fn('date_diff', (unitArg, at2, ctx2) => {
            const unit = datePartArg('date_diff', unitArg, DATE_UNITS, at2, ctx2);
            if (unit === null) return ERROR;
            return fn('date_diff', (otherArg, at3, ctx3) => {
                const other = exprNode(otherArg);
                if (dateLikeError('date_diff', otherArg, other, at3, ctx3)) return ERROR;
                if (forbid(other!, ['agg', 'group', 'order'], 'date_diff', at3 ?? otherArg.ast, ctx3)) return ERROR;
                return mkExpr({ kind: 'call', name: 'date_diff', args: [node!, lit(unit, 'string'), other!], type: 'int' }, at3);
            });
        });
    });
}

/** `date_trunc u.created_at "day"` — value, unit. */
function dateTruncBuiltin(): () => Value {
    return () => fn('date_trunc', (arg, at, ctx) => {
        const node = exprNode(arg);
        if (dateLikeError('date_trunc', arg, node, at, ctx)) return ERROR;
        if (forbid(node!, ['agg', 'group', 'order'], 'date_trunc', at ?? arg.ast, ctx)) return ERROR;
        return fn('date_trunc', (unitArg, at2, ctx2) => {
            const unit = datePartArg('date_trunc', unitArg, DATE_UNITS, at2, ctx2);
            if (unit === null) return ERROR;
            return mkExpr({ kind: 'call', name: 'date_trunc', args: [node!, lit(unit, 'string')], type: 'timestamp' }, at2);
        });
    });
}

/** `date_format u.created_at "%Y-%m-%d"` — value, dialect-native format. */
function dateFormatBuiltin(): () => Value {
    return () => fn('date_format', (arg, at, ctx) => {
        const node = exprNode(arg);
        if (dateLikeError('date_format', arg, node, at, ctx)) return ERROR;
        if (forbid(node!, ['agg', 'group', 'order'], 'date_format', at ?? arg.ast, ctx)) return ERROR;
        return fn('date_format', (formatArg, at2, ctx2) => {
            const format = stringValue(formatArg);
            if (format === null) {
                ctx2.diagnostics.push({ node: at2 ?? formatArg.ast, message: `date_format expects a format string literal, e.g. date_format u.created_at "%Y-%m-%d"` });
                return ERROR;
            }
            return mkExpr({ kind: 'call', name: 'date_format', args: [node!, lit(format, 'string')], type: 'string' }, at2);
        });
    });
}

/** `date_parse u.text "%Y-%m-%d"` — string value, dialect-native format. */
function dateParseBuiltin(): () => Value {
    return () => fn('date_parse', (arg, at, ctx) => {
        const node = exprNode(arg);
        if (!node || (node.type !== 'string' && node.type !== 'unknown')) {
            ctx.diagnostics.push({ node: at ?? arg.ast, message: `date_parse expects a string expression, got ${node ? `type ${typeName(node.type)}` : describe(arg)}` });
            return ERROR;
        }
        if (forbid(node, ['agg', 'group', 'order'], 'date_parse', at ?? arg.ast, ctx)) return ERROR;
        return fn('date_parse', (formatArg, at2, ctx2) => {
            const format = stringValue(formatArg);
            if (format === null) {
                ctx2.diagnostics.push({ node: at2 ?? formatArg.ast, message: `date_parse expects a format string literal, e.g. date_parse u.text "%Y-%m-%d"` });
                return ERROR;
            }
            return mkExpr({ kind: 'call', name: 'date_parse', args: [node, lit(format, 'string')], type: 'date' }, at2);
        });
    });
}

/** `to_unixtime u.created_at` / `from_unixtime u.ts`. */
function unixTimeBuiltin(name: 'to_unixtime' | 'from_unixtime'): () => Value {
    return () => fn(name, (arg, at, ctx) => {
        const node = exprNode(arg);
        const wantDate = name === 'to_unixtime';
        if (!node || (wantDate ? !dateLike(node) : !isNumeric(node.type) && node.type !== 'unknown')) {
            ctx.diagnostics.push({ node: at ?? arg.ast, message: `${name} expects ${wantDate ? 'a date or timestamp expression' : 'a numeric expression'}, got ${node ? `type ${typeName(node.type)}` : describe(arg)}` });
            return ERROR;
        }
        if (forbid(node, ['agg', 'group', 'order'], name, at ?? arg.ast, ctx)) return ERROR;
        const type: SqlType = wantDate ? 'int' : 'timestamp';
        return mkExpr({ kind: 'call', name, args: [node], type }, at);
    });
}

// ---------------------------------------------------------------------------
// Scalar builtins (math, string, logical, null handling, casts) — following
// teta's general SQL function set; render.ts owns the per-dialect lowering.
// ---------------------------------------------------------------------------

/** Numeric unary: `ceil x`, `floor x`, `sqrt x` — result keeps the input type. */
function numericUnaryBuiltin(name: string): () => Value {
    return () => fn(name, (arg, at, ctx) => {
        const node = exprNode(arg);
        if (!node || (!isNumeric(node.type) && node.type !== 'unknown')) {
            ctx.diagnostics.push({ node: at ?? arg.ast, message: `${name} expects a numeric expression, got ${node ? `type ${typeName(node.type)}` : describe(arg)}` });
            return ERROR;
        }
        if (forbid(node, ['agg', 'group', 'order'], name, at ?? arg.ast, ctx)) return ERROR;
        return mkExpr({ kind: 'call', name, args: [node], type: node.type as SqlType }, at);
    });
}

/**
 * Numeric binary: `pow x y`, `mod x y`.
 * Result type: 'float' for pow (SQL returns a double), 'first' keeps the
 * first operand's type (int % int stays int).
 */
function numericBinaryBuiltin(name: string, result: 'float' | 'first'): () => Value {
    return () => fn(name, (arg, at, ctx) => {
        const node = exprNode(arg);
        if (!node || (!isNumeric(node.type) && node.type !== 'unknown')) {
            ctx.diagnostics.push({ node: at ?? arg.ast, message: `${name} expects a numeric expression, got ${node ? `type ${typeName(node.type)}` : describe(arg)}` });
            return ERROR;
        }
        if (forbid(node, ['agg', 'group', 'order'], name, at ?? arg.ast, ctx)) return ERROR;
        return fn(name, (otherArg, at2, ctx2) => {
            const other = exprNode(otherArg);
            if (!other || (!isNumeric(other.type) && other.type !== 'unknown')) {
                ctx2.diagnostics.push({ node: at2 ?? otherArg.ast, message: `${name} expects a numeric expression, got ${other ? `type ${typeName(other.type)}` : describe(otherArg)}` });
                return ERROR;
            }
            if (forbid(other, ['agg', 'group', 'order'], name, at2 ?? otherArg.ast, ctx2)) return ERROR;
            const t: SqlType = result === 'float' ? 'float' : (node.type === 'float' ? 'float' : 'int');
            return mkExpr({ kind: 'call', name, args: [node, other], type: t }, at2);
        });
    });
}

const CAST_TYPES = ['int', 'float', 'string', 'bool', 'date', 'timestamp'] as const;

/** `cast x "int"` / `try_cast x "float"` — target type as a string literal. */
function castBuiltin(name: 'cast' | 'try_cast'): () => Value {
    return () => fn(name, (arg, at, ctx) => {
        const node = exprNode(arg);
        if (!node) {
            ctx.diagnostics.push({ node: at ?? arg.ast, message: `${name} expects an expression and a target type, e.g. ${name} u.age "float"` });
            return ERROR;
        }
        if (forbid(node, ['agg', 'group', 'order'], name, at ?? arg.ast, ctx)) return ERROR;
        return fn(name, (typeArg, at2, ctx2) => {
            const type = stringValue(typeArg);
            if (type === null || !(CAST_TYPES as readonly string[]).includes(type)) {
                ctx2.diagnostics.push({ node: at2 ?? typeArg.ast, message: `${name} expects a target type as a string literal — one of: ${CAST_TYPES.join(', ')}` });
                return ERROR;
            }
            return mkExpr({ kind: 'call', name, args: [node, lit(type, 'string')], type: type as SqlType }, at2);
        });
    });
}

// ---------------------------------------------------------------------------
// Variadic builtins — the interpreter collects all application arguments at
// once (an `Application` node's `arguments` list) instead of currying. See
// evalExpr's Application case; render.ts lowers the resulting call nodes.
// ---------------------------------------------------------------------------

/** A variadic builtin's env value — applying it as a curried function is an error. */
function variadicFn(name: string): () => Value {
    return () => ({
        kind: 'fn',
        name,
        variadic: true,
        apply: (_arg, at, ctx) => {
            ctx.diagnostics.push({ node: at, message: `${name} is variadic — apply all arguments directly, e.g. ${variadicExample(name)}` });
            return ERROR;
        },
    });
}

function variadicExample(name: string): string {
    switch (name) {
        case 'concat': return 'concat u.first u.last';
        case 'greatest': return 'greatest u.a u.b';
        case 'least': return 'least u.a u.b';
        case 'round': return 'round u.x 2';
        case 'substring': return 'substring u.name 1 3';
        case 'lpad': return 'lpad u.code 8 "0"';
        case 'rpad': return 'rpad u.code 8 "0"';
        case 'regex_extract': return 'regex_extract u.name "([0-9]+)" 1';
        case 'lag': return 'lag u.salary 1 0';
        case 'lead': return 'lead u.salary 1';
    }
    return `${name} a b`;
}

/** All args must be expression nodes of the given kind — else diagnostic + null. */
function exprArgs(
    args: Value[],
    what: string,
    kind: 'numeric' | 'string' | 'date' | 'any',
    at: AstNode | undefined,
    ctx: Ctx,
): SqlNode[] | null {
    const nodes: SqlNode[] = [];
    for (const a of args) {
        const node = exprNode(a);
        const ok = node !== null && (kind === 'any'
            ? true
            : kind === 'numeric'
                ? isNumeric(node.type) || node.type === 'unknown'
                : kind === 'string'
                    ? node.type === 'string' || node.type === 'unknown'
                    : dateLike(node));
        if (!ok) {
            const want = kind === 'numeric' ? 'numeric' : kind === 'string' ? 'string' : 'date or timestamp';
            ctx.diagnostics.push({ node: at ?? a.ast, message: `${what} expects ${want} expressions, got ${node ? `type ${typeName(node.type)}` : describe(a)}` });
            return null;
        }
        if (forbid(node, ['agg', 'group', 'order'], what, at ?? a.ast, ctx)) return null;
        nodes.push(node);
    }
    return nodes;
}

const VARIADIC: Record<string, { min: number; max: number; apply: (args: Value[], at: AstNode | undefined, ctx: Ctx) => Value }> = {
    concat: {
        min: 2, max: Infinity,
        apply: (args, at, ctx) => {
            const nodes = exprArgs(args, 'concat', 'string', at, ctx);
            if (nodes === null) return ERROR;
            return mkExpr({ kind: 'call', name: 'concat', args: nodes, type: 'string' }, at);
        },
    },
    greatest: {
        min: 2, max: Infinity,
        apply: (args, at, ctx) => variadicExtremum('greatest', args, at, ctx),
    },
    least: {
        min: 2, max: Infinity,
        apply: (args, at, ctx) => variadicExtremum('least', args, at, ctx),
    },
    round: {
        min: 1, max: 2,
        apply: (args, at, ctx) => {
            const nodes = exprArgs(args, 'round', 'numeric', at, ctx);
            if (nodes === null) return ERROR;
            return mkExpr({ kind: 'call', name: 'round', args: nodes, type: nodes[0]!.type as SqlType }, at);
        },
    },
    substring: {
        min: 2, max: 3,
        apply: (args, at, ctx) => {
            const value = exprArgs([args[0]!], 'substring', 'string', at, ctx);
            if (value === null) return ERROR;
            const start = exprArgs([args[1]!], 'substring', 'numeric', at, ctx);
            if (start === null) return ERROR;
            const hasLength = args[2] !== undefined;
            const length = hasLength ? exprArgs([args[2]!], 'substring', 'numeric', at, ctx) : null;
            if (hasLength && length === null) return ERROR;
            return mkExpr({ kind: 'call', name: 'substring', args: hasLength ? [value[0]!, start[0]!, length![0]!] : [value[0]!, start[0]!], type: 'string' }, at);
        },
    },
    lpad: {
        min: 2, max: 3,
        apply: (args, at, ctx) => variadicPad('lpad', args, at, ctx),
    },
    rpad: {
        min: 2, max: 3,
        apply: (args, at, ctx) => variadicPad('rpad', args, at, ctx),
    },
    regex_extract: {
        min: 2, max: 3,
        apply: (args, at, ctx) => {
            const value = exprArgs([args[0]!], 'regex_extract', 'string', at, ctx);
            if (value === null) return ERROR;
            const pattern = exprArgs([args[1]!], 'regex_extract', 'string', at, ctx);
            if (pattern === null) return ERROR;
            const hasGroup = args[2] !== undefined;
            const group = hasGroup ? exprArgs([args[2]!], 'regex_extract', 'numeric', at, ctx) : null;
            if (hasGroup && group === null) return ERROR;
            return mkExpr({ kind: 'call', name: 'regex_extract', args: hasGroup ? [value[0]!, pattern[0]!, group![0]!] : [value[0]!, pattern[0]!], type: 'string' }, at);
        },
    },
    lag: {
        min: 1, max: 3,
        apply: (args, at, ctx) => variadicLagLead('lag', args, at, ctx),
    },
    lead: {
        min: 1, max: 3,
        apply: (args, at, ctx) => variadicLagLead('lead', args, at, ctx),
    },
};

/** greatest/least — all arguments must share a comparable type. */
function variadicExtremum(name: 'greatest' | 'least', args: Value[], at: AstNode | undefined, ctx: Ctx): Value {
    const nodes = exprArgs(args, name, 'any', at, ctx);
    if (nodes === null) return ERROR;
    const base = nodes[0]!;
    for (let i = 1; i < nodes.length; i++) {
        if (!comparable(base.type, nodes[i]!.type) || (isNumeric(base.type) !== isNumeric(nodes[i]!.type) && base.type !== 'unknown' && nodes[i]!.type !== 'unknown')) {
            ctx.diagnostics.push({ node: at, message: `${name} requires matching types, got ${typeName(base.type)} and ${typeName(nodes[i]!.type)}` });
            return ERROR;
        }
    }
    const t = base.type === 'null' ? 'string' : base.type;
    return mkExpr({ kind: 'call', name, args: nodes, type: t }, at);
}

/** lpad/rpad — value, length, optional padding. */
function variadicPad(name: 'lpad' | 'rpad', args: Value[], at: AstNode | undefined, ctx: Ctx): Value {
    const value = exprArgs([args[0]!], name, 'string', at, ctx);
    if (value === null) return ERROR;
    const length = exprArgs([args[1]!], name, 'numeric', at, ctx);
    if (length === null) return ERROR;
    const padding = args[2] !== undefined ? exprArgs([args[2]!], name, 'string', at, ctx) : null;
    if (padding === null) return ERROR;
    return mkExpr({ kind: 'call', name, args: padding ? [value[0]!, length[0]!, padding[0]!] : [value[0]!, length[0]!], type: 'string' }, at);
}

/** lag/lead — value, optional offset (int), optional default (any type). */
function variadicLagLead(name: 'lag' | 'lead', args: Value[], at: AstNode | undefined, ctx: Ctx): Value {
    const value = exprNode(args[0]!);
    if (!value) {
        ctx.diagnostics.push({ node: at ?? args[0]!.ast, message: `${name} expects an expression to look up, e.g. ${name} u.salary 1 0` });
        return ERROR;
    }
    if (forbid(value, ['agg', 'group', 'order', 'window'], name, at ?? args[0]!.ast, ctx)) return ERROR;
    const nodes: SqlNode[] = [value];
    if (args[1] !== undefined) {
        const offset = exprNode(args[1]!);
        if (!offset || (!isNumeric(offset.type) && offset.type !== 'unknown')) {
            ctx.diagnostics.push({ node: at ?? args[1]!.ast, message: `${name} expects a numeric offset, got ${offset ? `type ${typeName(offset.type)}` : describe(args[1]!)}` });
            return ERROR;
        }
        if (forbid(offset, ['agg', 'group', 'order', 'window'], name, at ?? args[1]!.ast, ctx)) return ERROR;
        nodes.push(offset);
    }
    if (args[2] !== undefined) {
        const def = exprNode(args[2]!);
        if (!def) {
            ctx.diagnostics.push({ node: at ?? args[2]!.ast, message: `${name} expects an expression as its default value, e.g. ${name} u.salary 1 0` });
            return ERROR;
        }
        if (forbid(def, ['agg', 'group', 'order', 'window'], name, at ?? args[2]!.ast, ctx)) return ERROR;
        nodes.push(def);
    }
    const t: SqlType = value.type === 'null' ? 'string' : value.type;
    return mkExpr({ kind: 'call', name, args: nodes, type: t }, at);
}

// ---------------------------------------------------------------------------
// Window functions (OVER) — see render.ts's 'window' case for the SQL.
// ---------------------------------------------------------------------------

/** Window-only functions: invalid anywhere outside `over (...)`'s fn position. */
const WINDOW_ONLY = new Set(['row_number', 'rank', 'dense_rank', 'percent_rank', 'ntile', 'lag', 'lead']);

/** A list value, or a single value treated as a one-element list. */
function listOrSingle(v: Value): Value[] | null {
    if (v.kind === 'list') return v.items;
    if (v.kind === 'expr' || v.kind === 'error') return [v];
    return null;
}

/**
 * Parse `over`'s spec record: `{ partition = [...], order = [...] }` with
 * either field optional. Partition columns must be plain expressions; order
 * must be asc/desc items (reusing sort's orderItems validation).
 */
function windowSpec(v: Value, at: AstNode | undefined, ctx: Ctx): { partition: SqlNode[]; order: { node: SqlNode; dir: 'ASC' | 'DESC' }[] } | null {
    if (v.kind !== 'record') {
        ctx.diagnostics.push({ node: at ?? v.ast, message: `over expects a spec record, e.g. over (row_number) { partition = [u.dept], order = [desc u.salary] } — got ${describe(v)}` });
        return null;
    }
    const fields = new Map(v.fields.map(f => [f.key, f.value]));
    for (const key of fields.keys()) {
        if (key !== 'partition' && key !== 'order') {
            ctx.diagnostics.push({ node: at ?? v.ast, message: `unknown over spec field '${key}' — expected 'partition' and/or 'order'` });
            return null;
        }
    }
    let partition: SqlNode[] = [];
    const pv = fields.get('partition');
    if (pv !== undefined) {
        const items = listOrSingle(pv);
        if (items === null) {
            ctx.diagnostics.push({ node: at ?? pv.ast, message: `over spec 'partition' expects a list of columns, e.g. partition = [u.dept, u.region]` });
            return null;
        }
        for (const item of items) {
            const node = exprNode(item);
            if (!node) {
                ctx.diagnostics.push({ node: at ?? item.ast, message: `over spec 'partition' entries must be column expressions, got ${describe(item)}` });
                return null;
            }
            if (forbid(node, ['agg', 'group', 'order', 'window'], 'partition', at ?? item.ast, ctx)) return null;
            partition.push(node);
        }
    }
    let order: { node: SqlNode; dir: 'ASC' | 'DESC' }[] = [];
    const ov = fields.get('order');
    if (ov !== undefined) {
        const items = orderItems(ov, at, ctx, false, 'over spec');
        if (items === null) return null;
        // A window function cannot appear inside a window's own ORDER BY.
        for (const item of items) {
            if (forbid(item.node, ['window'], 'order', at ?? ov.ast, ctx)) return null;
        }
        order = items;
    }
    return { partition, order };
}

/**
 * Walk a projection's expressions and reject window-only functions
 * (row_number, rank, ...) that are not wrapped in `over (...)` — a bare
 * `ROW_NUMBER()` would render invalid SQL. `over (sum u.x) {...}` is fine
 * because `sum` is an aggregate, not a window-only function.
 */
function validateWindowUses(fields: { key: string; node: SqlNode }[], at: AstNode | undefined, ctx: Ctx): boolean {
    let bad = false;
    const visit = (n: SqlNode, parent: SqlNode | null, slot: string | null): void => {
        if (n.kind === 'call' && WINDOW_ONLY.has(n.name) && !(parent?.kind === 'window' && slot === 'fn')) {
            ctx.diagnostics.push({ node: at, message: `${n.name} must be wrapped in over (...) — e.g. over (${n.name}) { partition = [u.dept], order = [desc u.salary] }` });
            bad = true;
        }
        switch (n.kind) {
            case 'col': case 'lit': case 'current-date': case 'current-timestamp': break;
            case 'bin': visit(n.left, n, 'left'); visit(n.right, n, 'right'); break;
            case 'is-null': case 'not': case 'group': case 'order': visit(n.expr, n, 'expr'); break;
            case 'agg': visit(n.arg, n, 'arg'); break;
            case 'call': n.args.forEach(a => visit(a, n, 'args')); break;
            case 'window':
                visit(n.fn, n, 'fn');
                n.partition.forEach(p => visit(p, n, 'partition'));
                n.order.forEach(o => visit(o.node, n, 'order'));
                break;
            case 'in': visit(n.expr, n, 'expr'); n.list.forEach(a => visit(a, n, 'list')); break;
        }
    };
    for (const field of fields) visit(field.node, null, null);
    return bad;
}

function inBuiltin(negated: boolean): () => Value {
    return () => fn('is_in', (value, at, ctx) => {
        const node = exprNode(value);
        if (!node) {
            ctx.diagnostics.push({ node: at ?? value.ast, message: `is_in expects a value expression, e.g. is_in u.id [1, 2, 3]` });
            return ERROR;
        }
        return fn('is_in', (listVal, at2, ctx2) => {
            if (listVal.kind !== 'list' || listVal.items.length === 0) {
                ctx2.diagnostics.push({ node: at2 ?? listVal.ast, message: `is_in expects a non-empty list, e.g. is_in u.id [1, 2, 3]` });
                return ERROR;
            }
            const items: SqlNode[] = [];
            for (const item of listVal.items) {
                const itemNode = exprNode(item);
                if (!itemNode) {
                    ctx2.diagnostics.push({ node: item.ast ?? at2, message: `is_in list items must be expressions, got ${describe(item)}` });
                    return ERROR;
                }
                const isNullItem = itemNode.kind === 'lit' && itemNode.value === null;
                if (isNullItem) {
                    items.push(itemNode);
                    continue;
                }
                if (!comparable(node.type, itemNode.type)) {
                    ctx2.diagnostics.push({ node: item.ast ?? at2, message: `is_in list items must match type ${typeName(node.type)}, got ${typeName(itemNode.type)}` });
                    return ERROR;
                }
                items.push(itemNode);
            }
            if (forbid(node, ['agg', 'group', 'order'], 'is_in', at2 ?? value.ast, ctx2)) return ERROR;
            return mkExpr({ kind: 'in', expr: node, list: items, negated, type: 'bool' }, at2);
        });
    });
}

/** The QueryType inside a type annotation, unwrapping `?` and parens (null if not a query type). */
function queryTypeOf(t: import('./generated/ast.js').Type): QueryType | null {
    let cur = t;
    for (;;) {
        if (isNullType(cur)) { cur = cur.base; continue; }
        if (isTypeParen(cur)) { cur = cur.type; continue; }
        break;
    }
    return isQueryType(cur) ? cur : null;
}

/** Decode a binding annotation `query { id: int, name: string }` into a runtime Schema. */
function schemaFromQueryType(t: QueryType, at: AstNode | undefined, ctx: Ctx): Schema | null {
    if (t.tail) {
        ctx.diagnostics.push({ node: t, message: `table schema must be a closed record — every column must be listed` });
        return null;
    }
    const schema: Schema = new Map();
    for (const field of t.fields) {
        const type = scalarTypeOf(field.type);
        if (type === null) {
            ctx.diagnostics.push({ node: field.type, message: `schema entry '${field.key}' must be a scalar type (int, string, bool, float, date, timestamp) or a list of one, e.g. [string]` });
            return null; // leave the table dynamic — no partial schema
        }
        schema.set(field.key, { type, table: null });
    }
    return schema;
}

/** The SqlType named by a column type (`int`, `int?`, `[string]`, ...), or null if not a scalar. */
function scalarTypeOf(t: import('./generated/ast.js').Type): SqlType | null {
    let cur: import('./generated/ast.js').Type = t;
    // unwrap `?` and parentheses
    for (;;) {
        if (isNullType(cur)) { cur = cur.base; continue; }
        if (isTypeParen(cur)) { cur = cur.type; continue; }
        break;
    }
    // `[T]` — an array column (element type is not tracked at the SQL layer).
    if (isListType(cur)) {
        return scalarTypeOf(cur.type) === null ? null : 'array';
    }
    if (!isTypeVar(cur)) return null;
    const name = cur.name;
    if (name === 'int' || name === 'float' || name === 'string' || name === 'bool' || name === 'date' || name === 'timestamp') {
        return name;
    }
    return null;
}

function rowFromRecord(v: Value, at: AstNode | undefined, ctx: Ctx, what: string, allowAgg = false): RowNode | null {
    if (v.kind !== 'record') {
        ctx.diagnostics.push({ node: at ?? v.ast, message: `${what} must be a record like { key = expr, ... }, got ${describe(v)}` });
        return null;
    }
    const row: RowNode = { fields: [] };
    for (const { key, value } of v.fields) {
        const node = exprNode(value);
        if (!node) {
            ctx.diagnostics.push({ node: value.ast ?? at, message: `${what} entry '${key}' must be a scalar expression, got ${describe(value)}` });
            continue;
        }
        if (node.type === 'null') {
            ctx.diagnostics.push({ node: value.ast ?? at, message: `${what} entry '${key}' cannot be null` });
            continue;
        }
        // Aggregates are normally rejected outside a fold, but a map after a
        // fold runs on the aggregated result (a derived table), so wrapping
        // an aggregate there is valid nested aggregation:
        //   fold {...} & map (r => { grand_total = sum r.total })
        //   -- SELECT SUM(<name>.total) FROM (fold) AS <name>
        if (node.kind === 'agg' || node.kind === 'group' || node.kind === 'order') {
            if (!(allowAgg && node.kind === 'agg')) {
                ctx.diagnostics.push({ node: value.ast ?? at, message: `${what} entry '${key}' cannot contain ${kindLabel(node.kind)}` });
                continue;
            }
        }
        row.fields.push({ key, node });
    }
    return row;
}

function orderItems(v: Value, at: AstNode | undefined, ctx: Ctx, afterFold: boolean, what = 'sort'): { node: SqlNode; dir: 'ASC' | 'DESC' }[] | null {
    const collect = (value: Value, out: { node: SqlNode; dir: 'ASC' | 'DESC' }[]): boolean => {
        const node = exprNode(value);
        if (!node || node.kind !== 'order') {
            ctx.diagnostics.push({ node: value.ast ?? at, message: `${what} expects order items like asc u.name or a list of them, got ${node ? `an expression of type ${typeName(node.type)}` : describe(value)}` });
            return false;
        }
        // After fold, ordering by a group key or aggregate is allowed (ORDER BY SUM(...)).
        const forbidden: SqlNode['kind'][] = afterFold ? [] : ['agg', 'group', 'order'];
        if (forbid(node.expr, forbidden, what, value.ast ?? at, ctx)) return false;
        out.push({ node: node.expr, dir: node.dir });
        return true;
    };
    if (v.kind === 'list') {
        const out: { node: SqlNode; dir: 'ASC' | 'DESC' }[] = [];
        for (const item of v.items) {
            if (!collect(item, out)) return null;
        }
        return out;
    }
    const out: { node: SqlNode; dir: 'ASC' | 'DESC' }[] = [];
    return collect(v, out) ? out : null;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export interface AnalysisResult {
    value: Value;
    diagnostics: Diagnostic[];
}

export interface ProjectAnalysisOptions {
    /** Require the last module's last binding to be a query (default true). */
    requireQuery?: boolean;
}

/**
 * Evaluate a project: the modules in import order (imports first, the root
 * module last). Each module is evaluated in its OWN scope — the prelude, its
 * own imports (flat bindings + namespace aliases), then its own bindings —
 * so nothing leaks across modules and no binding can see a sibling's scope.
 * Only `export`ed bindings are visible to importers (flat or qualified).
 * The ROOT module's last binding is the project's query.
 */
export function analyzeProject(modules: ProjectModule[], options: ProjectAnalysisOptions = {}): AnalysisResult {
    const { requireQuery = true } = options;
    const diagnostics: Diagnostic[] = [];
    // Forward-reference hints are filled per module below: a name from a
    // sibling module is simply unknown, not "defined later".
    const ctx: Ctx = { env: new Map(), diagnostics, moduleBindings: new Set<string>() };

    // Exported bindings per module, keyed by module identity (diamond dedup
    // means every importer references the SAME target object). Filled as each
    // module is evaluated, so a module's imports are always ready.
    const exportsByModule = new Map<ProjectModule, Map<string, Value>>();

    let value: Value = ERROR;
    for (const module of modules) {
        const env = new Map<string, Value>();
        for (const [name, factory] of Object.entries(BUILTINS)) {
            env.set(name, factory());
        }
        ctx.env = env;
        ctx.moduleBindings = new Set(module.model.bindings.map(b => b.name));

        // --- imports: flat bindings + namespace aliases ------------------
        // `scope` tracks every name this module has bound (imports, aliases,
        // then local bindings) so collisions are errors, never silent
        // shadowing. Prelude names are NOT tracked — imports and local
        // bindings may shadow builtins, exactly as before. Values are labels
        // describing the existing binding, for conflict messages.
        const scope = new Map<string, string>();
        for (const { alias, target, importNode } of module.imports) {
            const targetExports = exportsByModule.get(target);
            if (!targetExports) continue; // cyclic/missing target — already diagnosed
            const spec = parseStringLiteral(importNode.path);
            // A selective name list `(users, orders)` restricts what is
            // visible to exactly those exports; every listed name must be
            // exported by the target.
            let selected = targetExports;
            if (importNode.names && importNode.names.length > 0) {
                for (const n of importNode.names) {
                    if (!targetExports.has(n)) {
                        const keys = [...targetExports.keys()];
                        diagnostics.push({ node: importNode, message: `'${n}' is not exported by '${spec}' — exported: ${keys.length > 0 ? keys.join(', ') : '(none)'}` });
                    }
                }
                selected = new Map(
                    importNode.names.filter(n => targetExports.has(n)).map(n => [n, targetExports.get(n)!]),
                );
            }
            if (alias !== undefined) {
                if (scope.has(alias)) {
                    diagnostics.push({ node: importNode, message: conflictMessage(alias, scope.get(alias)!, 'import alias') });
                    continue;
                }
                scope.set(alias, `import alias '${alias}'`);
                env.set(alias, { kind: 'module', name: alias, exports: selected, ast: importNode });
            } else {
                for (const [name, v] of selected) {
                    if (scope.has(name)) {
                        diagnostics.push({ node: importNode, message: conflictMessage(name, scope.get(name)!, `imported from '${spec}'`) });
                        continue;
                    }
                    scope.set(name, `'${name}' imported from '${spec}'`);
                    env.set(name, v);
                }
            }
        }

        // --- local bindings (in order) ------------------------------------
        const exports = new Map<string, Value>();
        const seen = new Set<string>(); // within-module duplicate detection (checkBinding)
        for (const binding of module.model.bindings) {
            if (scope.has(binding.name)) {
                // The program is invalid either way; keep evaluating so
                // downstream errors still surface, but report the conflict.
                diagnostics.push({ node: binding, message: conflictMessage(binding.name, scope.get(binding.name)!, 'a local binding') });
            }
            scope.set(binding.name, `local binding '${binding.name}'`);
            value = checkBinding(binding, ctx, seen);
            if (binding.export) exports.set(binding.name, value);
        }
        exportsByModule.set(module, exports);
    }

    const root = modules[modules.length - 1];
    if (requireQuery && root) {
        const last = root.model.bindings[root.model.bindings.length - 1];
        if (!last) {
            value = ERROR;
            diagnostics.push({
                node: root.model,
                message: `a module must have at least one binding — its last binding is the module's query`,
            });
        } else if (!isError(value) && value.kind !== 'query') {
            diagnostics.push({
                node: last,
                message: `a module's last binding must be a query (a table or a pipeline), got ${describe(value)}`,
            });
        }
    }
    return { value, diagnostics };
}

/** "name X (newcomer) conflicts with Y" — Y describes the name already in scope. */
function conflictMessage(name: string, existing: string, newcomer: string): string {
    return `name '${name}' (${newcomer}) conflicts with ${existing}`;
}

/** Evaluate a single module (no imports). */
export function analyze(model: Model): AnalysisResult {
    return analyzeProject([{ model, uri: undefined, imports: [] }]);
}

function checkBinding(binding: Binding, ctx: Ctx, seen: Set<string>): Value {
    if (seen.has(binding.name)) {
        ctx.diagnostics.push({ node: binding, message: `duplicate binding name '${binding.name}'` });
    }
    seen.add(binding.name);
    let v = evalExpr(binding.value, ctx);
    // A query-type binding annotation is the schema of a plain table:
    //   users: query { id: int, name: string } = table "users"
    // (Only join-free queries: stamping joined columns with the root table
    // would mis-qualify them. Any other annotation is just a signature.)
    if (v.kind === 'query' && !v.query.known && binding.type
        && v.query.steps.every(step => step.kind !== 'join')) {
        const qt = queryTypeOf(binding.type);
        if (qt) {
            const schema = schemaFromQueryType(qt, binding, ctx);
            if (schema) {
                // Stamp with the root's plain alias (last segment), matching
                // rowRecord, so column references stay `alias.column`.
                for (const col of schema.values()) col.table = v.query.aliases[0] ?? v.query.root.name;
                v.query.root.schema = schema;
                v.query.known = true;
            }
        }
    }
    // Remember the binding name on query values so generated SQL aliases
    // (derived tables, joined subqueries) can reuse it instead of inventing
    // names like `folded` — the SQL then reads like the source. Copy the
    // query (shallow) so two bindings over the same value (`x = users`,
    // `y = users`) keep their own names instead of one stamping over the
    // other's on the shared object.
    if (v.kind === 'query') {
        v = { kind: 'query', query: { ...v.query, name: binding.name }, ast: v.ast };
    }
    ctx.env.set(binding.name, v);
    return v;
}

// re-export for the validator
export { ERROR };
