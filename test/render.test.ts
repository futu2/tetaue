import { describe, expect, test } from 'bun:test';
import { render, errors, allErrors, parseModel } from './helpers.ts';

const USERS = `users: query {
    id: int,
    name: string,
    age: int,
    active: bool,
} = table "users"`;

describe('query roots', () => {
    test('bare table renders SELECT *', () => {
        expect(render(`${USERS}`)).toBe('SELECT *\nFROM users');
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
            'SELECT',
            '    id,',
            '    name',
            'FROM users',
            'WHERE',
            '    active',
            '    AND age >= 18',
            'ORDER BY',
            '    name ASC,',
            '    age DESC',
            'LIMIT 10',
        ].join('\n'));
    });

    test('single sort item without a list', () => {
        const sql = render(`${USERS}\nq = users & sort (u => asc u.name)`);
        expect(sql).toContain('ORDER BY name ASC');
    });

    test('curried step reused as a binding', () => {
        const sql = render(`
            ${USERS}
            by_age = sort (u => [desc u.age])
            q = users & by_age & take 5
        `);
        expect(sql).toContain('ORDER BY age DESC');
        expect(sql).toContain('LIMIT 5');
    });

    test('a bound (partially-applied) outer-join step is reusable and renders', () => {
        const sql = render(`
            ${USERS}
            orders: query { id: int, user_id: int, total: float } = table "orders"
            J = joinLeft orders
            q = users & J (u => o => u.id == o.user_id) (u => o => { uid = u.id, total = o.total })
        `);
        expect(sql).toContain('LEFT JOIN orders ON users.id = orders.user_id');
        expect(sql).toContain('users.id AS uid');
        expect(sql).toContain('orders.total');
    });

    test('bare lambda argument without parens', () => {
        const sql = render(`${USERS}\nq = users & filter u => u.age >= 21`);
        expect(sql).toContain('WHERE age >= 21');
    });

    test('multiple filter steps are ANDed', () => {
        const sql = render(`
            ${USERS}
            q = users & filter (u => u.age >= 18) & filter (u => u.active)
        `);
        expect(sql).toContain([
            'WHERE',
            '    age >= 18',
            '    AND active',
        ].join('\n'));
    });

    test('unary minus on literals and columns', () => {
        const sql = render(`${USERS}\nq = users & filter (u => u.age > -5)`);
        expect(sql).toContain('age > -5');
    });

    test('boolean literal dialect difference', () => {
        const src = `${USERS}\nq = users & filter (u => u.active == true)`;
        expect(render(src, 'sqlite')).toContain('active = 1');
        expect(render(src, 'postgresql')).toContain('active = TRUE');
        expect(render(src, 'trino')).toContain('active = TRUE');
        expect(render(src, 'mysql')).toContain('active = TRUE');
        expect(render(src, 'hive')).toContain('active = TRUE');
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
        expect(sql).toContain('name IS NULL');
        expect(sql).toContain('name IS NOT NULL');
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
        expect(sql).toContain('UPPER(name) AS upper');
        expect(sql).toContain('LOWER(name) AS lower');
        expect(sql).toContain('LENGTH(name) AS len');
        expect(sql).toContain(`COALESCE(name, 'unknown') AS name_or_unknown`);
    });

    test('string literal escaping', () => {
        const sql = render(`${USERS}\nq = users & filter (u => u.name == "it's")`);
        expect(sql).toContain(`name = 'it''s'`);
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
        expect(sql).toContain('age IN (18, 21, 25)');
        expect(sql).toContain(`name NOT IN ('a', 'b')`);
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
            orders: query {
                user_id: int,
                total: float,
                status: string,
            } = table "orders"
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
        expect(sql).toContain('COUNT(user_id) AS order_count');
        expect(sql).toContain('SUM(total) AS total');
        expect(sql).toContain('AVG(total) AS avg');
        expect(sql).toContain('MIN(total) AS min_total');
        expect(sql).toContain('MAX(total) AS max_total');
        expect(sql).toContain('GROUP BY user_id');
    });

    test('fold without group keys has no GROUP BY', () => {
        const sql = render(`
            orders: query { total: float } = table "orders"
            q = orders & fold (o => { total = sum o.total })
        `);
        expect(sql).not.toContain('GROUP BY');
        expect(sql).toContain('SUM(total) AS total');
    });

    test('list aggregate renders per dialect', () => {
        const src = `
            orders: query { user_id: int, tag: string } = table "orders"
            q = orders & fold (o => { user_id = group o.user_id, tags = list o.tag })
        `;
        expect(render(src, 'trino')).toContain('ARRAY_AGG(tag) AS tags');
        expect(render(src, 'postgresql')).toContain('ARRAY_AGG(tag) AS tags');
        expect(render(src, 'mysql')).toContain('JSON_ARRAYAGG(tag) AS tags');
        expect(render(src, 'hive')).toContain('COLLECT_LIST(tag) AS tags');
        expect(render(src, 'sqlite')).toContain('JSON_GROUP_ARRAY(tag) AS tags');
        expect(render(src, 'trino')).toContain('GROUP BY user_id');
    });

    test('a list aggregate result can be annotated [T]', () => {
        const src = `
            orders: query { user_id: int, tag: string } = table "orders"
            q: query { user_id: int, tags: [string] } = orders & fold (o => { user_id = group o.user_id, tags = list o.tag })
        `;
        expect(allErrors(src)).toEqual([]);
        expect(render(src, 'trino')).toContain('ARRAY_AGG(tag) AS tags');
    });
});

