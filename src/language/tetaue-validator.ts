/******************************************************************************
 * tetaue validator — runs the interpreter over the AST (resolving imports)
 * and reports the resulting diagnostics through Langium's validation.
 *
 * Diagnostics that belong to imported modules are folded onto the `import`
 * statement that leads to them, so a single open file shows its imports'
 * problems too.
 ******************************************************************************/
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { URI, type AstNode, type ValidationAcceptor, type ValidationChecks } from 'langium';
import type { Import, TetaueAstType, Model } from './generated/ast.js';
import { analyzeProject, parseStringLiteral, type Diagnostic } from './interpreter.js';
import { inferProject, mergeDiagnostics } from './inference.js';
import { createImportResolver } from './resolve.js';
import type { TetaueServices } from './tetaue-module.js';
import { collectModuleTree, moduleOf } from './imports.js';
import type { ProjectModule } from './imports.js';

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
    const { modules, importsByModule, diagnostics, warnings } = collectModuleTree({ model, uri: rootUri, imports: [] }, {
        resolve: createImportResolver(),
        read: (uri) => {
            try {
                return readFileSync(URI.parse(uri).fsPath, 'utf8');
            } catch {
                return undefined;
            }
        },
        parse: (text, uri) => {
            const result = services.parser.LangiumParser.parse(text);
            const parseErrors = [
                ...result.lexerErrors.map(e => e.message),
                ...result.parserErrors.map(e => e.message),
            ];
            if (!result.value || parseErrors.length > 0) {
                throw new Error(parseErrors.join('; ') || 'no parse result');
            }
            return result.value as Model;
        },
    });

    // The root document is analyzed without the query requirement (imported
    // helper modules legitimately end in non-query bindings); the CLI enforces
    // it for the root. The type-inference pass runs alongside the interpreter;
    // the two are merged with exact (node, message) dedupe so each type error
    // is reported exactly once.
    const result = analyzeProject(modules, { requireQuery: false, importsByModule });
    const { diagnostics: typeDiagnostics } = inferProject(modules, importsByModule);
    const merged = mergeDiagnostics(modules, diagnostics, result.diagnostics, typeDiagnostics);

    for (const diagnostic of merged) acceptFolded(diagnostic, 'error', model, modules, accept);
    for (const warning of warnings) acceptFolded(warning, 'warning', model, modules, accept);
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
