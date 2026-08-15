import { describe, expect, test } from 'bun:test';
import { render, errors, typeErrors, parseModel } from './helpers.ts';

const USERS = `users: query {
    id: int,
    name: string,
    balance: float,
    active: bool,
} = table "users"`;

describe('math functions', () => {
    test('ceil/floor/sqrt/pow/mod/round render (default dialects)', () => {
        const sql = render(`
            ${USERS}
            q = users & map (u => {
                c = ceil u.balance,
                f = floor u.balance,
                s = sqrt u.balance,
                p = pow u.balance 2,
                m = mod u.id 3,
                r1 = round [u.balance],
                r2 = round [u.balance, 2],
            })
        `, 'trino');
        expect(sql).toContain('CEIL(balance) AS c');
        expect(sql).toContain('FLOOR(balance) AS f');
        expect(sql).toContain('SQRT(balance) AS s');
        expect(sql).toContain('POW(balance, 2) AS p');
        expect(sql).toContain('MOD(id, 3) AS m');
        expect(sql).toContain('ROUND(balance) AS r1');
        expect(sql).toContain('ROUND(balance, 2) AS r2');
    });

    test('sqlite maps ceil to CEILING', () => {
        const sql = render(`${USERS}\nq = users & map (u => { c = ceil u.balance })`, 'sqlite');
        expect(sql).toContain('CEILING(balance) AS c');
    });

    test('greatest/least with many arguments', () => {
        const sql = render(`${USERS}\nq = users & map (u => { g = greatest [u.balance, u.id, 5], l = least [u.balance, u.id, 5] })`, 'trino');
        expect(sql).toContain('GREATEST(balance, id, 5) AS g');
        expect(sql).toContain('LEAST(balance, id, 5) AS l');
    });

    test('list-argument builtins work through a binding', () => {
        const sql = render(`
            ${USERS}
            pick = greatest
            q = users & map (u => { g = pick [u.balance, 5] })
        `, 'trino');
        expect(sql).toContain('GREATEST(balance, 5) AS g');
    });

    test('greatest requires matching types', () => {
        expect(errors(`${USERS}\nq = users & map (u => { g = greatest [u.balance, u.name] })`).join('\n')).toContain('greatest requires matching types, got float and string');
    });

    test('list-argument arity is validated', () => {
        expect(errors(`${USERS}\nq = users & map (u => { g = greatest [u.balance] })`).join('\n')).toContain('greatest expects 2 or more arguments, got 1');
        expect(errors(`${USERS}\nq = users & map (u => { r = round [u.balance, 2, 3] })`).join('\n')).toContain('round expects 1 to 2 arguments, got 3');
    });
});

