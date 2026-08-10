/******************************************************************************
 * tetaue Langium module — dependency injection wiring.
 ******************************************************************************/
import {
    createDefaultCoreModule, createDefaultSharedCoreModule, inject,
    DefaultValueConverter, GrammarAST,
    type CstNode, type DefaultSharedCoreModuleContext, type LangiumCoreServices,
    type LangiumSharedCoreServices, type ValueType,
} from 'langium';
import { TetaueGeneratedModule, TetaueGeneratedSharedModule } from './generated/module.js';
import { registerValidationChecks } from './tetaue-validator.js';

export type TetaueServices = LangiumCoreServices;
export type TetaueSharedServices = LangiumSharedCoreServices;

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
};

export function createTetaueServices(context: DefaultSharedCoreModuleContext): {
    shared: TetaueSharedServices;
    tetaue: TetaueServices;
} {
    const shared = inject(
        createDefaultSharedCoreModule(context),
        TetaueGeneratedSharedModule,
    );
    const tetaue = inject(
        createDefaultCoreModule({ shared }),
        TetaueGeneratedModule,
        TetaueModule,
    );
    shared.ServiceRegistry.register(tetaue);
    registerValidationChecks(tetaue);
    return { shared, tetaue };
}
