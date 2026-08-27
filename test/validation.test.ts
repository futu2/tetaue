import { describe, expect, test } from 'bun:test';
import { errors, render, buildDocument, services } from './helpers.ts';

const USERS = `users: query {
    id: int,
    name: string,
    age: int,
    active: bool,
} = table "users"`;

describe('semantic errors', () => {
    test('misspelled builtin is an unknown identifier', () => {
        expect(errors(`${USERS}\nq = users & frobnicate (u => u.age)`).join('\n')).toContain("unknown identifier 'frobnicate'");
    });

    test('unknown identifier', () => {
        expect(errors(`${USERS}\nq = users & filter (u => u.age >= nope)`).join('\n')).toContain("unknown identifier 'nope'");
    });

    test('duplicate binding name', () => {
        expect(errors(`${USERS}\nusers: query { a: int } = table "x"`).join('\n')).toContain("duplicate binding name 'users'");
    });

    test('unknown column', () => {
        expect(errors(`${USERS}\nq = users & filter (u => u.missing == 1)`).join('\n')).toContain("unknown column 'missing'");
    });

    test('type mismatch in comparison (int vs string)', () => {
        expect(errors(`${USERS}\nq = users & filter (u => u.age == "yes")`).join('\n')).toContain('cannot compare int with string');
    });

    test('type mismatch in comparison (bool vs int)', () => {
        expect(errors(`${USERS}\nq = users & filter (u => u.active == 1)`).join('\n')).toContain('cannot compare bool with int');
    });

    test('arithmetic requires numbers', () => {
        expect(errors(`${USERS}\nq = users & map (u => { x = u.name + 1 })`).join('\n')).toContain("'+' requires numeric operands");
    });

    test('&& requires booleans', () => {
        expect(errors(`${USERS}\nq = users & filter (u => u.age && u.active)`).join('\n')).toContain("'&&' requires boolean operands");
    });

    test('filter predicate must be boolean', () => {
        expect(errors(`${USERS}\nq = users & filter (u => u.age)`).join('\n')).toContain('filter predicate must be a boolean expression');
    });

    test('take expects a non-negative integer literal', () => {
        expect(errors(`${USERS}\nq = users & take 3.5`).join('\n')).toContain('take expects a non-negative integer literal');
    });

    test('aggregates are rejected outside fold', () => {
        const messages = errors(`${USERS}\nq = users & map (u => { n = count u.id })`);
        expect(messages.join('\n')).toContain('cannot contain aggregates');
    });

    test('fold entries must be group or aggregate', () => {
        const messages = errors(`${USERS}\nq = users & fold (u => { id = u.id })`);
        expect(messages.join('\n')).toContain('must be wrapped in an aggregate');
    });

    test('fold requires at least one group or aggregate', () => {
        const messages = errors(`${USERS}\nq = users & fold (u => {})`);
        expect(messages.join('\n')).toContain('at least one aggregate or group entry');
    });

    test('duplicate projection keys', () => {
        expect(errors(`${USERS}\nq = users & map (u => { a = u.id, a = u.age })`).join('\n')).toContain("duplicate map key 'a'");
    });

    test('table takes only a name', () => {
        expect(errors(`t = table "t" { a = 42 }`).join('\n')).toContain('cannot apply a query');
    });

    test('table requires a name string', () => {
        expect(errors(`t = table 42 {}`).join('\n')).toContain('table expects a table name string');
    });

    test("a module's last binding must be a query", () => {
        expect(errors(`${USERS}\nq = 42`).join('\n')).toContain("a module's last binding must be a query");
    });

    test('an incomplete binding reports one missing-expression diagnostic', () => {
        const messages = errors('q = ');
        expect(messages.filter(message => message.includes("binding 'q' is missing an expression after '='"))).toHaveLength(1);
    });

    test('fields cannot be accessed on tables', () => {
        expect(errors(`${USERS}\nq = users.id`).join('\n')).toContain('tables have no fields');
    });

    test('string functions require strings', () => {
        expect(errors(`${USERS}\nq = users & map (u => { x = upper u.age })`).join('\n')).toContain('upper expects a string expression');
    });

    test('sum requires numeric', () => {
        expect(errors(`${USERS}\nq = users & fold (u => { x = sum u.name })`).join('\n')).toContain('sum expects a numeric expression');
    });

    test('join on must be a two-argument function', () => {
        const messages = errors(`
            users: query { id: int } = table "users"
            orders: query { user_id: int } = table "orders"
            q = users & joinInner orders (u => u.id == 1) (u => o => { uid = u.id })
        `);
        expect(messages.join('\n')).toContain("joinInner 'on' must be a two-argument function (curried)");
    });

    test('the removed general join is unknown', () => {
        const messages = errors(`
            users: query { id: int } = table "users"
            orders: query { user_id: int } = table "orders"
            q = users & join orders (u => o => u.id == o.user_id) (u => o => { uid = u.id })
        `);
        expect(messages.join('\n')).toContain("unknown identifier 'join'");
    });

    test('removed join kind constants are unknown', () => {
        const messages = errors(`
            users: query { id: int } = table "users"
            q = users & filter (u => u.id == inner)
        `);
        expect(messages.join('\n')).toContain("unknown identifier 'inner'");
    });

    test('join merger must be a two-argument function', () => {
        const messages = errors(`
            users: query { id: int } = table "users"
            orders: query { user_id: int } = table "orders"
            q = users & joinInner orders u => o => u.id == o.user_id (u => { uid = u.id })
        `);
        expect(messages.join('\n')).toContain("joinInner 'merger' must be a two-argument function (curried)");
    });

    test('join right side must be a query', () => {
        const messages = errors(`
            users: query { id: int } = table "users"
            q = users & joinInner 42 (u => o => u.id == o.user_id) (u => o => { uid = u.id })
        `);
        expect(messages.join('\n')).toContain('joinInner expects a query as its first argument');
    });

    test('stepped right side of a join renders as a subquery', () => {
        const sql = render(`
            users: query { id: int } = table "users"
            orders: query { user_id: int, status: string } = table "orders"
            paid = orders & filter (o => o.status == "paid")
            q = users & joinInner paid (u => o => u.id == o.user_id) (u => o => { uid = u.id, oid = o.user_id })
        `);
        expect(sql).toContain([
            'WITH paid AS (',
            "    SELECT * FROM orders WHERE status = 'paid'",
            ')',
        ].join('\n'));
        expect(sql).toContain([
            'INNER JOIN paid',
            '    ON users.id = paid.user_id',
        ].join('\n'));
    });

    test('join on with a one-parameter $n expression is rejected', () => {
        const messages = errors(`
            users: query { id: int } = table "users"
            orders: query { user_id: int } = table "orders"
            q = users & joinInner orders ($1.id == 3) { uid = $1.id }
        `);
        expect(messages.join('\n')).toContain("joinInner 'on' must be a two-argument function (curried)");
    });

    test('$n inside an explicit lambda body is an error', () => {
        const messages = errors(`
            users: query { id: int } = table "users"
            q = users & filter (u => $1.active)
        `);
        expect(messages.join('\n')).toContain("unknown lambda parameter '$1'");
    });

    test('this/that inside an explicit lambda body are errors like $n', () => {
        const messages = errors(`
            users: query { id: int } = table "users"
            q = users & filter (u => this.id == that.id)
        `);
        expect(messages.join('\n')).toContain("unknown lambda parameter '$1'");
        expect(messages.join('\n')).toContain("unknown lambda parameter '$2'");
    });

    test('$n inside a nested parenthesized argument is its own implicit lambda', () => {
        // The inner `filter` predicate is a parenthesized argument — its own
        // implicit-lambda scope — so `$1` is not captured by the outer `u`
        // lambda nor treated as an unbound parameter of it.
        const messages = errors(`
            s03_corp_chrem_tx_dtl: query { pt_dt: date } = table "s03_corp_chrem_tx_dtl"
            main = s03_corp_chrem_tx_dtl & filter (u => exists (filter (cast $1.pt_dt "date" <= u.pt_dt) s03_corp_chrem_tx_dtl))
        `);
        expect(messages).toEqual([]);
    });

    test('unbound $n at the top level is an error', () => {
        const messages = errors(`
            users: query { id: int } = table "users"
            q = $1 + 3
        `);
        expect(messages.join('\n')).toContain("unknown lambda parameter '$1'");
    });

    test('not requires boolean', () => {
        expect(errors(`${USERS}\nq = users & filter (u => not u.age)`).join('\n')).toContain('not expects a boolean expression');
    });

    test('is_in type mismatch', () => {
        expect(errors(`${USERS}\nq = users & filter (u => is_in u.age ["a", "b"])`).join('\n')).toContain('must match type int');
    });

    test('coalesce type mismatch', () => {
        expect(errors(`${USERS}\nq = users & map (u => { x = coalesce u.name u.age })`).join('\n')).toContain('coalesce requires matching types');
    });
});

