import { describe, expect, test } from 'bun:test';
import { NodeFileSystem } from 'langium/node';
import { createTetaueServices } from '../src/language/tetaue-module.js';
import { standardPrelude } from '../src/language/prelude.js';
import { createPreludeEnv } from '../src/language/interpreter.js';
import { Inferencer } from '../src/language/inference.js';
import { checkProject } from '../src/language/checker.js';
import { renderQuery, DIALECTS } from '../src/language/render.js';
import type { Model } from '../src/language/generated/ast.js';

const services = createTetaueServices(NodeFileSystem).tetaue;

function checked(source: string, dialect: string) {
    const parsed = services.parser.LangiumParser.parse(source);
    expect(parsed.lexerErrors).toEqual([]);
    expect(parsed.parserErrors).toEqual([]);
    const result = checkProject(
        [{ model: parsed.value as Model, uri: undefined, imports: [] }],
        {
            prelude: standardPrelude(services),
            requireQuery: false,
            dialect: DIALECTS[dialect as keyof typeof DIALECTS],
        },
    );
    return result;
}

function render(source: string, dialect: string): string {
    const result = checked(source, dialect);
    expect(result.diagnostics.map(d => d.message)).toEqual([]);
    expect(result.value.kind).toBe('query');
    if (result.value.kind !== 'query') return '';
    const rendered = renderQuery(result.value.query, DIALECTS[dialect as keyof typeof DIALECTS]!, 'compact');
    if (!rendered.ok) throw new Error(rendered.diagnostics.map(d => d.message).join(' | '));
    return rendered.sql;
}

const USERS = 'users: query { name: string } = table "users"\n';

describe('sql_dialect', () => {
    test('is seeded as a record value with the dialect name', () => {
        const env = createPreludeEnv(DIALECTS.postgresql);
        const d = env.get('sql_dialect');
        expect(d?.kind).toBe('record');
        if (!d || d.kind !== 'record') return;
        expect(d.fields.map(f => f.key)).toContain('name');
        const name = d.fields.find(f => f.key === 'name');
        expect(name?.value.kind).toBe('expr');
    });

    test('is typed as a record in the inferencer prelude', () => {
        const inf = new Inferencer();
        inf.prelude(DIALECTS.sqlite);
        const scheme = inf.env.get('sql_dialect');
        expect(scheme).toBeDefined();
    });

    test('branches at analysis time: per-dialect lowering via case + sql_func', () => {
        const src = USERS + `
            position = x => n => case sql_dialect.name {
                "mysql"  => sql_func "LOCATE" [n, x],
                "sqlite" => sql_func "INSTR" [x, n],
                _        => sql_func "POSITION" [n, x],
            }
            main = users & map (u => { p = position u.name "a" })
        `;
        expect(render(src, 'mysql')).toContain(`LOCATE('a', name)`);
        expect(render(src, 'sqlite')).toContain(`INSTR(name, 'a')`);
        expect(render(src, 'trino')).toContain(`POSITION('a', name)`);
        expect(render(src, 'postgresql')).toContain(`POSITION('a', name)`);
    });

    test('case with a literal condition short-circuits instead of emitting SQL CASE', () => {
        const src = USERS + `
            label = case sql_dialect.name {
                "mysql" => "mysql-db",
                _       => "other",
            }
            main = users & map (u => { l = label })
        `;
        expect(render(src, 'mysql')).toContain(`'mysql-db'`);
        expect(render(src, 'sqlite')).toContain(`'other'`);
        expect(render(src, 'mysql')).not.toContain('CASE');
        expect(render(src, 'sqlite')).not.toContain('CASE');
    });

    test('sql_func emits an uninterpreted call node', () => {
        const src = USERS + `main = users & map (u => { n = sql_func "UPPER" [u.name] })`;
        expect(render(src, 'trino')).toContain(`UPPER(name)`);
    });

    test('sql_bare emits an unquoted SQL word, unlike a string literal', () => {
        // Function-position parens are pure style (sql_func "EXTRACT" [...]
        // is identical). What IS required is argument-position grouping: a
        // parenthesized atom in argument position ((sql_bare)) stays one
        // argument, but a nested application must be wrapped whole
        // (((sql_bare) "YEAR")) or it splits into sibling arguments of the
        // enclosing call — the same reason sql_infix "IN" n x is passed as a
        // list element above.
        const src = USERS + `
            events: query { happened_at: date } = table "events"
            main = events & map (e => { y = sql_func "EXTRACT" [((sql_infix) "FROM") ((sql_bare) "YEAR") e.happened_at] })
        `;
        expect(render(src, 'postgresql')).toContain(`EXTRACT(YEAR FROM happened_at)`);
        expect(render(src, 'postgresql')).not.toContain(`'YEAR'`);
        expect(render(src, 'postgresql')).not.toContain(`"YEAR"`);
    });
});