describe('string functions', () => {
    test('concat renders CONCAT except sqlite ||', () => {
        const src = `${USERS}\nq = users & map (u => { full = concat [u.name, "-", u.name] })`;
        expect(render(src, 'trino')).toContain(`CONCAT(name, '-', name) AS "full"`);
        expect(render(src, 'sqlite')).toContain(`COALESCE(name, '') || COALESCE('-', '') || COALESCE(name, '') AS "full"`);
    });

    test('substring with optional length; sqlite uses SUBSTR', () => {
        const src = `${USERS}\nq = users & map (u => { a = substring [u.name, 1], b = substring [u.name, 1, 3] })`;
        expect(render(src, 'trino')).toContain('SUBSTRING(name, 1) AS a');
        expect(render(src, 'trino')).toContain('SUBSTRING(name, 1, 3) AS b');
        expect(render(src, 'sqlite')).toContain('SUBSTR(name, 1) AS a');
        expect(render(src, 'sqlite')).toContain('SUBSTR(name, 1, 3) AS b');
    });

    test('position is dialect-specific', () => {
        const src = `${USERS}\nq = users & map (u => { p = position u.name "a" })`;
        expect(render(src, 'trino')).toContain(`POSITION('a' IN name) AS p`);
        expect(render(src, 'postgresql')).toContain(`POSITION('a' IN name) AS p`);
        expect(render(src, 'mysql')).toContain(`LOCATE('a', name) AS p`);
        expect(render(src, 'sqlite')).toContain(`INSTR(name, 'a') AS p`);
        expect(render(src, 'hive')).toContain(`INSTR(name, 'a') AS p`);
    });

    test('trim/replace/reverse are direct', () => {
        const sql = render(`
            ${USERS}
            q = users & map (u => { t = trim u.name, r = replace u.name "x" "y", v = reverse u.name })
        `, 'trino');
        expect(sql).toContain('TRIM(name) AS t');
        expect(sql).toContain(`REPLACE(name, 'x', 'y') AS r`);
        expect(sql).toContain('REVERSE(name) AS v');
    });

    test('left/right substring; sqlite uses SUBSTR', () => {
        const src = `${USERS}\nq = users & map (u => { l = left_substring u.name 3, r = right_substring u.name 2 })`;
        expect(render(src, 'trino')).toContain('LEFT(name, 3) AS l');
        expect(render(src, 'trino')).toContain('RIGHT(name, 2) AS r');
        expect(render(src, 'sqlite')).toContain('SUBSTR(name, 1, 3) AS l');
        expect(render(src, 'sqlite')).toContain('SUBSTR(name, -2) AS r');
    });

    test('lpad/rpad render directly; sqlite errors', () => {
        const src = `${USERS}\nq = users & map (u => { l = lpad [u.name, 8, "0"], r = rpad [u.name, 8, "0"] })`;
        expect(render(src, 'trino')).toContain(`LPAD(name, 8, '0') AS l`);
        expect(render(src, 'trino')).toContain(`RPAD(name, 8, '0') AS r`);
        expect(() => render(src, 'sqlite')).toThrow('lpad is not supported for the sqlite dialect');
    });

    test('reverse errors on sqlite only', () => {
        const src = `${USERS}\nq = users & map (u => { v = reverse u.name })`;
        expect(() => render(src, 'sqlite')).toThrow('reverse is not supported for the sqlite dialect');
        expect(render(src, 'hive')).toContain('REVERSE(name) AS v');
    });
});

describe('regex functions', () => {
    test('regex_like lowers per dialect', () => {
        const src = `${USERS}\nq = users & filter (u => regex_like u.name "^[A-Z]")`;
        expect(render(src, 'trino')).toContain(`REGEXP_LIKE(name, '^[A-Z]')`);
        expect(render(src, 'postgresql')).toContain(`name ~ '^[A-Z]'`);
        expect(render(src, 'mysql')).toContain(`REGEXP_LIKE(name, '^[A-Z]')`);
        expect(render(src, 'hive')).toContain(`name RLIKE '^[A-Z]'`);
        expect(() => render(src, 'sqlite')).toThrow('regex_like is not supported for the sqlite dialect');
    });

    test('regex_replace and regex_extract', () => {
        const src = `${USERS}\nq = users & map (u => { r = regex_replace u.name "[0-9]" "#", e = regex_extract [u.name, "([0-9]+)"] })`;
        expect(render(src, 'trino')).toContain(`REGEXP_REPLACE(name, '[0-9]', '#') AS r`);
        expect(render(src, 'trino')).toContain(`REGEXP_EXTRACT(name, '([0-9]+)') AS e`);
        expect(render(src, 'postgresql')).toContain(`REGEXP_SUBSTR(name, '([0-9]+)') AS e`);
        expect(() => render(src, 'sqlite')).toThrow('regex_replace is not supported for the sqlite dialect');
        const extract = `${USERS}\nq = users & map (u => { e = regex_extract [u.name, "([0-9]+)"] })`;
        expect(() => render(extract, 'sqlite')).toThrow('regex_extract is not supported for the sqlite dialect');
        expect(() => render(extract, 'mysql')).toThrow('regex_extract is not supported for the mysql dialect');
    });
});

