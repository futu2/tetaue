/******************************************************************************
 * Pure normalization for the symbolic query IR.
 *
 * The evaluator deliberately builds a persistent query value and the SQL
 * renderer should not have to know which source-level steps are equivalent.
 * This pass performs only rewrites that are independent of a SQL dialect and
 * preserve SQL's three-valued boolean semantics. It returns new values and
 * never mutates a Query, SqlNode, row, or schema supplied by the caller.
 ******************************************************************************/
import type {
    Query, QueryStep, RowNode, Schema, SqlColumn, SqlNode,
} from './interpreter.js';

interface OptimizeState {
    queries: Map<Query, Query>;
}

function boolLiteral(value: boolean, ast: SqlNode['ast']): SqlNode {
    return { kind: 'lit', value, type: 'bool', ast };
}

function isBoolLiteral(node: SqlNode, value: boolean): boolean {
    return node.kind === 'lit' && node.type === 'bool' && node.value === value;
}

function optimizeExpr(node: SqlNode, state: OptimizeState): SqlNode {
    let result: SqlNode;
    switch (node.kind) {
        case 'col': case 'bare': case 'lit': case 'param':
        case 'current-date': case 'date-literal':
        case 'timestamp-literal': case 'current-timestamp':
            return node;
        case 'bin': {
            const left = optimizeExpr(node.left, state);
            const right = optimizeExpr(node.right, state);
            if (node.op === 'AND') {
                // These identities hold for TRUE, FALSE, and UNKNOWN under
                // SQL's three-valued logic; they do not assume two-valued
                // booleans.
                if (isBoolLiteral(left, false) || isBoolLiteral(right, false)) {
                    return boolLiteral(false, node.ast);
                }
                if (isBoolLiteral(left, true)) return right;
                if (isBoolLiteral(right, true)) return left;
            } else if (node.op === 'OR') {
                if (isBoolLiteral(left, true) || isBoolLiteral(right, true)) {
                    return boolLiteral(true, node.ast);
                }
                if (isBoolLiteral(left, false)) return right;
                if (isBoolLiteral(right, false)) return left;
            }
            result = left === node.left && right === node.right
                ? node
                : { ...node, left, right };
            return result;
        }
        case 'is-null': {
            const expr = optimizeExpr(node.expr, state);
            if (expr.kind === 'lit') {
                return boolLiteral((expr.value === null) !== node.negated, node.ast);
            }
            return expr === node.expr ? node : { ...node, expr };
        }
        case 'not': {
            const expr = optimizeExpr(node.expr, state);
            if (expr.kind === 'lit' && expr.type === 'bool' && typeof expr.value === 'boolean') {
                return boolLiteral(!expr.value, node.ast);
            }
            if (expr.kind === 'not') return expr.expr;
            if (expr.kind === 'is-null') {
                return { ...expr, negated: !expr.negated, ast: node.ast };
            }
            return expr === node.expr ? node : { ...node, expr };
        }
        case 'call': {
            const args = node.args.map(arg => optimizeExpr(arg, state));
            return args.every((arg, i) => arg === node.args[i]) ? node : { ...node, args };
        }
        case 'in': {
            const expr = optimizeExpr(node.expr, state);
            const list = node.list.map(item => optimizeExpr(item, state));
            return expr === node.expr && list.every((item, i) => item === node.list[i])
                ? node
                : { ...node, expr, list };
        }
        case 'exists':
            {
                const query = optimizeQueryInternal(node.query, state);
                return query === node.query ? node : { ...node, query };
            }
        case 'scalar':
            {
                const query = optimizeQueryInternal(node.query, state);
                return query === node.query ? node : { ...node, query };
            }
        case 'in-query': {
            const expr = optimizeExpr(node.expr, state);
            const query = optimizeQueryInternal(node.query, state);
            return expr === node.expr && query === node.query ? node : { ...node, expr, query };
        }
        case 'agg': {
            const arg = optimizeExpr(node.arg, state);
            const filter = node.filter ? optimizeExpr(node.filter, state) : undefined;
            return arg === node.arg && filter === node.filter ? node : { ...node, arg, filter };
        }
        case 'group': {
            const expr = optimizeExpr(node.expr, state);
            return expr === node.expr ? node : { ...node, expr };
        }
        case 'order': {
            const expr = optimizeExpr(node.expr, state);
            return expr === node.expr ? node : { ...node, expr };
        }
        case 'window': {
            const fn = optimizeExpr(node.fn, state);
            const partition = node.partition.map(item => optimizeExpr(item, state));
            const order = node.order.map(item => ({ ...item, node: optimizeExpr(item.node, state) }));
            return fn === node.fn
                && partition.every((item, i) => item === node.partition[i])
                && order.every((item, i) => item.node === node.order[i]?.node)
                ? node
                : { ...node, fn, partition, order };
        }
        case 'case': {
            const branches = node.branches.map(branch => ({
                cond: optimizeExpr(branch.cond, state),
                value: optimizeExpr(branch.value, state),
            }));
            const elseValue = node.elseValue ? optimizeExpr(node.elseValue, state) : null;
            const unchanged = branches.every((branch, i) =>
                branch.cond === node.branches[i]?.cond && branch.value === node.branches[i]?.value,
            ) && elseValue === node.elseValue;
            return unchanged ? node : { ...node, branches, elseValue };
        }
    }
}