describe('joins', () => {
    const SRC = `
        users: query { id: int, name: string } = table "users"
        orders: query { oid: int, user_id: int, total: float } = table "orders"
        q = users
            & joinLeft orders (u => o => u.id == o.user_id) (u => o => { uid = u.id, oid = o.oid, total = o.total })
    `;

    test('renders JOIN with qualified columns', () => {
        const sql = render(SRC);
        expect(sql).toContain('LEFT JOIN orders ON users.id = orders.user_id');
        // after the join, both tables are in scope → qualified; the merger
        // projects the result row (like map)
        expect(sql).toContain('users.id AS uid');
        expect(sql).toContain('orders.total');
        expect(sql).toContain('orders.oid');
    });

    test('joinInner renders INNER JOIN', () => {
        const sql = render(`
            users: query { id: int } = table "users"
            orders: query { user_id: int } = table "orders"
            q = users & joinInner orders (u => o => u.id == o.user_id) (u => o => { uid = u.id })
        `);
        expect(sql).toContain('INNER JOIN orders');
    });

    test('overlapping columns are fine — the merger picks the output row', () => {
        const sql = render(`
            users: query { id: int } = table "users"
            orders: query { id: int } = table "orders"
            q = users & joinInner orders (u => o => u.id == o.id) (u => o => { left_id = u.id, right_id = o.id })
        `);
        expect(sql).toContain('INNER JOIN orders ON users.id = orders.id');
        expect(sql).toContain('users.id AS left_id');
        expect(sql).toContain('orders.id AS right_id');
    });
});

