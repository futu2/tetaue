import { describe, expect, test } from 'bun:test';
import { errors, render, buildDocument, services } from './helpers.ts';

const USERS = `users = table "users" {
    id = int,
    name = string,
    age = int,
    active = bool,
}`;

describe('semantic errors', () => {
    test('misspelled builtin is an unknown identifier', () => {
        expect(errors(`${USERS}\nq = users & frobnicate (u => u.age)`).join('\n')).toContain("unknown identifier 'frobnicate'");
    });

    test('unknown identifier', () => {
        expect(errors(`${USERS}\nq = users & filter (u => u.age >= nope)`).join('\n')).toContain("unknown identifier 'nope'");
    });

    test('duplicate binding name', () => {
        expect(errors(`${USERS}\nusers = table "x" { a = int }`).join('\n')).toContain("duplicate binding name 'users'");
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

    test('fold requires at least one aggregate', () => {
        const messages = errors(`${USERS}\nq = users & fold (u => { id = group u.id })`);
        expect(messages.join('\n')).toContain('at least one aggregate');
    });

    test('duplicate projection keys', () => {
        expect(errors(`${USERS}\nq = users & map (u => { a = u.id, a = u.age })`).join('\n')).toContain("duplicate map key 'a'");
    });

    test('schema entry must be a type', () => {
        expect(errors(`t = table "t" { a = 42 }`).join('\n')).toContain("schema entry 'a' must be a type");
    });

    test('table requires a name string', () => {
        expect(errors(`t = table 42 {}`).join('\n')).toContain('table expects a table name string');
    });

    test("a module's last binding must be a query", () => {
        expect(errors(`${USERS}\nq = 42`).join('\n')).toContain("a module's last binding must be a query");
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

    test('join on must be a two-parameter lambda', () => {
        const messages = errors(`
            users = table "users" { id = int }
            orders = table "orders" { user_id = int }
            q = users & join orders (u => u.id == 1) "inner"
        `);
        expect(messages.join('\n')).toContain("join 'on' must be a two-parameter lambda");
    });

    test('join kind must be inner/left/right/full', () => {
        const messages = errors(`
            users = table "users" { id = int }
            orders = table "orders" { user_id = int }
            q = users & join orders (u, o) => u.id == o.user_id "outer"
        `);
        expect(messages.join('\n')).toContain('"inner", "left", "right" or "full"');
    });

    test('join kind is required (three positional args)', () => {
        const messages = errors(`
            users = table "users" { id = int }
            orders = table "orders" { user_id = int }
            q = users & join orders (u, o) => u.id == o.user_id
        `);
        expect(messages.join('\n')).toContain('"inner", "left", "right" or "full"');
    });

    test('join right must be a query', () => {
        const messages = errors(`
            users = table "users" { id = int }
            q = users & join 42 (u, o) => u.id == o.user_id "inner"
        `);
        expect(messages.join('\n')).toContain('join expects a query as its first argument');
    });

    test('stepped right side of a join renders as a subquery', () => {
        const sql = render(`
            users = table "users" { id = int }
            orders = table "orders" { user_id = int, status = string }
            paid = orders & filter (o => o.status == "paid")
            q = users & join paid (u, o) => u.id == o.user_id "inner"
        `);
        expect(sql).toContain('INNER JOIN (SELECT * FROM "orders" WHERE ("status" = \'paid\')) AS "orders" ON "users"."id" = "orders"."user_id"');
    });

    test('join on with a one-parameter $n expression is rejected', () => {
        const messages = errors(`
            users = table "users" { id = int }
            orders = table "orders" { user_id = int }
            q = users & join orders ($1.id == 3) "inner"
        `);
        expect(messages.join('\n')).toContain("join 'on' must be a two-parameter lambda");
    });

    test('$n inside an explicit lambda body is an error', () => {
        const messages = errors(`
            users = table "users" { id = int }
            q = users & filter (u => $1.active)
        `);
        expect(messages.join('\n')).toContain("unknown lambda parameter '$1'");
    });

    test('unbound $n at the top level is an error', () => {
        const messages = errors(`
            users = table "users" { id = int }
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
