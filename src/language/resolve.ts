/******************************************************************************
 * tetaue import resolution — relative-first, then tetaue.toml dependencies.
 *
 * A "tetaue project" is any directory containing a tetaue.toml manifest,
 * which declares named dependencies, each a local path:
 *
 *     [dependencies]
 *     acme   = { path = "vendor/acme" }            # inside the project
 *     shared = { path = "../shared-libs/shared" }  # anywhere, declared here
 *
 * `import "spec"` resolves, for each importing file:
 *
 *   1. relative to the importing file (as always — local files win), then
 *   2. as `name/rest` against a dependency set: `name` is the first path
 *      segment, looked up in the NEAREST ancestor tetaue.toml of the
 *      importing file — so a lib may carry its own manifest, and its
 *      dependencies travel with the folder. `rest` is a path inside the
 *      dependency, resolved against the dependency's path (which itself is
 *      relative to the manifest that declares it).
 *
 * For every location, three candidate forms are tried: `spec`,
 * `spec.tetaue`, and `spec/index.tetaue` — so `import "acme/tables"` finds
 * `<acme>/tables.tetaue` and `import "acme"` finds `<acme>/index.tetaue`.
 *
 * There are no globals and no environment variables: everything a project
 * imports is declared in its own manifest (or an ancestor lib's), and every
 * path is relative to the manifest that declares it. The rule is a pure
 * function of the file path, so the CLI and every editor's LSP agree.
 ******************************************************************************/
import { existsSync, readFileSync, statSync } from 'node:fs';
import * as path from 'node:path';
import { URI } from 'langium';
import { parse as parseToml, TomlError } from 'smol-toml';

export const MANIFEST_NAME = 'tetaue.toml';

/** Result of resolving an import specifier. */
export interface ResolvedImport {
    /** Resolved file URI, or undefined when nothing matched. */
    uri: string | undefined;
    /** Directories searched, in order (for error messages). */
    searched: string[];
    /**
     * A specific resolution error (undeclared dependency, broken path, bad
     * manifest). When set, it replaces the generic "cannot resolve import"
     * message.
     */
    error?: string;
    /** A non-fatal resolution warning (shadowing, non-self-contained lib). */
    warning?: string;
}

/** A `[dependencies]` entry: `name = { path = "…" }`. */
export interface Dependency {
    /** Root of the dependency, relative to the manifest that declares it. */
    path: string;
}

/**
 * The optional `[build]` table — defaults for `tetaue build`:
 *
 *     [build]
 *     out     = "sql"          # output directory for rendered SQL
 *     dialect = "postgresql"   # default render dialect
 *     format  = "compact"      # pretty | compact
 *     pre     = "bun run gen"  # hook run before building
 *     post    = "echo done"    # hook run after building
 *
 * Command-line flags override these values.
 */
export interface BuildConfig {
    out?: string;
    dialect?: string;
    format?: string;
    pre?: string;
    post?: string;
}

export interface Manifest {
    dependencies: Map<string, Dependency>;
    /** Optional `[build]` table (undefined when absent). */
    build?: BuildConfig;
    /**
     * Declared names whose value is not `{ path = "…" }` (e.g. a string
     * shorthand). Kept for accurate error messages instead of silently
     * pretending the name is undeclared.
     */
    bad: Map<string, string>;
}

/** Parse a tetaue.toml manifest; malformed entries are recorded, not dropped. */
export function parseManifest(text: string): Manifest {
    const dependencies = new Map<string, Dependency>();
    const bad = new Map<string, string>();
    const doc = parseToml(text) as Record<string, unknown>;
    const table = doc.dependencies;
    if (table && typeof table === 'object' && !Array.isArray(table)) {
        for (const [name, value] of Object.entries(table as Record<string, unknown>)) {
            if (value && typeof value === 'object' && !Array.isArray(value)) {
                const p = (value as Record<string, unknown>).path;
                if (typeof p === 'string' && p.length > 0) {
                    dependencies.set(name, { path: p });
                    continue;
                }
            }
            bad.set(name, JSON.stringify(value));
        }
    }

    let build: BuildConfig | undefined;
    const buildTable = doc.build;
    if (buildTable && typeof buildTable === 'object' && !Array.isArray(buildTable)) {
        const b = buildTable as Record<string, unknown>;
        build = {};
        if (typeof b.out === 'string' && b.out.length > 0) build.out = b.out;
        if (typeof b.dialect === 'string' && b.dialect.length > 0) build.dialect = b.dialect;
        if (typeof b.format === 'string' && b.format.length > 0) build.format = b.format;
        if (typeof b.pre === 'string' && b.pre.length > 0) build.pre = b.pre;
        if (typeof b.post === 'string' && b.post.length > 0) build.post = b.post;
        if (Object.keys(build).length === 0) build = undefined;
    }

    return { dependencies, build, bad };
}

