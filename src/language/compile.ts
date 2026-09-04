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
 * language tool, not a sandbox. The single checker pass (`checkProject`)
 * builds the typed SQL IR and emits exact-deduped diagnostics, exactly like
 * the CLI's `render`/`check`.
 ******************************************************************************/
import { type AstNode } from 'langium';
import type { TetaueServices } from './tetaue-module.js';
import type { Diagnostic } from './interpreter.js';
import { checkProject } from './checker.js';
import { renderQuery, DIALECTS, isDialect } from './render.js';
import type { RenderDiagnostic, RenderFormat } from './render.js';
import { collectModuleTree, moduleOf } from './imports.js';
import type { ResolvedImportEdge, ResolvedExportEdge } from './imports.js';
import type { ProjectModule } from './imports.js';
import { createImportResolver } from './resolve.js';
import { createModuleLoader, parseModel } from './module-cache.js';
import type { Model } from './generated/ast.js';
import { standardPrelude } from './prelude.js';
import { stringEscapeWarningsFor } from './strings.js';

export interface CompileDiagnostic {
    /** URI of the module the diagnostic belongs to. */
    uri: string;
    message: string;
    /** 0-based LSP position (the CST start of the offending node). */
    line: number;
    character: number;
    /** `'error'` (default) or `'warning'` (e.g. unknown string escapes). */
    severity?: 'error' | 'warning';
}

export type CompileOutcome =
    | {
        ok: true;
        sql: string;
        /** Named query parameters in the order they were encountered. */
        parameters: string[];
        /** Non-fatal warnings (e.g. unknown string escapes); empty most of the time. */
        diagnostics: CompileDiagnostic[];
    }
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
    /**
     * Strict `main` entry: a module without a `main` binding is a library and
     * produces no SQL. Defaults to `requireQuery` (so `render`/`check` are
     * strict); `--binding` selects a named binding instead.
     */
    requireMain?: boolean;
    /** Render this named root-module binding instead of the last one. */
    binding?: string;
}

/** Parse text into a Model, throwing with a message on lexer/parser errors. */
export { parseModel } from './module-cache.js';

// ---------------------------------------------------------------------------
// Imported-module loading.
//
// Hover/completion/validation all build the import tree on every keystroke.
// The root document is the caller's live parse, but imported modules are
// plain files: `moduleLoader` caches their text by mtime and their AST by
// content hash (bounded by bytes, budgeted per module), so a large
// dependency tree is not re-read and re-parsed on each request. The loader
// intentionally does NOT drop CSTs here (positions matter for CLI
// diagnostics); the LSP validator uses its own loader that does.
// ---------------------------------------------------------------------------

const moduleLoader = createModuleLoader();

/** Resolved module tree of a root, plus its re-export edges. */
export interface ProjectTree {
    modules: readonly ProjectModule[];
    importsByModule: ReadonlyMap<ProjectModule, readonly ResolvedImportEdge[]>;
    exportsByModule: ReadonlyMap<ProjectModule, readonly ResolvedExportEdge[]>;
    diagnostics: readonly Diagnostic[];
}

/**
 * Resolve the import/export tree of a root module (root model provided by
 * the caller — the CLI's parsed file or the LSP's open document) and parse
 * every imported module from disk. Shared by the CLI, the language server's
 * `tetaue/render`, hover, and completion so they all see the same tree.
 */
export function projectTreeFor(root: ProjectModule, services: TetaueServices): ProjectTree {
    // Imports and re-exports resolve relative to the importing file — see
    // resolve.ts. The same loader serves both, so a diamond graph parses
    // each module once.
    const tree = collectModuleTree(root, {
        resolve: createImportResolver(),
        read: moduleLoader.read,
        parse: (text, uri) => moduleLoader.parse(text, uri, services),
    });
    return {
        modules: tree.modules,
        importsByModule: tree.importsByModule,
        exportsByModule: tree.exportsByModule,
        diagnostics: tree.diagnostics,
    };
}

function diagnostic(d: { node?: { $cstNode?: { range: { start: { line: number; character: number } } } | null } | null; message: string }, uri: string, severity?: 'error' | 'warning'): CompileDiagnostic {
    const pos = d.node?.$cstNode?.range.start;
    return {
        uri,
        message: d.message,
        line: pos?.line ?? 0,
        character: pos?.character ?? 0,
        ...(severity ? { severity } : {}),
    };
}

/**
 * Render-time diagnostics carry the SQL IR node that failed; every SqlNode
 * and QueryStep remembers the source AST node that produced it, so capability
 * errors can be anchored to the offending expression instead of the file
 * start.
 */
function renderDiagnostic(d: RenderDiagnostic, rootUri: string, modules: readonly ProjectModule[], main: ProjectModule): CompileDiagnostic {
    const ast = (d.node as { ast?: AstNode } | undefined)?.ast;
    const owner = ast ? (moduleOf(ast, modules) ?? main) : main;
    const pos = ast?.$cstNode?.range.start;
    return {
        uri: owner.uri ?? rootUri,
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
    const { dialect = 'sqlite', format = 'pretty', requireQuery = true, requireMain, binding } = options ?? {};
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

    const { modules, importsByModule, exportsByModule, diagnostics: treeDiagnostics } = projectTreeFor(main, services);
    // The prelude module anchors its own diagnostics (e.g. an error raised
    // while applying the `_&_` pipeline lambda must point at prelude.tetaue,
    // not at the importing file).
    const prelude = standardPrelude(services);
    const anchorModules = [...modules, prelude];
    const { value, diagnostics: merged } = checkProject(modules, {
        requireQuery,
        // Strict main by default for render/check; `build` opts in via
        // requireMain while keeping requireQuery off (library detection).
        requireMain: requireMain ?? requireQuery,
        importsByModule,
        reexportsByModule: exportsByModule,
        entryBinding: binding,
        prelude,
        dialect: DIALECTS[dialect],
    });

    const all: CompileDiagnostic[] = [];
    for (const d of [...treeDiagnostics, ...merged]) {
        const m = moduleOf(d.node, anchorModules) ?? main;
        all.push(diagnostic(d, m.uri ?? rootUri));
    }
    // Unknown string escapes stay verbatim in the value but warn — the CLI
    // prints them, the LSP squiggles them.
    for (const warning of stringEscapeWarningsFor(main.model)) {
        all.push(diagnostic(warning, main.uri ?? rootUri, 'warning'));
    }

    if (all.some(d => (d.severity ?? 'error') === 'error') || value.kind === 'error') {
        return { ok: false, diagnostics: all };
    }
    if (value.kind !== 'query') {
        return { ok: false, diagnostics: [] };
    }
    const spec = DIALECTS[dialect]!;
    const rendered = renderQuery(value.query, spec, format);
    if (!rendered.ok) {
        return {
            ok: false,
            diagnostics: rendered.diagnostics.map(d => renderDiagnostic(d, rootUri, modules, main)),
        };
    }
    return {
        ok: true,
        sql: rendered.sql,
        parameters: rendered.parameters,
        diagnostics: all.filter(d => d.severity === 'warning'),
    };
}
