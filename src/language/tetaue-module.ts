/******************************************************************************
 * tetaue Langium module — dependency injection wiring.
 *
 * Uses the full `langium/lsp` service set (core + LSP), so the generated
 * grammar powers the default hover / definition / completion / document
 * symbol / folding providers out of the box, and `registerValidationChecks`
 * turns interpreter + inference diagnostics into live LSP diagnostics.
 ******************************************************************************/
import {
    inject, DefaultValueConverter, GrammarAST,
    type CstNode, type ValueType,
} from 'langium';
import {
    createDefaultModule, createDefaultSharedModule,
    type DefaultSharedModuleContext, type LangiumServices, type LangiumSharedServices,
} from 'langium/lsp';
import { TetaueGeneratedModule, TetaueGeneratedSharedModule } from './generated/module.js';
import { registerValidationChecks } from './tetaue-validator.js';
import { TetaueHoverProvider } from './lsp/hover.js';
import { TetaueCompletionProvider } from './lsp/completion.js';
import { TetaueDefinitionProvider } from './lsp/definition.js';
import { TetaueFormatter } from './lsp/formatter.js';
import { TetaueSemanticTokenProvider } from './lsp/semantic-tokens.js';

export type TetaueServices = LangiumServices;
export type TetaueSharedServices = LangiumSharedServices;

/**
 * Keeps STRING terminal values raw (including the surrounding quotes) so the
 * interpreter's parseStringLiteral controls unescaping — the Langium default
 * silently drops unknown escape sequences like `\U`.
 */
class TetaueValueConverter extends DefaultValueConverter {
    override convert(input: string, cstNode: CstNode): ValueType {
        const feature = cstNode.grammarSource;
        if (feature && GrammarAST.isRuleCall(feature) && feature.rule.ref?.name === 'STRING') {
            return input;
        }
        return super.convert(input, cstNode);
    }
}

const TetaueModule = {
    parser: {
        ValueConverter: () => new TetaueValueConverter(),
    },
    lsp: {
        HoverProvider: (services: TetaueServices) => new TetaueHoverProvider(services),
        CompletionProvider: (services: TetaueServices) => new TetaueCompletionProvider(services),
        DefinitionProvider: (services: TetaueServices) => new TetaueDefinitionProvider(services),
        Formatter: (services: TetaueServices) => new TetaueFormatter(services),
        SemanticTokenProvider: (services: TetaueServices) => new TetaueSemanticTokenProvider(services),
    },
};

export function createTetaueServices(context: DefaultSharedModuleContext): {
    shared: TetaueSharedServices;
    tetaue: TetaueServices;
} {
    const shared = inject(
        createDefaultSharedModule(context),
        TetaueGeneratedSharedModule,
    );
    const tetaue = inject(
        createDefaultModule({ shared }),
        TetaueGeneratedModule,
        TetaueModule,
    );
    shared.ServiceRegistry.register(tetaue);
    registerValidationChecks(tetaue);
    return { shared, tetaue };
}
