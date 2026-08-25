/******************************************************************************
 * tetaue module tree — resolves `import "path.tetaue"` statements and
 * `export ... from "path"` re-exports into an ordered list of modules
 * (imports first, root last) with cycle detection.
 *
 * The traversal is pure with respect to its inputs: no caller-provided module
 * object is mutated. Resolved edges are returned in separate immutable maps
 * keyed by the importing module instead of being written onto
 * `ProjectModule`.
 ******************************************************************************/
import type { AstNode } from 'langium';
import type { Export, Import, Model } from './generated/ast.js';
import { parseStringLiteral, type Diagnostic } from './interpreter.js';
import type { ResolvedImport } from './resolve.js';

export interface ProjectModule {
    model: Model;
    /** Resolved URI of the module (for relative import resolution). */
    uri: string | undefined;
    /** How this module was reached: the importing module's URI and Import node. */
    parent?: { uri: string; importNode: Import };
    /**
     * Legacy direct-construction imports (`{ model, uri, imports: [...] }`).
     * `collectModuleTree` does NOT populate this field; use
     * `ModuleTree.importsByModule` for tree-resolved imports.
     */
    imports?: readonly ResolvedImportEdge[];
    /**
     * Legacy direct-construction re-exports (mirror of `imports`). Use
     * `ModuleTree.exportsByModule` for tree-resolved re-exports.
     */
    exports?: readonly ResolvedExportEdge[];
}

export interface ResolvedImportEdge {
    /** Set for `import "x.tetaue" as t`; undefined for flat imports. */
    alias: string | undefined;
    target: ProjectModule;
    importNode: Import;
}

export interface ResolvedExportEdge {
    target: ProjectModule;
    /** The `export ... from "path"` statement (its `names` list selects; empty = `export *`). */
    exportNode: Export;
}

export interface ModuleTreeOptions {
    /**
     * Resolve an import specifier against the importing module's URI.
     * Returns the resolved file URI plus the directories searched (undefined
     * `uri` = not found anywhere).
     */
    resolve: (importerUri: string | undefined, spec: string) => ResolvedImport;
    /** Read a module's source text by resolved URI (undefined = missing). */
    read: (uri: string) => string | undefined;
    /** Parse source text into a Model; throw with a message on parse errors. */
    parse: (text: string, uri: string) => Model;
}

export interface ModuleTree {
    /** Modules in import order: imports depth-first, the root module last. */
    modules: readonly ProjectModule[];
    /** Resolved direct imports of every module, keyed by module identity. */
    importsByModule: ReadonlyMap<ProjectModule, readonly ResolvedImportEdge[]>;
    /** Resolved re-export (`export ... from`) edges of every module, keyed by module identity. */
    exportsByModule: ReadonlyMap<ProjectModule, readonly ResolvedExportEdge[]>;
    /** Import-resolution diagnostics (unresolved files, cycles, parse errors). */
    diagnostics: readonly Diagnostic[];
}

interface WalkState {
    readonly order: readonly ProjectModule[];
    readonly done: ReadonlySet<string>;
    readonly path: readonly string[];
    readonly byUri: ReadonlyMap<string, ProjectModule>;
    readonly edges: ReadonlyMap<ProjectModule, readonly ResolvedImportEdge[]>;
    readonly exportEdges: ReadonlyMap<ProjectModule, readonly ResolvedExportEdge[]>;
    readonly diagnostics: readonly Diagnostic[];
}

const emptyState = (): WalkState => ({
    order: [],
    done: new Set(),
    path: [],
    byUri: new Map(),
    edges: new Map(),
    exportEdges: new Map(),
    diagnostics: [],
});

function addEdge(state: WalkState, module: ProjectModule, edge: ResolvedImportEdge): WalkState {
    const next = new Map(state.edges);
    next.set(module, [...(next.get(module) ?? []), edge]);
    return { ...state, edges: next };
}

function addExportEdge(state: WalkState, module: ProjectModule, edge: ResolvedExportEdge): WalkState {
    const next = new Map(state.exportEdges);
    next.set(module, [...(next.get(module) ?? []), edge]);
    return { ...state, exportEdges: next };
}

