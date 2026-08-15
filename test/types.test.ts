import { describe, expect, test } from 'bun:test';
import { parseModel, typeErrors, allErrors, render } from './helpers.ts';
import {
    TypeUniverse, UnifyError, type Type,
    fun, listOf, nullable, prim, queryOf, rowOf,
} from '../src/language/types.ts';
import { inferProject } from '../src/language/inference.ts';
import type { ProjectModule } from '../src/language/imports.ts';

const USERS = `users: query {
    id: int,
    name: string,
    age: int,
    active: bool,
} = table "users"`;

// ---------------------------------------------------------------------------
// Core type engine (unification, rows, nullability)
// ---------------------------------------------------------------------------

describe('type engine', () => {
    test('strict prims: int = int, but int ≠ string and int ≠ float', () => {
        const u = new TypeUniverse();
        u.unify(prim('int'), prim('int'));
        expect(() => u.unify(prim('int'), prim('string'))).toThrow(UnifyError);
        expect(() => u.unify(prim('int'), prim('float'))).toThrow(UnifyError);
    });

    test('`?` absorption is symmetric and result-carrying', () => {
        const u = new TypeUniverse();
        expect(u.unify(nullable(prim('int')), prim('int')).kind).toBe('nullable');
        u.unify(prim('int'), nullable(prim('int')));
        expect(() => u.unify(nullable(prim('int')), prim('string'))).toThrow(UnifyError);
        const a = u.fresh();
        u.unify(a, nullable(a)); // α ~ α? is fine
    });

    test('open rows absorb extra fields from closed rows', () => {
        const u = new TypeUniverse();
        const rho = u.fresh('row');
        const open = rowOf([['age', prim('int')]], rho);
        const closed = rowOf([['id', prim('int')], ['age', prim('int')], ['name', prim('string')]]);
        u.unify(open, closed);
        expect(u.rowLabels(closed).join()).toBe('age,id,name');
        expect(u.rowLabels(rho).join()).toBe('id,name'); // the tail absorbed the rest
    });

    test('closed rows reject missing labels', () => {
        const u = new TypeUniverse();
        const closed = rowOf([['age', prim('int')]]);
        expect(() => u.unify(closed, rowOf([['id', prim('int')], ['age', prim('int')]]))).toThrow(UnifyError);
    });

    test('two open rows unify by cross-absorption', () => {
        const u = new TypeUniverse();
        const r1 = rowOf([['a', prim('int')], ['c', prim('bool')]], u.fresh('row'));
        const r2 = rowOf([['b', prim('string')]], u.fresh('row'));
        u.unify(r1, r2);
        expect(u.rowLabels(r1).join()).toBe('a,b,c');
        expect(u.rowLabels(r2).join()).toBe('a,b,c');
    });

    test('row access on an unconstrained variable extends it', () => {
        const u = new TypeUniverse();
        const rho = u.fresh('row');
        const field = u.fieldOf(rho, 'age');
        expect(field).not.toBeNull();
        u.unify(field!.type, prim('int'));
        u.unify(rho, rowOf([['id', prim('int')], ['age', prim('int')]]));
        expect(u.rowLabels(rho).join()).toBe('age,id');
    });

    test('generalization and instantiation', () => {
        const u = new TypeUniverse();
        const rho = u.fresh('row');
        const s = u.generalize([], fun(rho, prim('bool')));
        expect(s.vars.length).toBe(1);
        const inst = u.instantiate(s);
        expect(inst.kind).toBe('fun');
    });

    test('occurs check', () => {
        const u = new TypeUniverse();
        const a = u.fresh();
        expect(() => u.unify(a, listOf(a))).toThrow(UnifyError);
    });

    test('rigid (skolemized) variables cannot be bound; flexible can bind to them', () => {
        const u = new TypeUniverse();
        const a = u.fresh();
        const { type, restore } = u.skolemize(a);
        try {
            expect(() => u.unify(type, prim('int'))).toThrow(UnifyError);
            const b = u.fresh();
            u.unify(b, type); // flexible := rigid is fine
        } finally {
            restore();
        }
    });
});

// ---------------------------------------------------------------------------
// Row polymorphism
// ---------------------------------------------------------------------------

