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
import { analyzeProject, parseStringLiteral } from './interpreter.js';
import type { TetaueServices } from './tetaue-module.js';
import { collectModuleTree, moduleOf } from './imports.js';
import type { ProjectModule } from './imports.js';

let validationServices: TetaueServices | undefined;

export function registerValidationChecks(services: TetaueServices): void {
    validationServices = services;
    const registry = services.validation.ValidationRegistry;
    const checks: ValidationChecks<TetaueAstType> = {
        Model: checkModel,
    };
    registry.register(checks);
}

export function checkModel(model: Model, accept: ValidationAcceptor): void {
    const services = validationServices;
    if (!services) return;

    const rootUri = model.$document?.uri.toString();
    const { modules, diagnostics } = collectModuleTree({ model, uri: rootUri }, {
        resolve: (importerUri, spec) => {
            const base = importerUri ? path.dirname(URI.parse(importerUri).fsPath) : process.cwd();
            return URI.file(path.resolve(base, spec)).toString();
        },
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
    // it for the root.
    const result = analyzeProject(modules.map(m => m.model), { requireQuery: false });

    for (const diagnostic of [...diagnostics, ...result.diagnostics]) {
        const node = diagnostic.node;
        if (node && belongsTo(node, model)) {
            accept('error', diagnostic.message, { node });
        } else {
            // The diagnostic lives in an imported module: fold it onto the
            // `import` statement of THIS document that leads to that module.
            const owner = moduleOf(node, modules);
            const anchor = owner ? directImportNodeFor(owner, modules, model) : undefined;
            if (anchor) {
                const prefix = owner && owner.uri ? `in imported module '${basename(owner.uri)}': ` : '';
                accept('error', prefix + diagnostic.message, { node: anchor });
            }
        }
    }
}

/** The `import` statement of `model` whose subtree contains `module`. */
function directImportNodeFor(module: ProjectModule, modules: ProjectModule[], model: Model): Import | undefined {
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
