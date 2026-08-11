/******************************************************************************
 * tetaue interpreter — symbolic evaluation of a tetaue module.
 *
 * Evaluation is "symbolic": expressions over query rows become SQL expression
 * trees (SqlNode), and query pipelines become a logical Query plan. The same
 * evaluator powers both the Langium validator (collecting diagnostics) and
 * the CLI renderer (producing a Query value to render to SQL).
 ******************************************************************************/
import type { AstNode } from 'langium';
import {
    isAccessExpression, isApplication, isBinaryExpression, isBooleanLiteral,
    isIdentifier, isLambda, isListLiteral, isMapLiteral,
    isNullLiteral, isNumberLiteral, isStringLiteral, isUnaryMinus,
    type Binding, type Expr, type Lambda, type Model, type UnaryExpression,
} from './generated/ast.js';

// ---------------------------------------------------------------------------
// SQL model
// ---------------------------------------------------------------------------

export type SqlType = 'int' | 'float' | 'string' | 'bool' | 'date' | 'timestamp';
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
    | { kind: 'in'; expr: SqlNode; list: SqlNode[]; negated: boolean; type: 'bool' }
    | { kind: 'agg'; name: string; arg: SqlNode; type: SqlType }
    | { kind: 'group'; expr: SqlNode; table: string | null; type: SqlType }
    | { kind: 'order'; expr: SqlNode; dir: 'ASC' | 'DESC'; type: SqlType };

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
    | { kind: 'join'; joinKind: JoinKind; right: Query; on: SqlNode };

export interface Query {
    root: { name: string; schema: Schema };
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
    | { kind: 'fn'; name: string; apply: (arg: Value, at: AstNode | undefined, ctx: Ctx) => Value; ast?: AstNode }
    | { kind: 'step'; name: string; apply: (q: Query, at: AstNode | undefined, ctx: Ctx) => Query | null; ast?: AstNode }
    | { kind: 'lambda'; params: string[]; body: Expr; closure: Map<string, Value>; ast?: AstNode }
    /**
     * An optic (Haskell lens/optics style): the language's core abstraction.
     *
     * An optic is a pair of `read` (s → a, the "view") and `over`
     * ((a → b) → s → t, the van Laarhoven-style primitive). `view` and `set`
     * derive from `over`; optics compose with the PureScript operators
     * `<<<` / `>>>`.
     * A `traversal` optic (e.g. `mapped`) has no single view.
     */
    | {
        kind: 'optic';
        name: string;
        /** true = a traversal over many focuses (e.g. `mapped`): view is undefined. */
        traversal: boolean;
        read: (s: Value, at: AstNode | undefined, ctx: Ctx) => Value;
        over: (f: Value, s: Value, at: AstNode | undefined, ctx: Ctx) => Value;
        ast?: AstNode;
    }
    /**
     * A first-class record value. Field access (`r.name`) and the field lens
     * operators (`r ^. name`, `r & name %~ f`) work over records.
     * A row inside a lambda is a record whose schema comes from the pipeline
     * and whose `fields` are empty (columns are synthesized on access); a
     * materialized record (a `{ ... }` literal or the result of `%~`/`.~`)
     * carries its evaluated fields.
     */
    | { kind: 'record'; schema: Schema; fields: { key: string; value: Value }[]; ast?: AstNode }
    | { kind: 'expr'; node: SqlNode; ast?: AstNode }
    | { kind: 'list'; items: Value[]; ast?: AstNode }
    | { kind: 'sql-type'; type: SqlType; ast?: AstNode }
    /** Absence — the focus of `at` when a key is missing (lens's `Nothing`). Distinct from SQL `null`. */
    | { kind: 'none'; ast?: AstNode }
    | { kind: 'error'; ast?: AstNode };

export interface Ctx {
    env: Map<string, Value>;
    diagnostics: Diagnostic[];
    /** Names bound anywhere in the module (for forward-reference hints). */
    moduleBindings: Set<string>;
}

const ERROR: Value = { kind: 'error' };

/** Absence (lens's `Nothing`) — the focus of `at` for a missing key. */
const NONE: Value = { kind: 'none' };

export function isError(v: Value): v is { kind: 'error'; ast?: AstNode } {
    return v.kind === 'error';
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TYPE_NAMES: Record<TypeOrNull, string> = {
    int: 'int', float: 'float', string: 'string', bool: 'bool',
    date: 'date', timestamp: 'timestamp', null: 'null',
};

export function typeName(t: TypeOrNull): string {
    return TYPE_NAMES[t] ?? String(t);
}

export function isNumeric(t: TypeOrNull): boolean {
    return t === 'int' || t === 'float';
}

export function comparable(a: TypeOrNull, b: TypeOrNull): boolean {
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
        case 'optic': return v.traversal ? `a traversal (${v.name})` : `a lens (${v.name})`;
        case 'record': return 'a record';
        case 'expr': return `an expression of type ${typeName(v.node.type)}`;
        case 'list': return 'a list';
        case 'sql-type': return `type ${v.type}`;
        case 'none': return 'none';
        case 'error': return 'an error';
    }
}

export function exprNode(v: Value): SqlNode | null {
    return v.kind === 'expr' ? v.node : null;
}

function mkExpr(node: SqlNode, ast?: AstNode): Value {
    return { kind: 'expr', node, ast };
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

function lambdaParams(l: Lambda): string[] {
    return l.param !== undefined ? [l.param] : l.params;
}

/** Walk a SqlNode tree; call `visit` for every node. */
function forEachNode(node: SqlNode, visit: (n: SqlNode) => void): void {
    visit(node);
    switch (node.kind) {
        case 'col': case 'lit': break;
        case 'bin': forEachNode(node.left, visit); forEachNode(node.right, visit); break;
        case 'is-null': case 'not': case 'group': case 'order':
            forEachNode(node.expr, visit); break;
        case 'agg': forEachNode(node.arg, visit); break;
        case 'call': node.args.forEach(a => forEachNode(a, visit)); break;
        case 'in': forEachNode(node.expr, visit); node.list.forEach(a => forEachNode(a, visit)); break;
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
            case 'map': schema = rowNodeSchema(step.proj); break;
            case 'fold': schema = rowNodeSchema(step.proj); break;
            case 'join': {
                const rightSchema = step.right.root.schema;
                for (const [name, col] of rightSchema) {
                    if (schema.has(name)) continue; // collision reported when the step was built
                    schema.set(name, col);
                }
                break;
            }
        }
    }
    return schema;
}

function addStep(q: Query, step: QueryStep): Query {
    return { ...q, steps: [...q.steps, step] };
}

function hasFoldStep(q: Query): boolean {
    return q.steps.some(s => s.kind === 'fold');
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
        case 'optic':
            ctx.diagnostics.push({ node: at ?? f.ast, message: `cannot apply ${describe(f)} — optics compose with the <<< / >>> operators: (${f.name}) <<< field` });
            return ERROR;
        default:
            ctx.diagnostics.push({ node: at ?? fallbackNode(ctx), message: `cannot apply ${describe(f)}` });
            return ERROR;
    }
}

