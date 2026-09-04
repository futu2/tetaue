import { describe, expect, test } from 'bun:test';
import { render, errors, typeErrors, allErrors, parseModel, services } from './helpers.ts';
import { checkProject } from '../src/language/checker.ts';
import { standardPrelude } from '../src/language/prelude.ts';
import type { SqlNode, Value } from '../src/language/interpreter.ts';

const USERS = `users: query {
    id: int,
    name: string,
    balance: float,
    active: bool,
} = table "users"`;

function checkedPureValue(source: string): Value {
    const result = checkProject(
        [{ model: parseModel(source), uri: undefined, imports: [] }],
        { requireQuery: false, prelude: standardPrelude(services) },
    );
    expect(result.diagnostics.map(d => d.message)).toEqual([]);
    return result.value;
}

function literalList(source: string): unknown[] {
    const value = checkedPureValue(source);
    expect(value.kind).toBe('list');
    if (value.kind !== 'list') return [];
    return value.items.map(item => item.kind === 'expr' ? constantSqlValue(item.node) : item.kind);
}

function constantSqlValue(node: SqlNode): unknown {
    if (node.kind === 'lit') return node.value;
    if (node.kind === 'bin') {
        const left = constantSqlValue(node.left);
        const right = constantSqlValue(node.right);
        if (typeof left === 'number' && typeof right === 'number') {
            if (node.op === '+') return left + right;
            if (node.op === '*') return left * right;
        }
    }
    return node.kind;
}

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
                r1 = round u.balance 0,
                r2 = round u.balance 2,
            })
        `, 'trino');
        expect(sql).toContain('CEIL(balance) AS c');
        expect(sql).toContain('FLOOR(balance) AS f');
        expect(sql).toContain('SQRT(balance) AS s');
        expect(sql).toContain('POW(balance, 2) AS p');
        expect(sql).toContain('MOD(id, 3) AS m');
        expect(sql).toContain('ROUND(balance, 0) AS r1');
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

    test('round validates its scale and value', () => {
        // The scale is required (SQL's ROUND(x) means scale 0), so the caller
        // writes the default explicitly: `round u.balance 0`.
        expect(errors(`${USERS}\nq = users & map (u => { r = round u.balance "2" })`).join('\n')).toContain('round expects a numeric scale');
        expect(errors(`${USERS}\nq = users & map (u => { r = round u.name 0 })`).join('\n')).toContain('round expects a numeric expression');
    });
});

describe('string functions', () => {
    test('concat renders CONCAT except sqlite ||', () => {
        const src = `${USERS}\nq = users & map (u => { full = concat [u.name, "-", u.name] })`;
        expect(render(src, 'trino')).toContain(`CONCAT(name, '-', name) AS "full"`);
        expect(render(src, 'sqlite')).toContain(`COALESCE(name, '') || COALESCE('-', '') || COALESCE(name, '') AS "full"`);
    });

    test('substring with optional length; sqlite uses SUBSTR', () => {
        const src = `${USERS}\nq = users & map (u => { a = substring u.name 1 nothing, b = substring u.name 1 (just 3) })`;
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

    test('lpad/rpad render directly in every dialect', () => {
        const src = `${USERS}\nq = users & map (u => { l = lpad u.name 8 "0", r = rpad u.name 8 "0" })`;
        expect(render(src, 'trino')).toContain(`LPAD(name, 8, '0') AS l`);
        expect(render(src, 'trino')).toContain(`RPAD(name, 8, '0') AS r`);
        expect(render(src, 'sqlite')).toContain("ELSE SUBSTR(REPLACE(PRINTF('%*s', 8, ''), ' ', '0'), 1, 8 - LENGTH(name)) || name END AS l");
        expect(render(src, 'sqlite')).toContain("ELSE name || SUBSTR(REPLACE(PRINTF('%*s', 8, ''), ' ', '0'), 1, 8 - LENGTH(name)) END AS r");
    });

    test('reverse renders on every dialect', () => {
        const src = `${USERS}\nq = users & map (u => { v = reverse u.name })`;
        expect(render(src, 'sqlite')).toContain('WITH RECURSIVE __tetaue_reverse');
        expect(render(src, 'hive')).toContain('REVERSE(name) AS v');
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
        const sql = render(`${USERS}\nq = users & map (u => { maybe_label = case { u.balance > 100 => u.name } })`);
        expect(sql).toContain('CASE WHEN balance > 100 THEN name END AS maybe_label');
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
        expect(typeErrors(`${USERS}\nq = users & map (u => { x = case { true => 1, _ => "a" } })`).join('\n')).toContain('requires matching value types');
    });

    test('the fallback branch must be last', () => {
        expect(errors(`${USERS}\nq = users & map (u => { x = case { u.active => 1, _ => 0, u.id => 2 } })`).join('\n')).toContain(`the '_' fallback branch must be last in a case expression`);
    });

    test('an empty case is an error', () => {
        expect(errors(`${USERS}\nq = users & map (u => { x = case {} })`).join('\n')).toContain('case requires at least one branch');
    });

    test('case may wrap aggregates in fold only with grouped/constant conditions', () => {
        const orders = `orders: query { status: string, total: float } = table "orders"`;
        const grouped = `${orders}\nq = orders & fold (o => { status = group o.status, x = case { o.status == "paid" => sum o.total, _ => 0.0 } })`;
        expect(errors(grouped)).toEqual([]);
        const ungrouped = `${orders}\nq = orders & fold (o => { x = case { o.status == "paid" => sum o.total, _ => 0.0 } })`;
        expect(errors(ungrouped).join('\n')).toContain("case conditions must be constant or use grouped columns");
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

describe('cast', () => {
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

    test('cast to bool uses SQLite integer booleans', () => {
        const src = `${USERS}\nq = users & map (u => { b = cast u.active "bool" })`;
        expect(render(src, 'sqlite')).toContain('CAST(active AS INTEGER) AS b');
    });

    test('cast validates the target type', () => {
        expect(errors(`${USERS}\nq = users & map (u => { i = cast u.id "integer" })`).join('\n')).toContain('cast expects a target type as a string literal — one of: int, float, decimal, string, bool, date, timestamp');
    });
});

describe('non-portable functions are not in the common prelude', () => {
    test('regex helpers and try_cast are unknown in every dialect', () => {
        for (const name of ['regex_like', 'regex_replace', 'regex_extract', 'try_cast']) {
            const source = `${USERS}\nq = users & map (u => { x = ${name} u.name })`;
            expect(allErrors(source).join('\n')).toContain(`unknown identifier '${name}'`);
        }
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
        expect(errors(`${USERS}\nq = users & map (u => { s = substring u.id 1 (just 3) })`).join('\n')).toContain('substring expects a string expression');
        expect(errors(`${USERS}\nq = users & map (u => { s = substring u.name u.name nothing })`).join('\n')).toContain('substring expects a numeric start position');
    });

    test('lpad/rpad validate argument kinds', () => {
        expect(errors(`${USERS}\nq = users & map (u => { s = lpad u.id 8 "0" })`).join('\n')).toContain('lpad expects a string expression');
        expect(errors(`${USERS}\nq = users & map (u => { s = rpad u.name "8" "0" })`).join('\n')).toContain('rpad expects a numeric length');
    });

    test('like requires string operands', () => {
        expect(errors(`${USERS}\nq = users & filter (u => like u.id "a%")`).join('\n')).toContain('like expects a string expression');
    });

    test('aggregates cannot be wrapped by scalar functions', () => {
        expect(errors(`${USERS}\nq = users & fold (u => { x = ceil (count u.id) })`).join('\n')).toContain('ceil cannot contain aggregates');
    });

    test('array is an aggregate: rejected outside fold', () => {
        expect(errors(`${USERS}\nq = users & map (u => { tags = array u.name })`).join('\n')).toContain("projection entry 'tags' cannot contain aggregates");
    });
});

describe('closed fmap instances', () => {
    test('fmap lifts a function over a nullable SQL expression', () => {
        const src = `t: query { email: (maybe string), age: (maybe int) } = table "t"
