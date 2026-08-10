/******************************************************************************
 * tetaue SQL renderer — lowers a Query value to a SQL string.
 *
 * Dialects are capability-driven (like teta's backend): identifier quoting,
 * boolean literals and function-name mappings are resolved at render time.
 ******************************************************************************/
import type { JoinKind, Query, SqlNode } from './interpreter.js';

export interface DialectSpec {
    name: string;
    quoteIdentifier: (name: string) => string;
    boolLiteral: (b: boolean) => string;
    /** Render a string literal (dialects differ in backslash handling). */
    stringLiteral: (value: string) => string;
    /** canonical builtin name → SQL function name */
    functions: Record<string, string>;
}

function quoteSingleQuoted(value: string): string {
    return `'${value.replace(/'/g, "''")}'`;
}

function quoteMysql(value: string): string {
    // MySQL treats backslash as an escape character inside string literals.
    return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "''")}'`;
}

export const DIALECTS: Record<string, DialectSpec> = {
    sqlite: {
        name: 'sqlite',
        quoteIdentifier: name => `"${name}"`,
        boolLiteral: b => (b ? '1' : '0'),
        stringLiteral: quoteSingleQuoted,
        functions: {
            upper: 'UPPER', lower: 'LOWER', length: 'LENGTH', coalesce: 'COALESCE',
            abs: 'ABS', count: 'COUNT', sum: 'SUM', avg: 'AVG', min: 'MIN', max: 'MAX',
        },
    },
    postgresql: {
        name: 'postgresql',
        quoteIdentifier: name => `"${name}"`,
        boolLiteral: b => (b ? 'TRUE' : 'FALSE'),
        stringLiteral: quoteSingleQuoted,
        functions: {
            upper: 'UPPER', lower: 'LOWER', length: 'LENGTH', coalesce: 'COALESCE',
            abs: 'ABS', count: 'COUNT', sum: 'SUM', avg: 'AVG', min: 'MIN', max: 'MAX',
        },
    },
    mysql: {
        name: 'mysql',
        quoteIdentifier: name => `\`${name}\``,
        boolLiteral: b => (b ? 'TRUE' : 'FALSE'),
        stringLiteral: quoteMysql,
        functions: {
            upper: 'UPPER', lower: 'LOWER', length: 'LENGTH', coalesce: 'COALESCE',
            abs: 'ABS', count: 'COUNT', sum: 'SUM', avg: 'AVG', min: 'MIN', max: 'MAX',
        },
    },
};

export type RenderFormat = 'pretty' | 'compact';

export function isDialect(name: string): name is keyof typeof DIALECTS {
    return name in DIALECTS;
}

const JOIN_SQL: Record<JoinKind, string> = {
    inner: 'INNER JOIN', left: 'LEFT JOIN', right: 'RIGHT JOIN', full: 'FULL JOIN',
};

interface RenderCtx {
    dialect: DialectSpec;
    qualify: boolean;
}

function countTables(q: Query): number {
    return 1 + q.steps.filter(s => s.kind === 'join').length;
}

function lastProjection(q: Query): Extract<Query['steps'][number], { kind: 'map' | 'fold' }> | null {
    for (let i = q.steps.length - 1; i >= 0; i--) {
        const step = q.steps[i]!;
        if (step.kind === 'map' || step.kind === 'fold') return step;
    }
    return null;
}

// --- expression rendering --------------------------------------------------

// SQL operator precedence (higher binds tighter)
const PREC: Record<string, number> = {
    '||': 1, OR: 1,
    '&&': 2, AND: 2,
    '=': 3, '!=': 3, '<': 3, '<=': 3, '>': 3, '>=': 3,
    '+': 4, '-': 4,
    '*': 5, '/': 5, '%': 5,
    IN: 6, NOT: 6, 'IS NULL': 6,
    CALL: 7, ATOM: 8,
};

function parenIf(child: string, childPrec: number, parentPrec: number): string {
    return childPrec < parentPrec ? `(${child})` : child;
}

function precOf(key: string): number {
    return PREC[key] ?? 0;
}

function escapeString(value: string, dialect: DialectSpec): string {
    return dialect.stringLiteral(value);
}

