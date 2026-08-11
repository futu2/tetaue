/******************************************************************************
 * Optics tests — the lens/optics core (Haskell lens/optics style).
 *
 * Covers: view (^.), over (%~), set (.~), first-class lenses (`field`),
 * optic composition, the `mapped` traversal, `filtered` selection, and their
 * diagnostics. `map`/`filter` are sugar over the optics and stay tested in
 * render.test.ts / review-fixes.test.ts.
 ******************************************************************************/
import { describe, expect, test } from 'bun:test';
import { errors, render } from './helpers.ts';

const USERS = `users = table "users" { id = int, name = string, age = int, active = bool }`;

describe('view (^.)', () => {
    test('u ^. field is view — renders the column', () => {
        const sql = render(`${USERS}
q = users & filtered (u => u ^. active && u ^. age >= 18)`);
        expect(sql).toContain('WHERE ("active" AND "age" >= 18)');
    });

    test('^. binds tighter than comparisons', () => {
        const sql = render(`${USERS}
q = users & filtered (u => u ^. age >= 18)`);
        expect(sql).toContain('WHERE ("age" >= 18)');
    });

    test('view (field "x") (u) is the functional form', () => {
        const sql = render(`${USERS}
q = users & filtered (u => view (field "age") (u) >= 18)`);
        expect(sql).toContain('WHERE ("age" >= 18)');
    });

    test('unknown field lens reports the available columns', () => {
        const messages = errors(`${USERS}
q = users & filtered (u => u ^. missing == 1)`);
        expect(messages.join('\n')).toContain("unknown column 'missing' — available: id, name, age, active");
    });

    test('viewing a field on a query is an error', () => {
        const messages = errors(`${USERS}
q = users ^. age`);
        expect(messages.join('\n')).toContain("cannot view field 'age' on a query");
    });
});

describe('over (%~)', () => {
    test('mapped <<< field %~ f transforms the column across rows', () => {
        const sql = render(`${USERS}
q = users & mapped <<< name %~ upper`);
        expect(sql).toContain('SELECT "id", UPPER("name") AS "name", "age", "active"');
    });

    test('record-level over keeps all fields inside a projection', () => {
        const sql = render(`${USERS}
q = users & map (u => u & name %~ upper)`);
        expect(sql).toContain('SELECT "id", UPPER("name") AS "name", "age", "active"');
    });

    test('a lambda transformer works: age %~ (a => a + 1)', () => {
        const sql = render(`${USERS}
q = users & mapped <<< age %~ (a => a + 1)`);
        expect(sql).toContain('SELECT "id", "name", "age" + 1 AS "age", "active"');
    });

    test('over on a non-record is an error', () => {
        const messages = errors(`${USERS}
q = users & filtered (u => (5 & name %~ upper))`);
        expect(messages.join('\n')).toContain("cannot set field 'name' on an expression of type int — expected a record");
    });
});

describe('set (.~)', () => {
    test('mapped <<< field .~ v sets a constant column', () => {
        const sql = render(`${USERS}
q = users & mapped <<< active .~ false`);
        expect(sql).toContain('SELECT "id", "name", "age", 0 AS "active"');
    });

    test('setting a field lens on a query lifts to the rows', () => {
        const sql = render(`${USERS}
q = users & age .~ 5`);
        expect(sql).toContain('SELECT "id", "name", 5 AS "age", "active"');
    });

    test('over a field lens on a query lifts to the rows (auto-traversal)', () => {
        const sql = render(`${USERS}
q = users & name %~ upper`);
        expect(sql).toContain('SELECT "id", UPPER("name") AS "name", "age", "active"');
    });
});

describe('first-class lenses (field)', () => {
    test('a bound lens views and composes under mapped', () => {
        const sql = render(`${USERS}
nick = field "name"
q = users & filtered (u => u ^. nick == "ada") & mapped <<< nick %~ upper`);
        expect(sql).toContain('WHERE ("name" = \'ada\')');
        expect(sql).toContain('SELECT "id", UPPER("name") AS "name", "age", "active"');
    });

    test('a bound lens can be set across rows', () => {
        const sql = render(`${USERS}
nick = field "name"
q = users & mapped <<< nick .~ "anon"`);
        expect(sql).toContain(`SELECT "id", 'anon' AS "name", "age", "active"`);
    });

    test('field requires a string name', () => {
        const messages = errors(`${USERS}
l = field 42
q = users & mapped <<< l %~ upper`);
        expect(messages.join('\n')).toContain('field expects a field name string');
    });
});

