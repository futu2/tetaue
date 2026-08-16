import { describe, expect, test } from 'bun:test';
import { analyze, evalExpr, BUILTINS, type Value } from '../src/language/interpreter.ts';
import { collectModuleTree } from '../src/language/imports.ts';
import { renderQuery, renderQueryWithCtes, DIALECTS } from '../src/language/render.ts';
import { allErrors, parseModel, render, typeErrors } from './helpers.ts';

describe('pure evaluation API', () => {
    test('evalExpr returns diagnostics instead of mutating shared state', () => {
        const valid = parseModel(`users: query { id: int } = table "users"\nq = users & take 1`);
        const analyzed = analyze(valid);
        expect(analyzed.value.kind).toBe('query');
        if (analyzed.value.kind !== 'query') return;

        const env = new Map<string, Value>(Object.entries(BUILTINS).map(([name, factory]) => [name, factory()]));
        env.set('users', analyzed.value);
        const ok = evalExpr(valid.bindings[1]!.value, env, new Set(['users', 'q']));
        expect(ok.ok).toBe(true);
        if (ok.ok) expect(ok.value.kind).toBe('query');

        const badModel = parseModel(`users: query { id: int } = table "users"\nq = users & filter (u => u.id == "x")`);
        const bad = evalExpr(badModel.bindings[1]!.value, env, new Set(['users', 'q']));
        expect(bad.ok).toBe(false);
        expect(bad.diagnostics.map(d => d.message).join('\n')).toContain('cannot compare int with string');
    });

    test('renderQuery returns capability errors as data', () => {
        const model = parseModel(`users: query { name: string } = table "users"\nq = users & map (u => { v = reverse u.name })`);
        const { value } = analyze(model);
        expect(value.kind).toBe('query');
        if (value.kind !== 'query') return;
        const result = renderQuery(value.query, DIALECTS.sqlite!);
        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.diagnostics.map(d => d.message).join('\n')).toContain('reverse is not supported for the sqlite dialect');
        }
    });

    test('collectModuleTree does not mutate the caller root imports', () => {
        const model = parseModel('q = 1');
        const root = { model, uri: 'main.tetaue', imports: [] as never[] };
        const tree = collectModuleTree(root, {
            resolve: () => ({ uri: undefined, searched: [] }),
            read: () => undefined,
            parse: () => parseModel('q = 2'),
        });
        expect(tree.modules.length).toBe(1);
        expect(tree.importsByModule.get(tree.modules[0]!) ?? []).toEqual([]);
        expect(tree.modules[0]).not.toBe(root);
    });
});

const USERS_A = `a: query { id: int, name: string } = table "a"`;
const USERS_B = `b: query { id: int, name: string } = table "b"`;

describe('opt-in CTE rendering', () => {
    test('named intermediates can render as WITH clauses', () => {
        const src = `users: query { id: int } = table \"users\"\norders: query { id: int, user_id: int } = table \"orders\"\npaid = orders & filter (o => o.id > 0)\nq = users & join inner paid (u => o => u.id == o.user_id) (u => o => { uid = u.id, oid = o.id })`;
        const model = parseModel(src);
        const { value } = analyze(model);
        expect(value.kind).toBe('query');
        if (value.kind !== 'query') return;
        const result = renderQueryWithCtes(value.query, DIALECTS.postgresql!);
        expect(result.ok).toBe(true);
        if (result.ok) {
            expect(result.sql).toContain('WITH paid AS (');
            expect(result.sql).toContain('INNER JOIN paid');
        }
    });
});

describe('pure set combinators', () => {
    test('union/intersect/except render SQL set operations', () => {
        expect(render(`${USERS_A}\n${USERS_B}\nq = a & union b`, 'postgresql')).toContain('UNION');
        expect(render(`${USERS_A}\n${USERS_B}\nq = a & union_all b`, 'postgresql')).toContain('UNION ALL');
        expect(render(`${USERS_A}\n${USERS_B}\nq = a & intersect b`, 'postgresql')).toContain('INTERSECT');
        expect(render(`${USERS_A}\n${USERS_B}\nq = a & except b`, 'postgresql')).toContain('EXCEPT');
    });

    test('set operands are projected in a shared explicit column order', () => {
        const sql = render(
            `a: query { id: int, name: string } = table "a"
             b: query { name: string, id: int } = table "b"
             q = a & union_all b`,
            'postgresql',
        );
        expect(sql).toContain('SELECT id, name');
        expect(sql.startsWith('SELECT id, name')).toBe(true);
    });

    test('dialect join capabilities are enforced', () => {
        const src = `a: query { id: int } = table "a"
b: query { id: int } = table "b"
q = a & join full b (l => r => l.id == r.id) (l => r => { id = l.id })`;
        expect(() => render(src, 'mysql')).toThrow(/full join is not supported/);
        expect(render(src, 'postgresql')).toContain('FULL JOIN');
    });

    test('set operand schemas must unify', () => {
        expect(allErrors(`${USERS_A}\nb: query { id: int, age: int } = table "b"\nq = a & union b`).join('\n')).toContain('cannot apply');
    });

    test('steps after a set run on the combined result', () => {
        const sql = render(`${USERS_A}\n${USERS_B}\nq = a & union_all b & sort (r => [asc r.id])`, 'postgresql');
        expect(sql).toContain('UNION ALL');
        expect(sql).toContain('ORDER BY id ASC');
    });
});

describe('record update sugar', () => {
    test('{ row | k = v } is merge row { k = v }', () => {
        const sql = render(`users: query { id: int, name: string } = table "users"\nq = users & map (u => { u | active = u.id > 0 })`, 'postgresql');
        expect(sql).toContain('id > 0 AS active');
        expect(sql).toContain('id');
        expect(sql).toContain('name');
    });

    test('select [columns] narrows a projection', () => {
        const src = `t: query { id: int, name: string, secret: string } = table "t"\nq = t & select ["id", "name"] & filter (u => u.id > 0)`;
        const sql = render(src, 'postgresql', 'compact');
        expect(sql).toBe('SELECT id, name FROM t WHERE id > 0');
        expect(typeErrors(src)).toEqual([]);
    });

    test('select validates its column list', () => {
        expect(allErrors(`t: query { id: int } = table "t"\nq = t & select ["id", "id"]`).join('\n')).toContain("duplicate column 'id' in select");
        expect(allErrors(`t: query { id: int } = table "t"\nq = t & select []`).join('\n')).toContain('at least one column');
    });

    test('field punning: { id, name } is { id = u.id, name = u.name }', () => {
        const sql = render(`t: query { id: int, name: string } = table "t"\nq = t & map (u => { id, name }) & take 1`, 'postgresql');
        expect(sql).toContain('id');
        expect(sql).toContain('name');
        const bad = allErrors('q = { id }');
        expect(bad.join('\n')).toContain("field pun 'id' requires an enclosing lambda parameter");
    });

    test('record update rejects non-records consistently', () => {
        const messages = allErrors('q = { 1 | x = 2 }');
        expect(messages).toEqual(["record update expects a record before '|', got type int"]);
    });
});
