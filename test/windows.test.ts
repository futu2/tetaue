import { describe, expect, test } from 'bun:test';
import { render, errors, typeErrors } from './helpers.ts';

const USERS = `users: query {
    id: int,
    name: string,
    dept: string,
    salary: float,
    joined: date,
} = table "users"`;

const RANKED = `
    q = users & map (u => {
        rn = over (row_number) { partition = [u.dept], order = [desc u.salary] },
        r = over (rank) { partition = [u.dept], order = [desc u.salary] },
        dr = over (dense_rank) { partition = [u.dept], order = [desc u.salary] },
        pr = over (percent_rank) { partition = [u.dept], order = [desc u.salary] },
        nt = over (ntile 4) { partition = [u.dept], order = [desc u.salary] },
    })
`;

describe('window functions', () => {
    test('rank family renders OVER (PARTITION BY ... ORDER BY ...)', () => {
        const sql = render(`${USERS}${RANKED}`, 'trino');
        expect(sql).toContain('ROW_NUMBER() OVER (PARTITION BY dept ORDER BY salary DESC) AS rn');
        expect(sql).toContain('RANK() OVER (PARTITION BY dept ORDER BY salary DESC) AS r');
        expect(sql).toContain('DENSE_RANK() OVER (PARTITION BY dept ORDER BY salary DESC) AS dr');
        expect(sql).toContain('PERCENT_RANK() OVER (PARTITION BY dept ORDER BY salary DESC) AS pr');
        expect(sql).toContain('NTILE(4) OVER (PARTITION BY dept ORDER BY salary DESC) AS nt');
    });

    test('window functions are identical across dialects', () => {
        const expected = 'ROW_NUMBER() OVER (PARTITION BY dept ORDER BY salary DESC) AS rn';
        for (const dialect of ['trino', 'postgresql', 'mysql', 'sqlite', 'hive']) {
            expect(render(`${USERS}${RANKED}`, dialect)).toContain(expected);
        }
    });

    test('lag/lead with optional offset and default', () => {
        const sql = render(`
            ${USERS}
            q = users & map (u => {
                l1 = over (lag [u.salary]) { order = [asc u.joined] },
                l2 = over (lag [u.salary, 1]) { order = [asc u.joined] },
                l3 = over (lag [u.salary, 1, 0]) { order = [asc u.joined] },
                l4 = over (lead [u.salary, 2]) { order = [asc u.joined] },
            })
        `, 'trino');
        expect(sql).toContain('LAG(salary) OVER (ORDER BY joined ASC) AS l1');
        expect(sql).toContain('LAG(salary, 1) OVER (ORDER BY joined ASC) AS l2');
        expect(sql).toContain('LAG(salary, 1, 0) OVER (ORDER BY joined ASC) AS l3');
        expect(sql).toContain('LEAD(salary, 2) OVER (ORDER BY joined ASC) AS l4');
    });

    test('windowed aggregates (sum/avg over)', () => {
        const sql = render(`
            ${USERS}
            q = users & map (u => {
                ws = over (sum u.salary) { partition = [u.dept] },
                wa = over (avg u.salary) { partition = [u.dept], order = [desc u.salary] },
                wl = over (list u.name) { partition = [u.dept] },
            })
        `, 'trino');
        expect(sql).toContain('SUM(salary) OVER (PARTITION BY dept) AS ws');
        expect(sql).toContain('AVG(salary) OVER (PARTITION BY dept ORDER BY salary DESC) AS wa');
        expect(sql).toContain('ARRAY_AGG(name) OVER (PARTITION BY dept) AS wl');
    });

    test('empty spec renders OVER ()', () => {
        const sql = render(`${USERS}\nq = users & map (u => { e = over (row_number) {} })`, 'trino');
        expect(sql).toContain('ROW_NUMBER() OVER () AS e');
    });

    test('single (non-list) partition and order values are accepted', () => {
        const sql = render(`${USERS}\nq = users & map (u => { rn = over (row_number) { partition = u.dept, order = desc u.salary } })`, 'trino');
        expect(sql).toContain('ROW_NUMBER() OVER (PARTITION BY dept ORDER BY salary DESC) AS rn');
    });

    test('multi-column partition', () => {
        const sql = render(`${USERS}\nq = users & map (u => { rn = over (row_number) { partition = [u.dept, u.name] } })`, 'trino');
        expect(sql).toContain('ROW_NUMBER() OVER (PARTITION BY dept, name) AS rn');
    });

    test('zero-argument window functions work without parens', () => {
        const sql = render(`
            ${USERS}
            q = users & map (u => {
                rn = over row_number { partition = [u.dept], order = [desc u.salary] },
                r = over rank { partition = [u.dept] },
                dr = over dense_rank {},
                pr = over percent_rank {},
            })
        `, 'trino');
        expect(sql).toContain('ROW_NUMBER() OVER (PARTITION BY dept ORDER BY salary DESC) AS rn');
        expect(sql).toContain('RANK() OVER (PARTITION BY dept) AS r');
        expect(sql).toContain('DENSE_RANK() OVER () AS dr');
        expect(sql).toContain('PERCENT_RANK() OVER () AS pr');
    });

    test('bare multi-argument window functions hint at parens', () => {
        const messages = errors(`${USERS}\nq = users & map (u => { x = over lag [u.salary, 1, 0] { order = [asc u.joined] } })`);
        expect(messages.join('\n')).toContain('over expects a window function');
        expect(messages.join('\n')).toContain('wrap it in parens');
    });

    test('a window result can be filtered in a later step (subquery-safe)', () => {
        const sql = render(`
            ${USERS}
            q = users
                & map (u => { id = u.id, rn = over (row_number) { partition = [u.dept], order = [desc u.salary] } })
                & filter (u => u.rn == 1)
        `, 'trino');
        expect(sql).toContain('ROW_NUMBER() OVER (PARTITION BY dept ORDER BY salary DESC) AS rn');
        expect(sql).toContain('FROM (\n    SELECT');
        expect(sql).toContain('WHERE rn = 1');
    });
});

