/******************************************************************************
 * Test helpers — parse text into a Model, run the interpreter, render SQL.
 ******************************************************************************/
import { NodeFileSystem } from 'langium/node';
import { URI } from 'langium';
import { createTetaueServices } from '../src/language/tetaue-module.js';
import type { TetaueServices } from '../src/language/tetaue-module.js';
import { analyze, analyzeProject } from '../src/language/interpreter.js';
import { infer, inferProject, mergeDiagnostics } from '../src/language/inference.js';
import { renderQuery, DIALECTS } from '../src/language/render.js';
import type { RenderFormat } from '../src/language/render.js';
import type { Model } from '../src/language/generated/ast.js';

export const services: TetaueServices = createTetaueServices(NodeFileSystem).tetaue;

let counter = 0;

/** Build a full Langium document (parse + validation) from in-memory text. */
export async function buildDocument(text: string) {
    const uri = URI.from({ scheme: 'memory', path: `/tetaue-test-${counter++}.tetaue` });
    const doc = services.shared.workspace.LangiumDocumentFactory.fromString(text, uri);
    await services.shared.workspace.DocumentBuilder.build([doc], { validation: true });
    return doc;
}

/** Parse text into a Model via the Langium parser (throws on parse errors). */
export function parseModel(text: string): Model {
    const result = services.parser.LangiumParser.parse(text);
    const parseErrors = [
        ...result.lexerErrors.map(e => e.message),
        ...result.parserErrors.map(e => e.message),
    ];
    if (!result.value || parseErrors.length > 0) {
        throw new Error(`parse failed: ${parseErrors.join('; ') || 'no value'}`);
    }
    return result.value as Model;
}

/** Interpret a module and return the diagnostic messages (empty = valid). */
export function errors(text: string): string[] {
    return analyze(parseModel(text)).diagnostics.map(d => d.message);
}

/** Run the type-inference pass and return its diagnostic messages. */
export function typeErrors(text: string): string[] {
    return infer(parseModel(text)).diagnostics.map(d => d.message);
}

/** Interpreter + inference diagnostics merged exactly as check/render surface them. */
export function allErrors(text: string): string[] {
    const model = parseModel(text);
    const project = [{ model, uri: undefined, imports: [] }];
    const { diagnostics } = analyzeProject(project, {});
    const { diagnostics: typeDiagnostics } = inferProject(project);
    return mergeDiagnostics(project, diagnostics, typeDiagnostics).map(d => d.message);
}

/** Interpret a module and render its query to SQL. Throws on diagnostics. */
export function render(text: string, dialect: string = 'sqlite', format: RenderFormat = 'pretty'): string {
    const model = parseModel(text);
    const { value, diagnostics } = analyze(model);
    if (diagnostics.length > 0) {
        throw new Error(`invalid module: ${diagnostics.map(d => d.message).join(' | ')}`);
    }
    if (value.kind !== 'query') {
        throw new Error(`module did not produce a query (got ${value.kind})`);
    }
    const result = renderQuery(value.query, DIALECTS[dialect]!, format);
    if (!result.ok) {
        throw new Error(`render failed: ${result.diagnostics.map(d => d.message).join(' | ')}`);
    }
    return result.sql;
}