q = t & map (u => { e = fmap upper u.email, a = fmap (x => x + 1) u.age })`;
        expect(typeErrors(src)).toEqual([]);
        const sql = render(src, 'postgresql', 'compact');
        expect(sql).toContain('UPPER(email) AS e');
        expect(sql).toContain('age + 1 AS a');
    });

    test('fmap type-checks only functions of the wrapped type', () => {
        const bad = `t: query { age: (maybe int) } = table "t"
q = t & map (u => { a = fmap upper u.age })`;
        expect(typeErrors(bad).join('\n')).toContain('cannot apply');
    });

    test('fmap maps list values', () => {
        const src = `values = fmap (x => x + 1) [1, 2]
q = table "users"`;
        expect(typeErrors(src)).toEqual([]);
        expect(allErrors(src)).toEqual([]);
    });

    test('fmap maps query rows as a query step', () => {
        const src = `users: query { id: int, name: string } = table "users"
q = fmap (u => { id2 = u.id + 1, label = u.name }) users`;
        expect(typeErrors(src)).toEqual([]);
        expect(render(src, 'postgresql', 'compact'))
            .toBe('SELECT id + 1 AS id2, name AS label FROM users');
    });

    test('fmap rejects values without a closed Functor instance', () => {
        const bad = `users: query { id: int } = table "users"
