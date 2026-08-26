/******************************************************************************
 * Debounced validation test — the LSP document builder skips the expensive
 * validation pass while typing and only re-checks the document once the
 * typing pause (`tetaue.validationDelayMs`) has elapsed.
 ******************************************************************************/
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NodeFileSystem } from 'langium/node';
import { Cancellation, URI } from 'langium';
import { createTetaueServices } from '../src/language/tetaue-module.js';

const DELAY_MS = 80;

const ERRONEOUS = [
    'users: query { id: int } = table "users"',
    'q = users & filter (u => u.id == "x")',
    '',
].join('\n');

const CORRECT = [
    'users: query { id: int } = table "users"',
    'q = users & filter (u => u.id == 1)',
    '',
].join('\n');

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/** Poll until `predicate` is true or the timeout elapses. */
async function until(predicate: () => boolean, timeoutMs = 2000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (predicate()) return true;
        await sleep(25);
    }
    return predicate();
}

describe('debounced validation', () => {
    test('type-checks only after the typing pause', async () => {
        const { shared } = createTetaueServices(NodeFileSystem);
        // Shorten the pause for the test; the setting reaches the builder
        // through Langium's ConfigurationProvider (the same path the client
        // uses for `workspace/didChangeConfiguration`).
        shared.workspace.ConfigurationProvider.updateConfiguration({
            settings: { tetaue: { validationDelayMs: DELAY_MS } },
        });

        const dir = mkdtempSync(join(tmpdir(), 'tetaue-debounce-'));
        const file = join(dir, 'main.tetaue');
        const fileUri = URI.file(file).toString();
        const builder = shared.workspace.DocumentBuilder;
        const documents = shared.workspace.LangiumDocuments;
        const cancel = Cancellation.CancellationToken.None;
        try {
            // First keystroke burst: the model updates immediately, but the
            // heavy check is deferred until the pause elapses.
            writeFileSync(file, ERRONEOUS);
            await builder.update([URI.parse(fileUri)], [], cancel);

            let doc = documents.getDocument(URI.parse(fileUri));
            expect(doc).toBeDefined();
            await sleep(DELAY_MS / 2);
            expect(doc!.diagnostics).toBeUndefined();

            // ...and lands once the user stops typing.
            expect(await until(() => doc!.diagnostics !== undefined)).toBe(true);
            const messages = (doc!.diagnostics ?? []).map(d => d.message);
            expect(messages.length).toBeGreaterThan(0);
            expect(messages.join('\n')).toContain('cannot compare int with string');

            // Typing again defers the check again ...
            writeFileSync(file, CORRECT);
            await builder.update([URI.parse(fileUri)], [], cancel);
            doc = documents.getDocument(URI.parse(fileUri))!;

            await sleep(DELAY_MS / 2);
            expect(doc.diagnostics).toBeUndefined();

            // ... and after another quiet period the document is clean.
            expect(await until(() => doc.diagnostics !== undefined)).toBe(true);
            expect(doc.diagnostics).toEqual([]);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});