/******************************************************************************
 * tetaue CLI — render / check / parse / format / build / watch / lsp.
 *
 *   tetaue render <file> [--dialect sqlite|postgresql|mysql|trino|hive] [--format pretty|compact]
 *   tetaue check <file>
 *   tetaue parse <file>
 *   tetaue format <file...> [--check] [--tabs] [--tab-width <n>]     (alias: fmt)
 *   tetaue format --stdin [--check]
 *   tetaue build [dir] [--dialect <name>] [--format pretty|compact] [--out <dir>]
 *                [--pre-hook <cmd>] [--post-hook <cmd>] [--no-hooks]
 *   tetaue watch <file|dir> [--dialect <name>] [--format pretty|compact]
 *   tetaue lsp [--stdio | --node-ipc | --socket=<port> | --pipe=<name>]
 *
 * Modules may import other files (`import "path.tetaue"`); the whole import
 * tree is loaded, analyzed, and reported. `build` reads defaults from the
 * nearest tetaue.toml's `[build]` table (out, dialect, format, pre, post);
 * command-line flags override them.
 ******************************************************************************/
import {
    existsSync, mkdirSync, readFileSync, readdirSync, statSync, watch, writeFileSync,
} from 'node:fs';
import * as path from 'node:path';
import { execSync } from 'node:child_process';
import { NodeFileSystem } from 'langium/node';
import { URI } from 'langium';
import { createTetaueServices } from './language/tetaue-module.js';
import type { TetaueServices } from './language/tetaue-module.js';
import { DIALECTS, isDialect } from './language/render.js';
import type { RenderFormat } from './language/render.js';
import { compileModuleText } from './language/compile.js';
import type { CompileDiagnostic, CompileOutcome } from './language/compile.js';
import { collectModuleTree, moduleOf } from './language/imports.js';
import type { ProjectModule } from './language/imports.js';
import { findManifestDir, MANIFEST_NAME, parseManifest, resolveImport } from './language/resolve.js';
import type { BuildConfig } from './language/resolve.js';
import { formatTetaue } from './language/lsp/formatter.js';
import type { Model } from './language/generated/ast.js';

const HELP = `tetaue — a pure functional SQL query language

Usage:
  tetaue render <file.tetaue> [--dialect <name>] [--format pretty|compact] [--cte]
      Validate the module (and its imports) and render its query to SQL.
  tetaue check <file.tetaue>
      Validate the module and report all diagnostics.
  tetaue parse <file.tetaue>
      Parse the module and print its AST as JSON.
  tetaue format <file.tetaue...> [--check] [--tabs] [--tab-width <n>]   (alias: fmt)
      Format files in place (default: 4-space indent; --tabs for tabs).
      --check only reports files that would change and exits 1 if any.
  tetaue format --stdin [--check]
      Read a module from stdin and print the formatted text to stdout.
  tetaue build [dir] [--dialect <name>] [--format pretty|compact]
               [--out <dir>] [--pre-hook <cmd>] [--post-hook <cmd>] [--no-hooks]
      Check every .tetaue file under dir (default: .) and write rendered SQL
      for each module whose query compiles, mirroring the tree under <out>
      (default: dist/sql). Library modules (no query) are checked, not
      written. --pre-hook/--post-hook run shell commands around the build;
      defaults come from tetaue.toml's [build] table unless overridden.
  tetaue watch <file.tetaue|dir> [--dialect <name>] [--format pretty|compact]
      Watch a file (or every .tetaue file under a directory) and re-render on
      change. Editing tetaue.toml re-checks everything. Ctrl+C quits.
  tetaue lsp [--stdio | --node-ipc | --socket=<port> | --pipe=<name>]
      Start the language server (default transport: stdio).
  tetaue --help

Dialects: ${Object.keys(DIALECTS).join(', ')} (default: sqlite)
`;

function usage(message?: string): number {
    if (message) console.error(`error: ${message}\n`);
    console.error(HELP);
    return 2;
}