describe('row polymorphism', () => {
    test('a row lambda is typed once and reused on different schemas', () => {
        const kids = `kids: query { id: int, age: int, guardian: string } = table "kids"`;
        const module = `${USERS}\n${kids}\nadult = u => u.age >= 18\nq1 = users & filter (adult)\nq2 = kids & filter (adult)`;
        expect(typeErrors(module)).toEqual([]);
    });

    test('a reusable step binds polymorphically', () => {
        const byAge = `by_age = sort (u => [desc u.age])`;
        expect(typeErrors(`${USERS}\n${byAge}\nq = users & by_age & take 5`)).toEqual([]);
    });

    test('constraints on later fields propagate into the row (fieldOf must return the stored type)', () => {
        // u.id is bound to float by the comparison; the row must record that,
        // so the mismatch with the int column is caught at the pipeline.
        const messages = typeErrors(`${USERS}\nf = u => u.id >= 1.5 && u.age >= 18\nq = users & filter (f)`);
        expect(messages.join('\n')).toContain('cannot mix int and float');
    });

    test('map, fold, join, composition and $n all type-check', () => {
        expect(typeErrors(`${USERS}
            orders: query { user_id: int, total: float } = table "orders"
            paid = orders & filter (o => o.status == "paid")
            q = users
                & filter ($1.active && $1.age >= 18)
                & map (u => { id = u.id, name = upper u.name, age = u.age })
                & sort (u => [asc u.name])
                & fold (r => { id = group r.id, n = count r.id })
        `)).toEqual([]);
        expect(typeErrors(`${USERS}
            orders: query { user_id: int } = table "orders"
            q = users & join inner orders (l => r => l.id == r.user_id) (l => r => { uid = l.id, oid = r.user_id })
        `)).toEqual([]);
        expect(typeErrors(`${USERS}
            adult = u => u.age >= 18
            q = users & filter (adult <<< (x => x + 1))
        `)).toEqual([]);
    });

    test('row polymorphism survives map projections (the row narrows)', () => {
        expect(typeErrors(`${USERS}\nq = users & map (u => { id = u.id, age = u.age }) & filter (u => u.age >= 18)`)).toEqual([]);
    });
});

// ---------------------------------------------------------------------------
// Strict numerics
// ---------------------------------------------------------------------------

describe('strict numerics', () => {
    test('int/float do not mix', () => {
        expect(typeErrors(`${USERS}\nq = users & map (u => { x = 1 + 2.5 })`).join('\n')).toContain('of the same type');
        expect(typeErrors(`${USERS}\nq = users & map (u => { x = u.age + 1.5 })`).join('\n')).toContain('cannot mix int and float');
        expect(typeErrors(`${USERS}\nq = users & filter (u => u.age >= 100.0)`).join('\n')).toContain('cannot mix int and float');
    });

    test('matching numerics are fine', () => {
        expect(typeErrors(`${USERS}\nq = users & filter (u => u.age >= 100)`)).toEqual([]);
        expect(typeErrors(`orders: query { total: float } = table "orders"\nq = orders & filter (o => o.total >= 100.0)`)).toEqual([]);
        expect(typeErrors(`orders: query { total: float } = table "orders"\nq = orders & fold (o => { s = sum o.total, m = min o.total })`)).toEqual([]);
    });

    test('a decimal literal is float even when its value is integral (100.0)', () => {
        // 100.0 is float by syntax, so comparing a float column with it is fine.
        expect(typeErrors(`orders: query { total: float } = table "orders"\nq = orders & filter (o => o.total >= 100.0)`)).toEqual([]);
    });
});

// ---------------------------------------------------------------------------
// Nullability (Maybe-style `t?`)
// ---------------------------------------------------------------------------

describe('nullability', () => {
    test('null unifies with any type in comparisons and coalesce', () => {
        expect(typeErrors(`${USERS}\nq = users & filter (u => u.name == null)`)).toEqual([]);
        expect(typeErrors(`${USERS}\nq = users & filter (u => u.name != null && u.age >= 18)`)).toEqual([]);
        expect(typeErrors(`${USERS}\nq = users & map (u => { x = coalesce u.name null })`)).toEqual([]);
    });

    test('nullable columns work in arithmetic and projections', () => {
        expect(typeErrors(`${USERS}\nq = users & map (u => { x = u.age + 1 }) & filter (r => r.x > 18)`)).toEqual([]);
    });

    test('nullable types are expressible in annotations', () => {
        expect(typeErrors(`${USERS}\nq = users & filter (u: { age: int? | r }) => u.age >= 18`)).toEqual([]);
    });

    test('null == null stays an interpreter (semantic) error', () => {
        expect(allErrors(`${USERS}\nq = users & filter (u => null == null)`).join('\n')).toContain('cannot compare null with null');
    });
});

