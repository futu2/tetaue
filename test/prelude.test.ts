import { describe, expect, test } from 'bun:test';
import { NodeFileSystem } from 'langium/node';
import { readFileSync } from 'node:fs';
import { createTetaueServices } from '../src/language/tetaue-module.js';
import { standardPrelude, standardPreludeNames, STANDARD_PRELUDE_SOURCE } from '../src/language/prelude.js';
import { BUILTINS } from '../src/language/interpreter.js';
import { checkProject } from '../src/language/checker.js';
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

describe('standard prelude', () => {
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
        expect(plus?.export).toBe(true);
        expect(plus?.$cstNode?.text).toBe('export _+_ = __op_add');
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
});
