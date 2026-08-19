import { describe, expect, test } from 'bun:test';
import { NodeFileSystem } from 'langium/node';
import { readFileSync } from 'node:fs';
import { createTetaueServices } from '../src/language/tetaue-module.js';
import { standardPrelude, standardPreludeNames, STANDARD_PRELUDE_SOURCE } from '../src/language/prelude.js';
import { BUILTINS, createPreludeEnv } from '../src/language/interpreter.js';
import { BUILTIN_NAMES, CORE_TYPE_NAMES, coreBuiltinName } from '../src/language/builtin.js';
import { checkProject } from '../src/language/checker.js';
import { Inferencer } from '../src/language/inference.js';
import type { Model } from '../src/language/generated/ast.js';

const services = createTetaueServices(NodeFileSystem).tetaue;

function checked(source: string) {
    const parsed = services.parser.LangiumParser.parse(source);
    expect(parsed.lexerErrors).toEqual([]);
    expect(parsed.parserErrors).toEqual([]);
    return checkProject(
        [{ model: parsed.value as Model, uri: undefined, imports: [] }],
        { prelude: standardPrelude(services) },
    );
}

function parsedModule(source: string, uri: string | undefined = undefined) {
    const parsed = services.parser.LangiumParser.parse(source);
    expect(parsed.lexerErrors).toEqual([]);
    expect(parsed.parserErrors).toEqual([]);
    return { model: parsed.value as Model, uri, imports: [] };
}

describe('standard prelude', () => {
    test('is cached per service container', () => {
        expect(standardPrelude(services)).toBe(standardPrelude(services));

        const otherServices = createTetaueServices(NodeFileSystem).tetaue;
        expect(standardPrelude(otherServices)).not.toBe(standardPrelude(services));
    });

    test('the checked-in source matches the embedded distribution source', () => {
        const file = readFileSync(new URL('../prelude.tetaue', import.meta.url), 'utf8').trim();
        expect(file).toBe(STANDARD_PRELUDE_SOURCE.trim());
    });

    test('is ordinary tetaue and is checked by the shared pass', () => {
        const result = checked('q = table "users" & map (compose (u => { name = upper u.name }) id)');
        expect(result.diagnostics).toEqual([]);
        expect(result.value.kind).toBe('query');
    });

    test('defines public operators as ordinary exported bindings', () => {
        const prelude = standardPrelude(services);
        const plus = prelude.model.bindings.find(binding => binding.name === '_+_');
        const forward = prelude.model.bindings.find(binding => binding.name === '_>>>_');
        const pipeline = prelude.model.bindings.find(binding => binding.name === '_&_');
        const apply = prelude.model.bindings.find(binding => binding.name === '_$_');
        const fmap = prelude.model.bindings.find(binding => binding.name === '_<$>_');
        const alternative = prelude.model.bindings.find(binding => binding.name === '_<|>_');
        const bind = prelude.model.bindings.find(binding => binding.name === '_>>=_');
        expect(plus?.export).toBe(true);
        expect(plus?.$cstNode?.text).toBe('export _+_ = @op_add');
        expect(forward?.$cstNode?.text).toBe('export _>>>_ = f => g => x => g (f x)');
        expect(pipeline?.$cstNode?.text).toBe('export _&_ = x => f => f x');
        expect(apply?.$cstNode?.text).toBe('export _$_ = f => x => f x');
        expect(fmap?.$cstNode?.text).toBe('export _<$>_ = fmap');
        expect(alternative?.$cstNode?.text).toBe('export _<|>_ = orElse');
        expect(bind?.$cstNode?.text).toBe('export _>>=_ = bind');
        const core = createPreludeEnv();
        expect(core.has('@op_compose_forward')).toBe(false);
        expect(core.has('@op_pipeline')).toBe(false);
        expect(core.has('@op_apply')).toBe(false);
    });

    test('exports every primitive function and scalar type through aliases', () => {
        const prelude = standardPrelude(services);
        const bindings = new Map(prelude.model.bindings.map(binding => [binding.name, binding]));
        for (const name of BUILTIN_NAMES) {
            expect(bindings.get(name)?.$cstNode?.text).toBe(`export ${name} = ${coreBuiltinName(name)}`);
        }
        const types = new Map(prelude.model.types.map(alias => [alias.name, alias]));
        for (const name of CORE_TYPE_NAMES) {
            expect(types.get(name)?.$cstNode?.text).toBe(`export type ${name} = @${name}`);
        }
        const core = createPreludeEnv();
        expect(core.has('filter')).toBe(false);
        expect(core.has('@filter')).toBe(true);
        expect(core.has('int')).toBe(false);

        const inferencer = new Inferencer();
        inferencer.prelude();
        expect(inferencer.env.has('filter')).toBe(false);
        expect(inferencer.env.has('@filter')).toBe(true);
    });

    test('defines derived helpers outside the primitive builtin table', () => {
        const names = standardPreludeNames(services);
        for (const name of ['is_nothing', 'is_just', 'is_not_null']) {
            expect(names).toContain(name);
            expect(Object.keys(BUILTINS)).not.toContain(name);
        }
        expect(names).not.toContain('filtered');

        const result = checked(`
            users: query { name: (maybe string) } = table "users"
            q = users & filter (u => is_just u.name && is_not_null u.name && is_nothing nothing)
        `);
        expect(result.diagnostics).toEqual([]);
        expect(result.value.kind).toBe('query');
    });

    test('prelude definitions can be shadowed like ordinary bindings', () => {
        const result = checked('id = x => { local = x.id }\nq = table "users" & map id');
        expect(result.diagnostics).toEqual([]);
        expect(result.value.kind).toBe('query');
    });

    test('the source prelude controls the public surface', () => {
        const minimal = parsedModule('export type int = @int\nexport table = @table', 'tetaue:test-prelude');
        const publicUse = checkProject(
            [parsedModule('users: query { id: int } = table "users"\nq = users & filter (u => true)')],
            { prelude: minimal },
        );
        expect(publicUse.diagnostics.map(d => d.message).join('\n')).toContain("unknown identifier 'filter'");

        const coreUse = checkProject(
            [parsedModule('q = @filter (u => true) (@table "users")')],
            { prelude: minimal },
        );
        expect(coreUse.diagnostics).toEqual([]);
        expect(coreUse.value.kind).toBe('query');
    });

    test('omitting the source prelude exposes only core names', () => {
        const publicUse = checkProject(
            [parsedModule('q = filter')],
            { requireQuery: false },
        );
        expect(publicUse.diagnostics.map(d => d.message).join('\n')).toContain("unknown identifier 'filter'");

        const coreUse = checkProject(
            [parsedModule('q = @filter')],
            { requireQuery: false },
        );
        expect(coreUse.diagnostics).toEqual([]);
    });
});