function optimizeRow(row: RowNode, state: OptimizeState): RowNode {
    const fields = row.fields.map(field => ({ ...field, node: optimizeExpr(field.node, state) }));
    return fields.every((field, i) => field.node === row.fields[i]?.node) ? row : { ...row, fields };
}

function optimizeSchema(schema: Schema, state: OptimizeState): Schema {
    let changed = false;
    const fields = new Map<string, SqlColumn>();
    for (const [name, column] of schema) {
        const expr = column.expr ? optimizeExpr(column.expr, state) : undefined;
        if (expr !== column.expr) changed = true;
        fields.set(name, expr === undefined ? column : { ...column, expr });
    }
    return changed ? fields : schema;
}

function combineFilters(left: Extract<QueryStep, { kind: 'filter' }>, right: Extract<QueryStep, { kind: 'filter' }>): Extract<QueryStep, { kind: 'filter' }> {
    return {
        ...left,
        // Keep both predicates in one expression while retaining the newer
        // step as the source location for diagnostics on the combined step.
        cond: optimizeExpr({
            kind: 'bin', op: 'AND', left: left.cond, right: right.cond, type: 'bool',
            ast: right.ast ?? left.ast,
        }, { queries: new Map() }),
        ast: right.ast ?? left.ast,
    };
}

function normalizeSteps(steps: readonly QueryStep[], state: OptimizeState): readonly QueryStep[] {
    const out: QueryStep[] = [];
    for (const original of steps) {
        let step: QueryStep;
        switch (original.kind) {
            case 'filter': {
                const cond = optimizeExpr(original.cond, state);
                step = cond === original.cond ? original : { ...original, cond };
                break;
            }
            case 'map': case 'fold': {
                const proj = optimizeRow(original.proj, state);
                step = proj === original.proj ? original : { ...original, proj };
                break;
            }
            case 'sort': {
                const items = original.items.map(item => ({ ...item, node: optimizeExpr(item.node, state) }));
                step = items.every((item, i) => item.node === original.items[i]?.node)
                    ? original
                    : { ...original, items };
                break;
            }
            case 'join': {
                const right = optimizeQueryInternal(original.right, state);
                const on = optimizeExpr(original.on, state);
                const proj = optimizeRow(original.proj, state);
                step = right === original.right && on === original.on && proj === original.proj
                    ? original
                    : { ...original, right, on, proj };
                break;
            }
            case 'set': {
                const right = optimizeQueryInternal(original.right, state);
                step = right === original.right ? original : { ...original, right };
                break;
            }
            case 'take': case 'drop':
                step = original;
                break;
        }

        const previous = out.at(-1);
        if (previous?.kind === 'filter' && step.kind === 'filter' && previous.having === step.having) {
            out[out.length - 1] = combineFilters(previous, step);
        } else if (previous?.kind === 'drop' && step.kind === 'drop') {
            const total = previous.n + step.n;
            if (Number.isSafeInteger(total)) {
                out[out.length - 1] = { ...previous, n: total, ast: step.ast ?? previous.ast };
            } else {
                out.push(step);
            }
        } else {
            out.push(step);
        }
    }
    return out;
}

function optimizeQueryInternal(query: Query, state: OptimizeState): Query {
    const cached = state.queries.get(query);
    if (cached) return cached;

    // Queries produced by the language are acyclic. Caching after the full
    // traversal preserves sharing for a query reused by multiple subqueries.
    const rootFrom = query.root.from ? optimizeQueryInternal(query.root.from, state) : undefined;
    const steps = normalizeSteps(query.steps, state);
    const recursive = query.recursive
        ? { ...query.recursive, term: optimizeQueryInternal(query.recursive.term, state) }
        : undefined;
    const root = rootFrom === query.root.from
        ? query.root
        : { ...query.root, from: rootFrom };
    const schema = optimizeSchema(root.schema, state);
    const finalRoot = schema === root.schema ? root : { ...root, schema };
    const changed = finalRoot !== query.root || steps.some((step, i) => step !== query.steps[i])
        || steps.length !== query.steps.length || recursive?.term !== query.recursive?.term;
    const result = changed
        ? { ...query, root: finalRoot, steps, recursive }
        : query;
    state.queries.set(query, result);
    return result;
}

/** Normalize a query without mutating the original IR. */
export function optimizeQuery(query: Query): Query {
    return optimizeQueryInternal(query, { queries: new Map() });
}