function msg(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}

function printCompileDiagnostics(diagnostics: CompileDiagnostic[]): void {
    for (const d of diagnostics) {
        console.error(`${d.uri}:${d.line + 1}:${d.character + 1}: error: ${d.message}`);
    }
}

function printWarnings(warnings: CompileDiagnostic[]): void {
    for (const w of warnings) {
        console.error(`${w.uri}:${w.line + 1}:${w.character + 1}: warning: ${w.message}`);
    }
}

// ---------------------------------------------------------------------------
// render / check
// ---------------------------------------------------------------------------

async function cmdRenderCheck(command: 'render' | 'check', args: string[]): Promise<number> {
    let dialect = 'sqlite';
    let format: RenderFormat = 'pretty';
    let cte = false;
    const files: string[] = [];
    while (args.length > 0) {
        const arg = args.shift()!;
        if (arg === '--dialect') {
            const value = args.shift();
            if (value === undefined) return usage(`--dialect expects a value (${Object.keys(DIALECTS).join(', ')})`);
            dialect = value;
        } else if (arg === '--cte') {
            cte = true;
        } else if (arg === '--format') {
            const value = args.shift();
            if (value !== 'pretty' && value !== 'compact') return usage(`--format expects 'pretty' or 'compact'`);
            format = value;
        } else if (arg.startsWith('-')) {
            return usage(`unknown option '${arg}'`);
        } else {
            files.push(arg);
        }
    }

    if (files.length !== 1) return usage(`exactly one file expected, got ${files.length}`);
    if (!isDialect(dialect)) {
        console.error(`error: unknown dialect '${dialect}' — available: ${Object.keys(DIALECTS).join(', ')}`);
        return 2;
    }

    const file = files[0]!;
    const services = createTetaueServices(NodeFileSystem).tetaue;
    const rootUri = URI.file(path.resolve(file)).toString();
    let rootText: string;
    try {
        rootText = readFileSync(URI.parse(rootUri).fsPath, 'utf8');
    } catch (err) {
        console.error(`error: cannot read ${file}: ${msg(err)}`);
        return 1;
    }
    const outcome = compileModuleText(rootUri, rootText, services, { dialect, format, cte });
    if (!outcome.ok) {
        printCompileDiagnostics(outcome.diagnostics);
        return 1;
    }
    printWarnings(outcome.warnings ?? []);
    if (command === 'render') {
        console.log(outcome.sql);
    } else {
        console.log(`OK — ${file} is a valid tetaue module`);
    }
    return 0;
}

// ---------------------------------------------------------------------------
// parse
// ---------------------------------------------------------------------------

function loadProject(file: string, services: TetaueServices): { modules: readonly ProjectModule[]; main: ProjectModule } {
    const rootUri = URI.file(path.resolve(file)).toString();
    const rootText = readFileSync(URI.parse(rootUri).fsPath, 'utf8');

    const parse = (text: string, uri: string): Model => {
        const result = services.parser.LangiumParser.parse(text);
        const parseErrors = [
            ...result.lexerErrors.map(e => e.message),
            ...result.parserErrors.map(e => e.message),
        ];
        if (!result.value || parseErrors.length > 0) {
            throw new Error(parseErrors.join('; ') || 'no parse result');
        }
        return result.value as Model;
    };

    let main: ProjectModule;
    try {
        main = { model: parse(rootText, rootUri), uri: rootUri, imports: [] };
    } catch (err) {
        throw new Error(`${file}: ${msg(err)}`);
    }

    const tree = collectModuleTree(main, {
        resolve: (importerUri, spec) => resolveImport(importerUri, spec),
        read: (uri) => {
            try {
                return readFileSync(URI.parse(uri).fsPath, 'utf8');
            } catch {
                return undefined;
            }
        },
        parse,
    });

    // Prepend import-resolution errors onto the main module's analysis.
    const { modules, diagnostics: treeDiagnostics } = tree;
    if (treeDiagnostics.length > 0) {
        console.error(`error: failed to resolve imports in ${file}`);
        for (const d of treeDiagnostics) {
            const m = moduleOf(d.node, modules) ?? main;
            const pos = d.node?.$cstNode?.range.start;
            const where = pos ? `${m.uri ?? file}:${pos.line + 1}:${pos.character + 1}` : m.uri ?? file;
            console.error(`${where}: error: ${d.message}`);
        }
        process.exit(1);
    }
    return { modules, main };
}