describe('like and null handling', () => {
    test('like renders a binary LIKE', () => {
        const sql = render(`${USERS}\nq = users & filter (u => like u.name "a%")`);
        expect(sql).toContain(`name LIKE 'a%'`);
    });

    test('null_if / is_null / is_not_null', () => {
        const sql = render(`
            ${USERS}
            q = users & map (u => {
                n = null_if u.name "",
                a = is_null u.name,
                b = is_not_null u.name,
            })
        `);
        expect(sql).toContain(`NULL_IF(name, '') AS n`);
        expect(sql).toContain('name IS NULL AS a');
        expect(sql).toContain('name IS NOT NULL AS b');
    });

    test('null_if requires matching types', () => {
        expect(errors(`${USERS}\nq = users & map (u => { n = null_if u.id "" })`).join('\n')).toContain('null_if requires matching types');
    });
});

describe('case / CASE WHEN', () => {
    test('case with fallback renders CASE WHEN ... ELSE ... END', () => {
        const sql = render(`
            ${USERS}
            q = users & map (u => {
                label = case { u.active => u.name, _ => "inactive" },
                flag = case { u.active => 1, _ => 0 },
            })
        `);
        expect(sql).toContain(`CASE WHEN active THEN name ELSE 'inactive' END AS label`);
        expect(sql).toContain('CASE WHEN active THEN 1 ELSE 0 END AS flag');
    });

    test('multi-branch case renders a flat WHEN ladder', () => {
        const sql = render(`
            ${USERS}
            q = users & map (u => {
                bucket = case { u.balance < 100 => "low", u.balance < 1000 => "mid", _ => "high" },
            })
        `);
        expect(sql).toContain(`CASE WHEN balance < 100 THEN 'low' WHEN balance < 1000 THEN 'mid' ELSE 'high' END AS bucket`);
    });

    test('case without a fallback renders CASE ... END (no ELSE clause)', () => {
        const sql = render(`${USERS}\nq = users & map (u => { maybe = case { u.balance > 100 => u.name } })`);
        expect(sql).toContain('CASE WHEN balance > 100 THEN name END AS maybe');
    });

    test('case works in filter predicates and nests', () => {
        const sql = render(`
            ${USERS}
            q = users
                & filter (u => case { u.active => true, _ => false })
                & map (u => { kind = case { u.active => (case { u.balance > 50 => "rich", _ => "mid" }), _ => "off" } })
        `, 'postgresql');
        expect(sql).toContain('WHERE CASE WHEN active THEN TRUE ELSE FALSE END');
        expect(sql).toContain(`CASE WHEN active THEN CASE WHEN balance > 50 THEN 'rich' ELSE 'mid' END ELSE 'off' END AS kind`);
    });

    test('null value absorbs like coalesce', () => {
        const sql = render(`${USERS}\nq = users & map (u => { n = case { u.active => u.name, _ => null } })`);
        expect(sql).toContain('CASE WHEN active THEN name ELSE NULL END AS n');
    });

    test('CASE renders identically across dialects', () => {
        const src = `${USERS}\nq = users & map (u => { bucket = case { u.balance < 100 => "low", _ => "high" } })`;
        const expected = `CASE WHEN balance < 100 THEN 'low' ELSE 'high' END AS bucket`;
        for (const d of ['sqlite', 'postgresql', 'mysql', 'trino', 'hive']) {
            expect(render(src, d)).toContain(expected);
        }
    });

    test('case condition must be boolean', () => {
        expect(errors(`${USERS}\nq = users & map (u => { x = case { u.balance => 1, _ => 0 } })`).join('\n')).toContain('case condition must be a boolean expression, got type float');
    });

    test('case values must share a type', () => {
        expect(errors(`${USERS}\nq = users & map (u => { x = case { u.active => u.name, _ => u.id } })`).join('\n')).toContain('case requires matching value types, got string and int');
    });

    test('case mismatches among literals are caught by inference', () => {
        expect(typeErrors(`${USERS}\nq = users & map (u => { x = case { true => 1, _ => "a" } })`).join('\n')).toContain('case requires matching value types, got int and string');
    });

    test('the fallback branch must be last', () => {
        expect(errors(`${USERS}\nq = users & map (u => { x = case { u.active => 1, _ => 0, u.id => 2 } })`).join('\n')).toContain(`the '_' fallback branch must be last in a case expression`);
    });

    test('an empty case is an error', () => {
        expect(errors(`${USERS}\nq = users & map (u => { x = case {} })`).join('\n')).toContain('case requires at least one branch');
    });

    test('case cannot wrap aggregates', () => {
        const orders = `orders: query { total: float } = table "orders"`;
        expect(errors(`${orders}\nq = orders & fold (o => { x = case { o.total > 100.0 => (sum o.total), _ => 0 } })`).join('\n')).toContain('case cannot contain aggregates');
    });

    test('_ is a reserved word', () => {
        expect(() => parseModel(`${USERS}\n_ = 5\nq = users`)).toThrow();
    });

    test('simple case: subject + literal branches', () => {
        const sql = render(`
            ${USERS}
            q = users & map (u => {
                label = case u.name { "a" => "first", "b" => "second", _ => u.name },
                flag = case u.active { true => 1, _ => 0 },
                no_else = case u.name { "a" => "first" },
            })
        `, 'postgresql');
        expect(sql).toContain(`CASE WHEN name = 'a' THEN 'first' WHEN name = 'b' THEN 'second' ELSE name END AS label`);
        expect(sql).toContain('CASE WHEN active = TRUE THEN 1 ELSE 0 END AS flag');
        expect(sql).toContain(`CASE WHEN name = 'a' THEN 'first' END AS no_else`);
    });

    test('simple case: null branch renders IS NULL', () => {
        const sql = render(`${USERS}\nq = users & map (u => { n = case u.name { null => "missing", _ => "present" } })`);
        expect(sql).toContain(`CASE WHEN name IS NULL THEN 'missing' ELSE 'present' END AS n`);
    });

    test('simple case: branch condition must match the subject type', () => {
        expect(errors(`${USERS}\nq = users & map (u => { x = case u.balance { "x" => 1, _ => 0 } })`).join('\n')).toContain('cannot compare float with string');
        expect(errors(`${USERS}\nq = users & map (u => { x = case u.name { true => 1, _ => 0 } })`).join('\n')).toContain('cannot compare string with bool');
    });

    test('simple case: expressions as branch conditions', () => {
        // `case subject { c => v }` ≡ `case { subject == c => v }` — any
        // expression works as the branch condition, not just literals.
        const sql = render(`${USERS}\nq = users & map (u => { x = case u.id { u.id + 1 => "next", _ => "other" } })`);
        expect(sql).toContain(`CASE WHEN id = id + 1 THEN 'next' ELSE 'other' END AS x`);
    });
});