// ---------------------------------------------------------------------------
// Type annotations
// ---------------------------------------------------------------------------

describe('annotations and ascription', () => {
    test('binding annotation with an open row', () => {
        expect(typeErrors(`${USERS}\nadult: { age: int | r } -> bool = u => u.age >= 18\nq = users & filter (adult)`)).toEqual([]);
    });

    test('binding annotation narrowing to a closed row', () => {
        expect(typeErrors(`${USERS}\nadult: { age: int } -> bool = u => u.age >= 18\nq = users & filter (adult)`)).toEqual([]);
    });

    test('binding annotation missing the used field is an error', () => {
        const messages = typeErrors(`${USERS}\nadult: { a: int | r } -> bool = u => u.age >= 18\nq = users & filter (adult)`);
        expect(messages.join('\n')).toContain('does not match inferred type');
    });

    test('lambda-parameter annotations check the body against the annotation', () => {
        expect(typeErrors(`${USERS}\nq = users & filter (u: { age: int | r }) => u.age >= 18`)).toEqual([]);
        const messages = typeErrors(`${USERS}\nq = users & filter (u: { age: int | r }) => u.name == "x"`);
        expect(messages.join('\n')).toContain("unknown column 'name'");
    });

    test('expression ascription on any expression', () => {
        expect(typeErrors(`${USERS}\nq = users & map (u => { x = u.age: int })`)).toEqual([]);
        expect(typeErrors(`${USERS}\nq = users & filter (u => (u.age >= 18: bool))`)).toEqual([]);
        // strict: (5: float) fails
        expect(typeErrors(`${USERS}\nq = users & map (u => { x = (5: float) })`).join('\n')).toContain('does not match inferred type');
    });

    test('the binding annotation defines a bare table\'s schema', () => {
        // The annotation IS the schema — nothing to contradict, so any closed
        // query type is accepted; the interpreter decodes it at runtime.
        expect(typeErrors(`q: query { id: int } = table "users"`)).toEqual([]);
        expect(typeErrors(`q: query { id: string } = table "users"`)).toEqual([]);
        // Non-table bindings are checked as signatures:
        expect(typeErrors(`q: query { id: string } = 42`).join('\n')).toContain('does not match inferred type');
    });

    test('non-scalar table columns are rejected at runtime', () => {
        expect(allErrors(`q: query { id: int, f: int -> int } = table "users"`).join('\n')).toContain("schema entry 'f' must be a scalar type");
    });

    test('unknown type names are errors', () => {
        expect(typeErrors(`${USERS}\nx: Foo -> bool = u => u.age >= 18\nq = users & filter (x)`).join('\n')).toContain("unknown type 'Foo'");
    });
});

// ---------------------------------------------------------------------------
// Type errors (inference) and dedupe with the interpreter
// ---------------------------------------------------------------------------

