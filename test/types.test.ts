import { describe, expect, test } from 'bun:test';
import { parseModel, typeErrors, allErrors, render, services } from './helpers.ts';
import { checkProject } from '../src/language/checker.ts';
import {
    ConstraintError, TypeUniverse, UnifyError, type Type,
    fun, listOf, maybeOf, nullExtendedMaybeOf, prim, queryOf, rowOf,
} from '../src/language/types.ts';
import { inferProject } from '../src/language/inference.ts';
import { standardPrelude } from '../src/language/prelude.ts';
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

    test('maybe is a distinct type constructor: no implicit absorption', () => {
        const u = new TypeUniverse();
        expect(u.unify(maybeOf(prim('int')), maybeOf(prim('int'))).kind).toBe('maybe');
        expect(() => u.unify(maybeOf(prim('int')), prim('int'))).toThrow(UnifyError);
        expect(() => u.unify(prim('int'), maybeOf(prim('int')))).toThrow(UnifyError);
        expect(() => u.unify(maybeOf(prim('int')), maybeOf(prim('string')))).toThrow(UnifyError);
        const a = u.fresh();
        expect(() => u.unify(a, maybeOf(a))).toThrow(UnifyError); // occurs check, no α ~ maybe α
    });

    test('SQL null extension is idempotent without flattening explicit Maybe', () => {
        const u = new TypeUniverse();
        const delayed = u.fresh();
        const extended = nullExtendedMaybeOf(delayed);
        u.unify(delayed, maybeOf(prim('int')));
        expect(u.pretty(extended)).toBe('(maybe int)');
        expect(u.pretty(maybeOf(maybeOf(prim('int'))))).toBe('(maybe (maybe int))');
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

    test('class constraints survive schemes and failed constrained unification rolls back', () => {
        const u = new TypeUniverse();
        const a = u.fresh();
        u.constrain(a, 'Num');
        const numericIdentity = u.generalize([], fun(a, a));
        expect(u.pretty(numericIdentity.type)).toMatch(/^Num (t\d*) => \1 -> \1$/);

        const invalid = u.instantiate(numericIdentity);
        expect(() => u.unify(invalid, fun(prim('string'), prim('string')))).toThrow(ConstraintError);

        const valid = u.instantiate(numericIdentity);
        expect(() => u.unify(valid, fun(prim('decimal'), prim('decimal')))).not.toThrow();

        const transactional = u.fresh();
        expect(() => u.unifyConstrained(transactional, prim('string'), 'Num')).toThrow(ConstraintError);
        expect(() => u.unify(transactional, prim('int'))).not.toThrow();
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
            orders: query { user_id: int, total: float, status: string } = table "orders"
            paid = orders & filter (o => o.status == "paid")
            q = users
                & filter ($1.active && $1.age >= 18)
                & map (u => { id = u.id, name = upper u.name, age = u.age })
                & sort (u => [asc u.name])
                & fold (r => { id = group r.id, n = count r.id })
        `)).toEqual([]);
        expect(typeErrors(`${USERS}
            orders: query { user_id: int } = table "orders"
            q = users & joinInner orders (l => r => l.id == r.user_id) (l => r => { uid = l.id, oid = r.user_id })
        `)).toEqual([]);
        expect(typeErrors(`${USERS}
            adult = u => u.age >= 18
            q = users & filter ((u => u.active) <<< (u => u))
        `)).toEqual([]);
        expect(typeErrors(`${USERS}
            adult = u => u.age >= 18
            q = users & filter (adult <<< (x => x + 1))
        `).join('\n')).toContain('cannot apply');
    });

    test('row polymorphism survives map projections (the row narrows)', () => {
        expect(typeErrors(`${USERS}\nq = users & map (u => { id = u.id, age = u.age }) & filter (u => u.age >= 18)`)).toEqual([]);
    });
});

// ---------------------------------------------------------------------------
// Strict numerics
// ---------------------------------------------------------------------------

describe('strict numerics', () => {
    test('arithmetic lambdas retain a Num constraint after generalization', () => {
        const model = parseModel('add = x => y => x + y\nnegate = x => -x\nq = add');
        const result = inferProject(
            [{ model, uri: undefined, imports: [] }],
            new Map(),
            standardPrelude(services),
        );
        expect(result.typeOf(model.bindings[0]!)).toBe('Num t => t -> t -> t');
        expect(result.typeOf(model.bindings[1]!)).toBe('Num t => t -> t');
        expect(result.diagnostics).toEqual([]);

        expect(typeErrors('add = x => y => x + y\nq = add "a" "b"')).toEqual([
            'Num requires a numeric type, got string',
        ]);
        expect(typeErrors('negate = x => -x\nq = negate "a"')).toEqual([
            'Num requires a numeric type, got string',
        ]);
    });

    test('int/float do not mix', () => {
        expect(typeErrors(`${USERS}\nq = users & map (u => { x = 1 + 2.5 })`).join('\n')).toContain('of the same type');
        expect(typeErrors(`${USERS}\nq = users & map (u => { x = u.age + 1.5 })`).join('\n')).toContain('cannot mix int and float');
        expect(typeErrors(`${USERS}\nq = users & filter (u => u.age >= 100.0)`).join('\n')).toContain('cannot mix int and float');
    });

    test('decimal is a Num instance and still does not mix with other numeric types', () => {
        const direct = `d: decimal = cast 1 "decimal"\ni: int = 1\nq = d + i`;
        expect(typeErrors(direct).join('\n')).toContain('numeric operands of the same type');

        const throughRow = `orders: query { total: decimal } = table "orders"
q = orders & map (o => { x = o.total + 1 })`;
        expect(typeErrors(throughRow).join('\n')).toContain('cannot mix numeric types (decimal vs int)');
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

describe('closed typeclass instances', () => {
    test('container classes have explicit closed instances', () => {
        const u = new TypeUniverse();
        expect(() => u.constrain(maybeOf(prim('int')), 'Applicative')).not.toThrow();
        expect(() => u.constrain(listOf(prim('int')), 'Alternative')).not.toThrow();
        expect(() => u.constrain(listOf(prim('int')), 'Monad')).not.toThrow();
        expect(() => u.constrain(queryOf(rowOf([['id', prim('int')]])), 'Functor')).not.toThrow();
        expect(() => u.constrain(queryOf(rowOf([['id', prim('int')]])), 'Monad')).toThrow(ConstraintError);
    });

    test('Eq and Ord cover the supported scalar primitives', () => {
        const source = `users: query { id: int, name: string, active: bool } = table "users"
q = users & filter (u => u.id >= 1 && u.name < "z" && u.active == true)`;
        expect(typeErrors(source)).toEqual([]);
    });

    test('record equality and unsupported semigroup operands are rejected', () => {
        const equality = `q = table "users" & filter (u => { id = u.id } == { id = 1 })`;
        expect(typeErrors(equality).join('\n')).toContain('cannot compare');
        const semigroup = `q = table "users" & map (u => { value = u.id <> 1 })`;
        expect(typeErrors(semigroup).join('\n')).toContain('Semigroup');
    });

    test('string and list semigroup operations type-check', () => {
        expect(typeErrors(`q = table "users" & map (u => { value = u.name <> "!" })`)).toEqual([]);
        expect(typeErrors(`values = [1, 2] <> [3]
q = table "users"`)).toEqual([]);
    });
});

// ---------------------------------------------------------------------------
// Nullability (Maybe-style `t?`)
// ---------------------------------------------------------------------------

describe('nullability', () => {
    test('null only unifies with maybe values (no implicit conversion)', () => {
        // A non-null string column cannot be compared with null — is_null is
        // the explicit way to ask "is this nullable value missing?".
        expect(typeErrors(`${USERS}\nq = users & filter (u => u.name == null)`)).not.toEqual([]);
        expect(typeErrors(`users: query { name: (maybe string) } = table "users"\nq = users & filter (u => is_null u.name)`)).toEqual([]);
        expect(typeErrors(`users: query { name: (maybe string), fallback: string } = table "users"\nq = users & map (u => { x = coalesce u.name (just u.fallback) })`)).toEqual([]);
    });

    test('nullable columns work in arithmetic and projections', () => {
        expect(typeErrors(`${USERS}\nq = users & map (u => { x = u.age + 1 }) & filter (r => r.x > 18)`)).toEqual([]);
    });

    test('nullable types are expressible in annotations and require explicit unwrapping', () => {
        expect(typeErrors(`${USERS}\nq = users & filter (u: { age: (maybe int) | r }) => u.age >= 18`).join('\n')).toContain('cannot compare');
        expect(typeErrors(`users_maybe: query { age: (maybe int), name: string } = table "users_maybe"\nq = users_maybe & filter (u: { age: (maybe int) | r }) => from_maybe 0 u.age >= 18`)).toEqual([]);
    });

    test('null == null stays an interpreter (semantic) error', () => {
        expect(allErrors(`${USERS}\nq = users & filter (u => null == null)`).join('\n')).toContain('cannot compare null with null');
    });
});

// ---------------------------------------------------------------------------
// Type annotations
// ---------------------------------------------------------------------------

describe('type aliases', () => {
    test('module-local aliases expand in query schemas and signatures', () => {
        const src = `type UserRow = query { id: int, name: string, age: int }
type AdultRow = { age: int | r }
adult: AdultRow -> bool = u => u.age >= 18
users: UserRow = table "users"
q = users & filter (adult) & map (u => { id, name })`;
        expect(typeErrors(src)).toEqual([]);
        const model = parseModel(src);
        const result = inferProject(
            [{ model, uri: undefined, imports: [] }],
            new Map(),
            standardPrelude(services),
        );
        const usersBinding = model.bindings.find(b => b.name === 'users')!;
        expect(result.typeOf(usersBinding)).toBe('query { age: int, id: int, name: string }');
    });

    test('recursive aliases are diagnosed, not expanded forever', () => {
        expect(typeErrors(`type A = A\nt: A = table "t"\nq = t`).join('\n')).toContain("recursive type alias 'A'");
    });
});

describe('annotations and ascription', () => {
    test('binding annotation with an open row', () => {
        expect(typeErrors(`${USERS}\nadult: { age: int | r } -> bool = u => u.age >= 18\nq = users & filter (adult)`)).toEqual([]);
    });

    test('binding annotation narrowing to a closed row', () => {
        // The annotation becomes the binding type, so applying the closed-row
        // predicate to a wider users row is a static row mismatch.
        const messages = typeErrors(`${USERS}\nadult: { age: int } -> bool = u => u.age >= 18\nq = users & filter (adult)`);
        expect(messages.join('\n')).toContain('to an argument of type query { age: int } -> query { age: int }');
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

    test('duplicate fields in type annotations are errors', () => {
        const messages = typeErrors(`t: query { a: int, a: string } = table "t"`);
        expect(messages.join('\n')).toContain("duplicate field 'a' in query type");
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
            q = users & joinInner orders (l => r => l.id == r.id) (l => r => { left_id = l.id, right_id = r.id })
        `);
        expect(messages).toEqual([]);
        const sql = render(`${USERS}
            orders: query { id: int, user_id: int } = table "orders"
            q = users & joinInner orders (l => r => l.id == r.id) (l => r => { left_id = l.id, right_id = r.id })
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
    test('dynamic tables are shared holes, not forall rows', () => {
        // q1 binds id:int; q2 later requires id:string — the two uses of the
        // same table hole are unified together, so the conflict is reported.
        const conflict = typeErrors(`t = table "t"
q1 = t & map (u => { a = u.id + 1 })
q2 = t & map (u => { b = u.id == "x" })`);
        expect(conflict.join('\n')).toContain('cannot apply');
        // A user-written hole annotation is a named metavariable.
        const holes = `f: ?a -> ?a = x => x
users: query { id: int } = table "users"
q = users & map (u => { id = f u.id })`;
        expect(typeErrors(holes)).toEqual([]);
        const model = parseModel('t = table "users"');
        const result = inferProject(
            [{ model, uri: undefined, imports: [] }],
            new Map(),
            standardPrelude(services),
        );
        expect(result.typeOf(model.bindings[0]!)).toBe('query ?table_users');
    });

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
        const sql = render(`users = table "users"\norders = table "orders"\nq = users & joinInner orders ($1.id == $2.user_id) { uid = $1.id, oid = $2.user_id }`);
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
        expect(typeErrors(`users: query { id: int, email: (maybe string) } = table "users"\nq = users & filter (u => u.email == null)`)).toEqual([]);
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
        const src = `users: query { id: int } = table "users"\norders: query { user_id: int } = table "orders"\nq = users & joinInner orders ($1.id == $2.user_id) { uid = $1.id, oid = $2.user_id }`;
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
        const { diagnostics } = inferProject([tables, root], new Map(), standardPrelude(services));
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
        const { diagnostics } = inferProject([helpers, root], new Map(), standardPrelude(services));
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
        const { diagnostics } = inferProject([helpers, root], new Map(), standardPrelude(services));
        expect(diagnostics.map(d => d.message).join('\n')).toContain("module 'h' has no exported binding 'adult'");
    });
});

// ---------------------------------------------------------------------------
// DSL modes are types: order and aggregate/group (B)
// ---------------------------------------------------------------------------

describe('DSL modes are static types', () => {
    test('the removed general join is not in the public prelude', () => {
        const src = `${USERS}\norders: query { user_id: int } = table "orders"\nq = users & join orders (l => r => l.id == r.user_id) (l => r => { uid = l.id })`;
        const messages = allErrors(src);
        expect(messages.join('\n')).toContain("unknown identifier 'join'");
    });

    test('all fixed-kind joins type-check', () => {
        for (const name of ['joinInner', 'joinLeft', 'joinRight', 'joinFull']) {
            expect(typeErrors(`${USERS}\norders: query { user_id: int } = table "orders"\nq = users & ${name} orders (l => r => l.id == r.user_id) (l => r => { uid = l.id })`)).toEqual([]);
        }
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
        const src = `${USERS}\norders: query { user_id: int, total: float } = table "orders"\nq = users\n    & joinInner orders (l => r => l.id == r.user_id) (l => r => { uid = l.id, total = r.total })\n    & fold (r => { uid = group r.uid, total = sum r.total })\n    & filter (r => from_maybe 0.0 r.total > 100.0)\n    & sort (r => [desc r.total])`;
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

describe('review fixes: composition types, merge partials, shadowing, case nullability', () => {
    function typeOf(text: string, binding: string): string | undefined {
        const model = parseModel(text);
        const result = inferProject(
            [{ model, uri: undefined, imports: [] }],
            new Map(),
            standardPrelude(services),
        );
        const b = model.bindings.find(x => x.name === binding);
        return b ? result.typeOf(b) : undefined;
    }

    test('composition infers a function type, not its result type', () => {
        expect(typeOf('f = upper <<< lower', 'f')).toBe('string -> string');
    });

    test('partial application of merge keeps the row union', () => {
        const text = `users: query { id: int, name: string } = table "users"
extend = merge { active = true }
q = users & map (u => extend u)`;
        expect(typeErrors(text)).toEqual([]);
        expect(typeOf(text, 'q')).toBe('query { active: bool, id: int, name: string }');
    });

    test('case is nullable only when it has no fallback branch', () => {
        expect(typeOf('q = case { true => 1, _ => 2 }', 'q')).toBe('int');
        expect(typeOf('q = case { true => 1 }', 'q')).toBe('(maybe int)');
    });

    test('special builtin typing is disabled when the prelude name is shadowed', () => {
        expect(typeErrors('map = u => u + 1\nq = map 1')).toEqual([]);
    });

    test('closed-row binding annotations now narrow downstream applications', () => {
        const messages = typeErrors(`${USERS}\nadult: { age: int } -> bool = u => u.age >= 18\nq = users & filter (adult)`);
        expect(messages.join('\n')).toContain('to an argument of type query { age: int } -> query { age: int }');
    });
});

describe('post-review design fixes', () => {
    function typeOf(text: string, binding: string): string | undefined {
        const model = parseModel(text);
        const result = inferProject(
            [{ model, uri: undefined, imports: [] }],
            new Map(),
            standardPrelude(services),
        );
        const b = model.bindings.find(x => x.name === binding);
        return b ? result.typeOf(b) : undefined;
    }

    test('param names share one project-wide type', () => {
        const src = `users: query { id: int, name: string } = table "users"
q = users & map (u => { n = param "x" + 1, s = upper (param "x") })`;
        expect(allErrors(src).join('\n')).toContain('upper expects a string expression, got type int');
        const ok = `users: query { id: int } = table "users"\nq = users & filter (u => u.id == param "x")`;
        expect(allErrors(ok)).toEqual([]);
    });

    test('fixed join functions make only the null-extended side nullable', () => {
        const source = (name: string) => `a: query { id: int, x: string } = table "a"
b: query { id: int, y: string } = table "b"
q = a & ${name} b (l => r => l.id == r.id) merge`;
        const expected = new Map([
            ['joinInner', 'query { id: int, x: string, y: string }'],
            // merge is right-biased, so the overlapping id comes from b.
            ['joinLeft', 'query { id: (maybe int), x: string, y: (maybe string) }'],
            ['joinRight', 'query { id: int, x: (maybe string), y: string }'],
            ['joinFull', 'query { id: (maybe int), x: (maybe string), y: (maybe string) }'],
        ]);
        for (const [name, result] of expected) {
            const joined = source(name);
            expect(typeErrors(joined)).toEqual([]);
            expect(typeOf(joined, 'q')).toBe(result);
        }
    });

    test('outer join merger projections preserve guaranteed fields and constants', () => {
        const source = (name: string) => `a: query { id: int, x: string } = table "a"
b: query { id: int, y: string } = table "b"
q = a & ${name} b (l => r => l.id == r.id) (l => r => {
    lid = l.id, rid = r.id, x = l.x, y = r.y, marker = 1
})`;
        const expected = new Map([
            ['joinLeft', 'query { lid: int, marker: int, rid: (maybe int), x: string, y: (maybe string) }'],
            ['joinRight', 'query { lid: (maybe int), marker: int, rid: int, x: (maybe string), y: string }'],
            ['joinFull', 'query { lid: (maybe int), marker: int, rid: (maybe int), x: (maybe string), y: (maybe string) }'],
        ]);
        for (const [name, result] of expected) {
            const joined = source(name);
            expect(typeErrors(joined)).toEqual([]);
            expect(typeOf(joined, 'q')).toBe(result);
        }
    });

    test('outer join merger must unwrap fields from the null-extended side', () => {
        const src = `a: query { id: int } = table "a"
b: query { id: int } = table "b"
q = a & joinLeft b (l => r => l.id == r.id) (l => r => { id = r.id + 1 })`;
        expect(typeErrors(src).join('\n')).toContain("'+' requires numeric operands, got (maybe int) and int");
    });

    test('null extension does not nest an existing nullable column', () => {
        const source = (name: string) => `a: query { id: int, x: (maybe string) } = table "a"
b: query { id: int, y: (maybe string) } = table "b"
q = a & ${name} b (l => r => l.id == r.id) (l => r => { x = l.x, y = r.y })`;
        const expected = new Map([
            ['joinLeft', 'query { x: (maybe string), y: (maybe string) }'],
            ['joinRight', 'query { x: (maybe string), y: (maybe string) }'],
            ['joinFull', 'query { x: (maybe string), y: (maybe string) }'],
        ]);
        for (const [name, result] of expected) {
            const joined = source(name);
            expect(typeErrors(joined)).toEqual([]);
            expect(typeOf(joined, 'q')).toBe(result);
        }
    });

    test('group_by allows grouping without aggregates', () => {
        const src = `users: query { id: int, name: string } = table "users"
q = users & group_by (u => { id = group u.id, name = group u.name })`;
        expect(allErrors(src)).toEqual([]);
        expect(render(src)).toContain('GROUP BY');
    });

    test('quoted field labels are decoded consistently', () => {
        const src = `a: query { "weird name": string } = table "a"
q = a & map (u => { y = u."weird name" })`;
        expect(allErrors(src)).toEqual([]);
        expect(render(src)).toContain('"weird name"');
    });

    test('decimal is a strict numeric primitive', () => {
        const src = `a: query { price: decimal } = table "a"
q = a & map (u => { p = u.price + u.price, c = cast u.price "decimal" })`;
        expect(allErrors(src)).toEqual([]);
        expect(render(src, 'postgresql')).toContain('CAST(price AS NUMERIC)');
    });
});

describe('variadic coalesce list form', () => {
    test('coalesce [maybe, maybe, just default] types as maybe and renders', () => {
        const src = `a: query { x: (maybe string), y: (maybe string) } = table "a"
q = a & map (u => { c = coalesce [u.x, u.y, just "fallback"] })`;
        expect(allErrors(src)).toEqual([]);
        expect(render(src, 'postgresql')).toContain(`COALESCE(x, y, 'fallback')`);
    });

    test('coalesce list items must all be nullable', () => {
        const messages = typeErrors(`a: query { x: (maybe string) } = table "a"\nq = a & map (u => { c = coalesce [u.x, "fallback"] })`);
        expect(messages.join('\n')).toContain('coalesce requires matching nullable (maybe T) types');
    });
});

describe('typed expression result recording', () => {
    test('checkProject records both the inferred type and runtime value for expression nodes', () => {
        const model = parseModel('x = 1 + 2\n');
        const project = [{ model, uri: undefined, imports: [] }];
        const result = checkProject(project, { requireQuery: false, importsByModule: new Map() });
        const expr = model.bindings[0]!.value;
        expect(result.typeOf(expr)).toBe('int');
        expect(result.nodeValues.get(expr)?.kind).toBe('expr');
    });
});
