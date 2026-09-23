/******************************************************************************
 * Test helpers — parse text into a Model, run the interpreter, render SQL.
 ******************************************************************************/
import { NodeFileSystem } from 'langium/node';
import { URI } from 'langium';
import { createTetaueServices } from '../src/language/tetaue-module.js';
import type { TetaueServices } from '../src/language/tetaue-module.js';
import { analyze, analyzeProject } from '../src/language/interpreter.js';
import { infer } from '../src/language/inference.js';
import { checkProject } from '../src/language/checker.js';
import { baseLibraryOptions, standardPrelude } from '../src/language/prelude.js';
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
    return analyze(parseModel(text), standardPrelude(services)).diagnostics.map(d => d.message);
}

/** Run the type-inference pass and return its diagnostic messages. */
export function typeErrors(text: string): string[] {
    return infer(parseModel(text), standardPrelude(services)).diagnostics.map(d => d.message);
}

/** Interpreter + inference diagnostics merged exactly as check/render surface them. */
export function allErrors(text: string): string[] {
    const model = parseModel(text);
    const project = [{ model, uri: undefined, imports: [] }];
    const { diagnostics } = checkProject(project, {
        importsByModule: new Map(),
        prelude: standardPrelude(services),
    });
    return diagnostics.map(d => d.message);
}

/** Interpret a module and render its query to SQL. Throws on diagnostics. */
export function render(text: string, dialect: string = 'sqlite', format: RenderFormat = 'pretty'): string {
    const model = parseModel(text);
    const { value, diagnostics } = analyzeProject(
        [{ model, uri: undefined, imports: [] }],
        { prelude: standardPrelude(services), dialect: DIALECTS[dialect] },
    );
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

/**
 * Check a module with the BASE LIBRARY'S LOWERING VOCABULARY in scope.
 *
 * `sql_func`/`sql_infix`/`sql_bare`/`sql_dialect`/`core.*` are private to the
 * library: a user module reaches SQL only through the exported surface. Tests
 * that exercise the lowering mechanism itself therefore declare a small
 * library module that re-exports those primitives, and import it — which is
 * exactly how `base/sql.tetaue` is written, and keeps the tests honest about
 * the boundary instead of punching a hole in it.
 */
export function checkWithLowerings(
    text: string,
    options: { dialect?: string; requireQuery?: boolean } = {},
): ReturnType<typeof checkProject> {
    const library = baseLibraryOptions(services);
    const loweringModule = parseModel(
        'export sql_func = core.sql_func\n'
        + 'export sql_infix = core.sql_infix\n'
        + 'export sql_cast = core.sql_cast\n'
        + 'export sql_bare = core.sql_bare\n'
        + 'export sql_dialect = core.sql_dialect\n',
    );
    const lowering: { model: Model; uri: string; imports: [] } = {
        model: loweringModule,
        uri: 'base/TestLowerings.tetaue',
        imports: [],
    };
    const model = parseModel(`import "base/TestLowerings.tetaue"\n${text}`);
    const module = { model, uri: 'base/Test.tetaue', imports: [] };
    return checkProject([module], {
        requireQuery: options.requireQuery ?? false,
        ...library,
        importsByModule: new Map([[
            module,
            [{ alias: undefined, target: lowering, importNode: model.imports[0]! }],
        ]]),
        baseModules: [...library.baseModules, lowering],
        dialect: options.dialect ? DIALECTS[options.dialect] : undefined,
    });
}

/**
 * The inferred signatures of a BASE module's own definitions, keyed by name.
 *
 * A base module's declarations no longer all live in the primitive catalog:
 * the date/time family is defined in `base/sql/time.tetaue`, so its
 * signatures are ORDINARY INFERRED TYPES. Reading them back here is what lets
 * a test pin "the calendar type threads from argument to result" without
 * asserting a TypeScript scheme.
 */
export function baseLibraryModuleTypes(uri: string): Map<string, string[]> {
    const library = baseLibraryOptions(services);
    const target = library.baseModules.find(m => m.uri === uri);
    if (!target) throw new Error(`no base module '${uri}'`);
    const result = checkProject([target], { ...library, requireQuery: false, dialect: DIALECTS['sqlite'] });
    const types = new Map<string, string[]>();
    for (const binding of target.model.bindings) {
        const type = result.typeOf(binding);
        if (type === undefined) continue;
        types.set(binding.name, [...(types.get(binding.name) ?? []), type]);
    }
    for (const [name, list] of types) types.set(name, list.slice().sort());
    return types;
}