export function renderExpr(node: SqlNode, ctx: RenderCtx, parentPrec = 0): string {
    switch (node.kind) {
        case 'lit': {
            let text: string;
            if (node.value === null) text = 'NULL';
            else if (typeof node.value === 'boolean') text = ctx.dialect.boolLiteral(node.value);
            else if (typeof node.value === 'string') text = escapeString(node.value, ctx.dialect);
            else text = String(node.value);
            return parenIf(text, precOf('ATOM'), parentPrec);
        }
        case 'col': {
            const q = ctx.qualify && node.table ? `${ctx.dialect.quoteIdentifier(node.table)}.` : '';
            return parenIf(`${q}${ctx.dialect.quoteIdentifier(node.name)}`, precOf('ATOM'), parentPrec);
        }
        case 'bin': {
            const prec = precOf(node.op) || 3;
            // Comparisons are non-associative in SQL: parenthesize nested comparisons.
            const isCmp = node.op === '=' || node.op === '!=' || node.op === '<' || node.op === '<=' || node.op === '>' || node.op === '>=';
            const childPrec = isCmp ? prec + 1 : prec;
            const left = renderExpr(node.left, ctx, childPrec);
            const right = renderExpr(node.right, ctx, childPrec);
            const text = `${left} ${node.op} ${right}`;
            return parenIf(text, prec, parentPrec);
        }
        case 'is-null': {
            const inner = renderExpr(node.expr, ctx, precOf('IS NULL'));
            const text = `${inner} IS ${node.negated ? 'NOT ' : ''}NULL`;
            return parenIf(text, precOf('IS NULL'), parentPrec);
        }
        case 'not': {
            const inner = renderExpr(node.expr, ctx, precOf('NOT'));
            return parenIf(`NOT ${inner}`, precOf('NOT'), parentPrec);
        }
        case 'call': {
            const name = ctx.dialect.functions[node.name] ?? node.name.toUpperCase();
            const text = `${name}(${node.args.map(a => renderExpr(a, ctx)).join(', ')})`;
            return parenIf(text, precOf('CALL'), parentPrec);
        }
        case 'in': {
            const inner = renderExpr(node.expr, ctx, precOf('IN'));
            const text = `${inner} ${node.negated ? 'NOT ' : ''}IN (${node.list.map(i => renderExpr(i, ctx)).join(', ')})`;
            return parenIf(text, precOf('IN'), parentPrec);
        }
        case 'agg': {
            const name = ctx.dialect.functions[node.name] ?? node.name.toUpperCase();
            const text = `${name}(${renderExpr(node.arg, ctx)})`;
            return parenIf(text, precOf('CALL'), parentPrec);
        }
        case 'group':
            return renderExpr(node.expr, ctx, parentPrec);
        case 'order':
            return renderExpr(node.expr, ctx, parentPrec);
    }
}

// --- query rendering -------------------------------------------------------

export function renderQuery(q: Query, dialect: DialectSpec, format: RenderFormat = 'pretty'): string {
    const ctx: RenderCtx = { dialect, qualify: countTables(q) > 1 };
    const clauses: string[] = [];

    // SELECT
    const projection = lastProjection(q);
    let select: string;
    if (projection) {
        select = projection.proj.fields
            .map(({ key, node }) => {
                const rendered = renderExpr(node, ctx);
                const isPlainCol = (node.kind === 'col' && node.name === key)
                    || (node.kind === 'group' && node.expr.kind === 'col' && node.expr.name === key);
                return isPlainCol ? rendered : `${rendered} AS ${dialect.quoteIdentifier(key)}`;
            })
            .join(', ');
    } else {
        select = '*';
    }
    clauses.push(`SELECT${q.distinct ? ' DISTINCT' : ''} ${select}`);
    clauses.push(`FROM ${dialect.quoteIdentifier(q.root.name)}`);

    // JOINs
    for (const step of q.steps) {
        if (step.kind === 'join') {
            const right = step.right;
            const rightAlias = right.aliases[0] ?? right.root.name;
            let rightSql: string;
            if (right.steps.length === 0 && !right.distinct) {
                // plain table: `JOIN "orders" [AS "orders_1"]`
                const aliasClause = rightAlias === right.root.name
                    ? ''
                    : ` AS ${dialect.quoteIdentifier(rightAlias)}`;
                rightSql = `${dialect.quoteIdentifier(right.root.name)}${aliasClause}`;
            } else {
                // stepped right side: render as a subquery so joins compose
                rightSql = `(${renderQuery(right, dialect, 'compact')}) AS ${dialect.quoteIdentifier(rightAlias)}`;
            }
            clauses.push(`${JOIN_SQL[step.joinKind]} ${rightSql} ON ${renderExpr(step.on, ctx)}`);
        }
    }

    // WHERE (predicates applied before aggregation)
    const wheres = q.steps
        .filter((s): s is Extract<Query['steps'][number], { kind: 'filter' }> => s.kind === 'filter' && !s.having)
        .map(s => renderExpr(s.cond, ctx));
    if (wheres.length > 0) {
        clauses.push(`WHERE ${wheres.map(w => `(${w})`).join(' AND ')}`);
    }

    // GROUP BY (from the last fold)
    const fold = [...q.steps].reverse().find(s => s.kind === 'fold');
    if (fold && fold.kind === 'fold') {
        const groups = fold.proj.fields
            .filter((f): f is { key: string; node: Extract<SqlNode, { kind: 'group' }> } => f.node.kind === 'group')
            .map(f => renderExpr(f.node.expr, ctx));
        if (groups.length > 0) {
            clauses.push(`GROUP BY ${groups.join(', ')}`);
        }
    }

    // HAVING (predicates applied after aggregation)
    const havings = q.steps
        .filter((s): s is Extract<Query['steps'][number], { kind: 'filter' }> => s.kind === 'filter' && s.having)
        .map(s => renderExpr(s.cond, ctx));
    if (havings.length > 0) {
        clauses.push(`HAVING ${havings.map(h => `(${h})`).join(' AND ')}`);
    }

    // ORDER BY
    const sorts = q.steps.filter(s => s.kind === 'sort').flatMap(s => s.items);
    if (sorts.length > 0) {
        clauses.push(`ORDER BY ${sorts.map(s => `${renderExpr(s.node, ctx)} ${s.dir}`).join(', ')}`);
    }

    // LIMIT
    const takes = q.steps.filter(s => s.kind === 'take');
    if (takes.length > 0) {
        const last = takes[takes.length - 1]!;
        clauses.push(`LIMIT ${last.n}`);
    }

    return format === 'compact' ? clauses.join(' ') : clauses.join('\n');
}