async function cmdParse(args: string[]): Promise<number> {
    if (args.some(a => a.startsWith('-'))) return usage(`parse takes no options`);
    if (args.length !== 1) return usage(`exactly one file expected, got ${args.length}`);
    const file = args[0]!;
    const services = createTetaueServices(NodeFileSystem).tetaue;
    let main: ProjectModule;
    try {
        ({ main } = loadProject(file, services));
    } catch (err) {
        console.error(`error: ${msg(err)}`);
        return 1;
    }
    console.log(JSON.stringify(dumpAst(main.model), null, 2));
    return 0;
}

function dumpAst(node: { $type: string }): unknown {
    const record = node as unknown as Record<string, unknown>;
    const out: Record<string, unknown> = { $type: node.$type };
    for (const key of Object.keys(record)) {
        if (key.startsWith('$')) continue;
        const value = record[key];
        if (value === undefined || value === null) continue;
        if (Array.isArray(value)) {
            out[key] = value.map(v => (v && typeof v === 'object' && '$type' in (v as object) ? dumpAst(v as { $type: string }) : v));
        } else if (value && typeof value === 'object' && '$type' in value) {
            out[key] = dumpAst(value as { $type: string });
        } else {
            out[key] = value;
        }
    }
    return out;
}

// ---------------------------------------------------------------------------
// format (alias: fmt)
// ---------------------------------------------------------------------------

async function readStdin(): Promise<string> {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks).toString('utf8');
}

async function cmdFormat(args: string[]): Promise<number> {
    let check = false;
    let stdin = false;
    let tabs = false;
    let tabWidth = 4;
    const files: string[] = [];
    while (args.length > 0) {
        const arg = args.shift()!;
        if (arg === '--check') {
            check = true;
        } else if (arg === '--stdin') {
            stdin = true;
        } else if (arg === '--tabs') {
            tabs = true;
        } else if (arg === '--tab-width') {
            const value = args.shift();
            const n = Number(value);
            if (value === undefined || !Number.isInteger(n) || n < 1) return usage(`--tab-width expects a positive integer`);
            tabWidth = n;
        } else if (arg.startsWith('-')) {
            return usage(`format: unknown option '${arg}'`);
        } else {
            files.push(arg);
        }
    }

    const services = createTetaueServices(NodeFileSystem).tetaue;
    const indentUnit = tabs ? '\t' : ' '.repeat(tabWidth);

    if (stdin) {
        if (files.length > 0) return usage(`format: --stdin cannot be combined with file arguments`);
        const text = await readStdin();
        const formatted = formatTetaue(text, indentUnit, services);
        if (formatted === undefined) {
            console.error(`error: cannot format stdin (lexer error, e.g. unterminated string)`);
            return 1;
        }
        if (check) return formatted === text ? 0 : 1;
        process.stdout.write(formatted);
        return 0;
    }

    if (files.length === 0) return usage(`format expects at least one file (or --stdin)`);
    let changed = 0;
    let failed = 0;
    for (const file of files) {
        let text: string;
        try {
            text = readFileSync(file, 'utf8');
        } catch (err) {
            console.error(`error: cannot read ${file}: ${msg(err)}`);
            failed++;
            continue;
        }
        const formatted = formatTetaue(text, indentUnit, services);
        if (formatted === undefined) {
            console.error(`error: cannot format ${file} (lexer error, e.g. unterminated string)`);
            failed++;
            continue;
        }
        if (formatted === text) continue;
        changed++;
        if (check) {
            console.error(`${file} would be reformatted`);
        } else {
            writeFileSync(file, formatted);
        }
    }
    if (check && changed > 0) {
        console.error(`${changed} file(s) would be reformatted`);
        return 1;
    }
    return failed > 0 ? 1 : 0;
}