function astOf(v: Value): AstNode | undefined {
    return 'ast' in v ? v.ast : undefined;
}

// ---------------------------------------------------------------------------
// Optics (Haskell lens/optics style)
//
// The language's core abstraction. An optic focuses on part(s) of a value:
//   - a field lens `field "name"` focuses on a record field;
//   - `mapped` is a traversal focusing on every row of a query;
//   - optics compose with `<<<` / `>>>`: `mapped <<< name`, `(field "a") <<< b`.
//
// `over` is the primitive; `view` and `set` derive from it:
//   view l s = read l s            (error if l is a traversal)
//   set  l b s = over l (const b) s
// ---------------------------------------------------------------------------

/** Build an optic value. */
function mkOptic(
    name: string,
    traversal: boolean,
    read: (s: Value, at: AstNode | undefined, ctx: Ctx) => Value,
    over: (f: Value, s: Value, at: AstNode | undefined, ctx: Ctx) => Value,
    ast?: AstNode,
): Value {
    return { kind: 'optic', name, traversal, read, over, ast };
}

/**
 * The `mapped` traversal: focuses on every row of a query. `view` is
 * undefined; `over`/`set` lower to a `map` step.
 */
function mappedOptic(): Value {
    return mkOptic(
        'mapped',
        true,
        (s, at, ctx) => {
            ctx.diagnostics.push({ node: at ?? s.ast, message: `mapped is a traversal — view is undefined; use over (%~) or set (.~) instead` });
            return ERROR;
        },
        (f, s, at, ctx) => {
            if (s.kind !== 'query') {
                ctx.diagnostics.push({ node: at ?? s.ast, message: `mapped operates on a query — use it in a pipeline: users & mapped ...` });
                return ERROR;
            }
            const next = mapStepFromTransformer(s.query, f, at, ctx);
            return next ? { kind: 'query', query: next, ast: at } : ERROR;
        },
    );
}

/** Derive a record's schema from its evaluated fields (types only where known). */
function recordSchemaOf(fields: { key: string; value: Value }[]): Schema {
    const schema: Schema = new Map();
    for (const { key, value } of fields) {
        if (value.kind === 'expr') {
            schema.set(key, { type: value.node.type as SqlType, table: nodeTable(value.node), expr: value.node });
        } else if (value.kind === 'sql-type') {
            schema.set(key, { type: value.type, table: null });
        }
    }
    return schema;
}

/** A row-shaped record: a schema with no materialized fields (lambda parameter). */
function rowRecord(schema: Schema, ast?: AstNode): Value {
    return { kind: 'record', schema, fields: [], ast };
}

/** A materialized record value: evaluated fields plus a derived schema. */
function recordValue(fields: { key: string; value: Value }[], ast?: AstNode): Value {
    return { kind: 'record', schema: recordSchemaOf(fields), fields, ast };
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
        ctx.diagnostics.push({ node: at ?? rec.ast, message: `unknown column '${name}' — available: ${[...rec.schema.keys()].join(', ')}` });
        return ERROR;
    }
    return col.expr ? mkExpr(col.expr, at) : mkExpr(colNode(name, col.table, col.type), at);
}

/**
 * The total read for `at`: the value at the key, or `none` if absent — never
 * errors on a missing key (that is what makes `at` a lens over maps, unlike
 * the partial field lens `ix`).
 */
function atRead(name: string, rec: Value, at: AstNode | undefined, ctx: Ctx): Value {
    if (rec.kind !== 'record') {
        ctx.diagnostics.push({ node: at ?? rec.ast, message: `cannot view key '${name}' on ${describe(rec)} — expected a record` });
        return ERROR;
    }
    if (rec.fields.length > 0) {
        const f = rec.fields.find(f => f.key === name);
        return f ? f.value : NONE;
    }
    const col = rec.schema.get(name);
    if (!col) return NONE;
    return col.expr ? mkExpr(col.expr, at) : mkExpr(colNode(name, col.table, col.type), at);
}

/**
 * The `over` half of `at`: apply `f` to the value at the key (or `none` if
 * absent). A `none` result *removes* the key; anything else replaces it, or
 * adds it when absent. On a row-shaped record this materializes every column,
 * so `mapped <<< at "name" .~ none` is a projection without `name`.
 */
