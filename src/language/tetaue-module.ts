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
    Cancellation, inject, DefaultDocumentBuilder, DefaultValueConverter, DefaultWorkspaceManager, GrammarAST,
    isOperationCancelled,
    type CstNode, type LangiumDocument, type LangiumSharedCoreServices, type URI, type ValueType, type WorkspaceLock,
} from 'langium';
import {
    createDefaultModule, createDefaultSharedModule,
    type DefaultSharedModuleContext, type LangiumServices, type LangiumSharedServices,
} from 'langium/lsp';
import type { InitializedParams } from 'vscode-languageserver';
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
 * Debounced-validation document builder.
 *
 * Langium re-runs the full validation pipeline on every `didChange`, and for
 * tetaue that validation is the expensive part: the validator walks the whole
 * import closure and re-type-checks the document (`tetaue-validator.ts` →
 * `checkedProjectFor`). To keep typing responsive, this builder:
 *
 *   1. still keeps the document model fresh immediately (parse/link/index so
 *      hover, completion, semantic tokens and folding never lag), but skips
 *      validation while the change arrives;
 *   2. defers the check: once the user stops typing for `validationDelayMs`
 *      (default 500ms), it re-validates exactly the documents that changed,
 *      and diagnostics are published then.
 *
 * The delay is configurable via the `tetaue.validationDelayMs` setting, which
 * the client forwards through `workspace/didChangeConfiguration` (Langium's
 * `ConfigurationProvider` is wired to that notification automatically).
 */
class TetaueDocumentBuilder extends DefaultDocumentBuilder {
    private static readonly DEFAULT_VALIDATION_DELAY_MS = 500;
    private readonly lock: WorkspaceLock;
    private validationDelayMs = TetaueDocumentBuilder.DEFAULT_VALIDATION_DELAY_MS;
    private validationTimer: ReturnType<typeof setTimeout> | undefined;
    private readonly pending = new Map<string, URI>();

    constructor(services: LangiumSharedCoreServices) {
        super(services);
        this.lock = services.workspace.WorkspaceLock;
        const configuration = services.workspace.ConfigurationProvider;
        configuration.onConfigurationSectionUpdate(update => {
            if (update.section === 'tetaue') {
                this.applyValidationDelay(update.configuration?.validationDelayMs);
            }
        });
        // The initial `workspace/configuration` fetch populates the provider
        // without firing section updates; read it once when the provider is
        // ready (a no-op in unit tests, where `ready` never resolves).
        void configuration.getConfiguration('tetaue', 'validationDelayMs').then(
            value => this.applyValidationDelay(value),
            () => undefined,
        );
    }

    private applyValidationDelay(value: unknown): void {
        const delay = typeof value === 'number' && Number.isFinite(value)
            ? Math.max(0, Math.round(value))
            : TetaueDocumentBuilder.DEFAULT_VALIDATION_DELAY_MS;
        this.validationDelayMs = delay;
    }

    override async update(changed: URI[], deleted: URI[], cancelToken = Cancellation.CancellationToken.None): Promise<void> {
        // Remember which documents still need the expensive check.
        for (const uri of deleted) {
            this.pending.delete(uri.toString());
        }
        for (const uri of changed) {
            this.pending.set(uri.toString(), uri);
        }
        // Keep the model fresh (parse/link/index) immediately, but skip the
        // validation phase while the user is still typing. Updates are
        // serialized by the workspace lock, so `updateBuildOptions` is safe
        // to swap for the duration of this call.
        const buildOptions = this.updateBuildOptions;
        this.updateBuildOptions = { ...buildOptions, validation: false };
        try {
            await super.update(changed, deleted, cancelToken);
        } finally {
            this.updateBuildOptions = buildOptions;
            // Even if this update was cancelled (leaving a partially rebuilt
            // document), schedule the check — it force-resets state, so it
            // always ends on a validated document.
            this.scheduleValidation();
        }
    }

    /** Restart the pause timer; validation runs when it fires. */
    private scheduleValidation(): void {
        if (this.validationTimer !== undefined) {
            clearTimeout(this.validationTimer);
        }
        this.validationTimer = setTimeout(() => {
            this.validationTimer = undefined;
            void this.runValidation();
        }, this.validationDelayMs);
    }

    /** Re-validate exactly the documents that changed since the last check. */
    private async runValidation(): Promise<void> {
        if (this.pending.size === 0) return;
        const documents: LangiumDocument[] = [];
        for (const uri of this.pending.values()) {
            const document = this.langiumDocuments.getDocument(uri);
            if (document) documents.push(document);
        }
        this.pending.clear();
        if (documents.length === 0) return;
        try {
            await this.lock.write(() => this.build(documents, { validation: true }, Cancellation.CancellationToken.None));
        } catch (err) {
            if (!isOperationCancelled(err)) {
                console.error('tetaue: deferred validation failed', err);
            }
        }
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
        DocumentBuilder: (services: LangiumSharedCoreServices) => new TetaueDocumentBuilder(services),
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