// ---------------------------------------------------------------------------
// build
// ---------------------------------------------------------------------------

/** Directories never scanned by build/watch (matches .gitignore). */
export const SKIP_DIRS = new Set(['node_modules', '.git', 'out', 'dist']);

/** Recursively collect `*.tetaue` files under `root` (sorted). */
export function findTetaueFiles(root: string, out: string[] = []): string[] {
    let entries;
    try {
        entries = readdirSync(root, { withFileTypes: true });
    } catch {
        return out;
    }
    for (const entry of entries) {
        if (entry.isDirectory()) {
            if (!SKIP_DIRS.has(entry.name)) findTetaueFiles(path.join(root, entry.name), out);
        } else if (entry.isFile() && entry.name.endsWith('.tetaue')) {
            out.push(path.join(root, entry.name));
        }
    }
    return out.sort();
}

export interface BuildOptions {
    dialect: string;
    format: RenderFormat;
    /** Directory where rendered .sql files are written (created on demand). */
    out: string;
}

export interface BuildResult {
    /** Modules whose query compiled; their SQL was written to `sqlFiles`. */
    built: number;
    /** Clean modules whose last binding is not a query (library files). */
    library: number;
    /** Modules with diagnostics. */
    errors: number;
    /** Non-fatal warnings (e.g. import shadowing) surfaced during builds. */
    warnings: number;
    files: string[];
    sqlFiles: string[];
}

/**
 * Check every `.tetaue` file under `root` and render the ones that evaluate
 * to a query. Prints diagnostics to stderr; returns the summary counts.
 */
export function buildProject(root: string, options: BuildOptions, services: TetaueServices): BuildResult {
    const files = findTetaueFiles(root);
    const result: BuildResult = { built: 0, library: 0, errors: 0, warnings: 0, files, sqlFiles: [] };
    for (const file of files) {
        const uri = URI.file(file).toString();
        let text: string;
        try {
            text = readFileSync(file, 'utf8');
        } catch (err) {
            console.error(`error: cannot read ${file}: ${msg(err)}`);
            result.errors++;
            continue;
        }
        // requireQuery: false — a library module (no query) is not an error.
        const outcome = compileModuleText(uri, text, services, {
            dialect: options.dialect,
            format: options.format,
            requireQuery: false,
        });
        if (outcome.ok) {
            printWarnings(outcome.warnings ?? []);
            if (outcome.warnings) result.warnings += outcome.warnings.length;
            const outFile = path.join(options.out, path.relative(root, file).replace(/\.tetaue$/, '') + '.sql');
            mkdirSync(path.dirname(outFile), { recursive: true });
            writeFileSync(outFile, outcome.sql);
            result.built++;
            result.sqlFiles.push(outFile);
        } else if (outcome.diagnostics.length > 0) {
            printCompileDiagnostics(outcome.diagnostics);
            result.errors++;
        } else {
            result.library++;
        }
    }
    return result;
}

function runHook(command: string, phase: string): boolean {
    console.error(`[build] ${phase}-hook: ${command}`);
    try {
        execSync(command, { stdio: 'inherit' });
        return true;
    } catch {
        return false;
    }
}

