import { describe, expect, test } from 'bun:test';
import { NodeFileSystem } from 'langium/node';
import { readFileSync } from 'node:fs';
import { createTetaueServices } from '../src/language/tetaue-module.js';
import { standardPrelude, standardPreludeNames, STANDARD_PRELUDE_SOURCE } from '../src/language/prelude.js';
import { BUILTINS, createPreludeEnv } from '../src/language/interpreter.js';
import { BUILTIN_NAMES } from '../src/language/builtin.js';
import { MAYBE_NAMESPACE, PRELUDE_NAMESPACES } from '../src/language/prelude-namespaces.js';
import { checkProject } from '../src/language/checker.js';
import { Inferencer } from '../src/language/inference.js';
import type { Model } from '../src/language/generated/ast.js';

const services = createTetaueServices(NodeFileSystem).tetaue;

function checked(source: string, options: { requireQuery?: boolean } = {}) {
    const parsed = services.parser.LangiumParser.parse(source);
    expect(parsed.lexerErrors).toEqual([]);
    expect(parsed.parserErrors).toEqual([]);
    return checkProject(
        [{ model: parsed.value as Model, uri: undefined, imports: [] }],
        { prelude: standardPrelude(services), requireQuery: options.requireQuery ?? true },
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
        expect(plus?.$cstNode?.text).toBe('export _+_ = op_add');
        expect(forward?.$cstNode?.text).toBe('export _>>>_ = f => g => x => g (f x)');
        expect(pipeline?.$cstNode?.text).toBe('export _&_ = x => f => f x');
        expect(apply?.$cstNode?.text).toBe('export _$_ = f => x => f x');
        expect(fmap?.$cstNode?.text).toBe('export _<$>_ = fmap');
        expect(alternative?.$cstNode?.text).toBe('export _<|>_ = orElse');
        expect(bind?.$cstNode?.text).toBe('export _>>=_ = bind');
        const core = createPreludeEnv();
        expect(core.has('op_compose_forward')).toBe(false);
        expect(core.has('op_pipeline')).toBe(false);
        expect(core.has('op_apply')).toBe(false);
    });

    test('builtin names are native — no @ prefix, no alias shims', () => {
        const prelude = standardPrelude(services);
        // The prelude no longer re-exports every builtin: builtins are native
        // names supplied by the core, so the source prelude binds only the
        // derived helpers and operator sections.
        expect(prelude.model.bindings.find(b => b.name === 'table')).toBeUndefined();
        const core = createPreludeEnv();
        expect(core.has('filter')).toBe(true);
        expect(core.has('@filter')).toBe(false);
        expect(core.has('table')).toBe(true);
        expect(core.has('int')).toBe(false); // types are not runtime values

        const inferencer = new Inferencer();
        inferencer.prelude();
        expect(inferencer.env.has('filter')).toBe(true);
        expect(inferencer.env.has('@filter')).toBe(false);
        // Every builtin name is reachable natively.
        for (const name of BUILTIN_NAMES) {
            expect(inferencer.env.has(name)).toBe(true);
        }
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
        // Without the prelude, only the native builtin names are visible.
        const coreUse = checkProject(
            [parsedModule('q = filter (u => true) (table "users")')],
            { requireQuery: false },
        );
        expect(coreUse.diagnostics).toEqual([]);
        expect(coreUse.value.kind).toBe('query');

        // Prelude-derived helpers (not builtins) disappear without the prelude.
        const helperUse = checkProject(
            [parsedModule('q = is_nothing')],
            { requireQuery: false },
        );
        expect(helperUse.diagnostics.map(d => d.message).join('\n')).toContain("unknown identifier 'is_nothing'");
    });
});

