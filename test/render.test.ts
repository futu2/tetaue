import { describe, expect, test } from 'bun:test';
import { render, errors, parseModel } from './helpers.ts';

const USERS = `users = @table "users" {
    id = @int,
    name = @string,
    age = @int,
    active = @bool,
},`;

describe('query roots', () => {
    test('bare table renders SELECT *', () => {
        expect(render(`${USERS}\nusers`)).toBe('SELECT *\nFROM "users"');
    });
});

describe('pipeline steps', () => {
    test('filter + map + sort + take', () => {
        const sql = render(`
            ${USERS}
            adults = users
                |> @filter (u => u.active && u.age >= 18)
                |> @sort (u => [@asc u.name, @desc u.age])
                |> @map (u => { id = u.id, name = u.name })
                |> @take 10,
            adults
        `);
        expect(sql).toBe([
            'SELECT "id", "name"',
            'FROM "users"',
            'WHERE ("active" AND "age" >= 18)',
            'ORDER BY "name" ASC, "age" DESC',
            'LIMIT 10',
        ].join('\n'));
    });

    test('single sort item without a list', () => {
        const sql = render(`${USERS}\nq = users |> @sort (u => @asc u.name),\nq`);
        expect(sql).toContain('ORDER BY "name" ASC');
    });

    test('curried step reused as a binding', () => {
        const sql = render(`
            ${USERS}
            by_age = @sort (u => [@desc u.age]),
            q = users |> by_age |> @take 5,
            q
        `);
        expect(sql).toContain('ORDER BY "age" DESC');
        expect(sql).toContain('LIMIT 5');
    });

    test('bare lambda argument without parens', () => {
        const sql = render(`${USERS}\nq = users |> @filter u => u.age >= 21,\nq`);
        expect(sql).toContain('WHERE ("age" >= 21)');
    });

    test('multiple filter steps are ANDed', () => {
        const sql = render(`
            ${USERS}
            q = users |> @filter (u => u.age >= 18) |> @filter (u => u.active),
            q
        `);
        expect(sql).toContain('WHERE ("age" >= 18) AND ("active")');
    });

    test('unary minus on literals and columns', () => {
        const sql = render(`${USERS}\nq = users |> @filter (u => u.age > -5),\nq`);
        expect(sql).toContain('"age" > -5');
    });

    test('boolean literal dialect difference', () => {
        const src = `${USERS}\nq = users |> @filter (u => u.active == true),\nq`;
        expect(render(src, 'sqlite')).toContain('"active" = 1');
        expect(render(src, 'postgresql')).toContain('"active" = TRUE');
    });
});

describe('nulls', () => {
    test('== @null renders IS NULL, != @null renders IS NOT NULL', () => {
        const sql = render(`
            ${USERS}
            q = users
                |> @filter (u => u.name == @null)
                |> @filter (u => u.name != @null),
            q
        `);
        expect(sql).toContain('"name" IS NULL');
        expect(sql).toContain('"name" IS NOT NULL');
    });
});

describe('string functions', () => {
    test('upper/lower/length/coalesce', () => {
        const sql = render(`
            ${USERS}
            q = users
                |> @map (u => {
                    upper = @upper u.name,
                    lower = @lower u.name,
                    len = @length u.name,
                    name_or_unknown = @coalesce u.name "unknown",
                }),
            q
        `);
        expect(sql).toContain('UPPER("name") AS "upper"');
        expect(sql).toContain('LOWER("name") AS "lower"');
        expect(sql).toContain('LENGTH("name") AS "len"');
        expect(sql).toContain(`COALESCE("name", 'unknown') AS "name_or_unknown"`);
    });

    test('string literal escaping', () => {
        const sql = render(`${USERS}\nq = users |> @filter (u => u.name == "it's"),\nq`);
        expect(sql).toContain(`"name" = 'it''s'`);
    });
});

describe('is_in', () => {
    test('IN and NOT IN', () => {
        const sql = render(`
            ${USERS}
            q = users
                |> @filter (u => @is_in u.age [18, 21, 25])
                |> @filter (u => @is_not_in u.name ["a", "b"]),
            q
        `);
        expect(sql).toContain('"age" IN (18, 21, 25)');
        expect(sql).toContain(`"name" NOT IN ('a', 'b')`);
    });
});

