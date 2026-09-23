/******************************************************************************
 * tetaue interpreter — symbolic evaluation of a tetaue module.
 *
 * Evaluation is "symbolic": expressions over query rows become SQL expression
 * trees (SqlNode), and query pipelines become a logical Query plan. The same
 * evaluator powers both the Langium validator (collecting diagnostics) and
 * the CLI renderer (producing a Query value to render to SQL).
 ******************************************************************************/
import type { AstNode } from 'langium';
import { lower } from '../hir/lower.js';
import type { Hir } from '../hir/hir.js';
import type { NumberLiteral } from './generated/ast.js';
import {
    isAccessExpression, isApplication, isAscription, isBinaryExpression, isBooleanLiteral,
    isCaseExpression, isIdentifier, isLambda, isLetExpression, isListLiteral,
    isFunType, isListType, isMapLiteral,
    isNullLiteral, isNumberLiteral, isOperatorSection, isQueryType, isRecordType, isStringLiteral,
    isTypeAtom, isTypeHole, isTypeParen, isTypeVar, isUnaryMinus,
    type Application, type Binding, type CaseExpression, type Expr, type Lambda, type MapEntry, type Model, type QueryType, type UnaryExpression,
} from './generated/ast.js';
import type { ProjectModule, ResolvedExportEdge, ResolvedImportEdge } from './imports.js';
import { resolveImportScope } from './project-scope.js';
import { implicitParamName, labelName, parseStringLiteral } from './strings.js';
export { parseStringLiteral };
// Binding order + shared diagnostic wording live in an evaluator-free module so
// the inferencer can use them without importing the interpreter (stage 3).
import {
    missingBindingExpressionMessage, recursiveBindingMessage, topoOrderBindings,
    type Diagnostic, type DialectView,
} from './binding-analysis.js';
export { missingBindingExpressionMessage, recursiveBindingMessage, topoOrderBindings };
export type { Diagnostic, DialectView };
import { BUILTIN_ALIASES, BUILTIN_SPECS, CAST_TYPES, LIST_ARITY, type BuiltinName } from './builtin.js';
import { CORE_NAMESPACE, PRELUDE_NAMESPACES } from './prelude-namespaces.js';
import { baseClosureFor } from './prelude.js';
import { TypeUniverse } from './types.js';
import type { Type } from './types.js';
import {
    INTRINSIC_OPERATORS, isBinaryOperator, isIntrinsicOperator, isOperatorIntrinsicName,
    operatorIntrinsicName, sectionName, sectionSpelling, type BinaryOperator, type IntrinsicOperator,
} from './operators.js';

// ---------------------------------------------------------------------------
// SQL IR — moved to core/ir.ts (stage 1 of docs/design/architecture.md).
// Re-exported here so every existing import site keeps working unchanged;
// the definitions live in core/ir.ts, which depends on nothing but Langium's
// AstNode (no Value, no Ctx), so back ends can import it without a cycle.
// ---------------------------------------------------------------------------
export type {
    JoinKind, Query, QueryStep, RowNode, Schema, SetOp, SqlColumn, SqlNode, SqlNodeBase, SqlType, TypeOrNull,
} from '../core/ir.js';
import type {
    JoinKind, Query, QueryStep, RowNode, Schema, SetOp, SqlColumn, SqlNode, SqlNodeBase, SqlType, TypeOrNull,
} from '../core/ir.js';

// ---------------------------------------------------------------------------
// Interpreter values
// ---------------------------------------------------------------------------


export type Value =
    | { kind: 'query'; query: Query; ast?: AstNode }
    | { kind: 'fn'; name: string; apply: (arg: Value, at: AstNode | undefined, ctx: Ctx) => Value; ast?: AstNode;
        /** Declared first-parameter SQL type, for overload selection. */
        paramType?: TypeOrNull }
    | { kind: 'step'; name: string; apply: (q: Query, at: AstNode | undefined, ctx: Ctx) => Query | null; ast?: AstNode }
    | { kind: 'lambda'; params: string[]; body: Hir; closure: Map<string, Value>; ast?: AstNode;
        /** Declared first-parameter SQL type (`(x: float) => ...`), for overload selection. */
        paramType?: TypeOrNull }
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
    /**
     * The monoid identity (`mempty`). Its SQL value depends on the instance,
     * which only the use site knows: a `<>` operand, an ascription, a
     * list-argument builtin, or a row/record context resolves it. Unresolved,
     * it renders as the string identity `''` (the concrete default).
     */
    | { kind: 'mempty'; ast?: AstNode }
    | { kind: 'error'; ast?: AstNode }
    /**
     * An imported module namespace (`import "x.tetaue" as t`). Qualified
     * access `t.binding` reads the module's EXPORTED bindings. Values are
     * already evaluated and shared by reference; polymorphism is only a
     * type-level concern (handled by inference).
     */
    | { kind: 'module'; name: string; exports: Map<string, Value>; ast?: AstNode }
    /**
     * One name bound to several definitions (`abs` given once per numeric
     * type). Applying it picks the FIRST alternative whose SQL argument types
     * the actual arguments satisfy, mirroring the static overload choice. The
     * alternatives are ordinary functions in declaration order.
     */
    | { kind: 'overload'; name: string; alternatives: Value[]; ast?: AstNode };

export interface Ctx {
    env: Map<string, Value>;
    diagnostics: Diagnostic[];
    /** Names bound anywhere in the module (for forward-reference hints). */
    moduleBindings: Set<string>;
    /** When evaluating a fold projection, CASE branches may wrap aggregates. */
    allowAggregatesInCase?: boolean;
    /** Optional best-effort record of the runtime Value produced per AST node. */
    nodeValues?: Map<AstNode, Value>;
}

/** The public, pure evaluation result: diagnostics are returned, never hidden. */
export type EvalResult<T> =
    | { ok: true; value: T; diagnostics: Diagnostic[] }
    | { ok: false; diagnostics: Diagnostic[] };

const EMPTY_BINDINGS: ReadonlySet<string> = new Set();

const ERROR: Value = { kind: 'error' };

export function isError(v: Value): v is { kind: 'error'; ast?: AstNode } {
    return v.kind === 'error';
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TYPE_NAMES: Record<TypeOrNull, string> = {
    int: 'int', float: 'float', decimal: 'decimal', string: 'string', bool: 'bool',
    date: 'date', timestamp: 'timestamp', array: 'array', null: 'null', unknown: 'unknown',
};

export function typeName(t: TypeOrNull): string {
    return TYPE_NAMES[t] ?? String(t);
}

export function isNumeric(t: TypeOrNull): boolean {
    return t === 'int' || t === 'float' || t === 'decimal';
}

/**
 * A numeric literal (`2`, `2.0`) is polymorphic — see inference. For `/`
 * (fractional division) an integer literal adapts to float, so it is an
 * acceptable operand even though its runtime SqlType is `int`; genuine int
 * columns still require `div`.
 */
function isLiteralNum(node: SqlNode): boolean {
    return node.kind === 'lit' && isNumeric(node.type);
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
        case 'record': return 'a record';
        case 'expr': return `an expression of type ${typeName(v.node.type)}`;
        case 'list': return 'a list';
        case 'module': return `module '${v.name}'`;
        case 'overload': return `an overloaded function (${v.name})`;

        case 'error': return 'an error';
        case 'mempty': return 'the monoid identity (mempty)';
    }
}

export function exprNode(v: Value): SqlNode | null {
    return v.kind === 'expr' ? v.node : null;
}

