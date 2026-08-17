import { describe, expect, test } from 'bun:test';
import { render, errors } from './helpers.ts';

// Regression tests for issues found in review: silent invalid/wrong SQL.
describe('derived columns (review fixes)', () => {
    test('filter after map inlines the defining expression (valid postgres SQL)', () => {
        const sql = render(`
            users: query { id: int, age: int } = table "users"
            q = users & map (u => { a = u.age }) & filter (r => r.a > 18)
        `, 'postgresql');
        expect(sql).toBe([
            'SELECT age AS a',
            'FROM users',
            'WHERE age > 18',
        ].join('\n'));
    });

    test('chained map projects the final expression, not a phantom alias', () => {
        const sql = render(`
            users: query { id: int, age: int } = table "users"
            q = users & map (u => { a = u.age }) & map (u => { b = u.a })
        `);
        expect(sql).toBe([
            'SELECT age AS b',
            'FROM users',
        ].join('\n'));
    });

    test('sort after map inlines', () => {
        const sql = render(`
            users: query { id: int, age: int } = table "users"
            q = users & map (u => { a = u.age }) & sort (r => desc r.a)
        `);
        expect(sql).toContain('ORDER BY age DESC');
    });

    test('join after map inlines the left expression', () => {
        const sql = render(`
            users: query { id: int } = table "users"
            orders: query { user_id: int } = table "orders"
            q = users
                & map (u => { a = u.id })
                & joinInner orders (u => o => u.a == o.user_id) (u => o => { a = u.a, oid = o.user_id })
        `);
        expect(sql).toContain('ON users.id = orders.user_id');
    });

    test('fold after map inlines the mapped columns', () => {
        const sql = render(`
            orders: query { user_id: int, total: int } = table "orders"
            q = orders
                & map (o => { uid = o.user_id, amount = o.total })
                & fold (r => { uid = group r.uid, total = sum r.amount })
        `);
        expect(sql).toContain('SUM(total) AS total');
        expect(sql).toContain('GROUP BY user_id');
    });
});

