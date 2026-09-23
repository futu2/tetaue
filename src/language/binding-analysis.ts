/******************************************************************************
 * Binding analysis — pure, evaluator-free AST helpers.
 *
 * These drive the top-down (Haskell-style) binding order: a definition may
 * reference any other binding in the module regardless of position, so the
 * project pass needs a reference graph and a stable topological order before
 * it types or evaluates anything.
 *
 * Nothing here touches the evaluator, the type universe, or any `Value`; the
 * inputs are AST nodes and the outputs are orderings and strings. That is what
 * lets BOTH passes use it — before this module existed, `inference.ts` had to
 * import it from `interpreter.ts`, which is one direction of the cycle stage 3
 * of docs/design/architecture.md removes.
 *
 * Extracted verbatim from interpreter.ts.
 ******************************************************************************/
import type { AstNode } from 'langium';

/**
 * The per-dialect surface the prelude can branch on: a structural slice of the
 * renderer's `DialectSpec` (the name plus the canonical->SQL function map).
 * The prelude seeds a first-class `sql_dialect` record from this.
 *
 * It lives in this evaluator-free module for the same reason the rest does —
 * both the evaluator and the inferencer need the type, and the inferencer must
 * not import the interpreter (stage 3 of the architecture doc).
 */
export interface DialectView {
    name: string;
    functions: Readonly<Record<string, string>>;
}

/**
 * A user-facing diagnostic anchored at a source node. Shared by BOTH passes
 * (the evaluator and the inferencer), which is why it lives here rather than
 * in the evaluator: the project pass merges the two by (node, message).
 */
export interface Diagnostic {
    node: AstNode | undefined;
    message: string;
}
import {
    isIdentifier, isLambda, isLetExpression,
    type Binding,
} from '../language/generated/ast.js';

/**
 * Collect the module-binding names a binding's value references, ignoring
 * names shadowed by enclosing lambda parameters or `let` binders. This drives
 * the top-down (Haskell-style) binding order: a definition may reference any
 * other binding in the module regardless of position. Type annotations are
 * skipped — type names are not value references.
 */
const TYPE_NODE_TYPES = new Set([
    'Type', 'FunType', 'TypeAtom', 'BaseType', 'RecordType', 'QueryType',
    'RecordField', 'ListType', 'TypeHole', 'TypeVar', 'TypeParen',
]);

function freeModuleRefs(node: AstNode, moduleNames: ReadonlySet<string>, shadow: Set<string>, out: Set<string>): void {
    if (TYPE_NODE_TYPES.has(node.$type)) return;
    if (isIdentifier(node)) {
        if (!shadow.has(node.name) && moduleNames.has(node.name)) out.add(node.name);
        return;
    }
    if (isLambda(node)) {
        const param = node.param?.name;
        if (param) shadow.add(param);
        if (node.body) freeModuleRefs(node.body as unknown as AstNode, moduleNames, shadow, out);
        if (param) shadow.delete(param);
        return;
    }
    if (isLetExpression(node)) {
        if (node.value) freeModuleRefs(node.value as unknown as AstNode, moduleNames, shadow, out);
        if (node.name) shadow.add(node.name);
        if (node.body) freeModuleRefs(node.body as unknown as AstNode, moduleNames, shadow, out);
        if (node.name) shadow.delete(node.name);
        return;
    }
    for (const key of Object.keys(node)) {
        if (key === '$type' || key === '$container') continue;
        const v = (node as unknown as Record<string, unknown>)[key];
        if (Array.isArray(v)) {
            for (const item of v) {
                if (item && typeof item === 'object' && '$type' in (item as object)) {
                    freeModuleRefs(item as AstNode, moduleNames, shadow, out);
                }
            }
        } else if (v && typeof v === 'object' && '$type' in (v as object)) {
            freeModuleRefs(v as AstNode, moduleNames, shadow, out);
        }
    }
}