function mkExpr(node: SqlNode, ast?: AstNode): Value {
    const tagged: SqlNode = ast ? { ...node, ast } : node;
    return { kind: 'expr', node: tagged, ast };
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

/**
 * The number of holes in a `sql_fragment` template. A hole is `{}` (rendered
 * argument) or `{:}` (the same, but bare — the SQL word of a string without
 * quoting). `{{`/`}}` are escaped literal braces and do not open a hole,
 * matching the format-string escape used elsewhere in the language, so
 * `"a {{}} b {}"` has exactly one hole.
 */
function fragmentHoles(template: string): number {
    let holes = 0;
    for (let i = 0; i < template.length; i++) {
        if (template[i] !== '{') continue;
        if (template[i + 1] === '{') { i++; continue; }  // `{{` — a literal brace
        if (template[i + 1] === '}') { holes++; i++; continue; }
        if (template[i + 1] === ':' && template[i + 2] === '}') { holes++; i += 2; }
    }
    return holes;
}

/**
 * The string a rename key-rule result denotes, constant-folding literal
 * `concat` chains (`"user_" <> k` with k a string literal folds to
 * "user_id"). A column NAME is a compile-time string — a rule that still
 * contains a non-literal SQL expression cannot name a column, so its caller
 * diagnoses it.
 */
function foldableStringValue(v: Value): string | null {
    const direct = stringValue(v);
    if (direct !== null) return direct;
    const node = exprNode(v);
    if (node?.kind !== 'call' || node.name !== 'concat') return null;
    let out = '';
    for (const arg of node.args) {
        if (arg.kind !== 'lit' || typeof arg.value !== 'string') return null;
        out += arg.value;
    }
    return out;
}

/** Evaluate a list-of-strings argument (`pick ["id", "name"]`), or diagnose. */
function stringListValue(v: Value, at: AstNode | undefined, ctx: Ctx, what: string): { name: string; node?: AstNode }[] | null {
    if (v.kind !== 'list') {
        ctx.diagnostics.push({ node: at ?? v.ast, message: `${what} expects a list of field-name strings, e.g. ${what} ["id", "name"]` });
        return null;
    }
    const names: { name: string; node?: AstNode }[] = [];
    for (const item of v.items) {
        const name = stringValue(item);
        if (name === null) {
            ctx.diagnostics.push({ node: item.ast ?? at, message: `${what} entries must be string literals, got ${describe(item)}` });
            return null;
        }
        names.push({ name, node: item.ast });
    }
    return names;
}

function numberValue(v: Value): number | null {
    const node = exprNode(v);
    if (node?.kind === 'lit' && typeof node.value === 'number') return node.value;
    return null;
}

/** Whether a predicate result means "keep": a literal true, or a truthy SQL node. */
function truthyValue(v: Value): boolean {
    const node = exprNode(v);
    if (!node) return false;
    if (node.kind === 'lit') return node.value === true;
    // A non-literal boolean expression (e.g. `x > 0` over SQL columns) is
    // treated as a predicate that holds.
    return true;
}

/**
 * Fold a numeric list with `+`/`*` over its elements. Elements that are
 * numeric literals are added into a constant accumulator; a non-literal SQL
 * expression element folds into a `bin` expression chain via evalBinary.
 */
function listNumericFold(op: '+' | '*', start: number, type: SqlType, xs: { kind: 'list'; items: Value[]; ast?: AstNode }, at: AstNode | undefined, ctx: Ctx): Value {
    let acc = mkExpr(lit(start, type), at ?? xs.ast);
    for (const item of xs.items) {
        const n = numberValue(item);
        if (n !== null) {
            const cur = numberValue(acc);
            if (cur !== null) {
                acc = mkExpr(lit(op === '+' ? cur + n : cur * n, type), at ?? item.ast ?? xs.ast);
                continue;
            }
        }
        const next = evalBinary(op, acc, item, at ?? item.ast ?? xs.ast ?? fallbackNode(ctx), ctx);
        if (isError(next)) return ERROR;
        acc = next;
    }
    return acc;
}

/** SQL three-valued logic predicates; all return a non-null boolean. */
function truthPredicateBuiltin(name: 'isTrue' | 'isFalse' | 'isUnknown'): () => Value {
    return () => fn(name, (arg, at, ctx) => {
        const node = exprNode(arg);
        if (!node || (node.type !== 'bool' && node.type !== 'null' && node.type !== 'unknown')) {
            ctx.diagnostics.push({ node: at ?? arg.ast, message: `${name} expects a boolean or nullable boolean expression, got ${node ? `type ${typeName(node.type)}` : describe(arg)}` });
            return ERROR;
        }
        if (forbid(node, ['agg', 'group', 'order'], name, at ?? arg.ast, ctx)) return ERROR;
        return mkExpr({ kind: 'call', name, args: [node], type: 'bool' }, at);
    });
}


/** Nearest lambda whose body encloses `node`, for field-punning sugar. */
function enclosingLambdaParamName(node: import('./generated/ast.js').MapEntry): string | null {
    let cur: AstNode | undefined = node;
    while (cur) {
        const parent: AstNode | undefined = cur.$container;
        if (parent && isLambda(parent) && (parent.body as unknown as AstNode) === cur) {
            return lambdaParam(parent);
        }
        cur = parent;
    }
    return null;
}

function lambdaParam(l: Lambda): string {
    return l.param?.name ?? '';
}

/** Walk a SqlNode tree; call `visit` for every node. */
function forEachNode(node: SqlNode, visit: (n: SqlNode) => void): void {
    visit(node);
    switch (node.kind) {
        case 'col': case 'bare': case 'lit':
        case 'current-date': case 'current-timestamp':
        case 'date-literal': case 'timestamp-literal': break;
        case 'bin': forEachNode(node.left, visit); forEachNode(node.right, visit); break;
        case 'is-null': case 'not': case 'group': case 'order':
            forEachNode(node.expr, visit); break;
        case 'agg':
            forEachNode(node.arg, visit);
            if (node.filter) forEachNode(node.filter, visit);
            break;
        case 'call': node.args.forEach(a => forEachNode(a, visit)); break;
        case 'fragment': node.args.forEach(a => forEachNode(a, visit)); break;
        case 'window':
            forEachNode(node.fn, visit);
            node.partition.forEach(p => forEachNode(p, visit));
            node.order.forEach(o => forEachNode(o.node, visit));
            break;
        case 'in': forEachNode(node.expr, visit); node.list.forEach(a => forEachNode(a, visit)); break;
        case 'exists': case 'scalar': case 'in-query': break; // subquery nodes are validated at render time
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

// Schema derivation (`rowNodeSchema`, `querySchema`, `nodeTable`) lives in
// `core/ir.ts` — pure IR -> Schema functions the renderer needs but that must
// not require the evaluator. Imported for the evaluator's own use below, and
// re-exported so existing importers keep working.
import { nodeTable, querySchema, rowNodeSchema } from '../core/ir.js';
export { querySchema, rowNodeSchema };

function addStep(q: Query, step: QueryStep, at?: AstNode): Query {
    // A projection (map/fold/join-merger) defines the complete schema;
    // other steps preserve it.
    let known = q.known;
    if (step.kind === 'map' || step.kind === 'fold' || step.kind === 'join') known = true;
    const tagged = at ? { ...step, ast: at } : step;
    return { ...q, known, steps: [...q.steps, tagged] };
}

function hasFoldStep(q: Query): boolean {
    return q.steps.some(s => s.kind === 'fold');
}

function hasTakeStep(q: Query): boolean {
    return q.steps.some(s => s.kind === 'take');
}

function hasDropStep(q: Query): boolean {
    return q.steps.some(s => s.kind === 'drop');
}

function hasSetStep(q: Query): boolean {
    return q.steps.some(s => s.kind === 'set');
}

/** True when the query's last projection contains a window function. */
function hasWindowProjection(q: Query): boolean {
    for (let i = q.steps.length - 1; i >= 0; i--) {
        const step = q.steps[i]!;
        if (step.kind !== 'map' && step.kind !== 'fold' && step.kind !== 'join') continue;
        for (const field of step.proj.fields) {
            let found = false;
            forEachNode(field.node, n => { if (n.kind === 'window') found = true; });
            if (found) return true;
        }
        return false;
    }
    return false;
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
 *     r = q & joinInner users ...
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
    const schema = new Map<string, SqlColumn>();
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

/**
 * Make a query ready for the next pipeline step without changing observable
 * semantics. Relational steps commute with many clauses, but LIMIT, DISTINCT
 * and window projections do not. When a later step needs the row set produced
 * by one of those operations, wrap everything so far as a derived table.
 * `take` after `take` is kept flat so the take builtin can fold the two
 * limits together (LIMIT n then LIMIT m is LIMIT (min n m)).
 */
function prepareQueryForStep(q: Query, stepName: string): Query {
    const hasTake = hasTakeStep(q);
    const hasDrop = hasDropStep(q);
    const needsBoundary = q.distinct
        || hasWindowProjection(q)
        || hasSetStep(q)
        || (stepName === 'take'
            ? false // drop-then-take renders as LIMIT n OFFSET m in one scope
            : stepName === 'drop'
                ? hasTake // take-then-drop needs a derived table (SQL clauses are the other way around)
                : hasTake || hasDrop);
    return needsBoundary ? wrapAsDerived(q) : q;
}

// ---------------------------------------------------------------------------
// Application
// ---------------------------------------------------------------------------

/**
 * Pick the alternative of an overload set that accepts `arg`.
 *
 * The runtime matches on the argument's SQL type, which is exactly the
 * granularity an overload is written at: the prelude declares `abs` once per
 * numeric type, and the argument's type names which one. An alternative that
 * declares no parameter type accepts anything, and several surviving
 * alternatives mean the set is genuinely ambiguous for this argument.
 *
 * A partially applied set (`negate = abs`) keeps its alternatives and is
 * re-picked on the next application.
 */
function selectOverload(
    f: { name: string; alternatives: Value[]; ast?: AstNode },
    arg: Value,
    at: AstNode | undefined,
    ctx: Ctx,
): Value | null {
    const argType = valueSqlType(arg);
    const scored: { value: Value; score: number }[] = [];
    for (const alternative of f.alternatives) {
        const param = declaredParamType(alternative);
        if (param === null) continue; // not a function: the ordinary path reports it
        if (param === 'any' || argType === 'unknown') {
            scored.push({ value: alternative, score: 0 });
        } else if (param === argType) {
            scored.push({ value: alternative, score: 2 });
        } else if (isNumeric(param) && isNumeric(argType)) {
            scored.push({ value: alternative, score: 1 });
        }
    }
    if (scored.length === 0) return null;
    scored.sort((a, b) => b.score - a.score);
    const best = scored[0]!;
    const tied = scored.filter(s => s.score === best.score);
    if (tied.length > 1) {
        ctx.diagnostics.push({
            node: at ?? f.ast,
            message: `'${f.name}' is ambiguous for ${typeName(argType)} — annotate the argument to pick one of its ${f.alternatives.length} definitions`,
        });
        return null;
    }
    return best.value;
}

/** The parameter type an alternative declares, or null when it is not a function. */
function declaredParamType(v: Value): TypeOrNull | 'any' | null {
    if (v.kind === 'fn' || v.kind === 'lambda') return v.paramType ?? 'any';
    return null;
}

/** Whether a value can take part in an overload set (callable, not a query/record). */
function isOverloadable(v: Value): boolean {
    return v.kind === 'fn' || v.kind === 'lambda' || v.kind === 'step';
}

/** The SQL type of a value, for overload matching. */
function valueSqlType(v: Value): TypeOrNull | 'unknown' {
    return v.kind === 'expr' ? v.node.type : 'unknown';
}

export function applyWith(f: Value, arg: Value, at: AstNode | undefined, ctx: Ctx): Value {
    if (isError(f) || isError(arg)) return ERROR;
    // An overloaded name picks the alternative whose parameter accepts this
    // argument. The pick runs BEFORE the ordinary application, and the chosen
    // alternative is applied exactly as a direct call would be — so a numeric
    // overload (`abs` on int vs float) resolves the same way statically and at
    // runtime, and no SQL lowering is duplicated.
    if (f.kind === 'overload') {
        const chosen = selectOverload(f, arg, at, ctx);
        return chosen ? applyWith(chosen, arg, at, ctx) : ERROR;
    }
    switch (f.kind) {
        case 'fn':
            return f.apply(arg, at, ctx);
        case 'step': {
            // Diagnostics inside the step (bad predicate, bad projection, ...)
            // anchor at the APPLICATION site (`users & filter ...`), never at
            // the lambda the operator section resolved to (prelude `_&_`),
            // which would print a misleading prelude position.
            const site = at ?? f.ast;
            if (arg.kind !== 'query') {
                ctx.diagnostics.push({ node: site ?? astOf(arg) ?? fallbackNode(ctx), message: `step '${f.name}' expects a query, got ${describe(arg)} — use it in a pipeline: query & ${f.name} ...` });
                return ERROR;
            }
            const query = prepareQueryForStep(arg.query, f.name);
            const next = f.apply(query, site, ctx);
            return next ? { kind: 'query', query: next, ast: at } : ERROR;
        }
        case 'lambda': {
            const remaining = f.params.slice(1);
            const env = new Map(f.closure);
            env.set(f.params[0]!, arg);
            if (remaining.length === 0) {
                return evalHir(f.body, {
                    env,
                    diagnostics: ctx.diagnostics,
                    moduleBindings: ctx.moduleBindings,
                    allowAggregatesInCase: ctx.allowAggregatesInCase,
                });
            }
            return { kind: 'lambda', params: remaining, body: f.body, closure: env, ast: f.ast };
        }
        case 'mempty': {
            // `mempty` is not a function; application always fails. Keep the
            // message shared with the inference pass so both passes agree.
            ctx.diagnostics.push({ node: at ?? f.ast, message: `mempty is a value, not a function — write (mempty : T) to pick the instance, e.g. (mempty : [int])` });
            return ERROR;
        }
        default:
            ctx.diagnostics.push({ node: at ?? fallbackNode(ctx), message: `cannot apply ${describe(f)}` });
            return ERROR;
    }
}


/** Pure public entry point: evaluate with an immutable environment and return diagnostics. */
export function evalExpr(e: Expr, env: ReadonlyMap<string, Value>, moduleBindings: ReadonlySet<string> = EMPTY_BINDINGS): EvalResult<Value> {
    const diagnostics: Diagnostic[] = [];
    const value = evalExprWith(e, { env: new Map(env), diagnostics, moduleBindings: new Set(moduleBindings) });
    return isError(value) ? { ok: false, diagnostics } : { ok: true, value, diagnostics };
}

/** Pure public entry point for applying a first-class function/step value. */
export function apply(f: Value, arg: Value, at: AstNode | undefined, env: ReadonlyMap<string, Value>, moduleBindings: ReadonlySet<string> = EMPTY_BINDINGS): EvalResult<Value> {
    const diagnostics: Diagnostic[] = [];
    const value = applyWith(f, arg, at, { env: new Map(env), diagnostics, moduleBindings: new Set(moduleBindings) });
    return isError(value) ? { ok: false, diagnostics } : { ok: true, value, diagnostics };
}

function astOf(v: Value): AstNode | undefined {
    return 'ast' in v ? v.ast : undefined;
}

// ---------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------

/** Derive a record's schema from its evaluated fields (types only where known). */
function recordSchemaOf(fields: { key: string; value: Value }[]): Schema {
    const schema = new Map<string, SqlColumn>();
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
        ctx.diagnostics.push({ node: at ?? rec.ast, message: `cannot enumerate a row with an unknown schema — annotate the table, e.g. users: query { id: int } = table "users"` });
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

// ---------------------------------------------------------------------------
// Record transformers (`rename`, `pick`, `omit`) — teta-style pure record
// helpers used inside map: `map (rename (k => "user_" <> k))`,
// `map (pick ["id", "email"])`, `map (omit ["password_hash"])`.
//
// A record here is the row the map lambda receives: an unknown-schema row
// (an un-annotated table) cannot enumerate its fields, which recordFields
// already diagnoses with the shared annotate-the-table wording — the same
// restriction `merge` has. The transformer is applied to the row at map STEP
// construction time, and the result materializes every output field as a
// plain column expression, so it flows through rowFromRecord like any map
// projection. A rename key rule must return a string literal per key: a SQL
// expression cannot compute a column NAME.
// ---------------------------------------------------------------------------

/**
 * Evaluate the transformer's key function against one record of every input
 * key and return the `key -> newKey` mapping. The row's keys are known here
 * (the row record materialized them), so a pure string -> string rule such
 * as `k => "user_" <> k` is applied by CALLING the function per key.
 */
function renameKeyMapping(
    keys: readonly string[],
    keyFn: Value,
    at: AstNode | undefined,
    ctx: Ctx,
): Map<string, string> | null {
    const mapping = new Map<string, string>();
    for (const key of keys) {
        const mapped = applyWith(keyFn, mkExpr(lit(key, 'string'), at), at, ctx);
        if (isError(mapped)) return null;
        const name = foldableStringValue(mapped);
        if (name === null) {
            ctx.diagnostics.push({ node: at ?? keyFn.ast, message: `rename key rule must compute a column name from the field name (e.g. k => "user_" <> k) — got a non-literal result for '${key}'` });
            return null;
        }
        mapping.set(key, name);
    }
    return mapping;
}

/** Apply a rename mapping, rejecting duplicate output columns. */
function applyRenameMapping(
    fields: readonly { key: string; value: Value }[],
    mapping: Map<string, string>,
    at: AstNode | undefined,
    ctx: Ctx,
): Value | null {
    const out: { key: string; value: Value }[] = [];
    const seen = new Set<string>();
    for (const { key, value } of fields) {
        const newKey = mapping.get(key) ?? key;
        // A renamed key colliding with an UNCHANGED key is a duplicate too,
        // so every output key joins `seen`.
        if (seen.has(newKey)) {
            ctx.diagnostics.push({ node: at, message: `rename would produce a duplicate column '${newKey}'` });
            return null;
        }
        seen.add(newKey);
        out.push({ key: newKey, value });
    }
    return recordValue(out, at);
}

/**
 * Resolve `mempty` against the OTHER `<>` operand (Haskell's type-directed
 * instance selection, made explicit at the use site):
 *   - `mempty <> s` / `s <> mempty` with s an expression of type string → ''
 *   - with s a list → []
 *   - with s a record → {} (right-biased merge keeps the other operand's
 *     fields; the record identity carries no fields of its own)
 * A `null` side (the empty-operand slot) returns the other operand unchanged
 * for strings/lists; for records the merge call already handles it.
 */
function memptyIdentityFor(other: Value, at: AstNode | undefined, ctx: Ctx, otherIsRight: boolean): Value {
    if (other.kind === 'expr' && other.node.type === 'string') {
        return mkExpr(lit('', 'string'), at);
    }
    if (other.kind === 'list') {
        return { kind: 'list', items: [], ast: at };
    }
    if (other.kind === 'record') {
        // <> identity on records: the empty record. Merging {} with `other`
        // yields exactly `other`'s materialized fields.
        return mergeValues(recordValue([], at), other, at, ctx);
    }
    ctx.diagnostics.push({
        node: at ?? other.ast,
        message: `mempty has no instance for ${describe(other)} — the closed Monoid instances are string, [a], and records`,
    });
    return ERROR;
}

/**
 * Decode an ascription annotation into a concrete `mempty` value. The closed
 * instances (see docs/design/type-system.md §7): string, lists, and records.
 * Scalars like int/bool have NO monoid instance — `(mempty : int)` is an
 * error, matching the inference pass. Unknown annotations (holes, variables)
 * leave the identity unresolved so a surrounding use site can still resolve it.
 */
function expandMemptyAnnotation(t: import('./generated/ast.js').Type, ctx: Ctx): Value | null {
    let cur: import('./generated/ast.js').Type = t;
    for (;;) {
        if (isTypeAtom(cur)) {
            if (cur.maybeType) { cur = cur.maybeType; continue; }
            if (cur.base) { cur = cur.base; continue; }
        }
        if (isTypeParen(cur)) { cur = cur.type; continue; }
        break;
    }
    if (isListType(cur)) return { kind: 'list', items: [] };
    if (isRecordType(cur)) return recordValue([]);
    if (isTypeVar(cur) && cur.name === 'string') return mkExpr(lit('', 'string'));
    return null;
}
/**
 * The SQL type a parameter annotation declares (`(x: float) => ...` ->
 * `float`), or null when the annotation names no concrete scalar. Only scalar
 * primitives are reported: those are the granularity overloads are written at,
 * and anything else (`maybe T`, a row, a function) leaves the choice open.
 */
function sqlTypeOfAnnotation(t: unknown): TypeOrNull | null {
    let cur = t as import('./generated/ast.js').Type | undefined;
    for (;;) {
        if (!cur) return null;
        if (isTypeParen(cur)) { cur = cur.type; continue; }
        if (isTypeAtom(cur)) {
            if (cur.maybeType) { cur = cur.maybeType; continue; }
            if (cur.base) { cur = cur.base; continue; }
        }
        break;
    }
    if (isTypeVar(cur)) {
        const name = cur.name;
        if ((PRIM_TYPE_NAMES as readonly string[]).includes(name)) return name as TypeOrNull;
    }
    return null;
}

/** The first parameter's SQL type from a `T -> U` binding annotation. */
function firstParamTypeOfAnnotation(t: import('./generated/ast.js').Type): TypeOrNull | null {
    let cur: import('./generated/ast.js').Type = t;
    for (;;) {
        if (isTypeParen(cur)) { cur = cur.type; continue; }
        break;
    }
    if (!isFunType(cur)) return null;
    return sqlTypeOfAnnotation(cur.left);
}

/** Scalar primitives usable as an overload discriminator. */
const PRIM_TYPE_NAMES = ['int', 'float', 'decimal', 'string', 'bool', 'date', 'timestamp'] as const;

function memptyFromAnnotation(t: import('./generated/ast.js').Type, at: AstNode | undefined, ctx: Ctx): Value {
    let cur: import('./generated/ast.js').Type = t;
    for (;;) {
        if (isTypeAtom(cur)) {
            if (cur.maybeType) { cur = cur.maybeType; continue; }
            if (cur.base) { cur = cur.base; continue; }
        }
        if (isTypeParen(cur)) { cur = cur.type; continue; }
        break;
    }
    if (isListType(cur)) {
        // The element type is unchecked at the value layer — lists are
        // heterogeneous at evaluation time; inference checks elements.
        return { kind: 'list', items: [], ast: at };
    }
    if (isRecordType(cur)) {
        return recordValue([], at);
    }
    if (isTypeVar(cur) && cur.name === 'string') {
        return mkExpr(lit('', 'string'), at);
    }
    if (isTypeVar(cur) && (CAST_TYPES as readonly string[]).includes(cur.name)) {
        ctx.diagnostics.push({
            node: at ?? cur,
            message: `mempty has no instance for ${cur.name} — the closed Monoid instances are string, [a], and records`,
        });
        return mkExpr(lit('', 'string'), at); // concrete default keeps downstream IR valid
    }
    // Holes/type variables stay unresolved (`mempty : ?a` in a signature).
    return { kind: 'mempty', ast: at };
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

/** Turn an Agda-style `_op_` reference into an ordinary curried function. */
function operatorSectionValue(raw: string, at: AstNode, ctx: Ctx): Value {
    const scoped = ctx.env.get(raw);
    if (scoped) return scoped;

    // A `_name_` reference resolves ONLY its exact `_name_` binding (or, for an
    // operator symbol, the intrinsic behind it). There is no fallback to the
    // bare `name`: one spelling, one lookup.
    const op = sectionName(raw);
    if (!isBinaryOperator(op)) {
        ctx.diagnostics.push({ node: at, message: `unknown operator section '${raw}' — '${raw}' is not defined` });
        return ERROR;
    }
    if (isIntrinsicOperator(op)) return operatorIntrinsicValue(op);
    ctx.diagnostics.push({ node: at, message: `unknown operator section '${raw}' — '${raw}' is not defined` });
    return ERROR;
}

/** The hidden SQL-aware primitive exported under an ordinary prelude binding. */
function operatorIntrinsicValue(op: IntrinsicOperator): Value {
    return fn(operatorIntrinsicName(op), (left, at1, ctx1) =>
        fn(operatorIntrinsicName(op), (right, at2, ctx2) =>
            applyBinaryOperator(op, left, right, at2 ?? at1 ?? fallbackNode(ctx1), ctx2)));
}

/** Apply the scoped `_op_` binding used by infix syntax. */
function applyScopedBinaryOperator(op: BinaryOperator, left: Value, right: Value, at: AstNode, ctx: Ctx): Value {
    // Infix syntax remains usable in the strict core so the source prelude can
    // define `_op_` aliases. User modules normally resolve the exported alias.
    const operator = ctx.env.get(sectionSpelling(op));
    if (operator) {
        const partial = applyWith(operator, left, at, ctx);
        return isError(partial)
            ? ERROR
            : reanchorDiagnostics(at, ctx, () => applyWith(partial, right, at, ctx));
    }
    if (!isIntrinsicOperator(op)) {
        ctx.diagnostics.push({ node: at, message: `operator '${op}' is not defined` });
        return ERROR;
    }
    const partial = applyWith(operatorIntrinsicValue(op), left, at, ctx);
    return isError(partial) ? ERROR : applyWith(partial, right, at, ctx);
}

/**
 * Re-anchor diagnostics raised while evaluating an infix operator through a
 * scoped `_op_` lambda (e.g. the prelude's `_&_ = x => f => f x`). The lambda
 * body lives in ANOTHER module, so any diagnostic that grew there would print
 * that module's position. After evaluation, diagnostics added while the body
 * ran whose AST root is NOT the caller's operator node are re-anchored at
 * `at` (keeping their message); diagnostics anchored inside the caller's own
 * module keep their exact node.
 */
function reanchorDiagnostics(at: AstNode, ctx: Ctx, evalRest: () => Value): Value {
    const mark = ctx.diagnostics.length;
    const operatorRoot = rootOf(at);
    const result = evalRest();
    for (let i = mark; i < ctx.diagnostics.length; i++) {
        const d = ctx.diagnostics[i]!;
        if (d.node && rootOf(d.node) === operatorRoot) continue;
        ctx.diagnostics[i] = { ...d, node: at };
    }
    return result;
}

/** Walk to the top-level owner (the Model) of a node. */
function rootOf(node: AstNode): AstNode {
    let current = node;
    while (current.$container) current = current.$container;
    return current;
}

/** SQL-aware semantics supplied only by hidden operator intrinsics. */
function applyBinaryOperator(op: IntrinsicOperator, left: Value, right: Value, at: AstNode, ctx: Ctx): Value {
    return evalBinary(op, left, right, at, ctx);
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
    const v = applyWith(f, row, at, ctx);
    if (isError(v)) return null;
    const proj = rowFromRecord(v, at, ctx, 'projection', afterFold);
    if (!proj) return null;
    if (proj.fields.length === 0) {
        ctx.diagnostics.push({ node: at ?? f.ast, message: `map projection must contain at least one field` });
        return null;
    }
    // Window-only functions (rowNumber, rank, lag, ...) are invalid outside
    // `over (...)` — catch them here so they never render broken SQL.
    if (validateWindowUses(proj.fields, at ?? f.ast, ctx)) return null;
    return addStep(q, { kind: 'map', proj }, at);
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
    // `<>` is a closed Semigroup operation for strings and lists, while
    // records retain their structural right-biased merge behavior. `mempty`
    // resolves to the other operand's monoid identity.
    if (op === '<>') {
        if (l.kind === 'mempty' && r.kind === 'mempty') {
            ctx.diagnostics.push({ node: at, message: `cannot infer the monoid instance of mempty <> mempty — annotate one side, e.g. (mempty : [int]) <> xs` });
            return ERROR;
        }
        if (l.kind === 'mempty') return memptyIdentityFor(r, at, ctx, true);
        if (r.kind === 'mempty') return memptyIdentityFor(l, at, ctx, false);
        if (l.kind === 'list' && r.kind === 'list') {
            return { kind: 'list', items: [...l.items, ...r.items], ast: at };
        }
        if (l.kind === 'record' && r.kind === 'record') {
            return mergeValues(l, r, at, ctx);
        }
        const leftNode = exprNode(l);
        const rightNode = exprNode(r);
        if (leftNode?.type === 'string' && rightNode?.type === 'string') {
            return mkExpr({ kind: 'call', name: 'concat', args: [leftNode, rightNode], type: 'string' }, at);
        }
        ctx.diagnostics.push({ node: at, message: `'<>' expects two records, strings, or lists, got ${describe(l)} and ${describe(r)}` });
        return ERROR;
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
        // Constant-fold literal comparisons so the prelude can branch on
        // compile-time values like `sql_dialect.name == "mysql"` and the
        // `case` short-circuits at analysis time instead of emitting SQL.
        if (ln.kind === 'lit' && rn.kind === 'lit') {
            const eq = ln.value === rn.value;
            return mkExpr(lit(op === '==' ? eq : !eq, 'bool'), at);
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

    if (op === '+' || op === '-' || op === '*' || op === '/') {
        if ((!isNumeric(ln.type) && ln.type !== 'unknown') || (!isNumeric(rn.type) && rn.type !== 'unknown')) {
            ctx.diagnostics.push({ node: at, message: `'${op}' requires numeric operands, got ${typeName(ln.type)} and ${typeName(rn.type)}` });
            return ERROR;
        }
        if (op === '/' && ((ln.type !== 'float' && ln.type !== 'unknown' && !isLiteralNum(ln))
            || (rn.type !== 'float' && rn.type !== 'unknown' && !isLiteralNum(rn)))) {
            ctx.diagnostics.push({ node: at, message: `'/' requires float operands — use div for integral division, got ${typeName(ln.type)} and ${typeName(rn.type)}` });
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
// `this`/`that` implicit lambda parameters
// ---------------------------------------------------------------------------

/**
 * Highest implicit-parameter index in `node` that is NOT bound in `env` and
 * not hidden inside an explicit lambda body (explicit lambdas are their own
 * scope). `this` is parameter 1 and `that` is parameter 2 — the only two.
 *
 * An argument in a FUNCTION position of an application — a position whose
 * type is a curried function, e.g. `filter`'s predicate or a join's `on`
 * merger — is its own implicit-lambda scope and does not leak its `this`/
 * `that` outward: `filter (P1) $ filter (P2) s03` keeps the `this` inside
 * the inner `filter`'s predicate instead of abstracting the whole `$`-right
 * operand into a lambda. VALUE-position `this`/`that` arguments (like
 * `cast this.pt_dt` or `isIn (fromMaybe "" this.x) [...]`) bubble up to
 * the enclosing expression's implicit lambda.
 */
function dollarArity(node: AstNode, env: ReadonlyMap<string, Value>): number {
    let arity = 0;
    const stack: AstNode[] = [node];
    while (stack.length > 0) {
        const cur = stack.pop()!;
        // `this`/`that` sugar: an unbound identifier naming an implicit
        // parameter (internally $1/$2) contributes its index, unless shadowed
        // by a binding or an already-bound $1/$2 of the same name.
        if (isIdentifier(cur) && !env.has(cur.name)) {
            const dollar = implicitParamName(cur.name);
            if (dollar && !env.has(dollar)) {
                if (hiddenBehindLambda(cur, env)) continue;
                arity = Math.max(arity, Number(dollar.slice(1)));
                continue;
            }
        }
        for (const key of Object.keys(cur)) {
            if (key.startsWith('$')) continue;
            const value = (cur as unknown as Record<string, unknown>)[key];
            if (Array.isArray(value)) {
                const skipFnArgs = key === 'arguments' && isApplication(cur) ? functionArgIndexesOf(cur, env) : undefined;
                for (let i = 0; i < value.length; i++) {
                    const v = value[i];
                    if (!v || typeof v !== 'object' || !('$type' in (v as object))) continue;
                    if (skipFnArgs?.has(i)) continue;
                    stack.push(v as AstNode);
                }
            } else if (value && typeof value === 'object' && '$type' in (value as object)) {
                stack.push(value as AstNode);
            }
        }
    }
    return arity;
}

/**
 * Is `node` inside an explicit lambda body WITHOUT an intervening implicit
 * scope? `this`/`that` belong to an explicit lambda only when no
 * function-position application argument sits between it and that lambda:
 * `filter (this.active)` scopes `this` to the filter's predicate, but
 * `filter (u => exists (filter (cast this.x ...) t))` scopes `this` to the
 * INNER filter. The walk stops at the first function-position argument.
 */
function hiddenBehindLambda(node: AstNode, env: ReadonlyMap<string, Value>): boolean {
    let cur: AstNode | undefined = node;
    while (cur) {
        const parent: AstNode | undefined = cur.$container;
        if (!parent) break;
        if (isLambda(parent) && parent.body === cur) return true;
        if (isApplication(parent)) {
            const index = parent.arguments.indexOf(cur as Expr);
            if (index >= 0 && functionArgIndexesOf(parent, env).has(index)) return false;
        }
        cur = parent;
    }
    return false;
}

const NO_FN_ARG_INDEXES = new Set<number>();

/**
 * Argument indexes of `app` that consume a function (an implicit-lambda
 * scope), derived from the callee's type scheme when the callee is a known
 * builtin. Unknown callees return an empty set, so the scan descends into all
 * of their arguments (the pre-existing behavior).
 */
function functionArgIndexesOf(app: Application, env: ReadonlyMap<string, Value>): Set<number> {
    const func = app.func;
    if (!isIdentifier(func)) return NO_FN_ARG_INDEXES;
    const value = env.get(func.name);
    let name: string | undefined;
    if (value?.kind === 'fn') {
        name = value.name;
    } else {
        name = func.name;
    }
    const canonical = Object.hasOwn(BUILTIN_ALIASES, name) ? BUILTIN_ALIASES[name as keyof typeof BUILTIN_ALIASES] : name;
    return builtinFnArgIndexes(canonical) ?? NO_FN_ARG_INDEXES;
}

/** Lazily-built map: builtin name → argument indexes that take a function. */
let builtinFnArgIndexesByName: ReadonlyMap<string, Set<number>> | undefined;
function builtinFnArgIndexes(name: string): Set<number> | undefined {
    if (!builtinFnArgIndexesByName) {
        const u = new TypeUniverse();
        const map = new Map<string, Set<number>>();
        for (const spec of BUILTIN_SPECS) {
            map.set(spec.name, fnArgIndexesOfType(spec.scheme(u).type, u));
        }
        builtinFnArgIndexesByName = map;
    }
    return builtinFnArgIndexesByName.get(name);
}

/** Indexes of a curried type's parameters whose (peeled) type is a function. */
function fnArgIndexesOfType(t: Type, u: TypeUniverse): Set<number> {
    const out = new Set<number>();
    let cur: Type | undefined = t;
    let index = 0;
    while (cur) {
        const r = u.peel(cur);
        if (r.kind !== 'fun') break;
        if (u.peel(r.from).kind === 'fun') out.add(index);
        cur = r.to;
        index++;
    }
    return out;
}

/**
 * Evaluate an expression as an argument. If it uses `this`/`that` (the
 * implicit parameters, internally `$1`/`$2`) that are not bound in the
 * current environment, abstract it into an implicit lambda:
 *   (this.age + 3)            ≡   u => u.age + 3
 *   (this.id == that.user_id) ≡   (u, v) => u.id == v.user_id
 * Lambda arguments are parenthesized, e.g. `filter (this.active)`,
 * `joinInner orders (this.id == that.user_id) { uid = this.id }`.
 */
function evalArg(expr: Expr, ctx: Ctx): Value {
    const arity = dollarArity(expr, ctx.env);
    if (arity > 0) return dollarLambda(lower(expr), arity, ctx);
    return evalExprWith(expr, ctx);
}

/**
 * Evaluate an application argument. `this`/`that` sugar turns the argument
 * into an implicit lambda when it mentions an implicit parameter; the arity
 * scan runs on the HIR node's AST so `$` collection stays syntax-driven.
 */
function evalHirArg(h: Hir, ctx: Ctx): Value {
    const arity = dollarArity(h.at, ctx.env);
    if (arity > 0) return dollarLambda(h, arity, ctx);
    return evalHir(h, ctx);
}

function dollarLambda(body: Hir, arity: number, ctx: Ctx): Value {
    const params = Array.from({ length: arity }, (_, i) => `$${i + 1}`);
    return { kind: 'lambda', params, body, closure: new Map(ctx.env), ast: body.at };
}

export function evalExprWith(e: Expr, ctx: Ctx): Value {
    // The AST node is still the key for recorded per-node values (hover and
    // completion look them up by AST node), so the HIR node carries it.
    const hir = lower(e);
    const value = evalHir(hir, ctx);
    ctx.nodeValues?.set(e, value);
    return value;
}

/** Evaluate an already-lowered HIR node. */
function evalHir(h: Hir, ctx: Ctx): Value {
    const value = evalHirInner(h, ctx);
    ctx.nodeValues?.set(h.at, value);
    return value;
}

function evalHirInner(h: Hir, ctx: Ctx): Value {
    switch (h.kind) {
        case 'let': {
            // `let x = value in body` — a pure lexical binding. Evaluation
            // extends the environment immutably; the value is not mutable state.
            let v = evalHir(h.value, ctx);
            if (isError(v)) return ERROR;
            // A query-type annotation on a local bare table defines the schema,
            // exactly like a top-level binding annotation.
            if (h.type && v.kind === 'query' && !v.query.known
                && v.query.steps.every(step => step.kind !== 'join')) {
                const qt = queryTypeOf(h.type);
                if (qt) {
                    const schema = schemaFromQueryType(qt, h.at, ctx);
                    if (schema) {
                        const alias = v.query.aliases[0] ?? v.query.root.name;
                        const stamped: Schema = new Map(
                            [...schema].map(([key, col]) => [key, { ...col, table: alias }]),
                        );
                        v = {
                            kind: 'query',
                            query: { ...v.query, known: true, root: { ...v.query.root, schema: stamped } },
                            ast: v.ast,
                        };
                    }
                }
            }
            const env = new Map(ctx.env);
            env.set(h.name, v);
            return evalHir(h.body, { env, diagnostics: ctx.diagnostics, moduleBindings: ctx.moduleBindings });
        }

        case 'ascribe': {
            // Type annotations are erased except for query schemas on plain
            // tables, where the annotation IS the schema — and `mempty`, where
            // the annotation picks the monoid instance (type-directed value).
            const v = evalHir(h.operand, ctx);
            return stampQueryTypeAnnotation(v, h.type, h.at, ctx);
        }

        case 'negate': {
            const v = evalHir(h.operand, ctx);
            const node = exprNode(v);
            if (!node) return ERROR;
            if (node.type === 'null' || (!isNumeric(node.type) && node.type !== 'unknown')) {
                ctx.diagnostics.push({ node: h.at, message: `unary '-' requires a numeric expression, got ${typeName(node.type)}` });
                return ERROR;
            }
            if (node.kind === 'lit' && typeof node.value === 'number') {
                return mkExpr({ ...node, value: -node.value, type: node.type }, h.at);
            }
            return mkExpr({ kind: 'bin', op: '-', left: lit(0, node.type), right: node, type: node.type }, h.at);
        }

        case 'binary': {
            const left = evalHir(h.left, ctx);
            // `$` keeps implicit-lambda argument behavior (its right operand is
            // an application argument); all other operators evaluate normally.
            const right = h.op === '$'
                ? evalHirArg(h.right, ctx)
                : evalHir(h.right, ctx);
            if (!isBinaryOperator(h.op)) {
                ctx.diagnostics.push({ node: h.at, message: `unknown operator '${h.op}'` });
                return ERROR;
            }
            return applyScopedBinaryOperator(h.op, left, right, h.at, ctx);
        }

        case 'access': {
            const recv = evalHir(h.receiver, ctx);
            if (isError(recv)) return ERROR;
            return access(recv, h.property, h.at, ctx);
        }

        case 'apply': {
            // All builtins are ordinary curried functions — including the
            // list-argument ones (`concat [a, b]`), which take a single list
            // argument, and the heterogeneous/optional ones (`substring u.name
            // 1 nothing`), which curry position by position with `maybe`s.
            // Overload selection happens inside `applyWith`.
            let f = evalHir(h.func, ctx);
            for (const argExpr of h.args) {
                if (isError(f)) {
                    evalHirArg(argExpr, ctx); // keep collecting diagnostics
                    continue;
                }
                const arg = evalHirArg(argExpr, ctx);
                f = applyWith(f, arg, argExpr.at, ctx);
            }
            return f;
        }

        case 'number':
            return mkExpr({ kind: 'lit', value: h.value, type: numberLiteralType(h.at as unknown as NumberLiteral) }, h.at);

        case 'string':
            return mkExpr({ kind: 'lit', value: h.value, type: 'string' }, h.at);

        case 'bool':
            return mkExpr({ kind: 'lit', value: h.value, type: 'bool' }, h.at);

        case 'null':
            return mkExpr({ kind: 'lit', value: null, type: 'null' }, h.at);

        case 'case':
            return evalCaseHir(h, ctx);

        case 'list': {
            const items = h.elements.map(el => evalHir(el, ctx));
            const bad = items.find(isError);
            if (bad) return bad;
            return { kind: 'list', items, ast: h.at };
        }

        case 'record': {
            // A record literal is a plain `{ k = v, ... }`. The old
            // `{ recv | k = v }` update sugar was removed from the grammar —
            // it was only ever `merge recv { k = v }`, so use `merge`.
            let fields: { key: string; value: Value }[] = [];
            const literalKeys = new Set<string>();
            for (const entry of h.entries) {
                const key = entry.key;
                if (literalKeys.has(key)) {
                    ctx.diagnostics.push({ node: entry.at, message: `duplicate map key '${key}'` });
                }
                literalKeys.add(key);
                let entryValue: Value;
                if (entry.value) {
                    entryValue = evalHir(entry.value, ctx);
                } else {
                    // Field punning: `{ id }` is `{ id = <lambda param>.id }`.
                    const paramName = enclosingLambdaParamName(entry.at as unknown as MapEntry);
                    if (paramName === null) {
                        ctx.diagnostics.push({ node: entry.at, message: `field pun '${key}' requires an enclosing lambda parameter, e.g. map (u => { ${key} })` });
                        return ERROR;
                    }
                    const rec = ctx.env.get(paramName);
                    if (!rec || rec.kind !== 'record') {
                        ctx.diagnostics.push({ node: entry.at, message: `field pun '${key}' expects lambda parameter '${paramName}' to be a record` });
                        return ERROR;
                    }
                    entryValue = readField(key, rec, entry.at, ctx);
                    if (isError(entryValue)) return ERROR;
                }
                fields = [...fields.filter(f => f.key !== key), { key, value: entryValue }];
            }
            return recordValue(fields, h.at);
        }

        case 'lambda': {
            // Snapshot the current scope: lambdas see only bindings defined so
            // far. A parameter annotation (`(x: float) => ...`) is recorded as
            // an SQL type so an overload set can be selected at render time.
            const declared = sqlTypeOfAnnotation(h.paramTypes[0]);
            return {
                kind: 'lambda',
                params: [...h.params],
                body: h.body,
                closure: new Map(ctx.env),
                ast: h.at,
                ...(declared ? { paramType: declared } : {}),
            };
        }

        case 'section':
            return operatorSectionValue(h.value, h.at, ctx);

        case 'ref': {
            const v = ctx.env.get(h.name);
            if (v) return v;
            // `this`/`that` sugar for the first two implicit lambda parameters.
            // Falling through to the generic message here would lose the hint
            // that tells the user WHY the sugar did not resolve.
            const dollar = implicitParamName(h.name);
            if (dollar) {
                const param = ctx.env.get(dollar);
                if (param) return param;
                ctx.diagnostics.push({ node: h.at, message: `unknown lambda parameter '${h.name}' — this/that refer to the implicit parameters of the enclosing lambda, e.g. filter (this.active)` });
                return ERROR;
            }
            if (ctx.moduleBindings.has(h.name)) {
                ctx.diagnostics.push({ node: h.at, message: `unknown identifier '${h.name}' — bindings must be defined before use` });
                return ERROR;
            }
            // Suggest corrections from the SMALL, relevant part of the scope:
            // the module's own bindings and its imports. Builtins, hidden
            // operator intrinsics, and the base library's surface are never
            // worth listing — the Prelude alone is dozens of names, and a
            // "defined: ..." list that long hides the one name the user meant.
            const excluded = new Set<string>(Object.keys(BUILTINS));
            const suggestions = [...ctx.env.keys()]
                .filter(k => !excluded.has(k) && !isOperatorIntrinsicName(k))
                .slice(0, 8);
            const suffix = suggestions.length > 0
                ? ` — did you mean one of: ${suggestions.join(', ')}?`
                : '';
            ctx.diagnostics.push({ node: h.at, message: `unknown identifier '${h.name}'${suffix}` });
            return ERROR;
        }
    }
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
function evalCaseHir(h: Extract<Hir, { kind: 'case' }>, ctx: Ctx): Value {
    if (h.branches.length === 0) {
        ctx.diagnostics.push({ node: h.at, message: `case requires at least one branch, e.g. case { u.active => u.name, _ => "inactive" }` });
        return ERROR;
    }
    const branches: { cond: SqlNode; value: SqlNode }[] = [];
    let elseValue: SqlNode | null = null;
    let resultType: SqlType | null = null;
    // Simple case: evaluate the subject ONCE, then compare every branch with
    // the same immutable value.
    const subjectValue = h.subject ? evalHir(h.subject, ctx) : null;
    if (subjectValue !== null && isError(subjectValue)) return ERROR;

    const valueNode = (branchAt: AstNode, value: Value): SqlNode | null => {
        const node = exprNode(value);
        if (!node) {
            ctx.diagnostics.push({ node: branchAt, message: `case branch values must be scalar expressions, got ${describe(value)}` });
            return null;
        }
        if (!ctx.allowAggregatesInCase && forbid(node, ['agg', 'group', 'order'], 'case', branchAt, ctx)) return null;
        if (ctx.allowAggregatesInCase && forbid(node, ['group', 'order'], 'case', branchAt, ctx)) return null;
        if (node.type !== 'null') {
            if (resultType === null) resultType = node.type as SqlType;
            else if (!comparable(resultType, node.type)) {
                ctx.diagnostics.push({ node: branchAt, message: `case requires matching value types, got ${typeName(resultType)} and ${typeName(node.type)}` });
                return null;
            }
        }
        return node;
    };

    for (let i = 0; i < h.branches.length; i++) {
        const b = h.branches[i]!;
        const value = evalHir(b.value, ctx);
        if (isError(value)) return ERROR;
        if (!b.cond) {
            // No condition = the `_` fallback branch.
            if (i !== h.branches.length - 1) {
                ctx.diagnostics.push({ node: b.at, message: `the '_' fallback branch must be last in a case expression` });
                return ERROR;
            }
            const v = valueNode(b.at, value);
            if (!v) return ERROR;
            elseValue = v;
            continue;
        }
        let condValue: Value;
        if (subjectValue !== null) {
            // The simple form with `subject == c1` conditions. Reuse evalBinary
            // so `== null` becomes IS NULL and type checks match the operator.
            const condExpr = evalHir(b.cond, ctx);
            if (isError(condExpr)) return ERROR;
            condValue = evalBinary('==', subjectValue, condExpr, b.cond.at, ctx);
            if (isError(condValue)) return ERROR;
        } else {
            condValue = evalHir(b.cond, ctx);
            if (isError(condValue)) return ERROR;
        }
        const cond = exprNode(condValue);
        if (!cond || (cond.type !== 'bool' && cond.type !== 'unknown')) {
            ctx.diagnostics.push({ node: b.cond.at, message: `case condition must be a boolean expression, got ${cond ? `type ${typeName(cond.type)}` : describe(condValue)}` });
            return ERROR;
        }
        if (forbid(cond, ['agg', 'group', 'order'], 'case', b.cond.at, ctx)) return ERROR;
        // Constant-fold a literal condition: the prelude branches on
        // compile-time values (`sql_dialect.name == "mysql"` folds to a
        // literal bool), so pick the branch NOW instead of emitting SQL.
        if (cond.kind === 'lit') {
            if (cond.value === true) {
                return value;
            }
            continue; // false branch: skip it entirely
        }
        const v = valueNode(b.at, value);
        if (!v) return ERROR;
        branches.push({ cond, value: v });
    }

    if (branches.length === 0 && elseValue !== null) {
        return mkExpr(elseValue, h.at);
    }
    const t: SqlType = resultType ?? 'string'; // all-null branches → string, like coalesce
    return mkExpr({ kind: 'case', branches, elseValue, type: t }, h.at);
}

// ---------------------------------------------------------------------------
// Builtins
// ---------------------------------------------------------------------------

/**
 * `paramType` lets an overloaded name be selected at render time: a prelude
 * definition annotated `abs: float -> float` records `float` here, so the
 * runtime can tell its alternatives apart exactly as the checker does.
 */
function fn(name: string, impl: (arg: Value, at: AstNode | undefined, ctx: Ctx) => Value, paramType?: TypeOrNull): Value {
    return { kind: 'fn', name, apply: impl, ...(paramType ? { paramType } : {}) };
}

function sqlNodeReferences(node: SqlNode, target: SqlNode): boolean {
    if (node === target) return true;
    if (node.kind === 'col' && target.kind === 'col') {
        return node.name === target.name && node.table === target.table;
    }
    if (node.kind === 'lit' && target.kind === 'lit') {
        return node.type === target.type && node.value === target.value;
    }
    switch (node.kind) {
        case 'bin': return sqlNodeReferences(node.left, target) || sqlNodeReferences(node.right, target);
        case 'is-null': case 'not': case 'group': case 'order':
            return sqlNodeReferences(node.expr, target);
        case 'call': return node.args.some(arg => sqlNodeReferences(arg, target));
        case 'in':
            return sqlNodeReferences(node.expr, target) || node.list.some(arg => sqlNodeReferences(arg, target));
        case 'agg':
            return sqlNodeReferences(node.arg, target) || (node.filter ? sqlNodeReferences(node.filter, target) : false);
        case 'window':
            return sqlNodeReferences(node.fn, target)
                || node.partition.some(part => sqlNodeReferences(part, target))
                || node.order.some(item => sqlNodeReferences(item.node, target));
        case 'fragment': return node.args.some(a => sqlNodeReferences(a, target));
        case 'case':
            return node.branches.some(branch => sqlNodeReferences(branch.cond, target) || sqlNodeReferences(branch.value, target))
                || (node.elseValue ? sqlNodeReferences(node.elseValue, target) : false);
        case 'in-query': return sqlNodeReferences(node.expr, target);
        case 'col': case 'bare': case 'lit': case 'param': case 'current-date': case 'date-literal':
        case 'timestamp-literal': case 'current-timestamp': case 'exists': case 'scalar':
            return false;
    }
}

/** Preserve Maybe short-circuiting for operations that do not naturally propagate SQL NULL. */
function nullableGuard(
    name: string,
    inputs: readonly Value[],
    result: Value,
    at: AstNode | undefined,
    ctx: Ctx,
): Value {
    const nodes: SqlNode[] = [];
    for (const input of inputs) {
        const node = exprNode(input);
        if (!node) {
            ctx.diagnostics.push({ node: at ?? input.ast, message: `${name} expects maybe expressions, got ${describe(input)}` });
            return ERROR;
        }
        if (node.kind === 'lit' && node.value === null) return mkExpr(node, at ?? input.ast);
        nodes.push(node);
    }
    const output = exprNode(result);
    if (!output) {
        ctx.diagnostics.push({ node: at ?? result.ast, message: `${name} must produce a maybe expression, got ${describe(result)}` });
        return ERROR;
    }
    if (output.type === 'null' || nodes.every(node => node.kind === 'lit')) return mkExpr(output, at ?? result.ast);
    const nullChecks = nodes.map<SqlNode>(expr => ({ kind: 'is-null', expr, negated: false, type: 'bool' }));
    const condition = nullChecks.slice(1).reduce<SqlNode>(
        (left, right) => ({ kind: 'bin', op: 'OR', left, right, type: 'bool' }),
        nullChecks[0]!,
    );
    return mkExpr({
        kind: 'case',
        branches: [{ cond: condition, value: lit(null, 'null') }],
        elseValue: output,
        type: output.type,
    }, at ?? result.ast);
}

/** `<*`, `*>`, and `>>` share sequencing; lists use Cartesian-product order. */
function sequenceBuiltin(name: 'applyLeft' | 'applyRight' | 'then', keep: 'left' | 'right'): () => Value {
    return () => fn(name, (left, at, ctx) => fn(name, (right, at2, ctx2) => {
        if (left.kind === 'list' || right.kind === 'list') {
            if (left.kind !== 'list' || right.kind !== 'list') {
                ctx2.diagnostics.push({ node: at2 ?? right.ast, message: `${name} expects two values in the same Applicative container, got ${describe(left)} and ${describe(right)}` });
                return ERROR;
            }
            const items: Value[] = [];
            for (const l of left.items) {
                for (const r of right.items) items.push(keep === 'left' ? l : r);
            }
            return { kind: 'list', items, ast: at2 ?? at ?? right.ast ?? left.ast };
        }
        const result = keep === 'left' ? left : right;
        return nullableGuard(name, [left, right], result, at2 ?? at, ctx2);
    }));
}

function step(name: string, impl: (q: Query, at: AstNode | undefined, ctx: Ctx) => Query | null): Value {
    return { kind: 'step', name, apply: (q, at, ctx) => {
        // `at` may legitimately be undefined (a step VALUE applied later, e.g.
        // `users & adults` where `adults` was built with no application node);
        // the impl's own fallbacks cover that case.
        return impl(q, at ?? undefined, ctx);
    } };
}

/** A set operation: `left & union right`, `intersect`, `except`, `unionAll`. */
function setOpBuiltin(name: string, op: SetOp): () => Value {
    return () => fn(name, (right, at, ctx) => {
        if (right.kind !== 'query') {
            ctx.diagnostics.push({ node: at ?? right.ast, message: `${name} expects a query as its argument, got ${describe(right)} — use it in a pipeline: query & ${name} right` });
            return ERROR;
        }
        return step(name, (q, at2, ctx2) => {
            // Set operands are complete relational expressions. Any step
            // applied AFTER the set will wrap the combined result as a
            // derived table via prepareQueryForStep/hasSetStep.
            const left = prepareQueryForStep(q, name);
            const rightQuery = prepareQueryForStep(right.query, name);
            return addStep(left, { kind: 'set', op, right: rightQuery }, at2);
        });
    });
}

/** A join whose SQL kind is encoded in its primitive name. */
function joinBuiltin(name: string, joinKind: JoinKind): () => Value {
    return () => fn(name, (right, at, ctx) => {
        if (right.kind !== 'query') {
            ctx.diagnostics.push({ node: at ?? right.ast, message: `${name} expects a query as its first argument, got ${describe(right)} — bind a table or pipeline first, e.g. ${name} orders (l => r => ...)` });
            return ERROR;
        }
        return fn(name, (on, at2, ctx2) => {
            if (!isApplicable(on)) {
                ctx2.diagnostics.push({ node: at2 ?? on.ast, message: `${name} 'on' must be a two-argument function (curried), e.g. (l => r => l.id == r.user_id) or (this.id == that.user_id), got ${describe(on)}` });
                return ERROR;
            }
            return fn(name, (merge, at3, ctx3) => {
                if (!isApplicable(merge)) {
                    ctx3.diagnostics.push({ node: at3 ?? merge.ast, message: `${name} 'merger' must be a two-argument function (curried), e.g. (l => r => merge l r) or merge, got ${describe(merge)}` });
                    return ERROR;
                }
                return step(name, (q, at4, ctx4) => {
                    // A fold ends the flat FROM scope: joining the aggregated
                    // result wraps the folded part as a derived table.
                    if (hasFoldStep(q)) q = wrapAsDerived(q);
                    const rightName = right.query.root.name;
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
                        // Re-qualify the schema with the join alias, but keep
                        // the rest of the root — dropping `root.from` here
                        // makes a derived right side render as a raw table
                        // name (`FROM all_detail`) instead of its subquery.
                        root: { ...right.query.root, schema: rightSchema },
                        aliases: [alias],
                    };
                    const rightRow: Value = { kind: 'record', schema: rightSchema, open: !right.query.known, defaultTable: alias, fields: [], ast: at4 };
                    const leftRow = rowRecord(q, at4);
                    const on1 = applyWith(on, leftRow, at4, ctx4);
                    if (isError(on1)) return null;
                    if (!isApplicable(on1)) {
                        ctx4.diagnostics.push({ node: at4 ?? on.ast, message: `${name} 'on' must be a two-argument function (curried), e.g. (l => r => l.id == r.user_id) or (this.id == that.user_id), got a one-argument function` });
                        return null;
                    }
                    const onVal = applyWith(on1, rightRow, at4, ctx4);
                    const node = exprNode(onVal);
                    if (!node || (node.type !== 'bool' && node.type !== 'unknown')) {
                        ctx4.diagnostics.push({ node: at4 ?? on.ast, message: `${name} 'on' condition must be a boolean expression, got ${node ? `type ${typeName(node.type)}` : describe(onVal)}` });
                        return null;
                    }
                    if (forbid(node, ['agg', 'group', 'order', 'window'], 'the join condition', at4 ?? on.ast, ctx4)) return null;
                    const m1 = applyWith(merge, leftRow, at4, ctx4);
                    if (isError(m1)) return null;
                    if (!isApplicable(m1)) {
                        ctx4.diagnostics.push({ node: at4 ?? merge.ast, message: `${name} 'merger' must be a two-argument function (curried), e.g. (l => r => merge l r) or merge, got a one-argument function` });
                        return null;
                    }
                    const mv = applyWith(m1, rightRow, at4, ctx4);
                    if (isError(mv)) return null;
                    const proj = rowFromRecord(mv, at4, ctx4, 'join merger');
                    if (!proj) return null;
                    if (proj.fields.length === 0) {
                        ctx4.diagnostics.push({ node: at4 ?? merge.ast, message: `${name} merger must produce a record with at least one field` });
                        return null;
                    }
                    const next: Query = { ...q, aliases: [...q.aliases, alias] };
                    return addStep(next, { kind: 'join', joinKind, right: rightQuery, on: node, proj }, at4);
                });
            });
        });
    });
}

const AGG_TYPES: Record<string, SqlType> = {
    count: 'int', sum: 'int', avg: 'float', min: 'int', max: 'int', array: 'array',
};

export const BUILTINS: Readonly<Record<BuiltinName, () => Value>> = {
    // --- query roots -----------------------------------------------------
    param: () => fn('param', (arg, at, ctx) => {
        const name = stringValue(arg);
        if (name === null || name.trim().length === 0) {
            ctx.diagnostics.push({ node: at ?? arg.ast, message: `param expects a non-empty parameter name string, e.g. param "user_id"` });
            return ERROR;
        }
        return mkExpr({ kind: 'param', name, type: 'unknown' }, at);
    }),
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
        if (name.trim().length === 0) {
            ctx.diagnostics.push({ node: at1 ?? arg1.ast, message: `table expects a non-empty table name string, e.g. table "users"` });
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
    filter: filterBuiltin('filter'),

    select: () => fn('select', (labelsArg, at, ctx) => {
        if (labelsArg.kind !== 'list') {
            ctx.diagnostics.push({ node: at ?? labelsArg.ast, message: `select expects a list of column-name strings, e.g. select ["id", "name"]` });
            return ERROR;
        }
        const labels: string[] = [];
        const seen = new Set<string>();
        for (const item of labelsArg.items) {
            const value = stringValue(item);
            if (value === null) {
                ctx.diagnostics.push({ node: item.ast ?? at, message: `select entries must be string literals, got ${describe(item)}` });
                return ERROR;
            }
            if (seen.has(value)) {
                ctx.diagnostics.push({ node: item.ast ?? at, message: `duplicate column '${value}' in select` });
            }
            seen.add(value);
            labels.push(value);
        }
        if (labels.length === 0) {
            ctx.diagnostics.push({ node: at ?? labelsArg.ast, message: `select expects at least one column name, e.g. select ["id"]` });
            return ERROR;
        }
        return step('select', (q, at2, ctx2) => {
            if (hasFoldStep(q)) q = wrapAsDerived(q);
            const row = rowRecord(q, at2);
            const fields: { key: string; value: Value }[] = [];
            for (const label of labels) {
                const value = readField(label, row, at2, ctx2);
                if (isError(value)) return null;
                fields.push({ key: label, value });
            }
            const proj = rowFromRecord(recordValue(fields, at2), at2, ctx2, 'select');
            if (!proj) return null;
            return addStep(q, { kind: 'map', proj }, at2);
        });
    }),

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
            const v = applyWith(sel, row, at2, ctx2);
            // Ordering by an aggregate is allowed after a fold (ORDER BY
            // SUM(...)) and after a nested-aggregate map (the derived table's
            // columns are aggregate expressions).
            const items = orderItems(v, at2 ?? sel.ast, ctx2, hasFoldStep(q) || schemaHasAggregates(q));
            if (!items) return null;
            // A query has one observable ORDER BY: applying sort again replaces
            // the previous sort (earlier sorts are unordered relational steps).
            const withoutSorts = { ...q, steps: q.steps.filter(s => s.kind !== 'sort') };
            return addStep(withoutSorts, { kind: 'sort', items }, at2);
        });
    }),

    take: () => fn('take', (arg, at, ctx) => {
        const n = numberValue(arg);
        if (n === null || !Number.isInteger(n) || n < 0) {
            ctx.diagnostics.push({ node: at ?? arg.ast, message: `take expects a non-negative integer literal, got ${n === null ? describe(arg) : String(n)}` });
            return ERROR;
        }
        return step('take', (q, at2) => {
            // LIMIT n followed by LIMIT m is LIMIT (min n m) in one flat scope.
            if (hasTakeStep(q)) {
                return {
                    ...q,
                    steps: q.steps.map(s => s.kind === 'take' ? { ...s, n: Math.min(s.n, n) } : s),
                };
            }
            return addStep(q, { kind: 'take', n }, at2);
        });
    }),

    drop: () => fn('drop', (arg, at, ctx) => {
        const n = numberValue(arg);
        if (n === null || !Number.isInteger(n) || n < 0) {
            ctx.diagnostics.push({ node: at ?? arg.ast, message: `drop expects a non-negative integer literal, got ${n === null ? describe(arg) : String(n)}` });
            return ERROR;
        }
        return step('drop', (q, at2) => addStep(q, { kind: 'drop', n }, at2));
    }),

    recursive: () => fn('recursive', (f, at, ctx) => {
        if (!isApplicable(f)) {
            ctx.diagnostics.push({ node: at ?? f.ast, message: `recursive expects a function query -> query, e.g. edges & recursive (self => edges & joinInner self ...)` });
            return ERROR;
        }
        return step('recursive', (q, at2, ctx2) => {
            if (!q.known) {
                ctx2.diagnostics.push({ node: at2 ?? f.ast, message: `recursive requires a known schema — annotate the base table first` });
                return null;
            }
            let name = q.name ?? 'recursive';
            // The CTE name must not collide with a base-table alias, or the
            // recursive term's `FROM base` would resolve to the CTE itself.
            const baseAliases = new Set(q.aliases);
            while (baseAliases.has(name)) name = `${name}_rec`;
            const selfQuery: Query = {
                name,
                root: { name, schema: querySchema(q) },
                known: true,
                aliases: [name],
                steps: [],
                distinct: false,
            };
            const term = applyWith(f, { kind: 'query', query: selfQuery, ast: f.ast }, at2 ?? f.ast, ctx2);
            if (isError(term) || term.kind !== 'query') {
                if (!isError(term)) ctx2.diagnostics.push({ node: at2 ?? f.ast, message: `recursive term must be a query, got ${describe(term)}` });
                return null;
            }
            return {
                root: { name, schema: querySchema(term.query), from: q },
                known: true,
                aliases: [name],
                steps: [],
                distinct: false,
                recursive: { name, term: term.query },
            };
        });
    }),

    distinct: () => fn('distinct', (arg, at, ctx) => {
        if (arg.kind !== 'query') {
            ctx.diagnostics.push({ node: at ?? arg.ast, message: `distinct expects a query, got ${describe(arg)} — use it in a pipeline: query & distinct` });
            return ERROR;
        }
        // DISTINCT after LIMIT or after a window projection needs the prior
        // query as a derived table: SQL's SELECT DISTINCT ... LIMIT n would
        // apply DISTINCT before the limit, not after.
        let q = arg.query;
        if (q.distinct) return { kind: 'query', query: q, ast: at };
        if (hasTakeStep(q) || hasWindowProjection(q)) q = wrapAsDerived(q);
        return { kind: 'query', query: { ...q, distinct: true }, ast: at };
    }),

    // --- set operations (pure query -> query combinators) -------------
    // left & union right, left & unionAll right, left & intersect right,
    // and left & except right render as SQL set operations. Both operands
    // are complete relational expressions; later steps wrap the combined
    // result as a derived table.
    union: setOpBuiltin('union', 'UNION'),
    unionAll: setOpBuiltin('unionAll', 'UNION ALL'),
    intersect: setOpBuiltin('intersect', 'INTERSECT'),
    except: setOpBuiltin('except', 'EXCEPT'),

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

    // --- record transformers (teta-style pure record helpers) ------------
    // `rename keyFn` — every field renamed by the key rule. The rule runs on
    // the row's KEYS (strings), so `map (rename (k => "user_" <> k))` turns
    // { id, name } into { user_id, user_name }; a key rule returning the key
    // itself keeps the field's name.
    rename: () => fn('rename', (keyFn, at, ctx) => {
        if (!isApplicable(keyFn)) {
            ctx.diagnostics.push({ node: at ?? keyFn.ast, message: `rename expects a key rule, e.g. map (rename (k => "user_" <> k))` });
            return ERROR;
        }
        return fn('rename', (rec, at2, ctx2) => {
            const fields = recordFields(rec, at2, ctx2);
            if (fields === null) return ERROR;
            const mapping = renameKeyMapping(fields.map(f => f.key), keyFn, at2 ?? at, ctx2);
            if (mapping === null) return ERROR;
            return applyRenameMapping(fields, mapping, at2 ?? at, ctx2) ?? ERROR;
        });
    }),

    // `pick names` — keep only the listed fields, in list order (teta's
    // pick, which also fixes the output column order). An empty list is an
    // invalid projection; unknown names are diagnosed with the row's fields.
    pick: () => fn('pick', (namesArg, at, ctx) => {
        const picked = stringListValue(namesArg, at, ctx, 'pick');
        if (picked === null) return ERROR;
        return fn('pick', (rec, at2, ctx2) => {
            const fields = recordFields(rec, at2, ctx2);
            if (fields === null) return ERROR;
            const byKey = new Map(fields.map(f => [f.key, f.value] as const));
            const out: { key: string; value: Value }[] = [];
            const seen = new Set<string>();
            for (const { name, node } of picked) {
                // Anchor a duplicate on the string item like the static pass,
                // so the two passes' diagnostics dedupe (the select pattern).
                const anchor = node ?? at2 ?? at;
                const value = byKey.get(name);
                if (value === undefined) {
                    ctx2.diagnostics.push({ node: at2 ?? at, message: `pick has no field '${name}' — available: ${fields.map(f => f.key).join(', ')}` });
                    return ERROR;
                }
                if (seen.has(name)) {
                    ctx2.diagnostics.push({ node: anchor, message: `duplicate field '${name}' in pick` });
                    return ERROR;
                }
                seen.add(name);
                out.push({ key: name, value });
            }
            if (out.length === 0) {
                ctx2.diagnostics.push({ node: at2 ?? at, message: `pick expects at least one field, e.g. pick ["id"]` });
                return ERROR;
            }
            return recordValue(out, at2);
        });
    }),

    // `omit names` — remove the listed fields, keeping the rest in row order
    // (teta's record-level drop; named `omit` instead of `drop` because
    // `drop n` is the OFFSET query step).
    omit: () => fn('omit', (namesArg, at, ctx) => {
        const names = stringListValue(namesArg, at, ctx, 'omit');
        if (names === null) return ERROR;
        return fn('omit', (rec, at2, ctx2) => {
            const fields = recordFields(rec, at2, ctx2);
            if (fields === null) return ERROR;
            const dropped = new Set(names.map(n => n.name));
            if (dropped.size !== names.length) {
                ctx2.diagnostics.push({ node: at2 ?? at, message: `duplicate field in omit` });
                return ERROR;
            }
            const available = fields.map(f => f.key);
            const unknown = names.map(n => n.name).filter(n => !available.includes(n));
            if (unknown.length > 0) {
                ctx2.diagnostics.push({ node: at2 ?? at, message: `omit has no field '${unknown[0]}' — available: ${available.join(', ')}` });
                return ERROR;
            }
            const out = fields.filter(f => !dropped.has(f.key));
            if (out.length === 0) {
                ctx2.diagnostics.push({ node: at2 ?? at, message: `omit would remove every field` });
                return ERROR;
            }
            return recordValue(out, at2);
        });
    }),

    fold: () => fn('fold', (sel, at, ctx) => {
        if (!isApplicable(sel) || (sel.kind === 'lambda' && sel.params.length !== 1)) {
            ctx.diagnostics.push({ node: at ?? sel.ast, message: `fold expects a projection function, e.g. fold (o => { user_id = group o.user_id, total = sum o.total })` });
            return ERROR;
        }
        return step('fold', (q, at2, ctx2) => {
            // A sort before a fold has no observable effect (grouping and
            // aggregation are over an unordered relation), so drop it before
            // wrapping. A second fold runs on the first fold's derived result.
            if (!hasTakeStep(q) && !hasWindowProjection(q)) {
                q = { ...q, steps: q.steps.filter(s => s.kind !== 'sort') };
            }
            if (hasFoldStep(q)) q = wrapAsDerived(q);
            const foldCtx: Ctx = { ...ctx2, allowAggregatesInCase: true };
            const v = applyWith(sel, rowRecord(q, at2), at2, foldCtx);
            if (v.kind !== 'record') {
                ctx2.diagnostics.push({ node: at2 ?? sel.ast, message: `fold expects a projection record, got ${describe(v)}` });
                return null;
            }
            const row: { fields: { key: string; node: SqlNode }[] } = { fields: [] };
            const groupCols = new Set<string>();
            for (const { value } of v.fields) {
                const node = exprNode(value);
                if (node?.kind === 'group' && node.expr.kind === 'col') {
                    groupCols.add(`${node.expr.table}\u0000${node.expr.name}`);
                }
            }
            let modes = 0;
            for (const { key, value } of v.fields) {
                const node = exprNode(value);
                if (!node) {
                    ctx2.diagnostics.push({ node: value.ast ?? at2, message: `fold entry '${key}' must be an aggregate (count, sum, ...) or group, got ${describe(value)}` });
                    return null;
                }
                let isAggregate = node.kind === 'agg';
                if (node.kind === 'case') {
                    // `case { cond => sum x, _ => sum y }` is an aggregate CASE
                    // expression in SQL. Conditions are ordinary predicates;
                    // each branch VALUE must be aggregate/group/constant-only.
                    const containsAgg = (n: SqlNode): boolean => {
                        let saw = false;
                        forEachNode(n, x => { if (x.kind === 'agg' || x.kind === 'group') saw = true; });
                        return saw;
                    };
                    const aggregateSafe = (n: SqlNode): boolean => {
                        if (n.kind === 'agg' || n.kind === 'group') return true;
                        if (n.kind === 'lit') return true;
                        if (n.kind === 'bin') return aggregateSafe(n.left) && aggregateSafe(n.right);
                        if (n.kind === 'call') return n.args.every(aggregateSafe);
                        if (n.kind === 'is-null' || n.kind === 'not') return aggregateSafe(n.expr);
                        if (n.kind === 'case') {
                            return n.branches.every(b => aggregateSafe(b.value))
                                && (n.elseValue === null || aggregateSafe(n.elseValue));
                        }
                        return false;
                    };
                    const values = [...node.branches.map(b => b.value)];
                    if (node.elseValue) values.push(node.elseValue);
                    const conditionsGrouped = node.branches.every(b => {
                        let ok = true;
                        forEachNode(b.cond, n => {
                            if (n.kind === 'col' && !groupCols.has(`${n.table}\u0000${n.name}`)) ok = false;
                        });
                        return ok;
                    });
                    if (!conditionsGrouped) {
                        ctx2.diagnostics.push({ node: value.ast ?? at2, message: `fold entry '${key}' case conditions must be constant or use grouped columns` });
                        return null;
                    }
                    isAggregate = values.length > 0
                        && values.every(aggregateSafe)
                        && values.some(containsAgg);
                }
                if (isAggregate) modes++;
                if (!isAggregate && node.kind !== 'group') {
                    ctx2.diagnostics.push({ node: value.ast ?? at2, message: `fold entry '${key}' must be wrapped in an aggregate (count, sum, ...) or group` });
                    return null;
                }
                if (node.kind === 'group') modes++;
                row.fields.push({ key, node });
            }
            if (modes === 0) {
                ctx2.diagnostics.push({ node: sel.ast ?? at2, message: `fold must contain at least one aggregate or group entry` });
                return null;
            }
            return addStep(q, { kind: 'fold', proj: row }, at2);
        });
    }),

    joinLateral: () => fn('joinLateral', (rightFn, at, ctx) => {
        if (!isApplicable(rightFn)) {
            ctx.diagnostics.push({ node: at ?? rightFn.ast, message: `joinLateral expects a function l => query as its first argument` });
            return ERROR;
        }
        return fn('joinLateral', (on, at2, ctx2) => {
            if (!isApplicable(on)) {
                ctx2.diagnostics.push({ node: at2 ?? on.ast, message: `joinLateral 'on' must be a two-argument function (curried)` });
                return ERROR;
            }
            return fn('joinLateral', (merger, at3, ctx3) => {
                if (!isApplicable(merger)) {
                    ctx3.diagnostics.push({ node: at3 ?? merger.ast, message: `joinLateral 'merger' must be a two-argument function (curried)` });
                    return ERROR;
                }
                return step('joinLateral', (q, at4, ctx4) => {
                    const leftRow = rowRecord(q, at4);
                    const right = applyWith(rightFn, leftRow, at4, ctx4);
                    if (isError(right) || right.kind !== 'query') {
                        if (!isError(right)) ctx4.diagnostics.push({ node: at4 ?? rightFn.ast, message: `joinLateral right side must evaluate to a query, got ${describe(right)}` });
                        return null;
                    }
                    const baseAlias = right.query.name ?? (right.query.root.name.split('.').at(-1) ?? right.query.root.name);
                    let alias = baseAlias;
                    let suffix = 1;
                    while (q.aliases.includes(alias)) alias = `${baseAlias}_${suffix++}`;
                    const rightSchema: Schema = new Map(
                        [...querySchema(right.query)].map(([key, col]) => [key, { type: col.type, table: alias }]),
                    );
                    const rightQuery: Query = { ...right.query, root: { ...right.query.root, schema: rightSchema }, aliases: [alias] };
                    const rightRow: Value = { kind: 'record', schema: rightSchema, open: !right.query.known, defaultTable: alias, fields: [], ast: at4 };

                    const on1 = applyWith(on, leftRow, at4, ctx4);
                    if (isError(on1) || !isApplicable(on1)) {
                        ctx4.diagnostics.push({ node: at4 ?? on.ast, message: `joinLateral 'on' must be a two-argument function (curried)` });
                        return null;
                    }
                    const onVal = applyWith(on1, rightRow, at4, ctx4);
                    const onNode = exprNode(onVal);
                    if (!onNode || (onNode.type !== 'bool' && onNode.type !== 'unknown')) {
                        ctx4.diagnostics.push({ node: at4 ?? on.ast, message: `joinLateral 'on' condition must be a boolean expression, got ${onNode ? `type ${typeName(onNode.type)}` : describe(onVal)}` });
                        return null;
                    }
                    if (forbid(onNode, ['agg', 'group', 'order', 'window'], 'the joinLateral condition', at4 ?? on.ast, ctx4)) return null;

                    const m1 = applyWith(merger, leftRow, at4, ctx4);
                    if (isError(m1) || !isApplicable(m1)) {
                        ctx4.diagnostics.push({ node: at4 ?? merger.ast, message: `joinLateral 'merger' must be a two-argument function (curried)` });
                        return null;
                    }
                    const mv = applyWith(m1, rightRow, at4, ctx4);
                    if (isError(mv)) return null;
                    const proj = rowFromRecord(mv, at4, ctx4, 'joinLateral merger');
                    if (!proj) return null;
                    if (proj.fields.length === 0) {
                        ctx4.diagnostics.push({ node: at4 ?? merger.ast, message: `joinLateral merger must produce a record with at least one field` });
                        return null;
                    }
                    const next: Query = { ...q, aliases: [...q.aliases, alias] };
                    return addStep(next, { kind: 'join', joinKind: 'inner', right: rightQuery, on: onNode, proj, lateral: true }, at4);
                });
            });
        });
    }),

    joinInner: joinBuiltin('joinInner', 'inner'),
    joinLeft: joinBuiltin('joinLeft', 'left'),
    joinRight: joinBuiltin('joinRight', 'right'),
    joinFull: joinBuiltin('joinFull', 'full'),

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
    countWhere: aggWhereBuiltin('countWhere', 'any'),
    sumWhere: aggWhereBuiltin('sumWhere', 'numeric'),
    avgWhere: aggWhereBuiltin('avgWhere', 'numeric'),
    minWhere: aggWhereBuiltin('minWhere', 'any'),
    maxWhere: aggWhereBuiltin('maxWhere', 'any'),
    countDistinct: () => fn('countDistinct', (arg, at, ctx) => {
        const node = exprNode(arg);
        if (!node) {
            ctx.diagnostics.push({ node: at ?? arg.ast, message: `countDistinct expects an expression, e.g. countDistinct o.status` });
            return ERROR;
        }
        if (node.kind === 'agg' || node.kind === 'group' || node.kind === 'order' || node.kind === 'window') {
            ctx.diagnostics.push({ node: at ?? arg.ast, message: `countDistinct cannot wrap ${kindLabel(node.kind)}` });
            return ERROR;
        }
        return mkExpr({ kind: 'agg', name: 'countDistinct', arg: node, type: 'int' }, at);
    }),
    count: aggBuiltin('count', 'any'),
    sum: aggBuiltin('sum', 'numeric'),
    avg: aggBuiltin('avg', 'numeric'),
    min: aggBuiltin('min', 'any'),
    max: aggBuiltin('max', 'any'),
    array: aggBuiltin('array', 'any'),
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
    scalar: () => fn('scalar', (arg, at, ctx) => {
        if (arg.kind !== 'query') {
            ctx.diagnostics.push({ node: at ?? arg.ast, message: `scalar expects a query, e.g. scalar (orders & map (o => { max_id = max o.id })) — got ${describe(arg)}` });
            return ERROR;
        }
        const schema = [...querySchema(arg.query).values()];
        if (schema.length !== 1) {
            ctx.diagnostics.push({ node: at ?? arg.ast, message: `scalar subquery must return exactly one column, got ${schema.length} columns` });
            return ERROR;
        }
        return mkExpr({ kind: 'scalar', query: arg.query, type: schema[0]!.type }, at);
    }),
    exists: () => fn('exists', (arg, at, ctx) => {
        if (arg.kind !== 'query') {
            ctx.diagnostics.push({ node: at ?? arg.ast, message: `exists expects a query, e.g. exists (orders & filter (o => o.user_id == u.id)) — got ${describe(arg)}` });
            return ERROR;
        }
        return mkExpr({ kind: 'exists', query: arg.query, type: 'bool' }, at);
    }),
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
    isIn: inBuiltin(false),
    isNotIn: inBuiltin(true),
    inQuery: inQueryBuiltin(false),
    notInQuery: inQueryBuiltin(true),

    // --- string & scalar functions --------------------------------------
    // `abs`/`ceil`/`floor`/`sqrt` live in base/sql.tetaue (Num-constrained
    // sql_func definitions).
    coalesce: () => fn('coalesce', (arg1, at1, ctx) => {
        // Variadic list form: coalesce [a, b, c].
        if (arg1.kind === 'list') {
            if (arg1.items.length < 2) {
                ctx.diagnostics.push({ node: at1 ?? arg1.ast, message: `coalesce expects at least two expressions, e.g. coalesce [u.nickname, u.email]` });
                return ERROR;
            }
            const nodes: SqlNode[] = [];
            let resultType: TypeOrNull = 'null';
            for (const item of arg1.items) {
                const node = exprNode(item);
                if (!node) {
                    ctx.diagnostics.push({ node: item.ast ?? at1, message: `coalesce list items must be expressions, got ${describe(item)}` });
                    return ERROR;
                }
                if (node.kind === 'agg' || node.kind === 'group' || node.kind === 'order' || node.kind === 'window') {
                    ctx.diagnostics.push({ node: item.ast ?? at1, message: `coalesce cannot wrap ${kindLabel(node.kind)}` });
                    return ERROR;
                }
                if (resultType === 'null') resultType = node.type;
                if (node.type !== 'null' && resultType !== 'null' && !comparable(resultType, node.type)) {
                    ctx.diagnostics.push({ node: item.ast ?? at1, message: `coalesce requires matching types, got ${typeName(resultType)} and ${typeName(node.type)}` });
                    return ERROR;
                }
                nodes.push(node);
            }
            return mkExpr({ kind: 'call', name: 'coalesce', args: nodes, type: resultType === 'null' ? 'string' : resultType as SqlType }, at1);
        }
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
    date: () => fn('date', (arg, at, ctx) => {
        const value = stringValue(arg);
        if (value === null || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
            ctx.diagnostics.push({ node: at ?? arg.ast, message: `date expects an ISO date string literal (YYYY-MM-DD), e.g. date "2024-01-01"` });
            return ERROR;
        }
        return mkExpr({ kind: 'date-literal', value, type: 'date' }, at);
    }),
    timestamp: () => fn('timestamp', (arg, at, ctx) => {
        const value = stringValue(arg);
        // ISO-8601-ish: date + space/T + HH:MM:SS with optional fraction and
        // timezone. Conservative enough to reject typos while accepting the
        // dialect TIMESTAMP literal forms.
        const validTimestamp = value !== null
            && /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?$/.test(value);
        if (!validTimestamp) {
            ctx.diagnostics.push({ node: at ?? arg.ast, message: `timestamp expects an ISO timestamp string literal, e.g. timestamp "2024-01-01 12:00:00"` });
            return ERROR;
        }
        return mkExpr({ kind: 'timestamp-literal', value, type: 'timestamp' }, at);
    }),
    // Zero-argument constants (SQL keywords, rendered bare — no parens).
    currentDate: () => mkExpr({ kind: 'current-date', type: 'date' }),
    currentTimestamp: () => mkExpr({ kind: 'current-timestamp', type: 'timestamp' }),

    // The monoid identity is type-directed: `<>` resolves it against the other
    // operand; an ascription resolves it through the schema/stamp decoders.
    mempty: () => ({ kind: 'mempty' }),

    // --- pure list combinators (the list.* namespace) --------------------
    // In-memory operations over `{ kind: 'list' }` values. These are the
    // Haskell base List vocabulary, kept separate from the SQL query steps
    // (which keep `map`/`filter`/`take`/`drop`/`fold`).
    list_map: () => fn('list.map', (f, at, ctx) => {
        if (!isApplicable(f)) {
            ctx.diagnostics.push({ node: at ?? f.ast, message: `list.map expects a function as its first argument, e.g. list.map (x => x + 1) [1, 2, 3]` });
            return ERROR;
        }
        return fn('list.map', (xs, at2, ctx2) => {
            if (xs.kind !== 'list') {
                ctx2.diagnostics.push({ node: at2 ?? xs.ast, message: `list.map expected a list, got ${describe(xs)}` });
                return ERROR;
            }
            const items: Value[] = [];
            for (const item of xs.items) {
                const mapped = applyWith(f, item, at2 ?? item.ast, ctx2);
                if (isError(mapped)) return ERROR;
                items.push(mapped);
            }
            return { kind: 'list', items, ast: at2 ?? xs.ast };
        });
    }),
    list_filter: () => fn('list.filter', (p, at, ctx) => {
        if (!isApplicable(p)) {
            ctx.diagnostics.push({ node: at ?? p.ast, message: `list.filter expects a predicate function, e.g. list.filter (x => x > 0) [1, -2, 3]` });
            return ERROR;
        }
        return fn('list.filter', (xs, at2, ctx2) => {
            if (xs.kind !== 'list') {
                ctx2.diagnostics.push({ node: at2 ?? xs.ast, message: `list.filter expected a list, got ${describe(xs)}` });
                return ERROR;
            }
            const items: Value[] = [];
            for (const item of xs.items) {
                const keep = applyWith(p, item, at2 ?? item.ast, ctx2);
                if (isError(keep)) return ERROR;
                if (truthyValue(keep)) items.push(item);
            }
            return { kind: 'list', items, ast: at2 ?? xs.ast };
        });
    }),
    list_fold: () => fn('list.fold', (f, at, ctx) => {
        if (!isApplicable(f)) {
            ctx.diagnostics.push({ node: at ?? f.ast, message: `list.fold expects a binary accumulator function (acc => x => acc'), e.g. list.fold (acc => x => acc + x) 0 xs` });
            return ERROR;
        }
        return fn('list.fold', (z, at2, ctx2) => fn('list.fold', (xs, at3, ctx3) => {
            if (xs.kind !== 'list') {
                ctx3.diagnostics.push({ node: at3 ?? xs.ast, message: `list.fold expected a list, got ${describe(xs)}` });
                return ERROR;
            }
            let acc = z;
            for (const item of xs.items) {
                const step = applyWith(f, acc, at3 ?? item.ast, ctx3);
                if (isError(step)) return ERROR;
                const next = applyWith(step, item, at3 ?? item.ast, ctx3);
                if (isError(next)) return ERROR;
                acc = next;
            }
            return acc;
        }));
    }),
    list_foldr: () => fn('list.foldr', (f, at, ctx) => {
        if (!isApplicable(f)) {
            ctx.diagnostics.push({ node: at ?? f.ast, message: `list.foldr expects a binary function (x => acc => acc'), e.g. list.foldr (x => acc => x + acc) 0 xs` });
            return ERROR;
        }
        return fn('list.foldr', (z, at2, ctx2) => fn('list.foldr', (xs, at3, ctx3) => {
            if (xs.kind !== 'list') {
                ctx3.diagnostics.push({ node: at3 ?? xs.ast, message: `list.foldr expected a list, got ${describe(xs)}` });
                return ERROR;
            }
            let acc = z;
            for (let i = xs.items.length - 1; i >= 0; i--) {
                const item = xs.items[i]!;
                const step = applyWith(f, item, at3 ?? item.ast, ctx3);
                if (isError(step)) return ERROR;
                const next = applyWith(step, acc, at3 ?? item.ast, ctx3);
                if (isError(next)) return ERROR;
                acc = next;
            }
            return acc;
        }));
    }),
    list_sum: () => fn('list.sum', (xs, at, ctx) => {
        if (xs.kind !== 'list') {
            ctx.diagnostics.push({ node: at ?? xs.ast, message: `list.sum expected a list, got ${describe(xs)}` });
            return ERROR;
        }
        return listNumericFold('+', 0, 'int', xs, at, ctx);
    }),
    list_product: () => fn('list.product', (xs, at, ctx) => {
        if (xs.kind !== 'list') {
            ctx.diagnostics.push({ node: at ?? xs.ast, message: `list.product expected a list, got ${describe(xs)}` });
            return ERROR;
        }
        return listNumericFold('*', 1, 'int', xs, at, ctx);
    }),
    list_length: () => fn('list.length', (xs, at, ctx) => {
        if (xs.kind !== 'list') {
            ctx.diagnostics.push({ node: at ?? xs.ast, message: `list.length expected a list, got ${describe(xs)}` });
            return ERROR;
        }
        return mkExpr(lit(xs.items.length, 'int'), at ?? xs.ast);
    }),
    list_reverse: () => fn('list.reverse', (xs, at, ctx) => {
        if (xs.kind !== 'list') {
            ctx.diagnostics.push({ node: at ?? xs.ast, message: `list.reverse expected a list, got ${describe(xs)}` });
            return ERROR;
        }
        return { kind: 'list', items: [...xs.items].reverse(), ast: at ?? xs.ast };
    }),
    list_concat: () => fn('list.concat', (xss, at, ctx) => {
        if (xss.kind !== 'list') {
            ctx.diagnostics.push({ node: at ?? xss.ast, message: `list.concat expected a list of lists, got ${describe(xss)}` });
            return ERROR;
        }
        const items: Value[] = [];
        for (const sub of xss.items) {
            if (sub.kind !== 'list') {
                ctx.diagnostics.push({ node: sub.ast ?? at, message: `list.concat expected a list of lists, got an element of ${describe(sub)}` });
                return ERROR;
            }
            items.push(...sub.items);
        }
        return { kind: 'list', items, ast: at ?? xss.ast };
    }),
    list_append: () => fn('list.append', (xs, at, ctx) => fn('list.append', (ys, at2, ctx2) => {
        if (xs.kind !== 'list' || ys.kind !== 'list') {
            ctx2.diagnostics.push({ node: at2 ?? xs.ast ?? ys.ast, message: `list.append expects two lists, got ${describe(xs)} and ${describe(ys)}` });
            return ERROR;
        }
        return { kind: 'list', items: [...xs.items, ...ys.items], ast: at2 ?? xs.ast };
    })),
    list_take: () => fn('list.take', (nArg, at, ctx) => {
        const n = numberValue(nArg);
        if (n === null || !Number.isInteger(n) || n < 0) {
            ctx.diagnostics.push({ node: at ?? nArg.ast, message: `list.take expects a non-negative integer, got ${n === null ? describe(nArg) : String(n)}` });
            return ERROR;
        }
        return fn('list.take', (xs, at2, ctx2) => {
            if (xs.kind !== 'list') {
                ctx2.diagnostics.push({ node: at2 ?? xs.ast, message: `list.take expected a list, got ${describe(xs)}` });
                return ERROR;
            }
            return { kind: 'list', items: xs.items.slice(0, n), ast: at2 ?? xs.ast };
        });
    }),
    list_drop: () => fn('list.drop', (nArg, at, ctx) => {
        const n = numberValue(nArg);
        if (n === null || !Number.isInteger(n) || n < 0) {
            ctx.diagnostics.push({ node: at ?? nArg.ast, message: `list.drop expects a non-negative integer, got ${n === null ? describe(nArg) : String(n)}` });
            return ERROR;
        }
        return fn('list.drop', (xs, at2, ctx2) => {
            if (xs.kind !== 'list') {
                ctx2.diagnostics.push({ node: at2 ?? xs.ast, message: `list.drop expected a list, got ${describe(xs)}` });
                return ERROR;
            }
            return { kind: 'list', items: xs.items.slice(n), ast: at2 ?? xs.ast };
        });
    }),
    list_head: () => fn('list.head', (xs, at, ctx) => {
        if (xs.kind !== 'list') {
            ctx.diagnostics.push({ node: at ?? xs.ast, message: `list.head expected a list, got ${describe(xs)}` });
            return ERROR;
        }
        if (xs.items.length === 0) {
            ctx.diagnostics.push({ node: at ?? xs.ast, message: `list.head of an empty list` });
            return ERROR;
        }
        return xs.items[0]!;
    }),
    list_last: () => fn('list.last', (xs, at, ctx) => {
        if (xs.kind !== 'list') {
            ctx.diagnostics.push({ node: at ?? xs.ast, message: `list.last expected a list, got ${describe(xs)}` });
            return ERROR;
        }
        if (xs.items.length === 0) {
            ctx.diagnostics.push({ node: at ?? xs.ast, message: `list.last of an empty list` });
            return ERROR;
        }
        return xs.items[xs.items.length - 1]!;
    }),
    list_null: () => fn('list.null', (xs, at, ctx) => {
        if (xs.kind !== 'list') {
            ctx.diagnostics.push({ node: at ?? xs.ast, message: `list.null expected a list, got ${describe(xs)}` });
            return ERROR;
        }
        return mkExpr(lit(xs.items.length === 0, 'bool'), at ?? xs.ast);
    }),
    list_elem: () => fn('list.elem', (target, at, ctx) => fn('list.elem', (xs, at2, ctx2) => {
        if (xs.kind !== 'list') {
            ctx2.diagnostics.push({ node: at2 ?? xs.ast, message: `list.elem expected a list, got ${describe(xs)}` });
            return ERROR;
        }
        for (const item of xs.items) {
            const eq = evalBinary('==', target, item, at2 ?? xs.ast ?? fallbackNode(ctx2), ctx2);
            if (isError(eq)) return ERROR;
            if (truthyValue(eq)) return mkExpr(lit(true, 'bool'), at2 ?? xs.ast);
        }
        return mkExpr(lit(false, 'bool'), at2 ?? xs.ast);
    })),

    // --- strings ----------------------------------------------------------
    reverse: stringFnBuiltin('reverse', 'string'),
    // --- closed Functor / Applicative / Alternative / Monad operations ----
    fmap: () => fn('fmap', (f, at, ctx) => {
        if (!isApplicable(f)) {
            ctx.diagnostics.push({ node: at ?? f.ast, message: `fmap expects a function as its first argument, e.g. fmap upper u.email — got ${describe(f)}` });
            return ERROR;
        }
        return fn('fmap', (m, at2, ctx2) => {
            if (m.kind === 'list') {
                const items: Value[] = [];
                for (const item of m.items) {
                    const mapped = applyWith(f, item, at2 ?? item.ast, ctx2);
                    if (isError(mapped)) return ERROR;
                    items.push(mapped);
                }
                return { kind: 'list', items, ast: at2 ?? m.ast };
            }
            if (m.kind === 'query') {
                const mapFn = applyWith(BUILTINS.map!(), f, at2 ?? m.ast, ctx2);
                if (isError(mapFn)) return ERROR;
                const mapped = applyWith(mapFn, m, at2 ?? m.ast, ctx2);
                return isError(mapped) ? ERROR : mapped;
            }
            const node = exprNode(m);
            if (!node) {
                ctx2.diagnostics.push({ node: at2 ?? m.ast, message: `fmap expects a maybe value, list, or query as its second argument, got ${describe(m)}` });
                return ERROR;
            }
            if (node.kind === 'agg' || node.kind === 'group' || node.kind === 'order' || node.kind === 'window') {
                ctx2.diagnostics.push({ node: at2 ?? m.ast, message: `fmap cannot lift ${kindLabel(node.kind)}` });
                return ERROR;
            }
            // SQL functions propagate NULL naturally, so applying f to the
            // expression is exactly the Maybe Functor law for this backend.
            if (node.kind === 'lit' && node.value === null) return mkExpr(node, at2 ?? m.ast);
            const lifted = applyWith(f, mkExpr(node, m.ast), at2 ?? m.ast, ctx2);
            if (isError(lifted)) return ERROR;
            const out = exprNode(lifted);
            if (!out) return ERROR;
            return sqlNodeReferences(out, node)
                ? mkExpr(out, at2 ?? m.ast)
                : nullableGuard('fmap', [m], lifted, at2 ?? m.ast, ctx2);
        });
    }),

    replaceWith: () => fn('replaceWith', (replacement, at, ctx) => fn('replaceWith', (mapped, at2, ctx2) => {
        if (mapped.kind === 'list') {
            return { kind: 'list', items: mapped.items.map(() => replacement), ast: at2 ?? mapped.ast };
        }
        if (mapped.kind === 'query') {
            const constant = fn('replaceWith', () => replacement);
            const mapFn = applyWith(BUILTINS.map!(), constant, at2 ?? mapped.ast, ctx2);
            if (isError(mapFn)) return ERROR;
            const result = applyWith(mapFn, mapped, at2 ?? mapped.ast, ctx2);
            return isError(result) ? ERROR : result;
        }
        return nullableGuard('replaceWith', [mapped], replacement, at2 ?? at, ctx2);
    })),

    ap: () => fn('ap', (functions, at, ctx) => fn('ap', (values, at2, ctx2) => {
        if (functions.kind === 'list' || values.kind === 'list') {
            if (functions.kind !== 'list' || values.kind !== 'list') {
                ctx2.diagnostics.push({ node: at2 ?? values.ast, message: `ap expects two values in the same Applicative container, got ${describe(functions)} and ${describe(values)}` });
                return ERROR;
            }
            const items: Value[] = [];
            for (const f of functions.items) {
                if (!isApplicable(f)) {
                    ctx2.diagnostics.push({ node: f.ast ?? at2, message: `ap list entries must be functions, got ${describe(f)}` });
                    return ERROR;
                }
                for (const value of values.items) {
                    const applied = applyWith(f, value, value.ast ?? at2, ctx2);
                    if (isError(applied)) return ERROR;
                    items.push(applied);
                }
            }
            return { kind: 'list', items, ast: at2 ?? values.ast };
        }
        const functionNode = exprNode(functions);
        if (functionNode?.kind === 'lit' && functionNode.value === null) return mkExpr(functionNode, at2 ?? at);
        if (!isApplicable(functions)) {
            ctx2.diagnostics.push({ node: at ?? functions.ast, message: `ap expects a function inside maybe as its first argument, got ${describe(functions)}` });
            return ERROR;
        }
        const valueNode = exprNode(values);
        if (!valueNode) {
            ctx2.diagnostics.push({ node: at2 ?? values.ast, message: `ap expects a maybe expression as its second argument, got ${describe(values)}` });
            return ERROR;
        }
        if (valueNode.kind === 'lit' && valueNode.value === null) return mkExpr(valueNode, at2 ?? values.ast);
        const applied = applyWith(functions, values, at2 ?? values.ast, ctx2);
        if (isError(applied)) return ERROR;
        return nullableGuard('ap', [values], applied, at2 ?? at, ctx2);
    })),

    applyLeft: sequenceBuiltin('applyLeft', 'left'),
    applyRight: sequenceBuiltin('applyRight', 'right'),

    orElse: () => fn('orElse', (left, at, ctx) => fn('orElse', (right, at2, ctx2) => {
        if (left.kind === 'list' || right.kind === 'list') {
            if (left.kind !== 'list' || right.kind !== 'list') {
                ctx2.diagnostics.push({ node: at2 ?? right.ast, message: `orElse expects two values in the same Alternative container, got ${describe(left)} and ${describe(right)}` });
                return ERROR;
            }
            return { kind: 'list', items: [...left.items, ...right.items], ast: at2 ?? at ?? right.ast ?? left.ast };
        }
        const leftNode = exprNode(left);
        const rightNode = exprNode(right);
        if (!leftNode || !rightNode) {
            ctx2.diagnostics.push({ node: at2 ?? at, message: `orElse expects two maybe expressions, got ${describe(left)} and ${describe(right)}` });
            return ERROR;
        }
        if (leftNode.kind === 'lit' && leftNode.value === null) return mkExpr(rightNode, at2 ?? right.ast);
        if (rightNode.kind === 'lit' && rightNode.value === null) return mkExpr(leftNode, at ?? left.ast);
        if (!comparable(leftNode.type, rightNode.type)) {
            ctx2.diagnostics.push({ node: at2 ?? right.ast, message: `orElse requires matching expression types, got ${typeName(leftNode.type)} and ${typeName(rightNode.type)}` });
            return ERROR;
        }
        const type = leftNode.type === 'null' ? rightNode.type : leftNode.type;
        if (type === 'null') return mkExpr(leftNode, at ?? left.ast);
        return mkExpr({ kind: 'call', name: 'coalesce', args: [leftNode, rightNode], type }, at2 ?? at);
    })),

    bind: () => fn('bind', (value, at, ctx) => fn('bind', (f, at2, ctx2) => {
        if (!isApplicable(f)) {
            ctx2.diagnostics.push({ node: at2 ?? f.ast, message: `bind expects a function as its second argument, got ${describe(f)}` });
            return ERROR;
        }
        if (value.kind === 'list') {
            const items: Value[] = [];
            for (const item of value.items) {
                const applied = applyWith(f, item, item.ast ?? at2, ctx2);
                if (isError(applied)) return ERROR;
                if (applied.kind !== 'list') {
                    ctx2.diagnostics.push({ node: item.ast ?? at2, message: `bind over a list requires the function to return a list, got ${describe(applied)}` });
                    return ERROR;
                }
                items.push(...applied.items);
            }
            return { kind: 'list', items, ast: at2 ?? value.ast };
        }
        const node = exprNode(value);
        if (!node) {
            ctx2.diagnostics.push({ node: at ?? value.ast, message: `bind expects a maybe expression or list, got ${describe(value)}` });
            return ERROR;
        }
        if (node.kind === 'lit' && node.value === null) return mkExpr(node, at ?? value.ast);
        const applied = applyWith(f, value, at2 ?? value.ast, ctx2);
        if (isError(applied)) return ERROR;
        return nullableGuard('bind', [value], applied, at2 ?? at, ctx2);
    })),

    then: sequenceBuiltin('then', 'right'),

    just: () => fn('just', (arg, at, ctx) => {
        if (isApplicable(arg)) return arg;
        const node = exprNode(arg);
        if (!node || node.type === 'null') {
            ctx.diagnostics.push({ node: at ?? arg.ast, message: `just expects a non-null expression, got ${node ? `type ${typeName(node.type)}` : describe(arg)}` });
            return ERROR;
        }
        if (forbid(node, ['agg', 'group', 'order', 'window'], 'just', at ?? arg.ast, ctx)) return ERROR;
        return mkExpr(node, at ?? arg.ast);
    }),
    nothing: () => mkExpr(lit(null, 'null')),

    fromMaybe: () => fn('fromMaybe', (def, at, ctx) => {
        const defaultNode = exprNode(def);
        if (!defaultNode) {
            ctx.diagnostics.push({ node: at ?? def.ast, message: `fromMaybe expects a default expression, e.g. fromMaybe "" u.nickname` });
            return ERROR;
        }
        return fn('fromMaybe', (m, at2, ctx2) => {
            const maybeNode = exprNode(m);
            if (!maybeNode) {
                ctx2.diagnostics.push({ node: at2 ?? m.ast, message: `fromMaybe expects a nullable expression, e.g. fromMaybe "" u.nickname` });
                return ERROR;
            }
            // Aggregates are allowed here: after a fold, fromMaybe over an
            // aggregate is a valid HAVING/SELECT expression (COALESCE(SUM(...),
            // default)). The enclosing filter/map step performs the positional
            // aggregate validation. Window expressions stay invalid.
            if (forbid(maybeNode, ['window'], 'fromMaybe', at2 ?? m.ast, ctx2)) return ERROR;
            if (forbid(defaultNode, ['window'], 'fromMaybe', at2 ?? m.ast, ctx2)) return ERROR;
            if (maybeNode.type !== 'null' && defaultNode.type !== 'null' && !comparable(maybeNode.type, defaultNode.type)) {
                ctx2.diagnostics.push({ node: at2 ?? m.ast, message: `fromMaybe requires matching types, got ${typeName(defaultNode.type)} and ${typeName(maybeNode.type)}` });
                return ERROR;
            }
            const t = maybeNode.type === 'null' ? defaultNode.type : maybeNode.type;
            return mkExpr({ kind: 'call', name: 'fromMaybe', args: [maybeNode, defaultNode], type: t === 'null' ? 'string' : t }, at2);
        });
    }),

    nullIf: () => fn('nullIf', (arg, at, ctx) => {
        const node = exprNode(arg);
        if (!node) {
            ctx.diagnostics.push({ node: at ?? arg.ast, message: `nullIf expects expressions, e.g. nullIf u.nickname ""` });
            return ERROR;
        }
        if (forbid(node, ['agg', 'group', 'order'], 'nullIf', at ?? arg.ast, ctx)) return ERROR;
        return fn('nullIf', (otherArg, at2, ctx2) => {
            const other = exprNode(otherArg);
            if (!other || !comparable(node.type, other.type)) {
                ctx2.diagnostics.push({ node: at2 ?? otherArg.ast, message: `nullIf requires matching types, got ${node.type === 'null' ? 'null' : typeName(node.type)} and ${other ? (other.type === 'null' ? 'null' : typeName(other.type)) : describe(otherArg)}` });
                return ERROR;
            }
            if (forbid(other, ['agg', 'group', 'order'], 'nullIf', at2 ?? otherArg.ast, ctx2)) return ERROR;
            const t = node.type === 'null' ? other.type : node.type;
            return mkExpr({ kind: 'call', name: 'nullIf', args: [node, other], type: t === 'null' ? 'string' : t }, at2);
        });
    }),
    isNull: () => fn('isNull', (arg, at, ctx) => {
        const node = exprNode(arg);
        if (!node) {
            ctx.diagnostics.push({ node: at ?? arg.ast, message: `isNull expects an expression, e.g. isNull u.nickname` });
            return ERROR;
        }
        if (forbid(node, ['agg', 'group', 'order'], 'isNull', at ?? arg.ast, ctx)) return ERROR;
        return mkExpr({ kind: 'is-null', expr: node, negated: false, type: 'bool' }, at);
    }),
    maybeIsJust: () => fn('isJust', (arg, at, ctx) => {
        const node = exprNode(arg);
        if (!node) {
            ctx.diagnostics.push({ node: at ?? arg.ast, message: `maybe.isJust expects an expression, e.g. maybe.isJust u.nickname` });
            return ERROR;
        }
        if (forbid(node, ['agg', 'group', 'order'], 'isJust', at ?? arg.ast, ctx)) return ERROR;
        // not (x IS NULL) — Data.Maybe's isJust over nullable SQL values.
        return mkExpr({ kind: 'is-null', expr: node, negated: true, type: 'bool' }, at);
    }),
    isTrue: truthPredicateBuiltin('isTrue'),
    isFalse: truthPredicateBuiltin('isFalse'),
    isUnknown: truthPredicateBuiltin('isUnknown'),

    // --- type conversion --------------------------------------------------
    cast: castBuiltin('cast'),
    // `tryCast` shares the `cast` implementation: only the IR node NAME
    // differs, and the renderer's lowering of that name is what turns it
    // into TRY_CAST (or the sqlite emulation).
    tryCast: castBuiltin('tryCast'),

    // --- generic SQL call builder (prelude lowering) --------------------
    // `sql_func name [args]` emits an uninterpreted SQL function call. The
    // source prelude branches on the hidden `sql_dialect` value and composes
    // dialect-specific lowerings from this primitive, so a per-function
    // dialect table does not need a new TS builtin per function.
    sql_func: () => fn('sql_func', (nameArg, at, ctx) => {
        const name = stringValue(nameArg);
        if (name === null || name.trim().length === 0) {
            ctx.diagnostics.push({ node: at ?? nameArg.ast, message: `sql_func expects a non-empty SQL function name string, e.g. sql_func "UPPER" [u.name]` });
            return ERROR;
        }
        return fn('sql_func', (argsArg, at2, ctx2) => {
            if (argsArg.kind !== 'list') {
                ctx2.diagnostics.push({ node: at2 ?? argsArg.ast, message: `sql_func expects a list of arguments, e.g. sql_func "UPPER" [u.name] — got ${describe(argsArg)}` });
                return ERROR;
            }
            const args: SqlNode[] = [];
            for (const item of argsArg.items) {
                const node = exprNode(item);
                if (!node) {
                    ctx2.diagnostics.push({ node: item.ast ?? at2, message: `sql_func arguments must be SQL expressions, got ${describe(item)}` });
                    return ERROR;
                }
                args.push(node);
            }
            return mkExpr({ kind: 'call', name, args, type: 'unknown' }, at2 ?? at);
        });
    }),

    sql_infix: () => fn('sql_infix', (opArg, at, ctx) => {
        const op = stringValue(opArg);
        if (op === null || op.trim().length === 0) {
            ctx.diagnostics.push({ node: at ?? opArg.ast, message: `sql_infix expects a non-empty SQL operator string, e.g. sql_infix "IN" n x` });
            return ERROR;
        }
        return fn('sql_infix', (leftArg, at2, ctx2) => fn('sql_infix', (rightArg, at3, ctx3) => {
            const left = exprNode(leftArg);
            const right = exprNode(rightArg);
            if (!left || !right) {
                ctx3.diagnostics.push({ node: at3 ?? leftArg.ast, message: `sql_infix operands must be SQL expressions, got ${describe(leftArg)} and ${describe(rightArg)}` });
                return ERROR;
            }
            // Numeric operators produce numeric SQL, comparisons produce bool.
            const t: SqlType = op === '/' || op === '*' || op === '+' || op === '-' || op === 'DIV' || op === 'MOD'
                ? (left.type === 'float' || right.type === 'float' || op === '/' ? 'float' : 'int')
                : 'bool';
            return mkExpr({ kind: 'bin', op, left, right, type: t }, at3 ?? at);
        }));
    }),

    // `sql_fragment template [args]` — an uninterpreted SQL FRAGMENT. The
    // template's literal text is emitted with each `{}` replaced by the
    // corresponding rendered argument, which is what lets a library
    // definition express the shapes the function/infix primitives cannot
    // (`INTERVAL 7 DAY`, `INTERVAL '-7' DAY`, `(-7)`).
    sql_fragment: () => fn('sql_fragment', (templateArg, at, ctx) => {
        const template = stringValue(templateArg);
        if (template === null || template.trim().length === 0) {
            ctx.diagnostics.push({ node: at ?? templateArg.ast, message: `sql_fragment expects a non-empty SQL template string, e.g. sql_fragment "INTERVAL {} DAY" [x]` });
            return ERROR;
        }
        return fn('sql_fragment', (argsArg, at2, ctx2) => {
            if (argsArg.kind !== 'list') {
                ctx2.diagnostics.push({ node: at2 ?? argsArg.ast, message: `sql_fragment expects a list of arguments, e.g. sql_fragment "INTERVAL {} DAY" [x] — got ${describe(argsArg)}` });
                return ERROR;
            }
            const args: SqlNode[] = [];
            for (const item of argsArg.items) {
                const node = exprNode(item);
                if (!node) {
                    ctx2.diagnostics.push({ node: item.ast ?? at2, message: `sql_fragment arguments must be SQL expressions, got ${describe(item)}` });
                    return ERROR;
                }
                args.push(node);
            }
            // The hole count is part of the contract: a template with a
            // different number of `{}` than arguments would emit SQL with a
            // hole left over (or an argument dropped), so it is a diagnostic
            // rather than a silent truncation.
            const holes = fragmentHoles(template);
            if (holes !== args.length) {
                ctx2.diagnostics.push({
                    node: at2 ?? argsArg.ast,
                    message: `sql_fragment template has ${holes} \`{}\` hole(s) but ${args.length} argument(s), e.g. sql_fragment "INTERVAL {} DAY" [x]`,
                });
                return ERROR;
            }
            return mkExpr({ kind: 'fragment', template, args, type: 'unknown' }, at2 ?? at);
        });
    }),

    sql_cast: () => fn('sql_cast', (valueArg, at, ctx) => {
        const value = exprNode(valueArg);
        if (!value) {
            ctx.diagnostics.push({ node: at ?? valueArg.ast, message: `sql_cast expects a value expression and a target type, e.g. sql_cast x "int"` });
            return ERROR;
        }
        return fn('sql_cast', (typeArg, at2, ctx2) => {
            const type = stringValue(typeArg);
            if (type === null || !(CAST_TYPES as readonly string[]).includes(type)) {
                ctx2.diagnostics.push({ node: at2 ?? typeArg.ast, message: `sql_cast expects a target type as a string literal — one of: ${CAST_TYPES.join(', ')}` });
                return ERROR;
            }
            // Same IR node as the `cast` builtin, so the renderer's existing
            // per-dialect CAST lowering applies.
            return mkExpr({ kind: 'call', name: 'cast', args: [value, lit(type, 'string')], type: type as SqlType }, at2 ?? at);
        });
    }),

    sql_try_cast: () => fn('sql_try_cast', (valueArg, at, ctx) => {
        const value = exprNode(valueArg);
        if (!value) {
            ctx.diagnostics.push({ node: at ?? valueArg.ast, message: `sql_try_cast expects a value expression and a target type, e.g. sql_try_cast x "int"` });
            return ERROR;
        }
        return fn('sql_try_cast', (typeArg, at2, ctx2) => {
            const type = stringValue(typeArg);
            if (type === null || !(CAST_TYPES as readonly string[]).includes(type)) {
                ctx2.diagnostics.push({ node: at2 ?? typeArg.ast, message: `sql_try_cast expects a target type as a string literal — one of: ${CAST_TYPES.join(', ')}` });
                return ERROR;
            }
            // Same IR node as the `tryCast` builtin, so the renderer's
            // TRY_CAST lowering (and the sqlite emulation) applies.
            return mkExpr({ kind: 'call', name: 'tryCast', args: [value, lit(type, 'string')], type: type as SqlType }, at2 ?? at);
        });
    }),

    sql_bare: () => fn('sql_bare', (wordArg, at, ctx) => {
        const word = stringValue(wordArg);
        if (word === null || word.trim().length === 0 || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(word)) {
            ctx.diagnostics.push({ node: at ?? wordArg.ast, message: `sql_bare expects a plain SQL word, e.g. sql_bare "YEAR"` });
            return ERROR;
        }
        // A bare SQL word (EXTRACT(YEAR FROM x) needs YEAR, not 'YEAR').
        return mkExpr({ kind: 'bare', name: word, type: 'unknown' }, at);
    }),

    // `sql_error message` — reject a library definition at analysis time.
    //
    // A definition that dispatches on a compile-time name (`extract x
    // "month"`, `dateAdd x "day" 7`) reaches this from its fallback arm when
    // the name is not one it knows. The diagnostic is reported, so a typo is
    // an error rather than silently-lowered wrong SQL, and the set of valid
    // names stays where the dispatch is: in the library.
    sql_error: () => fn('sql_error', (messageArg, at, ctx) => {
        const message = stringValue(messageArg);
        ctx.diagnostics.push({
            node: at ?? messageArg.ast,
            message: message ?? 'sql_error expects a message string',
        });
        // The result is an expression node WITHOUT a value type: an error arm
        // sits beside the arms that produce real SQL, and case arms must agree
        // on a type, so a concrete type here would make every dispatch that
        // can fail a spurious "case requires matching value types".
        return mkExpr({ kind: 'bare', name: 'NULL', type: 'unknown' }, at);
    }),

    // `sql_literal x` — the SQL text of a LITERAL argument, or "".
    //
    // This is the only introspection in the lowering vocabulary: a library
    // definition sees values rather than syntax, so this is how the date
    // layer tells `dateAdd x "day" 7` (which every dialect can embed as a
    // native literal modifier, `INTERVAL 7 DAY`) from `dateAdd x "day" u.n`
    // (which must be parenthesized or wrapped as an expression). The result
    // is a plain tetaue string the library branches on — never a SQL node —
    // so it widens what a library definition can DECIDE without widening
    // what it can EMIT.
    //
    // The text is unquoted (`-7` for the literal `-7`). A caller that needs
    // it inside SQL passes it to `sql_func`/`sql_bare`, which quote or
    // interpolate it like any other string.
    sql_literal: () => fn('sql_literal', (arg) => {
        const node = exprNode(arg);
        const text = node?.kind === 'lit' && typeof node.value === 'number'
            ? String(node.value)
            : '';
        return mkExpr(lit(text, 'string'));
    }),

    // `sql_literal_amount x scale` — the signed SQL text of a literal amount.
    //
    // The date layer's sqlite branch needs the modifier `'-7 days'`: SQL signs
    // a positive interval amount explicitly, and tetaue strings cannot be
    // assembled from parts, so the number-to-text step has to happen here.
    // `scale` folds a week amount into days (the one piece of arithmetic that
    // branch needs). A computed argument reports "" so the library can pick
    // the PRINTF form instead.
    sql_literal_amount: () => fn('sql_literal_amount', (arg) => fn('sql_literal_amount', (scaleArg) => {
        const node = exprNode(arg);
        const scale = exprNode(scaleArg);
        if (node?.kind !== 'lit' || typeof node.value !== 'number') return mkExpr(lit('', 'string'));
        const factor = scale?.kind === 'lit' && typeof scale.value === 'number' ? scale.value : 1;
        const value = node.value * factor;
        return mkExpr(lit(`${value >= 0 ? '+' : ''}${value}`, 'string'));
    })),

    // --- list-argument builtins (homogeneous variadic) -------------------
    // concat [a, b], greatest [a, b], least [a, b] take a single list
    // argument — the sound encoding for variadic functions with ONE element
    // type. LIST_BUILTINS owns the element-kind and arity validation.
    concat: listBuiltin('concat'),
    greatest: listBuiltin('greatest'),
    least: listBuiltin('least'),

    // --- heterogeneous-argument builtins (curried) ------------------------
    // round, substring, lpad/rpad, lag/lead have arguments of DIFFERENT
    // types (a list cannot type them soundly), so they are ordinary curried
    // functions. An argument is `maybe`-typed only when omitting it changes
    // the meaning (substring's length = to the end, lag's default = NULL);
    // args SQL merely defaults are required: `round u.x 0`,
    // `substring u.name 1 (just 3)`, `lpad u.code 8 "0"`,
    // `lag u.salary 1 nothing`.
    round: roundBuiltin(),
    substring: substringBuiltin(),
    lpad: padBuiltin('lpad'),
    rpad: padBuiltin('rpad'),

    // --- window functions ------------------------------------------------
    // Window-only functions must be wrapped in `over (...)` — a bare
    // `rowNumber` in a projection is an error (see validateWindowUses).
    // `sum u.x`, `avg u.x`, ... become windowed aggregates via over too.
    over: () => fn('over', (fnArg, at, ctx) => {
        const fnNode = exprNode(fnArg);
        // Window functions are aggregates (sum, avg, ...) or the window-only
        // ranking/offset functions — never plain scalar calls like upper.
        const ok = fnNode !== null && (fnNode.kind === 'agg' || (fnNode.kind === 'call' && WINDOW_ONLY.has(fnNode.name)));
        if (!ok) {
            // A bare `over lag u.salary 1 0 {...}` — the application
            // flattens, so the first argument arrives as a function — hint at
            // wrapping multi-argument window functions in parens.
            const hint = fnArg.kind === 'fn'
                ? ` — wrap it in parens when it takes arguments, e.g. over (${fnArg.name} u.x 1 nothing) { partition = [u.dept], order = [desc u.salary] }`
                : '';
            ctx.diagnostics.push({ node: at ?? fnArg.ast, message: `over expects a window function (rowNumber, rank, sum, lag, ...), got ${fnNode ? `an expression of type ${typeName(fnNode.type)}` : describe(fnArg)}${hint}` });
            return ERROR;
        }
        if (forbid(fnNode!, ['window'], 'over', at ?? fnArg.ast, ctx)) return ERROR;
        return fn('over', (specArg, at2, ctx2) => {
            const spec = windowSpec(specArg, at2, ctx2);
            if (spec === null) return ERROR;
            return mkExpr({ kind: 'window', fn: fnNode!, partition: spec.partition, order: spec.order, frame: spec.frame, type: fnNode!.type as SqlType }, at2);
        });
    }),
    rowNumber: () => mkExpr({ kind: 'call', name: 'rowNumber', args: [], type: 'int' }),
    rank: () => mkExpr({ kind: 'call', name: 'rank', args: [], type: 'int' }),
    denseRank: () => mkExpr({ kind: 'call', name: 'denseRank', args: [], type: 'int' }),
    percentRank: () => mkExpr({ kind: 'call', name: 'percentRank', args: [], type: 'int' }),
    ntile: () => fn('ntile', (arg, at, ctx) => {
        const node = exprNode(arg);
        if (!node || (!isNumeric(node.type) && node.type !== 'unknown')) {
            ctx.diagnostics.push({ node: at ?? arg.ast, message: `ntile expects a numeric bucket count, got ${node ? `type ${typeName(node.type)}` : describe(arg)}` });
            return ERROR;
        }
        if (forbid(node, ['agg', 'group', 'order', 'window'], 'ntile', at ?? arg.ast, ctx)) return ERROR;
        return mkExpr({ kind: 'call', name: 'ntile', args: [node], type: 'int' }, at);
    }),
    lag: lagLeadBuiltin('lag'),
    lead: lagLeadBuiltin('lead'),
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
            const v = applyWith(pred, rowRecord(q, at2), at2, ctx2);
            const node = exprNode(v);
            if (!node || (node.type !== 'bool' && node.type !== 'unknown')) {
                ctx2.diagnostics.push({ node: at2 ?? pred.ast, message: `${name} predicate must be a boolean expression, got ${node ? `type ${typeName(node.type)}` : describe(v)}` });
                return null;
            }
            // After fold the predicate becomes HAVING, where aggregates are allowed.
            const forbidden: SqlNode['kind'][] = having ? ['order', 'window'] : ['agg', 'group', 'order', 'window'];
            if (forbid(node, forbidden, `the ${name} predicate`, at2 ?? pred.ast, ctx2)) return null;
            return addStep(q, { kind: 'filter', cond: node, having }, at2);
        });
    });
}

function aggWhereBuiltin(name: string, numeric: 'numeric' | 'any'): () => Value {
    return () => fn(name, (cond, at, ctx) => {
        const condNode = exprNode(cond);
        if (!condNode || (condNode.type !== 'bool' && condNode.type !== 'unknown')) {
            ctx.diagnostics.push({ node: at ?? cond.ast, message: `${name} expects a boolean condition, e.g. ${name} (o.status == "paid") o.total` });
            return ERROR;
        }
        if (forbid(condNode, ['agg', 'group', 'order', 'window'], name, at ?? cond.ast, ctx)) return ERROR;
        return fn(name, (arg, at2, ctx2) => {
            const node = exprNode(arg);
            if (!node) {
                ctx2.diagnostics.push({ node: at2 ?? arg.ast, message: `${name} expects an expression to aggregate` });
                return ERROR;
            }
            if (numeric === 'numeric' && !isNumeric(node.type) && node.type !== 'unknown') {
                ctx2.diagnostics.push({ node: at2 ?? arg.ast, message: `${name} expects a numeric expression, got type ${typeName(node.type)}` });
                return ERROR;
            }
            if (node.kind === 'agg' || node.kind === 'group' || node.kind === 'order' || node.kind === 'window') {
                ctx2.diagnostics.push({ node: at2 ?? arg.ast, message: `${name} cannot wrap ${kindLabel(node.kind)}` });
                return ERROR;
            }
            let type: SqlType = node.type as SqlType;
            if (name === 'countWhere') type = 'int';
            if (name === 'avgWhere') type = 'float';
            return mkExpr({ kind: 'agg', name, arg: node, filter: condNode, type }, at2);
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
        if (name === 'array') type = 'array';
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

/** True for expressions that carry a date or timestamp value. */
function dateLike(node: SqlNode): boolean {
    return node.type === 'date' || node.type === 'timestamp' || node.type === 'unknown';
}

// ---------------------------------------------------------------------------
// Scalar builtins (math, string, logical, null handling, casts) — following
// teta's general SQL function set; render.ts owns the per-dialect lowering.
// ---------------------------------------------------------------------------

/** `cast x "int"` — target type as a string literal. */
/** `cast x "int"` / `tryCast x "int"` — target type as a string literal. */
function castBuiltin(name: 'cast' | 'tryCast'): () => Value {
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
// Many-argument builtins.
//
// concat, greatest, least are HOMOGENEOUS variadic functions: their list
// argument (`concat [a, b]`) types exactly what they consume, which is the
// sound pure-functional encoding. LIST_BUILTINS owns their element-kind and
// arity validation.
//
// round, substring, lpad/rpad, lag/lead have heterogeneous arguments — a
// list cannot express `[string, int, ...]` — so they are ordinary curried
// functions typed position by position. Only the positions whose OMISSION
// changes the meaning are `maybe` (substring's length = to the end, lag's
// default = NULL); args SQL merely defaults are required. render.ts lowers
// the resulting call nodes.
// ---------------------------------------------------------------------------

/** A list-argument builtin's env value: apply the one list argument. */
function listBuiltin(name: string): () => Value {
    return () => fn(name, (arg, at, ctx) => {
        if (arg.kind !== 'list') {
            ctx.diagnostics.push({ node: at ?? arg.ast, message: `${name} expects a list argument, e.g. ${listExample(name)}` });
            return ERROR;
        }
        const spec = LIST_BUILTINS[name]!;
        if (arg.items.length < spec.min || arg.items.length > spec.max) {
            ctx.diagnostics.push({ node: at ?? arg.ast, message: `${name} expects ${spec.min}${spec.max === Infinity ? ' or more' : ` to ${spec.max}`} arguments, got ${arg.items.length}` });
            return ERROR;
        }
        return spec.apply(arg.items, at, ctx);
    });
}

function listExample(name: string): string {
    switch (name) {
        case 'concat': return 'concat [u.first, u.last]';
        case 'greatest': return 'greatest [u.a, u.b]';
        case 'least': return 'least [u.a, u.b]';
    }
    return `${name} [a, b]`;
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
        // An unresolved `mempty` in an expression list resolves to the
        // string identity (the concrete default instance).
        const resolved = a.kind === 'mempty' ? mkExpr(lit('', 'string'), a.ast) : a;
        const node = exprNode(resolved);
        const ok = node !== null && (kind === 'any'
            ? true
            : kind === 'numeric'
                ? isNumeric(node.type) || node.type === 'unknown'
                : kind === 'string'
                    ? node.type === 'string' || node.type === 'unknown'
                    : dateLike(node));
        if (!ok) {
            const want = kind === 'numeric' ? 'numeric' : kind === 'string' ? 'string' : 'date or timestamp';
            ctx.diagnostics.push({ node: at ?? a.ast, message: `${what} expects ${want} expressions, got ${node ? `type ${typeName(node.type)}` : describe(resolved)}` });
            return null;
        }
        if (forbid(node, ['agg', 'group', 'order'], what, at ?? a.ast, ctx)) return null;
        nodes.push(node);
    }
    return nodes;
}

const LIST_BUILTINS: Readonly<Record<string, { min: number; max: number; apply: (args: Value[], at: AstNode | undefined, ctx: Ctx) => Value }>> = {
    concat: {
        min: LIST_ARITY.concat![0], max: LIST_ARITY.concat![1],
        apply: (args, at, ctx) => {
            const nodes = exprArgs(args, 'concat', 'string', at, ctx);
            if (nodes === null) return ERROR;
            return mkExpr({ kind: 'call', name: 'concat', args: nodes, type: 'string' }, at);
        },
    },
    greatest: {
        min: LIST_ARITY.greatest![0], max: LIST_ARITY.greatest![1],
        apply: (args, at, ctx) => listExtremum('greatest', args, at, ctx),
    },
    least: {
        min: LIST_ARITY.least![0], max: LIST_ARITY.least![1],
        apply: (args, at, ctx) => listExtremum('least', args, at, ctx),
    },
};

/** greatest/least — all arguments must share a comparable type. */
function listExtremum(name: 'greatest' | 'least', args: Value[], at: AstNode | undefined, ctx: Ctx): Value {
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

// ---------------------------------------------------------------------------
// Curried builtins with heterogeneous arguments.
// round, substring, lpad/rpad, lag/lead are curried position by position.
// A trailing argument is `maybe`-typed ONLY when omitting it changes the
// meaning (substring's length = to the end; lag's default = NULL); arguments
// that SQL merely gives a default value are REQUIRED, so the caller writes
// the default explicitly. Every message below mirrors the corresponding
// static diagnostic in inference.ts (argError / postCheckArg) so the merged
// checker diagnostics dedupe to one.
// ---------------------------------------------------------------------------

/**
 * Resolve a `maybe`-typed optional argument: `nothing` (a NULL literal)
 * omits the argument; any other expression supplies it. Returns 'omit',
 * the expression node, or null (a diagnostic was pushed).
 */
function maybeOpt(v: Value, what: string, at: AstNode | undefined, ctx: Ctx): SqlNode | 'omit' | null {
    const node = exprNode(v);
    if (!node) {
        ctx.diagnostics.push({ node: at ?? v.ast, message: `${what} expects its optional argument as maybe (nothing to omit, just x to supply), got ${describe(v)}` });
        return null;
    }
    return node.type === 'null' ? 'omit' : node;
}

/** round x scale — the scale is required (SQL's ROUND(x) means scale 0). */
function roundBuiltin(): () => Value {
    return () => fn('round', (x, at, ctx) => {
        const value = exprNode(x);
        if (!value || (!isNumeric(value.type) && value.type !== 'unknown')) {
            ctx.diagnostics.push({ node: at ?? x.ast, message: `round expects a numeric expression, got ${value ? `type ${typeName(value.type)}` : describe(x)}` });
            return ERROR;
        }
        if (forbid(value, ['agg', 'group', 'order'], 'round', at ?? x.ast, ctx)) return ERROR;
        return fn('round', (scale, at2, ctx2) => {
            const scaleNode = exprNode(scale);
            if (!scaleNode || (!isNumeric(scaleNode.type) && scaleNode.type !== 'unknown')) {
                ctx2.diagnostics.push({ node: at2 ?? scale.ast, message: `round expects a numeric scale, got ${scaleNode ? `type ${typeName(scaleNode.type)}` : describe(scale)}` });
                return ERROR;
            }
            if (forbid(scaleNode, ['agg', 'group', 'order'], 'round', at2 ?? scale.ast, ctx2)) return ERROR;
            return mkExpr({ kind: 'call', name: 'round', args: [value, scaleNode], type: value.type as SqlType }, at2);
        });
    });
}

/** substring s (maybe length) — start required, length optional (to the end). */
function substringBuiltin(): () => Value {
    return () => fn('substring', (s, at, ctx) => {
        const value = exprNode(s);
        if (!value || (value.type !== 'string' && value.type !== 'unknown')) {
            ctx.diagnostics.push({ node: at ?? s.ast, message: `substring expects a string expression, got ${value ? `type ${typeName(value.type)}` : describe(s)}` });
            return ERROR;
        }
        if (forbid(value, ['agg', 'group', 'order'], 'substring', at ?? s.ast, ctx)) return ERROR;
        return fn('substring', (start, at2, ctx2) => {
            const startNode = exprNode(start);
            if (!startNode || (!isNumeric(startNode.type) && startNode.type !== 'unknown')) {
                ctx2.diagnostics.push({ node: at2 ?? start.ast, message: `substring expects a numeric start position, got ${startNode ? `type ${typeName(startNode.type)}` : describe(start)}` });
                return ERROR;
            }
            if (forbid(startNode, ['agg', 'group', 'order'], 'substring', at2 ?? start.ast, ctx2)) return ERROR;
            return fn('substring', (len, at3, ctx3) => {
                const lenNode = maybeOpt(len, 'substring', at3, ctx3);
                if (lenNode === null) return ERROR;
                if (lenNode !== 'omit') {
                    if (!isNumeric(lenNode.type) && lenNode.type !== 'unknown') {
                        ctx3.diagnostics.push({ node: at3 ?? len.ast, message: `substring expects its optional length as maybe int, e.g. substring u.name 1 nothing or substring u.name 1 (just 3)` });
                        return ERROR;
                    }
                    if (forbid(lenNode, ['agg', 'group', 'order'], 'substring', at3 ?? len.ast, ctx3)) return ERROR;
                }
                const args = lenNode === 'omit' ? [value, startNode] : [value, startNode, lenNode];
                return mkExpr({ kind: 'call', name: 'substring', args, type: 'string' }, at3);
            });
        });
    });
}

/** lpad/rpad — value, length, padding (required; SQL's default pad is a space). */
function padBuiltin(name: 'lpad' | 'rpad'): () => Value {
    return () => fn(name, (s, at, ctx) => {
        const value = exprNode(s);
        if (!value || (value.type !== 'string' && value.type !== 'unknown')) {
            ctx.diagnostics.push({ node: at ?? s.ast, message: `${name} expects a string expression, got ${value ? `type ${typeName(value.type)}` : describe(s)}` });
            return ERROR;
        }
        if (forbid(value, ['agg', 'group', 'order'], name, at ?? s.ast, ctx)) return ERROR;
        return fn(name, (n, at2, ctx2) => {
            const length = exprNode(n);
            if (!length || (!isNumeric(length.type) && length.type !== 'unknown')) {
                ctx2.diagnostics.push({ node: at2 ?? n.ast, message: `${name} expects a numeric length, got ${length ? `type ${typeName(length.type)}` : describe(n)}` });
                return ERROR;
            }
            if (forbid(length, ['agg', 'group', 'order'], name, at2 ?? n.ast, ctx2)) return ERROR;
            return fn(name, (pad, at3, ctx3) => {
                const padNode = exprNode(pad);
                if (!padNode || (padNode.type !== 'string' && padNode.type !== 'unknown')) {
                    ctx3.diagnostics.push({ node: at3 ?? pad.ast, message: `${name} expects a string padding, got ${padNode ? `type ${typeName(padNode.type)}` : describe(pad)}` });
                    return ERROR;
                }
                if (forbid(padNode, ['agg', 'group', 'order'], name, at3 ?? pad.ast, ctx3)) return ERROR;
                return mkExpr({ kind: 'call', name, args: [value, length, padNode], type: 'string' }, at3);
            });
        });
    });
}

/** lag/lead — value, offset (required; SQL's default is 1), optional default (NULL). */
function lagLeadBuiltin(name: 'lag' | 'lead'): () => Value {
    return () => fn(name, (x, at, ctx) => {
        const value = exprNode(x);
        if (!value) {
            ctx.diagnostics.push({ node: at ?? x.ast, message: `${name} expects an expression to look up, e.g. ${name} u.salary 1 nothing, got ${describe(x)}` });
            return ERROR;
        }
        if (forbid(value, ['agg', 'group', 'order', 'window'], name, at ?? x.ast, ctx)) return ERROR;
        return fn(name, (offset, at2, ctx2) => {
            const offsetNode = exprNode(offset);
            if (!offsetNode || (!isNumeric(offsetNode.type) && offsetNode.type !== 'unknown')) {
                ctx2.diagnostics.push({ node: at2 ?? offset.ast, message: `${name} expects a numeric offset, got ${offsetNode ? `type ${typeName(offsetNode.type)}` : describe(offset)}` });
                return ERROR;
            }
            if (forbid(offsetNode, ['agg', 'group', 'order', 'window'], name, at2 ?? offset.ast, ctx2)) return ERROR;
            return fn(name, (def, at3, ctx3) => {
                const defNode = maybeOpt(def, name, at3, ctx3);
                if (defNode === null) return ERROR;
                if (defNode !== 'omit' && forbid(defNode, ['agg', 'group', 'order', 'window'], name, at3 ?? def.ast, ctx3)) return ERROR;
                const nodes: SqlNode[] = [value, offsetNode];
                if (defNode !== 'omit') nodes.push(defNode);
                const t: SqlType = value.type === 'null' ? 'string' : value.type;
                return mkExpr({ kind: 'call', name, args: nodes, type: t }, at3);
            });
        });
    });
}

// ---------------------------------------------------------------------------
// Window functions (OVER) — see render.ts's 'window' case for the SQL.
// ---------------------------------------------------------------------------

/** Window-only functions: invalid anywhere outside `over (...)`'s fn position. */
const WINDOW_ONLY = new Set(['rowNumber', 'rank', 'denseRank', 'percentRank', 'ntile', 'lag', 'lead']);

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
function windowSpec(v: Value, at: AstNode | undefined, ctx: Ctx): { partition: SqlNode[]; order: { node: SqlNode; dir: 'ASC' | 'DESC' }[]; frame: { start: number; end: number } | null } | null {
    if (v.kind !== 'record') {
        ctx.diagnostics.push({ node: at ?? v.ast, message: `over expects a spec record, e.g. over (rowNumber) { partition = [u.dept], order = [desc u.salary] } — got ${describe(v)}` });
        return null;
    }
    const fields = new Map(v.fields.map(f => [f.key, f.value]));
    for (const key of fields.keys()) {
        if (key !== 'partition' && key !== 'order' && key !== 'rows') {
            ctx.diagnostics.push({ node: at ?? v.ast, message: `unknown over spec field '${key}' — expected 'partition', 'order' and/or 'rows'` });
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
    let frame: { start: number; end: number } | null = null;
    const rv = fields.get('rows');
    if (rv !== undefined) {
        const items = listOrSingle(rv);
        if (items === null || (items.length !== 1 && items.length !== 2)) {
            ctx.diagnostics.push({ node: at ?? rv.ast, message: `over spec 'rows' expects [n] or [n, m] with non-negative integer literals, e.g. rows = [3]` });
            return null;
        }
        const nums: number[] = [];
        for (const item of items) {
            const node = exprNode(item);
            if (node?.kind !== 'lit' || typeof node.value !== 'number' || !Number.isInteger(node.value) || node.value < 0) {
                ctx.diagnostics.push({ node: at ?? item.ast, message: `over spec 'rows' entries must be non-negative integer literals, got ${node ? `type ${typeName(node.type)}` : describe(item)}` });
                return null;
            }
            nums.push(node.value);
        }
        frame = { start: nums[0]!, end: nums[1] ?? 0 };
    }
    return { partition, order, frame };
}

/**
 * Walk a projection's expressions and reject window-only functions
 * (rowNumber, rank, ...) that are not wrapped in `over (...)` — a bare
 * `ROW_NUMBER()` would render invalid SQL. `over (sum u.x) {...}` is fine
 * because `sum` is an aggregate, not a window-only function.
 */
function validateWindowUses(fields: readonly { key: string; node: SqlNode }[], at: AstNode | undefined, ctx: Ctx): boolean {
    let bad = false;
    const visit = (n: SqlNode, parent: SqlNode | null, slot: string | null): void => {
        if (n.kind === 'call' && WINDOW_ONLY.has(n.name) && !(parent?.kind === 'window' && slot === 'fn')) {
            ctx.diagnostics.push({ node: at, message: `${n.name} must be wrapped in over (...) — e.g. over (${n.name}) { partition = [u.dept], order = [desc u.salary] }` });
            bad = true;
        }
        switch (n.kind) {
            case 'col': case 'bare': case 'lit': case 'current-date': case 'current-timestamp':
            case 'date-literal': case 'timestamp-literal': break;
            case 'bin': visit(n.left, n, 'left'); visit(n.right, n, 'right'); break;
            case 'is-null': case 'not': case 'group': case 'order': visit(n.expr, n, 'expr'); break;
            case 'agg':
                visit(n.arg, n, 'arg');
                if (n.filter) visit(n.filter, n, 'filter');
                break;
            case 'call': n.args.forEach(a => visit(a, n, 'args')); break;
            case 'fragment': n.args.forEach(a => visit(a, n, 'args')); break;
            case 'window':
                visit(n.fn, n, 'fn');
                n.partition.forEach(p => visit(p, n, 'partition'));
                n.order.forEach(o => visit(o.node, n, 'order'));
                break;
            case 'in': visit(n.expr, n, 'expr'); n.list.forEach(a => visit(a, n, 'list')); break;
            case 'exists': case 'scalar': case 'in-query': break;
        }
    };
    for (const field of fields) visit(field.node, null, null);
    return bad;
}

function inQueryBuiltin(negated: boolean): () => Value {
    const name = negated ? 'notInQuery' : 'inQuery';
    return () => fn(name, (value, at, ctx) => {
        const expr = exprNode(value);
        if (!expr) {
            ctx.diagnostics.push({ node: at ?? value.ast, message: `${name} expects a value expression, e.g. ${name} u.id (orders & map (o => { user_id = o.user_id }))` });
            return ERROR;
        }
        if (forbid(expr, ['agg', 'group', 'order', 'window'], name, at ?? value.ast, ctx)) return ERROR;
        return fn(name, (q, at2, ctx2) => {
            if (q.kind !== 'query') {
                ctx2.diagnostics.push({ node: at2 ?? q.ast, message: `${name} expects a query as its second argument, got ${describe(q)}` });
                return ERROR;
            }
            const cols = [...querySchema(q.query).values()];
            if (cols.length !== 1) {
                ctx2.diagnostics.push({ node: at2 ?? q.ast, message: `${name} subquery must return exactly one column, got ${cols.length}` });
                return ERROR;
            }
            const col = cols[0]!;
            if (!comparable(expr.type, col.type)) {
                ctx2.diagnostics.push({ node: at2 ?? q.ast, message: `${name} requires matching types, got ${typeName(expr.type)} and ${typeName(col.type)}` });
                return ERROR;
            }
            return mkExpr({ kind: 'in-query', expr, query: q.query, negated, type: 'bool' }, at2);
        });
    });
}

function inBuiltin(negated: boolean): () => Value {
    return () => fn('isIn', (value, at, ctx) => {
        const node = exprNode(value);
        if (!node) {
            ctx.diagnostics.push({ node: at ?? value.ast, message: `isIn expects a value expression, e.g. isIn u.id [1, 2, 3]` });
            return ERROR;
        }
        return fn('isIn', (listVal, at2, ctx2) => {
            if (listVal.kind !== 'list' || listVal.items.length === 0) {
                ctx2.diagnostics.push({ node: at2 ?? listVal.ast, message: `isIn expects a non-empty list, e.g. isIn u.id [1, 2, 3]` });
                return ERROR;
            }
            const items: SqlNode[] = [];
            for (const item of listVal.items) {
                const itemNode = exprNode(item);
                if (!itemNode) {
                    ctx2.diagnostics.push({ node: item.ast ?? at2, message: `isIn list items must be expressions, got ${describe(item)}` });
                    return ERROR;
                }
                const isNullItem = itemNode.kind === 'lit' && itemNode.value === null;
                if (isNullItem) {
                    items.push(itemNode);
                    continue;
                }
                if (!comparable(node.type, itemNode.type)) {
                    ctx2.diagnostics.push({ node: item.ast ?? at2, message: `isIn list items must match type ${typeName(node.type)}, got ${typeName(itemNode.type)}` });
                    return ERROR;
                }
                items.push(itemNode);
            }
            if (forbid(node, ['agg', 'group', 'order'], 'isIn', at2 ?? value.ast, ctx2)) return ERROR;
            return mkExpr({ kind: 'in', expr: node, list: items, negated, type: 'bool' }, at2);
        });
    });
}

/** The QueryType inside a type annotation, unwrapping parens (null if not a query type). */
function queryTypeOf(t: import('./generated/ast.js').Type): QueryType | null {
    let cur = t;
    for (;;) {
        if (isTypeAtom(cur)) {
            if (cur.maybeType) { cur = cur.maybeType; continue; }
            if (cur.base) { cur = cur.base; continue; }
            return null;
        }
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
    const schema = new Map<string, SqlColumn>();
    const seenFields = new Set<string>();
    for (const field of t.fields) {
        const key = labelName(field.key);
        if (seenFields.has(key)) {
            ctx.diagnostics.push({ node: field, message: `duplicate field '${key}' in query type` });
        }
        seenFields.add(key);
        const type = scalarTypeOf(field.type);
        if (type === null) {
            ctx.diagnostics.push({ node: field.type, message: `schema entry '${key}' must be a scalar type (int, string, bool, float, decimal, date, timestamp) or a list of one, e.g. [string]` });
            return null; // leave the table dynamic — no partial schema
        }
        schema.set(key, { type, table: null });
    }
    return schema;
}

/** The SqlType named by a column type (`int`, `(maybe int)`, `[string]`, ...), or null if not a scalar. */
function scalarTypeOf(
    t: import('./generated/ast.js').Type,
): SqlType | null {
    let cur: import('./generated/ast.js').Type = t;
    // Unwrap maybe/parens; a hole cannot be a concrete SQL column type.
    for (;;) {
        if (isTypeAtom(cur)) {
            if (cur.maybeType) { cur = cur.maybeType; continue; }
            if (cur.base) { cur = cur.base; continue; }
            return null;
        }
        if (isTypeParen(cur)) { cur = cur.type; continue; }
        break;
    }
    if (isTypeHole(cur)) return null;
    // `[T]` — an array column (element type is not tracked at the SQL layer).
    if (isListType(cur)) {
        return scalarTypeOf(cur.type) === null ? null : 'array';
    }
    if (!isTypeVar(cur)) return null;
    if (cur.name === 'int' || cur.name === 'float' || cur.name === 'decimal' || cur.name === 'string' || cur.name === 'bool' || cur.name === 'date' || cur.name === 'timestamp') {
        return cur.name;
    }
    return null;
}

function rowFromRecord(v: Value, at: AstNode | undefined, ctx: Ctx, what: string, allowAgg = false): RowNode | null {
    if (v.kind !== 'record') {
        ctx.diagnostics.push({ node: at ?? v.ast, message: `${what} must be a record like { key = expr, ... }, got ${describe(v)}` });
        return null;
    }
    const row: { fields: { key: string; node: SqlNode }[] } = { fields: [] };
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

/**
 * The per-dialect surface the prelude can branch on. It is a structural slice
 * of render.ts's `DialectSpec` (name + the canonical->SQL function map), kept
 * here so the interpreter does not import render (which imports interpreter).
 * The prelude seeds a first-class `sql_dialect` record from this.
 */
export interface ProjectAnalysisOptions {
    /** Require the last module's last binding to be a query (default true). */
    requireQuery?: boolean;
    /** Resolved import edges from `collectModuleTree` (pure tree). */
    importsByModule?: ReadonlyMap<ProjectModule, readonly ResolvedImportEdge[]>;
    /** Resolved re-export (`export ... from`) edges from `collectModuleTree`. */
    reexportsByModule?: ReadonlyMap<ProjectModule, readonly ResolvedExportEdge[]>;
    /** Optional source standard library, evaluated before the user modules. */
    prelude?: ProjectModule;
    /**
     * The dialect the prelude's `sql_dialect` value describes. When omitted,
     * the prelude sees a sqlite-shaped view (matching the CLI default).
     */
    dialect?: DialectView;
}

/**
 * The built-in namespaces (`list.*`, `Maybe.*`) as a fresh environment.
 *
 * They are pure, always-in-scope core vocabulary rather than Prelude exports,
 * so a user module gets them whether or not the Prelude is auto-imported;
 * `# no prelude` suppresses the Prelude, not the namespaces.
 */
export function namespaceEnv(): Map<string, Value> {
    const env = new Map<string, Value>();
    for (const [alias, namespace] of Object.entries(PRELUDE_NAMESPACES)) {
        const exports = new Map<string, Value>();
        for (const [publicName, builtinName] of Object.entries(namespace)) {
            const factory = BUILTINS[builtinName as BuiltinName];
            if (factory) exports.set(publicName, factory());
        }
        env.set(alias, { kind: 'module', name: alias, exports });
    }
    return env;
}

/** The primitive environment shared by `analyzeProject` and `checkProject`. */
export function createPreludeEnv(dialect?: DialectView): Map<string, Value> {
    const env = new Map<string, Value>();
    for (const [name, factory] of Object.entries(BUILTINS)) {
        env.set(name, factory());
    }
    for (const operator of INTRINSIC_OPERATORS) {
        env.set(operatorIntrinsicName(operator), operatorIntrinsicValue(operator));
    }
    // The first-class `sql_dialect` value the prelude branches on for
    // per-dialect lowering (hidden intrinsic: reserved, not in BUILTINS).
    const view = dialect ?? { name: 'sqlite', functions: {} };
    const functionFields: { key: string; value: Value }[] = [];
    for (const [canonical, sqlName] of Object.entries(view.functions)) {
        functionFields.push({ key: canonical, value: mkExpr(lit(sqlName, 'string')) });
    }
    env.set('sql_dialect', recordValue([
        { key: 'name', value: mkExpr(lit(view.name, 'string')) },
        { key: 'functions', value: recordValue(functionFields) },
    ]));
    // The reserved `core` namespace: every primitive under a qualified name.
    // A BASE module uses it to publish a public spelling without a
    // self-recursive binding (`export table = core.table`), which is what
    // lets the primitive names stay ambient for the library while the
    // library owns the public surface.
    const coreExports = new Map<string, Value>();
    for (const [name, value] of env) coreExports.set(name, value);
    env.set(CORE_NAMESPACE, { kind: 'module', name: CORE_NAMESPACE, exports: coreExports });

    // Built-in prelude namespaces (`list.*`, `maybe.*`): module values whose
    // exports are the pure combinators, so `list.map` / `maybe.isJust`
    // resolve exactly like a qualified import `import "..." as list`.
    for (const [alias, namespace] of Object.entries(PRELUDE_NAMESPACES)) {
        const exports = new Map<string, Value>();
        for (const [publicName, builtinName] of Object.entries(namespace)) {
            const factory = BUILTINS[builtinName as BuiltinName];
            if (factory) exports.set(publicName, factory());
        }
        env.set(alias, { kind: 'module', name: alias, exports });
    }
    return env;
}

/**
 * Evaluate a project: the modules in import order (imports first, the root
 * module last). Each module is evaluated in its OWN scope — the prelude, its
 * own imports (flat bindings + namespace aliases), then its own bindings —
 * so nothing leaks across modules and no binding can see a sibling's scope.
 * Only `export`ed bindings are visible to importers (flat or qualified).
 * Within a module, bindings are order-independent (top-down resolution):
 * each is evaluated in dependency order, so any binding may reference any
 * other regardless of position. The ROOT module's query is its `main`
 * binding, or its last binding when there is no `main`.
 */
export function analyzeProject(modules: readonly ProjectModule[], options: ProjectAnalysisOptions = {}): AnalysisResult {
    const { requireQuery = true, importsByModule = new Map(), reexportsByModule = new Map(), prelude, dialect } = options;
    const diagnostics: Diagnostic[] = [];

    // Exported bindings per module, keyed by module identity (diamond dedup
    // means every importer references the SAME target object). Filled as each
    // module is evaluated, so a module's imports are always ready.
    const exportsByModule = new Map<ProjectModule, Map<string, Value>>();

    // A base module is the only kind that starts from the primitive core;
    // every other module starts from the Prelude's exports instead.
    const baseModules = prelude ? baseClosureFor(prelude) : [];
    const baseSet: ReadonlySet<ProjectModule> = new Set(baseModules);
    const allModules = [...baseModules, ...modules];
    const root = modules[modules.length - 1];
    let standardValues = new Map<string, Value>();
    let rootEnv: Map<string, Value> | undefined;
    let value: Value = ERROR;
    for (const module of allModules) {
        // Each module gets its OWN immutable scope: prelude, imports, then
        // local bindings. The environment is threaded through the binding
        // fold; nothing is reassigned on a shared context object.
        //
        // Every BASE module starts from the PRIMITIVE core environment (SQL
        // builtins, operator intrinsics, the hidden `sql_dialect` value, the
        // reserved `core` namespace). A user module starts from what it
        // imports instead; `# no prelude` suppresses the automatic injection
        // of the Prelude's exports (and nothing else).
        const isBase = baseSet.has(module);
        const isNoPrelude = module.noPrelude === true;
        // A base module starts from the whole primitive core. A user module
        // starts from the built-in NAMESPACES (`list.*`, `Maybe.*`) — they are
        // core vocabulary, always in scope, and not part of the Prelude's
        // exported surface — and then receives the Prelude's exports below.
        let env = isBase ? createPreludeEnv(dialect) : namespaceEnv();
        const moduleBindings: Set<string> = new Set(module.model.bindings.map(b => b.name));
        const moduleDiagnostics: Diagnostic[] = [];

        // --- imports: flat bindings + namespace aliases ------------------
        // Shared with inference (project-scope.ts): collision detection and
        // selective-import validation happen exactly once, with one wording.
        const moduleImports: readonly ResolvedImportEdge[] = importsByModule.get(module) ?? module.imports ?? [];
        const imported = resolveImportScope(module, moduleImports, exportsByModule);
        moduleDiagnostics.push(...imported.diagnostics);
        for (const [name, v] of imported.flat) env.set(name, v);
        for (const [alias, selected] of imported.namespaces) {
            env.set(alias, { kind: 'module', name: alias, exports: new Map(selected), ast: module.model.imports.find(imp => imp.alias === alias) });
        }
        // The Prelude's exports are auto-imported into every USER module. A
        // base module is skipped: it is built from the core, not from the
        // standard surface it helps define.
        if (!isBase && !isNoPrelude) {
            for (const [name, standardValue] of standardValues) {
                if (!env.has(name)) env.set(name, standardValue);
            }
        }
        const scope = new Map(imported.scope);

        // --- local bindings (Haskell-style: order-independent) ------------
        // Binding resolution is TOP-DOWN: every binding may reference any
        // other binding in the module, so definitions can appear in any
        // order (`main = x` before `x = table "k"` is valid). Bindings are
        // evaluated in dependency (topological) order — dependencies first,
        // source order as tiebreak. Recursive cycles are diagnosed once per
        // member and bound to ERROR so dependents surface their own errors
        // instead of a misleading "defined before use". `value` tracks the
        // LAST binding's value (the entry binding, by convention `main`).
        const exports = new Map<string, Value>();
        let seen = new Set<string>(); // within-module duplicate detection (immutably updated)
        const { order, cycles } = topoOrderBindings(module.model.bindings);
        for (const cycle of cycles) {
            env = new Map(env).set(cycle.name, ERROR);
            seen = new Set(seen).add(cycle.name);
            moduleDiagnostics.push({ node: cycle, message: recursiveBindingMessage(cycle.name) });
        }
        for (const binding of order) {
            // A name brought in by an import may not also be bound locally:
            // that would silently shadow the import. A REPEATED local name is
            // different — it is a second definition of an overload set, and
            // the two are told apart by their parameter types.
            const claimedBy = scope.get(binding.name);
            if (claimedBy !== undefined && claimedBy !== `local binding '${binding.name}'`) {
                moduleDiagnostics.push({ node: binding, message: conflictMessage(binding.name, claimedBy, 'a local binding') });
            }
            scope.set(binding.name, `local binding '${binding.name}'`);
            const result = checkBinding(binding, env, moduleBindings, seen);
            moduleDiagnostics.push(...result.diagnostics);
            env = result.env;
            seen = result.seen;
            value = result.value;
            if (binding.export) exports.set(binding.name, value);
        }
        // Cycle members keep their ERROR values; their binding value is the
        // module's entry only when it is the last binding.
        for (const binding of cycles) {
            value = ERROR;
            if (binding.export) exports.set(binding.name, ERROR);
        }
        // --- re-exports: `export * from "x"` / `export { a as b } from "x"` ---
        // Re-exports add names to THIS module's public surface without binding
        // them locally. The target was evaluated earlier (DFS order), so its
        // export map is ready. Conflicts are errors, never silent.
        // Base modules carry their re-export edges on the module itself (see
        // prelude.ts), so a caller that only passes the Prelude still gets the
        // library's aggregation.
        const moduleReexports = reexportsByModule.get(module) ?? module.exports ?? [];
        for (const { target, exportNode } of moduleReexports) {
            const targetExports = exportsByModule.get(target);
            if (!targetExports) continue; // cyclic/missing target — already diagnosed
            const spec = parseStringLiteral(exportNode.path);
            if (exportNode.names.length === 0) {
                for (const [name, reexported] of targetExports) {
                    if (exports.has(name)) {
                        moduleDiagnostics.push({ node: exportNode, message: `re-exported name '${name}' (from '${spec}') conflicts with an already exported name` });
                        continue;
                    }
                    exports.set(name, reexported);
                }
            } else {
                for (const item of exportNode.names) {
                    const reexported = targetExports.get(item.name);
                    if (reexported === undefined) {
                        const keys = [...targetExports.keys()];
                        moduleDiagnostics.push({ node: exportNode, message: `'${item.name}' is not exported by '${spec}' — exported: ${keys.length > 0 ? keys.join(', ') : '(none)'}` });
                        continue;
                    }
                    const name = item.renamed ?? item.name;
                    if (exports.has(name)) {
                        moduleDiagnostics.push({ node: exportNode, message: `re-exported name '${name}' (from '${spec}') conflicts with an already exported name` });
                        continue;
                    }
                    exports.set(name, reexported);
                }
            }
        }
        exportsByModule.set(module, exports);
        if (module === prelude) standardValues = exports;
        if (module === root) rootEnv = env;
        diagnostics.push(...moduleDiagnostics);
    }

    if (requireQuery && root) {
        // With top-down resolution the query is the module's `main` binding
        // when one exists; otherwise the last binding in source order. The
        // entry value is read from the module's final environment (the loop
        // above evaluates in dependency order, so its trailing value is not
        // necessarily the entry).
        const mainBinding = root.model.bindings.find(b => b.name === 'main');
        const last = root.model.bindings[root.model.bindings.length - 1];
        const selected = mainBinding ?? last;
        if (!selected) {
            value = ERROR;
            diagnostics.push({
                node: root.model,
                message: `a module must have at least one binding — its \`main\` binding (or last binding) is the module's query`,
            });
        } else {
            value = rootEnv?.get(selected.name) ?? ERROR;
            if (!isError(value) && value.kind !== 'query') {
                diagnostics.push({
                    node: selected,
                    message: mainBinding
                        ? `binding 'main' must be a query (a table or a pipeline), got ${describe(value)}`
                        : `a module's last binding must be a query (a table or a pipeline), got ${describe(value)}`,
                });
            }
        }
    }
    return { value, diagnostics };
}

/** "name X (newcomer) conflicts with Y" — Y describes the name already in scope. */
function conflictMessage(name: string, existing: string, newcomer: string): string {
    return `name '${name}' (${newcomer}) conflicts with ${existing}`;
}

/** Evaluate a single module (no imports). */
export function analyze(model: Model, prelude?: ProjectModule): AnalysisResult {
    return analyzeProject([{ model, uri: undefined, imports: [] }], { importsByModule: new Map(), prelude });
}

export interface BindingResult {
    value: Value;
    env: Map<string, Value>;
    seen: Set<string>;
    diagnostics: Diagnostic[];
}

/**
 * A query-type annotation on a plain table defines the table's schema:
 *   users: query { id: int } = table "users"
 *   t = table "users": query { id: int }
 * The same rule applies to binding annotations and expression ascriptions so
 * the interpreter IR and the type checker never disagree. Only join-free
 * queries are stamped — stamping joined columns with the root table would
 * mis-qualify them. Any other annotation is just a signature.
 */
function stampQueryTypeAnnotation(
    v: Value,
    typeAst: import('./generated/ast.js').Type | undefined,
    at: AstNode | undefined,
    ctx: Ctx,
): Value {
    if (v.kind === 'mempty' && typeAst) {
        return memptyFromAnnotation(typeAst, at, ctx);
    }
    if (v.kind !== 'query' || v.query.known || !typeAst
        || !v.query.steps.every(step => step.kind !== 'join')) {
        return v;
    }
    const qt = queryTypeOf(typeAst);
    if (!qt) return v;
    const schema = schemaFromQueryType(qt, at, ctx);
    if (!schema) return v;
    // Stamp with the root's plain alias (last segment), matching rowRecord,
    // so column references stay `alias.column`. Build a new map and a new
    // query value: annotations never mutate an existing query in place.
    const alias = v.query.aliases[0] ?? v.query.root.name;
    const stamped: Schema = new Map(
        [...schema].map(([key, col]) => [key, { ...col, table: alias }]),
    );
    return {
        kind: 'query',
        query: { ...v.query, known: true, root: { ...v.query.root, schema: stamped } },
        ast: v.ast,
    };
}


export function checkBinding(binding: Binding, env: Map<string, Value>, moduleBindings: ReadonlySet<string>, seen: ReadonlySet<string>, ctxExtras: Partial<Ctx> = {}): BindingResult {
    const diagnostics: Diagnostic[] = [];
    const nextSeen = new Set(seen);
    // A repeated name is NOT a duplicate: it is a second definition of an
    // overload set (`abs` per numeric type), and the definitions are told
    // apart by their parameter types. A repeated name whose definitions are
    // not callable has no way to choose, so it stays an error below.
    nextSeen.add(binding.name);
    if (!binding.value) {
        const value = ERROR;
        diagnostics.push({ node: binding, message: missingBindingExpressionMessage(binding.name) });
        return { value, env: new Map(env).set(binding.name, value), seen: nextSeen, diagnostics };
    }
    const ctx: Ctx = { env, diagnostics, moduleBindings: new Set(moduleBindings), ...ctxExtras };
    let v = evalExprWith(binding.value, ctx);
    v = stampQueryTypeAnnotation(v, binding.type, binding, ctx);
    // A BINDING annotation is the other way to declare a parameter type
    // (`abs: float -> float = x => ...`). Overload selection reads it, so the
    // prelude can spell its alternatives exactly as inference sees them.
    if (binding.type && v.kind === 'lambda' && v.paramType === undefined) {
        const declared = firstParamTypeOfAnnotation(binding.type);
        if (declared) v = { ...v, paramType: declared };
    }
    // A bare `mempty` with a binding annotation picks the instance from the
    // annotation (`x: [int] = mempty`) — same type-directed rule as
    // `x = (mempty : [int])`. Non-maybe annotations only; a query-typed
    // annotation is a schema stamp, not a monoid instance.
    if (v.kind === 'mempty' && binding.type) {
        v = memptyFromAnnotation(binding.type, binding, ctx);
    }
    if (v.kind === 'mempty' && binding.type) {
        // The annotation stayed abstract (a user alias wrapping a list, e.g.
        // `type IntList = [int]`): decode it through the alias map before
        // giving up — memptyFromAnnotation expanded `@` scalars only.
        const aliased = expandMemptyAnnotation(binding.type, ctx);
        if (aliased) v = aliased;
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
    const nextEnv = new Map(env);
    // A second definition of the same name is an OVERLOAD, not a duplicate:
    // `abs` may be given once per numeric type. The environment holds the set
    // and `applyWith` picks the alternative the argument's SQL type selects.
    // Only definitions from THIS module overload each other — `seen` is
    // exactly the set of names this module has already bound — so a definition
    // here SHADOWS a prelude/import of the same name outright.
    const prior = seen.has(binding.name) ? env.get(binding.name) : undefined;
    if (prior !== undefined) {
        // A repeated name is an overload ONLY when both definitions are
        // callable — that is what lets a reader pick one by argument type.
        // Two queries (or two records, two lists) named the same have no such
        // discriminator, so the repeat is still an error.
        const priorCallable = prior.kind === 'overload' || isOverloadable(prior);
        if (!priorCallable || !isOverloadable(v)) {
            diagnostics.push({ node: binding, message: `duplicate binding name '${binding.name}'` });
        } else {
            nextEnv.set(binding.name, prior.kind === 'overload'
                ? { kind: 'overload', name: binding.name, alternatives: [...prior.alternatives, v], ast: binding }
                : { kind: 'overload', name: binding.name, alternatives: [prior, v], ast: binding });
            return { value: v, env: nextEnv, seen: nextSeen, diagnostics };
        }
    }
    nextEnv.set(binding.name, v);
    return { value: v, env: nextEnv, seen: nextSeen, diagnostics };
}

// re-export for the validator
export { ERROR };
