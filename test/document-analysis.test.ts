/******************************************************************************
 * document-analysis tests — the LSP's per-document analysis cache:
 * the typed check runs once per document state and is reused until the root
 * text or an imported file changes.
 ******************************************************************************/
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { URI } from 'langium';
import { checkedProjectFor, analysisCacheStats, lspModuleLoader } from '../src/language/lsp/document-analysis.ts';
import { parseModel, services } from './helpers.ts';

function projectDir(): { dir: string; cleanup: () => void } {
    const dir = mkdtempSync(join(tmpdir(), 'tetaue-analysis-'));
    return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const LIB = `export users: query { id: int, name: string } = table "users"\n`;
const ROOT = `import "./lib"\nq = users & take 1\n`;

describe('document-analysis cache', () => {
    test('an unchanged document reuses the memoized checked project', () => {
        const p = projectDir();
        try {
            writeFileSync(join(p.dir, 'lib.tetaue'), LIB);
            const uri = URI.file(join(p.dir, 'main.tetaue')).toString();
            const model = parseModel(ROOT);

            const hitsBefore = analysisCacheStats.hits;
            const missesBefore = analysisCacheStats.misses;
            const first = checkedProjectFor(model, uri, ROOT, services);
            const second = checkedProjectFor(model, uri, ROOT, services);
            expect(first.checked).toBe(second.checked); // same inference result
            expect(analysisCacheStats.misses - missesBefore).toBe(1);
            expect(analysisCacheStats.hits - hitsBefore).toBeGreaterThanOrEqual(1);
            expect(first.checked.diagnostics).toEqual([]);
        } finally {
            p.cleanup();
        }
    });

    test('editing the root document invalidates the analysis', () => {
        const p = projectDir();
        try {
            writeFileSync(join(p.dir, 'lib.tetaue'), LIB);
            const uri = URI.file(join(p.dir, 'main.tetaue')).toString();
            const modelV1 = parseModel(ROOT);
            const first = checkedProjectFor(modelV1, uri, ROOT, services);

            const ROOT2 = `import "./lib"\nq = users & take 5\n`;
            const modelV2 = parseModel(ROOT2);
            const second = checkedProjectFor(modelV2, uri, ROOT2, services);
            expect(second.checked).not.toBe(first.checked);
            // The cached nodeTypes are keyed by the v1 document's AST nodes.
            expect(second.checked.nodeTypes.has(modelV2.bindings[0]!)).toBe(true);
        } finally {
            p.cleanup();
        }
    });

    test('editing an imported file invalidates the analysis', async () => {
        const p = projectDir();
        try {
            writeFileSync(join(p.dir, 'lib.tetaue'), LIB);
            const uri = URI.file(join(p.dir, 'main.tetaue')).toString();
            const model = parseModel(ROOT);
            const first = checkedProjectFor(model, uri, ROOT, services);

            // Change the imported module on disk (mtime + content change).
            await Bun.sleep(20);
            writeFileSync(join(p.dir, 'lib.tetaue'), `export users: query { id: int, name: string, age: int } = table "users"\n`);
            const second = checkedProjectFor(parseModel(ROOT), uri, ROOT, services);
            expect(second.checked).not.toBe(first.checked);
        } finally {
            p.cleanup();
        }
    });

    test('the shared loader reports content versions for imports', () => {
        const p = projectDir();
        try {
            writeFileSync(join(p.dir, 'lib.tetaue'), LIB);
            const uri = URI.file(join(p.dir, 'main.tetaue')).toString();
            const libUri = URI.file(join(p.dir, 'lib.tetaue')).toString();
            checkedProjectFor(parseModel(ROOT), uri, ROOT, services);
            expect(lspModuleLoader.versionOf(libUri)).toBeDefined();
        } finally {
            p.cleanup();
        }
    });
});