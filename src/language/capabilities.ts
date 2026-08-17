/******************************************************************************
 * Dialect capability preflight for the symbolic query IR.
 *
 * Rendering still contains defensive capability checks, but callers should
 * learn that a query is unsupported before any SQL text is emitted. This
 * traversal is pure, dialect-specific only through DialectSpec, and visits
 * nested queries and scalar expressions as well as top-level steps.
 ******************************************************************************/
import type { DialectSpec } from './render.js';
import type { Query, QueryStep, RowNode, SqlNode } from './interpreter.js';

export interface CapabilityDiagnostic {
    message: string;
    node?: unknown;
}

function walkRow(row: RowNode, dialect: DialectSpec, diagnostics: CapabilityDiagnostic[], seen: Set<Query>): void {
    for (const field of row.fields) walkExpr(field.node, dialect, diagnostics, seen);
}

function walkExpr(node: SqlNode, dialect: DialectSpec, diagnostics: CapabilityDiagnostic[], seen: Set<Query>): void {
    switch (node.kind) {
        case 'col': case 'lit': case 'param':
        case 'current-date': case 'date-literal':
        case 'timestamp-literal': case 'current-timestamp':
            return;
        case 'bin':
            walkExpr(node.left, dialect, diagnostics, seen);
            walkExpr(node.right, dialect, diagnostics, seen);
            return;
        case 'is-null': case 'not': case 'group': case 'order':
            walkExpr(node.expr, dialect, diagnostics, seen);
            return;
        case 'call':
            // Every public scalar/date call has a lowering in every built-in
            // dialect. Capability checks are only needed for query shape.
            node.args.forEach(arg => walkExpr(arg, dialect, diagnostics, seen));
            return;
        case 'agg':
            walkExpr(node.arg, dialect, diagnostics, seen);
            if (node.filter) walkExpr(node.filter, dialect, diagnostics, seen);
            return;
        case 'window':
            walkExpr(node.fn, dialect, diagnostics, seen);
            node.partition.forEach(item => walkExpr(item, dialect, diagnostics, seen));
            node.order.forEach(item => walkExpr(item.node, dialect, diagnostics, seen));
            return;
        case 'in':
            walkExpr(node.expr, dialect, diagnostics, seen);
            node.list.forEach(item => walkExpr(item, dialect, diagnostics, seen));
            return;
        case 'exists': case 'scalar':
            walkQuery(node.query, dialect, diagnostics, seen);
            return;
        case 'in-query':
            walkExpr(node.expr, dialect, diagnostics, seen);
            walkQuery(node.query, dialect, diagnostics, seen);
            return;
        case 'case':
            node.branches.forEach(branch => {
                walkExpr(branch.cond, dialect, diagnostics, seen);
                walkExpr(branch.value, dialect, diagnostics, seen);
            });
            if (node.elseValue) walkExpr(node.elseValue, dialect, diagnostics, seen);
            return;
    }
}

function checkStep(step: QueryStep, dialect: DialectSpec, diagnostics: CapabilityDiagnostic[], seen: Set<Query>): void {
    switch (step.kind) {
        case 'filter':
            walkExpr(step.cond, dialect, diagnostics, seen);
            return;
        case 'map': case 'fold':
            walkRow(step.proj, dialect, diagnostics, seen);
            return;
        case 'sort':
            step.items.forEach(item => walkExpr(item.node, dialect, diagnostics, seen));
            return;
        case 'join':
            if (step.lateral && dialect.lateral === false) {
                diagnostics.push({ message: `lateral joins are not supported for the ${dialect.name} dialect`, node: step });
            }
            if (dialect.joinKinds && !dialect.joinKinds.includes(step.joinKind)) {
                diagnostics.push({ message: `${step.joinKind} join is not supported for the ${dialect.name} dialect`, node: step });
            }
            walkQuery(step.right, dialect, diagnostics, seen);
            walkExpr(step.on, dialect, diagnostics, seen);
            walkRow(step.proj, dialect, diagnostics, seen);
            return;
        case 'set':
            if (dialect.setOps && !dialect.setOps.includes(step.op)) {
                diagnostics.push({ message: `${step.op} is not supported for the ${dialect.name} dialect`, node: step });
            }
            walkQuery(step.right, dialect, diagnostics, seen);
            return;
        case 'drop':
            if (step.n > 0 && (dialect.offset ?? 'standard') === 'none') {
                diagnostics.push({ message: `OFFSET (drop) is not supported for the ${dialect.name} dialect`, node: step });
            }
            return;
        case 'take':
            return;
    }
}

function walkQuery(query: Query, dialect: DialectSpec, diagnostics: CapabilityDiagnostic[], seen: Set<Query>): void {
    if (seen.has(query)) return;
    seen.add(query);
    if (query.recursive) {
        if (dialect.recursive === false) {
            diagnostics.push({ message: `recursive CTEs are not supported for the ${dialect.name} dialect`, node: query.recursive });
        }
        if (query.root.from) walkQuery(query.root.from, dialect, diagnostics, seen);
        walkQuery(query.recursive.term, dialect, diagnostics, seen);
    } else if (query.root.from) {
        walkQuery(query.root.from, dialect, diagnostics, seen);
    }
    for (const step of query.steps) checkStep(step, dialect, diagnostics, seen);
    for (const column of query.root.schema.values()) {
        if (column.expr) walkExpr(column.expr, dialect, diagnostics, seen);
    }
}

/** Return all dialect capability failures before SQL rendering begins. */
export function checkDialectCapabilities(query: Query, dialect: DialectSpec): CapabilityDiagnostic[] {
    const diagnostics: CapabilityDiagnostic[] = [];
    walkQuery(query, dialect, diagnostics, new Set());
    return diagnostics;
}
