/******************************************************************************
 * Pipeline-order semantics — `q & f` must behave like `f q`, not like a
 * fixed SQL clause order. These tests execute generated SQLite SQL against
 * in-memory tables so ordering bugs cannot hide behind string expectations.
 ******************************************************************************/
import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { render, typeErrors } from './helpers.ts';

describe('pipeline order is preserved by derived tables', () => {
    test('take before sort limits first, then sorts the limited rows', () => {
        const db = new Database(':memory:');
        db.run('CREATE TABLE t (a int)');
        db.run('INSERT INTO t VALUES (3), (2), (1)');
        const sql = render(`t: query { a: int } = table "t"\nq = t & take 2 & sort (u => asc u.a)`);
        expect(sql).toContain('FROM (\n    SELECT *\n    FROM t\n    LIMIT 2');
        expect(sql).toContain('ORDER BY a ASC');
        expect(db.query(sql).all()).toBeArray();
    });

    test('take before filter limits before the predicate', () => {
        const db = new Database(':memory:');
        db.run('CREATE TABLE t (a int, flag bool)');
        db.run('INSERT INTO t VALUES (1, 0), (2, 0), (3, 1)');
        const sql = render(`t: query { a: int, flag: bool } = table "t"\nq = t & take 2 & filter (u => u.flag)`);
        expect(sql).toContain('LIMIT 2');
        expect(sql).toContain('WHERE flag');
    });

    test('take before fold aggregates only the limited rows', () => {
        const db = new Database(':memory:');
        db.run('CREATE TABLE t (a int)');
        db.run('INSERT INTO t VALUES (10), (10), (10)');
        const sql = render(`t: query { a: int } = table "t"\nq = t & take 2 & fold (u => { total = sum u.a })`);
        expect(db.query(sql).get()).toEqual({ total: 20 });
    });

    test('distinct before fold deduplicates before aggregation', () => {
        const db = new Database(':memory:');
        db.run('CREATE TABLE t (a int)');
        db.run('INSERT INTO t VALUES (1), (1), (2)');
        const sql = render(`t: query { a: int } = table "t"\nq = t & distinct & fold (u => { total = sum u.a })`);
        expect(db.query(sql).get()).toEqual({ total: 3 });
    });

    test('drop before take skips first, then limits', () => {
        const db = new Database(':memory:');
        db.run('CREATE TABLE t (a int)');
        db.run('INSERT INTO t VALUES (1), (2), (3), (4), (5)');
        const sql = render(`t: query { a: int } = table "t"\nq = t & sort (u => asc u.a) & drop 2 & take 2`);
        expect(sql).toContain('LIMIT 2 OFFSET 2');
        expect(db.query(sql).all()).toEqual([{ a: 3 }, { a: 4 }]);
    });

    test('take before drop limits first, then drops from the limited rows', () => {
        const db = new Database(':memory:');
        db.run('CREATE TABLE t (a int)');
        db.run('INSERT INTO t VALUES (1), (2), (3), (4), (5)');
        const sql = render(`t: query { a: int } = table "t"\nq = t & sort (u => asc u.a) & take 3 & drop 1`);
        expect(db.query(sql).all()).toEqual([{ a: 2 }, { a: 3 }]);
    });

    test('consecutive drops are additive', () => {
        expect(render(`t: query { a: int } = table "t"\nq = t & drop 2 & drop 3`, 'postgresql')).toContain('OFFSET 5');
    });

    test('repeated take uses the smaller limit', () => {
        expect(render(`t: query { a: int } = table "t"\nq = t & take 3 & take 5`)).toContain('LIMIT 3');
        expect(render(`t: query { a: int } = table "t"\nq = t & take 5 & take 3`)).toContain('LIMIT 3');
    });
});

describe('window projections create a derived-table boundary', () => {
    test('a later filter reads the window alias from a subquery', () => {
        const db = new Database(':memory:');
        db.run('CREATE TABLE t (dept text, salary int)');
        db.run("INSERT INTO t VALUES ('a', 10), ('a', 20), ('b', 5)");
        const sql = render(`
            t: query { dept: string, salary: int } = table "t"
            q = t & map (u => { rn = over row_number { partition = [u.dept], order = [desc u.salary] } })
                  & filter (u => u.rn == 1)
        `);
        expect(sql).toContain('FROM (\n    SELECT');
        const out = db.query(sql).all() as { rn: number }[];
        expect(out.map(r => r.rn)).toEqual([1, 1]);
    });
});

