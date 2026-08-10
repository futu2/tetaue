import { describe, expect, test } from 'bun:test';
import { render, errors, parseModel } from './helpers.ts';

const USERS = `users = table "users" {
    id = int,
    name = string,
    age = int,
    active = bool,
}`;

describe('query roots', () => {
    test('bare table renders SELECT *', () => {
        expect(render(`${USERS}`)).toBe('SELECT *\nFROM "users"');
    });
});

describe('pipeline steps', () => {
    test('filter + map + sort + take', () => {
        const sql = render(`
            ${USERS}
            adults = users
                & filter (u => u.active && u.age >= 18)
                & sort (u => [asc u.name, desc u.age])
                & map (u => { id = u.id, name = u.name })
                & take 10
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
        const sql = render(`${USERS}\nq = users & sort (u => asc u.name)`);
        expect(sql).toContain('ORDER BY "name" ASC');
    });

    test('curried step reused as a binding', () => {
        const sql = render(`
            ${USERS}
            by_age = sort (u => [desc u.age])
            q = users & by_age & take 5
        `);
        expect(sql).toContain('ORDER BY "age" DESC');
        expect(sql).toContain('LIMIT 5');
    });

    test('bare lambda argument without parens', () => {
        const sql = render(`${USERS}\nq = users & filter u => u.age >= 21`);
        expect(sql).toContain('WHERE ("age" >= 21)');
    });

    test('multiple filter steps are ANDed', () => {
        const sql = render(`
            ${USERS}
            q = users & filter (u => u.age >= 18) & filter (u => u.active)
        `);
        expect(sql).toContain('WHERE ("age" >= 18) AND ("active")');
    });

    test('unary minus on literals and columns', () => {
        const sql = render(`${USERS}\nq = users & filter (u => u.age > -5)`);
        expect(sql).toContain('"age" > -5');
    });

    test('boolean literal dialect difference', () => {
        const src = `${USERS}\nq = users & filter (u => u.active == true)`;
        expect(render(src, 'sqlite')).toContain('"active" = 1');
        expect(render(src, 'postgresql')).toContain('"active" = TRUE');
    });
});

describe('nulls', () => {
    test('== null renders IS NULL, != null renders IS NOT NULL', () => {
        const sql = render(`
            ${USERS}
            q = users
                & filter (u => u.name == null)
                & filter (u => u.name != null)
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
                & map (u => {
                    upper = upper u.name,
                    lower = lower u.name,
                    len = length u.name,
                    name_or_unknown = coalesce u.name "unknown",
                })
        `);
        expect(sql).toContain('UPPER("name") AS "upper"');
        expect(sql).toContain('LOWER("name") AS "lower"');
        expect(sql).toContain('LENGTH("name") AS "len"');
        expect(sql).toContain(`COALESCE("name", 'unknown') AS "name_or_unknown"`);
    });

    test('string literal escaping', () => {
        const sql = render(`${USERS}\nq = users & filter (u => u.name == "it's")`);
        expect(sql).toContain(`"name" = 'it''s'`);
    });
});

describe('is_in', () => {
    test('IN and NOT IN', () => {
        const sql = render(`
            ${USERS}
            q = users
                & filter (u => is_in u.age [18, 21, 25])
                & filter (u => is_not_in u.name ["a", "b"])
        `);
        expect(sql).toContain('"age" IN (18, 21, 25)');
        expect(sql).toContain(`"name" NOT IN ('a', 'b')`);
    });
});

describe('distinct', () => {
    test('SELECT DISTINCT', () => {
        const sql = render(`${USERS}\nq = users & distinct`);
        expect(sql).toContain('SELECT DISTINCT *');
    });
});

describe('aggregation', () => {
    test('fold with group keys and aggregates', () => {
        const sql = render(`
            orders = table "orders" {
                user_id = int,
                total = float,
                status = string,
            }
            q = orders
                & fold (o => {
                    user_id = group o.user_id,
                    order_count = count o.user_id,
                    total = sum o.total,
                    avg = avg o.total,
                    min_total = min o.total,
                    max_total = max o.total,
                })
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
            orders = table "orders" { total = float }
            q = orders & fold (o => { total = sum o.total })
        `);
        expect(sql).not.toContain('GROUP BY');
        expect(sql).toContain('SUM("total") AS "total"');
    });
});

describe('joins', () => {
    const SRC = `
        users = table "users" { id = int, name = string }
        orders = table "orders" { oid = int, user_id = int, total = float }
        q = users
            & join { right = orders,
                on = (u, o) => u.id == o.user_id,
                kind = "left",
            }
            & map (r => { uid = r.id, oid = r.oid, total = r.total })
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
            users = table "users" { id = int }
            orders = table "orders" { user_id = int }
            q = users & join { right = orders, on = (u, o) => u.id == o.user_id }
        `);
        expect(sql).toContain('INNER JOIN "orders"');
    });

    test('overlapping columns are rejected', () => {
        const messages = errors(`
            users = table "users" { id = int }
            orders = table "orders" { id = int }
            q = users & join { right = orders, on = (u, o) => u.id == o.id }
        `);
        expect(messages.join('\n')).toContain('overlapping column');
    });
});

describe('dialects', () => {
    test('quoting differs per dialect', () => {
        const src = `${USERS}\nq = users & take 1`;
        expect(render(src, 'sqlite')).toContain('FROM "users"');
        expect(render(src, 'postgresql')).toContain('FROM "users"');
        expect(render(src, 'mysql')).toContain('FROM `users`');
    });

    test('compact format is a single line', () => {
        const sql = render(`${USERS}\nq = users & take 1`, 'sqlite', 'compact');
        expect(sql).not.toContain('\n');
        expect(sql).toBe('SELECT * FROM "users" LIMIT 1');
    });
});

describe('parse structure', () => {
    test('module has bindings; last binding is the query', () => {
        const model = parseModel(`${USERS}\nq = users & take 1`);
        expect(model.$type).toBe('Model');
        expect(model.bindings.length).toBe(2);
        expect(model.bindings[1]!.name).toBe('q');
        // `users & take 1` is a pipeline — a BinaryExpression
        expect((model.bindings[1]!.value as { $type: string }).$type).toBe('BinaryExpression');
    });

    test('a module with a single binding', () => {
        const model = parseModel('q = table "t" { a = int }');
        expect(model.bindings.length).toBe(1);
    });

    test('comments are hidden', () => {
        const model = parseModel('# a comment\nusers = table "t" { a = int }');
        expect(model.bindings.length).toBe(1);
    });
});

describe('haskell-style operators (review change)', () => {
    const USERS2 = `users = table "users" { id = int, name = string, age = int, active = bool }`;

    test('$ is function application (right-associative)', () => {
        const sql = render(`
            ${USERS2}
            by_age = sort $ u => [asc u.name]
            q = users & by_age
        `);
        expect(sql).toContain('ORDER BY "name" ASC');
    });

    test('$ chains right-associatively inside parens', () => {
        const sql = render(`
            ${USERS2}
            q = users
                & (filter $ u => u.age >= 18)
                & (map $ u => { id = u.id })
        `);
        expect(sql).toBe([
            'SELECT "id"',
            'FROM "users"',
            'WHERE ("age" >= 18)',
        ].join('\n'));
    });

    test('& is the pipeline operator', () => {
        const sql = render(`
            ${USERS2}
            adults = users
                & filter (u => u.active && u.age >= 18)
                & take 5
        `);
        expect(sql).toContain('WHERE ("active" AND "age" >= 18)');
        expect(sql).toContain('LIMIT 5');
    });

    test('builtins are plain identifiers and may be shadowed', () => {
        const messages = errors(`
            table = 42
            q = table "x" { a = int }
        `);
        expect(messages.join('\n')).toContain('cannot apply');
    });

    test('null is the NULL literal keyword', () => {
        const sql = render(`${USERS2}\nq = users & filter (u => u.name == null)`);
        expect(sql).toContain('"name" IS NULL');
    });

    test('bindings must be defined before use (lexical order)', () => {
        const messages = errors(`
            ${USERS2}
            q = users & filter (u => u.age >= min_age)
            min_age = 18
        `);
        expect(messages.join('\n')).toContain("unknown identifier 'min_age' — bindings must be defined before use");
    });
});

describe('composable joins (review change)', () => {
    test('the right side is a first-class query value, not a name', () => {
        const sql = render(`
            users = table "users" { id = int, name = string }
            orders = table "orders" { user_id = int, total = float }
            q = users & join { right = orders, on = (u, o) => u.id == o.user_id }
        `);
        expect(sql).toContain('INNER JOIN "orders" ON "users"."id" = "orders"."user_id"');
    });

    test('a mapped right side composes as a subquery with aliased output', () => {
        const sql = render(`
            users = table "users" { id = int }
            orders = table "orders" { user_id = int, total = float }
            o2 = orders & map (o => { uid = o.user_id, amount = o.total })
            q = users & join { right = o2, on = (u, o) => u.id == o.uid }
        `);
        expect(sql).toContain('INNER JOIN (SELECT "user_id" AS "uid", "total" AS "amount" FROM "orders") AS "orders" ON "users"."id" = "orders"."uid"');
    });

    test('a stepped self-join gets a unique subquery alias', () => {
        const sql = render(`
            users = table "users" { id = int }
            q = users
                & join { right = users & map (u => { uid = u.id }), on = (l, r) => l.id == r.uid }
        `);
        expect(sql).toContain('INNER JOIN (SELECT "id" AS "uid" FROM "users") AS "users_1" ON "users"."id" = "users_1"."uid"');
    });

    test('a distinct right side renders as a DISTINCT subquery', () => {
        const sql = render(`
            users = table "users" { id = int }
            orders = table "orders" { user_id = int }
            q = users & join { right = orders & distinct, on = (u, o) => u.id == o.user_id }
        `);
        expect(sql).toContain('INNER JOIN (SELECT DISTINCT * FROM "orders") AS "orders" ON "users"."id" = "orders"."user_id"');
    });

    test('join composes inside a pipeline with other steps', () => {
        const sql = render(`
            users = table "users" { id = int, active = bool }
            orders = table "orders" { user_id = int, total = float }
            q = users
                & filter (u => u.active)
                & join { right = orders, on = (u, o) => u.id == o.user_id, kind = "left" }
                & map (r => { uid = r.id, total = r.total })
                & take 5
        `);
        expect(sql).toContain('LEFT JOIN "orders" ON "users"."id" = "orders"."user_id"');
        expect(sql).toContain('WHERE ("users"."active")');
        expect(sql).toContain('LIMIT 5');
    });
});
