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
import { spawn, spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
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

    // Imports are read from disk on every validation, so edits to a lib file
    // only reach open importers when we revalidate them. Langium's
    // DocumentUpdateHandler owns the
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

    setTimeout(() => {
        void tetaue.parser.LangiumParser;
    }, 25);
    startLanguageServer(shared);
}

function startWithBunRuntime(): boolean {
    const versions = process.versions as Record<string, string | undefined>;
    if (versions.bun !== undefined || process.env.TETAUE_LSP_BUN === '1') {
        return false;
    }
    const bun = process.env.TETAUE_BUN ?? 'bun';
    const probe = spawnSync(bun, ['--version'], { stdio: 'ignore' });
    if (probe.error || probe.status !== 0) {
        return false;
    }
    const child = spawn(bun, [fileURLToPath(import.meta.url), ...process.argv.slice(2)], {
        env: { ...process.env, TETAUE_LSP_BUN: '1' },
        stdio: 'inherit',
    });
    child.once('error', error => {
        console.error(`could not start Bun language server: ${error.message}`);
        process.exitCode = 1;
    });
    child.once('exit', (code, signal) => {
        process.exitCode = signal === null ? code ?? 1 : 1;
    });
    for (const signal of ['SIGINT', 'SIGTERM'] as const) {
        process.once(signal, () => child.kill(signal));
    }
    return true;
}

if (process.argv[1] && resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1])) {
    if (!startWithBunRuntime()) {
        startTetaueServer();
    }
}