type ManifestLoad =
    | { kind: 'ok'; dir: string; manifest: Manifest }
    | { kind: 'parse-error'; dir: string; message: string }
    | { kind: 'none'; dir: string };

/** Per-project manifest cache; a changed mtime re-reads the file. */
export type ManifestCache = Map<string, { mtimeMs: number; load: ManifestLoad }>;

function isFile(p: string): boolean {
    try {
        return statSync(p).isFile();
    } catch {
        return false;
    }
}

/** The candidate file paths for `spec` inside a single directory. */
function candidates(dir: string, spec: string): string[] {
    const base = path.resolve(dir, spec);
    return [base, base + '.tetaue', path.join(base, 'index.tetaue')];
}

/** Nearest ancestor of `fromDir` containing a tetaue.toml, or undefined. */
export function findManifestDir(fromDir: string): string | undefined {
    let dir = fromDir;
    for (;;) {
        if (isFile(path.join(dir, MANIFEST_NAME))) return dir;
        const parent = path.dirname(dir);
        if (parent === dir) return undefined;
        dir = parent;
    }
}

function loadManifest(manifestDir: string, cache: ManifestCache): ManifestLoad {
    const file = path.join(manifestDir, MANIFEST_NAME);
    let stat;
    try {
        stat = statSync(file);
    } catch {
        return { kind: 'none', dir: manifestDir };
    }
    const cached = cache.get(file);
    if (cached && cached.mtimeMs === stat.mtimeMs) return cached.load;
    let load: ManifestLoad;
    try {
        load = { kind: 'ok', dir: manifestDir, manifest: parseManifest(readFileSync(file, 'utf8')) };
    } catch (err) {
        load = {
            kind: 'parse-error',
            dir: manifestDir,
            message: err instanceof TomlError ? err.message : err instanceof Error ? err.message : String(err),
        };
    }
    cache.set(file, { mtimeMs: stat.mtimeMs, load });
    return load;
}

/**
 * Resolve an import specifier against the importing file, then the file's
 * dependency set (nearest ancestor tetaue.toml). A specifier that looks like
 * a path (starts with `.`, or absolute) resolves relative to the importing
 * file ONLY. Everything else is tried relative to the importer first, then
 * as `name/rest` against the dependencies.
 */
export interface ImportResolverOptions {
    /** Per-project manifest cache (fresh by default; pass one for cross-call caching). */
    cache?: ManifestCache;
    /** Directory used when `importerUri` is undefined. Defaults to process.cwd(). */
    cwd?: string;
}

