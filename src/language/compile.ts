/******************************************************************************
 * tetaue compile pipeline — the single path from a module's source text to
 * rendered SQL, shared by the CLI and the language server so they can never
 * disagree.
 *
 *   compileModuleText(uri, text, services, { dialect, format })
 *
 * The root text is parsed in memory (the LSP passes the live document, the
 * CLI reads the file); `import`ed modules are read from disk relative to the
 * root. Imports intentionally resolve with the same filesystem semantics as
 * the CLI (relative specs, `..`/absolute paths allowed) — this is a local
 * language tool, not a sandbox. Interpreter + inference diagnostics are
 * merged with exact dedupe, exactly like the CLI's `render`/`check`.
 ******************************************************************************/
import { readFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import * as path from 'node:path';
import { URI } from 'langium';
import type { TetaueServices } from './tetaue-module.js';
import { analyzeProject, type Diagnostic } from './interpreter.js';
import { inferProject, mergeDiagnostics } from './inference.js';
import { renderQuery, renderQueryWithCtes, DIALECTS, isDialect } from './render.js';
import type { RenderFormat } from './render.js';
import { collectModuleTree, moduleOf } from './imports.js';
import type { ResolvedImportEdge } from './imports.js';
import type { ProjectModule } from './imports.js';
import { createImportResolver } from './resolve.js';
import type { Model } from './generated/ast.js';

export interface CompileDiagnostic {
    /** URI of the module the diagnostic belongs to. */
    uri: string;
    message: string;
    /** 0-based LSP position (the CST start of the offending node). */
    line: number;
    character: number;
}

export type CompileOutcome =
    | { ok: true; sql: string; warnings?: CompileDiagnostic[] }
    | { ok: false; diagnostics: CompileDiagnostic[] };

export interface CompileOptions {
    dialect?: string;
    format?: RenderFormat;
    /** Emit named intermediate queries as WITH ... AS CTEs. */
    cte?: boolean;
    /**
     * Require the root module's last binding to be a query (default true).
     * `build` disables it so library modules (no query) compile cleanly and
     * are reported as "no query" rather than as errors.
     */
    requireQuery?: boolean;
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

// ---------------------------------------------------------------------------
// Small project-tree caches.
//
// Hover/completion/validation all call projectTreeFor on every keystroke.
// The root document is the caller's live parse, but imported modules are
// plain files: cache their text by mtime and their AST by text hash so a
// large dependency tree is not re-read and re-parsed on each request.
// ---------------------------------------------------------------------------

const moduleTextCache = new Map<string, { mtimeMs: number; text: string }>();
const moduleAstCache = new Map<string, { hash: string; model: Model }>();
const CACHE_LIMIT = 256;

function hashText(text: string): string {
    return createHash('sha1').update(text).digest('hex');
}

function trimCache<K, V>(cache: Map<K, V>): void {
    if (cache.size <= CACHE_LIMIT) return;
    for (const key of cache.keys()) {
        cache.delete(key);
        if (cache.size <= CACHE_LIMIT / 2) return;
    }
}

function readModule(uri: string): string | undefined {
    try {
        const fsPath = URI.parse(uri).fsPath;
        const mtimeMs = statSync(fsPath).mtimeMs;
        const cached = moduleTextCache.get(fsPath);
        if (cached && cached.mtimeMs === mtimeMs) return cached.text;
        const text = readFileSync(fsPath, 'utf8');
        trimCache(moduleTextCache);
        moduleTextCache.set(fsPath, { mtimeMs, text });
        return text;
    } catch {
        return undefined;
    }
}

function parseModuleCached(text: string, uri: string, services: TetaueServices): Model {
    const hash = hashText(text);
    const key = `${uri}\u0000${hash}`;
    const cached = moduleAstCache.get(key);
    if (cached && cached.hash === hash) return cached.model;
    const model = parseModel(text, uri, services);
    trimCache(moduleAstCache);
    moduleAstCache.set(key, { hash, model });
    return model;
}

/**
 * Resolve the import tree of a root module (root model provided by the
 * caller — the CLI's parsed file or the LSP's open document) and parse every
 * imported module from disk. Shared by the CLI, the language server's
 * `tetaue/render`, hover, and completion so they all see the same tree.
 */
export function projectTreeFor(root: ProjectModule, services: TetaueServices): { modules: readonly ProjectModule[]; importsByModule: ReadonlyMap<ProjectModule, readonly ResolvedImportEdge[]>; diagnostics: readonly Diagnostic[]; warnings: readonly Diagnostic[] } {
    // Relative imports first, then tetaue.toml dependencies — see resolve.ts.
    const tree = collectModuleTree(root, {
        resolve: createImportResolver(),
        read: readModule,
        parse: (text, uri) => parseModuleCached(text, uri, services),
    });
    return { modules: tree.modules, importsByModule: tree.importsByModule, diagnostics: tree.diagnostics, warnings: tree.warnings };
}

function diagnostic(d: { node?: { $cstNode?: { range: { start: { line: number; character: number } } } | null } | null; message: string }, uri: string): CompileDiagnostic {
    const pos = d.node?.$cstNode?.range.start;
    return {
        uri,
        message: d.message,
        line: pos?.line ?? 0,
        character: pos?.character ?? 0,
    };
}

/**
 * Compile a module's source text to SQL.
 *
 * On success returns `{ ok: true, sql }`. On failure returns `{ ok: false,
 * diagnostics }` — parse errors, import-resolution errors, interpreter and
 * type diagnostics all land in the same list. `diagnostics` is empty only
 * when the module parsed and checked cleanly but did not evaluate to a query.
 */
export function compileModuleText(
    rootUri: string,
    rootText: string,
    services: TetaueServices,
    options?: CompileOptions,
): CompileOutcome {
    const { dialect = 'sqlite', format = 'pretty', requireQuery = true, cte = false } = options ?? {};
    if (!isDialect(dialect)) {
        return {
            ok: false,
            diagnostics: [{
                uri: rootUri,
                line: 0,
                character: 0,
                message: `unknown dialect '${dialect}' — available: ${Object.keys(DIALECTS).join(', ')}`,
            }],
        };
    }

    let main: ProjectModule;
    try {
        main = { model: parseModel(rootText, rootUri, services), uri: rootUri, imports: [] };
    } catch (err) {
        return {
            ok: false,
            diagnostics: [{ uri: rootUri, line: 0, character: 0, message: err instanceof Error ? err.message : String(err) }],
        };
    }

    const { modules, importsByModule, diagnostics: treeDiagnostics, warnings: treeWarnings } = projectTreeFor(main, services);
    const { value, diagnostics } = analyzeProject(modules, { requireQuery, importsByModule });
    const { diagnostics: typeDiagnostics } = inferProject(modules, importsByModule);
    // Interpreter + inference merged with exact (node, message) dedupe.
    const merged = mergeDiagnostics(modules, diagnostics, typeDiagnostics);

    const all: CompileDiagnostic[] = [];
    for (const d of [...treeDiagnostics, ...merged]) {
        const m = moduleOf(d.node, modules) ?? main;
        all.push(diagnostic(d, m.uri ?? rootUri));
    }
    const warningList: CompileDiagnostic[] = treeWarnings.map(d => diagnostic(d, (moduleOf(d.node, modules) ?? main).uri ?? rootUri));

    if (all.length > 0 || value.kind === 'error') {
        return { ok: false, diagnostics: all };
    }
    if (value.kind !== 'query') {
        return { ok: false, diagnostics: [] };
    }
    const spec = DIALECTS[dialect]!;
    const rendered = cte ? renderQueryWithCtes(value.query, spec, format) : renderQuery(value.query, spec, format);
    if (!rendered.ok) {
        return {
            ok: false,
            diagnostics: rendered.diagnostics.map(d => ({
                uri: rootUri,
                line: 0,
                character: 0,
                message: d.message,
            })),
        };
    }
    return { ok: true, sql: rendered.sql, warnings: warningList };
}