function atOver(name: string, f: Value, rec: Value, at: AstNode | undefined, ctx: Ctx): Value {
    if (rec.kind === 'query') {
        const composed = composeOptic(mappedOptic(), atLens(name, at), at);
        if (composed.kind !== 'optic') return ERROR;
        return composed.over(f, rec, at, ctx);
    }
    if (rec.kind !== 'record') {
        ctx.diagnostics.push({ node: at ?? rec.ast, message: `cannot set key '${name}' on ${describe(rec)} — expected a record (or a query, which updates every row)` });
        return ERROR;
    }
    const focus = atRead(name, rec, at, ctx);
    if (isError(focus)) return ERROR;
    const updated = apply(f, focus, at, ctx);
    if (isError(updated)) return ERROR;
    if (updated.kind === 'none') {
        // remove the key
        if (rec.fields.length > 0) {
            return recordValue(rec.fields.filter(fld => fld.key !== name), rec.ast);
        }
        const fields: { key: string; value: Value }[] = [];
        for (const key of rec.schema.keys()) {
            if (key !== name) fields.push({ key, value: atRead(key, rec, at, ctx) });
        }
        return recordValue(fields, rec.ast);
    }
    if (rec.fields.length > 0) {
        const fields = rec.fields.some(fld => fld.key === name)
            ? rec.fields.map(fld => (fld.key === name ? { key: name, value: updated } : fld))
            : [...rec.fields, { key: name, value: updated }];
        return recordValue(fields, rec.ast);
    }
    // row-shaped record: materialize every column, adding the new key at the end
    const fields: { key: string; value: Value }[] = [];
    for (const key of rec.schema.keys()) {
        fields.push({ key, value: key === name ? updated : atRead(key, rec, at, ctx) });
    }
    if (!rec.schema.has(name)) fields.push({ key: name, value: updated });
    return recordValue(fields, rec.ast);
}

/** `at "key"` — the total map lens (lens's `at` for `Map`): view or `none`, set-to-`none` removes. */
function atLens(name: string, ast?: AstNode): Value {
    return mkOptic(
        `at "${name}"`,
        false,
        (s, at, ctx) => atRead(name, s, at, ctx),
        (f, s, at, ctx) => atOver(name, f, s, at, ctx),
        ast,
    );
}

/**
 * The `over` half of a field lens: apply `f` to the field's value and return a
 * new record. On a row-shaped record this materializes every column, so
 * `mapped <<< name %~ upper` becomes a projection over all fields.
 *
 * Applied to a *query*, a field lens lifts to the rows: `users & name %~ f`
 * is sugar for `users & mapped <<< name %~ f` (a lens update over a collection
 * applies to every element — exactly what the `mapped` traversal means).
 */
function overField(name: string, f: Value, rec: Value, at: AstNode | undefined, ctx: Ctx): Value {
    if (rec.kind === 'query') {
        const composed = composeOptic(mappedOptic(), fieldLens(name, at), at);
        if (composed.kind !== 'optic') return ERROR;
        return composed.over(f, rec, at, ctx);
    }
    if (rec.kind !== 'record') {
        ctx.diagnostics.push({
            node: at ?? rec.ast,
            message: `cannot set field '${name}' on ${describe(rec)} — expected a record (or a query, which updates every row)`,
        });
        return ERROR;
    }
    const focus = readField(name, rec, at, ctx);
    if (isError(focus)) return ERROR;
    const updated = apply(f, focus, at, ctx);
    if (isError(updated)) return ERROR;
    if (rec.fields.length > 0) {
        const fields = rec.fields.map(fld => (fld.key === name ? { key: name, value: updated } : fld));
        return recordValue(fields, rec.ast);
    }
    const fields: { key: string; value: Value }[] = [];
    for (const key of rec.schema.keys()) {
        fields.push({ key, value: key === name ? updated : readField(key, rec, at, ctx) });
    }
    return recordValue(fields, rec.ast);
}

/** The lens onto a record field: `field "name"` and the structural `r ^. name`. */
function fieldLens(name: string, ast?: AstNode): Value {
    return mkOptic(
        `field "${name}"`,
        false,
        (s, at, ctx) => readField(name, s, at, ctx),
        (f, s, at, ctx) => overField(name, f, s, at, ctx),
        ast,
    );
}

/** Compose two optics (`outer.inner`): the inner optic focuses inside the outer focus. */
function composeOptic(outer: Value, inner: Value, at: AstNode | undefined): Value {
    if (outer.kind !== 'optic' || inner.kind !== 'optic') {
        return ERROR;
    }
    return mkOptic(
        `${outer.name} <<< ${inner.name}`,
        outer.traversal || inner.traversal,
        (s, at2, ctx) => {
            const v = outer.read(s, at2, ctx);
            return isError(v) ? ERROR : inner.read(v, at2, ctx);
        },
        (f, s, at2, ctx) => outer.over(fn(`compose (${outer.name}.${inner.name})`, (h, at3, ctx3) => inner.over(f, h, at3, ctx3)), s, at2, ctx),
        at,
    );
}

/** Is the value applicable as a function (fn, lambda, or setter)? */
function isApplicable(v: Value): v is Extract<Value, { kind: 'fn' }> | Extract<Value, { kind: 'lambda' }> {
    return v.kind === 'fn' || v.kind === 'lambda';
}

/**
 * Evaluate a `<<<`/`>>>` operand: a bound identifier is its value (optic or
 * function), an unbound bare identifier is a field lens, everything else
 * evaluates normally.
 */
function evalComposeOperand(e: UnaryExpression | Expr, ctx: Ctx): Value {
    if (isUnaryMinus(e)) {
        ctx.diagnostics.push({ node: e, message: `expected an optic or function here, got an expression` });
        return ERROR;
    }
    if (isApplication(e) && e.arguments.length === 0 && isIdentifier(e.func)) {
        const v = ctx.env.get(e.func.name);
        if (v) return v;
        return fieldLens(e.func.name, e);
    }
    if (isAccessExpression(e)) {
        if (e.property === undefined) return evalComposeOperand(e.receiver, ctx);
        // `mapped <<< addr.city` — a dotted operand in composition position
        // routes through optic-path evaluation, so a receiver that is an optic
        // gets the "compose with <<<" hint instead of a confusing access error.
        return evalOpticPath(e, ctx);
    }
    return evalExpr(e, ctx);
}

