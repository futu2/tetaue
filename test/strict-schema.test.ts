/******************************************************************************
 * Schema-driven projection and the `# strict` pragma.
 *
 * A binding's `query { ... }` annotation is a real COLUMN CONTRACT: a query
 * whose row shape is known projects exactly those columns instead of `SELECT *`
 * (the column list a wildcard would have hidden is what the annotation
 * declares). An un-annotated (dynamic) table keeps `SELECT *`; `# strict` turns
 * that remaining wildcard into an error.
 ******************************************************************************/
import { describe, expect, test } from 'bun:test';
import { NodeFileSystem } from 'langium/node';
import { createTetaueServices } from '../src/language/tetaue-module.ts';
import type { TetaueServices } from '../src/language/tetaue-module.ts';
import { compileModuleText } from '../src/language/compile.ts';
import { render } from './helpers.ts';

const services: TetaueServices = createTetaueServices(NodeFileSystem).tetaue;

const ANNOTATED = `users: query { id: int, name: string, age: int, active: bool } = table "users"`;

function sqlOf(source: string, dialect = 'sqlite', format: 'pretty' | 'compact' = 'compact'): string {
    const outcome = compileModuleText('file:///strict-schema.tetaue', source, services, { dialect, format });
    if (!outcome.ok) throw new Error(`compile failed: ${outcome.diagnostics.map(d => d.message).join(' | ')}`);
    return outcome.sql;
}

function messagesOf(source: string): string[] {
    const outcome = compileModuleText('file:///strict-schema.tetaue', source, services, {});
    return outcome.ok ? [] : outcome.diagnostics.map(d => d.message);
}

describe('schema-driven projection', () => {
    test('an annotated table projects its declared columns, in declaration order', () => {
        expect(sqlOf(`${ANNOTATED}\nmain = users`)).toBe('SELECT id, name, age, active FROM users');
    });

    test('an annotated filter-only pipeline projects the schema, not *', () => {
        expect(sqlOf(`${ANNOTATED}\nmain = users & filter (u => u.active)`))
            .toBe('SELECT id, name, age, active FROM users WHERE active');
    });

    test('a projection narrows the columns a later schema names', () => {
        // `map` decides the row; the SELECT follows the projected record.
        expect(sqlOf(`${ANNOTATED}\nmain = users & map (u => { name = u.name })`))
            .toBe('SELECT name FROM users');
    });

    test('a distinct query projects its columns', () => {
        expect(sqlOf(`${ANNOTATED}\nmain = users & distinct`))
            .toBe('SELECT DISTINCT id, name, age, active FROM users');
    });

    test('an un-annotated table still renders SELECT *', () => {
        expect(sqlOf('main = table "users"')).toBe('SELECT * FROM users');
    });

    test('an un-annotated table with a map projection names its columns', () => {
        expect(sqlOf('main = table "users" & map (u => { id = u.id })'))
            .toBe('SELECT id FROM users');
    });

    test('a named intermediate projects its schema too, CTE or inlined', () => {
        const sql = sqlOf(`${ANNOTATED}\npaid = users & filter (u => u.active)\nmain = paid & take 2`);
        // Whichever shape the optimizer picks, the wildcard never appears.
        expect(sql).not.toContain('SELECT *');
        expect(sql).toContain('id, name, age, active');
    });

    test('EXISTS subqueries stay shape-independent (SELECT 1)', () => {
        const sql = sqlOf(`users: query { id: int } = table "users"
orders: query { user_id: int } = table "orders"
main = users & filter (u => exists (orders & filter (o => o.user_id == u.id)))`);
        expect(sql).toBe('SELECT id FROM users WHERE EXISTS (SELECT 1 FROM orders WHERE user_id = users.id)');
    });

    test('the projected columns execute against a real engine', () => {
        const { Database } = require('bun:sqlite') as typeof import('bun:sqlite');
        const db = new Database(':memory:');
        db.run('CREATE TABLE users (id int, name text, age int, active int)');
        db.run(`INSERT INTO users VALUES (1, 'a', 30, 1), (2, 'b', 12, 1)`);
        const sql = sqlOf(`${ANNOTATED}\nmain = users & filter (u => u.age >= 18)`);
        expect(db.query(sql).all()).toEqual([{ id: 1, name: 'a', age: 30, active: 1 }]);
    });
});

describe('the `# strict` pragma', () => {
    test('rejects a wildcard projection from an un-annotated table', () => {
        expect(messagesOf('# strict\nmain = table "users" & take 2').join('\n'))
            .toContain('strict schema');
    });

    test('accepts an annotated table', () => {
        expect(messagesOf(`# strict\n${ANNOTATED}\nmain = users & take 2`)).toEqual([]);
    });

    test('accepts a dynamic table that is projected with map', () => {
        expect(messagesOf('# strict\nmain = table "users" & map (u => { id = u.id })')).toEqual([]);
    });

    test('accepts a schema-less EXISTS subquery (it renders SELECT 1)', () => {
        expect(messagesOf(`# strict
users: query { id: int } = table "users"
main = users & filter (u => exists (table "other"))`)).toEqual([]);
    });

    test('a nested subquery that names its columns is fine, even over a dynamic table', () => {
        // The inner `map` decides the inner SELECT list (`y`), so no wildcard is
        // emitted anywhere and strict mode has nothing to reject.
        expect(messagesOf(`# strict
users: query { id: int } = table "users"
main = users & map (u => { id = u.id, v = scalar (table "other" & map (o => { y = o.y }) & take 1) })`)).toEqual([]);
    });

    test('a nested subquery over a dynamic table is already rejected by arity, not strict mode', () => {
        // `scalar`/`inQuery` need exactly one column; a dynamic table offers
        // none, so the arity check fires first and strict mode never sees it.
        expect(messagesOf(`# strict
users: query { id: int } = table "users"
main = users & filter (u => inQuery u.id (table "other"))`).join('\n'))
            .toContain('must return exactly one column');
    });

    test('the pragma is opt-in: the same module passes without it', () => {
        expect(messagesOf('main = table "users" & take 2')).toEqual([]);
    });

    test('the pragma is recognized only on the first line', () => {
        // `# strict` in a later comment is prose, not a directive.
        expect(messagesOf('main = table "users"\n# strict\n')).toEqual([]);
    });

    test('render refuses a strict module rather than emitting SELECT *', () => {
        const outcome = compileModuleText('file:///s.tetaue', '# strict\nmain = table "users"', services, {});
        expect(outcome.ok).toBe(false);
    });

    test('non-strict rendering is unaffected', () => {
        expect(render('q = table "users"', 'sqlite', 'compact')).toBe('SELECT * FROM users');
    });
});
