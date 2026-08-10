/******************************************************************************
 * tetaue module tree — resolves `import "path.tetaue"` statements into an
 * ordered list of modules (imports first, root last) with cycle detection.
 ******************************************************************************/
import type { AstNode } from 'langium';
import type { Import, Model } from './generated/ast.js';
import { parseStringLiteral, type Diagnostic } from './interpreter.js';

export interface ProjectModule {
    model: Model;
    /** Resolved URI of the module (for relative import resolution). */
    uri: string | undefined;
    /** How this module was reached: the importing module's URI and Import node. */
    parent?: { uri: string; importNode: Import };
}

export interface ModuleTreeOptions {
    /** Resolve an import specifier against the importing module's URI. */
    resolve: (importerUri: string | undefined, spec: string) => string;
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
}

/**
 * Walk the import graph of the root module, depth-first, deduplicating by
 * resolved URI. Returns imports before the root so `analyzeProject` can
 * evaluate them in order. Cycles are reported as diagnostics.
 */
export function collectModuleTree(root: ProjectModule, opts: ModuleTreeOptions): ModuleTree {
    const modules: ProjectModule[] = [];
    const diagnostics: Diagnostic[] = [];
    const done = new Set<string>();
    const inProgress = new Set<string>();

    const visit = (module: ProjectModule, importNode: Import | undefined): void => {
        if (module.uri !== undefined) {
            if (inProgress.has(module.uri)) {
                const target = module.parent ? module.parent.uri : module.uri;
                diagnostics.push({ node: importNode, message: `circular import: '${target}' -> '${module.uri}'` });
                return;
            }
            if (done.has(module.uri)) return;
            inProgress.add(module.uri);
        }
        for (const imp of module.model.imports) {
            const spec = parseStringLiteral(imp.path);
            const resolved = opts.resolve(module.uri, spec);
            const text = opts.read(resolved);
            if (text === undefined) {
                diagnostics.push({ node: imp, message: `cannot resolve import '${spec}' (${resolved})` });
                continue;
            }
            let model: Model;
            try {
                model = opts.parse(text, resolved);
            } catch (err) {
                diagnostics.push({ node: imp, message: `error parsing import '${spec}': ${err instanceof Error ? err.message : String(err)}` });
                continue;
            }
            visit({ model, uri: resolved, parent: { uri: module.uri ?? '', importNode: imp } }, imp);
        }
        if (module.uri !== undefined) {
            inProgress.delete(module.uri);
            done.add(module.uri);
        }
        modules.push(module);
    };

    visit(root, undefined);
    return { modules, diagnostics };
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
