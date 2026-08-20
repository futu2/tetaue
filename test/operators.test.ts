import { describe, expect, test } from 'bun:test';
import { checkProject } from '../src/language/checker.ts';
import type { ProjectModule } from '../src/language/imports.ts';
import { standardPrelude } from '../src/language/prelude.ts';
import { DIALECTS, renderQuery } from '../src/language/render.ts';
import { allErrors, parseModel, render, services, typeErrors } from './helpers.ts';
import { isBinaryExpression } from '../src/language/generated/ast.ts';

const NUMBERS = 'numbers: query { a: int, b: int } = table "numbers"';

function checkedSql(
    source: string,
    dependencies: readonly ProjectModule[] = [],
    rootImports: readonly { alias: string | undefined; target: ProjectModule }[] = [],
): string {
    const root: ProjectModule = { model: parseModel(source), uri: 'main.tetaue', imports: [] };
    const importsByModule = new Map(rootImports.length === 0 ? [] : [[root, rootImports.map((edge, index) => ({
        ...edge,
        importNode: root.model.imports[index]!,
    }))]]);
    const result = checkProject([...dependencies, root], {
        importsByModule,
        prelude: standardPrelude(services),
    });
    expect(result.diagnostics.map(d => d.message)).toEqual([]);
    if (result.value.kind !== 'query') throw new Error(`expected query, got ${result.value.kind}`);
    const rendered = renderQuery(result.value.query, DIALECTS.postgresql!, 'compact');
    if (!rendered.ok) throw new Error(rendered.diagnostics.map(d => d.message).join(' | '));
    return rendered.sql;
}

describe('Agda-style operator sections', () => {
    test('Functor, Applicative, Alternative, and Monad precedence is Haskell-like', () => {
        const model = parseModel('q = f <$> xs <|> ys >>= g');
        const root = model.bindings[0]!.value;
        expect(isBinaryExpression(root) && root.operator).toBe('>>=');
        if (!isBinaryExpression(root)) return;
        expect(isBinaryExpression(root.left) && root.left.operator).toBe('<|>');
        if (!isBinaryExpression(root.left)) return;
        expect(isBinaryExpression(root.left.left) && root.left.left.operator).toBe('<$>');
    });

    test('the new operators are valid in lambda bodies', () => {
        const source = `choose = xs => xs <|> [0]
flatMap = xs => xs >>= (x => [x, x + 1])
q = table "t"`;
        expect(typeErrors(source)).toEqual([]);
    });

    test('_+_ is the curried function form of +', () => {
        const sql = render(`${NUMBERS}
            q = numbers & map (r => {
                section = _+_ r.a r.b,
                infix = r.a + r.b,
            })`, 'postgresql', 'compact');
        expect(sql).toBe('SELECT a + b AS section, a + b AS infix FROM numbers');
    });

    test('sections are first-class and support partial application', () => {
        const source = `${NUMBERS}
            add = _+_
            increment = add 1
            apply_two = f => f 1 2
            q = numbers & map (r => {
                value = increment r.a,
                passed = apply_two _+_,
            })`;
        expect(typeErrors(source)).toEqual([]);
        expect(render(source, 'postgresql', 'compact'))
            .toBe('SELECT 1 + a AS "value", 1 + 2 AS passed FROM numbers');
    });

    test('a local operator binding controls both infix and section syntax', () => {
        const source = `_+_ = x => y => x - y
            add = _+_
            q = table "numbers" & map (r => {
                infix = 5 + 2,
                section = add 5 2,
            })`;
        expect(checkedSql(source))
            .toBe('SELECT 5 - 2 AS infix, 5 - 2 AS section FROM numbers');
    });

    test('a selectively imported operator binding controls infix syntax', () => {
        const library: ProjectModule = {
            model: parseModel('export _+_ = x => y => x - y'),
            uri: 'operators.tetaue',
            imports: [],
        };
        const source = `import "operators.tetaue" (_+_)
            q = table "numbers" & map (r => { result = 5 + 2 })`;
        expect(checkedSql(source, [library], [{ alias: undefined, target: library }]))
            .toBe('SELECT 5 - 2 AS result FROM numbers');
    });

    test('_>>>_ composes functions exactly like >>>', () => {
        const source = `${NUMBERS}
            project = _>>>_ (r => { a = r.a, b = r.b }) (r => { r | total = r.a + r.b })
            q = numbers & map project`;
        expect(typeErrors(source)).toEqual([]);
        expect(render(source, 'postgresql', 'compact')).toContain('a + b AS total');
    });

    test('_&_ and _$_ preserve pipeline and application argument order', () => {
        const viaPipeline = render(`${NUMBERS}\nq = _&_ numbers (take 2)`, 'postgresql', 'compact');
        const viaApply = render(`${NUMBERS}\nq = _$_ (take 2) numbers`, 'postgresql', 'compact');
        expect(viaPipeline).toBe('SELECT * FROM numbers LIMIT 2');
        expect(viaApply).toBe(viaPipeline);
    });

    test('named sections resolve ordinary curried functions from scope', () => {
        const source = `${NUMBERS}
            combine = x => y => x + y
            q = numbers & map (r => {
                quotient = _div_ r.a r.b,
                combined = _combine_ r.a r.b,
            })`;
        expect(typeErrors(source)).toEqual([]);
        const sql = render(source, 'postgresql', 'compact');
        expect(sql).toContain('a / b AS quotient');
        expect(sql).toContain('a + b AS combined');
    });

    test('operator sections retain the infix type checks', () => {
        expect(allErrors(`${NUMBERS}\nq = numbers & map (r => { bad = _+_ r.a "x" })`).join('\n'))
            .toContain("'+' requires numeric operands");
        expect(allErrors(`${NUMBERS}\nq = numbers & map (r => { bad = _missing_ r.a r.b })`).join('\n'))
            .toContain("unknown operator section '_missing_'");
    });
});

describe('`?` unwrap-with-default operator', () => {
    test('lowers to COALESCE and types as the default type', () => {
        const src = `users: query { id: int, email: (maybe string), nick: (maybe string) } = table "users"
main = users & map (u => { email = u.email ? "n/a", id = u.id })`;
        expect(typeErrors(src)).toEqual([]);
        const sql = render(src, 'postgresql', 'compact');
        expect(sql).toContain("COALESCE(email, 'n/a') AS email");
    });

    test('is a first-class curried operator section', () => {
        // `_?_` is ordinary prelude curried function; `x ? d` = `from_maybe d x`.
        const src = `users: query { id: int, nick: (maybe string) } = table "users"
unwrapped = users & map (u => { nick = _?_ u.nick "anon" })`;
        expect(typeErrors(src)).toEqual([]);
    });

    test('rejects a non-maybe left operand', () => {
        // `?` requires the left side to be nullable.
        const src = `users: query { id: int } = table "users"
main = users & map (u => { id = u.id ? 0 })`;
        expect(typeErrors(src)).not.toEqual([]);
    });
});