describe('list namespace', () => {
    test('every list.* member maps to a real backend builtin', () => {
        const env = createPreludeEnv();
        const list = env.get('list');
        const listNamespace = PRELUDE_NAMESPACES.list ?? {};
        expect(list?.kind).toBe('module');
        if (!list || list.kind !== 'module') return;
        for (const [publicName, builtinName] of Object.entries(listNamespace)) {
            expect(list.exports.has(publicName)).toBe(true);
            expect(Object.keys(BUILTINS)).toContain(builtinName);
            expect(BUILTIN_NAMES).toContain(builtinName);
        }
    });

    test('list.* resolves and evaluates as pure in-memory list operations', () => {
        expect(checked('main = (list.sum) [1, 2, 3]', { requireQuery: false }).diagnostics).toEqual([]);
        expect(checked('main = (list.length) [1, 2, 3]', { requireQuery: false }).diagnostics).toEqual([]);
        expect(checked('main = (list.product) [2, 3, 4]', { requireQuery: false }).diagnostics).toEqual([]);
        expect(checked('main = (list.reverse) [1, 2, 3]', { requireQuery: false }).diagnostics).toEqual([]);
        expect(checked('main = (list.head) [1, 2, 3]', { requireQuery: false }).diagnostics).toEqual([]);
        expect(checked('main = (list.elem) 2 [1, 2, 3]', { requireQuery: false }).diagnostics).toEqual([]);
        expect(checked('main = (list.map) (x => x + 1) [1, 2, 3]', { requireQuery: false }).diagnostics).toEqual([]);
        expect(checked('xs = [1, 2, 3]\nmain = (list.fold) (acc => x => acc + x) 0 xs', { requireQuery: false }).diagnostics).toEqual([]);
        expect(checked('main = (list.isEmpty) []', { requireQuery: false }).diagnostics).toEqual([]);
    });

    test('list.* coexists with the unqualified SQL vocabulary (no overwrite)', () => {
        const env = createPreludeEnv();
        const list = env.get('list');
        expect(list?.kind).toBe('module');
        if (!list || list.kind !== 'module') return;
        // The unqualified query steps and scalar builtins stay in place —
        // `map`/`filter`/`take`/`drop`/`reverse`/`concat`/`sum` remain the
        // relational/SQL words — and the namespace adds the pure list
        // spellings without replacing them. (`length` moved from a core
        // builtin to a prelude export; it is covered below.)
        for (const name of ['map', 'filter', 'take', 'drop', 'reverse', 'concat', 'sum']) {
            expect(env.has(name)).toBe(true);
            expect(env.get(name)).not.toBe(list.exports.get(name));
        }
        // And every list.* public spelling resolves through the namespace.
        const listNamespace = PRELUDE_NAMESPACES.list ?? {};
        for (const publicName of Object.keys(listNamespace)) {
            expect(list.exports.has(publicName)).toBe(true);
        }
        // `length` is no longer a core builtin — it is a prelude export that
        // still resolves unqualified (list.length stays the namespace form).
        expect(env.has('length')).toBe(false);
        expect(standardPreludeNames(services)).toContain('length');
    });

    test('a pipeline can mix list.* and the relational query steps without collision', () => {
        const result = checked(`
            users: query { id: int, age: int } = table "users"
            q = users
                & filter (u => u.age >= 18)
                & map (u => { id = u.id, age = u.age })
        `);
        expect(result.diagnostics).toEqual([]);
        expect(result.value.kind).toBe('query');

        // list.* is pure in-memory and usable in an ordinary binding.
        const pure = checked(`
            users: query { id: int } = table "users"
            total = (list.fold) (acc => x => acc + x) 0 [1, 2, 3]
            q = users & take 1 & map (u => { id = u.id, n = total })
        `);
        expect(pure.diagnostics).toEqual([]);
        expect(pure.value.kind).toBe('query');
    });
});

describe('Maybe namespace', () => {
    test('every Maybe.* member maps to a real backend builtin', () => {
        const env = createPreludeEnv();
        const maybe = env.get('Maybe');
        expect(maybe?.kind).toBe('module');
        if (!maybe || maybe.kind !== 'module') return;
        for (const [publicName, builtinName] of Object.entries(MAYBE_NAMESPACE)) {
            expect(maybe.exports.has(publicName)).toBe(true);
            expect(Object.keys(BUILTINS)).toContain(builtinName);
            expect(BUILTIN_NAMES).toContain(builtinName);
        }
    });

    test('Maybe.* resolves and types like the Data.Maybe vocabulary', () => {
        expect(checked('main = (Maybe.just) 1', { requireQuery: false }).diagnostics).toEqual([]);
        expect(checked('main = (Maybe.isJust) (just 1)', { requireQuery: false }).diagnostics).toEqual([]);
        expect(checked('main = (Maybe.isNothing) nothing', { requireQuery: false }).diagnostics).toEqual([]);
        expect(checked('main = (Maybe.fromMaybe) 0 nothing', { requireQuery: false }).diagnostics).toEqual([]);
    });

    test('Maybe.* coexists with the unqualified maybe builtins', () => {
        const env = createPreludeEnv();
        const maybe = env.get('Maybe');
        expect(maybe?.kind).toBe('module');
        if (!maybe || maybe.kind !== 'module') return;
        for (const name of ['just', 'nothing', 'is_null', 'from_maybe']) {
            expect(env.has(name)).toBe(true);
            expect(env.get(name)).not.toBe(maybe.exports.get(name));
        }
    });

    test('Maybe.* works in a query predicate', () => {
        const result = checked(`
            users: query { id: int, nickname: (maybe string) } = table "users"
            q = users & filter (u => (Maybe.isJust) u.nickname)
        `);
        expect(result.diagnostics).toEqual([]);
        expect(result.value.kind).toBe('query');
    });
});