describe('cast / try_cast', () => {
    test('cast uses per-dialect SQL types', () => {
        const src = `${USERS}\nq = users & map (u => { i = cast u.balance "int", f = cast u.id "float", s = cast u.id "string", d = cast u.name "date", t = cast u.name "timestamp" })`;
        expect(render(src, 'trino')).toContain('CAST(balance AS INTEGER) AS i');
        expect(render(src, 'trino')).toContain('CAST(id AS DOUBLE) AS f');
        expect(render(src, 'trino')).toContain('CAST(id AS VARCHAR) AS s');
        expect(render(src, 'postgresql')).toContain('CAST(id AS DOUBLE PRECISION) AS f');
        expect(render(src, 'mysql')).toContain('CAST(balance AS SIGNED) AS i');
        expect(render(src, 'mysql')).toContain('CAST(id AS CHAR) AS s');
        expect(render(src, 'sqlite')).toContain('CAST(id AS TEXT) AS s');
        expect(render(src, 'hive')).toContain('CAST(id AS STRING) AS s');
    });

    test('cast to bool uses BOOLEAN where supported', () => {
        const src = `${USERS}\nq = users & map (u => { b = cast u.active "bool" })`;
        expect(render(src, 'trino')).toContain('CAST(active AS BOOLEAN) AS b');
        expect(render(src, 'postgresql')).toContain('CAST(active AS BOOLEAN) AS b');
    });

    test('cast to bool errors on sqlite', () => {
        const src = `${USERS}\nq = users & map (u => { b = cast u.active "bool" })`;
        expect(() => render(src, 'sqlite')).toThrow('casting to bool is not supported for the sqlite dialect');
    });

    test('try_cast is trino-only', () => {
        const src = `${USERS}\nq = users & map (u => { i = try_cast u.name "int" })`;
        expect(render(src, 'trino')).toContain('TRY_CAST(name AS INTEGER) AS i');
        expect(() => render(src, 'postgresql')).toThrow('try_cast is not supported for the postgresql dialect');
    });

    test('cast validates the target type', () => {
        expect(errors(`${USERS}\nq = users & map (u => { i = cast u.id "integer" })`).join('\n')).toContain('cast expects a target type as a string literal — one of: int, float, string, bool, date, timestamp');
    });
});

