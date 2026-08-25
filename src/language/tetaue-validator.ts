/******************************************************************************
 * tetaue validator — runs the single checker pass over the AST (resolving
 * imports) and reports the resulting diagnostics through Langium's validation.
 *
 * Diagnostics that belong to imported modules are folded onto the `import`
 * statement that leads to them, so a single open file shows its imports'
 * problems too.
 ******************************************************************************/
import { URI, type AstNode, type ValidationAcceptor, type ValidationChecks } from 'langium';
import * as path from 'node:path';
import type { Import, TetaueAstType, Model } from './generated/ast.js';
import { parseStringLiteral, type Diagnostic } from './interpreter.js';
import { mergeDiagnostics } from './inference.js';
import { checkProject } from './checker.js';
import { createImportResolver } from './resolve.js';
import { createModuleLoader, CST_DROP_BYTES } from './module-cache.js';
import type { TetaueServices } from './tetaue-module.js';
import { collectModuleTree, moduleOf } from './imports.js';
import type { ProjectModule } from './imports.js';
import { standardPrelude } from './prelude.js';

/**
 * The LSP validator is the hot path: it runs on every keystroke for every
 * open document. Imported modules are read/parsed through a shared loader
 * (mtime-keyed text, hash-keyed AST, per-module size budget, byte-bounded
 * cache) so the whole import closure is NOT re-parsed per keystroke, and
 * modules above the CST threshold lose their CST after parsing — the only
 * CST that must survive is the open document's, and imported diagnostics
 * are folded onto its `import` statement anyway.
 */
const moduleLoader = createModuleLoader({ cstDropBytes: CST_DROP_BYTES });

export function registerValidationChecks(services: TetaueServices): void {
    const registry = services.validation.ValidationRegistry;
    // Capture the service in a closure instead of a module-level singleton.
    const checks: ValidationChecks<TetaueAstType> = {
        Model: (model, accept) => checkModel(model, accept, services),
    };
    registry.register(checks);
}

export function checkModel(model: Model, accept: ValidationAcceptor, services: TetaueServices): void {
    const rootUri = model.$document?.uri.toString();
    const { modules, importsByModule, exportsByModule, diagnostics } = collectModuleTree({ model, uri: rootUri, imports: [] }, {
        resolve: createImportResolver(),
        read: moduleLoader.read,
        parse: (text, uri) => moduleLoader.parse(text, uri, services),
    });

    // The root document is analyzed without the query requirement (imported
    // helper modules legitimately end in non-query bindings); the CLI enforces
    // it for the root. The checker runs IR construction and type inference as
    // one pass and returns the exact-deduped diagnostics.
    const { diagnostics: checked } = checkProject(modules, {
        requireQuery: false,
        importsByModule,
        reexportsByModule: exportsByModule,
        prelude: standardPrelude(services),
    });
    // Tree diagnostics (unresolved imports, cycles, parse errors) are not
    // produced by the checker, so fold them into the same exact-deduped list.
    const merged = mergeDiagnostics(modules, diagnostics, checked);

    for (const diagnostic of merged) acceptFolded(diagnostic, 'error', model, modules, accept);
}

/**
 * Report a diagnostic on its node — or, when it lives in an imported module
 * (or has no anchorable node), fold it onto the `import` statement of THIS
 * document that leads to that module. Unanchorable nodes fall back to the
 * root module so the error is never dropped.
 */
function acceptFolded(
    diagnostic: Diagnostic,
    severity: 'error' | 'warning',
    model: Model,
    modules: readonly ProjectModule[],
    accept: ValidationAcceptor,
): void {
    const node = diagnostic.node;
    if (node && belongsTo(node, model)) {
        accept(severity, diagnostic.message, { node });
        return;
    }
    const root = modules[modules.length - 1];
    const owner = node ? (moduleOf(node, modules) ?? root) : undefined;
    const isRoot = owner === root;
    const anchor = owner
        ? (isRoot && node?.$cstNode ? node : directImportNodeFor(owner, modules, model))
        : undefined;
    if (anchor) {
        const prefix = owner && owner.uri && !isRoot ? `in imported module '${basename(owner.uri)}': ` : '';
        accept(severity, prefix + diagnostic.message, { node: anchor });
    } else if (model.$cstNode) {
        // Truly unanchorable (no node, or a synthetic placeholder):
        // attach to the document root so the error is not dropped.
        accept(severity, diagnostic.message, { node: model });
    }
}

/** The `import` statement of `model` whose subtree contains `module`. */
function directImportNodeFor(module: ProjectModule, modules: readonly ProjectModule[], model: Model): Import | undefined {
    if (!module.uri) return undefined;
    for (const imp of model.imports) {
        const spec = parseStringLiteral(imp.path);
        const resolved = URI.file(path.resolve(path.dirname(model.$document ? URI.parse(model.$document.uri.toString()).fsPath : process.cwd()), spec)).toString();
        if (module.uri === resolved) return imp;
        // nested: is `module` in the subtree of `resolved`?
        const subtree = modules.find(m => m.uri === resolved);
        if (subtree) {
            let current: ProjectModule | undefined = module;
            while (current && current.uri !== resolved) {
                const parentUri: string | undefined = current.parent?.uri;
                current = parentUri !== undefined ? modules.find(m => m.uri === parentUri) : undefined;
            }
            if (current?.uri === resolved) return imp;
        }
    }
    return undefined;
}

function basename(uri: string): string {
    return uri.slice(uri.lastIndexOf('/') + 1);
}

function belongsTo(node: AstNode | undefined, model: Model): boolean {
    let current: AstNode | undefined = node;
    while (current) {
        if (current === model) return true;
        current = current.$container;
    }
    return false;
}