describe('composition', () => {
    test('nested records compose with <<<: r ^. a <<< b', () => {
        // value-level nested records; r ^. a <<< b is a composed lens
        const messages = errors(`${USERS}
r = { a = { b = 1 } }
q = users & filtered (u => (r ^. a <<< b == 1))`);
        expect(messages).toEqual([]);
    });

    test('an unbound property in a lens path is a field selector', () => {
        const sql = render(`${USERS}
q = users & mapped <<< age %~ (a => a * 2)`);
        expect(sql).toContain('"age" * 2 AS "age"');
    });

    test('>>> is the flip of <<< (PureScript composeFlipped)', () => {
        const forward = render(`${USERS}
q = users & mapped <<< name %~ upper`);
        const flipped = render(`${USERS}
q = users & name >>> mapped %~ upper`);
        expect(flipped).toBe(forward);
        expect(flipped).toContain('UPPER("name") AS "name"');
    });

    test('field access on an optic is an error that suggests <<<', () => {
        const messages = errors(`${USERS}
q = users & mapped.name %~ upper`);
        expect(messages.join('\n')).toContain('cannot access field \'name\' on a traversal (mapped)');
        expect(messages.join('\n')).toContain('(mapped) <<< name');
    });

    test('optics are not directly applicable — compose first', () => {
        const messages = errors(`${USERS}
q = users & field "name"`);
        expect(messages.join('\n')).toContain('cannot apply a lens (field "name")');
    });
});

describe('mapped traversal', () => {
    test('mapped %~ with a record lambda projects a subset', () => {
        const sql = render(`${USERS}
q = users & mapped %~ (u => { id = u.id, name = upper u.name })`);
        expect(sql).toContain('SELECT "id", UPPER("name") AS "name"');
    });

    test('mapped on a non-query is an error', () => {
        const messages = errors(`${USERS}
q = 5 & mapped <<< name %~ upper`);
        expect(messages.join('\n')).toContain('mapped operates on a query');
    });

    test('viewing a traversal is an error', () => {
        const messages = errors(`${USERS}
q = users & filtered (u => (view (mapped) (u) == 1))`);
        expect(messages.join('\n')).toContain('mapped is a traversal — view is undefined');
    });

    test('a setter built with %~ is first-class and reusable', () => {
        const sql = render(`${USERS}
up = name %~ upper
q = users & mapped %~ (u => u & up)`);
        expect(sql).toContain('SELECT "id", UPPER("name") AS "name", "age", "active"');
    });
});

describe('filtered selection', () => {
    test('filtered keeps rows matching the predicate', () => {
        const sql = render(`${USERS}
q = users & filtered (u => u.active && u ^. age >= 18) & take 5`);
        expect(sql).toContain('WHERE ("active" AND "age" >= 18)');
        expect(sql).toContain('LIMIT 5');
    });

    test('filtered after fold becomes HAVING', () => {
        const sql = render(`${USERS}
q = users & fold (u => { n = count u.id }) & filtered (r => r.n > 1)`);
        expect(sql).toContain('HAVING (COUNT("id") > 1)');
    });

    test('filtered composes with the other steps', () => {
        const sql = render(`${USERS}
q = users
    & filtered (u => u ^. age >= 18)
    & mapped %~ (u => { id = u.id, name = u.name })
    & sort (u => [asc u.name])
    & take 10`);
        expect(sql).toContain('WHERE ("age" >= 18)');
        expect(sql).toContain('SELECT "id", "name"');
        expect(sql).toContain('ORDER BY "name" ASC');
        expect(sql).toContain('LIMIT 10');
    });
});

describe('indexed lenses (ix)', () => {
    test('ix "name" is the field lens by index — view and over', () => {
        const sql = render(`${USERS}
q = users & filtered (u => u ^. ix "age" >= 18) & mapped <<< ix "name" %~ upper`);
        expect(sql).toContain('WHERE ("age" >= 18)');
        expect(sql).toContain('SELECT "id", UPPER("name") AS "name", "age", "active"');
    });

    test('a bound indexed lens composes under the traversal', () => {
        const sql = render(`${USERS}
nick = ix "name"
q = users & mapped <<< nick %~ upper`);
        expect(sql).toContain('SELECT "id", UPPER("name") AS "name", "age", "active"');
    });

    test('ix requires a field name string', () => {
        const messages = errors(`${USERS}
l = ix 42
q = users & mapped <<< l %~ upper`);
        expect(messages.join('\n')).toContain('ix expects a field name string');
    });
});