function addModule(state: WalkState, module: ProjectModule): WalkState {
    const next = new Map(state.byUri);
    if (module.uri !== undefined) next.set(module.uri, module);
    return { ...state, byUri: next };
}

function addDiagnostic(state: WalkState, diagnostic: Diagnostic): WalkState {
    return { ...state, diagnostics: [...state.diagnostics, diagnostic] };
}

/**
 * Walk the import/export graph of the root module, depth-first, deduplicating
 * by resolved URI. Returns imports (and re-export targets) before the root so
 * `analyzeProject` can evaluate them in order. Cycles are reported as
 * diagnostics.
 */
export function collectModuleTree(rootInput: ProjectModule, opts: ModuleTreeOptions): ModuleTree {
    // Never append edges to a caller-reused root: copy it so each walk starts
    // with empty `imports`/`exports` lists (model/uri identity is preserved,
    // so `moduleOf` and per-module export keying are unaffected).
    const root: ProjectModule = { ...rootInput, imports: [], exports: [] };

    const visit = (module: ProjectModule, edgeNode: Import | Export | undefined, fromUri: string | undefined, state: WalkState): WalkState => {
        let next = state;
        if (module.uri !== undefined) {
            if (state.path.includes(module.uri)) {
                return addDiagnostic(next, {
                    node: edgeNode,
                    message: `circular import: '${fromUri ?? module.parent?.uri ?? module.uri}' -> '${module.uri}'`,
                });
            }
            if (state.done.has(module.uri)) return next;
            next = { ...next, path: [...next.path, module.uri] };
        }

        for (const imp of module.model.imports) {
            const spec = parseStringLiteral(imp.path);
            const resolved = opts.resolve(module.uri, spec);
            if (!resolved.uri) {
                const searched = resolved.searched.length > 0 ? ` — searched: ${resolved.searched.join(', ')}` : '';
                next = addDiagnostic(next, { node: imp, message: `cannot resolve import '${spec}'${searched}` });
                continue;
            }
            const text = opts.read(resolved.uri);
            if (text === undefined) {
                next = addDiagnostic(next, { node: imp, message: `cannot resolve import '${spec}' (${resolved.uri})` });
                continue;
            }
            let model: Model;
            try {
                model = opts.parse(text, resolved.uri);
            } catch (err) {
                next = addDiagnostic(next, { node: imp, message: `error parsing import '${spec}': ${err instanceof Error ? err.message : String(err)}` });
                continue;
            }
            let target = next.byUri.get(resolved.uri);
            if (!target) {
                target = { model, uri: resolved.uri, parent: { uri: module.uri ?? '', importNode: imp }, imports: [], exports: [] };
                next = addModule(next, target);
            }
            // The same (alias, file) imported twice in one module is a no-op.
            const existingEdges = next.edges.get(module) ?? [];
            if (!existingEdges.some(e => e.alias === imp.alias && e.target.uri === resolved.uri)) {
                next = addEdge(next, module, { alias: imp.alias, target, importNode: imp });
            }
            next = visit(target, imp, module.uri, next);
        }

        for (const exp of module.model.exports) {
            const spec = parseStringLiteral(exp.path);
            const resolved = opts.resolve(module.uri, spec);
            if (!resolved.uri) {
                const searched = resolved.searched.length > 0 ? ` — searched: ${resolved.searched.join(', ')}` : '';
                next = addDiagnostic(next, { node: exp, message: `cannot resolve re-export '${spec}'${searched}` });
                continue;
            }
            const text = opts.read(resolved.uri);
            if (text === undefined) {
                next = addDiagnostic(next, { node: exp, message: `cannot resolve re-export '${spec}' (${resolved.uri})` });
                continue;
            }
            let model: Model;
            try {
                model = opts.parse(text, resolved.uri);
            } catch (err) {
                next = addDiagnostic(next, { node: exp, message: `error parsing re-export '${spec}': ${err instanceof Error ? err.message : String(err)}` });
                continue;
            }
            let target = next.byUri.get(resolved.uri);
            if (!target) {
                target = { model, uri: resolved.uri, parent: { uri: module.uri ?? '', importNode: exp as unknown as Import }, imports: [], exports: [] };
                next = addModule(next, target);
            }
            // The same file re-exported twice in one module is a no-op.
            const existingEdges = next.exportEdges.get(module) ?? [];
            if (!existingEdges.some(e => e.target.uri === resolved.uri && e.exportNode === exp)) {
                next = addExportEdge(next, module, { target, exportNode: exp });
            }
            next = visit(target, exp, module.uri, next);
        }

        if (module.uri !== undefined) {
            next = {
                ...next,
                path: next.path.filter(uri => uri !== module.uri),
                done: new Set(next.done).add(module.uri),
            };
        }
        return { ...next, order: [...next.order, module] };
    };

    const walked = visit(root, undefined, undefined, emptyState());
    // Compatibility view: all modules in the returned tree are freshly
    // created (or the copied root), so filling `imports`/`exports` once here
    // never mutates a caller-provided object. New code should read the maps.
    for (const [module, edges] of walked.edges) {
        (module as { imports?: readonly ResolvedImportEdge[] }).imports = [...edges];
    }
    for (const [module, edges] of walked.exportEdges) {
        (module as { exports?: readonly ResolvedExportEdge[] }).exports = [...edges];
    }
    return {
        modules: walked.order,
        importsByModule: walked.edges,
        exportsByModule: walked.exportEdges,
        diagnostics: walked.diagnostics,
    };
}

