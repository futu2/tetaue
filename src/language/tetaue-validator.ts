/******************************************************************************
 * tetaue validator — runs the interpreter over the AST and reports the
 * resulting diagnostics through Langium's validation infrastructure.
 ******************************************************************************/
import type { ValidationAcceptor, ValidationChecks } from 'langium';
import type { TetaueAstType, Model } from './generated/ast.js';
import { analyze } from './interpreter.js';
import type { TetaueServices } from './tetaue-module.js';

export function registerValidationChecks(services: TetaueServices): void {
    const registry = services.validation.ValidationRegistry;
    const checks: ValidationChecks<TetaueAstType> = {
        Model: checkModel,
    };
    registry.register(checks);
}

export function checkModel(model: Model, accept: ValidationAcceptor): void {
    const { diagnostics } = analyze(model);
    for (const diagnostic of diagnostics) {
        accept('error', diagnostic.message, { node: diagnostic.node ?? model });
    }
}