describe('window function validation', () => {
    test('window-only functions must be wrapped in over', () => {
        for (const fn of ['row_number', 'rank', 'dense_rank', 'percent_rank', 'ntile 4', 'lag [u.salary]', 'lead [u.salary]']) {
            expect(errors(`${USERS}\nq = users & map (u => { x = ${fn} })`).join('\n')).toContain('must be wrapped in over');
        }
    });

    test('over rejects non-window-function expressions', () => {
        expect(errors(`${USERS}\nq = users & map (u => { x = over (u.id) {} })`).join('\n')).toContain('over expects a window function');
        expect(errors(`${USERS}\nq = users & map (u => { x = over (upper u.name) {} })`).join('\n')).toContain('over expects a window function');
    });

    test('over spec must be a record with only partition/order', () => {
        expect(errors(`${USERS}\nq = users & map (u => { x = over (row_number) 5 })`).join('\n')).toContain('over expects a spec record');
        expect(errors(`${USERS}\nq = users & map (u => { x = over (row_number) { foo = 1 } })`).join('\n')).toContain("unknown over spec field 'foo'");
    });

    test('partition entries must be plain expressions', () => {
        expect(errors(`${USERS}\nq = users & map (u => { x = over (row_number) { partition = [sum u.salary] } })`).join('\n')).toContain('partition cannot contain aggregates');
    });

    test('order entries must be asc/desc items', () => {
        expect(errors(`${USERS}\nq = users & map (u => { x = over (row_number) { order = [u.salary] } })`).join('\n')).toContain('over spec expects order items like asc u.name');
    });

    test('lag/lead validate their arguments', () => {
        expect(errors(`${USERS}\nq = users & map (u => { x = over (lag [u.salary, "x"]) {} })`).join('\n')).toContain('lag expects a numeric offset');
        expect(errors(`${USERS}\nq = users & map (u => { x = lag [u.salary, 1, 0, 9] })`).join('\n')).toContain('lag expects 1 to 3 arguments');
    });

    test('window functions are rejected in filter predicates', () => {
        expect(errors(`${USERS}\nq = users & filter (u => over (row_number) {} == 1)`).join('\n')).toContain('filter predicate cannot contain window functions');
    });
});

describe('type inference', () => {
    test('a module using window functions type-checks', () => {
        const src = `
            ${USERS}
            q = users & map (u => {
                rn = over (row_number) { partition = [u.dept], order = [desc u.salary] },
                lg = over (lag [u.salary, 1, 0]) { partition = [u.dept] },
                ws = over (sum u.salary) { partition = [u.dept] },
            })
        `;
        expect(typeErrors(src)).toEqual([]);
    });

    test('over result keeps the window function type', () => {
        const src = `
            ${USERS}
            q = users & map (u => { rn = over (row_number) {} })
                & filter (u => u.rn >= 1)
        `;
        expect(typeErrors(src)).toEqual([]);
    });
});

describe('review fix: window-only functions are a static mode', () => {
    test('inference types row_number as a window-mode value and requires over in projections', () => {
        expect(typeErrors(`${USERS}\nq = users & map (u => { x = row_number })`).join('\n')).toContain('row_number must be wrapped in over');
        expect(typeErrors(`${USERS}\nq = users & map (u => { x = over (row_number) {} })`)).toEqual([]);
    });

    test('window-mode values cannot be used as plain scalars', () => {
        expect(typeErrors('x = row_number + 1').join('\n')).toContain("'+' requires numeric operands");
    });
});
