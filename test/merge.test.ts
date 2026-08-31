import { describe, expect, test } from 'bun:test';
import { render, errors, typeErrors, allErrors } from './helpers.ts';

const USERS = `users: query {
    id: int,
    name: string,
    age: int,
    balance: float,
} = table "users"`;

describe('merge', () => {
    test('extends a row with computed fields in a projection', () => {
        const sql = render(`
            ${USERS}
            q = users & map (u => merge u { active = u.balance > 100.0 })
        `, 'sqlite');
        // plain columns render bare, the computed field gets an alias
        expect(sql).toContain([
            'SELECT',
            '    id,',
            '    name,',
            '    age,',
            '    balance,',
            '    balance > 100 AS active',
        ].join('\n'));
        expect(sql).toContain('FROM users');
    });

    test('merges two record literals', () => {
        const sql = render(`
            ${USERS}
            q = users & map (u => merge { a = u.id, b = upper u.name } { c = 1 })
        `, 'trino');
        expect(sql).toContain('id AS a');
        expect(sql).toContain('UPPER(name) AS b');
        expect(sql).toContain('1 AS c');
    });

    test('right record wins on overlapping fields (JS spread semantics)', () => {
        const sql = render(`
            ${USERS}
            q = users & map (u => merge u { age = 0 })
        `, 'sqlite');
        // u.age is overridden by the literal: SELECT keeps the literal's age.
        expect(sql).toContain([
            'SELECT',
            '    id,',
            '    name,',
            '    0 AS age,',
            '    balance',
        ].join('\n'));
        expect(sql).not.toContain('age AS age');
    });

    test('merge is row-polymorphic: one helper reused on two tables', () => {
        const src = `
            ${USERS}
            kids: query { id: int, age: int, guardian: string } = table "kids"
            with_flag = u => merge u { flagged = u.age >= 18 }
            q1 = users & map (with_flag)
            q2 = kids & map (with_flag)
        `;
        // The last binding is the query; both map steps must typecheck.
        expect(allErrors(src)).toEqual([]);
    });

    test('merge works in a join merger', () => {
        const sql = render(`
            ${USERS}
            orders: query { id: int, user_id: int } = table "orders"
            q = users & joinInner orders (l => r => l.id == r.user_id) (l => r => merge l { uid = r.user_id })
        `, 'sqlite');
        expect(sql).toContain('orders.user_id AS uid');
        expect(sql).toContain('users.id');
    });

    test('join merger with both rows merged: l => r => merge l r', () => {
        const sql = render(`
            ${USERS}
            orders: query { id: int, user_id: int } = table "orders"
            q = users & joinInner orders (l => r => l.id == r.user_id) (l => r => merge l r)
        `, 'sqlite');
        expect(sql).toContain('users.id');
        expect(sql).toContain('orders.user_id');
        expect(sql).toContain('users.name');
    });

    test('join merger accepts a plain function: join ... merge', () => {
        const sql = render(`
            ${USERS}
            orders: query { id: int, user_id: int } = table "orders"
            q = users & joinInner orders (l => r => l.id == r.user_id) merge
        `, 'sqlite');
        // right-wins: orders.id shadows users.id, so id appears once in SELECT
        expect(sql).toContain([
            'SELECT',
            '    orders.id,',
            '    users.name,',
            '    users.age,',
            '    users.balance,',
            '    orders.user_id',
        ].join('\n'));
        expect(sql).toContain('INNER JOIN orders ON users.id = orders.user_id');
    });

    test('partial application: map (merge { bonus = 1 })', () => {
        const sql = render(`
            ${USERS}
            q = users & map (merge { bonus = 1 })
        `, 'sqlite');
        expect(sql).toContain([
            'SELECT',
            '    1 AS bonus,',
            '    id,',
            '    name,',
            '    age,',
            '    balance',
        ].join('\n'));
    });

    test('merged rows can be filtered downstream', () => {
        const src = `
            ${USERS}
            q = users & map (u => merge u { active = u.balance > 100.0 })
                & filter (v => v.active && v.id > 5)
        `;
        expect(allErrors(src)).toEqual([]);
        expect(render(src, 'sqlite')).toContain('balance > 100 AS active');
        expect(render(src, 'sqlite')).toContain([
            'WHERE',
            '    balance > 100',
            '    AND id > 5',
        ].join('\n'));
    });

    test('merge of two bound record values', () => {
        const sql = render(`
            ${USERS}
            extra = u => { status = "ok" }
            q = users & map (u => merge u (extra u))
        `, 'sqlite');
        expect(sql).toContain("'ok' AS status");
        expect(sql).toContain([
            'SELECT',
            '    id,',
            '    name,',
            '    age,',
            '    balance,',
        ].join('\n'));
    });

    test('rejects non-record arguments', () => {
        expect(errors(`${USERS}\nq = users & map (u => merge u 5)`).join('\n')).toContain('merge expects a record as its second argument');
        expect(errors(`${USERS}\nq = users & map (u => merge 5 u)`).join('\n')).toContain('merge expects a record as its first argument');
        expect(typeErrors(`${USERS}\nq = users & map (u => merge u 5)`).join('\n')).toContain('merge expects a record as its second argument');
    });

    test('rejects merging a row with an unknown schema', () => {
        const src = `
            t = table "t"
            q = t & map (u => merge u { x = 1 })
        `;
        expect(errors(src).join('\n')).toContain('cannot enumerate a row with an unknown schema');
    });

    test('duplicate fields within one literal are still caught', () => {
        expect(errors(`${USERS}\nq = users & map (u => merge { a = u.id, a = u.name } { b = 1 })`).join('\n')).toContain("duplicate map key 'a'");
    });
});

