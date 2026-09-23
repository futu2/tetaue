/******************************************************************************
 * Strict-schema preflight for the symbolic query IR.
 *
 * A query whose row shape is not known renders a wildcard projection
 * (`SELECT *`). That is fine for exploratory code, but a strict-schema module
 * (`# strict` on its first line) asks for the opposite: every emitted query
 * must name its columns, so an un-annotated table or a schema-less projection
 * becomes a compile error instead of a silent `*`.
 *
 * This traversal is pure and dialect-independent — it inspects only `known`,
 * `root.schema` and the step list (the same facts the renderer uses to decide
 * between an explicit SELECT list and `*`), so a strict module can never
 * disagree with what `render` would emit.
 ******************************************************************************/
import type { Query, QueryStep, RowNode, SqlNode } from '../core/ir.js';

export interface StrictSchemaDiagnostic {
    message: string;
}

/**
 * Does this query render `SELECT *`? True exactly when the renderer finds no
 * projecting step (map/fold/join) and no known schema to project instead.
 */
function rendersWildcard(query: Query): boolean {
    const projecting = query.steps.some(
        step => step.kind === 'map' || step.kind === 'fold' || step.kind === 'join',
    );
    if (projecting) return false;
    return !(query.known && query.root.schema.size > 0);
}

function walkRow(row: RowNode, diagnostics: StrictSchemaDiagnostic[], seen: Set<Query>): void {
    for (const field of row.fields) walkExpr(field.node, diagnostics, seen);
}

function walkExpr(node: SqlNode, diagnostics: StrictSchemaDiagnostic[], seen: Set<Query>): void {
    switch (node.kind) {
        case 'col': case 'bare': case 'lit': case 'param':
        case 'current-date': case 'date-literal':
        case 'timestamp-literal': case 'current-timestamp':
            return;
        case 'bin':
            walkExpr(node.left, diagnostics, seen);
            walkExpr(node.right, diagnostics, seen);
            return;
        case 'is-null': case 'not': case 'group': case 'order':
            walkExpr(node.expr, diagnostics, seen);
            return;
        case 'call':
            node.args.forEach(arg => walkExpr(arg, diagnostics, seen));
            return;
        case 'agg':
            walkExpr(node.arg, diagnostics, seen);
            if (node.filter) walkExpr(node.filter, diagnostics, seen);
            return;
        case 'window':
            walkExpr(node.fn, diagnostics, seen);
            node.partition.forEach(item => walkExpr(item, diagnostics, seen));
            node.order.forEach(item => walkExpr(item.node, diagnostics, seen));
            return;
        case 'in':
            walkExpr(node.expr, diagnostics, seen);
            node.list.forEach(item => walkExpr(item, diagnostics, seen));
            return;
        case 'exists':
            walkQuery(node.query, diagnostics, seen, true);
            return;
        case 'scalar':
            walkQuery(node.query, diagnostics, seen);
            return;
        case 'in-query':
            walkExpr(node.expr, diagnostics, seen);
            walkQuery(node.query, diagnostics, seen);
            return;
        case 'case':
            node.branches.forEach(branch => {
                walkExpr(branch.cond, diagnostics, seen);
                walkExpr(branch.value, diagnostics, seen);
            });
            if (node.elseValue) walkExpr(node.elseValue, diagnostics, seen);
            return;
    }
}

function checkStep(step: QueryStep, diagnostics: StrictSchemaDiagnostic[], seen: Set<Query>): void {
    switch (step.kind) {
        case 'filter':
            walkExpr(step.cond, diagnostics, seen);
            return;
        case 'map': case 'fold':
            walkRow(step.proj, diagnostics, seen);
            return;
        case 'sort':
            step.items.forEach(item => walkExpr(item.node, diagnostics, seen));
            return;
        case 'join':
            walkQuery(step.right, diagnostics, seen);
            walkExpr(step.on, diagnostics, seen);
            walkRow(step.proj, diagnostics, seen);
            return;
        case 'set':
            walkQuery(step.right, diagnostics, seen);
            return;
        case 'take': case 'drop':
            return;
    }
}

function walkQuery(query: Query, diagnostics: StrictSchemaDiagnostic[], seen: Set<Query>, existsSubquery = false): void {
    if (seen.has(query)) return;
    seen.add(query);

    // An EXISTS subquery renders `SELECT 1` whatever its row shape, so a
    // schema-less query in that position is not a wildcard projection.
    if (!existsSubquery && rendersWildcard(query)) {
        diagnostics.push({
            message: 'strict schema: this query has no known columns and would render SELECT *'
                + ' — annotate its table with a `query { ... }` type (or project it with `map`)',
        });
    }

    if (query.recursive) {
        if (query.root.from) walkQuery(query.root.from, diagnostics, seen);
        walkQuery(query.recursive.term, diagnostics, seen);
    } else if (query.root.from) {
        walkQuery(query.root.from, diagnostics, seen);
    }
    for (const step of query.steps) checkStep(step, diagnostics, seen);
    for (const column of query.root.schema.values()) {
        if (column.expr) walkExpr(column.expr, diagnostics, seen);
    }
}

/** Return every wildcard projection in a strict-schema module. */
export function checkStrictSchema(query: Query): StrictSchemaDiagnostic[] {
    const diagnostics: StrictSchemaDiagnostic[] = [];
    walkQuery(query, diagnostics, new Set());
    return diagnostics;
}