q = fmap upper users`;
        expect(typeErrors(bad).join('\n')).toContain('incompatible types');
    });
});

describe('closed Applicative, Alternative, and Monad instances', () => {
    test('maybe operators preserve nullable SQL semantics', () => {
        const src = `t: query { a: (maybe int), b: (maybe int) } = table "t"
q = t & map (u => {
    mapped = (x => x + 1) <$> u.a,
    constant = (x => 7) <$> u.a,
    replaced = 0 <$ u.a,
    applied = just (x => x + 1) <*> u.a,
    left = u.a <* u.b,
    right = u.a *> u.b,
    choice = u.a <|> u.b,
    bound = u.a >>= (x => just (x + 1)),
    sequenced = u.a >> u.b,
})`;
        expect(typeErrors(src)).toEqual([]);
        const sql = render(src, 'postgresql', 'compact');
        expect(sql).toContain('a + 1 AS mapped');
        expect(sql).toContain('CASE WHEN a IS NULL THEN NULL ELSE 7 END AS constant');
        expect(sql).toContain('CASE WHEN a IS NULL THEN NULL ELSE 0 END AS replaced');
        expect(sql).toContain('CASE WHEN a IS NULL OR b IS NULL THEN NULL ELSE a END AS "left"');
        expect(sql).toContain('COALESCE(a, b) AS choice');
        expect(sql).toContain('CASE WHEN a IS NULL THEN NULL ELSE a + 1 END AS bound');
    });

    test('list operators map, apply, sequence, choose, and flat-map', () => {
        expect(literalList('q = (x => x + 1) <$> [1, 2]')).toEqual([2, 3]);
        expect(literalList('q = 0 <$ [1, 2]')).toEqual([0, 0]);
        expect(literalList('q = [x => x + 1, x => x * 2] <*> [3, 4]')).toEqual([4, 5, 6, 8]);
        expect(literalList('q = [1, 2] <* [3, 4]')).toEqual([1, 1, 2, 2]);
        expect(literalList('q = [1, 2] *> [3, 4]')).toEqual([3, 4, 3, 4]);
        expect(literalList('q = [1] <|> [2]')).toEqual([1, 2]);
        expect(literalList('q = [1, 2] >>= (x => [x, x + 10])')).toEqual([1, 11, 2, 12]);
        expect(literalList('q = [1, 2] >> [3, 4]')).toEqual([3, 4, 3, 4]);
    });

    test('named helpers and operator sections use the same closed dispatch', () => {
        expect(literalList('q = replaceWith 0 [1, 2]')).toEqual([0, 0]);
        expect(literalList('q = _<|>_ [1] [2]')).toEqual([1, 2]);
        expect(literalList('q = bind [1, 2] (x => [x + 1])')).toEqual([2, 3]);
    });

    test('<$ replaces each query row with a constant projection', () => {
        const src = `users: query { id: int } = table "users"