describe('at — the total map lens', () => {
    test('views a present key and transforms it (over)', () => {
        const sql = render(`${USERS}
q = users & filtered (u => u ^. at "age" >= 18) & mapped <<< at "name" %~ upper`);
        expect(sql).toContain('WHERE ("age" >= 18)');
        expect(sql).toContain('SELECT "id", UPPER("name") AS "name", "age", "active"');
    });

    test('set to none removes a key — exclude a column', () => {
        const sql = render(`${USERS}
q = users & at "name" .~ none`);
        expect(sql).toContain('SELECT "id", "age", "active"');
    });

    test('the key rename of map: copy with at, then remove the old key', () => {
        const sql = render(`${USERS}
q = users & mapped %~ (u => u & at "user_name" .~ u ^. at "name" & at "name" .~ none)`);
        expect(sql).toContain('SELECT "id", "age", "active", "name" AS "user_name"');
    });

    test('set adds a missing key to a row (computed column)', () => {
        const sql = render(`${USERS}
q = users & mapped %~ (u => u & at "tag" .~ "x")`);
        expect(sql).toContain(`SELECT "id", "name", "age", "active", 'x' AS "tag"`);
    });

    test('set replaces a present key on a row', () => {
        const sql = render(`${USERS}
q = users & at "name" .~ "anon"`);
        expect(sql).toContain(`SELECT "id", 'anon' AS "name", "age", "active"`);
    });

    test('value-level records: view missing key is none (no error), set adds, none removes', () => {
        const messages = errors(`${USERS}
r = { a = 1 }
r2 = r & at "b" .~ 2
r3 = r2 & at "a" .~ none
q = users & filtered (u => (r3 ^. at "b" == 2))`);
        expect(messages).toEqual([]);
    });

    test('over on an at key transforms the value', () => {
        const sql = render(`${USERS}
q = users & mapped <<< at "age" %~ (a => a + 1)`);
        expect(sql).toContain('SELECT "id", "name", "age" + 1 AS "age", "active"');
    });

    test('%~ requires a function (hint: use .~ or at "k" .~ none)', () => {
        const messages = errors(`${USERS}
q = users & at "name" %~ none`);
        expect(messages.join('\n')).toContain("'%~' expects a function");
    });

    test('at requires a key string', () => {
        const messages = errors(`${USERS}
l = at 42
q = users & (l .~ 1)`);
        expect(messages.join('\n')).toContain('at expects a key string');
    });

    test('at is total: an absent key does not error on view', () => {
        // view (at "b") (r) → none, distinct from the partial field lens
        const messages = errors(`${USERS}
r = { a = 1 }
q = users & filtered (u => (view (at "b") (r) == 1))`);
        expect(messages.join('\n')).toContain('got none');
    });
});

describe('function composition (<<< / >>>)', () => {
    test('<<< composes functions point-free: (u => u.age) <<< ...', () => {
        // lambdas are functions, so they compose like optics do
        const sql = render(`${USERS}
get_age = u => u ^. age
q = users & filtered ((u => u >= 18) <<< get_age)`);
        expect(sql).toContain('WHERE ("age" >= 18)');
    });

    test('a bound predicate function is reusable', () => {
        const sql = render(`${USERS}
adult = u => u ^. age >= 18
q = users & filtered (adult) & take 3`);
        expect(sql).toContain('WHERE ("age" >= 18)');
        expect(sql).toContain('LIMIT 3');
    });

    test('repeated filtered steps AND the predicates', () => {
        const sql = render(`${USERS}
q = users & filtered (u => u.active) & filtered (u => u.age >= 18) & take 5`);
        expect(sql).toContain('WHERE ("active") AND ("age" >= 18)');
        expect(sql).toContain('LIMIT 5');
    });
});

describe('lens diagnostics', () => {
    test('a column named after a builtin still views (u ^. upper)', () => {
        const sql = render(`things = table "things" { upper = int, count = int }
q = things & filtered (u => u ^. upper > u ^. count)`);
        expect(sql).toContain('WHERE ("upper" > "count")');
    });

    test('a non-lens binding does not shadow the column lens', () => {
        const sql = render(`${USERS}
age = 18
q = users & filtered (u => u ^. age == 18)`);
        expect(sql).toContain('WHERE ("age" = 18)');
    });

    test('a bound lens shadows the structural field of the same name', () => {
        const sql = render(`${USERS}
name = field "id"
q = users & filtered (u => u ^. name == 1)`);
        expect(sql).toContain('WHERE ("id" = 1)');
    });
});
