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
}

/**
 * Resolve an import specifier relative to the importing file. `spec` may be
 * any path (`./x`, `../x`, `x/y`, absolute); `..` and absolute paths are
 * allowed — this is a local language tool, not a sandbox.
 */
function resolveImportWith(importerUri: string | undefined, spec: string, cwd: string): ResolvedImport {
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
    return resolveImportWith(importerUri, spec, options.cwd ?? process.cwd());
}

/** Build a reusable resolver (e.g. for the CLI/LSP). Resolution is stateless. */
export function createImportResolver(options: ImportResolverOptions = {}): (importerUri: string | undefined, spec: string) => ResolvedImport {
    const cwd = options.cwd ?? process.cwd();
    return (importerUri, spec) => resolveImportWith(importerUri, spec, cwd);
}