/******************************************************************************
 * The base library — tetaue's `base`.
 *
 * The library is ordinary tetaue in `base/`: one file per module, exactly
 * like Haskell's `base`. This file is only the *loader*: it parses those
 * modules with the caller's language services, resolves their relative
 * imports (`base/prelude.tetaue` re-exports `./data/function.tetaue`, ...),
 * and hands the resulting module tree to the checker.
 *
 *   Prelude          the auto-imported surface (a thin aggregator)
 *   Sql              the public SQL surface + the scalar layer
 *   data/function    pure combinators (id, const, flip, compose, ...)
 *   data/maybe       helpers over SQL NULL
 *
 * The sources are embedded as strings (`base-sources.ts`) so the
 * CLI, the LSP server, and the standalone executables all carry the library
 * without an asset directory; the files under `base/` remain the source of
 * truth and are what gets edited.
 *
 * Two rules make the PICTURE complete:
 *
 *   - a BASE module is the only kind of module that sees the primitive core
 *     unqualified (BUILTINS + the operator intrinsics + `sql_dialect`);
 *   - every OTHER module sees exactly what it imports — `base/prelude` is
 *     auto-imported, so the familiar names stay unqualified by default,
 *     while `sql_func` and friends remain private to the library.
 ******************************************************************************/
import type { TetaueServices } from './tetaue-module.js';
import type { Model } from './generated/ast.js';
import type { ProjectModule, ResolvedExportEdge, ResolvedImportEdge } from './imports.js';
import { parseStringLiteral } from './strings.js';
import { BASE_MODULE_SOURCES } from './base-sources.js';

/** Prefix that marks a base-library module path (`base/prelude.tetaue`). */
export const BASE_PREFIX = 'base/';

/** True when a module URI refers to the base library. */
export function isBaseUri(uri: string | undefined): boolean {
    if (!uri) return false;
    return uri.startsWith(BASE_PREFIX) || uri.startsWith(`tetaue:${BASE_PREFIX}`);
}

/** The Prelude's canonical URI; the module every other module auto-imports. */
export const PRELUDE_URI = `${BASE_PREFIX}prelude.tetaue`;