describe('distinct', () => {
    test('SELECT DISTINCT', () => {
        const sql = render(`${USERS}\nq = users |> @distinct,\nq`);
        expect(sql).toContain('SELECT DISTINCT *');
    });
});

describe('aggregation', () => {
    test('fold with group keys and aggregates', () => {
        const sql = render(`
            orders = @table "orders" {
                user_id = @int,
                total = @float,
                status = @string,
            },
            q = orders
                |> @fold (o => {
                    user_id = @group o.user_id,
                    order_count = @count o.user_id,
                    total = @sum o.total,
                    avg = @avg o.total,
                    min_total = @min o.total,
                    max_total = @max o.total,
                }),
            q
        `);
        expect(sql).toContain('COUNT("user_id") AS "order_count"');
        expect(sql).toContain('SUM("total") AS "total"');
        expect(sql).toContain('AVG("total") AS "avg"');
        expect(sql).toContain('MIN("total") AS "min_total"');
        expect(sql).toContain('MAX("total") AS "max_total"');
        expect(sql).toContain('GROUP BY "user_id"');
    });

    test('fold without group keys has no GROUP BY', () => {
        const sql = render(`
            orders = @table "orders" { total = @float },
            q = orders |> @fold (o => { total = @sum o.total }),
            q
        `);
        expect(sql).not.toContain('GROUP BY');
        expect(sql).toContain('SUM("total") AS "total"');
    });
});

describe('joins', () => {
    const SRC = `
        users = @table "users" { id = @int, name = @string },
        orders = @table "orders" { oid = @int, user_id = @int, total = @float },
        q = users
            |> @join orders {
                on = (u, o) => u.id == o.user_id,
                kind = "left",
            }
            |> @map (r => { uid = r.id, oid = r.oid, total = r.total }),
        q
    `;

    test('renders JOIN with qualified columns', () => {
        const sql = render(SRC);
        expect(sql).toContain('LEFT JOIN "orders" ON "users"."id" = "orders"."user_id"');
        // after the join, both tables are in scope → qualified
        expect(sql).toContain('"users"."id"');
        expect(sql).toContain('"orders"."total"');
        expect(sql).toContain('"orders"."oid"');
    });

    test('default join kind is inner', () => {
        const sql = render(`
            users = @table "users" { id = @int },
            orders = @table "orders" { user_id = @int },
            q = users |> @join orders { on = (u, o) => u.id == o.user_id },
            q
        `);
        expect(sql).toContain('INNER JOIN "orders"');
    });

    test('overlapping columns are rejected', () => {
        const messages = errors(`
            users = @table "users" { id = @int },
            orders = @table "orders" { id = @int },
            q = users |> @join orders { on = (u, o) => u.id == o.id },
            q
        `);
        expect(messages.join('\n')).toContain('overlapping column');
    });
});

describe('dialects', () => {
    test('quoting differs per dialect', () => {
        const src = `${USERS}\nq = users |> @take 1,\nq`;
        expect(render(src, 'sqlite')).toContain('FROM "users"');
        expect(render(src, 'postgresql')).toContain('FROM "users"');
        expect(render(src, 'mysql')).toContain('FROM `users`');
    });

    test('compact format is a single line', () => {
        const sql = render(`${USERS}\nq = users |> @take 1,\nq`, 'sqlite', 'compact');
        expect(sql).not.toContain('\n');
        expect(sql).toBe('SELECT * FROM "users" LIMIT 1');
    });
});

describe('parse structure', () => {
    test('module has bindings and a query', () => {
        const model = parseModel(`${USERS}\nq = users |> @take 1,\nq`);
        expect(model.$type).toBe('Model');
        expect(model.bindings.length).toBe(2);
        // bare atoms are wrapped in a zero-argument Application node by Langium
        expect((model.query as { $type: string }).$type).toBe('Application');
    });

    test('expression without bindings', () => {
        const model = parseModel('@table "t" { a = @int }');
        expect(model.bindings.length).toBe(0);
        expect((model.query as { $type: string }).$type).toBe('Application');
    });

    test('comments are hidden', () => {
        const model = parseModel('# a comment\nusers = @table "t" { a = @int },\nusers');
        expect(model.bindings.length).toBe(1);
    });
});
