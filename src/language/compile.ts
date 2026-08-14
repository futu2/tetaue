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
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { URI } from 'langium';
import type { TetaueServices } from './tetaue-module.js';
import { analyzeProject, type Diagnostic } from './interpreter.js';
import { inferProject, mergeDiagnostics } from './inference.js';
import { renderQuery, DIALECTS, isDialect } from './render.js';
import type { RenderFormat } from './render.js';
import { collectModuleTree, moduleOf } from './imports.js';
import type { ProjectModule } from './imports.js';
import { resolveImport } from './resolve.js';
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

function readModule(uri: string): string | undefined {
    try {
        return readFileSync(URI.parse(uri).fsPath, 'utf8');
    } catch {
        return undefined;
    }
}

/**
 * Resolve the import tree of a root module (root model provided by the
 * caller — the CLI's parsed file or the LSP's open document) and parse every
 * imported module from disk. Shared by the CLI, the language server's
 * `tetaue/render`, hover, and completion so they all see the same tree.
 */
export function projectTreeFor(root: ProjectModule, services: TetaueServices): { modules: ProjectModule[]; diagnostics: Diagnostic[]; warnings: Diagnostic[] } {
    // Relative imports first, then tetaue.toml dependencies — see resolve.ts.
    const tree = collectModuleTree(root, {
        resolve: (importerUri, spec) => resolveImport(importerUri, spec),
        read: readModule,
        parse: (text, uri) => parseModel(text, uri, services),
    });
    return { modules: tree.modules, diagnostics: tree.diagnostics, warnings: tree.warnings };
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
    const { dialect = 'sqlite', format = 'pretty', requireQuery = true } = options ?? {};

    let main: ProjectModule;
    try {
        main = { model: parseModel(rootText, rootUri, services), uri: rootUri, imports: [] };
    } catch (err) {
        return {
            ok: false,
            diagnostics: [{ uri: rootUri, line: 0, character: 0, message: err instanceof Error ? err.message : String(err) }],
        };
    }

    const { modules, diagnostics: treeDiagnostics, warnings: treeWarnings } = projectTreeFor(main, services);
    const { value, diagnostics } = analyzeProject(modules, { requireQuery });
    const { diagnostics: typeDiagnostics } = inferProject(modules);
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
    const spec = isDialect(dialect) ? DIALECTS[dialect]! : DIALECTS.sqlite!;
    try {
        return { ok: true, sql: renderQuery(value.query, spec, format), warnings: warningList };
    } catch (err) {
        // Render-time capability errors (e.g. a date function the dialect
        // cannot lower) surface as diagnostics like any other failure.
        return {
            ok: false,
            diagnostics: [{ uri: rootUri, line: 0, character: 0, message: err instanceof Error ? err.message : String(err) }],
        };
    }
}