/** Source text of a base module path, or undefined when there is no such module. */
export function baseModuleSource(spec: string): string | undefined {
    const trimmed = spec.replace(/^\.\//, '');
    return BASE_MODULE_SOURCES[trimmed] ?? BASE_MODULE_SOURCES[`${BASE_PREFIX}${trimmed}`];
}

/** Every base module path, in generated (depth-first, sorted) order. */
export function baseModulePaths(): readonly string[] {
    // The generated table repeats each module under its accepted spellings;
    // the canonical set is the ones without the `base/` prefix and `.tetaue`.
    return Object.keys(BASE_MODULE_SOURCES).filter(
        path => !path.startsWith(BASE_PREFIX) && path.endsWith('.tetaue'),
    );
}

interface BaseCache {
    readonly modules: readonly ProjectModule[];
    readonly byUri: ReadonlyMap<string, ProjectModule>;
    /** Resolved intra-library import edges, keyed by module identity. */
    readonly importsByModule: ReadonlyMap<ProjectModule, readonly ResolvedImportEdge[]>;
    /** Resolved intra-library re-export edges, keyed by module identity. */
    readonly exportsByModule: ReadonlyMap<ProjectModule, readonly ResolvedExportEdge[]>;
}

// A service container owns the parser configuration used to construct AST
// nodes. Cache only within that container so callers can safely create
// independent language instances in tests, embedded tools, or workers.
const baseCache = new WeakMap<object, BaseCache>();

/** Resolve a base-module import specifier (`"./data/maybe.tetaue"`) to its URI. */
function resolveBaseUri(spec: string): string {
    // The grammar stores STRING terminals with their quotes (the value
    // converter keeps them raw so the interpreter controls unescaping).
    const bare = parseStringLiteral(spec).replace(/^\.\//, '');
    return `${BASE_PREFIX}${bare}`;
}

/**
 * Parse every base module with the caller's services and resolve the imports
 * and re-exports BETWEEN them (no filesystem: the sources are embedded). The
 * result is a module tree in dependency order — a module always follows
 * everything it imports — with the same edge maps a user project produces,
 * so the checker treats the library exactly like any other project.
 */
function baseLibrary(services: TetaueServices): BaseCache {
    const cached = baseCache.get(services);
    if (cached) return cached;

    const byUri = new Map<string, ProjectModule>();
    for (const path of baseModulePaths()) {
        const uri = `${BASE_PREFIX}${path}`;
        const text = BASE_MODULE_SOURCES[path]!;
        const result = services.parser.LangiumParser.parse(text);
        const parseErrors = [
            ...result.lexerErrors.map(e => e.message),
            ...result.parserErrors.map(e => e.message),
        ];
        if (!result.value || parseErrors.length > 0) {
            throw new Error(`invalid base module '${uri}': ${parseErrors.join('; ') || 'no parse result'}`);
        }
        byUri.set(uri, { model: result.value as Model, uri, imports: [] });
    }

    // Resolve the library's own edges: `import "./data/function.tetaue" as fn`
    // and `export { a } from "./sql.tetaue"`.
    const importsByModule = new Map<ProjectModule, ResolvedImportEdge[]>();
    const exportsByModule = new Map<ProjectModule, ResolvedExportEdge[]>();
    for (const module of byUri.values()) {
        const edges: ResolvedImportEdge[] = [];
        for (const imp of module.model.imports) {
            const target = byUri.get(resolveBaseUri(imp.path));
            if (target) edges.push({ alias: imp.alias, target, importNode: imp });
        }
        if (edges.length > 0) importsByModule.set(module, edges);

        const reexports: ResolvedExportEdge[] = [];
        for (const exp of module.model.exports) {
            const target = byUri.get(resolveBaseUri(exp.path));
            if (target) reexports.push({ target, exportNode: exp });
        }
        if (reexports.length > 0) exportsByModule.set(module, reexports);
    }

    // Depth-first over the embedded imports, emitting dependencies first so
    // the checker sees a target's exports before the module that uses them.
    const ordered: ProjectModule[] = [];
    const done = new Set<string>();
    const visit = (uri: string, path: readonly string[]): void => {
        if (done.has(uri) || path.includes(uri)) return;
        const module = byUri.get(uri);
        if (!module) return;
        for (const edge of importsByModule.get(module) ?? []) {
            visit(edge.target.uri!, [...path, uri]);
        }
        for (const edge of exportsByModule.get(module) ?? []) {
            visit(edge.target.uri!, [...path, uri]);
        }
        done.add(uri);
        ordered.push(module);
    };
    for (const path of baseModulePaths()) visit(`${BASE_PREFIX}${path}`, []);

    // Publish the edges on the modules themselves as well. `checkProject`
    // reads the explicit maps, but the one-sided entry points
    // (`analyzeProject`, `inferProject`) and any caller that only holds a
    // module object read `module.imports`/`module.exports` — so filling
    // both means a base module is never partially wired, whichever API
    // is used.
    for (const [module, edges] of importsByModule) {
        (module as { imports?: readonly ResolvedImportEdge[] }).imports = edges;
    }
    for (const [module, edges] of exportsByModule) {
        (module as { exports?: readonly ResolvedExportEdge[] }).exports = edges;
    }

    const cache: BaseCache = { modules: ordered, byUri, importsByModule, exportsByModule };
    baseCache.set(services, cache);
    return cache;
}

/**
 * Every base module in dependency order. The checker evaluates these with the
 * primitive environment seeded and records their exports, so the Prelude can
 * re-export the library the way an ordinary module re-exports another.
 */
export function baseLibraryModules(services: TetaueServices): readonly ProjectModule[] {
    return baseLibrary(services).modules;
}

/** Resolved intra-library import edges (for `checkProject`'s module tree). */
export function baseLibraryImports(services: TetaueServices): ReadonlyMap<ProjectModule, readonly ResolvedImportEdge[]> {
    return baseLibrary(services).importsByModule;
}

/** Resolved intra-library re-export edges (for `checkProject`'s module tree). */
export function baseLibraryExports(services: TetaueServices): ReadonlyMap<ProjectModule, readonly ResolvedExportEdge[]> {
    return baseLibrary(services).exportsByModule;
}

/**
 * The base-library modules a `prelude` depends on, in dependency order, the
 * prelude LAST. Used by the one-sided entry points (`analyzeProject`,
 * `inferProject`), which receive the Prelude module alone and must still
 * evaluate the library modules it re-exports from.
 *
 * The walk follows `imports`/`exports` edges, which `baseLibrary` publishes
 * on the modules themselves, so any caller holding a prelude module gets the
 * full closure without a second API to thread.
 */
export function baseClosureFor(prelude: ProjectModule): readonly ProjectModule[] {
    const order: ProjectModule[] = [];
    const seen = new Set<ProjectModule>();
    const visit = (module: ProjectModule): void => {
        if (seen.has(module)) return;
        seen.add(module);
        for (const edge of module.imports ?? []) visit(edge.target);
        for (const edge of module.exports ?? []) visit(edge.target);
        order.push(module);
    };
    visit(prelude);
    // The prelude must come last: it re-exports the modules walked above.
    const rest = order.filter(m => m !== prelude);
    return [...rest, prelude];
}

/**
 * The base library as `checkProject` options: the modules in dependency
 * order, their internal import/re-export edges, and the Prelude every other
 * module auto-imports. One call so no caller can wire half of it and get a
 * library without its own imports resolved.
 */
export function baseLibraryOptions(services: TetaueServices): {
    baseModules: readonly ProjectModule[];
    baseImportsByModule: ReadonlyMap<ProjectModule, readonly ResolvedImportEdge[]>;
    baseExportsByModule: ReadonlyMap<ProjectModule, readonly ResolvedExportEdge[]>;
    prelude: ProjectModule;
} {
    return {
        baseModules: baseLibraryModules(services),
        baseImportsByModule: baseLibraryImports(services),
        baseExportsByModule: baseLibraryExports(services),
        prelude: standardPrelude(services),
    };
}

/**
 * The Prelude module — what every module auto-imports. Exposed as a single
 * module for callers that only need "the standard surface" (the CLI's
 * diagnostics anchoring, completion, the interpreter's flat injection).
 */
export function standardPrelude(services: TetaueServices): ProjectModule {
    const prelude = baseLibrary(services).byUri.get(PRELUDE_URI);
    if (!prelude) throw new Error(`the base library has no '${PRELUDE_URI}' module`);
    return prelude;
}

/**
 * Public names supplied by the source Prelude rather than the primitive core.
 * Re-exports are included (the Prelude is an aggregator, so most of its
 * surface arrives that way), which is why this walks the re-export list.
 */
export function standardPreludeNames(services: TetaueServices): readonly string[] {
    const { byUri } = baseLibrary(services);
    const names = new Set<string>();
    const collect = (module: ProjectModule, seen: ReadonlySet<string>): void => {
        for (const binding of module.model.bindings) {
            if (binding.export) names.add(binding.name);
        }
        const uri = module.uri ?? '';
        if (seen.has(uri)) return;
        const nextSeen = new Set(seen).add(uri);
        for (const exp of module.model.exports) {
            const target = byUri.get(resolveBaseUri(exp.path));
            if (!target) continue;
            if (exp.names.length === 0) {
                collect(target, nextSeen);
            } else {
                for (const item of exp.names) names.add(item.renamed ?? item.name);
            }
        }
    };
    collect(standardPrelude(services), new Set());
    return [...names];
}