/**
 * Order a module's bindings so every binding comes after the bindings its
 * value references (a stable topological sort, source order as tiebreak).
 * Bindings involved in reference cycles (recursion) are returned separately
 * and reported by the caller.
 *
 * A name may have SEVERAL definitions — that is how overloading works
 * (`export year: date -> int = ...` next to `export year: timestamp -> int =
 * ...`). All definitions of one name are a single node in the ordering graph,
 * because a reference to `year` may resolve to any of them: keeping the group
 * together is what lets a definition in one group call a helper in another
 * with only the source-order tiebreak to settle the rest.
 */
export function topoOrderBindings(bindings: readonly Binding[]): { order: readonly Binding[]; cycles: readonly Binding[] } {
    const names = new Set(bindings.map(b => b.name));
    const byName = new Map(bindings.map(b => [b.name, b] as const));
    const indegree = new Map<string, number>();
    const dependents = new Map<string, Set<string>>();
    const refsByBinding = new Map<Binding, Set<string>>();
    for (const b of bindings) {
        const refs = new Set<string>();
        if (b.value) freeModuleRefs(b.value as unknown as AstNode, names, new Set(), refs);
        refsByBinding.set(b, refs);
        if (!indegree.has(b.name)) indegree.set(b.name, 0);
    }
    for (const b of bindings) {
        for (const r of refsByBinding.get(b)!) {
            if (!byName.has(r) || r === b.name) continue;
            // One edge per (dependent name, dependency name) pair, so an
            // overloaded name does not count its dependencies once per
            // definition.
            const deps = dependents.get(r) ?? new Set<string>();
            if (deps.has(b.name)) continue;
            deps.add(b.name);
            dependents.set(r, deps);
            indegree.set(b.name, indegree.get(b.name)! + 1);
        }
    }
    const order: Binding[] = [];
    const placed = new Set<string>();
    let progressed = true;
    while (progressed) {
        progressed = false;
        for (const b of bindings) {
            if (placed.has(b.name) || indegree.get(b.name)! > 0) continue;
            placed.add(b.name);
            // Every definition of the name travels together: an overloaded
            // name is ONE node in the graph, so all its definitions are
            // emitted at once, in source order.
            for (const overload of bindings) {
                if (overload.name === b.name) order.push(overload);
            }
            progressed = true;
            for (const dep of dependents.get(b.name) ?? []) {
                indegree.set(dep, indegree.get(dep)! - 1);
            }
        }
    }
    // Genuine cycle members: residual nodes that can reach themselves via at
    // least one dependency edge (nodes that merely DEPEND on a cycle are not
    // themselves recursive).
    const residual = bindings.filter(b => !placed.has(b.name));
    const cycles: Binding[] = [];
    const cycleNames = new Set<string>();
    const reaches = (start: string, target: string, seen: Set<string>): boolean => {
        if (seen.has(start)) return false;
        seen.add(start);
        for (const dep of dependents.get(start) ?? []) {
            if (dep === target || reaches(dep, target, seen)) return true;
        }
        return false;
    };
    for (const b of residual) {
        if (reaches(b.name, b.name, new Set())) {
            cycles.push(b);
            cycleNames.add(b.name);
        }
    }
    // Residual nodes that only DEPEND on a cycle (without being recursive)
    // still evaluate — after the cycle members are pre-bound to ERROR.
    for (const b of residual) {
        if (!cycleNames.has(b.name)) order.push(b);
    }
    return { order, cycles };
}

/**
 * Diagnostic shared by the typed and runtime passes for an incomplete binding.
 *
 * Both passes emit the SAME wording so `mergeDiagnostics` can dedupe the pair
 * by (node, message); this module is the one place that wording lives.
 */
export function missingBindingExpressionMessage(name: string): string {
    return `binding '${name}' is missing an expression after '='`;
}

/** Diagnostic shared by the typed and runtime passes for a recursive top-level binding. */
export function recursiveBindingMessage(name: string): string {
    return `binding '${name}' is part of a recursive cycle — recursive top-level bindings are not supported (use \`let\` or the \`recursive\` step for recursion)`;
}