describe('schema-qualified table names', () => {
    test('FROM renders each part of schema.table separately', () => {
        const sql = render('t = table "public.orders"\nq = t & take 1', 'postgresql');
        expect(sql).toContain('FROM public.orders');
        // the old bug: the whole name quoted as one identifier
        expect(sql).not.toContain('"public.orders"');
    });

    test('parts that need quoting are quoted individually', () => {
        const sql = render('t = table "Order Items.items"\nq = t & take 1', 'postgresql');
        expect(sql).toContain('FROM "Order Items".items');
    });

    test('catalog.schema.table renders all parts', () => {
        const sql = render('t = table "wh.db.orders"\nq = t & take 1', 'trino');
        expect(sql).toContain('FROM wh.db.orders');
    });

    test('join with qualified tables aliases both sides and qualifies columns by alias', () => {
        const sql = render(`
            users: query { id: int, name: string } = table "public.users"
            orders: query { oid: int, user_id: int, total: float } = table "public.orders"
            q = users
                & joinLeft orders (u => o => u.id == o.user_id) (u => o => { uid = u.id, oid = o.oid, total = o.total })
        `, 'postgresql');
        // Column references are `alias.column` — `schema.table.column` is
        // invalid in Hive, SQLite, and other engines.
        expect(sql).not.toContain('public.users.id');
        expect(sql).not.toContain('public.orders.oid');
        expect(sql).toContain('LEFT JOIN public.orders AS orders ON users.id = orders.user_id');
        expect(sql).toContain('FROM public.users AS users');
        expect(sql).toContain('users.id AS uid');
        expect(sql).toContain('orders.total');
    });

    test('self-join on a qualified table derives a plain alias', () => {
        const sql = render(`
            users: query { id: int, name: string, boss_id: int } = table "public.users"
            q = users
                & joinLeft users (u => b => u.boss_id == b.id) (u => b => { uid = u.id, boss = b.name })
        `, 'postgresql');
        expect(sql).toContain('FROM public.users AS users');
        expect(sql).toContain('LEFT JOIN public.users AS users_1 ON users.boss_id = users_1.id');
        expect(sql).toContain('users_1.name AS boss');
    });

    test('repeated self-joins on a qualified table suffix plain aliases', () => {
        const sql = render(`
            users: query { id: int, name: string, boss_id: int } = table "public.users"
            q = users
                & joinLeft users (u => b => u.boss_id == b.id) (u => b => { uid = u.id, boss = b.name, boss_id = b.id })
                & joinLeft users (u2 => c => u2.boss_id == c.id) (u2 => c => { uid2 = u2.uid, ceo = c.name })
        `, 'postgresql');
        expect(sql).toContain('FROM public.users AS users');
        expect(sql).toContain('LEFT JOIN public.users AS users_1 ON users.boss_id = users_1.id');
        expect(sql).toContain('LEFT JOIN public.users AS users_2 ON users_1.id = users_2.id');
        expect(sql).toContain('users_2.name AS ceo');
    });

    test('stepped qualified right side joins as a subquery with alias-qualified columns', () => {
        // Mirrors examples/lpbirthday.tetaue: a schema-qualified table with
        // filters + map on each side. Every column reference must be
        // `alias.column` — `ecs.table.column` is invalid in most engines.
        const sql = render(`
            cust = table "ecs.cust_f"
                & filter ($1.pt_dt == current_date)
                & map { p_cino = $1.roleplayer, cp = $1.par_to_par_rel_rol }
            bday = table "ecs.bday_f"
                & filter ($1.pt_dt == current_date)
                & map { customer_number = $1.individualid, birthday = $1.birthdate }
            q = cust
                & joinLeft bday (u => v => u.p_cino == v.customer_number) ($1 <> $2)
        `, 'hive');
        expect(sql).toContain('FROM ecs.cust_f AS cust_f');
        expect(sql).toContain('cust_f.roleplayer AS p_cino');
        expect(sql).not.toContain('ecs.cust_f.roleplayer');
        expect(sql).not.toContain('ecs.bday_f.customer_number');
        expect(sql).toContain('LEFT JOIN (\n    SELECT\n        individualid AS customer_number,');
        expect(sql).toContain(') AS bday\n    ON cust_f.roleplayer = bday.customer_number');
        expect(sql).toContain('WHERE cust_f.pt_dt = CURRENT_DATE');
    });
});

describe('dialects', () => {
    test('plain identifiers render unquoted in every dialect', () => {
        const src = `${USERS}\nq = users & take 1`;
        expect(render(src, 'sqlite')).toContain('FROM users');
        expect(render(src, 'postgresql')).toContain('FROM users');
        expect(render(src, 'trino')).toContain('FROM users');
        expect(render(src, 'mysql')).toContain('FROM users');
        expect(render(src, 'hive')).toContain('FROM users');
    });

    test('reserved words still get quoted, with the dialect quote char', () => {
        const src = `order_t: query { group: int } = table "order"\nq = order_t & map (t => { g = t.group })`;
        expect(render(src, 'sqlite')).toContain('FROM "order"');
        expect(render(src, 'postgresql')).toContain('FROM "order"');
        expect(render(src, 'trino')).toContain('FROM "order"');
        expect(render(src, 'mysql')).toContain('FROM `order`');
        expect(render(src, 'hive')).toContain('FROM `order`');
        expect(render(src, 'sqlite')).toContain('"group" AS g');
        expect(render(src, 'mysql')).toContain('`group` AS g');
    });

    test('non-plain table names are quoted', () => {
        const sql = render(`q = table "order-details" & take 1`);
        expect(sql).toBe('SELECT *\nFROM "order-details"\nLIMIT 1');
    });

    test('hive escapes backslashes in string literals like mysql', () => {
        const src = `
            users: query { id: int, name: string } = table "users"
            q = users & filter (u => u.name == "C:\\\\Users\\\\bob")
        `;
        // trino (like sqlite/postgres): backslash is a literal character
        expect(render(src, 'trino')).toContain(`'C:\\Users\\bob'`);
        // hive (like mysql): backslash is the escape character, so it must be doubled
        expect(render(src, 'hive')).toContain(`'C:\\\\Users\\\\bob'`);
    });

    test('compact format is a single line', () => {
        const sql = render(`${USERS}\nq = users & take 1`, 'sqlite', 'compact');
        expect(sql).not.toContain('\n');
        expect(sql).toBe('SELECT * FROM users LIMIT 1');
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
        const model = parseModel('q: query { a: int } = table "t"');
        expect(model.bindings.length).toBe(1);
    });

    test('comments are hidden', () => {
        const model = parseModel('# a comment\nusers: query { a: int } = table "t"');
        expect(model.bindings.length).toBe(1);
    });
});