describe('merge infix operator <>', () => {
    test('u <> { ... } renders like merge', () => {
        const sql = render(`
            ${USERS}
            q = users & map (u => u <> { active = u.balance > 100.0 })
        `, 'sqlite');
        expect(sql).toContain([
            'SELECT',
            '    id,',
            '    name,',
            '    age,',
            '    balance,',
            '    balance > 100 AS active',
        ].join('\n'));
    });

    test('chains left-associatively; right-wins resolves to the rightmost value', () => {
        const src = `
            ${USERS}
            q = users & map (u => u <> { a = 1 } <> { a = 2, b = 3 })
        `;
        expect(allErrors(src)).toEqual([]);
        expect(render(src, 'sqlite')).toContain([
            'SELECT',
            '    id,',
            '    name,',
            '    age,',
            '    balance,',
            '    2 AS a,',
            '    3 AS b',
        ].join('\n'));
    });

    test('{} is the identity: u <> {} and {} <> u', () => {
        const identity = [
            'SELECT',
            '    id,',
            '    name,',
            '    age,',
            '    balance',
        ].join('\n');
        expect(render(`${USERS}\nq = users & map (u => u <> {})`, 'sqlite')).toContain(identity);
        expect(render(`${USERS}\nq = users & map (u => {} <> u)`, 'sqlite')).toContain(identity);
    });

    test('works with this/that implicit lambdas', () => {
        const src = `
            ${USERS}
            q = users & map (this <> { active = this.balance > 100.0 })
        `;
        expect(allErrors(src)).toEqual([]);
        expect(render(src, 'sqlite')).toContain('balance > 100 AS active');
    });

    test('precise type: map result keeps the full union', () => {
        const src = `
            ${USERS}
            q = users & map (u => u <> { active = u.balance > 100.0 })
                & filter (v => v.active && v.id > 5)
        `;
        expect(allErrors(src)).toEqual([]);
    });

    test('rejects non-record operands', () => {
        expect(errors(`${USERS}\nq = users & map (u => u <> 5)`).join('\n')).toContain("'<>' expects two records");
        expect(typeErrors(`${USERS}\nq = users & map (u => u <> 5)`)).not.toEqual([]);
    });
});
