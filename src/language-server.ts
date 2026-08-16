/******************************************************************************
 * tetaue language server — LSP entry point.
 *
 *   tetaue lsp [--stdio | --node-ipc | --socket=<port>]   (CLI)
 *   node server.mjs --stdio                                (VS Code client)
 *
 * Serves live diagnostics (from the validator), grammar-driven completion /
 * hover / document symbols / folding, and a custom `tetaue/render` request
 * that compiles the current document to SQL — the "realtime compile" half
 * used by the extension's Render-on-Save / Render to SQL commands. The CLI's
 * `lsp` command starts the same server on the requested transport.
 ******************************************************************************/
import { readFileSync } from 'node:fs';
import { URI } from 'langium';
import { NodeFileSystem } from 'langium/node';
import { startLanguageServer } from 'langium/lsp';
import { createConnection, ProposedFeatures } from 'vscode-languageserver/node';
import { createTetaueServices } from './language/tetaue-module.js';
import { compileModuleText } from './language/compile.js';
import { isDialect } from './language/render.js';

export interface RenderParams {
    /** The document URI to compile (file: URIs). */
    uri: string;
    /** SQL dialect: sqlite | postgresql | mysql | trino | hive (default: sqlite). */
    dialect?: string;
}

export interface RenderResult {
    ok: boolean;
    /** Rendered SQL when `ok`. */
    sql?: string;
    /** Named query parameters in encounter order when `ok`. */
    parameters?: string[];
    /** Human-readable error (first diagnostic) when `!ok`. */
    message?: string;
}

/**
 * Start the language server on the transport requested in `process.argv`.
 * vscode-languageserver ≥10 requires an explicit transport flag in argv (its
 * `createConnection` scans `process.argv` for it); default to `--stdio` so
 * the server works no matter how it is launched (CLI `lsp`, extension spawn,
 * or a bare `node server.mjs`).
 */
export function startTetaueServer(): void {
    const hasTransport = process.argv.some(a =>
        a === '--stdio' || a === '--node-ipc' || a === '--socket' || a.startsWith('--socket=') || a === '--pipe' || a.startsWith('--pipe='),
    );
    if (!hasTransport) {
        process.argv.push('--stdio');
    }
    const connection = createConnection(ProposedFeatures.all);

    const { shared, tetaue } = createTetaueServices({ connection, ...NodeFileSystem });

    // Imports and tetaue.toml are read from disk on every validation, so edits
    // to a lib file or the manifest only reach open importers when we
    // revalidate them. Langium's DocumentUpdateHandler owns the
    // workspace/didChangeWatchedFiles registration (registering our own would
    // overwrite it); subscribe to its change event instead and re-run
    // validation on every open document. build({validation:true}) forces
    // re-validation; in-memory (unsaved) document text is preserved.
    const updateHandler = shared.lsp.DocumentUpdateHandler;
    if (updateHandler) {
        updateHandler.onWatchedFilesChange(async () => {
            const open = [...shared.workspace.LangiumDocuments.all];
            if (open.length === 0) return;
            await shared.workspace.WorkspaceLock.write(async () => {
                await shared.workspace.DocumentBuilder.build(open, { validation: true });
            });
        });
    }

    // Realtime compile: render the document at `uri` to SQL.
    connection.onRequest('tetaue/render', async (params: RenderParams): Promise<RenderResult> => {
        const uri = params?.uri;
        if (typeof uri !== 'string' || uri.length === 0) {
            return { ok: false, message: 'tetaue/render: missing uri' };
        }
        const parsedUri = URI.parse(uri);
        if (parsedUri.scheme !== 'file') {
            return { ok: false, message: 'tetaue/render: only file: URIs are supported' };
        }

        // Prefer the live in-memory document (includes unsaved changes).
        let text: string | undefined;
        const doc = shared.workspace.LangiumDocuments.getDocument(parsedUri);
        if (doc) {
            text = doc.textDocument.getText();
        } else {
            try {
                text = readFileSync(parsedUri.fsPath, 'utf8');
            } catch {
                // keep undefined
            }
        }
        if (text === undefined) {
            return { ok: false, message: `tetaue/render: could not read ${uri}` };
        }

        const dialect = typeof params?.dialect === 'string' && isDialect(params.dialect) ? params.dialect : 'sqlite';
        const outcome = compileModuleText(uri, text, tetaue, { dialect });
        if (outcome.ok) {
            return { ok: true, sql: outcome.sql, parameters: outcome.parameters };
        }
        const first = outcome.diagnostics[0];
        const message = first
            ? `${first.uri}:${first.line + 1}:${first.character + 1}: ${first.message}`
            : 'module does not evaluate to a query';
        return { ok: false, message };
    });

    startLanguageServer(shared);
}

if (import.meta.main) {
    startTetaueServer();
}
