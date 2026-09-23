/******************************************************************************
 * tetaue import resolution — relative-path only.
 *
 * There is no package layer and no manifest: `import "spec"` resolves
 * relative to the importing file, just like a filesystem `require`. For
 * every location, three candidate forms are tried: `spec`, `spec.tetaue`,
 * and `spec/index.tetaue` — so
 *
 *     import "tables"          → ./tables.tetaue
 *     import "acme/tables"     → ./acme/tables.tetaue   (a folder of modules)
 *     import "acme"            → ./acme/index.tetaue    (a package folder)
 *
 * Everything a module imports is a file reachable from the importing file.
 * There are no globals, no environment variables, no install command:
 * distribution is an ordinary file operation (`cp -r`, symlink, `git clone`).
 * Resolution is a pure function of the file path, so the CLI and every
 * editor's LSP agree.
 ******************************************************************************/
import { statSync } from 'node:fs';
import * as path from 'node:path';
import { URI } from 'langium';
import { baseModuleSource, BASE_PREFIX } from './prelude.js';

/** Result of resolving an import specifier. */
export interface ResolvedImport {
    /** Resolved file URI, or undefined when nothing matched. */
    uri: string | undefined;
    /** Directories searched, in order (for error messages). */
    searched: string[];
}

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

export interface ImportResolverOptions {
    /** Directory used when `importerUri` is undefined. Defaults to process.cwd(). */
    cwd?: string;
    /**
     * Resolve `base/...` specifiers against the EMBEDDED base library (see
     * prelude.ts) instead of the filesystem. The CLI and the language server
     * enable it; a bare resolver used for plain relative imports does not.
     */
    base?: boolean;
}

/**
 * Resolve a `base/...` specifier against the embedded base library. The
 * library ships inside the binary (`base-sources.ts`), so a
 * resolved base import always reads successfully — there is no search
 * path and no installation step.
 */
function resolveBaseImport(spec: string): ResolvedImport {
    if (baseModuleSource(spec) === undefined) {
        return { uri: undefined, searched: [`<base library> (no module '${spec}')`] };
    }
    // A stable synthetic URI: `base/data/maybe.tetaue`. It is NOT a file
    // path, which is why the module loader's read() special-cases the prefix.
    const bare = spec.replace(/^\.\//, '').replace(/^base\//, '').replace(/\.tetaue$/, '');
    return { uri: `${BASE_PREFIX}${bare}.tetaue`, searched: ['<base library>'] };
}

/**
 * Resolve an import specifier relative to the importing file. `spec` may be
 * any path (`./x`, `../x`, `x/y`, absolute); `..` and absolute paths are
 * allowed — this is a local language tool, not a sandbox. With `base`
 * enabled, a `base/...` specifier resolves into the embedded base library.
 */
function resolveImportWith(importerUri: string | undefined, spec: string, cwd: string, useBase: boolean): ResolvedImport {
    if (useBase && spec.startsWith(BASE_PREFIX)) return resolveBaseImport(spec);
    const importerDir = importerUri ? path.dirname(URI.parse(importerUri).fsPath) : cwd;
    const searched: string[] = [importerDir];
    for (const candidate of candidates(importerDir, spec)) {
        if (isFile(candidate)) {
            return { uri: URI.file(candidate).toString(), searched };
        }
    }
    return { uri: undefined, searched };
}

/** Resolve an import specifier relative to the importing file. */
export function resolveImport(importerUri: string | undefined, spec: string, options: ImportResolverOptions = {}): ResolvedImport {
    return resolveImportWith(importerUri, spec, options.cwd ?? process.cwd(), options.base ?? false);
}

/** Build a reusable resolver (e.g. for the CLI/LSP). Resolution is stateless. */
export function createImportResolver(options: ImportResolverOptions = {}): (importerUri: string | undefined, spec: string) => ResolvedImport {
    const cwd = options.cwd ?? process.cwd();
    const useBase = options.base ?? false;
    return (importerUri, spec) => resolveImportWith(importerUri, spec, cwd, useBase);
}