describe('dialect capability fixes execute on SQLite', () => {
    test('greatest/least lower to scalar MAX/MIN', () => {
        const db = new Database(':memory:');
        db.run('CREATE TABLE t (a int, b int)');
        db.run('INSERT INTO t VALUES (1, 2)');
        const sql = render(`t: query { a: int, b: int } = table "t"\nq = t & map (u => { g = greatest [u.a, u.b], l = least [u.a, u.b] })`);
        expect(sql).toContain('MAX(a, b) AS g');
        expect(sql).toContain('MIN(a, b) AS l');
        expect(db.query(sql).get()).toEqual({ g: 2, l: 1 });
    });

    test('concat ignores NULLs on SQLite like CONCAT', () => {
        const db = new Database(':memory:');
        db.run('CREATE TABLE t (a text, b text)');
        db.run("INSERT INTO t VALUES ('x', NULL)");
        const sql = render(`t: query { a: (maybe string), b: (maybe string) } = table "t"\nq = t & map (u => { c = concat [u.a, u.b] })`);
        expect(db.query(sql).get()).toEqual({ c: 'x' });
    });

    test('two-argument lpad/rpad lower to an explicit space pad', () => {
        const sql = render(`t: query { a: string, n: int } = table "t"\nq = t & map (u => { l = lpad [u.a, 3], r = rpad [u.a, 3] })`, 'postgresql');
        expect(sql).toContain(`LPAD(a, 3, ' ') AS l`);
        expect(sql).toContain(`RPAD(a, 3, ' ') AS r`);
    });

    test('lpad/rpad fallbacks pad and truncate correctly on SQLite', () => {
        const db = new Database(':memory:');
        db.run('CREATE TABLE t (a text)');
        db.run("INSERT INTO t VALUES ('ab'), ('abcdef')");
        const sql = render(`t: query { a: string } = table "t"\nq = t & map (u => { l = lpad [u.a, 4, "0"], r = rpad [u.a, 4, "0"] })`);
        expect(db.query(sql).all()).toEqual([
            { l: '00ab', r: 'ab00' },
            { l: 'abcd', r: 'abcd' },
        ]);
    });

    test('reverse fallback executes without a SQLite extension', () => {
        const db = new Database(':memory:');
        db.run('CREATE TABLE t (a text)');
        db.run("INSERT INTO t VALUES ('abcd'), ('')");
        const sql = render(`t: query { a: string } = table "t"\nq = t & map (u => { r = reverse u.a })`);
        expect(db.query(sql).all()).toEqual([{ r: 'dcba' }, { r: '' }]);
    });
});

describe('count_distinct aggregate', () => {
    test('renders COUNT(DISTINCT ...) and type-checks as an aggregate', () => {
        const db = new Database(':memory:');
        db.run('CREATE TABLE t (g int, v text)');
        db.run("INSERT INTO t VALUES (1, 'a'), (1, 'a'), (1, 'b')");
        const sql = render(`t: query { g: int, v: string } = table "t"\nq = t & fold (u => { g = group u.g, n = count_distinct u.v })`);
        expect(sql).toContain('COUNT(DISTINCT v) AS n');
        expect(db.query(sql).get()).toEqual({ g: 1, n: 2 });
        expect(typeErrors(`t: query { g: int, v: string } = table "t"\nq = t & fold (u => { g = group u.g, n = count_distinct u.v })`)).toEqual([]);
    });
});

describe('first-class builtins keep their static checks', () => {
    test('bound sort rejects a non-order lambda', () => {
        const src = `users: query { name: string } = table "users"\nby = sort\nq = users & by (u => u.name)`;
        expect(typeErrors(src).join('\n')).toContain('sort expects order items');
    });

    test('bound fold still requires aggregate/group modes', () => {
        const src = `users: query { name: string } = table "users"\nf = fold\nq = users & f (u => { n = u.name })`;
        expect(typeErrors(src).join('\n')).toContain(`fold entry 'n' must be wrapped in an aggregate`);
    });

    test('bound greatest still rejects incompatible literals', () => {
        const src = `users: query { name: string } = table "users"\ng = greatest\nq = users & map (u => { x = g [u.name, 1] })`;
        expect(typeErrors(src).join('\n')).toContain('greatest requires matching types, got string and int');
    });
});
