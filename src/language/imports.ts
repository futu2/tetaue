/******************************************************************************
 * tetaue module tree — resolves `import "path.tetaue"` statements into an
 * ordered list of modules (imports first, root last) with cycle detection.
 *
 * The traversal is pure with respect to its inputs: no caller-provided module
 * object is mutated. Resolved import edges are returned in a separate
 * immutable map keyed by the importing module instead of being written onto
 * `ProjectModule`.
 ******************************************************************************/
import type { AstNode } from 'langium';
import type { Import, Model } from './generated/ast.js';
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
}

export interface ResolvedImportEdge {
    /** Set for `import "x.tetaue" as t`; undefined for flat imports. */
    alias: string | undefined;
    target: ProjectModule;
    importNode: Import;
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
    /** Import-resolution diagnostics (unresolved files, cycles, parse errors). */
    diagnostics: readonly Diagnostic[];
    /** Non-fatal import-resolution warnings (shadowing, non-self-contained libs). */
    warnings: readonly Diagnostic[];
}

interface WalkState {
    readonly order: readonly ProjectModule[];
    readonly done: ReadonlySet<string>;
    readonly path: readonly string[];
    readonly byUri: ReadonlyMap<string, ProjectModule>;
    readonly edges: ReadonlyMap<ProjectModule, readonly ResolvedImportEdge[]>;
    readonly diagnostics: readonly Diagnostic[];
    readonly warnings: readonly Diagnostic[];
}

const emptyState = (): WalkState => ({
    order: [],
    done: new Set(),
    path: [],
    byUri: new Map(),
    edges: new Map(),
    diagnostics: [],
    warnings: [],
});

function addEdge(state: WalkState, module: ProjectModule, edge: ResolvedImportEdge): WalkState {
    const next = new Map(state.edges);
    next.set(module, [...(next.get(module) ?? []), edge]);
    return { ...state, edges: next };
}

function addModule(state: WalkState, module: ProjectModule): WalkState {
    const next = new Map(state.byUri);
    if (module.uri !== undefined) next.set(module.uri, module);
    return { ...state, byUri: next };
}

function addDiagnostic(state: WalkState, diagnostic: Diagnostic): WalkState {
    return { ...state, diagnostics: [...state.diagnostics, diagnostic] };
}

function addWarning(state: WalkState, warning: Diagnostic): WalkState {
    return { ...state, warnings: [...state.warnings, warning] };
}

/**
 * Walk the import graph of the root module, depth-first, deduplicating by
 * resolved URI. Returns imports before the root so `analyzeProject` can
 * evaluate them in order. Cycles are reported as diagnostics.
 */
export function collectModuleTree(rootInput: ProjectModule, opts: ModuleTreeOptions): ModuleTree {
    // Never append edges to a caller-reused root: copy it so each walk starts
    // with an empty `imports` list (model/uri identity is preserved, so
    // `moduleOf` and per-module export keying are unaffected).
    const root: ProjectModule = { ...rootInput, imports: [] };

    const visit = (module: ProjectModule, importNode: Import | undefined, fromUri: string | undefined, state: WalkState): WalkState => {
        let next = state;
        if (module.uri !== undefined) {
            if (state.path.includes(module.uri)) {
                return addDiagnostic(next, {
                    node: importNode,
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
                if (resolved.error) {
                    next = addDiagnostic(next, { node: imp, message: resolved.error });
                } else {
                    const searched = resolved.searched.length > 0 ? ` — searched: ${resolved.searched.join(', ')}` : '';
                    next = addDiagnostic(next, { node: imp, message: `cannot resolve import '${spec}'${searched}` });
                }
                continue;
            }
            const text = opts.read(resolved.uri);
            if (text === undefined) {
                next = addDiagnostic(next, { node: imp, message: `cannot resolve import '${spec}' (${resolved.uri})` });
                continue;
            }
            if (resolved.warning) next = addWarning(next, { node: imp, message: resolved.warning });
            let model: Model;
            try {
                model = opts.parse(text, resolved.uri);
            } catch (err) {
                next = addDiagnostic(next, { node: imp, message: `error parsing import '${spec}': ${err instanceof Error ? err.message : String(err)}` });
                continue;
            }
            let target = next.byUri.get(resolved.uri);
            if (!target) {
                target = { model, uri: resolved.uri, parent: { uri: module.uri ?? '', importNode: imp }, imports: [] };
                next = addModule(next, target);
            }
            // The same (alias, file) imported twice in one module is a no-op.
            const existingEdges = next.edges.get(module) ?? [];
            if (!existingEdges.some(e => e.alias === imp.alias && e.target.uri === resolved.uri)) {
                next = addEdge(next, module, { alias: imp.alias, target, importNode: imp });
            }
            next = visit(target, imp, module.uri, next);
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
    // created (or the copied root), so filling `imports` once here never
    // mutates a caller-provided object. New code should read `importsByModule`.
    for (const [module, edges] of walked.edges) {
        (module as { imports?: readonly ResolvedImportEdge[] }).imports = [...edges];
    }
    return {
        modules: walked.order,
        importsByModule: walked.edges,
        diagnostics: walked.diagnostics,
        warnings: walked.warnings,
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
