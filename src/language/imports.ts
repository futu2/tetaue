/******************************************************************************
 * tetaue module tree — resolves `import "path.tetaue"` statements into an
 * ordered list of modules (imports first, root last) with cycle detection.
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
     * This module's direct imports, resolved to their target modules in
     * source order. `alias` is set for `import "x.tetaue" as t` (qualified
     * access `t.binding`); undefined for flat imports, which bring the
     * target's exported bindings into scope. Filled during the tree walk,
     * so it is complete once `collectModuleTree` returns.
     */
    imports: { alias: string | undefined; target: ProjectModule; importNode: Import }[];
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
    modules: ProjectModule[];
    /** Import-resolution diagnostics (unresolved files, cycles, parse errors). */
    diagnostics: Diagnostic[];
    /** Non-fatal import-resolution warnings (shadowing, non-self-contained libs). */
    warnings: Diagnostic[];
}

/**
 * Walk the import graph of the root module, depth-first, deduplicating by
 * resolved URI. Returns imports before the root so `analyzeProject` can
 * evaluate them in order. Cycles are reported as diagnostics.
 */
export function collectModuleTree(root: ProjectModule, opts: ModuleTreeOptions): ModuleTree {
    // Never append edges to a caller-reused root: copy it so each walk starts
    // with an empty `imports` list (model/uri identity is preserved, so
    // `moduleOf` and per-module export keying are unaffected).
    root = { ...root, imports: [] };
    const modules: ProjectModule[] = [];
    const diagnostics: Diagnostic[] = [];
    const warnings: Diagnostic[] = [];
    const done = new Set<string>();
    const inProgress = new Set<string>();
    // One module object per resolved URI, so every importer's `imports`
    // entry references the SAME object (diamond dedup) — analysis keys
    // per-module state (exports) by object identity.
    const byUri = new Map<string, ProjectModule>();
    if (root.uri !== undefined) byUri.set(root.uri, root);

    const visit = (module: ProjectModule, importNode: Import | undefined, fromUri: string | undefined): void => {
        if (module.uri !== undefined) {
            if (inProgress.has(module.uri)) {
                // `module.parent` is the FIRST importer that reached this
                // module (byUri dedup), not the edge closing the loop — the
                // importing module's URI is the accurate "from" end.
                diagnostics.push({
                    node: importNode,
                    message: `circular import: '${fromUri ?? module.parent?.uri ?? module.uri}' -> '${module.uri}'`,
                });
                return;
            }
            if (done.has(module.uri)) return;
            inProgress.add(module.uri);
        }
        for (const imp of module.model.imports) {
            const spec = parseStringLiteral(imp.path);
            const resolved = opts.resolve(module.uri, spec);
            if (!resolved.uri) {
                if (resolved.error) {
                    diagnostics.push({ node: imp, message: resolved.error });
                } else {
                    const searched = resolved.searched.length > 0 ? ` — searched: ${resolved.searched.join(', ')}` : '';
                    diagnostics.push({ node: imp, message: `cannot resolve import '${spec}'${searched}` });
                }
                continue;
            }
            const text = opts.read(resolved.uri);
            if (text === undefined) {
                diagnostics.push({ node: imp, message: `cannot resolve import '${spec}' (${resolved.uri})` });
                continue;
            }
            if (resolved.warning) warnings.push({ node: imp, message: resolved.warning });
            let model: Model;
            try {
                model = opts.parse(text, resolved.uri);
            } catch (err) {
                diagnostics.push({ node: imp, message: `error parsing import '${spec}': ${err instanceof Error ? err.message : String(err)}` });
                continue;
            }
            let target = byUri.get(resolved.uri);
            if (!target) {
                target = { model, uri: resolved.uri, parent: { uri: module.uri ?? '', importNode: imp }, imports: [] };
                byUri.set(resolved.uri, target);
            }
            // The same (alias, file) imported twice in one module is a no-op —
            // skip the duplicate edge so its exports don't phantom-collide
            // with the first import's.
            if (!module.imports.some(e => e.alias === imp.alias && e.target.uri === resolved.uri)) {
                module.imports.push({ alias: imp.alias, target, importNode: imp });
            }
            visit(target, imp, module.uri);
        }
        if (module.uri !== undefined) {
            inProgress.delete(module.uri);
            done.add(module.uri);
        }
        modules.push(module);
    };

    visit(root, undefined, undefined);
    return { modules, diagnostics, warnings };
}

/** Find the module whose model contains the given node. */
export function moduleOf(node: AstNode | undefined, modules: ProjectModule[]): ProjectModule | undefined {
    let current: AstNode | undefined = node;
    while (current) {
        const hit = modules.find(m => m.model === current);
        if (hit) return hit;
        current = current.$container;
    }
    return undefined;
}
