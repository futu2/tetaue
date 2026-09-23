/******************************************************************************
 * Embed the base library into TypeScript.
 *
 * The base library is ordinary tetaue living in `base/` — the single source
 * of truth. This script reads every `base/**\/*.tetaue` file and writes
 * `src/language/base-sources.ts`, a module of string constants.
 *
 * WHY EMBED AT ALL — `bun build --compile` produces a single-file executable
 * with no asset directory beside it, so the CLI, the LSP server, and the
 * standalone binaries must all carry the library inside the bundle. The
 * generated module is what makes "the library is a real file on disk" and
 * "the library ships inside the binary" both true at once. Regenerate with
 * `bun run base:generate` (part of `bun run build`).
 *
 * The generated header is rewritten, so the output is stable and diffable:
 * a change to a `base/*.tetaue` file shows up as exactly the corresponding
 * string change.
 ******************************************************************************/
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(new URL('.', import.meta.url).pathname, '..');
const BASE_DIR = join(ROOT, 'base');
const OUT_FILE = join(ROOT, 'src/language/base-sources.ts');

/**
 * Names are a HARD contract: a base module's path is lowercase (directories
 * and file names alike), because the module path is part of the public import
 * specifier (`import "base/data/maybe"`) and two spellings of one module would
 * be two modules. Failing here beats shipping a second `Data/Maybe` alias into
 * the embed.
 */
function assertLowercaseModulePath(path: string): void {
    if (path !== path.toLowerCase()) {
        throw new Error(`base module path must be lowercase: '${path}' (rename the file/directory)`);
    }
}

/** Every `.tetaue` file under `base/`, as module paths relative to `base/`. */
function baseModulePaths(dir: string, prefix: string): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(dir).sort()) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) {
            assertLowercaseModulePath(`${prefix}${entry}/`);
            out.push(...baseModulePaths(full, `${prefix}${entry}/`));
        } else if (entry.endsWith('.tetaue')) {
            assertLowercaseModulePath(`${prefix}${entry}`);
            // A module's canonical path drops the extension: base/data/list.tetaue
            // is importable as `base/data/list` and as `base/data/list.tetaue`.
            out.push(`${prefix}${entry}`);
        }
    }
    return out;
}

/** The exported constant name for a module path (`data/list.tetaue` -> `DATA_LIST`). */
function constantName(modulePath: string): string {
    return modulePath.replace(/\.tetaue$/, '').replace(/[^A-Za-z0-9]+/g, '_').toUpperCase();
}

function literal(text: string): string {
    return text.split('`').join('\\`').split('${').join('\\${');
}

const modules = baseModulePaths(BASE_DIR, '');
const entries = modules.map(modulePath => {
    const source = readFileSync(join(BASE_DIR, modulePath), 'utf8');
    return { modulePath, name: constantName(modulePath), source };
});

const lines: string[] = [
    '/******************************************************************************',
    ' * GENERATED — do not edit. Run `bun run base:generate` instead.',
    ' *',
    ' * The base library sources, embedded so the CLI, the LSP server, and the',
    ' * standalone executables all carry the library without an asset directory.',
    ' * The files under `base/` are the source of truth.',
    ' ******************************************************************************/',
    '',
];

for (const { modulePath, name, source } of entries) {
    lines.push(`/** \`base/${modulePath}\` */`);
    lines.push(`export const ${name} = \`${literal(source)}\`;`);
    lines.push('');
}

lines.push('/** Every base module: canonical import path -> its source text. */');
lines.push('export const BASE_MODULE_SOURCES: Readonly<Record<string, string>> = {');
for (const { modulePath, name } of entries) {
    lines.push(`    ${JSON.stringify(modulePath)}: ${name},`);
    // Both `base/data/list` and `base/data/list.tetaue` are accepted spellings.
    lines.push(`    ${JSON.stringify(`base/${modulePath}`)}: ${name},`);
    lines.push(`    ${JSON.stringify(`base/${modulePath.replace(/\.tetaue$/, '')}`)}: ${name},`);
}
lines.push('};');
lines.push('');

mkdirSync(join(ROOT, 'src/language'), { recursive: true });
writeFileSync(OUT_FILE, lines.join('\n'));
console.log(`base: embedded ${entries.length} module(s) into ${OUT_FILE}`);