q = { tag = "fixed" } <$ users`;
        expect(typeErrors(src)).toEqual([]);
        expect(render(src, 'postgresql', 'compact')).toBe("SELECT 'fixed' AS tag FROM users");
    });

    test('unsupported and mismatched instances are rejected', () => {
        expect(allErrors('bad = true <|> false\nq = table "t"').join('\n')).toContain('Alternative');
        expect(allErrors('bad = [1] >>= (x => x + 1)\nq = table "t"').join('\n')).toContain('same Monad container');
        expect(allErrors('bad = [1] <* just 2\nq = table "t"').join('\n')).toContain('same Applicative container');
    });
});

describe('exists subqueries', () => {
    test('correlated EXISTS renders and type-checks', () => {
        const src = `users: query { id: int } = table "users"
orders: query { user_id: int } = table "orders"
q = users & filter (u => exists (orders & filter (o => o.user_id == u.id)))`;
        expect(typeErrors(src)).toEqual([]);
        const sql = render(src, 'postgresql', 'compact');
        expect(sql).toContain('WHERE EXISTS (SELECT * FROM orders WHERE user_id = users.id)');
    });

    test('EXISTS executes with outer-column correlation', () => {
        const { Database } = require('bun:sqlite') as typeof import('bun:sqlite');
        const db = new Database(':memory:');
        db.run('CREATE TABLE users (id int)');
        db.run('CREATE TABLE orders (user_id int)');
        db.run('INSERT INTO users VALUES (1), (2)');
        db.run('INSERT INTO orders VALUES (1)');
        const sql = render(`users: query { id: int } = table "users"
orders: query { user_id: int } = table "orders"
q = users & filter (u => exists (orders & filter (o => o.user_id == u.id))) & map (u => { id })`);
        expect(db.query(sql).all()).toEqual([{ id: 1 }]);
    });
});

describe('IN subqueries', () => {
    test('in_query renders and executes IN (SELECT ...)', () => {
        const src = `users: query { id: int } = table "users"
orders: query { user_id: int } = table "orders"
q = users & filter (u => in_query u.id (orders & map (o => { user_id = o.user_id }))) & map (u => { id })`;
        expect(typeErrors(src)).toEqual([]);
        const sql = render(src, 'sqlite', 'compact');
        expect(sql).toContain('id IN (SELECT user_id FROM orders)');
        const { Database } = require('bun:sqlite') as typeof import('bun:sqlite');
        const db = new Database(':memory:');
        db.run('CREATE TABLE users (id int)');
        db.run('CREATE TABLE orders (user_id int)');
        db.run('INSERT INTO users VALUES (1), (2)');
        db.run('INSERT INTO orders VALUES (1)');
        expect(db.query(sql).all()).toEqual([{ id: 1 }]);
    });

    test('not_in_query is correlated like exists', () => {
        const src = `users: query { id: int } = table "users"
orders: query { user_id: int } = table "orders"
q = users & filter (u => not_in_query u.id (orders & filter (o => o.user_id == u.id) & map (o => { user_id = o.user_id })))`;
        const sql = render(src, 'postgresql', 'compact');
        expect(sql).toContain('id NOT IN (SELECT user_id FROM orders WHERE user_id = users.id)');
    });
});

describe('scalar subqueries', () => {
    test('correlated scalar subquery renders and types as maybe', () => {
        const src = `users: query { id: int } = table "users"
orders: query { user_id: int } = table "orders"
q = users & map (u => { id, last_user = scalar (orders & filter (o => o.user_id == u.id) & take 1) })`;
        expect(typeErrors(src)).toEqual([]);
        const sql = render(src, 'postgresql', 'compact');
        expect(sql).toContain('(SELECT * FROM orders WHERE user_id = users.id LIMIT 1)');
    });

    test('scalar requires exactly one output column', () => {
        const bad = `t: query { a: int, b: int } = table "t"
q = t & map (u => { x = scalar t })`;
        expect(typeErrors(bad).join('\n')).toContain('scalar subquery must return exactly one column');
    });
});

describe('lateral joins', () => {
    test('join_lateral renders a correlated LATERAL subquery', () => {
        const src = `users: query { id: int, name: string } = table "users"