describe('type errors', () => {
    test('unknown column on a closed row', () => {
        // Inside a row lambda the row is open until it meets a concrete schema,
        // so the interpreter reports it; on a closed record literal inference does.
        expect(allErrors(`${USERS}\nq = users & filter (u => u.missing == 1)`).join('\n')).toContain("unknown column 'missing' — available: id, name, age, active");
        expect(typeErrors(`${USERS}\nq = users & map (u => { a = { x = 1 }.y })`).join('\n')).toContain("unknown column 'y' — available: x");
    });

    test('accessing a query directly is the interpreter message', () => {
        expect(allErrors(`${USERS}\nq = users.id`).join('\n')).toContain('tables have no fields');
    });

    test('heterogeneous list items', () => {
        expect(typeErrors(`${USERS}\nq = users & filter (u => is_in u.age [1, 2, "x"])`).join('\n')).toContain('must match type int, got string');
    });

    test('filter with a non-lambda argument', () => {
        expect(typeErrors(`${USERS}\nq = users & filter 5`).join('\n')).toContain('filter expects a one-parameter predicate lambda or function');
    });

    test('map with a scalar projection is rejected', () => {
        expect(allErrors(`${USERS}\nq = users & map (u => u.age)`).join('\n')).toContain('projection must be a record');
    });

    test('table takes only a name', () => {
        expect(allErrors(`t = table "t" { a = 42 }`).join('\n')).toContain('table takes a single argument');
    });

    test('deferred operator errors surface once through the merged path', () => {
        // The interpreter reports these precisely; inference stays silent, so
        // the merged view has exactly one diagnostic.
        const messages = allErrors(`${USERS}\nq = users & filter (u => u.age == "yes")`);
        expect(messages.join('\n')).toContain('cannot compare int with string');
        expect(messages.length).toBeGreaterThan(0);
        expect(messages.filter(m => m === 'cannot compare int with string').length).toBe(1);
    });

    test('join overlap is not an error — the merger picks the output row', () => {
        const messages = allErrors(`${USERS}
            orders: query { id: int, user_id: int } = table "orders"
            q = users & join inner orders (l => r => l.id == r.id) (l => r => { left_id = l.id, right_id = r.id })
        `);
        expect(messages).toEqual([]);
        const sql = render(`${USERS}
            orders: query { id: int, user_id: int } = table "orders"
            q = users & join inner orders (l => r => l.id == r.id) (l => r => { left_id = l.id, right_id = r.id })
        `);
        expect(sql).toContain('ON users.id = orders.id');
        expect(sql).toContain('users.id AS left_id');
        expect(sql).toContain('orders.id AS right_id');
    });

    test('valid modules have zero diagnostics (check and render agree)', () => {
        expect(typeErrors(`${USERS}\nq = users & take 5`)).toEqual([]);
        const sql = render(`${USERS}\nq = users & filter (u => u.age >= 18) & map (u => { id = u.id }) : query { id: int }`);
        expect(sql).toContain('SELECT');
    });
});

// ---------------------------------------------------------------------------
// Table schemas are record types (no types-as-values)
// ---------------------------------------------------------------------------

describe('table schemas are types', () => {
    test('un-annotated tables are dynamic: the row type is inferred from use', () => {
        const src = `users = table "users"\nq = users & filter (u => u.age >= 18) & take 5`;
        expect(typeErrors(src)).toEqual([]);
        const sql = render(src);
        expect(sql).toContain('SELECT *');
        expect(sql).toContain('WHERE age >= 18');
    });

    test('dynamic tables render whatever columns are referenced', () => {
        const sql = render(`q = table "users" & map (u => { id = u.id, n = upper u.name })`);
        expect(sql).toContain([
            'SELECT',
            '    id,',
            '    UPPER(name) AS n',
        ].join('\n'));
    });

    test('a bare table alone renders SELECT *', () => {
        const sql = render(`q = table "users" & take 2`);
        expect(sql).toContain('SELECT *');
        expect(sql).toContain('FROM users');
    });

    test('dynamic joins qualify both sides', () => {
        const sql = render(`users = table "users"\norders = table "orders"\nq = users & join inner orders ($1.id == $2.user_id) { uid = $1.id, oid = $2.user_id }`);
        expect(sql).toContain('ON users.id = orders.user_id');
    });

    test('annotated tables still catch unknown columns; dynamic ones do not', () => {
        expect(allErrors(`users: query { id: int } = table "users"\nq = users & filter (u => u.nope)`).join('\n')).toContain("unknown column 'nope'");
        expect(typeErrors(`q = table "users" & filter (u => u.nope == 1)`)).toEqual([]);
    });

    test('dynamic tables relax type checks (no false positives)', () => {
        // With an unknown schema nothing is statically wrong; SQL still renders.
        const sql = render(`q = table "users" & filter (u => u.age == "x" && u.name + 1)`);
        expect(sql).toContain([
            'WHERE',
            "    age = 'x'",
            '    AND name + 1',
        ].join('\n'));
    });

    test('nullable columns are written explicitly with `?`', () => {
        expect(typeErrors(`users: query { id: int, email: string? } = table "users"\nq = users & filter (u => u.email == null)`)).toEqual([]);
    });

    test('open schemas are rejected at runtime', () => {
        expect(allErrors(`q: query { id: int | r } = table "users"`).join('\n')).toContain('must be a closed record');
    });

    test('non-scalar column types are rejected at runtime', () => {
        expect(allErrors(`q: query { id: int, f: int -> int } = table "users"`).join('\n')).toContain("schema entry 'f' must be a scalar type");
    });

    test('value-level type constants are gone', () => {
        expect(allErrors(`x = int\nq = x`).join('\n')).toContain("unknown identifier 'int'");
    });

    test('the module query may itself be an annotated table', () => {
        const sql = render(`q: query { id: int } = table "users"`);
        expect(sql).toContain('FROM users');
    });
});

