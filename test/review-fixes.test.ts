import { describe, expect, test } from 'bun:test';
import { render, errors } from './helpers.ts';

// Regression tests for issues found in review: silent invalid/wrong SQL.
describe('derived columns (review fixes)', () => {
    test('filter after map inlines the defining expression (valid postgres SQL)', () => {
        const sql = render(`
            users = table "users" { id = int, age = int }
            q = users & map (u => { a = u.age }) & filter (r => r.a > 18)
        `, 'postgresql');
        expect(sql).toBe([
            'SELECT "age" AS "a"',
            'FROM "users"',
            'WHERE ("age" > 18)',
        ].join('\n'));
    });

    test('chained map projects the final expression, not a phantom alias', () => {
        const sql = render(`
            users = table "users" { id = int, age = int }
            q = users & map (u => { a = u.age }) & map (u => { b = u.a })
        `);
        expect(sql).toBe([
            'SELECT "age" AS "b"',
            'FROM "users"',
        ].join('\n'));
    });

    test('sort after map inlines', () => {
        const sql = render(`
            users = table "users" { id = int, age = int }
            q = users & map (u => { a = u.age }) & sort (r => desc r.a)
        `);
        expect(sql).toContain('ORDER BY "age" DESC');
    });

    test('join after map inlines the left expression', () => {
        const sql = render(`
            users = table "users" { id = int }
            orders = table "orders" { user_id = int }
            q = users
                & map (u => { a = u.id })
                & join { right = orders, on = (u, o) => u.a == o.user_id }
        `);
        expect(sql).toContain('ON "users"."id" = "orders"."user_id"');
    });

    test('fold after map inlines the mapped columns', () => {
        const sql = render(`
            orders = table "orders" { user_id = int, total = int }
            q = orders
                & map (o => { uid = o.user_id, amount = o.total })
                & fold (r => { uid = group r.uid, total = sum r.amount })
        `);
        expect(sql).toContain('SUM("total") AS "total"');
        expect(sql).toContain('GROUP BY "user_id"');
    });
});

describe('aggregation edges (review fixes)', () => {
    test('filter after fold renders HAVING, not WHERE', () => {
        const sql = render(`
            orders = table "orders" { user_id = int, total = int }
            q = orders
                & fold (o => { user_id = group o.user_id, total = sum o.total })
                & filter (r => r.total > 100)
        `);
        expect(sql).toBe([
            'SELECT "user_id", SUM("total") AS "total"',
            'FROM "orders"',
            'GROUP BY "user_id"',
            'HAVING (SUM("total") > 100)',
        ].join('\n'));
    });

    test('filter before fold stays in WHERE', () => {
        const sql = render(`
            orders = table "orders" { user_id = int, total = int }
            q = orders
                & filter (o => o.total > 0)
                & fold (o => { user_id = group o.user_id, total = sum o.total })
        `);
        expect(sql).toContain('WHERE ("total" > 0)');
        expect(sql).toContain('GROUP BY "user_id"');
        expect(sql).not.toContain('HAVING');
    });

    test('sort after fold may order by an aggregate', () => {
        const sql = render(`
            orders = table "orders" { user_id = int, total = int }
            q = orders
                & fold (o => { user_id = group o.user_id, total = sum o.total })
                & sort (r => [desc r.total])
        `);
        expect(sql).toContain('ORDER BY SUM("total") DESC');
    });

    test('only one fold per pipeline', () => {
        const messages = errors(`
            orders = table "orders" { user_id = int, total = int }
            q = orders
                & fold (o => { total = sum o.total })
                & fold (o => { total = sum o.total })
        `);
        expect(messages.join('\n')).toContain('only one fold per pipeline');
    });

    test('map after fold is rejected', () => {
        const messages = errors(`
            orders = table "orders" { user_id = int, total = int }
            q = orders
                & fold (o => { total = sum o.total })
                & map (r => { t = r.total })
        `);
        expect(messages.join('\n')).toContain('cannot apply map after fold');
    });

    test('join after fold is rejected', () => {
        const messages = errors(`
            orders = table "orders" { user_id = int, total = int }
            users = table "users" { id = int }
            q = orders
                & fold (o => { user_id = group o.user_id, total = sum o.total })
                & join { right = users, on = (o, u) => o.user_id == u.id }
        `);
        expect(messages.join('\n')).toContain('cannot apply join after fold');
    });

    test('empty map projection is rejected', () => {
        const messages = errors(`
            users = table "users" { id = int }
            q = users & map (u => {})
        `);
        expect(messages.join('\n')).toContain('must contain at least one field');
    });
});

describe('self-joins (review fix)', () => {
    test('duplicate table names get unique aliases', () => {
        const sql = render(`
            a = table "users" { id = int }
            b = table "users" { uid = int }
            q = a & join { right = b, on = (l, r) => l.id == r.uid }
        `);
        expect(sql).toContain('INNER JOIN "users" AS "users_1" ON "users"."id" = "users_1"."uid"');
    });

    test('the bound table value is not mutated by aliasing', () => {
        // Two independent joins of the same binding: the second must not
        // inherit the first join's alias.
        const sql = render(`
            users = table "users" { id = int }
            orders = table "orders" { user_id = int }
            q1 = users & join { right = orders, on = (u, o) => u.id == o.user_id }
            q2 = users & join { right = orders, on = (u, o) => u.id == o.user_id }
        `);
        expect(sql).toContain('INNER JOIN "orders" ON');
        expect(sql).not.toContain('orders_1');
    });
});

describe('string escapes (review fix)', () => {
    test('unknown escape sequences are preserved verbatim', () => {
        const src = `
            users = table "users" { id = int, name = string }
            q = users & filter (u => u.name == "C:\\Users\\bob")
        `;
        // sqlite/postgres: backslash is a literal character inside the literal
        expect(render(src, 'sqlite')).toContain(`'C:\\Users\\bob'`);
        expect(render(src, 'postgresql')).toContain(`'C:\\Users\\bob'`);
        // mysql: backslash is the escape character, so it must be doubled
        expect(render(src, 'mysql')).toContain(`'C:\\\\Users\\\\bob'`);
    });

    test('known escapes still decode', () => {
        const sql = render(`
            users = table "users" { id = int, name = string }
            q = users & filter (u => u.name == "a\\nb\\t\\"q\\"")
        `);
        expect(sql).toContain(`'a\nb\t"q"'`);
    });
});