orders: query { user_id: int, total: float } = table "orders"
q = users & join_lateral (l => (orders & filter (o => o.user_id == l.id) & sort (o => desc o.total) & take 1)) (l => r => true) (l => r => { id = l.id, name = l.name, total = r.total })`;
        expect(typeErrors(src)).toEqual([]);
        const pg = render(src, 'postgresql', 'compact');
        expect(pg).toContain('INNER JOIN LATERAL');
        expect(pg).toContain('WHERE user_id = users.id');
        expect(pg).toContain('ORDER BY total DESC LIMIT 1');
    });

    test('lateral is capability-gated for SQLite', () => {
        const src = `users: query { id: int } = table "users"
orders: query { user_id: int } = table "orders"
q = users & join_lateral (l => orders) (l => r => l.id == r.user_id) (l => r => { id = l.id })`;
        expect(() => render(src, 'sqlite')).toThrow(/lateral joins are not supported/);
    });

    test('a derived right side inlines as a subquery, not a raw table', () => {
        const src = `users: query { id: int, name: string } = table "users"
orders: query { user_id: int, total: float } = table "orders"
ranked = orders
    & fold (o => { user_id = group o.user_id, total = sum o.total })
    & map (r => { id = r.user_id, total = r.total })
q = users
    & join_lateral (l => (ranked & filter (r => r.id == l.id))) (l => r => true) (l => r => { id = l.id, total = r.total })`;
        expect(typeErrors(src)).toEqual([]);
        const pg = render(src, 'postgresql');
        expect(pg).toContain('INNER JOIN LATERAL (');
        expect(pg).toContain('FROM (\n        SELECT\n            user_id,\n            SUM(total) AS total\n        FROM orders\n        GROUP BY user_id\n    ) AS ranked');
        expect(pg).not.toContain('FROM ranked WHERE');
        expect(pg).toContain('WHERE user_id = users.id');
    });
});

describe('filtered aggregates', () => {
    test('sum_where / count_where type-check and execute', () => {
        const src = `orders: query { status: string, total: float } = table "orders"
q = orders & fold (o => { paid_total = sum_where (o.status == "paid") o.total, n = count_where (o.status == "paid") o.total })`;
        expect(typeErrors(src)).toEqual([]);
        const sql = render(src, 'sqlite', 'compact');
        expect(sql).toContain('SUM(total) FILTER (WHERE status = \'paid\')');
        const { Database } = require('bun:sqlite') as typeof import('bun:sqlite');
        const db = new Database(':memory:');
        db.run('CREATE TABLE orders(status text, total real)');
        db.run("INSERT INTO orders VALUES ('paid', 10), ('x', 20), ('paid', 30)");
        expect(db.query(sql).get()).toEqual({ paid_total: 40, n: 2 });
    });

    test('MySQL/Hive lower FILTER to CASE WHEN', () => {
        const src = `t: query { flag: bool, x: int } = table "t"
q = t & fold (u => { s = sum_where u.flag u.x })`;
        expect(render(src, 'mysql', 'compact')).toContain('SUM(CASE WHEN flag THEN x END)');
        expect(render(src, 'hive', 'compact')).toContain('SUM(CASE WHEN flag THEN x END)');
    });
});

describe('case-wrapped aggregates', () => {
    test('fold accepts CASE WHEN ... THEN SUM(...) ELSE SUM(...) END', () => {
        const src = `t: query { status: string, a: float, b: float } = table "t"
q = t & fold (o => { status = group o.status, x = case { o.status == "paid" => sum o.a, _ => sum o.b } })`;
        expect(typeErrors(src)).toEqual([]);
        const sql = render(src, 'sqlite', 'compact');
        expect(sql).toContain('CASE WHEN status = \'paid\' THEN SUM(a) ELSE SUM(b) END');
        const { Database } = require('bun:sqlite') as typeof import('bun:sqlite');
        const db = new Database(':memory:');
        db.run('CREATE TABLE t(status text, a real, b real)');
        db.run("INSERT INTO t VALUES ('paid', 10, 1), ('x', 20, 2)");
        expect(db.query(sql).all()).toEqual([{ status: 'paid', x: 10 }, { status: 'x', x: 2 }]);
    });

    test('plain columns still cannot hide inside a case aggregate', () => {
        const src = `t: query { status: string, a: float } = table "t"
