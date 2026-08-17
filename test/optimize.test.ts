import { describe, expect, test } from 'bun:test';
import { analyze } from '../src/language/interpreter.ts';
import { optimizeQuery } from '../src/language/optimize.ts';
import { DIALECTS, renderQuery } from '../src/language/render.ts';
import { standardPrelude } from '../src/language/prelude.ts';
import { parseModel, services } from './helpers.ts';

function queryOf(source: string) {
    const result = analyze(parseModel(source), standardPrelude(services));
    expect(result.diagnostics).toEqual([]);
    expect(result.value.kind).toBe('query');
    if (result.value.kind !== 'query') throw new Error('expected query');
    return result.value.query;
}

describe('pure query optimization', () => {
    test('fuses adjacent filters without mutating the source query', () => {
        const query = queryOf(`
            users: query { id: int, active: bool } = table "users"
            q = users
                & filter (u => u.active)
                & filter (u => u.id > 0)
        `);

        const normalized = optimizeQuery(query);
        expect(query.steps.filter(step => step.kind === 'filter')).toHaveLength(2);
        expect(normalized.steps.filter(step => step.kind === 'filter')).toHaveLength(1);
        expect(optimizeQuery(normalized)).toBe(normalized);

        const rendered = renderQuery(normalized, DIALECTS.postgresql!, 'compact');
        expect(rendered).toEqual({
            ok: true,
            sql: 'SELECT * FROM users WHERE active AND id > 0',
            parameters: [],
        });
    });

    test('simplifies boolean identities with SQL three-valued semantics', () => {
        const query = queryOf(`
            users: query { active: bool } = table "users"
            q = users & filter (u => (u.active && true))
        `);

        const rendered = renderQuery(query, DIALECTS.postgresql!, 'compact');
        expect(rendered).toEqual({
            ok: true,
            sql: 'SELECT * FROM users WHERE active',
            parameters: [],
        });
    });

    test('normalizes negated null predicates', () => {
        const query = queryOf(`
            users: query { name: (maybe string) } = table "users"
            q = users & filter (u => not (is_null u.name))
        `);

        const rendered = renderQuery(query, DIALECTS.postgresql!, 'compact');
        expect(rendered).toEqual({
            ok: true,
            sql: 'SELECT * FROM users WHERE name IS NOT NULL',
            parameters: [],
        });
    });

    test('combines adjacent offsets while retaining the source query', () => {
        const query = queryOf(`
            users: query { id: int } = table "users"
            q = users & drop 2 & drop 3
        `);

        const normalized = optimizeQuery(query);
        expect(query.steps.filter(step => step.kind === 'drop')).toHaveLength(2);
        const drops = normalized.steps.filter((step): step is Extract<typeof normalized.steps[number], { kind: 'drop' }> => step.kind === 'drop');
        expect(drops).toHaveLength(1);
        expect(drops[0]!.n).toBe(5);
    });
});
