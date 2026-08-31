/******************************************************************************
 * Record transformers — teta-style pure record helpers inside map.
 *
 * `rename keyFn` renames every field via a key rule (teta's rename),
 * `pick names` keeps the listed fields in order, and `omit names` removes
 * the listed fields (teta's record-level drop, renamed because `drop n`
 * is the OFFSET query step). Each is a curried record -> record function,
 * so it composes in pipelines and binds first-class like any function.
 ******************************************************************************/
import { describe, expect, test } from 'bun:test';
import { render, errors, typeErrors, allErrors } from './helpers.ts';

const USERS = `users: query {
    id: int,
    name: string,
    password_hash: string,
    age: int,
} = table "users"`;

describe('rename', () => {
    test('renames every field with a prefix rule', () => {
        const sql = render(`${USERS}\nq = users & map (rename (k => "user_" <> k))`);
        expect(sql).toBe([
            'SELECT',
            '    id AS user_id,',
            '    name AS user_name,',
            '    password_hash AS user_password_hash,',
            '    age AS user_age',
            'FROM users',
        ].join('\n'));
    });

    test('a suffix rule composes after other projections', () => {
        const sql = render(`${USERS}\nq = users & map (u => { id = u.id }) & map (rename (k => k <> "_v2"))`);
        expect(sql).toBe('SELECT id AS id_v2\nFROM users');
    });

    test('renamed fields are addressable downstream', () => {
        const sql = render(`
            ${USERS}
            q = users & map (rename (k => "user_" <> k)) & filter (u => u.user_age >= 18) & map (u => { user_id = u.user_id })
        `);
        expect(sql).toBe('SELECT id AS user_id\nFROM users\nWHERE age >= 18');
    });

    test('an identity rule keeps every field', () => {
        const sql = render(`${USERS}\nq = users & map (rename id)`);
        expect(sql).toContain('id,');
        expect(sql).toContain('name,');
        expect(sql).toContain('password_hash,');
        expect(sql).toContain('age');
    });

    test('the key rule is a first-class reusable value', () => {
        const sql = render(`
            ${USERS}
            prefix = k => "user_" <> k
            q = users & map (rename prefix)
        `);
        expect(sql).toContain('id AS user_id');
    });

    test('runs after a fold on the aggregated result', () => {
        const sql = render(`
            ${USERS}
            q = users & fold (g => { dept = group g.name, n = count g.id }) & map (rename (k => k <> "_cnt"))
        `);
        expect(sql).toContain('dept AS dept_cnt');
        expect(sql).toContain('n AS n_cnt');
    });

    test('rejects a rule that produces duplicate columns', () => {
        expect(errors(`${USERS}\nq = users & map (rename (k => "x"))`).join('\n'))
            .toContain("rename would produce a duplicate column 'x'");
    });

    test('rejects a non-literal key rule', () => {
        expect(errors(`${USERS}\nq = users & map (rename (k => upper k))`).join('\n'))
            .toContain('rename key rule must compute a column name');
    });

    test('rejects a non-function key rule', () => {
        expect(errors(`${USERS}\nq = users & map (rename 5)`).join('\n'))
            .toContain('rename expects a key rule');
    });
});

describe('pick', () => {
    test('keeps the listed fields in list order', () => {
        const sql = render(`${USERS}\nq = users & map (pick ["age", "id"])`);
        expect(sql).toBe([
            'SELECT',
            '    age,',
            '    id',
            'FROM users',
        ].join('\n'));
    });

    test('the output row is closed — a typo downstream is a static error', () => {
        expect(allErrors(`${USERS}\nq = users & map (pick ["id"]) & map (u => { i = u.nope })`).join('\n'))
            .toContain("unknown column 'nope' — available: id");
    });

    test('rejects unknown fields with the available list', () => {
        expect(allErrors(`${USERS}\nq = users & map (pick ["id", "nope"])`).join('\n'))
            .toContain("pick has no field 'nope' — available: id, name, password_hash, age");
    });

    test('rejects duplicate fields and empty lists statically', () => {
        expect(typeErrors(`${USERS}\nq = users & map (pick ["id", "id"])`).join('\n'))
            .toContain("duplicate field 'id' in pick");
        expect(typeErrors(`${USERS}\nq = users & map (pick [])`).join('\n'))
            .toContain('pick expects at least one field name');
    });

    test('rejects non-literal entries', () => {
        expect(errors(`${USERS}\nq = users & map (pick [concat ["a", "b"]])`).join('\n'))
            .toContain('pick entries must be string literals');
    });
});

describe('omit', () => {
    test('removes the listed fields, keeping row order', () => {
        const sql = render(`${USERS}\nq = users & map (omit ["password_hash"])`);
        expect(sql).toBe([
            'SELECT',
            '    id,',
            '    name,',
            '    age',
            'FROM users',
        ].join('\n'));
    });

    test('rejects unknown fields with the available list', () => {
        expect(allErrors(`${USERS}\nq = users & map (omit ["nope"])`).join('\n'))
            .toContain("omit has no field 'nope'");
    });

    test('rejects removing every field and duplicates', () => {
        expect(errors(`${USERS}\nq = users & map (omit ["id", "name", "password_hash", "age"])`).join('\n'))
            .toContain('omit would remove every field');
        expect(errors(`${USERS}\nq = users & map (omit ["id", "id"])`).join('\n'))
            .toContain('duplicate field in omit');
    });

    test('stays open downstream — the remaining fields compose', () => {
        const sql = render(`${USERS}\nq = users & map (omit ["password_hash"]) & map (u => { u | ok = true })`);
        expect(sql).toContain('1 AS ok');
        expect(sql).not.toContain('password_hash');
    });
});

describe('record transformers in pipelines', () => {
    test('compose with each other', () => {
        const sql = render(`
            ${USERS}
            q = users & map (u => { id = u.id, password_hash = u.password_hash })
                & map (omit ["password_hash"])
                & map (rename (k => "user_" <> k))
        `);
        expect(sql).toBe('SELECT id AS user_id\nFROM users');
    });

    test('are first-class: a bound transformer is reusable', () => {
        const sql = render(`
            ${USERS}
            strip = omit ["password_hash"]
            q = users & map (strip)
        `);
        expect(sql).toBe([
            'SELECT',
            '    id,',
            '    name,',
            '    age',
            'FROM users',
        ].join('\n'));
    });

    test('are just values: a transformer type-checks on its own row shape', () => {
        expect(typeErrors(`${USERS}\nq = users & map (omit ["password_hash"])`)).toEqual([]);
        expect(typeErrors(`${USERS}\nq = users & map (rename (k => k))`)).toEqual([]);
        expect(typeErrors(`${USERS}\nq = users & map (pick ["id", "age"])`)).toEqual([]);
    });

    test('require a known schema like merge', () => {
        const src = `
            t = table "t"
            q = t & map (pick ["id"])
        `;
        expect(errors(src).join('\n')).toContain('cannot enumerate a row with an unknown schema');
    });

    test('compose with filter and take around them', () => {
        const sql = render(`
            ${USERS}
            q = users & filter (u => u.age >= 18) & map (pick ["id", "name"]) & take 5
        `);
        expect(sql).toContain('SELECT');
        expect(sql).toContain('    id,');
        expect(sql).toContain('    name');
        expect(sql).toContain('WHERE age >= 18');
        expect(sql).toContain('LIMIT 5');
    });
});
