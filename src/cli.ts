/******************************************************************************
 * tetaue CLI — render / check / parse a .tetaue module.
 *
 *   tetaue render <file> [--dialect sqlite|postgresql|mysql] [--format pretty|compact]
 *   tetaue check <file>
 *   tetaue parse <file>
 ******************************************************************************/
import { NodeFileSystem } from 'langium/node';
import { URI } from 'langium';
import path from 'node:path';
import { createTetaueServices } from './language/tetaue-module.js';
import type { TetaueServices } from './language/tetaue-module.js';
import { analyze } from './language/interpreter.js';
import type { AnalysisResult } from './language/interpreter.js';
import { renderQuery, DIALECTS, isDialect } from './language/render.js';
import type { RenderFormat } from './language/render.js';
import type { Model } from './language/generated/ast.js';

const HELP = `tetaue — a pure functional SQL query language

Usage:
  tetaue render <file.tetaue> [--dialect <name>] [--format pretty|compact]
      Validate the module and render its query to SQL.
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

async function loadModel(file: string): Promise<{ services: TetaueServices; model: Model }> {
    const services = createTetaueServices(NodeFileSystem);
    const uri = URI.file(path.resolve(file));
    const doc = await services.shared.workspace.LangiumDocuments.getOrCreateDocument(uri);
    await services.shared.workspace.DocumentBuilder.build([doc], { validation: true });
    const model = doc.parseResult.value as Model | undefined;
    if (!model) {
        const lexer = doc.parseResult.lexerErrors.map(e => e.message).join('; ');
        const parser = doc.parseResult.parserErrors.map(e => e.message).join('; ');
        throw new Error(`could not parse ${file}${lexer || parser ? `: ${lexer || parser}` : ''}`);
    }
    return { services: services.tetaue, model };
}

function printDiagnostics(file: string, model: Model): AnalysisResult | null {
    const result = analyze(model);
    if (result.diagnostics.length === 0) return result;
    for (const d of result.diagnostics) {
        console.error(formatDiagnostic(file, d.node, d.message));
    }
    return null;
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
    let model: Model;
    try {
        ({ model } = await loadModel(file));
    } catch (err) {
        console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
        return 1;
    }

    switch (command) {
        case 'render': {
            const result = printDiagnostics(file, model);
            if (!result) return 1;
            if (result.value.kind !== 'query') return 1; // defensive: analyze() already reported this
            console.log(renderQuery(result.value.query, DIALECTS[dialect]!, format));
            return 0;
        }
        case 'check': {
            if (!printDiagnostics(file, model)) return 1;
            console.log(`OK — ${file} is a valid tetaue module`);
            return 0;
        }
        case 'parse': {
            console.log(JSON.stringify(dumpAst(model), null, 2));
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