/**
 * `l1 <<< l2` / `l1 >>> l2` — PureScript composition. Two optics compose as
 * optics; two functions compose point-free (`f <<< g` = `x => f (g x)`,
 * `f >>> g` = `x => g (f x)`).
 */
function composeValues(l: Value, r: Value, op: '>>>' | '<<<', at: AstNode, ctx: Ctx): Value {
    if (l.kind === 'optic' && r.kind === 'optic') {
        return op === '<<<' ? composeOptic(l, r, at) : composeOptic(r, l, at);
    }
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
    ctx.diagnostics.push({ node: at, message: `cannot compose ${describe(l)} with ${describe(r)} — both must be optics, or both functions` });
    return ERROR;
}

/** `view l s` — error if the optic is a traversal (no single focus). */
function viewOptic(lens: Value, s: Value, at: AstNode | undefined, ctx: Ctx): Value {
    if (lens.kind !== 'optic') {
        ctx.diagnostics.push({ node: at ?? lens.ast, message: `expected a lens after '^.', got ${describe(lens)}` });
        return ERROR;
    }
    if (lens.traversal) {
        ctx.diagnostics.push({ node: at ?? lens.ast, message: `${lens.name} is a traversal — view is undefined; use over (%~) or set (.~) instead` });
        return ERROR;
    }
    return lens.read(s, at, ctx);
}

/** `set l b s` — `over` with a constant transformer. */
function constValue(v: Value): Value {
    return { kind: 'fn', name: 'const', apply: () => v };
}

function setOptic(lens: Value, b: Value, s: Value, at: AstNode | undefined, ctx: Ctx): Value {
    if (lens.kind !== 'optic') {
        ctx.diagnostics.push({ node: at ?? lens.ast, message: `expected a lens, got ${describe(lens)}` });
        return ERROR;
    }
    return lens.over(constValue(b), s, at, ctx);
}

/**
 * `l %~ f` / `l .~ v` build a *setter*: a function that applies the lens to a
 * value. `users & mapped <<< name %~ upper` then flows through `&` (application).
 */
function mkSetter(name: string, lens: Value, transformer: Value): Value {
    return {
        kind: 'fn',
        name,
        apply: (s, at, ctx) => {
            if (lens.kind !== 'optic') {
                ctx.diagnostics.push({ node: at ?? lens.ast, message: `expected a lens, got ${describe(lens)}` });
                return ERROR;
            }
            return lens.over(transformer, s, at, ctx);
        },
        ast: lens.ast,
    };
}

/**
 * Evaluate the structural side of a lens operator: `u ^. age` / `age %~ f`.
 * A bare identifier is a field selector (a lens generated at the use site,
 * like `makeLenses` in Haskell); an access chain composes (`addr.city`,
 * `mapped <<< name`); anything else must evaluate to an optic value.
 */
function evalOpticPath(e: UnaryExpression | Expr, ctx: Ctx): Value {
    if (isUnaryMinus(e)) {
        ctx.diagnostics.push({ node: e, message: `expected a lens here, got an expression` });
        return ERROR;
    }
    if (isAccessExpression(e)) {
        const recv = evalOpticPath(e.receiver, ctx);
        if (isError(recv)) return ERROR;
        return e.property === undefined ? recv : access(recv, e.property, e, ctx);
    }
    if (isApplication(e) && e.arguments.length === 0 && isIdentifier(e.func)) {
        // A bare field selector: `age` in `u ^. age`, `addr` in `addr.city`.
        // A bound *optic* wins (so `mapped`, `nick = field "name"` work); any
        // other binding is ignored and the name resolves to the structural
        // field lens — mirroring access(): `u ^. upper` views the `upper`
        // column even though `upper` is a builtin, exactly like `u.upper`.
        const v = ctx.env.get(e.func.name);
        if (v && v.kind === 'optic') return v;
        return fieldLens(e.func.name, e);
    }
    const v = evalExpr(e, ctx);
    if (isError(v)) return ERROR;
    if (v.kind !== 'optic') {
        ctx.diagnostics.push({ node: e, message: `expected a lens here, got ${describe(v)}` });
        return ERROR;
    }
    return v;
}

/** Turn a row transformer (lambda or setter) into a `map` query step. */
function mapStepFromTransformer(q: Query, f: Value, at: AstNode | undefined, ctx: Ctx): Query | null {
    if (hasFoldStep(q)) {
        ctx.diagnostics.push({ node: at ?? f.ast, message: `cannot apply map after fold — nested aggregation is not supported (use fold's projection instead)` });
        return null;
    }
    const row = rowRecord(querySchema(q), at);
    const v = apply(f, row, at, ctx);
    if (isError(v)) return null;
    const proj = rowFromRecord(v, at, ctx, 'projection');
    if (!proj) return null;
    if (proj.fields.length === 0) {
        ctx.diagnostics.push({ node: at ?? f.ast, message: `map projection must contain at least one field` });
        return null;
    }
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
        if (ln.type !== 'bool' || rn.type !== 'bool') {
            ctx.diagnostics.push({ node: at, message: `'${op}' requires boolean operands, got ${typeName(ln.type)} and ${typeName(rn.type)}` });
            return ERROR;
        }
        const sqlOp = op === '&&' ? 'AND' : 'OR';
        return mkExpr({ kind: 'bin', op: sqlOp, left: ln, right: rn, type: 'bool' }, at);
    }

    if (op === '+' || op === '-' || op === '*' || op === '/' || op === '%') {
        if (!isNumeric(ln.type) || !isNumeric(rn.type)) {
            ctx.diagnostics.push({ node: at, message: `'${op}' requires numeric operands, got ${typeName(ln.type)} and ${typeName(rn.type)}` });
            return ERROR;
        }
        const t: SqlType = op === '/' || ln.type === 'float' || rn.type === 'float' ? 'float' : 'int';
        return mkExpr({ kind: 'bin', op, left: ln, right: rn, type: t }, at);
    }

    ctx.diagnostics.push({ node: at, message: `unknown operator '${op}'` });
    return ERROR;
}

