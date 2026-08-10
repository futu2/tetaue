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
    | { kind: 'row'; schema: Schema; ast?: AstNode }
    | { kind: 'expr'; node: SqlNode; ast?: AstNode }
    | { kind: 'list'; items: Value[]; ast?: AstNode }
    | { kind: 'map'; entries: { key: string; value: Value }[]; ast?: AstNode }
    | { kind: 'sql-type'; type: SqlType; ast?: AstNode }
    | { kind: 'error'; ast?: AstNode };

export interface Ctx {
    env: Map<string, Value>;
    diagnostics: Diagnostic[];
    /** Names bound anywhere in the module (for forward-reference hints). */
    moduleBindings: Set<string>;
}

const ERROR: Value = { kind: 'error' };

export function isError(v: Value): boolean {
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
        case 'row': return 'a row';
        case 'expr': return `an expression of type ${typeName(v.node.type)}`;
        case 'list': return 'a list';
        case 'map': return 'a map';
        case 'sql-type': return `type ${v.type}`;
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
        default:
            ctx.diagnostics.push({ node: at ?? fallbackNode(ctx), message: `cannot apply ${describe(f)}` });
            return ERROR;
    }
}

function astOf(v: Value): AstNode | undefined {
    return 'ast' in v ? v.ast : undefined;
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
    if (recv.kind === 'row') {
        const col = recv.schema.get(prop);
        if (!col) {
            ctx.diagnostics.push({ node: at, message: `unknown column '${prop}' — available: ${[...recv.schema.keys()].join(', ')}` });
            return ERROR;
        }
        // Derived columns (from map/fold projections) are inlined: the
        // defining expression is substituted, so later steps reference the
        // real expression instead of a SELECT alias.
        if (col.expr) {
            return mkExpr(col.expr, at);
        }
        return mkExpr(colNode(prop, col.table, col.type), at);
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
        const entries: { key: string; value: Value }[] = [];
        const seen = new Set<string>();
        for (const entry of e.entries) {
            if (seen.has(entry.key)) {
                ctx.diagnostics.push({ node: entry, message: `duplicate map key '${entry.key}'` });
            }
            seen.add(entry.key);
            entries.push({ key: entry.key, value: evalExpr(entry.value, ctx) });
        }
        return { kind: 'map', entries, ast: e };
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

    // --- query steps -----------------------------------------------------
    filter: () => fn('filter', (pred, at, ctx) => {
        if (pred.kind !== 'lambda' || pred.params.length !== 1) {
            ctx.diagnostics.push({ node: at ?? pred.ast, message: `filter expects a one-parameter predicate lambda, e.g. filter (u => u.age >= 18)` });
            return ERROR;
        }
        return step('filter', (q, at2, ctx2) => {
            const having = hasFoldStep(q);
            const env = new Map(pred.closure);
            env.set(pred.params[0]!, { kind: 'row', schema: querySchema(q) });
            const v = evalExpr(pred.body, { env, diagnostics: ctx2.diagnostics, moduleBindings: ctx.moduleBindings });
            const node = exprNode(v);
            if (!node || node.type !== 'bool') {
                ctx2.diagnostics.push({ node: at2 ?? pred.body, message: `filter predicate must be a boolean expression, got ${node ? `type ${typeName(node.type)}` : describe(v)}` });
                return null;
            }
            // After fold the predicate becomes HAVING, where aggregates are allowed.
            const forbidden: SqlNode['kind'][] = having ? ['order'] : ['agg', 'group', 'order'];
            if (forbid(node, forbidden, 'the filter predicate', at2 ?? pred.body, ctx2)) return null;
            return addStep(q, { kind: 'filter', cond: node, having });
        });
    }),

    map: () => fn('map', (sel, at, ctx) => {
        if (sel.kind !== 'lambda' || sel.params.length !== 1) {
            ctx.diagnostics.push({ node: at ?? sel.ast, message: `map expects a one-parameter projection lambda, e.g. map (u => { id = u.id })` });
            return ERROR;
        }
        return step('map', (q, at2, ctx2) => {
            if (hasFoldStep(q)) {
                ctx2.diagnostics.push({ node: at2 ?? sel.body, message: `cannot apply map after fold — nested aggregation is not supported (use fold's projection instead)` });
                return null;
            }
            const env = new Map(sel.closure);
            env.set(sel.params[0]!, { kind: 'row', schema: querySchema(q) });
            const v = evalExpr(sel.body, { env, diagnostics: ctx2.diagnostics, moduleBindings: ctx.moduleBindings });
            const row = rowFromMap(v, at2 ?? sel.body, ctx2, 'projection');
            if (!row) return null;
            if (row.fields.length === 0) {
                ctx2.diagnostics.push({ node: at2 ?? sel.body, message: `map projection must contain at least one field` });
                return null;
            }
            return addStep(q, { kind: 'map', proj: row });
        });
    }),

    sort: () => fn('sort', (sel, at, ctx) => {
        if (sel.kind !== 'lambda' || sel.params.length !== 1) {
            ctx.diagnostics.push({ node: at ?? sel.ast, message: `sort expects a one-parameter lambda, e.g. sort (u => [asc u.name])` });
            return ERROR;
        }
        return step('sort', (q, at2, ctx2) => {
            const env = new Map(sel.closure);
            env.set(sel.params[0]!, { kind: 'row', schema: querySchema(q) });
            const v = evalExpr(sel.body, { env, diagnostics: ctx2.diagnostics, moduleBindings: ctx.moduleBindings });
            const items = orderItems(v, at2 ?? sel.body, ctx2, hasFoldStep(q));
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
            env.set(sel.params[0]!, { kind: 'row', schema: querySchema(q) });
            const v = evalExpr(sel.body, { env, diagnostics: ctx2.diagnostics, moduleBindings: ctx.moduleBindings });
            if (v.kind !== 'map') {
                ctx2.diagnostics.push({ node: at2 ?? sel.body, message: `fold expects a projection map, got ${describe(v)}` });
                return null;
            }
            const row: RowNode = { fields: [] };
            let aggregates = 0;
            for (const { key, value } of v.entries) {
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

    join: () => fn('join', (arg, at, ctx) => {
        const name = stringValue(arg);
        if (name === null) {
            ctx.diagnostics.push({ node: at ?? arg.ast, message: `join expects a table name string, e.g. join "orders" { on = (u, o) => u.id == o.user_id }` });
            return ERROR;
        }
        const right = ctx.env.get(name);
        if (!right) {
            const hint = ctx.moduleBindings.has(name) ? ' — bindings must be defined before the join' : '';
            ctx.diagnostics.push({ node: at ?? arg.ast, message: `unknown table '${name}'${hint}` });
            return ERROR;
        }
        if (right.kind !== 'query') {
            ctx.diagnostics.push({ node: at ?? arg.ast, message: `'${name}' is ${describe(right)}, not a query — join expects a table defined earlier in the module` });
            return ERROR;
        }
        if (right.query.steps.length > 0 || right.query.distinct) {
            ctx.diagnostics.push({ node: at ?? arg.ast, message: `the right side of join must be a plain table (no steps yet)` });
            return ERROR;
        }
        return fn('join', (spec, at2, ctx2) => {
            if (spec.kind !== 'map') {
                ctx2.diagnostics.push({ node: at2 ?? spec.ast, message: `join expects a spec map { on = (l, r) => ..., kind = "inner" }` });
                return ERROR;
            }
            let onLambda: Value | null = null;
            let joinKind: JoinKind = 'inner';
            for (const { key, value } of spec.entries) {
                if (key === 'on') {
                    if (value.kind !== 'lambda' || value.params.length !== 2) {
                        ctx2.diagnostics.push({ node: value.ast ?? at2, message: `join 'on' must be a two-parameter lambda, e.g. (l, r) => l.id == r.user_id` });
                        return ERROR;
                    }
                    onLambda = value;
                } else if (key === 'kind') {
                    const kind = stringValue(value);
                    if (kind === null || !(kind in JOIN_KINDS)) {
                        ctx2.diagnostics.push({ node: value.ast ?? at2, message: `join 'kind' must be "inner", "left", "right" or "full", got ${kind ?? describe(value)}` });
                        return ERROR;
                    }
                    joinKind = JOIN_KINDS[kind]!;
                } else {
                    ctx2.diagnostics.push({ node: value.ast ?? at2, message: `unknown join spec key '${key}' — expected 'on' and 'kind'` });
                    return ERROR;
                }
            }
            if (!onLambda) {
                ctx2.diagnostics.push({ node: at2 ?? spec.ast, message: `join spec is missing the 'on' condition` });
                return ERROR;
            }
            return step('join', (q, at3, ctx3) => {
                if (hasFoldStep(q)) {
                    ctx3.diagnostics.push({ node: at3 ?? onLambda?.ast, message: `cannot apply join after fold` });
                    return null;
                }
                // Assign a unique alias for the right-hand table (self-joins).
                const rightName = right.query.root.name;
                let alias = rightName;
                let suffix = 1;
                while (q.aliases.includes(alias)) {
                    alias = `${rightName}_${suffix++}`;
                }
                const rightSchema: Schema = new Map(
                    [...right.query.root.schema].map(([key, col]) => [key, { ...col, table: alias }]),
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
                env.set(p[0]!, { kind: 'row', schema: leftSchema });
                env.set(p[1]!, { kind: 'row', schema: rightSchema });
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
    if (v.kind !== 'map') {
        ctx.diagnostics.push({ node: at ?? v.ast, message: `expected a schema map like { id = int, name = string }, got ${describe(v)}` });
        return null;
    }
    const schema: Schema = new Map();
    for (const { key, value } of v.entries) {
        if (value.kind !== 'sql-type') {
            ctx.diagnostics.push({ node: value.ast ?? at, message: `schema entry '${key}' must be a type (int, string, bool, float, date, timestamp), got ${describe(value)}` });
            continue;
        }
        schema.set(key, { type: value.type, table: null });
    }
    return schema;
}

function rowFromMap(v: Value, at: AstNode, ctx: Ctx, what: string): RowNode | null {
    if (v.kind !== 'map') {
        ctx.diagnostics.push({ node: at, message: `${what} must be a map like { key = expr, ... }, got ${describe(v)}` });
        return null;
    }
    const row: RowNode = { fields: [] };
    for (const { key, value } of v.entries) {
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

function orderItems(v: Value, at: AstNode, ctx: Ctx, afterFold: boolean): { node: SqlNode; dir: 'ASC' | 'DESC' }[] | null {
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