async function cmdBuild(args: string[]): Promise<number> {
    let dialect: string | undefined;
    let format: RenderFormat | undefined;
    let out: string | undefined;
    let pre: string | undefined;
    let post: string | undefined;
    let noHooks = false;
    const positional: string[] = [];
    while (args.length > 0) {
        const arg = args.shift()!;
        if (arg === '--dialect') {
            const value = args.shift();
            if (value === undefined) return usage(`--dialect expects a value (${Object.keys(DIALECTS).join(', ')})`);
            dialect = value;
        } else if (arg === '--format') {
            const value = args.shift();
            if (value !== 'pretty' && value !== 'compact') return usage(`--format expects 'pretty' or 'compact'`);
            format = value;
        } else if (arg === '--out') {
            const value = args.shift();
            if (value === undefined || value.length === 0) return usage(`--out expects a directory`);
            out = value;
        } else if (arg === '--pre-hook') {
            const value = args.shift();
            if (value === undefined) return usage(`--pre-hook expects a command`);
            pre = value;
        } else if (arg === '--post-hook') {
            const value = args.shift();
            if (value === undefined) return usage(`--post-hook expects a command`);
            post = value;
        } else if (arg === '--no-hooks') {
            noHooks = true;
        } else if (arg.startsWith('-')) {
            return usage(`build: unknown option '${arg}'`);
        } else {
            positional.push(arg);
        }
    }
    if (positional.length > 1) return usage(`build expects at most one directory, got ${positional.length}`);

    const root = path.resolve(positional[0] ?? '.');
    if (!existsSync(root) || !statSync(root).isDirectory()) {
        console.error(`error: build root '${root}' is not a directory`);
        return 1;
    }

    // Defaults from the nearest tetaue.toml's [build] table; CLI flags win.
    const manifestDir = findManifestDir(root);
    let cfg: BuildConfig | undefined;
    if (manifestDir) {
        try {
            cfg = parseManifest(readFileSync(path.join(manifestDir, MANIFEST_NAME), 'utf8')).build;
        } catch {
            // malformed manifest — dependency resolution reports it; ignore [build]
        }
    }

    const finalDialect = dialect ?? cfg?.dialect ?? 'sqlite';
    if (!isDialect(finalDialect)) {
        console.error(`error: unknown dialect '${finalDialect}' — available: ${Object.keys(DIALECTS).join(', ')}`);
        return 2;
    }
    const finalFormat = format
        ?? (cfg?.format === 'pretty' || cfg?.format === 'compact' ? cfg.format : undefined)
        ?? 'pretty';
    let outDir: string;
    if (out !== undefined) outDir = path.resolve(out);
    else if (cfg?.out !== undefined && manifestDir !== undefined) outDir = path.resolve(manifestDir, cfg.out);
    else outDir = path.resolve(root, 'dist/sql');
    const preHook = noHooks ? undefined : (pre ?? cfg?.pre);
    const postHook = noHooks ? undefined : (post ?? cfg?.post);

    const services = createTetaueServices(NodeFileSystem).tetaue;
    console.error(`[build] ${root} (dialect: ${finalDialect})`);
    if (preHook !== undefined && !runHook(preHook, 'pre')) return 1;
    const start = performance.now();
    const result = buildProject(root, { dialect: finalDialect, format: finalFormat, out: outDir }, services);
    const ms = Math.round(performance.now() - start);
    for (const f of result.sqlFiles) console.error(`  wrote ${path.relative(process.cwd(), f) || f}`);
    console.error(`[build] ${result.built} query module(s) rendered, ${result.library} library module(s), ${result.errors} error(s), ${result.warnings} warning(s) in ${ms} ms → ${path.relative(process.cwd(), outDir) || outDir}`);
    if (postHook !== undefined && !runHook(postHook, 'post')) return 1;
    return result.errors > 0 ? 1 : 0;
}

// ---------------------------------------------------------------------------
// watch
// ---------------------------------------------------------------------------

export interface WatchOptions {
    dialect: string;
    format: RenderFormat;
}

export interface WatchSession {
    /** Close all fs watchers (the process may then exit). */
    stop(): void;
    /** Compile one file immediately (initial pass, no debounce). */
    runNow(file: string): void;
    /** Debounce a file change and compile it. */
    schedule(file: string): void;
    /** Compile every relevant file (initial pass / manifest change). */
    runAll(): void;
}