function access(recv: Value, prop: string, at: AstNode, ctx: Ctx): Value {
    if (recv.kind === 'record') {
        // `u.name` ⇔ `u ^. name` — the record's field lens applied as a view.
        return readField(prop, recv, at, ctx);
    }
    if (recv.kind === 'optic') {
        // `.` is field access on records only — optic composition is written
        // explicitly with the PureScript operators, so `mapped.name` is an
        // error that points at `mapped <<< name` instead of silently meaning
        // something different from record field access.
        ctx.diagnostics.push({
            node: at,
            message: `cannot access field '${prop}' on ${describe(recv)} — optics compose with the <<< / >>> operators: (${recv.name}) <<< ${prop}`,
        });
        return ERROR;
    }
    if (recv.kind === 'query') {
        ctx.diagnostics.push({ node: at, message: `tables have no fields — access columns through a row parameter inside a lambda, e.g. map (u => u.${prop})` });
        return ERROR;
    }
    ctx.diagnostics.push({ node: at, message: `cannot access field '${prop}' on ${describe(recv)}` });
    return ERROR;
}

export function evalExpr(e: Expr, ctx: Ctx): Value {
    if (isBinaryExpression(e)) {
        if (e.operator === '&') {
            // pipeline: `left & right` ⇔ apply right to left
            const left = evalUnary(e.left, ctx);
            const right = evalUnary(e.right, ctx);
            return apply(right, left, e, ctx);
        }
        if (e.operator === '$') {
            // application: `left $ right` ⇔ apply left to right (right-assoc)
            const left = evalUnary(e.left, ctx);
            const right = evalUnary(e.right, ctx);
            return apply(left, right, e, ctx);
        }
        if (e.operator === '>>>' || e.operator === '<<<') {
            // PureScript composition: `<<<` = compose (LEFT is the outer focus,
            // like Haskell `.`); `>>>` is its flip. Optics compose with
            // composeOptic; functions compose point-free.
            const l = evalComposeOperand(e.left, ctx);
            if (isError(l)) return ERROR;
            const r = evalComposeOperand(e.right, ctx);
            if (isError(r)) return ERROR;
            return composeValues(l, r, e.operator, e, ctx);
        }
        if (e.operator === '^.') {
            // view: `s ^. l` ⇔ `view l s`
            const left = evalUnary(e.left, ctx);
            if (isError(left)) return ERROR;
            const lens = evalOpticPath(e.right, ctx);
            if (isError(lens)) return ERROR;
            return viewOptic(lens, left, e, ctx);
        }
        if (e.operator === '%~' || e.operator === '.~') {
            // over/set: `l %~ f` and `l .~ v` build a setter (a function s -> t)
            const lens = evalOpticPath(e.left, ctx);
            if (isError(lens)) return ERROR;
            if (lens.kind !== 'optic') return ERROR; // evalOpticPath guarantees an optic
            const right = evalUnary(e.right, ctx);
            if (isError(right)) return ERROR;
            if (e.operator === '%~' && right.kind !== 'fn' && right.kind !== 'lambda') {
                ctx.diagnostics.push({ node: e, message: `'%~' expects a function — to set a constant use '.~', to remove a key use at "key" .~ none` });
                return ERROR;
            }
            const transformer = e.operator === '%~' ? right : constValue(right);
            return mkSetter(`${e.operator === '%~' ? 'over' : 'set'} (${lens.name})`, lens, transformer);
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
        let f = evalExpr(e.func, ctx);
        for (const argExpr of e.arguments) {
            if (isError(f)) {
                evalExpr(argExpr, ctx); // keep collecting diagnostics
                continue;
            }
            const arg = evalExpr(argExpr, ctx);
            f = apply(f, arg, argExpr, ctx);
        }
        return f;
    }
    if (isNumberLiteral(e)) {
        const t: SqlType = Number.isInteger(e.value) ? 'int' : 'float';
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
        return { kind: 'lambda', params: lambdaParams(e), body: e.body, closure: new Map(ctx.env), ast: e };
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
    ctx.diagnostics.push({ node: e, message: 'unexpected expression' });
    return ERROR;
}

/** Evaluate a UnaryExpression (a BinaryExpression operand): unary minus or a plain expression. */
function evalUnary(u: UnaryExpression, ctx: Ctx): Value {
    if (isUnaryMinus(u)) {
        const v = evalUnary(u.operand, ctx);
        const node = exprNode(v);
        if (!node) return ERROR;
        if (node.type === 'null' || !isNumeric(node.type)) {
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
// Builtins
// ---------------------------------------------------------------------------

function fn(name: string, impl: (arg: Value, at: AstNode | undefined, ctx: Ctx) => Value): Value {
    return { kind: 'fn', name, apply: impl };
}

function step(name: string, impl: (q: Query, at: AstNode | undefined, ctx: Ctx) => Query | null): Value {
    return { kind: 'step', name, apply: impl };
}

function sqlType(type: SqlType): Value {
    return { kind: 'sql-type', type };
}

const JOIN_KINDS: Record<string, JoinKind> = {
    inner: 'inner', left: 'left', right: 'right', full: 'full',
};

const AGG_TYPES: Record<string, SqlType> = {
    count: 'int', sum: 'int', avg: 'float', min: 'int', max: 'int',
};

const BUILTINS: Record<string, () => Value> = {
    // --- types -----------------------------------------------------------
    int: () => sqlType('int'),
    float: () => sqlType('float'),
    string: () => sqlType('string'),
    bool: () => sqlType('bool'),
    date: () => sqlType('date'),
    timestamp: () => sqlType('timestamp'),

    // --- optics (the core abstraction) -----------------------------------
    // `field "name"` is a first-class lens onto a record field.
    field: () => fn('field', (arg, at, ctx) => {
        const name = stringValue(arg);
        if (name === null) {
            ctx.diagnostics.push({ node: at ?? arg.ast, message: `field expects a field name string, e.g. field "name"` });
            return ERROR;
        }
        return fieldLens(name, at ?? arg.ast);
    }),
    // The three fundamental operations (Haskell lens): view / over / set.
    // Functional form (arguments need parens — bare identifiers are not
    // application arguments): view (field "age") (u); the operators `^.`,
    // `%~`, `.~` are the ergonomic sugar.
    view: () => fn('view', (lens, at, ctx) => {
        if (lens.kind !== 'optic') {
            ctx.diagnostics.push({ node: at ?? lens.ast, message: `view expects a lens, e.g. view (field "age") (u), got ${describe(lens)}` });
            return ERROR;
        }
        return fn('view', (s, at2, ctx2) => viewOptic(lens, s, at2, ctx2));
    }),
    over: () => fn('over', (lens, at, ctx) => {
        if (lens.kind !== 'optic') {
            ctx.diagnostics.push({ node: at ?? lens.ast, message: `over expects a lens, got ${describe(lens)}` });
            return ERROR;
        }
        return fn('over', (f, at2, ctx2) => fn('over', (s, at3, ctx3) => {
            const t = lens.over(f, s, at3, ctx3);
            return isError(t) ? ERROR : t;
        }));
    }),
    set: () => fn('set', (lens, at, ctx) => {
        if (lens.kind !== 'optic') {
            ctx.diagnostics.push({ node: at ?? lens.ast, message: `set expects a lens, got ${describe(lens)}` });
            return ERROR;
        }
        return fn('set', (b, at2, ctx2) => fn('set', (s, at3, ctx3) => setOptic(lens, b, s, at3, ctx3)));
    }),
    // `mapped` is the traversal over a query's rows: `users & mapped <<< name %~ f`
    // transforms the `name` column of every row (a `map` step).
    mapped: () => mappedOptic(),

    // --- indexed optics (lens's `at`/`ix` for maps) ----------------------
    // A record field lens IS an indexed lens: the index is the field name.
    // `at "key"` is the fundamental map lens — TOTAL (the focus is the value
    // or `none`, never an error), so it can add (`at "k" .~ v`), remove
    // (`at "k" .~ none`) and rename keys. `ix "key"` is the partial traversal
    // over a present value (alias `field "key"`).
    at: () => fn('at', (arg, at, ctx) => {
        const name = stringValue(arg);
        if (name === null) {
            ctx.diagnostics.push({ node: at ?? arg.ast, message: `at expects a key string, e.g. at "name"` });
            return ERROR;
        }
        return atLens(name, at ?? arg.ast);
    }),
    ix: () => fn('ix', (arg, at, ctx) => {
        const name = stringValue(arg);
        if (name === null) {
            ctx.diagnostics.push({ node: at ?? arg.ast, message: `ix expects a field name string, e.g. ix "name"` });
            return ERROR;
        }
        return fieldLens(name, at ?? arg.ast);
    }),
    // `none` — absence (lens's `Nothing`), distinct from SQL `null`.
    none: () => NONE,

    // --- query roots -----------------------------------------------------
    table: () => fn('table', (arg1, at1, ctx) => {
        const name = stringValue(arg1);
        if (name === null) {
            ctx.diagnostics.push({ node: at1 ?? arg1.ast, message: `table expects a table name string, e.g. table "users" { ... }` });
            return ERROR;
        }
        return fn('table', (arg2, at2, ctx2) => {
            const schema = schemaFromMap(arg2, at2, ctx2);
            if (!schema) return ERROR;
            for (const col of schema.values()) col.table = name;
            return { kind: 'query', query: { root: { name, schema }, aliases: [name], steps: [], distinct: false }, ast: at2 };
        });
    }),

    // --- query steps (optics over rows) ---------------------------------
    // `filtered` is the lens-library selection optic: it keeps the rows that
    // satisfy a predicate. `filter` is kept as a synonym.
    filtered: filterBuiltin('filtered'),
    filter: filterBuiltin('filter'),

    map: () => fn('map', (sel, at, ctx) => {
        if (!isApplicable(sel) || (sel.kind === 'lambda' && sel.params.length !== 1)) {
            ctx.diagnostics.push({ node: at ?? sel.ast, message: `map expects a one-parameter projection lambda or function, e.g. map (u => { id = u.id }) — or use the mapped traversal: users & mapped %~ (u => { id = u.id })` });
            return ERROR;
        }
        return step('map', (q, at2, ctx2) => mapStepFromTransformer(q, sel, at2 ?? sel.ast, ctx2));
    }),

    sort: () => fn('sort', (sel, at, ctx) => {
        if (!isApplicable(sel) || (sel.kind === 'lambda' && sel.params.length !== 1)) {
            ctx.diagnostics.push({ node: at ?? sel.ast, message: `sort expects a one-parameter lambda or function, e.g. sort (u => [asc u.name]) or sort (asc <<< (^. name))` });
            return ERROR;
        }
        return step('sort', (q, at2, ctx2) => {
            const row = rowRecord(querySchema(q), at2);
            const v = sel.kind === 'lambda'
                ? evalExpr(sel.body, { env: lambdaEnv(sel, row), diagnostics: ctx2.diagnostics, moduleBindings: ctx.moduleBindings })
                : apply(sel, row, at2, ctx2);
            const items = orderItems(v, at2 ?? sel.ast, ctx2, hasFoldStep(q));
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

    fold: () => fn('fold', (sel, at, ctx) => {
        if (sel.kind !== 'lambda' || sel.params.length !== 1) {
            ctx.diagnostics.push({ node: at ?? sel.ast, message: `fold expects a one-parameter lambda, e.g. fold (o => { user_id = group o.user_id, total = sum o.total })` });
            return ERROR;
        }
        return step('fold', (q, at2, ctx2) => {
            if (hasFoldStep(q)) {
                ctx2.diagnostics.push({ node: at2 ?? sel.body, message: `only one fold per pipeline is supported` });
                return null;
            }
            const env = new Map(sel.closure);
            env.set(sel.params[0]!, rowRecord(querySchema(q), at2));
            const v = evalExpr(sel.body, { env, diagnostics: ctx2.diagnostics, moduleBindings: ctx.moduleBindings });
            if (v.kind !== 'record') {
                ctx2.diagnostics.push({ node: at2 ?? sel.body, message: `fold expects a projection record, got ${describe(v)}` });
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
                ctx2.diagnostics.push({ node: at2 ?? sel.body, message: `fold must contain at least one aggregate (count, sum, ...)` });
                return null;
            }
            return addStep(q, { kind: 'fold', proj: row });
        });
    }),

    join: () => fn('join', (right, at, ctx) => {
        // `join` takes THREE positional arguments: the right-hand query, the
        // two-parameter `on` lambda, and the join kind string:
        //   join orders (l, r) => l.id == r.user_id "inner"
        // The right side is a first-class query VALUE (any query — pipelines
        // render as subqueries), so joins compose like every other step.
        if (right.kind !== 'query') {
            ctx.diagnostics.push({ node: at ?? right.ast, message: `join expects a query as its first argument, got ${describe(right)} — bind a table or pipeline first, e.g. join orders (l, r) => ...` });
            return ERROR;
        }
        return fn('join', (on, at2, ctx2) => {
            if (on.kind !== 'lambda' || on.params.length !== 2) {
                ctx2.diagnostics.push({ node: at2 ?? on.ast, message: `join 'on' must be a two-parameter lambda, e.g. (l, r) => l.id == r.user_id, got ${describe(on)}` });
                return ERROR;
            }
            const onLambda = on;
            return fn('join', (kindArg, atKind, ctxKind) => {
                const kind = stringValue(kindArg);
                if (kind === null || !(kind in JOIN_KINDS)) {
                    ctxKind.diagnostics.push({ node: atKind ?? kindArg.ast, message: `join 'kind' must be "inner", "left", "right" or "full", got ${kind ?? describe(kindArg)}` });
                    return ERROR;
                }
                const joinKind = JOIN_KINDS[kind]!;
                return step('join', (q, at3, ctx3) => {
                    if (hasFoldStep(q)) {
                        ctx3.diagnostics.push({ node: at3 ?? onLambda?.ast, message: `cannot apply join after fold` });
                        return null;
                    }
                    // Assign a unique alias for the right-hand side (self-joins).
                    // The ON condition references the right side's OUTPUT columns by
                    // alias — a stepped right side renders as a subquery.
                    const rightName = right.query.root.name;
                    let alias = rightName;
                    let suffix = 1;
                    while (q.aliases.includes(alias)) {
                        alias = `${rightName}_${suffix++}`;
                    }
                    const rightSchema: Schema = new Map(
                        [...querySchema(right.query)].map(([key, col]) => [key, { type: col.type, table: alias }]),
                    );
                    const rightQuery: Query = {
                        ...right.query,
                        root: { name: rightName, schema: rightSchema },
                        aliases: [alias],
                    };
                    const leftSchema = querySchema(q);
                    for (const name of rightSchema.keys()) {
                        if (leftSchema.has(name)) {
                            ctx3.diagnostics.push({ node: at3 ?? onLambda?.ast, message: `join result has overlapping column '${name}' on both sides — rename one side first, e.g. map (u => { ... })` });
                            return null;
                        }
                    }
                    const env = new Map(onLambda.closure);
                    const p = onLambda.params;
                    env.set(p[0]!, rowRecord(leftSchema, at3));
                    env.set(p[1]!, rowRecord(rightSchema, at3));
                    const v = evalExpr(onLambda.body, { env, diagnostics: ctx3.diagnostics, moduleBindings: ctx.moduleBindings });
                    const node = exprNode(v);
                    if (!node || node.type !== 'bool') {
                        ctx3.diagnostics.push({ node: at3 ?? onLambda.body, message: `join 'on' condition must be a boolean expression, got ${node ? `type ${typeName(node.type)}` : describe(v)}` });
                        return null;
                    }
                    if (forbid(node, ['agg', 'group', 'order'], 'the join condition', at3 ?? onLambda.body, ctx3)) return null;
                    const next: Query = { ...q, aliases: [...q.aliases, alias] };
                    return addStep(next, { kind: 'join', joinKind, right: rightQuery, on: node });
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
        if (!node || node.type !== 'bool') {
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
        if (!node || !isNumeric(node.type)) {
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
};

/** The environment for a lambda applied to the row: closure plus the bound parameter. */
function lambdaEnv(l: Extract<Value, { kind: 'lambda' }>, row: Value): Map<string, Value> {
    const env = new Map(l.closure);
    env.set(l.params[0]!, row);
    return env;
}

function filterBuiltin(name: string): () => Value {
    return () => fn(name, (pred, at, ctx) => {
        if (!isApplicable(pred) || (pred.kind === 'lambda' && pred.params.length !== 1)) {
            ctx.diagnostics.push({ node: at ?? pred.ast, message: `${name} expects a one-parameter predicate lambda or function, e.g. ${name} (u => u.age >= 18) or ${name} ((>= 18) <<< (^. age))` });
            return ERROR;
        }
        return step(name, (q, at2, ctx2) => {
            const having = hasFoldStep(q);
            const row = rowRecord(querySchema(q), at2);
            const v = pred.kind === 'lambda'
                ? evalExpr(pred.body, { env: lambdaEnv(pred, row), diagnostics: ctx2.diagnostics, moduleBindings: ctx.moduleBindings })
                : apply(pred, row, at2, ctx2);
            const node = exprNode(v);
            if (!node || node.type !== 'bool') {
                ctx2.diagnostics.push({ node: at2 ?? pred.ast, message: `${name} predicate must be a boolean expression, got ${node ? `type ${typeName(node.type)}` : describe(v)}` });
                return null;
            }
            // After fold the predicate becomes HAVING, where aggregates are allowed.
            const forbidden: SqlNode['kind'][] = having ? ['order'] : ['agg', 'group', 'order'];
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
        if (numeric === 'numeric' && !isNumeric(node.type)) {
            ctx.diagnostics.push({ node: at ?? arg.ast, message: `${name} expects a numeric expression, got type ${typeName(node.type)}` });
            return ERROR;
        }
        let type: SqlType = node.type as SqlType;
        if (name === 'count') type = 'int';
        if (name === 'avg') type = 'float';
        return mkExpr({ kind: 'agg', name, arg: node, type }, at);
    });
}

function stringFnBuiltin(name: string, result: SqlType): () => Value {
    return () => fn(name, (arg, at, ctx) => {
        const node = exprNode(arg);
        if (!node || node.type !== 'string') {
            ctx.diagnostics.push({ node: at ?? arg.ast, message: `${name} expects a string expression, got ${node ? `type ${typeName(node.type)}` : describe(arg)}` });
            return ERROR;
        }
        if (forbid(node, ['agg', 'group', 'order'], `${name}`, at ?? arg.ast, ctx)) return ERROR;
        return mkExpr({ kind: 'call', name, args: [node], type: result }, at);
    });
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

function schemaFromMap(v: Value, at: AstNode | undefined, ctx: Ctx): Schema | null {
    if (v.kind !== 'record') {
        ctx.diagnostics.push({ node: at ?? v.ast, message: `expected a schema record like { id = int, name = string }, got ${describe(v)}` });
        return null;
    }
    const schema: Schema = new Map();
    for (const { key, value } of v.fields) {
        if (value.kind !== 'sql-type') {
            ctx.diagnostics.push({ node: value.ast ?? at, message: `schema entry '${key}' must be a type (int, string, bool, float, date, timestamp), got ${describe(value)}` });
            continue;
        }
        schema.set(key, { type: value.type, table: null });
    }
    return schema;
}

function rowFromRecord(v: Value, at: AstNode | undefined, ctx: Ctx, what: string): RowNode | null {
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
        if (node.kind === 'agg' || node.kind === 'group' || node.kind === 'order') {
            ctx.diagnostics.push({ node: value.ast ?? at, message: `${what} entry '${key}' cannot contain ${kindLabel(node.kind)}` });
            continue;
        }
        row.fields.push({ key, node });
    }
    return row;
}

function orderItems(v: Value, at: AstNode | undefined, ctx: Ctx, afterFold: boolean): { node: SqlNode; dir: 'ASC' | 'DESC' }[] | null {
    const collect = (value: Value, out: { node: SqlNode; dir: 'ASC' | 'DESC' }[]): boolean => {
        const node = exprNode(value);
        if (!node || node.kind !== 'order') {
            ctx.diagnostics.push({ node: value.ast ?? at, message: `sort expects order items like asc u.name or a list of them, got ${node ? `an expression of type ${typeName(node.type)}` : describe(value)}` });
            return false;
        }
        // After fold, ordering by a group key or aggregate is allowed (ORDER BY SUM(...)).
        const forbidden: SqlNode['kind'][] = afterFold ? [] : ['agg', 'group', 'order'];
        if (forbid(node.expr, forbidden, 'sort', value.ast ?? at, ctx)) return false;
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
 * module last). All bindings share one environment seeded with the builtin
 * prelude; the ROOT module's last binding is the project's query.
 */
export function analyzeProject(modules: Model[], options: ProjectAnalysisOptions = {}): AnalysisResult {
    const { requireQuery = true } = options;
    const diagnostics: Diagnostic[] = [];
    // The environment starts with the prelude of builtins (table, filter, ...).
    // User bindings may shadow them.
    const env = new Map<string, Value>();
    for (const [name, factory] of Object.entries(BUILTINS)) {
        env.set(name, factory());
    }
    const moduleBindings = new Set<string>();
    for (const m of modules) {
        for (const b of m.bindings) moduleBindings.add(b.name);
    }
    const ctx: Ctx = { env, diagnostics, moduleBindings };

    let value: Value = ERROR;
    for (const model of modules) {
        const seen = new Set<string>();
        for (const binding of model.bindings) {
            value = checkBinding(binding, ctx, seen);
        }
    }

    const root = modules[modules.length - 1];
    if (requireQuery && root) {
        const last = root.bindings[root.bindings.length - 1];
        if (!last) {
            value = ERROR;
            diagnostics.push({
                node: root,
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

/** Evaluate a single module (no imports). */
export function analyze(model: Model): AnalysisResult {
    return analyzeProject([model]);
}

function checkBinding(binding: Binding, ctx: Ctx, seen: Set<string>): Value {
    if (seen.has(binding.name)) {
        ctx.diagnostics.push({ node: binding, message: `duplicate binding name '${binding.name}'` });
    }
    seen.add(binding.name);
    const v = evalExpr(binding.value, ctx);
    ctx.env.set(binding.name, v);
    return v;
}

// re-export for the validator
export { ERROR };