describe('haskell-style operators (review change)', () => {
    const USERS2 = `users: query { id: int, name: string, age: int, active: bool } = table "users"`;

    test('$ is function application (right-associative)', () => {
        const sql = render(`
            ${USERS2}
            by_age = sort $ u => [asc u.name]
            q = users & by_age
        `);
        expect(sql).toContain('ORDER BY name ASC');
    });

    test('$ chains right-associatively inside parens', () => {
        const sql = render(`
            ${USERS2}
            q = users
                & (filter $ u => u.age >= 18)
                & (map $ u => { id = u.id })
        `);
        expect(sql).toBe([
            'SELECT id',
            'FROM users',
            'WHERE age >= 18',
        ].join('\n'));
    });

    test('& is the pipeline operator', () => {
        const sql = render(`
            ${USERS2}
            adults = users
                & filter (u => u.active && u.age >= 18)
                & take 5
        `);
        expect(sql).toContain([
            'WHERE',
            '    active',
            '    AND age >= 18',
        ].join('\n'));
        expect(sql).toContain('LIMIT 5');
    });

    test('builtins are plain identifiers and may be shadowed', () => {
        const messages = errors(`
            table = 42
            q: query { a: int } = table "x"
        `);
        expect(messages.join('\n')).toContain('cannot apply');
    });

    test('null is the NULL literal keyword', () => {
        const sql = render(`${USERS2}\nq = users & filter (u => u.name == null)`);
        expect(sql).toContain('name IS NULL');
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

describe('function composition and aliases', () => {
    const USERS = `users: query { id: int, name: string, age: int, active: bool } = table "users"`;

    test('<<< and >>> compose functions point-free', () => {
        const sql = render(`
            ${USERS}
            q = users & map (u => {
                a = (upper <<< lower) u.name,
                b = (upper >>> lower) u.name,
            })
        `);
        expect(sql).toContain('UPPER(LOWER(name)) AS a');
        expect(sql).toContain('LOWER(UPPER(name)) AS b');
    });

    test('a bound predicate built from composition is reusable', () => {
        const sql = render(`
            ${USERS}
            adult = u => u.age >= 18
            q = users & filter (adult)
        `);
        expect(sql).toContain('WHERE age >= 18');
    });

    test('composing a non-function is an error', () => {
        const messages = errors(`
            ${USERS}
            q = users & filter (u => u.age >= ((18 <<< 21) 1))
        `);
        expect(messages.join('\n')).toContain('cannot apply');
    });
});

describe('composable joins (review change)', () => {
    test('the right side is a first-class query value, not a name', () => {
        const sql = render(`
            users: query { id: int, name: string } = table "users"
            orders: query { user_id: int, total: float } = table "orders"
            q = users & joinInner orders (u => o => u.id == o.user_id) (u => o => { uid = u.id, total = o.total })
        `);
        expect(sql).toContain('INNER JOIN orders ON users.id = orders.user_id');
    });

    test('a mapped right side composes as a subquery with aliased output', () => {
        const sql = render(`
            users: query { id: int } = table "users"
            orders: query { user_id: int, total: float } = table "orders"
            o2 = orders & map (o => { uid = o.user_id, amount = o.total })
            q = users & joinInner o2 (u => o => u.id == o.uid) (u => o => { uid = u.id, amount = o.amount })
        `);
        expect(sql).toContain('INNER JOIN (\n    SELECT\n        user_id AS uid,');
        expect(sql).toContain(') AS o2\n    ON users.id = o2.uid');
    });

    test('a stepped self-join gets a unique subquery alias', () => {
        const sql = render(`
            users: query { id: int } = table "users"
            q = users
                & joinInner (users & map (u => { uid = u.id })) (l => r => l.id == r.uid) (l => r => { id = l.id, uid = r.uid })
        `);
        expect(sql).toContain([
            'INNER JOIN (',
            '    SELECT id AS uid',
            '    FROM users',
            ') AS users_1',
            '    ON users.id = users_1.uid',
        ].join('\n'));
    });

    test('a distinct right side renders as a DISTINCT subquery', () => {
        const sql = render(`
            users: query { id: int } = table "users"
            orders: query { user_id: int } = table "orders"
            q = users & joinInner (orders & distinct) (u => o => u.id == o.user_id) (u => o => { uid = u.id })
        `);
        expect(sql).toContain([
            'INNER JOIN (',
            '    SELECT DISTINCT *',
            '    FROM orders',
            ') AS orders',
            '    ON users.id = orders.user_id',
        ].join('\n'));
    });

    test('join composes inside a pipeline with other steps', () => {
        const sql = render(`
            users: query { id: int, active: bool } = table "users"
            orders: query { user_id: int, total: float } = table "orders"
            q = users
                & filter (u => u.active)
                & joinLeft orders (u => o => u.id == o.user_id) (u => o => { uid = u.id, total = o.total })
                & take 5
        `);
        expect(sql).toContain('LEFT JOIN orders ON users.id = orders.user_id');
        expect(sql).toContain('WHERE users.active');
        expect(sql).toContain('LIMIT 5');
    });

    test('a zero-arg step does not swallow the next binding as an argument', () => {
        const sql = render(`
            users: query { id: int } = table "users"
            a = users & distinct
            b = users & take 1
        `);
        expect(sql).toContain('LIMIT 1');
        expect(sql).not.toContain('distinct');
    });

    test('a bare-identifier right side does not swallow the next binding', () => {
        const sql = render(`
            users: query { id: int } = table "users"
            orders: query { user_id: int } = table "orders"
            q1 = users & joinInner orders (u => o => u.id == o.user_id) (u => o => { uid = u.id })
            q2 = users & joinInner orders (u => o => u.id == o.user_id) (u => o => { uid = u.id })
        `);
        expect(sql).toContain('INNER JOIN orders ON users.id = orders.user_id');
        expect(sql).not.toContain('orders_1');
    });
});

describe('implicit lambda parameters ($n)', () => {
    const USERS = `users: query { id: int, name: string, age: int, active: bool } = table "users"`;

    test('($1 + 3) is a one-parameter lambda', () => {
        const sql = render(`
            ${USERS}
            q = users & map ({ x = $1.age + 3 })
        `);
        expect(sql).toContain('SELECT age + 3 AS x');
    });

    test('filter with $1', () => {
        const sql = render(`
            ${USERS}
            q = users & filter ($1.active && $1.age >= 18)
        `);
        expect(sql).toContain([
            'WHERE',
            '    active',
            '    AND age >= 18',
        ].join('\n'));
    });

    test('map projection with $1', () => {
        const sql = render(`
            ${USERS}
            q = users & map { uid = $1.id, name = $1.name }
        `);
        expect(sql).toContain([
            'SELECT',
            '    id AS uid,',
            '    name',
        ].join('\n'));
    });

    test('map projection with $1', () => {
        const sql = render(`
            ${USERS}
            q = users & map { uid = $1.id }
        `);
        expect(sql).toContain('SELECT id AS uid');
    });

    test('sort with $1', () => {
        const sql = render(`
            users: query { id: int, age: int } = table "users"
            q = users & sort [desc $1.age]
        `);
        expect(sql).toContain('ORDER BY age DESC');
    });

    test('fold with $1', () => {
        const sql = render(`
            orders: query { user_id: int, total: int } = table "orders"
            q = orders & fold { uid = group $1.user_id, t = sum $1.total }
        `);
        expect(sql).toContain([
            'SELECT',
            '    user_id AS uid,',
            '    SUM(total) AS t',
        ].join('\n'));
        expect(sql).toContain('GROUP BY user_id');
    });

    test('($1 + $2) is a two-argument implicit lambda — join on', () => {
        const sql = render(`
            users: query { id: int } = table "users"
            orders: query { user_id: int, total: float } = table "orders"
            q = users & joinInner orders ($1.id == $2.user_id) { uid = $1.id, total = $2.total }
        `);
        expect(sql).toContain('INNER JOIN orders ON users.id = orders.user_id');
    });

    test('fixed join functions render their encoded SQL kind with $n', () => {
        for (const [name, sqlKind] of [
            ['joinInner', 'INNER'],
            ['joinLeft', 'LEFT'],
            ['joinRight', 'RIGHT'],
            ['joinFull', 'FULL'],
        ] as const) {
            const sql = render(`
                users: query { id: int } = table "users"
                orders: query { user_id: int } = table "orders"
                q = users & ${name} orders ($1.id == $2.user_id) { uid = $1.id, oid = $2.user_id }
            `);
            expect(sql).toContain(`${sqlKind} JOIN orders ON users.id = orders.user_id`);
        }
    });

    test('$n bound by the enclosing lambda resolves inside nested calls', () => {
        const sql = render(`
            users: query { id: int } = table "users"
            orders: query { user_id: int, status: string } = table "orders"
            q = users & joinInner orders ($1.id == $2.user_id && is_in $2.status ["paid", "sent"]) { uid = $1.id, oid = $2.user_id }
        `);
        expect(sql).toContain('INNER JOIN orders ON users.id = orders.user_id AND orders.status IN (\'paid\', \'sent\')');
    });

    test('$n works through the $ application operator', () => {
        const sql = render(`
            ${USERS}
            q = users & (filter $ ($1.age >= 18))
        `);
        expect(sql).toContain('WHERE age >= 18');
    });

    test('a step with $n can be bound and reused', () => {
        const sql = render(`
            ${USERS}
            adults = filter ($1.active && $1.age >= 18)
            q = users & adults & map ({ uid = $1.id })
        `);
        expect(sql).toContain([
            'WHERE',
            '    active',
            '    AND age >= 18',
        ].join('\n'));
        expect(sql).toContain('SELECT id AS uid');
    });

    test('inner parens are pure grouping — they never rebind $n', () => {
        const plain = 'users: query { id: int, age: int } = table "users"\nq = users & map { a = $1.age + 1 }';
        const grouped = 'users: query { id: int, age: int } = table "users"\nq = users & map { a = ($1.age + 1) }';
        expect(render(grouped)).toBe(render(plain));
    });

    test('$n and explicit lambdas coexist', () => {
        const sql = render(`
            ${USERS}
            q = users
                & filter (u => u.active)
                & map ({ id = $1.id, name = upper $1.name })
        `);
        expect(sql).toContain('WHERE active');
        expect(sql).toContain([
            'SELECT',
            '    id,',
            '    UPPER(name) AS name',
        ].join('\n'));
    });

    test('unary minus works in lambda bodies (explicit and $n)', () => {
        const src1 = 'users: query { id: int, age: int } = table "users"\nq = users & map ({ a = -$1.age })';
        expect(render(src1)).toContain('0 - age AS a');
        const src2 = 'users: query { id: int, age: int } = table "users"\nq = users & map (u => { b = -u.age })';
        expect(render(src2)).toContain('0 - age AS b');
    });
});

describe('review fixes: pure-local bindings, step composition, SQL escaping', () => {
    test('let binds a pure local expression inside a projection', () => {
        const src = 'users: query { id: int, age: int } = table "users"\nq = users & map (u => let double = u.age * 2 in { double = double, next = double + 1 })';
        const sql = render(src);
        expect(sql).toBe([
            'SELECT',
            '    age * 2 AS double,',
            '    age * 2 + 1 AS next',
            'FROM users',
        ].join('\n'));
    });

    test('query steps compose point-free with >>>', () => {
        const sql = render(`
            ${USERS}
            adult = u => u.active
            q = users & (filter (adult) >>> take 10)
        `);
        expect(sql).toBe('SELECT *\nFROM users\nWHERE active\nLIMIT 10');
    });

    test('identifiers with embedded quotes are escaped per dialect', () => {
        const src = 'q: query { id: int } = table "a\\\"b"';
        expect(render(src, 'sqlite')).toBe('SELECT *\nFROM "a""b"');
        expect(render(src, 'postgresql')).toBe('SELECT *\nFROM "a""b"');
    });

    test('backtick identifiers are escaped for mysql/hive', () => {
        const src = 'q: query { id: int } = table "a`b"';
        expect(render(src, 'mysql')).toBe('SELECT *\nFROM `a``b`');
        expect(render(src, 'hive')).toBe('SELECT *\nFROM `a``b`');
    });

    test('date_format strings are quoted as SQL string literals', () => {
        const src = 'users: query { created_at: date } = table "users"\nq = users & map (u => { d = date_format u.created_at "it\'s" })';
        expect(render(src, 'sqlite')).toContain(`STRFTIME('it''s', created_at)`);
    });

    test('a let-bound table accepts a query-type schema annotation', () => {
        const sql = render('q = let users: query { id: int } = table "users" in users & map (u => { id = u.id })');
        expect(sql).toBe('SELECT id\nFROM users');
    });
});
