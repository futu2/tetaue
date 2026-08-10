import { describe, expect, test } from 'bun:test';
import { errors, buildDocument, services } from './helpers.ts';

const USERS = `users = @table "users" {
    id = @int,
    name = @string,
    age = @int,
    active = @bool,
},`;

describe('semantic errors', () => {
    test('unknown builtin', () => {
        expect(errors(`${USERS}\nq = users |> @frobnicate (u => u.age),\nq`)).toContain("unknown builtin '@frobnicate'");
    });

    test('unknown identifier', () => {
        expect(errors(`${USERS}\nq = users |> @filter (u => u.age >= nope),\nq`).join('\n')).toContain("unknown identifier 'nope'");
    });

    test('duplicate binding name', () => {
        expect(errors(`${USERS}\nusers = @table "x" { a = @int },\nusers`).join('\n')).toContain("duplicate binding name 'users'");
    });

    test('unknown column', () => {
        expect(errors(`${USERS}\nq = users |> @filter (u => u.missing == 1),\nq`).join('\n')).toContain("unknown column 'missing'");
    });

    test('type mismatch in comparison (int vs string)', () => {
        expect(errors(`${USERS}\nq = users |> @filter (u => u.age == "yes"),\nq`).join('\n')).toContain('cannot compare int with string');
    });

    test('type mismatch in comparison (bool vs int)', () => {
        expect(errors(`${USERS}\nq = users |> @filter (u => u.active == 1),\nq`).join('\n')).toContain('cannot compare bool with int');
    });

    test('arithmetic requires numbers', () => {
        expect(errors(`${USERS}\nq = users |> @map (u => { x = u.name + 1 }),\nq`).join('\n')).toContain("'+' requires numeric operands");
    });

    test('&& requires booleans', () => {
        expect(errors(`${USERS}\nq = users |> @filter (u => u.age && u.active),\nq`).join('\n')).toContain("'&&' requires boolean operands");
    });

    test('filter predicate must be boolean', () => {
        expect(errors(`${USERS}\nq = users |> @filter (u => u.age),\nq`).join('\n')).toContain('@filter predicate must be a boolean expression');
    });

    test('take expects a non-negative integer literal', () => {
        expect(errors(`${USERS}\nq = users |> @take 3.5,\nq`).join('\n')).toContain('@take expects a non-negative integer literal');
    });

    test('aggregates are rejected outside @fold', () => {
        const messages = errors(`${USERS}\nq = users |> @map (u => { n = @count u.id }),\nq`);
        expect(messages.join('\n')).toContain('cannot contain aggregates');
    });

    test('fold entries must be group or aggregate', () => {
        const messages = errors(`${USERS}\nq = users |> @fold (u => { id = u.id }),\nq`);
        expect(messages.join('\n')).toContain('must be wrapped in an aggregate');
    });

    test('fold requires at least one aggregate', () => {
        const messages = errors(`${USERS}\nq = users |> @fold (u => { id = @group u.id }),\nq`);
        expect(messages.join('\n')).toContain('at least one aggregate');
    });

    test('duplicate projection keys', () => {
        expect(errors(`${USERS}\nq = users |> @map (u => { a = u.id, a = u.age }),\nq`).join('\n')).toContain("duplicate map key 'a'");
    });

    test('schema entry must be a type', () => {
        expect(errors(`t = @table "t" { a = 42 },\nt`).join('\n')).toContain("schema entry 'a' must be a type");
    });

    test('@table requires a name string', () => {
        expect(errors(`t = @table 42 {},\nt`).join('\n')).toContain('@table expects a table name string');
    });

    test('module must end with a query', () => {
        expect(errors(`${USERS}\n42`).join('\n')).toContain('module must end with a query expression');
    });

    test('fields cannot be accessed on tables', () => {
        expect(errors(`${USERS}\nq = users.id,\nq`).join('\n')).toContain('tables have no fields');
    });

    test('string functions require strings', () => {
        expect(errors(`${USERS}\nq = users |> @map (u => { x = @upper u.age }),\nq`).join('\n')).toContain('@upper expects a string expression');
    });

    test('sum requires numeric', () => {
        expect(errors(`${USERS}\nq = users |> @fold (u => { x = @sum u.name }),\nq`).join('\n')).toContain('@sum expects a numeric expression');
    });

    test('join on must be a two-parameter lambda', () => {
        const messages = errors(`
            users = @table "users" { id = @int },
            orders = @table "orders" { user_id = @int },
            q = users |> @join orders { on = u => u.id == 1 },
            q
        `);
        expect(messages.join('\n')).toContain("join 'on' must be a two-parameter lambda");
    });

    test('join spec unknown key', () => {
        const messages = errors(`
            users = @table "users" { id = @int },
            orders = @table "orders" { user_id = @int },
            q = users |> @join orders { on = (u, o) => u.id == o.user_id, foo = 1 },
            q
        `);
        expect(messages.join('\n')).toContain("unknown join spec key 'foo'");
    });

    test('right side of join must be a plain table', () => {
        const messages = errors(`
            users = @table "users" { id = @int },
            orders = @table "orders" { user_id = @int },
            filtered = orders |> @filter (o => o.user_id > 0),
            q = users |> @join filtered { on = (u, o) => u.id == o.user_id },
            q
        `);
        expect(messages.join('\n')).toContain('must be a plain table');
    });

    test('@not requires boolean', () => {
        expect(errors(`${USERS}\nq = users |> @filter (u => @not u.age),\nq`).join('\n')).toContain('@not expects a boolean expression');
    });

    test('is_in type mismatch', () => {
        expect(errors(`${USERS}\nq = users |> @filter (u => @is_in u.age ["a", "b"]),\nq`).join('\n')).toContain('must match type int');
    });

    test('coalesce type mismatch', () => {
        expect(errors(`${USERS}\nq = users |> @map (u => { x = @coalesce u.name u.age }),\nq`).join('\n')).toContain('@coalesce requires matching types');
    });
});

describe('parse errors and the Langium validation pipeline', () => {
    test('parse error surfaces through document diagnostics', async () => {
        const doc = await buildDocument('users = @table "users" {,');
        const diagnostics = doc.diagnostics ?? [];
        expect(diagnostics.length).toBeGreaterThan(0);
    });

    test('semantic errors surface through the Langium DocumentBuilder', async () => {
        const doc = await buildDocument(`${USERS}\nq = users |> @filter (u => u.age == "x"),\nq`);
        const messages = (doc.diagnostics ?? []).map(d => d.message);
        expect(messages.join('\n')).toContain('cannot compare int with string');
    });

    test('valid module has no diagnostics', async () => {
        const doc = await buildDocument(`${USERS}\nq = users |> @take 5,\nq`);
        expect(doc.diagnostics ?? []).toEqual([]);
    });

    test('diagnostics carry positions', async () => {
        const doc = await buildDocument(`${USERS}\nq = users |> @filter (u => u.age == "x"),\nq`);
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