/** Watch a file or a directory tree; `onChange` receives changed paths. */
function makeWatcher(targetAbs: string, isDir: boolean, onChange: (p: string) => void): () => void {
    if (!isDir) {
        // Watch the parent directory, not the file: editors often save via
        // rename, which fires on the directory but not the file itself.
        const dir = path.dirname(targetAbs);
        const base = path.basename(targetAbs);
        const watcher = watch(dir, (_event, name) => {
            if (name === base) onChange(targetAbs);
        });
        return () => watcher.close();
    }
    try {
        const watcher = watch(targetAbs, { recursive: true }, (_event, name) => {
            if (typeof name === 'string') onChange(path.join(targetAbs, name));
        });
        return () => watcher.close();
    } catch {
        // Recursive watch unsupported (older Linux kernels): watch every
        // directory and pick up newly created directories as they appear.
        const watchers: ReturnType<typeof watch>[] = [];
        const watched = new Set<string>();
        const ensure = (dir: string): void => {
            if (watched.has(dir)) return;
            watched.add(dir);
            const w = watch(dir, (_event, name) => {
                if (typeof name !== 'string') return;
                const p = path.join(dir, name);
                let st;
                try {
                    st = statSync(p);
                } catch {
                    return;
                }
                if (st.isDirectory()) ensure(p);
                onChange(p);
            });
            watchers.push(w);
        };
        const walk = (dir: string): void => {
            ensure(dir);
            for (const entry of readdirSync(dir, { withFileTypes: true })) {
                if (entry.isDirectory() && !SKIP_DIRS.has(entry.name)) walk(path.join(dir, entry.name));
            }
        };
        walk(targetAbs);
        return () => {
            for (const w of watchers) w.close();
        };
    }
}

/**
 * Watch `targetAbs` (a file or directory) and compile on change. Results are
 * delivered to `onResult(file, outcome)`. Editing tetaue.toml re-runs every
 * file (import resolution may have changed). Returns a session you can stop.
 */
export function startWatch(
    targetAbs: string,
    isDir: boolean,
    options: WatchOptions,
    services: TetaueServices,
    onResult: (file: string, outcome: CompileOutcome) => void,
): WatchSession {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const pending = new Set<string>();

    const runNow = (file: string): void => {
        let text: string;
        try {
            text = readFileSync(file, 'utf8');
        } catch {
            return;
        }
        const outcome = compileModuleText(URI.file(file).toString(), text, services, {
            dialect: options.dialect,
            format: options.format,
        });
        onResult(file, outcome);
    };

    const schedule = (file: string): void => {
        pending.add(file);
        if (timer !== undefined) clearTimeout(timer);
        timer = setTimeout(() => {
            timer = undefined;
            const files = [...pending];
            pending.clear();
            for (const f of files) runNow(f);
        }, 120);
    };

    const runAll = (): void => {
        for (const f of isDir ? findTetaueFiles(targetAbs) : [targetAbs]) runNow(f);
    };

    const stop = makeWatcher(targetAbs, isDir, (p) => {
        if (path.basename(p) === MANIFEST_NAME) runAll();
        else if (p.endsWith('.tetaue')) schedule(p);
    });

    return { stop, runNow, schedule, runAll };
}