describe('parse errors and the Langium validation pipeline', () => {
    test('parse error surfaces through document diagnostics', async () => {
        const doc = await buildDocument('users = table "users" {,');
        const diagnostics = doc.diagnostics ?? [];
        expect(diagnostics.length).toBeGreaterThan(0);
    });

    test('semantic errors surface through the Langium DocumentBuilder', async () => {
        const doc = await buildDocument(`${USERS}\nq = users & filter (u => u.age == "x")`);
        const messages = (doc.diagnostics ?? []).map(d => d.message);
        expect(messages.join('\n')).toContain('cannot compare int with string');
    });

    test('valid module has no diagnostics', async () => {
        const doc = await buildDocument(`${USERS}\nq = users & take 5`);
        expect(doc.diagnostics ?? []).toEqual([]);
    });

    test('diagnostics carry positions', async () => {
        const doc = await buildDocument(`${USERS}\nq = users & filter (u => u.age == "x")`);
        const diag = (doc.diagnostics ?? [])[0]!;
        expect(diag.range.start.line).toBeGreaterThan(0);
    });
});

describe('services singleton', () => {
    test('created services are wired', () => {
        expect(services.parser.LangiumParser).toBeDefined();
        expect(services.validation.ValidationRegistry).toBeDefined();
    });
});

describe('literal validation', () => {
    test('date and timestamp literals are ISO-checked at compile time', () => {
        expect(errors('q = date "not-a-date"').join('\n')).toContain('date expects an ISO date string literal (YYYY-MM-DD)');
        expect(errors('q = timestamp "2024-01-01"').join('\n')).toContain('timestamp expects an ISO timestamp string literal');
    });

    test('empty parameter and table names are rejected', () => {
        expect(errors('q = param ""').join('\n')).toContain('non-empty parameter name');
        expect(errors('q = table ""').join('\n')).toContain('non-empty table name');
    });
});