function resolveImportWith(importerUri: string | undefined, spec: string, cache: ManifestCache, cwd: string): ResolvedImport {
    const importerDir = importerUri ? path.dirname(URI.parse(importerUri).fsPath) : cwd;
    const searched: string[] = [importerDir];
    const isPath = spec.startsWith('.') || path.isAbsolute(spec);
    const slash = spec.indexOf('/');
    const name = slash < 0 ? spec : spec.slice(0, slash);

    // 1. relative to the importer — local files always win.
    for (const candidate of candidates(importerDir, spec)) {
        if (isFile(candidate)) {
            // A local file silently shadowing a declared dependency is a
            // footgun (adding a folder with a dep's name stops using the
            // lib) — surface it.
            if (!isPath) {
                const manifestDir = findManifestDir(importerDir);
                const load = manifestDir ? loadManifest(manifestDir, cache) : undefined;
                if (load?.kind === 'ok' && load.manifest.dependencies.has(name)) {
                    return {
                        uri: URI.file(candidate).toString(),
                        searched,
                        warning: `local '${spec}' shadows the declared dependency '${name}' in ${MANIFEST_NAME}`,
                    };
                }
            }
            return { uri: URI.file(candidate).toString(), searched };
        }
    }

    if (isPath) return { uri: undefined, searched };

    // 2. dependency lookup: name = first segment, rest = path inside it.
    const rest = slash < 0 ? '' : spec.slice(slash + 1);
    const manifestDir = findManifestDir(importerDir);
    if (!manifestDir) {
        return { uri: undefined, searched, error: `cannot resolve import '${spec}' — no ${MANIFEST_NAME} found (searched: ${searched.join(', ')})` };
    }
    const load = loadManifest(manifestDir, cache);
    if (load.kind === 'parse-error') {
        return { uri: undefined, searched, error: `error in ${MANIFEST_NAME}: ${load.message}` };
    }
    if (load.kind !== 'ok') return { uri: undefined, searched }; // unreachable: findManifestDir found the file
    const dep = load.manifest.dependencies.get(name);
    if (!dep) {
        const bad = load.manifest.bad.get(name);
        if (bad !== undefined) {
            return { uri: undefined, searched, error: `dependency '${name}' in ${MANIFEST_NAME} must be { path = "…" } (got: ${bad})` };
        }
        const declared = [...load.manifest.dependencies.keys()];
        return {
            uri: undefined,
            searched,
            error: `dependency '${name}' is not declared in ${MANIFEST_NAME}${declared.length > 0 ? ` — declared: ${declared.join(', ')}` : ''}`,
        };
    }

    const depRoot = path.resolve(load.dir, dep.path);
    searched.push(depRoot);
    if (!existsSync(depRoot)) {
        return { uri: undefined, searched, error: `cannot read dependency '${name}' — path '${dep.path}' does not exist (${depRoot})` };
    }

    // A `rest` that walks out of the dependency (../.., absolute, …) would
    // silently import files that are NOT part of the declared dependency —
    // reject it. (`..` stays legal in plain relative imports, which never
    // reach this branch.)
    if (rest.length > 0) {
        const base = path.resolve(depRoot, rest);
        const rel = path.relative(depRoot, base);
        if (rel.startsWith('..') || path.isAbsolute(rel)) {
            return { uri: undefined, searched, error: `path '${rest}' escapes dependency '${name}' — must stay within ${depRoot}` };
        }
    }

    const depCandidates = rest.length > 0
        ? candidates(depRoot, rest)
        : [depRoot, depRoot + '.tetaue', path.join(depRoot, 'index.tetaue')];
    for (const candidate of depCandidates) {
        if (isFile(candidate)) {
            return {
                uri: URI.file(candidate).toString(),
                searched,
                warning: fallthroughWarning(load, depRoot, importerDir, name, manifestDir),
            };
        }
    }
    return {
        uri: undefined,
        searched,
        error: `no file '${rest.length > 0 ? rest : '<index>'}' in dependency '${name}' (${depRoot})`,
    };
}

/**
 * Resolve an import specifier. A fresh manifest cache is used per call; use
 * `createImportResolver` when many resolutions should share a cache.
 */
export function resolveImport(importerUri: string | undefined, spec: string, options: ImportResolverOptions = {}): ResolvedImport {
    return resolveImportWith(importerUri, spec, options.cache ?? new Map(), options.cwd ?? process.cwd());
}

/** Build a reusable resolver (e.g. for the CLI/LSP), optionally sharing a cache. */
export function createImportResolver(options: ImportResolverOptions = {}): (importerUri: string | undefined, spec: string) => ResolvedImport {
    const cache = options.cache ?? new Map();
    const cwd = options.cwd ?? process.cwd();
    return (importerUri, spec) => resolveImportWith(importerUri, spec, cache, cwd);
}

/**
 * When the importing file lives INSIDE a dependency of `manifest` and that
 * dependency has no tetaue.toml of its own, its imports silently resolve
 * against the OUTER manifest — the lib is not self-contained, so it works
 * here and breaks when shared. Warn once per resolution (undefined when the
 * file is not inside such a dependency).
 */
function fallthroughWarning(
    manifest: ManifestLoad & { kind: 'ok' },
    depRoot: string,
    importerDir: string,
    resolvedName: string,
    manifestDir: string,
): string | undefined {
    for (const [depName, dep] of manifest.manifest.dependencies) {
        const root = path.resolve(manifest.dir, dep.path);
        if (root === depRoot) continue; // the dep being imported is fine
        const rel = path.relative(root, importerDir);
        const inside = rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
        if (inside && !isFile(path.join(root, MANIFEST_NAME))) {
            return `file '${importerDir}' is inside dependency '${depName}', which has no ${MANIFEST_NAME} — '${resolvedName}' resolves against the manifest in '${manifestDir}'; add a ${MANIFEST_NAME} to '${root}' to make the lib self-contained`;
        }
    }
    return undefined;
}
