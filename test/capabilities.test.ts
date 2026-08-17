import { describe, expect, test } from 'bun:test';
import { analyze } from '../src/language/interpreter.ts';
import { checkDialectCapabilities } from '../src/language/capabilities.ts';
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

describe('dialect capability preflight', () => {
    test('scalar function lowerings do not produce capability diagnostics', () => {
        const query = queryOf(`
            users: query { name: string } = table "users"
            q = users & map (u => { reversed = reverse u.name })
        `);
        const diagnostics = checkDialectCapabilities(query, DIALECTS.sqlite!);
        expect(diagnostics).toEqual([]);

        const result = renderQuery(query, DIALECTS.sqlite!);
        expect(result.ok).toBe(true);
    });

    test('checks date fallbacks and set/join capabilities in one traversal', () => {
        const dateQuery = queryOf(`
            events: query { happened: date, amount: int } = table "events"
            q = events & map (e => { shifted = date_add e.happened "day" e.amount })
        `);
        expect(checkDialectCapabilities(dateQuery, DIALECTS.sqlite!)).toEqual([]);

        const joinQuery = queryOf(`
            users: query { id: int } = table "users"
            orders: query { user_id: int } = table "orders"
            q = users & joinFull orders (u => o => u.id == o.user_id) (u => o => { id = u.id })
        `);
        expect(checkDialectCapabilities(joinQuery, DIALECTS.mysql!).map(d => d.message)).toEqual([
            'full join is not supported for the mysql dialect',
        ]);
    });
});