describe('validation', () => {
    test('numeric functions reject strings', () => {
        expect(errors(`${USERS}\nq = users & map (u => { c = ceil u.name })`).join('\n')).toContain('ceil expects a numeric expression');
        expect(errors(`${USERS}\nq = users & map (u => { p = pow u.name 2 })`).join('\n')).toContain('pow expects a numeric expression');
    });

    test('concat rejects non-strings', () => {
        expect(errors(`${USERS}\nq = users & map (u => { c = concat [u.name, u.id] })`).join('\n')).toContain('concat expects string expressions');
    });

    test('substring validates argument kinds', () => {
        expect(errors(`${USERS}\nq = users & map (u => { s = substring [u.id, 1, 3] })`).join('\n')).toContain('substring expects string expressions');
        expect(errors(`${USERS}\nq = users & map (u => { s = substring [u.name, u.name] })`).join('\n')).toContain('substring expects numeric expressions');
    });

    test('lpad/rpad validate argument kinds', () => {
        expect(errors(`${USERS}\nq = users & map (u => { s = lpad [u.id, 8, "0"] })`).join('\n')).toContain('lpad expects string expressions');
        expect(errors(`${USERS}\nq = users & map (u => { s = rpad [u.name, "8", "0"] })`).join('\n')).toContain('rpad expects numeric expressions');
    });

    test('like requires string operands', () => {
        expect(errors(`${USERS}\nq = users & filter (u => like u.id "a%")`).join('\n')).toContain('like expects a string expression');
    });

    test('aggregates cannot be wrapped by scalar functions', () => {
        expect(errors(`${USERS}\nq = users & fold (u => { x = ceil (count u.id) })`).join('\n')).toContain('ceil cannot contain aggregates');
    });

    test('list is an aggregate: rejected outside fold', () => {
        expect(errors(`${USERS}\nq = users & map (u => { tags = list u.name })`).join('\n')).toContain("projection entry 'tags' cannot contain aggregates");
    });
});

describe('type inference', () => {
    test('a module using the scalar catalog type-checks', () => {
        const src = `
            ${USERS}
            q = users & map (u => {
                c = ceil u.balance,
                p = pow u.balance 2,
                m = mod u.id 3,
                r = round [u.balance, 2],
                g = greatest [u.balance, 1.5],
                full = concat [u.name, "-", u.name],
                sub = substring [u.name, 1, 3],
                pos = position u.name "a",
                li = like u.name "a%",
                nf = null_if u.name "",
                ci = cast u.id "string",
            })
        `;
        expect(typeErrors(src)).toEqual([]);
    });

    test('pow does not unify its operands (no type pollution)', () => {
        // Regression: `pow u.balance 2` must not pin balance to int.
        const src = `
            ${USERS}
            q = users & map (u => { p = pow u.balance 2, g = greatest [u.balance, 1.5] })
        `;
        expect(typeErrors(src)).toEqual([]);
        expect(typeErrors(src)).not.toContain('greatest requires matching types');
    });
});
