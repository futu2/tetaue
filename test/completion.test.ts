import { describe, expect, test } from 'bun:test';
import { services, buildDocument } from './helpers.ts';
import { TetaueCompletionProvider } from '../src/language/lsp/completion.js';
import type { CompletionParams } from 'vscode-languageserver';

const USERS = `users: query { id: int, name: string } = table "users"`;

/** Completion labels at a (line, character) position in `text`. */
async function completionsAt(text: string, line: number, character: number): Promise<string[]> {
    const doc = await buildDocument(text);
    const provider = new TetaueCompletionProvider(services);
    const params: CompletionParams = {
        textDocument: { uri: doc.textDocument.uri },
        position: { line, character },
    };
    const list = await provider.getCompletion(doc, params);
    return (list?.items ?? []).map(i => i.label);
}

describe('builtin completion', () => {
    test('suggests prelude builtins in expression positions', async () => {
        const labels = await completionsAt(`${USERS}\nq = users & `, 1, 12);
        for (const name of ['filter', 'map', 'sort', 'take', 'fold', 'distinct',
            'upper', 'lower', 'count', 'sum', 'coalesce', 'abs',
            'current_date', 'date_add', 'ceil', 'floor', 'concat', 'greatest',
            'substring', 'cast', 'like', 'is_null', 'is_true', 'is_false', 'is_unknown']) {
            expect(labels).toContain(name);
        }
    });

    test('filters by the typed prefix', async () => {
        const labels = await completionsAt(`${USERS}\nq = users & fil`, 1, 14);
        expect(labels).toContain('filter');
        expect(labels).not.toContain('filtered');
        expect(labels).not.toContain('take');
        expect(labels).not.toContain('concat');
    });

    test('works at a fresh binding with an empty prefix', async () => {
        const labels = await completionsAt(`${USERS}\nq = `, 1, 4);
        expect(labels).toContain('filter');
        expect(labels).toContain('current_date');
    });

    test('does not suggest builtins after a dot (field access wins)', async () => {
        const labels = await completionsAt(`${USERS}\nq = users & map (u => u.)`, 1, 24);
        expect(labels).toContain('id');
        expect(labels).toContain('name');
        expect(labels).not.toContain('filter');
        expect(labels).not.toContain('upper');
    });

    test('does not suggest builtins inside string literals', async () => {
        const labels = await completionsAt(`${USERS}\nq = users & filter (u => u.name == "fil")`, 1, 37);
        expect(labels).not.toContain('filter');
        expect(labels).not.toContain('concat');
    });

    test('does not suggest builtins inside comments', async () => {
        const labels = await completionsAt(`${USERS}\nq = users & # fil`, 1, 17);
        expect(labels).not.toContain('filter');
        expect(labels).not.toContain('concat');
    });
});
