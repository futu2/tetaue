/******************************************************************************
 * tetaue VS Code extension — client half.
 *
 * Spawns the bundled language server (server/server.mjs, plain Node) and
 * wires up:
 *   - live LSP diagnostics, completion, outline, folding (server side)
 *   - "Tetaue: Render to SQL" command
 *   - Render-on-Save: every saved .tetaue file is compiled to SQL and shown
 *     in the Tetaue output panel (realtime compile)
 ******************************************************************************/
import * as path from 'node:path';
import * as vscode from 'vscode';
import {
    LanguageClient, LanguageClientOptions, ServerOptions, TransportKind,
} from 'vscode-languageclient/node';

export interface RenderResult {
    ok: boolean;
    sql?: string;
    message?: string;
}

let client: LanguageClient | undefined;

export function activate(context: vscode.ExtensionContext): void {
    const output = vscode.window.createOutputChannel('Tetaue');

    // The server is bundled to plain JS (extension/server/server.mjs) so the
    // extension only needs Node, which ships with VS Code.
    const serverModule = context.asAbsolutePath(path.join('server', 'server.mjs'));
    const serverOptions: ServerOptions = {
        run: { module: serverModule, transport: TransportKind.stdio },
        debug: {
            module: serverModule,
            transport: TransportKind.stdio,
            options: { execArgv: ['--inspect=6009'] },
        },
    };
    const clientOptions: LanguageClientOptions = {
        documentSelector: [{ scheme: 'file', language: 'tetaue' }],
        synchronize: { configurationSection: 'tetaue' },
    };

    client = new LanguageClient('tetaue', 'Tetaue', serverOptions, clientOptions);
    client.start();

    // Forward file changes to the server so it revalidates open importers
    // when a lib module or tetaue.toml changes (imports are resolved from
    // disk, not via LSP references).
    const watcher = vscode.workspace.createFileSystemWatcher('**/{*.tetaue,tetaue.toml}');
    const forward = (uri: vscode.Uri, type: 1 | 2 | 3): void => {
        if (client?.state !== 2 /* State.Running */) return;
        void client.sendNotification('workspace/didChangeWatchedFiles', {
            changes: [{ uri: uri.toString(), type }],
        });
    };
    watcher.onDidCreate(uri => forward(uri, 1));
    watcher.onDidChange(uri => forward(uri, 2));
    watcher.onDidDelete(uri => forward(uri, 3));
    context.subscriptions.push(watcher);

    async function renderToSql(doc?: vscode.TextDocument): Promise<void> {
        const target = doc ?? vscode.window.activeTextEditor?.document;
        if (!target || target.languageId !== 'tetaue') {
            void vscode.window.showInformationMessage('Tetaue: open a .tetaue file first.');
            return;
        }
        if (!client) return;
        const dialect = vscode.workspace.getConfiguration('tetaue').get<string>('dialect', 'sqlite');
        output.show(true);
        output.appendLine(`— tetaue render ${target.fileName}  (dialect: ${dialect})`);
        try {
            const result = await client.sendRequest<RenderResult>('tetaue/render', {
                uri: target.uri.toString(),
                dialect,
            });
            if (result.ok && result.sql !== undefined) {
                output.appendLine(result.sql);
                if (vscode.workspace.getConfiguration('tetaue').get<boolean>('copyToClipboardOnRender', false)) {
                    void vscode.env.clipboard.writeText(result.sql).then(
                        () => {
                            vscode.window.setStatusBarMessage('Tetaue: SQL copied to clipboard', 3000);
                        },
                        () => {
                            void vscode.window.showWarningMessage('Tetaue: failed to copy SQL to the clipboard.');
                        },
                    );
                }
            } else {
                output.appendLine(`error: ${result.message ?? 'unknown error'}`);
            }
        } catch (err) {
            output.appendLine(`error: ${err instanceof Error ? err.message : String(err)}`);
        }
        output.appendLine('');
    }

    context.subscriptions.push(
        vscode.commands.registerCommand('tetaue.renderToSql', () => renderToSql()),
        vscode.workspace.onDidSaveTextDocument(doc => {
            if (doc.languageId !== 'tetaue') return;
            if (vscode.workspace.getConfiguration('tetaue').get<boolean>('renderOnSave', true)) {
                void renderToSql(doc);
            }
        }),
        output,
    );
}

export function deactivate(): Thenable<void> | undefined {
    return client?.stop();
}
