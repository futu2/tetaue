import { describe, expect, test } from 'bun:test';
import { NodeFileSystem } from 'langium/node';
import { readFileSync } from 'node:fs';
import { createTetaueServices } from '../src/language/tetaue-module.js';
import {
    standardPrelude,
    standardPreludeNames,
    baseLibraryModules,
    baseModuleSource,
    baseLibraryOptions,
} from '../src/language/prelude.js';
import { BUILTINS, createPreludeEnv } from '../src/language/interpreter.js';
import { BUILTIN_NAMES } from '../src/language/builtin.js';
import { MAYBE_NAMESPACE, PRELUDE_NAMESPACES } from '../src/language/prelude-namespaces.js';
import { checkProject } from '../src/language/checker.js';
import { Inferencer } from '../src/language/inference.js';
import type { Model } from '../src/language/generated/ast.js';
import { allErrors, render, typeErrors } from './helpers.js';

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

    test('the files under base/ are the source of truth for the embedded library', () => {
        // The library is edited as real files and embedded by
        // `bun run base:generate`; a stale embed is the one failure mode, so
        // every module is compared against its file.
        for (const path of ['prelude.tetaue', 'sql.tetaue', 'sql/time.tetaue', 'data/function.tetaue', 'data/maybe.tetaue']) {
            const file = readFileSync(new URL(`../base/${path}`, import.meta.url), 'utf8');
            expect(baseModuleSource(path), path).toBe(file);
        }
    });

    test('the base library is a real module tree, in dependency order', () => {
        const modules = baseLibraryModules(services);
        const uris = modules.map(m => m.uri);
        expect(new Set(uris)).toEqual(new Set([
            'base/prelude.tetaue',
            'base/sql.tetaue',
            'base/sql/time.tetaue',
            'base/data/function.tetaue',
            'base/data/maybe.tetaue',
        ]));
        // Every module comes AFTER everything it imports or re-exports, so
        // the checker always sees a target's exports before the module that
        // uses them; the Prelude is the aggregation point and comes last.
        const position = new Map(uris.map((uri, i) => [uri, i]));
        for (const module of modules) {
            for (const edge of [...(module.imports ?? []), ...(module.exports ?? [])]) {
                expect(position.get(edge.target.uri!), `${module.uri} -> ${edge.target.uri}`)
                    .toBeLessThan(position.get(module.uri!)!);
            }
        }
        expect(uris[uris.length - 1]).toBe('base/prelude.tetaue');
        // The Prelude is an aggregator: it re-exports the other modules.
        expect(standardPrelude(services).model.exports.map(e => e.path).sort()).toEqual([
            '"./data/function.tetaue"',
            '"./data/maybe.tetaue"',
            '"./sql.tetaue"',
            '"./sql/time.tetaue"',
        ]);
    });

    test('is ordinary tetaue and is checked by the shared pass', () => {
        const result = checked('q = table "users" & map (((u => { name = toUpper u.name }) <<< id))');
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
        expect(plus?.$cstNode?.text).toBe('export _+_ = sql.sql_add');
        expect(forward?.$cstNode?.text).toBe('export _>>>_ = fn.compose');
        expect(pipeline?.$cstNode?.text).toBe('export _&_ = x => f => f x');
        expect(apply?.$cstNode?.text).toBe('export _$_ = fn.apply');
        expect(fmap?.$cstNode?.text).toBe('export _<$>_ = fmap');
        expect(alternative?.$cstNode?.text).toBe('export _<|>_ = orElse');
        expect(bind?.$cstNode?.text).toBe('export _>>=_ = bind');
        const core = createPreludeEnv();
        expect(core.has('op_compose_forward')).toBe(false);
        expect(core.has('op_pipeline')).toBe(false);
        expect(core.has('op_apply')).toBe(false);
    });

    test('the primitive core is reachable only from base modules', () => {
        // The primitive env still holds every builtin under its plain name —
        // that is what base modules are evaluated against.
        const core = createPreludeEnv();
        expect(core.has('filter')).toBe(true);
        expect(core.has('table')).toBe(true);
        expect(core.has('int')).toBe(false); // types are not runtime values
        // ... and under the reserved `core` namespace, so a base module can
        // publish a public spelling without a self-recursive binding.
        const coreNs = core.get('core');
        expect(coreNs?.kind).toBe('module');

        const inferencer = new Inferencer();
        inferencer.prelude();
        for (const name of BUILTIN_NAMES) {
            expect(inferencer.env.has(name)).toBe(true);
        }
    });

    test('the SQL surface is exported by the library, not injected by the checker', () => {
        // `table`/`filter`/`map`/... are ordinary exported bindings of
        // base/sql.tetaue that the Prelude re-exports — not names the checker
        // sprinkles into every module.
        const names = standardPreludeNames(services);
        for (const name of ['table', 'filter', 'map', 'take', 'union', 'joinInner', 'count', 'asc']) {
            expect(names, name).toContain(name);
        }
        // The lowering primitives stay library-internal.
        for (const name of ['sql_func', 'sql_infix', 'sql_cast', 'sql_try_cast', 'sql_bare', 'sql_dialect', 'op_add']) {
            expect(names, name).not.toContain(name);
        }
    });

    test('a module without the Prelude cannot reach the primitives', () => {
        // `# no prelude` leaves the module with nothing auto-imported, so the
        // SQL surface is gone with it.
        const module = { ...parsedModule('# no prelude\nq = table "users"'), noPrelude: true };
        const result = checkProject([module], { requireQuery: false, prelude: standardPrelude(services) });
        expect(result.diagnostics.map(d => d.message).join('\n')).toContain("unknown identifier 'table'");
    });

    test('defines derived helpers outside the primitive builtin table', () => {
        const names = standardPreludeNames(services);
        for (const name of ['isNothing', 'isJust', 'isNotNull']) {
            expect(names).toContain(name);
            expect(Object.keys(BUILTINS)).not.toContain(name);
        }
        expect(names).not.toContain('filtered');

        const result = checked(`
            users: query { name: (maybe string) } = table "users"
            q = users & filter (u => isJust u.name && isNotNull u.name && isNothing nothing)
        `);
        expect(result.diagnostics).toEqual([]);
        expect(result.value.kind).toBe('query');
    });

    test('prelude definitions can be shadowed like ordinary bindings', () => {
        const result = checked('id = x => { local = x.id }\nq = table "users" & map id');
        expect(result.diagnostics).toEqual([]);
        expect(result.value.kind).toBe('query');
    });

    test('cast helpers fix the target type, so a cast reads as a unary function', () => {
        const names = standardPreludeNames(services);
        for (const name of [
            'asInt', 'asFloat', 'asDecimal', 'asString', 'asBool', 'asDate', 'asTimestamp',
            'asIntOrNull', 'asFloatOrNull', 'asDecimalOrNull', 'asStringOrNull',
            'asBoolOrNull', 'asDateOrNull', 'asTimestampOrNull',
        ]) {
            expect(names, name).toContain(name);
            expect(Object.keys(BUILTINS), name).not.toContain(name);
        }
        // `tryCast` itself is a primitive now, so it stays out of the
        // derived-helper set but is published by the library.
        expect(names).toContain('tryCast');

        const result = checked(`
            users: query { id: int, name: string, balance: float, joined: string } = table "users"
            q = users & map (u => {
                i = asInt u.name,
                s = asString u.id,
                f = asFloat u.balance,
                b = asBool u.name,
                d = asDate u.joined,
                ts = asTimestamp u.joined,
                dec = asDecimal u.balance,
            })
        `);
        expect(result.diagnostics).toEqual([]);
        expect(result.value.kind).toBe('query');
    });

    test('each cast helper pins its own target type, not one shared instance', () => {
        // The helpers are written out per definition rather than sharing an
        // `asImpl` helper: a shared helper is monomorphic at its definition
        // site, which would make all but the first target type a mismatch.
        const source = (target: string) => `
            users: query { id: int, name: string } = table "users"
            q = users & map (u => { v = as_${target} u.name })
        `;
        for (const target of ['int', 'float', 'decimal', 'string', 'bool', 'date', 'timestamp']) {
            expect(typeErrors(source(target)), target).toEqual([]);
        }
    });

    test('as_*_or_null renders NULL-on-failure, tryCast on dialects that have it', () => {
        const source = `
            users: query { name: string } = table "users"
            q = users & map (u => { i = asIntOrNull u.name })
        `;
        expect(render(source, 'postgresql')).toContain('TRY_CAST(name AS INTEGER)');
        // SQLite has no TRY_CAST, so the fallback detects the lossy conversion.
        const sqlite = render(source, 'sqlite');
        expect(sqlite).toContain('CASE WHEN');
        expect(sqlite).toContain('ELSE NULL END');
    });

    test('the Prelude controls the public surface', () => {
        // Without the Prelude the SQL surface is gone with it: `table` and
        // `filter` are ordinary exported bindings of the library, not names
        // an ambient environment supplies. Only the always-available
        // namespaces (`list.*`, `Maybe.*`) remain.
        const coreUse = checkProject(
            [parsedModule('q = filter (u => true) (table "users")')],
            { requireQuery: false },
        );
        const coreMessages = coreUse.diagnostics.map(d => d.message).join('\n');
        expect(coreMessages).toContain("unknown identifier 'filter'");
        expect(coreMessages).toContain("unknown identifier 'table'");

        // Library-derived helpers disappear with it too.
        const helperUse = checkProject(
            [parsedModule('q = isNothing')],
            { requireQuery: false },
        );
        expect(helperUse.diagnostics.map(d => d.message).join('\n')).toContain("unknown identifier 'isNothing'");
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
        for (const name of ['just', 'nothing', 'isNull', 'fromMaybe']) {
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

// ---------------------------------------------------------------------------
// Name overloading
//
// A name may be bound to several definitions told apart by type. This is what
// lets the standard library express "numeric" WITHOUT a compiler-owned class:
// `abs`/`ceil`/`floor`/`pow` each name one definition per numeric type, and the
// argument's type selects it.
// ---------------------------------------------------------------------------

describe('name overloading', () => {
    test('a name may carry one definition per numeric type', () => {
        for (const num of ['int', 'float', 'decimal']) {
            const source = `t: query { a: ${num} } = table "t"
q = t & map (r => { c = abs r.a, d = ceil r.a, e = floor r.a, f = pow r.a 2 })`;
            expect(typeErrors(source)).toEqual([]);
            expect(render(source, 'sqlite')).toContain('ABS(a)');
        }
    });

    test('an overloaded name rejects an argument no definition accepts', () => {
        const source = `t: query { a: string } = table "t"
q = t & map (r => { c = abs r.a })`;
        // The mismatch names the overload's expected parameter, not the whole
        // overload set — the point of keeping the alternatives distinct.
        expect(typeErrors(source).join('\n')).toContain("'abs' expects int as argument 1, got string");
    });

    test('the right alternative is chosen at render time, not just by the checker', () => {
        // `pow` on a float column must render the same call as on an int one;
        // what differs is which overload the renderer picked.
        const float = `t: query { a: float } = table "t"
q = t & map (r => { c = pow r.a 2 })`;
        expect(render(float, 'sqlite')).toContain('POW(a, 2)');
    });

    test('a user definition shadows the prelude rather than joining its overloads', () => {
        // `abs u.name` must fail even though the prelude defines `abs`: the
        // local definition is the only `abs` in scope here.
        const source = `abs = x => x
t: query { a: string } = table "t"
q = t & map (r => { c = abs r.a })`;
        expect(typeErrors(source)).toEqual([]);
    });

    test('a repeated non-callable binding is still a duplicate, not an overload', () => {
        // Two queries named the same have no argument type to choose between.
        const source = `users: query { id: int } = table "a"
users: query { id: int } = table "b"
q = users`;
        expect(allErrors(source).join('\n')).toContain("duplicate binding name 'users'");
    });
});