describe('aggregation edges (review fixes)', () => {
    test('filter after fold renders HAVING, not WHERE', () => {
        const sql = render(`
            orders: query { user_id: int, total: int } = table "orders"
            q = orders
                & fold (o => { user_id = group o.user_id, total = sum o.total })
                & filter (r => r.total > 100)
        `);
        expect(sql).toBe([
            'SELECT',
            '    user_id,',
            '    SUM(total) AS total',
            'FROM orders',
            'GROUP BY user_id',
            'HAVING SUM(total) > 100',
        ].join('\n'));
    });

    test('filter before fold stays in WHERE', () => {
        const sql = render(`
            orders: query { user_id: int, total: int } = table "orders"
            q = orders
                & filter (o => o.total > 0)
                & fold (o => { user_id = group o.user_id, total = sum o.total })
        `);
        expect(sql).toContain('WHERE total > 0');
        expect(sql).toContain('GROUP BY user_id');
        expect(sql).not.toContain('HAVING');
    });

    test('sort after fold may order by an aggregate', () => {
        const sql = render(`
            orders: query { user_id: int, total: int } = table "orders"
            q = orders
                & fold (o => { user_id = group o.user_id, total = sum o.total })
                & sort (r => [desc r.total])
        `);
        expect(sql).toContain('ORDER BY SUM(total) DESC');
    });

    test('fold after fold aggregates the aggregated result via a subquery', () => {
        const sql = render(`
            orders: query { user_id: int, total: int } = table "orders"
            q = orders
                & fold (o => { user_id = group o.user_id, total = sum o.total })
                & fold (r => { grand = sum r.total })
        `);
        expect(sql).toBe([
            'SELECT SUM(total) AS grand',
            'FROM (',
            '    SELECT',
            '        user_id,',
            '        SUM(total) AS total',
            '    FROM orders',
            '    GROUP BY user_id',
            ') AS orders',
        ].join('\n'));
    });

    test('fold after fold keeps grouping keys of the derived table', () => {
        const sql = render(`
            orders: query { user_id: int, total: int } = table "orders"
            q = orders
                & fold (o => { user_id = group o.user_id, total = sum o.total })
                & fold (r => { tier = group r.user_id, grand = sum r.total })
        `);
        expect(sql).toBe([
            'SELECT',
            '    user_id AS tier,',
            '    SUM(total) AS grand',
            'FROM (',
            '    SELECT',
            '        user_id,',
            '        SUM(total) AS total',
            '    FROM orders',
            '    GROUP BY user_id',
            ') AS orders',
            'GROUP BY user_id',
        ].join('\n'));
    });

    test('sort by a nested-aggregate column after fold renders ORDER BY', () => {
        const sql = render(`
            orders: query { user_id: int, total: int } = table "orders"
            q = orders
                & fold (o => { user_id = group o.user_id, total = sum o.total })
                & map (r => { grand = sum r.total })
                & sort (r => [desc r.grand])
        `);
        expect(sql).toBe([
            'SELECT SUM(total) AS grand',
            'FROM (',
            '    SELECT',
            '        user_id,',
            '        SUM(total) AS total',
            '    FROM orders',
            '    GROUP BY user_id',
            ') AS orders',
            'ORDER BY SUM(total) DESC',
        ].join('\n'));
    });

    test('map after fold wraps the aggregation as a derived table', () => {
        const sql = render(`
            orders: query { user_id: int, total: int } = table "orders"
            q = orders
                & fold (o => { user_id = group o.user_id, total = sum o.total })
                & map (r => { t = r.total })
        `);
        expect(sql).toBe([
            'SELECT total AS t',
            'FROM (',
            '    SELECT',
            '        user_id,',
            '        SUM(total) AS total',
            '    FROM orders',
            '    GROUP BY user_id',
            ') AS orders',
        ].join('\n'));
    });

    test('map after fold supports nested aggregation via a subquery', () => {
        const sql = render(`
            orders: query { user_id: int, total: int } = table "orders"
            q = orders
                & fold (o => { user_id = group o.user_id, total = sum o.total })
                & map (r => { grand_total = sum r.total })
        `);
        expect(sql).toBe([
            'SELECT SUM(total) AS grand_total',
            'FROM (',
            '    SELECT',
            '        user_id,',
            '        SUM(total) AS total',
            '    FROM orders',
            '    GROUP BY user_id',
            ') AS orders',
        ].join('\n'));
    });

    test('filter on a nested-aggregate column renders HAVING', () => {
        const sql = render(`
            orders: query { user_id: int, total: int } = table "orders"
            q = orders
                & fold (o => { user_id = group o.user_id, total = sum o.total })
                & map (r => { grand_total = sum r.total })
                & filter (r => r.grand_total > 1000)
        `);
        expect(sql).toBe([
            'SELECT SUM(total) AS grand_total',
            'FROM (',
            '    SELECT',
            '        user_id,',
            '        SUM(total) AS total',
            '    FROM orders',
            '    GROUP BY user_id',
            ') AS orders',
            'HAVING SUM(total) > 1000',
        ].join('\n'));
    });

    test('join after fold wraps the aggregation as a derived table', () => {
        const sql = render(`
            orders: query { user_id: int, total: int } = table "orders"
            users: query { id: int } = table "users"
            q = orders
                & fold (o => { user_id = group o.user_id, total = sum o.total })
                & joinInner users (o => u => o.user_id == u.id) (o => u => { user_id = o.user_id, id = u.id })
        `);
        expect(sql).toBe([
            'SELECT',
            '    orders.user_id,',
            '    users.id',
            'FROM (',
            '    SELECT',
            '        user_id,',
            '        SUM(total) AS total',
            '    FROM orders',
            '    GROUP BY user_id',
            ') AS orders',
            'INNER JOIN users ON orders.user_id = users.id',
        ].join('\n'));
    });

    test('filter after a join-after-fold is a WHERE on the outer query', () => {
        const sql = render(`
            orders: query { user_id: int, total: int } = table "orders"
            users: query { id: int } = table "users"
            q = orders
                & fold (o => { user_id = group o.user_id, total = sum o.total })
                & joinInner users (o => u => o.user_id == u.id) (o => u => { user_id = o.user_id, id = u.id })
                & filter (r => is_in r.id [1, 2])
        `);
        expect(sql).toContain('WHERE users.id IN (1, 2)');
        expect(sql).not.toContain('HAVING');
    });

    test('join-after-fold with the merge merger and an is_in filter (lpbirthday pattern)', () => {
        const sql = render(`
            orders: query { user_id: int, total: int } = table "orders"
            users: query { id: int, name: string } = table "users"
            totals = orders & fold (o => { user_id = group o.user_id, total = sum o.total })
            q = totals
                & joinLeft users ($1.user_id == $2.id) merge
                & filter (r => is_in r.user_id [1, 2])
        `);
        expect(sql).toBe([
            'SELECT',
            '    totals.user_id,',
            '    totals.total,',
            '    users.id,',
            '    users.name',
            'FROM (',
            '    SELECT',
            '        user_id,',
            '        SUM(total) AS total',
            '    FROM orders',
            '    GROUP BY user_id',
            ') AS totals',
            'LEFT JOIN users ON totals.user_id = users.id',
            'WHERE totals.user_id IN (1, 2)',
        ].join('\n'));
    });

    test('empty map projection is rejected', () => {
        const messages = errors(`
            users: query { id: int } = table "users"
            q = users & map (u => {})
        `);
        expect(messages.join('\n')).toContain('must contain at least one field');
    });
});

describe('self-joins (review fix)', () => {
    test('duplicate table names get unique aliases', () => {
        const sql = render(`
            a: query { id: int } = table "users"
            b: query { uid: int } = table "users"
            q = a & joinInner b (l => r => l.id == r.uid) (l => r => { id = l.id, uid = r.uid })
        `);
        // The right side is the named binding `b`, so its alias is the binding
        // name (not a table-derived `users_1`) — the SQL reads like the source.
        expect(sql).toContain('INNER JOIN users AS b ON users.id = b.uid');
    });

    test('the bound table value is not mutated by aliasing', () => {
        // Two independent joins of the same binding: the second must not
        // inherit the first join's alias.
        const sql = render(`
            users: query { id: int } = table "users"
            orders: query { user_id: int } = table "orders"
            q1 = users & joinInner orders (u => o => u.id == o.user_id) (u => o => { uid = u.id })
            q2 = users & joinInner orders (u => o => u.id == o.user_id) (u => o => { uid = u.id })
        `);
        expect(sql).toContain('INNER JOIN orders ON');
        expect(sql).not.toContain('orders_1');
    });
});

describe('string escapes (review fix)', () => {
    test('unknown escape sequences are preserved verbatim', () => {
        const src = `
            users: query { id: int, name: string } = table "users"
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
            users: query { id: int, name: string } = table "users"
            q = users & filter (u => u.name == "a\\nb\\t\\"q\\"")
        `);
        expect(sql).toContain(`'a\nb\t"q"'`);
    });
});