/** Find the module whose model contains the given node. */
export function moduleOf(node: AstNode | undefined, modules: readonly ProjectModule[]): ProjectModule | undefined {
    let current: AstNode | undefined = node;
    while (current) {
        const hit = modules.find(m => m.model === current);
        if (hit) return hit;
        current = current.$container;
    }
    return undefined;
}

/** The re-export edges of a tree, as consumed by the effective-export helpers. */
export interface ExportEdgeView {
    exportsByModule: ReadonlyMap<ProjectModule, readonly ResolvedExportEdge[]>;
}

/**
 * The names a module exposes to importers — its `export`ed bindings plus
 * everything pulled in through re-exports (`export * from` / `export { a }`),
 * following index modules transitively. Used by the LSP so `t.` completion
 * sees through an index module's aggregation.
 */
export function effectiveExportNames(module: ProjectModule, tree: ExportEdgeView, seen: ReadonlySet<ProjectModule> = new Set()): string[] {
    const names = new Set<string>(module.model.bindings.filter(b => b.export).map(b => b.name));
    if (seen.has(module)) return [...names];
    const nextSeen = new Set(seen).add(module);
    for (const { target, exportNode } of tree.exportsByModule.get(module) ?? []) {
        if (exportNode.names.length === 0) {
            for (const name of effectiveExportNames(target, tree, nextSeen)) names.add(name);
        } else {
            for (const item of exportNode.names) names.add(item.renamed ?? item.name);
        }
    }
    return [...names];
}

/**
 * Find the exported binding that a re-exported name ultimately refers to,
 * following `export * from` / `export { a as b } from` chains. Returns
 * undefined when `name` is not exported (directly or transitively).
 */
export function findExportBinding(
    module: ProjectModule,
    name: string,
    tree: ExportEdgeView,
    seen: ReadonlySet<ProjectModule> = new Set(),
): import('./generated/ast.js').Binding | undefined {
    for (const b of module.model.bindings) {
        if (b.export && b.name === name) return b;
    }
    if (seen.has(module)) return undefined;
    const nextSeen = new Set(seen).add(module);
    for (const { target, exportNode } of tree.exportsByModule.get(module) ?? []) {
        if (exportNode.names.length === 0) {
            const found = findExportBinding(target, name, tree, nextSeen);
            if (found) return found;
        } else {
            for (const item of exportNode.names) {
                if ((item.renamed ?? item.name) === name) {
                    return findExportBinding(target, item.name, tree, nextSeen);
                }
            }
        }
    }
    return undefined;
}