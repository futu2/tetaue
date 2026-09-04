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

    test('array aggregate renders per dialect', () => {
        const src = `
            orders: query { user_id: int, tag: string } = table "orders"
            q = orders & fold (o => { user_id = group o.user_id, tags = array o.tag })
        `;
        expect(render(src, 'trino')).toContain('ARRAY_AGG(tag) AS tags');
        expect(render(src, 'postgresql')).toContain('ARRAY_AGG(tag) AS tags');
        expect(render(src, 'mysql')).toContain('JSON_ARRAYAGG(tag) AS tags');
        expect(render(src, 'hive')).toContain('COLLECT_LIST(tag) AS tags');
        expect(render(src, 'sqlite')).toContain('JSON_GROUP_ARRAY(tag) AS tags');
        expect(render(src, 'trino')).toContain('GROUP BY user_id');
    });

    test('an array aggregate result can be annotated [T]', () => {
        const src = `
            orders: query { user_id: int, tag: string } = table "orders"
            q: query { user_id: int, tags: [string] } = orders & fold (o => { user_id = group o.user_id, tags = array o.tag })
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

    test('a derived right side (window wrap) inlines as a nested subquery, not a raw table', () => {
        // A map with a window followed by a filter wraps the pipeline as a
        // derived table. Joining that binding on the RIGHT previously dropped
        // root.from and rendered `FROM detail` as a raw table name. All named
        // intermediates now render as CTEs, and each reference site re-applies
        // its own alias.
        const sql = render(`
            tx: query { cust_id: int, tx_dt: date, prod_cd: int } = table "tx"
            prod: query { prod_cd: int } = table "prod"
            detail = tx
                & joinLeft prod (l => r => l.prod_cd == r.prod_cd) (l => r => merge l r)
            first_buy = detail
                & map (d => {
                    customer_number = d.cust_id,
                    buy_order = over row_number { partition = [d.cust_id], order = [asc d.tx_dt] },
                })
                & filter (d => d.buy_order == 1)
            q = first_buy
                & joinLeft first_buy (l => r => l.customer_number == r.customer_number) (l => r => merge l r)
        `);
        expect(sql).not.toContain('FROM detail\n    WHERE buy_order = 1'); // the raw-table bug
        expect(sql).toContain('WITH detail AS (');
        expect(sql).toContain('ROW_NUMBER() OVER (PARTITION BY tx.cust_id ORDER BY tx.tx_dt ASC) AS buy_order');
        expect(sql).toContain('first_buy AS (\n    SELECT * FROM detail AS first_buy WHERE buy_order = 1');
        expect(sql).toContain('LEFT JOIN first_buy\n    ON detail.customer_number = first_buy.customer_number');
        expect(sql).toContain('WHERE detail.buy_order = 1');
    });

    test('a fold-derived right side also inlines its definition', () => {
        const sql = render(`
            orders: query { user_id: int, total: int } = table "orders"
            users: query { id: int } = table "users"
            ranked = orders
                & fold (o => { user_id = group o.user_id, total = sum o.total })
                & map (r => { id = r.user_id, amount = r.total })
            q = users
                & joinLeft ranked (u => r => u.id == r.id) (u => r => { id = u.id, amount = r.amount })
        `);
        expect(sql).toContain('WITH orders_1 AS (\n    SELECT user_id, SUM(total) AS total FROM orders GROUP BY user_id');
        expect(sql).toContain('ranked AS (\n    SELECT user_id AS id, total AS amount FROM orders_1 AS ranked');
        expect(sql).toContain('LEFT JOIN ranked\n    ON users.id = ranked.id');
    });
});

describe('CTE rendering by default', () => {
    const WINDOW_SRC = `
        tx: query { cust_id: int, tx_dt: date, prod_cd: int } = table "tx"
        prod: query { prod_cd: int } = table "prod"
        detail = tx
            & joinLeft prod (l => r => l.prod_cd == r.prod_cd) (l => r => merge l r)
        first_buy = detail
            & map (d => {
                customer_number = d.cust_id,
                buy_order = over row_number { partition = [d.cust_id], order = [asc d.tx_dt] },
            })
            & filter (d => d.buy_order == 1)
    `;

    test('every named intermediate renders as a WITH CTE', () => {
        const sql = render(WINDOW_SRC + `q = first_buy
            & joinLeft first_buy (l => r => l.customer_number == r.customer_number) (l => r => merge l r)
        `);
        expect(sql).toContain('WITH detail AS (');
        expect(sql).toContain('first_buy AS (\n    SELECT * FROM detail AS first_buy WHERE buy_order = 1');
        expect(sql).toContain('ROW_NUMBER() OVER (PARTITION BY tx.cust_id ORDER BY tx.tx_dt ASC) AS buy_order');
        expect(sql).toContain('FROM detail\nLEFT JOIN first_buy\n    ON detail.customer_number = first_buy.customer_number');
        expect(sql).toContain('WHERE detail.buy_order = 1');
        // the subquery is defined once, then referenced by name
        expect(sql.match(/ROW_NUMBER\(\) OVER \(PARTITION BY tx\.cust_id/g)?.length).toBe(1);
        expect(sql).not.toContain('FROM (\n    SELECT\n        tx.cust_id AS customer_number,');
    });

    test('repeated bindings share one CTE across all reference sites', () => {
        const sql = render(WINDOW_SRC + `q = first_buy
            & joinLeft first_buy (l => r => l.customer_number == r.customer_number) (l => r => merge l r)
            & joinLeft first_buy (l => r => l.customer_number == r.customer_number) (l => r => merge l r)
        `);
        expect((sql.match(/WITH detail AS/g) ?? []).length).toBe(1);
        // one definition plus one reference inside each of the two first_buy CTEs
        expect(sql.match(/FROM detail\b/g)?.length).toBe(3);
        expect(sql).toContain('first_buy_1 AS (\n    SELECT * FROM detail AS first_buy_1 WHERE buy_order = 1');
        expect(sql).toContain('LEFT JOIN first_buy_1\n    ON first_buy.customer_number = first_buy_1.customer_number');
    });

    test('a single-use stepped binding also becomes a CTE', () => {
        const sql = render(`
            orders: query { user_id: int, total: int } = table "orders"
            users: query { id: int } = table "users"
            ranked = orders & fold (o => { user_id = group o.user_id, total = sum o.total })
            q = users & joinLeft ranked (u => r => u.id == r.user_id) (u => r => { id = u.id, total = r.total })
        `);
        expect(sql).toContain('WITH ranked AS (\n    SELECT user_id, SUM(total) AS total FROM orders GROUP BY user_id');
        expect(sql).toContain('LEFT JOIN ranked\n    ON users.id = ranked.user_id');
    });

    test('lateral right sides stay inline, even when shared', () => {
        // A correlated lateral right cannot move into a WITH clause; the same
        // named pipeline used in two lateral joins stays inline in each.
        const sql = render(`
            users: query { id: int, name: string } = table "users"
            orders: query { user_id: int, total: float } = table "orders"
            ranked = orders
                & fold (o => { user_id = group o.user_id, total = sum o.total })
                & map (r => { id = r.user_id, total = r.total })
            q = users
                & join_lateral (l => (ranked & filter (r => r.id == l.id))) (l => r => true) (l => r => { id = l.id, t1 = r.total })
                & join_lateral (l => (ranked & filter (r => r.id == l.id))) (l => r => true) (l => r => { id = l.id, t2 = r.total })
        `, 'postgresql');
        expect(sql).not.toMatch(/\bWITH\b/);
        expect(sql.match(/INNER JOIN LATERAL \(/g)?.length).toBe(2);
        expect(sql).toContain('WHERE user_id = users.id');
    });

    test('a CTE name never collides with a real table name', () => {
        // `t & take 2` wraps as a derived table named `t`; the CTE must not
        // reuse that name or `WITH t AS (SELECT * FROM t ...)` would recurse
        // into the CTE itself (SQLite: "circular reference").
        const sql = render(`t: query { a: int } = table "t"\nq = t & take 2 & fold (u => { total = sum u.a })`);
        expect(sql).toContain('WITH t_1 AS (\n    SELECT * FROM t LIMIT 2');
        expect(sql).toContain('FROM t_1 AS t');
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
                & filter (this.pt_dt == current_date)
                & map { p_cino = this.roleplayer, cp = this.par_to_par_rel_rol }
            bday = table "ecs.bday_f"
                & filter (this.pt_dt == current_date)
                & map { customer_number = this.individualid, birthday = this.birthdate }
            q = cust
                & joinLeft bday (u => v => u.p_cino == v.customer_number) (this <> that)
        `, 'hive');
        expect(sql).toContain('FROM ecs.cust_f AS cust_f');
        expect(sql).toContain('cust_f.roleplayer AS p_cino');
        expect(sql).not.toContain('ecs.cust_f.roleplayer');
        expect(sql).not.toContain('ecs.bday_f.customer_number');
        expect(sql).toContain('WITH bday AS (\n    SELECT individualid AS customer_number, birthdate AS birthday FROM ecs.bday_f WHERE pt_dt = CURRENT_DATE');
        expect(sql).toContain('LEFT JOIN bday\n    ON cust_f.roleplayer = bday.customer_number');
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

    test('bindings are order-independent (Haskell-style top-down resolution)', () => {
        // A binding may reference a later binding: `min_age` is defined after
        // the query that uses it.
        const sql = render(`
            ${USERS2}
            main = users & filter (u => u.age >= min_age)
            min_age = 18
        `);
        expect(sql).toContain('age >= 18');
    });

    test('forward reference through the module entry works', () => {
        const sql = render(`
            main = x
            x = table "ktable"
        `);
        expect(sql).toContain('FROM ktable');
    });

    test('recursive top-level bindings are rejected', () => {
        const messages = errors(`
            ${USERS2}
            a = b
            b = a
        `);
        expect(messages.join('\n')).toContain("binding 'a' is part of a recursive cycle");
        expect(messages.join('\n')).toContain("binding 'b' is part of a recursive cycle");
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
        expect(sql).toContain('WITH o2 AS (\n    SELECT user_id AS uid, total AS amount FROM orders');
        expect(sql).toContain('INNER JOIN o2\n    ON users.id = o2.uid');
    });

    test('a stepped self-join gets a unique subquery alias', () => {
        const sql = render(`
            users: query { id: int } = table "users"
            q = users
                & joinInner (users & map (u => { uid = u.id })) (l => r => l.id == r.uid) (l => r => { id = l.id, uid = r.uid })
        `);
        expect(sql).toContain('WITH users_1 AS (\n    SELECT id AS uid FROM users');
        expect(sql).toContain('INNER JOIN users_1\n    ON users.id = users_1.uid');
    });

    test('a distinct right side renders as a DISTINCT subquery', () => {
        const sql = render(`
            users: query { id: int } = table "users"
            orders: query { user_id: int } = table "orders"
            q = users & joinInner (orders & distinct) (u => o => u.id == o.user_id) (u => o => { uid = u.id })
        `);
        expect(sql).toContain('WITH orders_1 AS (\n    SELECT DISTINCT * FROM orders');
        expect(sql).toContain('INNER JOIN orders_1 AS orders\n    ON users.id = orders.user_id');
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

describe('implicit lambda parameters (this/that)', () => {
    const USERS = `users: query { id: int, name: string, age: int, active: bool } = table "users"`;

    test('(this.age + 3) is a one-parameter lambda', () => {
        const sql = render(`
            ${USERS}
            q = users & map ({ x = this.age + 3 })
        `);
        expect(sql).toContain('SELECT age + 3 AS x');
    });

    test('filter with this', () => {
        const sql = render(`
            ${USERS}
            q = users & filter (this.active && this.age >= 18)
        `);
        expect(sql).toContain([
            'WHERE',
            '    active',
            '    AND age >= 18',
        ].join('\n'));
    });

    test('map projection with this', () => {
        const sql = render(`
            ${USERS}
            q = users & map { uid = this.id, name = this.name }
        `);
        expect(sql).toContain([
            'SELECT',
            '    id AS uid,',
            '    name',
        ].join('\n'));
    });

    test('map projection with this', () => {
        const sql = render(`
            ${USERS}
            q = users & map { uid = this.id }
        `);
        expect(sql).toContain('SELECT id AS uid');
    });

    test('sort with this', () => {
        const sql = render(`
            users: query { id: int, age: int } = table "users"
            q = users & sort [desc this.age]
        `);
        expect(sql).toContain('ORDER BY age DESC');
    });

    test('fold with this', () => {
        const sql = render(`
            orders: query { user_id: int, total: int } = table "orders"
            q = orders & fold { uid = group this.user_id, t = sum this.total }
        `);
        expect(sql).toContain([
            'SELECT',
            '    user_id AS uid,',
            '    SUM(total) AS t',
        ].join('\n'));
        expect(sql).toContain('GROUP BY user_id');
    });

    test('(this.id == that.user_id) is a two-argument implicit lambda — join on', () => {
        const sql = render(`
            users: query { id: int } = table "users"
            orders: query { user_id: int, total: float } = table "orders"
            q = users & joinInner orders (this.id == that.user_id) { uid = this.id, total = that.total }
        `);
        expect(sql).toContain('INNER JOIN orders ON users.id = orders.user_id');
    });

    test('fixed join functions render their encoded SQL kind with this/that', () => {
        for (const [name, sqlKind] of [
            ['joinInner', 'INNER'],
            ['joinLeft', 'LEFT'],
            ['joinRight', 'RIGHT'],
            ['joinFull', 'FULL'],
        ] as const) {
            const sql = render(`
                users: query { id: int } = table "users"
                orders: query { user_id: int } = table "orders"
                q = users & ${name} orders (this.id == that.user_id) { uid = this.id, oid = that.user_id }
            `);
            expect(sql).toContain(`${sqlKind} JOIN orders ON users.id = orders.user_id`);
        }
    });

    test('this/that bound by the enclosing lambda resolves inside nested calls', () => {
        const sql = render(`
            users: query { id: int } = table "users"
            orders: query { user_id: int, status: string } = table "orders"
            q = users & joinInner orders (this.id == that.user_id && is_in that.status ["paid", "sent"]) { uid = this.id, oid = that.user_id }
        `);
        expect(sql).toContain('INNER JOIN orders ON users.id = orders.user_id AND orders.status IN (\'paid\', \'sent\')');
    });

    test('this works through the $ application operator', () => {
        const sql = render(`
            ${USERS}
            q = users & (filter $ (this.age >= 18))
        `);
        expect(sql).toContain('WHERE age >= 18');
    });

    test('this/that are the two implicit row parameters', () => {
        const sql = render(`
            users: query { id: int, active: bool, age: int } = table "users"
            orders: query { user_id: int, total: float, status: string } = table "orders"
            q = users
                & filter (this.active && this.age >= 18)
                & joinInner orders (this.id == that.user_id) { uid = this.id, status = that.status }
        `);
        expect(sql).toContain([
            'WHERE',
            '    users.active',
            '    AND users.age >= 18',
        ].join('\n'));
        expect(sql).toContain('INNER JOIN orders ON users.id = orders.user_id');
    });

    test('this/that stay ordinary names when a binding shadows them', () => {
        const sql = render(`
            ${USERS}
            this = 5
            q = users & filter (u => u.id == this)
        `);
        expect(sql).toContain('WHERE id = 5');
    });

    test('this/that work through the $ application operator', () => {
        const sql = render(`
            s03_corp_chrem_tx_dtl: query { pt_dt: date } = table "s03_corp_chrem_tx_dtl"
            main = filter (cast this.pt_dt "date" >= date "2025-12-31") $ filter (cast this.pt_dt "date" <= current_date) s03_corp_chrem_tx_dtl
        `);
        expect(sql).toContain([
            'WHERE',
            '    CAST(pt_dt AS DATE) <= CURRENT_DATE',
            "    AND CAST(pt_dt AS DATE) >= '2025-12-31'",
        ].join('\n'));
    });

    test('this/that scope to their own filter across $ application', () => {
        // `this`/`that` inside each parenthesized filter predicate is that
        // filter's row parameter; the `$`-right operand must NOT be
        // abstracted as a whole lambda (step applied to a lambda would be a
        // type error).
        const sql = render(`
            s03_corp_chrem_tx_dtl: query { pt_dt: date } = table "s03_corp_chrem_tx_dtl"
            main = filter (cast this.pt_dt "date" >= date "2025-12-31") $ filter (cast this.pt_dt "date" <= current_date) s03_corp_chrem_tx_dtl
        `);
        expect(sql).toContain([
            'WHERE',
            '    CAST(pt_dt AS DATE) <= CURRENT_DATE',
            "    AND CAST(pt_dt AS DATE) >= '2025-12-31'",
        ].join('\n'));
    });

    test('this in a filter nested inside an explicit lambda scopes to the inner filter', () => {
        // The inner `filter` predicate is a parenthesized argument — its own
        // implicit-lambda scope — so `this` is NOT captured by the outer `u`
        // lambda; the explicit-lambda hiding walk stops at the boundary.
        const sql = render(`
            s03_corp_chrem_tx_dtl: query { pt_dt: date } = table "s03_corp_chrem_tx_dtl"
            main = s03_corp_chrem_tx_dtl & filter (u => exists (filter (cast this.pt_dt "date" <= u.pt_dt) s03_corp_chrem_tx_dtl))
        `);
        expect(sql).toContain('EXISTS (SELECT * FROM s03_corp_chrem_tx_dtl WHERE CAST(pt_dt AS DATE) <= pt_dt)');
        expect(sql).not.toContain('unknown lambda parameter');
    });

    test('this/that in a VALUE-position argument bubbles up to the enclosing lambda', () => {
        // `is_in`'s first argument is a value expression, not a function
        // position — `this` inside its nested call is the `filter` row, so
        // the predicate is abstracted as one lambda (the lpbirthday pattern).
        const sql = render(`
            users: query { id: int, active: bool } = table "users"
            q = users & filter (is_in (from_maybe 0 this.id) [1, 2, 3])
        `);
        expect(sql).toContain('WHERE COALESCE(id, 0) IN (1, 2, 3)');
    });

    test('a step with this/that can be bound and reused', () => {
        const sql = render(`
            ${USERS}
            adults = filter (this.active && this.age >= 18)
            q = users & adults & map ({ uid = this.id })
        `);
        expect(sql).toContain([
            'WHERE',
            '    active',
            '    AND age >= 18',
        ].join('\n'));
        expect(sql).toContain('SELECT id AS uid');
    });

    test('inner parens are pure grouping — they never rebind this/that', () => {
        const plain = 'users: query { id: int, age: int } = table "users"\nq = users & map { a = this.age + 1 }';
        const grouped = 'users: query { id: int, age: int } = table "users"\nq = users & map { a = (this.age + 1) }';
        expect(render(grouped)).toBe(render(plain));
    });

    test('this/that and explicit lambdas coexist', () => {
        const sql = render(`
            ${USERS}
            q = users
                & filter (u => u.active)
                & map ({ id = this.id, name = upper this.name })
        `);
        expect(sql).toContain('WHERE active');
        expect(sql).toContain([
            'SELECT',
            '    id,',
            '    UPPER(name) AS name',
        ].join('\n'));
    });

    test('unary minus works in lambda bodies (explicit and implicit)', () => {
        const src1 = 'users: query { id: int, age: int } = table "users"\nq = users & map ({ a = -this.age })';
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

describe('lambda bodies are full operator chains', () => {
    test('a pipeline lambda body continues across lines without parens', () => {
        const sql = render(`
            users: query { id: int, age: int, active: bool } = table "users"
            adults_for = cutoff => users
                & filter (u => u.age >= cutoff)
                & filter (u => u.active)
            q = adults_for 18
        `);
        expect(sql).toContain('WHERE');
        expect(sql).toContain('age >= 18');
        expect(sql).toContain('active');
    });

    test('an unparenthesized pipeline lambda body and its parenthesized twin render identically', () => {
        const unparenthesized = `
            s03: query { pt_dt: date, chrem_acct_bal_year_accum: float } = table "s03"
            account_final = process_date =>
                s03
                & filter (u => cast u.pt_dt "date" == process_date)
                & filter (this.chrem_acct_bal_year_accum > 0)
            q = account_final (cast "2024-01-01" "date")
        `;
        const parenthesized = `
            s03: query { pt_dt: date, chrem_acct_bal_year_accum: float } = table "s03"
            account_final = process_date => (
                s03
                & filter (u => cast u.pt_dt "date" == process_date)
                & filter (this.chrem_acct_bal_year_accum > 0)
            )
            q = account_final (cast "2024-01-01" "date")
        `;
        const sql = render(unparenthesized);
        const sqlParens = render(parenthesized);
        expect(sql).toBe(sqlParens);
        expect(sql).toContain('CAST(pt_dt AS DATE) = CAST(\'2024-01-01\' AS DATE)');
        expect(sql).toContain('chrem_acct_bal_year_accum > 0');
    });

    test('$ inside a lambda body stays part of the body', () => {
        // `$` is right-associative application: `upper $ u.name` ≡ `upper (u.name)`.
        const sql = render(`
            ${USERS}
            q = users & map (u => { n = upper $ u.name })
        `);
        expect(sql).toContain('UPPER(name)');
    });
});
