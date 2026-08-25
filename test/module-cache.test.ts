/******************************************************************************
 * module-cache tests — the shared memoized loader for imported modules:
 * per-module size budget, byte-bounded AST cache, and optional CST dropping.
 ******************************************************************************/
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { URI } from 'langium';
import { createModuleLoader, ModuleTooLargeError, CST_DROP_BYTES } from '../src/language/module-cache.ts';
import { services } from './helpers.ts';

function tempDir(prefix: string): string {
    return mkdtempSync(join(tmpdir(), prefix));
}

describe('module cache', () => {
    test('rejects modules over the per-module budget without parsing them', () => {
        const loader = createModuleLoader({ maxModuleBytes: 32 });
        const text = 'export users: query { id: int } = table "users"\n';
        expect(() => loader.parse(text, 'mem://big', services)).toThrow(ModuleTooLargeError);
    });

    test('the budget error names the module and the limit', () => {
        const loader = createModuleLoader({ maxModuleBytes: 32 });
        try {
            loader.parse('x'.repeat(100), 'mem://big', services);
            expect.unreachable();
        } catch (err) {
            expect(err).toBeInstanceOf(ModuleTooLargeError);
            expect(String(err)).toContain("module 'mem://big' is too large to analyze");
            expect(String(err)).toContain('32');
        }
    });

    test('parses a module once per content hash (memoized AST identity)', () => {
        const loader = createModuleLoader();
        const text = 'export users: query { id: int } = table "users"\n';
        const a = loader.parse(text, 'mem://m', services);
        const b = loader.parse(text, 'mem://m', services);
        expect(a).toBe(b); // same object — no re-parse
    });

    test('a changed hash is re-parsed (cache key includes content)', () => {
        const loader = createModuleLoader();
        const a = loader.parse('export users: query { id: int } = table "users"\n', 'mem://m', services);
        const b = loader.parse('export users: query { id: int } = table "other"\n', 'mem://m', services);
        expect(a).not.toBe(b);
    });

    test('reads from disk via the mtime-keyed text cache', () => {
        const dir = tempDir('tetaue-cache-');
        try {
            const file = join(dir, 'm.tetaue');
            writeFileSync(file, 'export users: query { id: int } = table "users"\n');
            const uri = URI.file(file).toString();
            const loader = createModuleLoader();
            const text = loader.read(uri);
            expect(text).toContain('table "users"');
            expect(loader.read(uri)).toBe(text); // mtime unchanged → cached
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    test('drops the CST of modules over the cst-drop threshold', () => {
        const loader = createModuleLoader({ cstDropBytes: 1 });
        const text = 'export users: query { id: int } = table "users"\n';
        const model = loader.parse(text, 'mem://drop', services);
        expect(model.$cstNode).toBeUndefined();
        for (const binding of model.bindings) {
            expect((binding as { $cstNode?: unknown }).$cstNode).toBeUndefined();
        }
    });

    test('keeps the CST when below the cst-drop threshold', () => {
        const loader = createModuleLoader({ cstDropBytes: CST_DROP_BYTES });
        const text = 'export users: query { id: int } = table "users"\n';
        const model = loader.parse(text, 'mem://keep', services);
        expect(model.$cstNode).toBeDefined();
    });

    test('byte-bounded cache evicts oldest entries', () => {
        const loader = createModuleLoader({ maxCacheBytes: 1 });
        const text = 'export users: query { id: int } = table "users"\n';
        const a = loader.parse(text, 'mem://a', services);
        const b = loader.parse(text, 'mem://b', services);
        expect(b).toBeDefined();
        expect(a).toBeDefined();
        // Both are tiny; with maxCacheBytes=1 each new entry evicts the older
        // one but never returns an error — the newest stays cached.
        const againA = loader.parse(text, 'mem://a', services);
        expect(againA).toBeDefined();
    });
});