// ---------------------------------------------------------------------------
// Paren-free application (bare identifiers as arguments)
// ---------------------------------------------------------------------------

describe('paren-free application', () => {
    const USERS2 = `users: query { id: int, name: string, age: int, active: bool } = table "users"`;

    test('bare identifiers are arguments without parens', () => {
        expect(typeErrors(`${USERS2}\nadult = u => u.active && u.age >= 18\nq = users & filter adult & take 5`)).toEqual([]);
        const sql = render(`${USERS2}\nadult = u => u.active && u.age >= 18\nq = users & filter adult`);
        expect(sql).toContain([
            'WHERE',
            '    active',
            '    AND age >= 18',
        ].join('\n'));
    });

    test('an application ending in a bare identifier cannot swallow the next binding', () => {
        const src = `${USERS2}\nadult = u => u.active\nq = users & filter adult\nnext = users & take 1`;
        expect(typeErrors(src)).toEqual([]);
        expect(render(src)).toContain('LIMIT 1');
    });

    test('annotated bindings after a bare-identifier argument are not swallowed', () => {
        const src = `users: query { id: int, active: bool } = table "users"\nby_active = filter ($1.active)\nq = users & by_active\nnext: query { id: int, active: bool } = users & take 2`;
        expect(typeErrors(src)).toEqual([]);
    });

    test('zero-arg steps still do not swallow the next binding', () => {
        const src = `${USERS2}\nq = users & distinct\nx = users & take 1`;
        expect(typeErrors(src)).toEqual([]);
    });

    test('join with a bare-identifier right side still works', () => {
        const src = `users: query { id: int } = table "users"\norders: query { user_id: int } = table "orders"\nq = users & join inner orders ($1.id == $2.user_id) { uid = $1.id, oid = $2.user_id }`;
        expect(typeErrors(src)).toEqual([]);
    });

    test('parens remain valid', () => {
        expect(typeErrors(`${USERS2}\nadult = u => u.age >= 18\nq = users & filter (adult)`)).toEqual([]);
    });

    test('ascribing an application that ends in a bare identifier needs parens', () => {
        // `filter adult : bool` would lex `adult` as ID (followed by `:`), so
        // it is a parse error — the documented workaround is parens.
        expect(() => parseModel(`${USERS2}\nadult = u => u.active\nq = filter adult : bool`)).toThrow();
        expect(() => parseModel(`${USERS2}\nadult = u => u.active\nq = filter (adult) : bool`)).not.toThrow();
    });

    test('map keys followed by a comment still parse', () => {
        expect(typeErrors(`${USERS2}\nq = users & map (u => { id # the id\n = u.id })`)).toEqual([]);
    });
});

// ---------------------------------------------------------------------------
// Imported modules share the type environment
// ---------------------------------------------------------------------------

describe('imports', () => {
    test('imported polymorphic bindings type-check', () => {
        // Simulate a two-module project (imports first, root last): the
        // tables module EXPORTS its bindings, the root flat-imports them.
        const tables: ProjectModule = {
            model: parseModel(`export users: query { id: int, age: int } = table "users"\nexport adult = u => u.age >= 18`),
            uri: 'tables.tetaue',
            imports: [],
        };
        const rootModel = parseModel(`import "tables.tetaue"\nq = users & filter (adult)`);
        const root: ProjectModule = {
            model: rootModel,
            uri: 'main.tetaue',
            imports: [{ alias: undefined, target: tables, importNode: rootModel.imports[0]! }],
        };
        const { diagnostics } = inferProject([tables, root]);
        expect(diagnostics).toEqual([]);
    });

    test('qualified access instantiates exported schemes (row polymorphism)', () => {
        const helpers: ProjectModule = {
            model: parseModel(`export adult = u => u.age >= 18`),
            uri: 'helpers.tetaue',
            imports: [],
        };
        const rootModel = parseModel(`
            import "helpers.tetaue" as h
            users: query { id: int, age: int } = table "users"
            kids: query { id: int, age: int, guardian: string } = table "kids"
            q = users & filter (h.adult) & take 1
            q2 = kids & filter (h.adult) & take 1
        `);
        const root: ProjectModule = {
            model: rootModel,
            uri: 'main.tetaue',
            imports: [{ alias: 'h', target: helpers, importNode: rootModel.imports[0]! }],
        };
        const { diagnostics } = inferProject([helpers, root]);
        expect(diagnostics).toEqual([]);
    });

    test('a non-exported binding is invisible through the namespace', () => {
        const helpers: ProjectModule = {
            model: parseModel(`adult = u => u.age >= 18`),
            uri: 'helpers.tetaue',
            imports: [],
        };
        const rootModel = parseModel(`
            import "helpers.tetaue" as h
            users: query { id: int, age: int } = table "users"
            q = users & filter (h.adult)
        `);
        const root: ProjectModule = {
            model: rootModel,
            uri: 'main.tetaue',
            imports: [{ alias: 'h', target: helpers, importNode: rootModel.imports[0]! }],
        };
        const { diagnostics } = inferProject([helpers, root]);
        expect(diagnostics.map(d => d.message).join('\n')).toContain("module 'h' has no exported binding 'adult'");
    });
});

