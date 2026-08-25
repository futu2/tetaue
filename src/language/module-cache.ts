/******************************************************************************
 * module-cache — the shared, memoized loader for IMPORTED module files.
 *
 * The LSP and CLI both resolve imported modules from disk on demand. This
 * loader makes that cheap and bounded:
 *
 *   - a module's TEXT is read at most once per mtime (edits invalidate it),
 *   - a module's AST is parsed at most once per content hash (re-parsing the
 *     same file on every keystroke is the fast way to OOM),
 *   - modules larger than the per-module budget are rejected with
 *     `ModuleTooLargeError` ("module too large to analyze") instead of being
 *     parsed — a generated 8 MB schema module must not crash the server,
 *   - the AST cache is bounded by BYTES, not entries, so a big dependency
 *     tree can never accumulate unbounded ASTs for the server's lifetime,
 *   - optionally (LSP only) the full CST is dropped from imported modules
 *     above a size threshold after parsing — the CST is only needed for
 *     positions/doc-comments, which are folded onto the open document's
 *     `import` statement anyway.
 ******************************************************************************/
import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { AstUtils, URI } from 'langium';
import type { TetaueServices } from './tetaue-module.js';
import type { Model } from './generated/ast.js';

/** Largest imported module that is still parsed (source length in UTF-16 units). */
export const DEFAULT_MODULE_BUDGET_BYTES = 4 * 1024 * 1024;
/** Total AST-retention budget for imported modules (bytes of source text). */
export const DEFAULT_AST_CACHE_BYTES = 64 * 1024 * 1024;
/** LSP-only: imported modules above this size lose their CST after parsing. */
export const CST_DROP_BYTES = 512 * 1024;

/** Thrown by the loader's `parse` when a module exceeds the size budget. */
export class ModuleTooLargeError extends Error {
    constructor(uri: string, bytes: number, budget: number) {
        super(`module '${uri}' is too large to analyze (${formatBytes(bytes)} > ${formatBytes(budget)} budget)`);
        this.name = 'ModuleTooLargeError';
    }
}

export interface ModuleLoaderOptions {
    /** Per-module budget: imported modules larger than this are not parsed. */
    maxModuleBytes?: number;
    /** Total AST cache budget: oldest cached ASTs are evicted past this. */
    maxCacheBytes?: number;
    /** Drop the CST of imported modules above this size (0 = never drop). */
    cstDropBytes?: number;
}

export interface ModuleLoader {
    /** Read a module's source by URI (undefined when unreadable/missing). */
    read(uri: string): string | undefined;
    /** Parse module text into a Model; throws `ModuleTooLargeError` and parse errors. */
    parse(text: string, uri: string, services: TetaueServices): Model;
}

function hashText(text: string): string {
    return createHash('sha1').update(text).digest('hex');
}

function formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

interface TextEntry {
    mtimeMs: number;
    text: string;
}

interface AstEntry {
    hash: string;
    /** Source-text length, the proxy for retained AST bytes. */
    bytes: number;
    model: Model;
}

/** Build the shared module loader (one per process). */
export function createModuleLoader(options: ModuleLoaderOptions = {}): ModuleLoader {
    const maxModuleBytes = options.maxModuleBytes ?? DEFAULT_MODULE_BUDGET_BYTES;
    const maxCacheBytes = options.maxCacheBytes ?? DEFAULT_AST_CACHE_BYTES;
    const cstDropBytes = options.cstDropBytes ?? 0;

    // Insertion-ordered: the Map's first keys are the oldest entries.
    const textCache = new Map<string, TextEntry>();
    const astCache = new Map<string, AstEntry>();
    let astBytes = 0;

    const read = (uri: string): string | undefined => {
        try {
            const fsPath = URI.parse(uri).fsPath;
            const mtimeMs = statSync(fsPath).mtimeMs;
            const cached = textCache.get(fsPath);
            if (cached && cached.mtimeMs === mtimeMs) return cached.text;
            const text = readFileSync(fsPath, 'utf8');
            textCache.set(fsPath, { mtimeMs, text });
            return text;
        } catch {
            return undefined;
        }
    };

    const parse = (text: string, uri: string, services: TetaueServices): Model => {
        if (text.length > maxModuleBytes) {
            throw new ModuleTooLargeError(uri, text.length, maxModuleBytes);
        }
        const hash = hashText(text);
        const key = `${uri}\u0000${hash}`;
        const cached = astCache.get(key);
        if (cached && cached.hash === hash) return cached.model;

        const model = parseModel(text, uri, services);
        if (cstDropBytes > 0 && text.length > cstDropBytes) dropCst(model);
        const bytes = text.length;
        const prev = astCache.get(key);
        if (prev) astBytes -= prev.bytes;
        astCache.set(key, { hash, bytes, model });
        astBytes += bytes;
        // Evict oldest entries until the cache fits its byte budget.
        while (astBytes > maxCacheBytes && astCache.size > 1) {
            const oldest = astCache.keys().next().value as string;
            const evicted = astCache.get(oldest)!;
            astCache.delete(oldest);
            astBytes -= evicted.bytes;
        }
        return model;
    };

    return { read, parse };
}

/** Parse text into a Model, throwing with a message on lexer/parser errors. */
export function parseModel(text: string, uri: string, services: TetaueServices): Model {
    const result = services.parser.LangiumParser.parse(text);
    const parseErrors = [
        ...result.lexerErrors.map(e => e.message),
        ...result.parserErrors.map(e => e.message),
    ];
    if (!result.value || parseErrors.length > 0) {
        throw new Error(parseErrors.join('; ') || 'no parse result');
    }
    return result.value as Model;
}

/** Null out every AST node's `$cstNode` so the parse's CST tree can be GC'd. */
function dropCst(model: Model): void {
    for (const node of AstUtils.streamAst(model)) {
        (node as { $cstNode?: unknown }).$cstNode = undefined;
    }
}