async function cmdWatch(args: string[]): Promise<number> {
    let dialect = 'sqlite';
    let format: RenderFormat = 'pretty';
    const files: string[] = [];
    while (args.length > 0) {
        const arg = args.shift()!;
        if (arg === '--dialect') {
            const value = args.shift();
            if (value === undefined) return usage(`--dialect expects a value (${Object.keys(DIALECTS).join(', ')})`);
            dialect = value;
        } else if (arg === '--format') {
            const value = args.shift();
            if (value !== 'pretty' && value !== 'compact') return usage(`--format expects 'pretty' or 'compact'`);
            format = value;
        } else if (arg.startsWith('-')) {
            return usage(`watch: unknown option '${arg}'`);
        } else {
            files.push(arg);
        }
    }
    if (files.length !== 1) return usage(`watch expects exactly one file or directory, got ${files.length}`);
    if (!isDialect(dialect)) {
        console.error(`error: unknown dialect '${dialect}' — available: ${Object.keys(DIALECTS).join(', ')}`);
        return 2;
    }

    const target = path.resolve(files[0]!);
    let isDir: boolean;
    try {
        isDir = statSync(target).isDirectory();
    } catch {
        console.error(`error: cannot watch ${files[0]}: no such file or directory`);
        return 1;
    }

    const services = createTetaueServices(NodeFileSystem).tetaue;
    const display = path.relative(process.cwd(), target) || target;
    console.error(`[tetaue] watching ${display} (dialect: ${dialect}) — Ctrl+C to quit`);

    const session = startWatch(target, isDir, { dialect, format }, services, (file, outcome) => {
        const ts = new Date().toTimeString().slice(0, 8);
        const rel = isDir ? path.relative(target, file) || path.basename(file) : path.relative(process.cwd(), file) || file;
        if (outcome.ok) {
            console.error(`[${ts}] ${rel} — ok`);
            console.log(outcome.sql);
        } else if (outcome.diagnostics.length > 0) {
            console.error(`[${ts}] ${rel} — ${outcome.diagnostics.length} error${outcome.diagnostics.length === 1 ? '' : 's'}`);
            printCompileDiagnostics(outcome.diagnostics);
        } else {
            console.error(`[${ts}] ${rel} — module does not evaluate to a query`);
        }
    });
    session.runAll();

    // The fs watcher keeps the event loop alive; Ctrl+C exits. Never resolves.
    await new Promise<void>(() => { /* keep the process alive */ });
    return 0;
}

// ---------------------------------------------------------------------------
// lsp
// ---------------------------------------------------------------------------

async function cmdLsp(args: string[]): Promise<number> {
    // Only transport flags are meaningful; everything else is an error.
    let i = 0;
    while (i < args.length) {
        const arg = args[i]!;
        if (arg === '--stdio' || arg === '--node-ipc' || arg.startsWith('--socket=') || arg.startsWith('--pipe=')) {
            i++;
        } else if (arg === '--socket' || arg === '--pipe') {
            if (i + 1 >= args.length) return usage(`${arg} expects a value`);
            i += 2;
        } else {
            return usage(`lsp: unknown option '${arg}' — transport flags: --stdio, --node-ipc, --socket=<port>, --pipe=<name>`);
        }
    }
    // Transport flags stay in process.argv — vscode-languageserver's
    // createConnection scans process.argv for them. The server keeps the
    // process alive on the chosen transport; we never return.
    const server = await import('./language-server.js');
    server.startTetaueServer();
    return 0;
}

// ---------------------------------------------------------------------------

export async function main(argv: string[]): Promise<number> {
    const args = [...argv];
    if (args.length === 0 || args[0] === '--help' || args[0] === '-h' || args[0] === 'help') {
        console.error(HELP);
        return args.length === 0 ? 2 : 0;
    }

    const command = args.shift()!;
    switch (command) {
        case 'render':
        case 'check':
            return cmdRenderCheck(command, args);
        case 'parse':
            return cmdParse(args);
        case 'format':
        case 'fmt':
            return cmdFormat(args);
        case 'build':
            return cmdBuild(args);
        case 'watch':
            return cmdWatch(args);
        case 'lsp':
            return cmdLsp(args);
        default:
            return usage(`unknown command '${command}'`);
    }
}

if (import.meta.main) {
    main(process.argv.slice(2)).then(code => {
        process.exitCode = code;
    }).catch(err => {
        console.error(`error: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
        process.exitCode = 1;
    });
}
