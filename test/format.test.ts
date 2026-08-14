/******************************************************************************
 * tetaue formatter tests.
 ******************************************************************************/
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { NodeFileSystem } from 'langium/node';
import { createTetaueServices } from '../src/language/tetaue-module.js';
import { formatTetaue } from '../src/language/lsp/formatter.js';

const services = createTetaueServices(NodeFileSystem).tetaue;
const INDENT = '    ';

function fmt(text: string): string | undefined {
    return formatTetaue(text, INDENT, services);
}

function roundTrip(text: string): string {
    const once = fmt(text);
    expect(once).toBeDefined();
    expect(fmt(once!)).toBe(once); // idempotent
    return once!;
}

describe('tetaue formatter', () => {
    test('normalizes spacing inside records and types', () => {
        const out = roundTrip('users: query {id: int,name: string,active: bool} = table  "users"\n');
        expect(out).toBe('users: query { id: int, name: string, active: bool } = table "users"\n');
    });

    test('spaces binary operators', () => {
        const out = roundTrip('q = users&filter (u => u.age>=18&&u.active)&take 3\n');
        expect(out).toBe('q = users & filter (u => u.age >= 18 && u.active) & take 3\n');
    });

    test('keeps field access and $-params tight', () => {
        const out = roundTrip('a = $1.id == $2.user_id\n');
        expect(out).toBe('a = $1.id == $2.user_id\n');
    });

    test('preserves `-` adjacency (semantic!)', () => {
        expect(roundTrip('a = abs -1\n')).toBe('a = abs -1\n');
        expect(roundTrip('b = x - 1\n')).toBe('b = x - 1\n');
        expect(roundTrip('c = x-1\n')).toBe('c = x-1\n');
    });

    test('keeps strings and comments verbatim, moves comments after one space', () => {
        const out = roundTrip('x = "a  b\\U"\n# a comment\nq = 1# trailing\n');
        expect(out).toBe('x = "a  b\\U"\n# a comment\nq = 1 # trailing\n');
    });

    test('indents multi-line records and pipelines by bracket depth', () => {
        const input = [
            'users: query {',
            'id: int,',
            'name: string,',
            '} = table "users"',
            '',
            'adults = users',
            '& filter (u => u.active)',
            '& map (u => {',
            'id = u.id,',
            '})',
        ].join('\n');
        const expected = [
            'users: query {',
            '    id: int,',
            '    name: string,',
            '} = table "users"',
            '',
            'adults = users',
            '    & filter (u => u.active)',
            '    & map (u => {',
            '        id = u.id,',
            '    })',
        ].join('\n') + '\n';
        expect(roundTrip(input)).toBe(expected);
    });

    test('strips trailing whitespace and keeps blank lines', () => {
        const out = roundTrip('q = 1   \n\nr = 2\t\n');
        expect(out).toBe('q = 1\n\nr = 2\n');
    });

    test('multi-line join arguments stay in the pipeline context', () => {
        // The exact input the user reported: multi-line `join` arguments.
        const input = [
            'report: query {',
            '    user_id: int,',
            '    name: string,',
            '    order_count: int,',
            '    total_spent: float,',
            '} = adults',
            '    & map (u => { uid = u.id, name = u.name })',
            '    & join inner orders ',
            '      (l => r => l.uid == r.user_id) ',
            '      (l => r => {',
            '        user_id = r.user_id,',
            '        name = l.name,',
            '        order_id = r.id,',
            '        total = r.total, })',
            '    & fold (r => {',
            '        user_id = group r.user_id,',
            '        name = group r.name,',
            '        order_count = count r.order_id,',
            '        total_spent = sum r.total,',
            '    })',
            '    & sort (r => [desc r.total_spent])',
            '    & take 20',
        ].join('\n');
        const expected = [
            'report: query {',
            '    user_id: int,',
            '    name: string,',
            '    order_count: int,',
            '    total_spent: float,',
            '} = adults',
            '    & map (u => { uid = u.id, name = u.name })',
            '    & join inner orders',
            '    (l => r => l.uid == r.user_id)',
            '    (l => r => {',
            '        user_id = r.user_id,',
            '        name = l.name,',
            '        order_id = r.id,',
            '        total = r.total, })',
            '    & fold (r => {',
            '        user_id = group r.user_id,',
            '        name = group r.name,',
            '        order_count = count r.order_id,',
            '        total_spent = sum r.total,',
            '    })',
            '    & sort (r => [desc r.total_spent])',
            '    & take 20',
        ].join('\n') + '\n';
        expect(roundTrip(input)).toBe(expected);
    });

    test('a comment between continuation lines stays in the expression', () => {
        const input = [
            'q = users',
            '    & join inner orders',
            '# the on clause',
            '    (l => r => l.uid == r.user_id)',
            '    & take 5',
        ].join('\n');
        const expected = [
            'q = users',
            '    & join inner orders',
            '    # the on clause',
            '    (l => r => l.uid == r.user_id)',
            '    & take 5',
        ].join('\n') + '\n';
        expect(roundTrip(input)).toBe(expected);
    });

    test('formatting the canonical examples is a no-op', () => {
        for (const file of ['strings.tetaue', 'adults.tetaue', 'joins.tetaue', 'report.tetaue']) {
            const text = readFileSync(resolve(import.meta.dir, '..', 'examples', file), 'utf8');
            expect(fmt(text), file).toBe(text);
        }
    });

    test('returns undefined on unlexable input', () => {
        expect(fmt('q = "unterminated\n')).toBeUndefined();
    });
});