// ---------------------------------------------------------------------------
// DSL modes are types: jkind, order, aggregate/group (B)
// ---------------------------------------------------------------------------

describe('DSL modes are static types', () => {
    test('join kinds are a dedicated type — a string kind is a type error', () => {
        const src = `${USERS}\norders: query { user_id: int } = table "orders"\nq = users & join "inner" orders (l => r => l.id == r.user_id) (l => r => { uid = l.id })`;
        const messages = allErrors(src);
        expect(messages.join('\n')).toContain('join expects a join kind as its first argument: inner, left, right or full');
        expect(messages.length).toBe(1); // interpreter + inference dedupe on (node, message)
    });

    test('join with a bare kind still type-checks', () => {
        expect(typeErrors(`${USERS}\norders: query { user_id: int } = table "orders"\nq = users & join inner orders (l => r => l.id == r.user_id) (l => r => { uid = l.id })`)).toEqual([]);
    });

    test('sort requires order items, not a plain column', () => {
        const messages = typeErrors(`${USERS}\nq = users & sort (u => u.name)`);
        expect(messages.join('\n')).toContain('sort expects order items like asc u.name or a list of them');
    });

    test('sort accepts a single order item and a list of them', () => {
        expect(typeErrors(`${USERS}\nq = users & sort (u => asc u.name)`)).toEqual([]);
        expect(typeErrors(`${USERS}\nq = users & sort (u => [asc u.name, desc u.age])`)).toEqual([]);
    });

    test('fold entries must be aggregate or group mode', () => {
        const messages = allErrors(`${USERS}\nq = users & fold (o => { x = o.age })`);
        expect(messages.join('\n')).toContain("fold entry 'x' must be wrapped in an aggregate (count, sum, ...) or group");
    });

    test('fold without any aggregate is a static error', () => {
        const messages = typeErrors(`${USERS}\nq = users & fold (o => { x = group o.age })`);
        expect(messages.join('\n')).toContain('fold must contain at least one aggregate (count, sum, ...)');
    });

    test('map projections reject group keys and order items', () => {
        expect(typeErrors(`${USERS}\nq = users & map (u => { g = group u.age })`).join('\n')).toContain("projection entry 'g' cannot contain group");
        expect(typeErrors(`${USERS}\nq = users & map (u => { o = asc u.age })`).join('\n')).toContain("projection entry 'o' cannot contain order items (asc/desc)");
    });

    test('a fold result row is plain: HAVING filters and ORDER BY on aggregate columns work', () => {
        const src = `${USERS}\norders: query { user_id: int, total: float } = table "orders"\nq = users\n    & join inner orders (l => r => l.id == r.user_id) (l => r => { uid = l.id, total = r.total })\n    & fold (r => { uid = group r.uid, total = sum r.total })\n    & filter (r => r.total > 100.0)\n    & sort (r => [desc r.total])`;
        expect(typeErrors(src)).toEqual([]);
    });

    test('map after a fold may re-aggregate (nested aggregation)', () => {
        const src = `${USERS}\norders: query { user_id: int, total: float } = table "orders"\nq = orders\n    & fold (o => { user_id = group o.user_id, total = sum o.total })\n    & map (r => { grand = sum r.total })`;
        expect(typeErrors(src)).toEqual([]);
    });

    test('aggregates type as agg mode; windowed aggregates keep their value type', () => {
        expect(typeErrors(`${USERS}\nq = users & map (u => { ws = over (sum u.age) { partition = [u.id] } })`)).toEqual([]);
        expect(typeErrors(`${USERS}\nq = users & map (u => { x = sum u.age })`)).not.toContain('cannot compare');
    });
});