q = t & fold (o => { x = case { o.status == "paid" => sum o.a, _ => o.a } })`;
        expect(typeErrors(src).join('\n')).toContain("fold entry 'x' case conditions must be constant or use grouped columns");
        expect(allErrors(src).join('\n')).toContain("fold entry 'x' case conditions must be constant or use grouped columns");
    });
});

describe('recursive CTEs', () => {
    // The first Langium parse builds the grammar lookahead tables and can
    // exceed Bun's 5-second default on slower CI runners.
    test('recursive computes transitive closure', () => {
        const src = `edges: query { src: int, dst: int } = table "edges"
q = edges & recursive (self => (edges & joinInner self (l => r => l.dst == r.src) (l => r => { src = l.src, dst = r.dst }))) & map (u => { src, dst })`;
        expect(typeErrors(src)).toEqual([]);
        const sql = render(src, 'sqlite', 'compact');
        expect(sql).toContain('WITH RECURSIVE');
        expect(sql).toContain('UNION ALL');
        const { Database } = require('bun:sqlite') as typeof import('bun:sqlite');
        const db = new Database(':memory:');
        db.run('CREATE TABLE edges(src int, dst int)');
        db.run('INSERT INTO edges VALUES (1,2),(2,3),(3,4)');
        expect(db.query(sql).all()).toHaveLength(6);
    }, 10_000);

    test('recursive CTEs are capability-gated for Hive', () => {
        const src = `edges: query { src: int, dst: int } = table "edges"
q = edges & recursive (self => (edges & joinInner self (l => r => l.dst == r.src) (l => r => { src = l.src, dst = r.dst })))`;
        expect(() => render(src, 'hive')).toThrow(/recursive CTEs are not supported/);
    });
});

describe('query parameters', () => {
    test('param renders dialect-native placeholders and PostgreSQL numbers them', () => {
        const src = `t: query { id: int, name: string } = table "t"
q = t & filter (u => u.id == (param "id" : int) && u.name == (param "name" : string))`;
        expect(render(src, 'sqlite', 'compact')).toContain('id = ?');
        const pg = render(src, 'postgresql', 'compact');
        expect(pg).toContain('id = $1');
        expect(pg).toContain('name = $2');
        expect(typeErrors(src)).toEqual([]);
    });

    test('the same parameter name is one numbered placeholder', () => {
        const src = `t: query { id: int } = table "t"
q = t & filter (u => u.id >= (param "x" : int) && u.id <= (param "x" : int))`;
        const pg = render(src, 'postgresql', 'compact');
        expect(pg).toContain('id >= $1');
        expect(pg).toContain('id <= $1');
        expect(pg).not.toContain('$2');
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
                r = round u.balance 2,
                g = greatest [u.balance, 1.5],
                full = concat [u.name, "-", u.name],
                sub = substring u.name 1 (just 3),
                pos = position u.name "a",
                li = like u.name "a%",
                nf = null_if (just u.name) (just ""),
                ci = cast u.id "string",
            })
        `;
        expect(typeErrors(src)).toEqual([]);
    });

    test('division follows Haskell base: / is float, div is integral', () => {
        expect(typeErrors(`${USERS}\nq = users & map (u => { x = u.balance / 2.0 })`)).toEqual([]);
        expect(typeErrors(`${USERS}\nq = users & map (u => { x = u.id / 2 })`)).not.toEqual([]);
        const sql = render(`${USERS}\nq = users & map (u => { d = div u.id 3, m = mod u.id 3, r = u.balance / 2.0 })`, 'mysql');
        expect(sql).toContain('id DIV 3 AS d');
        expect(sql).toContain('MOD(id, 3) AS m');
        expect(sql).toContain('balance / 2 AS r');
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
