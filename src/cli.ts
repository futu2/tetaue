/******************************************************************************
 * tetaue CLI — render / check / parse a .tetaue module.
 *
 *   tetaue render <file> [--dialect sqlite|postgresql|mysql] [--format pretty|compact]
 *   tetaue check <file>
 *   tetaue parse <file>
 *
 * Modules may import other files (`import "path.tetaue"`); the whole import
 * tree is loaded, analyzed, and reported.
 ******************************************************************************/
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { NodeFileSystem } from 'langium/node';
import { URI, type AstNode } from 'langium';
import { createTetaueServices } from './language/tetaue-module.js';
import type { TetaueServices } from './language/tetaue-module.js';
import { analyzeProject, describe } from './language/interpreter.js';
import { renderQuery, DIALECTS, isDialect } from './language/render.js';
import type { RenderFormat } from './language/render.js';
import { collectModuleTree, moduleOf } from './language/imports.js';
import type { ProjectModule } from './language/imports.js';
import type { Model } from './language/generated/ast.js';

const HELP = `tetaue — a pure functional SQL query language

Usage:
  tetaue render <file.tetaue> [--dialect <name>] [--format pretty|compact]
      Validate the module (and its imports) and render its query to SQL.
      Dialects: ${Object.keys(DIALECTS).join(', ')} (default: sqlite)
  tetaue check <file.tetaue>
      Validate the module and report all diagnostics.
  tetaue parse <file.tetaue>
      Parse the module and print its AST as JSON.
  tetaue --help
`;

function usage(message?: string): number {
    if (message) console.error(`error: ${message}\n`);
    console.error(HELP);
    return 2;
}

function formatDiagnostic(file: string, node: { $cstNode?: { range: { start: { line: number; character: number } } } | null } | undefined, message: string): string {
    const pos = node?.$cstNode?.range.start;
    const where = pos ? `${file}:${pos.line + 1}:${pos.character + 1}` : file;
    return `${where}: error: ${message}`;
}

function loadProject(file: string, services: TetaueServices): { modules: ProjectModule[]; main: ProjectModule } {
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
        main = { model: parse(rootText, rootUri), uri: rootUri };
    } catch (err) {
        throw new Error(`${file}: ${err instanceof Error ? err.message : String(err)}`);
    }

    const tree = collectModuleTree(main, {
        resolve: (importerUri, spec) => {
            const base = importerUri ? path.dirname(URI.parse(importerUri).fsPath) : path.dirname(file);
            return URI.file(path.resolve(base, spec)).toString();
        },
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
            console.error(formatDiagnostic(m.uri ?? file, d.node, d.message));
        }
        process.exit(1);
    }
    return { modules, main };
}

function printSemanticDiagnostics(modules: ProjectModule[], main: ProjectModule): boolean {
    const { value, diagnostics } = analyzeProject(modules.map(m => m.model), { requireQuery: true });
    if (diagnostics.length === 0) return false;
    for (const d of diagnostics) {
        const m = moduleOf(d.node, modules) ?? main;
        console.error(formatDiagnostic(m.uri ?? '<memory>', d.node, d.message));
    }
    if (value.kind === 'error') {
        console.error(`error: evaluation failed`);
    }
    return true;
}

export async function main(argv: string[]): Promise<number> {
    const args = [...argv];
    if (args.length === 0 || args[0] === '--help' || args[0] === '-h' || args[0] === 'help') {
        console.error(HELP);
        return args.length === 0 ? 2 : 0;
    }

    const command = args.shift()!;
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

    let modules: ProjectModule[];
    let main: ProjectModule;
    try {
        ({ modules, main } = loadProject(file, services));
    } catch (err) {
        console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
        return 1;
    }

    switch (command) {
        case 'render': {
            if (printSemanticDiagnostics(modules, main)) return 1;
            const { value } = analyzeProject(modules.map(m => m.model), { requireQuery: true });
            if (value.kind !== 'query') return 1;
            console.log(renderQuery(value.query, DIALECTS[dialect]!, format));
            return 0;
        }
        case 'check': {
            if (printSemanticDiagnostics(modules, main)) return 1;
            console.log(`OK — ${file} is a valid tetaue module`);
            return 0;
        }
        case 'parse': {
            console.log(JSON.stringify(dumpAst(main.model), null, 2));
            return 0;
        }
        default:
            return usage(`unknown command '${command}'`);
    }
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

if (import.meta.main) {
    main(process.argv.slice(2)).then(code => {
        process.exitCode = code;
    }).catch(err => {
        console.error(`error: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
        process.exitCode = 1;
    });
}
