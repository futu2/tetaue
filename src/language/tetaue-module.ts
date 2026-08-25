/******************************************************************************
 * tetaue Langium module — dependency injection wiring.
 *
 * Uses the full `langium/lsp` service set (core + LSP), so the generated
 * grammar powers the default hover / definition / completion / document
 * symbol / folding providers out of the box, and `registerValidationChecks`
 * turns interpreter + inference diagnostics into live LSP diagnostics.
 *
 * The workspace is intentionally LAZY: the default Langium WorkspaceManager
 * parses every `.tetaue` file under the opened folder at startup and retains
 * each AST + full CST for the server's lifetime. Vendored schema libraries
 * can be hundreds of modules / millions of lines, which is exactly what OOMs
 * the server. TetaueWorkspaceManager skips that traversal: only OPEN
 * documents are parsed (on didOpen), and imported modules are resolved and
 * loaded on demand from disk by the memoized, budgeted module loader
 * (`module-cache.ts`).
 ******************************************************************************/
import {
    inject, DefaultValueConverter, GrammarAST,
    type CstNode, type ValueType,
} from 'langium';
import {
    createDefaultModule, createDefaultSharedModule,
    type DefaultSharedModuleContext, type LangiumServices, type LangiumSharedServices,
} from 'langium/lsp';
import type { InitializedParams } from 'vscode-languageserver';
import { DefaultWorkspaceManager } from 'langium';
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
 * Do not index the whole workspace at startup. Only open documents are
 * loaded (Langium's didOpen handler builds exactly the opened file); the
 * import closure is resolved on demand from disk per request. `ready`
 * resolves immediately so LSP features that await it never block.
 */
class TetaueWorkspaceManager extends DefaultWorkspaceManager {
    override async initialized(_params: InitializedParams): Promise<void> {
        await this.mutex.write(() => {
            this._ready.resolve();
        });
    }
}

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

const TetaueSharedModule = {
    workspace: {
        WorkspaceManager: (services: LangiumSharedServices) => new TetaueWorkspaceManager(services),
    },
};

export function createTetaueServices(context: DefaultSharedModuleContext): {
    shared: TetaueSharedServices;
    tetaue: TetaueServices;
} {
    const shared = inject(
        createDefaultSharedModule(context),
        TetaueGeneratedSharedModule,
        TetaueSharedModule,
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
