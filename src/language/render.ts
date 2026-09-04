/******************************************************************************
 * tetaue SQL renderer — normalizes a Query value, then lowers it to SQL.
 *
 * Dialects are capability-driven (like teta's backend): identifier quoting,
 * boolean literals and function-name mappings are resolved at render time.
 ******************************************************************************/
import { querySchema, type JoinKind, type Query, type SetOp, type SqlNode } from './interpreter.js';
import type { BuiltinName } from './builtin.js';
import { optimizeQuery } from './optimize.js';
import { checkDialectCapabilities } from './capabilities.js';

export interface DialectSpec {
    name: string;
    /**
     * Quote an identifier ONLY when required: it is not a plain word
     * (`[A-Za-z_][A-Za-z0-9_]*`) or it collides with a reserved keyword.
     * `users`, `id`, `name` render bare; `order`, `user`, `weird name` are quoted.
     */
    quoteIdentifier: (name: string) => string;
    boolLiteral: (b: boolean) => string;
    /** Render a string literal (dialects differ in backslash handling). */
    stringLiteral: (value: string) => string;
    /** canonical builtin name → SQL function name */
    functions: Partial<Record<BuiltinName, string>>;
    /** Join kinds the dialect can render natively (default: all four). */
    joinKinds?: readonly JoinKind[];
    /** Set operations the dialect can render natively (default: all four). */
    setOps?: readonly SetOp[];
    /**
     * How to render OFFSET without LIMIT: 'standard' (OFFSET n alone),
     * 'mysql' (enormous LIMIT), 'sqlite' (LIMIT -1 OFFSET n), or
     * 'none' (no native OFFSET support — Hive).
     */
    offset?: 'standard' | 'mysql' | 'sqlite' | 'none';
    /** WITH RECURSIVE support (default: true; Hive does not support it). */
    recursive?: boolean;
    /** LATERAL derived-table support (default: true; SQLite/Trino/Hive lack the standard form). */
    lateral?: boolean;
}

/**
 * Reserved keywords that need quoting when used as identifiers — a
 * conservative union across the supported dialects. Over-quoting is always
 * valid SQL; under-quoting produces broken statements, so err on the side of
 * quoting anything reserved in ANY dialect. Matched case-insensitively.
 */
const RESERVED_KEYWORDS = new Set([
    'add', 'all', 'alter', 'and', 'any', 'as', 'asc', 'between', 'by', 'case',
    'check', 'collate', 'column', 'constraint', 'create', 'cross', 'current',
    'database', 'date', 'default', 'delete', 'desc', 'distinct', 'drop', 'else',
    'end', 'except', 'exists', 'false', 'fetch', 'for', 'foreign', 'from', 'full',
    'grant', 'group', 'having', 'in', 'index', 'inner', 'insert', 'intersect',
    'interval', 'into', 'is', 'join', 'key', 'lateral', 'left', 'like', 'limit',
    'natural', 'not', 'null', 'offset', 'on', 'or', 'order', 'outer', 'over',
    'partition', 'primary', 'references', 'revoke', 'right', 'row', 'rows',
    'select', 'set', 'table', 'then', 'time', 'to', 'true', 'union', 'unique',
    'update', 'user', 'using', 'value', 'values', 'view', 'when', 'where',
    'window', 'with', 'year',
]);

const SIMPLE_IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Quote `name` with `quote` only when it is not a plain word or is reserved. */
function quoteOnlyIfNeeded(name: string, quote: (n: string) => string): string {
    return SIMPLE_IDENT.test(name) && !RESERVED_KEYWORDS.has(name.toLowerCase()) ? name : quote(name);
}

/**
 * Quote a possibly schema-qualified name (`public.orders`,
 * `catalog.schema.table`) by quoting each dot-separated part separately,
 * e.g. `"public"."orders"`. Quoting the whole string (`"public.orders"`)
 * would name a single identifier containing a dot — not a qualified table.
 * A plain single-part name is passed through `quoteIdentifier` unchanged.
 */
function quoteQualifiedName(name: string, dialect: DialectSpec): string {
    return name.split('.').map(part => dialect.quoteIdentifier(part)).join('.');
}

function quoteDoubleQuoted(value: string): string {
    return `"${value.replace(/"/g, '""')}"`;
}

function quoteBacktickQuoted(value: string): string {
    return `\`${value.replace(/`/g, '``')}\``;
}

function quoteSingleQuoted(value: string): string {
    return `'${value.replace(/'/g, "''")}'`;
}

function quoteMysql(value: string): string {
    // MySQL treats backslash as an escape character inside string literals.
    return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "''")}'`;
}

export const DIALECTS: Readonly<Record<string, DialectSpec>> = {
    sqlite: {
        name: 'sqlite',
        offset: 'sqlite',
        lateral: false,
        quoteIdentifier: name => quoteOnlyIfNeeded(name, quoteDoubleQuoted),
        boolLiteral: b => (b ? '1' : '0'),
        stringLiteral: quoteSingleQuoted,
        functions: {
            coalesce: 'COALESCE',
            count: 'COUNT', sum: 'SUM', avg: 'AVG', min: 'MIN', max: 'MAX',
            array: 'JSON_GROUP_ARRAY', // sqlite has no array type — a JSON array is the closest list
        },
    },
    postgresql: {
        name: 'postgresql',
        quoteIdentifier: name => quoteOnlyIfNeeded(name, quoteDoubleQuoted),
        boolLiteral: b => (b ? 'TRUE' : 'FALSE'),
        stringLiteral: quoteSingleQuoted,
        functions: {
            coalesce: 'COALESCE',
            count: 'COUNT', sum: 'SUM', avg: 'AVG', min: 'MIN', max: 'MAX',
            array: 'ARRAY_AGG',
        },
    },
    mysql: {
        name: 'mysql',
        // MySQL has no FULL OUTER JOIN; users must emulate it (union of
        // left join and anti-join) in the source language.
        joinKinds: ['inner', 'left', 'right'],
        offset: 'mysql',
        quoteIdentifier: name => quoteOnlyIfNeeded(name, quoteBacktickQuoted),
        boolLiteral: b => (b ? 'TRUE' : 'FALSE'),
        stringLiteral: quoteMysql,
        functions: {
            coalesce: 'COALESCE',
            count: 'COUNT', sum: 'SUM', avg: 'AVG', min: 'MIN', max: 'MAX',
            array: 'JSON_ARRAYAGG',
        },
    },
    trino: {
        name: 'trino',
        lateral: false,
        quoteIdentifier: name => quoteOnlyIfNeeded(name, quoteDoubleQuoted),
        boolLiteral: b => (b ? 'TRUE' : 'FALSE'),
        stringLiteral: quoteSingleQuoted,
        functions: {
            coalesce: 'COALESCE',
            count: 'COUNT', sum: 'SUM', avg: 'AVG', min: 'MIN', max: 'MAX',
            array: 'ARRAY_AGG',
        },
    },
    hive: {
        name: 'hive',
        offset: 'none',
        recursive: false,
        lateral: false,
        // Hive supports UNION [ALL], but not INTERSECT/EXCEPT.
        setOps: ['UNION', 'UNION ALL'],
        quoteIdentifier: name => quoteOnlyIfNeeded(name, quoteBacktickQuoted),
        boolLiteral: b => (b ? 'TRUE' : 'FALSE'),
        stringLiteral: quoteMysql,
        functions: {
            coalesce: 'COALESCE',
            count: 'COUNT', sum: 'SUM', avg: 'AVG', min: 'MIN', max: 'MAX',
            array: 'COLLECT_LIST',
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

/** Indent width for the pretty layout (pg_format-style 4 spaces). */
const INDENT = '    ';

/** Indent every line of `text` by `prefix`. */
function indentLines(text: string, prefix: string): string {
    return text.split('\n').map(line => prefix + line).join('\n');
}

/**
 * Flatten a top-level `AND` chain into its operands so the pretty printer
 * can lay each predicate out on its own line. The interpreter stores
 * `a AND b AND c` as `(a AND b) AND c`; recursion yields `[a, b, c]`. Any
 * other expression is a single element. Precedence is preserved when
 * operands are re-rendered (an embedded OR is parenthesized), so splitting
 * never changes the query's meaning.
 */
function flattenAnds(node: SqlNode): SqlNode[] {
    if (node.kind === 'bin' && node.op === 'AND') {
        return [...flattenAnds(node.left), ...flattenAnds(node.right)];
    }
    return [node];
}

/**
 * A clause whose items can be laid out one per line in pretty mode
 * (SELECT list, GROUP BY, ORDER BY). A single item stays inline.
 */
function renderListClause(kw: string, items: string[], pretty: boolean): string {
    if (pretty && items.length > 1) {
        return `${kw}\n${items.map((item, i) => `${INDENT}${item}${i < items.length - 1 ? ',' : ''}`).join('\n')}`;
    }
    return `${kw} ${items.join(', ')}`;
}

/**
 * Render a boolean-predicate clause (WHERE/HAVING). In pretty mode each
 * top-level AND operand gets its own line (renderExpr adds precedence
 * parens); in compact mode the historical single-line rendering — each
 * predicate parenthesized when there is more than one — is kept verbatim.
 */
function renderPredicateClause(kw: string, conds: SqlNode[], ctx: RenderCtx, pretty: boolean): string {
    if (pretty) {
        const parts = conds.flatMap(flattenAnds).map(c => renderExpr(c, ctx, precOf('AND')));
        if (parts.length === 1) return `${kw} ${parts[0]}`;
        return `${kw}\n${INDENT}${parts.join(`\n${INDENT}AND `)}`;
    }
    const rendered = conds.map(c => renderExpr(c, ctx));
    return rendered.length === 1
        ? `${kw} ${rendered[0]}`
        : `${kw} ${rendered.map(w => `(${w})`).join(' AND ')}`;
}

export type ParameterState = Map<string, number>;
type CteMap = ReadonlyMap<Query, string>;

interface RenderCtx {
    dialect: DialectSpec;
    qualify: boolean;
    readonly diagnostics: RenderDiagnostic[];
    readonly parameters: ParameterState;
    readonly ctes: CteMap;
    /** Table aliases visible from enclosing query scopes. */
    readonly outerAliases: ReadonlySet<string>;
    /** Table aliases introduced by the query currently being rendered. */
    readonly innerAliases: ReadonlySet<string>;
}

function renderFailure(ctx: RenderCtx, node: SqlNode, message: string): string {
    ctx.diagnostics.push({ message, node });
    return 'NULL';
}

function countTables(q: Query): number {
    return 1 + q.steps.filter(s => s.kind === 'join').length;
}

function lastProjection(q: Query): Extract<Query['steps'][number], { kind: 'map' | 'fold' | 'join' }> | null {
    for (let i = q.steps.length - 1; i >= 0; i--) {
        const step = q.steps[i]!;
        // A join step's merger lambda is a projection too: it selects the
        // result row, so it may supply the SELECT list.
        if (step.kind === 'map' || step.kind === 'fold' || step.kind === 'join') return step;
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
    '*': 5, '/': 5,
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
        case 'in-query': {
            const sub = renderQueryWithDiagnostics(
                node.query,
                ctx.dialect,
                'compact',
                ctx.diagnostics,
                ctx.ctes,
                ctx.parameters,
                new Set([...ctx.outerAliases, ...ctx.innerAliases]),
            );
            const text = `${renderExpr(node.expr, ctx, precOf('IN'))} ${node.negated ? 'NOT ' : ''}IN (${sub})`;
            return parenIf(text, precOf('IN'), parentPrec);
        }
        case 'scalar': {
            const sub = renderQueryWithDiagnostics(
                node.query,
                ctx.dialect,
                'compact',
                ctx.diagnostics,
                ctx.ctes,
                ctx.parameters,
                new Set([...ctx.outerAliases, ...ctx.innerAliases]),
            );
            return parenIf(`(${sub})`, precOf('ATOM'), parentPrec);
        }
        case 'exists': {
            const sub = renderQueryWithDiagnostics(
                node.query,
                ctx.dialect,
                'compact',
                ctx.diagnostics,
                ctx.ctes,
                ctx.parameters,
                new Set([...ctx.outerAliases, ...ctx.innerAliases]),
            );
            return parenIf(`EXISTS (${sub})`, precOf('ATOM'), parentPrec);
        }
        case 'param': {
            const existing = ctx.parameters.get(node.name);
            const index = existing ?? ctx.parameters.size + 1;
            if (existing === undefined) ctx.parameters.set(node.name, index);
            const text = ctx.dialect.name === 'postgresql' ? '$' + index : '?';
            return parenIf(text, precOf('ATOM'), parentPrec);
        }
        case 'lit': {
            let text: string;
            if (node.value === null) text = 'NULL';
            else if (typeof node.value === 'boolean') text = ctx.dialect.boolLiteral(node.value);
            else if (typeof node.value === 'string') text = escapeString(node.value, ctx.dialect);
            else text = String(node.value);
            return parenIf(text, precOf('ATOM'), parentPrec);
        }
        case 'col': {
            const correlated = node.table !== null
                && ctx.outerAliases.has(node.table)
                && !ctx.innerAliases.has(node.table);
            const q = (ctx.qualify || correlated) && node.table
                ? `${quoteQualifiedName(node.table, ctx.dialect)}.`
                : '';
            return parenIf(`${q}${ctx.dialect.quoteIdentifier(node.name)}`, precOf('ATOM'), parentPrec);
        }
        case 'bare':
            // An unquoted SQL word (EXTRACT(YEAR FROM x) needs YEAR, not
            // 'YEAR') emitted by the sql_bare lowering primitive.
            return parenIf(node.name, precOf('ATOM'), parentPrec);
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
            const special = renderCall(node, ctx);
            if (special !== null) {
                return parenIf(special, precOf('CALL'), parentPrec);
            }
            const name = ctx.dialect.functions[node.name as BuiltinName] ?? node.name.toUpperCase();
            const text = `${name}(${node.args.map(a => renderExpr(a, ctx)).join(', ')})`;
            return parenIf(text, precOf('CALL'), parentPrec);
        }
        case 'current-date':
            return parenIf('CURRENT_DATE', precOf('ATOM'), parentPrec);
        case 'date-literal':
            return parenIf(
                ctx.dialect.name === 'sqlite'
                    ? ctx.dialect.stringLiteral(node.value)
                    : `DATE ${ctx.dialect.stringLiteral(node.value)}`,
                precOf('ATOM'),
                parentPrec,
            );
        case 'timestamp-literal':
            return parenIf(
                ctx.dialect.name === 'sqlite'
                    ? ctx.dialect.stringLiteral(node.value)
                    : `TIMESTAMP ${ctx.dialect.stringLiteral(node.value)}`,
                precOf('ATOM'),
                parentPrec,
            );
        case 'current-timestamp':
            return parenIf('CURRENT_TIMESTAMP', precOf('ATOM'), parentPrec);
        case 'in': {
            const inner = renderExpr(node.expr, ctx, precOf('IN'));
            const text = `${inner} ${node.negated ? 'NOT ' : ''}IN (${node.list.map(i => renderExpr(i, ctx)).join(', ')})`;
            return parenIf(text, precOf('IN'), parentPrec);
        }
        case 'agg': {
            const arg = renderExpr(node.arg, ctx);
            if (node.name === 'count_distinct') {
                const text = node.filter
                    ? `COUNT(DISTINCT CASE WHEN ${renderExpr(node.filter, ctx)} THEN ${arg} END)`
                    : `COUNT(DISTINCT ${arg})`;
                return parenIf(text, precOf('CALL'), parentPrec);
            }
            const baseName = node.name.endsWith('_where') ? node.name.slice(0, -6) : node.name;
            const name = ctx.dialect.functions[baseName as BuiltinName] ?? baseName.toUpperCase();
            if (!node.filter) {
                const text = `${name}(${arg})`;
                return parenIf(text, precOf('CALL'), parentPrec);
            }
            const cond = renderExpr(node.filter, ctx);
            const filteredArg = `CASE WHEN ${cond} THEN ${arg} END`;
            const text = ctx.dialect.name === 'postgresql' || ctx.dialect.name === 'trino' || ctx.dialect.name === 'sqlite'
                ? `${name}(${arg}) FILTER (WHERE ${cond})`
                : `${name}(${filteredArg})`;
            return parenIf(text, precOf('CALL'), parentPrec);
        }
        case 'group':
            return renderExpr(node.expr, ctx, parentPrec);
        case 'order':
            return renderExpr(node.expr, ctx, parentPrec);
        case 'window': {
            const fn = renderExpr(node.fn, ctx, precOf('CALL'));
            const inner: string[] = [];
            if (node.partition.length > 0) {
                inner.push(`PARTITION BY ${node.partition.map(p => renderExpr(p, ctx)).join(', ')}`);
            }
            if (node.order.length > 0) {
                inner.push(`ORDER BY ${node.order.map(o => `${renderExpr(o.node, ctx)} ${o.dir}`).join(', ')}`);
            }
            if (node.frame) {
                const to = node.frame.end === 0
                    ? 'CURRENT ROW'
                    : `${node.frame.end} FOLLOWING`;
                inner.push(`ROWS BETWEEN ${node.frame.start} PRECEDING AND ${to}`);
            }
            const over = inner.length > 0 ? ` OVER (${inner.join(' ')})` : ' OVER ()';
            return parenIf(`${fn}${over}`, precOf('CALL'), parentPrec);
        }
        case 'case': {
            // `case { c1 => v1, c2 => v2, ..., _ => e }` → CASE WHEN c1 THEN v1 WHEN c2 THEN v2 [ELSE e] END.
            // CASE is standard SQL in every supported dialect, so no per-dialect lowering.
            const text = `CASE ${node.branches.map(b => `WHEN ${renderExpr(b.cond, ctx)} THEN ${renderExpr(b.value, ctx)}`).join(' ')}${node.elseValue ? ` ELSE ${renderExpr(node.elseValue, ctx)}` : ''} END`;
            return parenIf(text, precOf('CALL'), parentPrec);
        }
    }
}

// --- date & time lowering --------------------------------------------------
// The general SQL date/time function set (teta's spec §4): every function has
// one tetaue name and a per-dialect lowering — direct, mapped, or fallback.
// Formats (`date_format`/`date_parse`) are dialect-native: pass the format
// string the target database expects (e.g. Trino/MySQL `%Y-%m-%d`,
// PostgreSQL `YYYY-MM-DD`, Hive `yyyy-MM-dd`).
// ---------------------------------------------------------------------------

/** Canonical builtin names that lower to dialect-specific date/time SQL. */
const DATE_FUNCTIONS = new Set<BuiltinName>([
    'extract', 'year', 'month', 'day', 'day_of_week', 'hour', 'minute', 'second',
    'date_add', 'date_diff', 'date_trunc',
    'date_format', 'date_parse', 'to_unixtime', 'from_unixtime',
]);

const DATE_UNIT_SQL: Record<string, string> = {
    year: 'YEAR', month: 'MONTH', week: 'WEEK', day: 'DAY',
    hour: 'HOUR', minute: 'MINUTE', second: 'SECOND',
};

/** Fixed duration used by dialects whose date-diff primitive is day-based. */
function unitSeconds(unit: string): number {
    return {
        year: 365 * 24 * 60 * 60,
        month: 30 * 24 * 60 * 60,
        week: 7 * 24 * 60 * 60,
        day: 24 * 60 * 60,
        hour: 60 * 60,
        minute: 60,
        second: 1,
    }[unit] ?? 86400;
}

/**
 * Dialect-specific render for a `call` node, or `null` to fall through to the
 * plain `NAME(args)` renderer. Covers the general SQL function set (teta's
 * spec): date/time functions plus the scalar functions whose lowering is not a
 * plain same-name call (sqlite fallbacks, binary forms and casts).
 */
const SPECIAL_CALLS = new Set<BuiltinName>([
    // date/time family (see renderDateFunction)
    'extract', 'year', 'month', 'day', 'day_of_week', 'hour', 'minute', 'second',
    'date_add', 'date_diff', 'date_trunc', 'date_format', 'date_parse',
    'to_unixtime', 'from_unixtime',
    // scalar family
    'concat', 'greatest', 'least', 'substring', 'reverse',
    'lpad', 'rpad', 'cast',
    'from_maybe', 'is_true', 'is_false', 'is_unknown',
]);

function renderCall(node: Extract<SqlNode, { kind: 'call' }>, ctx: RenderCtx): string | null {
    if (DATE_FUNCTIONS.has(node.name as BuiltinName)) return renderDateFunction(node, ctx);
    if (!SPECIAL_CALLS.has(node.name as BuiltinName)) return null;
    const d = ctx.dialect.name;
    const x = (i = 0) => renderExpr(node.args[i]!, ctx, precOf('CALL'));

    switch (node.name) {
        case 'concat': {
            const parts = node.args.map(a => renderExpr(a, ctx));
            if (d === 'sqlite') {
                // SQLite has no CONCAT; || propagates NULL, so COALESCE each
                // argument to the empty string to match CONCAT semantics.
                return parts.map(p => `COALESCE(${p}, '')`).join(' || ');
            }
            return `CONCAT(${parts.join(', ')})`;
        }
        case 'greatest': case 'least': {
            if (d !== 'sqlite') return null; // GREATEST/LEAST via the default path
            // SQLite has scalar MAX/MIN with GREATEST/LEAST-like NULL semantics.
            const fn = node.name === 'greatest' ? 'MAX' : 'MIN';
            return `${fn}(${node.args.map(a => renderExpr(a, ctx)).join(', ')})`;
        }
        case 'substring': {
            // value, start, length?
            const len = node.args[2] ? x(2) : null;
            if (d === 'sqlite') return len ? `SUBSTR(${x()}, ${x(1)}, ${len})` : `SUBSTR(${x()}, ${x(1)})`;
            return len ? `SUBSTRING(${x()}, ${x(1)}, ${len})` : `SUBSTRING(${x()}, ${x(1)})`;
        }
        case 'reverse':
            if (d === 'sqlite') {
                // A scalar recursive CTE reverses one character per step and
                // remains correlated with the current row expression.
                return `(WITH RECURSIVE __tetaue_reverse(i, value) AS (`
                    + `SELECT LENGTH(${x()}), '' UNION ALL `
                    + `SELECT i - 1, value || SUBSTR(${x()}, i, 1) `
                    + `FROM __tetaue_reverse WHERE i > 0`
                    + `) SELECT value FROM __tetaue_reverse WHERE i = 0)`;
            }
            return `REVERSE(${x()})`;
        case 'lpad': case 'rpad':
            // SQLite has no LPAD/RPAD.  printf() produces a run of spaces and
            // replace() turns it into the requested pad string. CASE handles
            // native LPAD/RPAD behavior when the input is already too long.
            if (d === 'sqlite') {
                const value = x();
                const width = x(1);
                const pad = node.args[2] ? x(2) : ctx.dialect.stringLiteral(' ');
                const fill = `REPLACE(PRINTF('%*s', ${width}, ''), ' ', ${pad})`;
                const missing = `${width} - LENGTH(${value})`;
                const truncated = `SUBSTR(${value}, 1, ${width})`;
                return node.name === 'lpad'
                    ? `CASE WHEN LENGTH(${value}) >= ${width} THEN ${truncated} ELSE SUBSTR(${fill}, 1, ${missing}) || ${value} END`
                    : `CASE WHEN LENGTH(${value}) >= ${width} THEN ${truncated} ELSE ${value} || SUBSTR(${fill}, 1, ${missing}) END`;
            }
            if (node.args.length === 2) {
                // MySQL/Trino/Hive require the pad string; PostgreSQL defaults
                // to a space. Make the default explicit for a uniform lowering.
                return `${node.name.toUpperCase()}(${x()}, ${x(1)}, ' ')`;
            }
            return null;
        case 'from_maybe':
            return `COALESCE(${x()}, ${x(1)})`;
        case 'is_true':
            return `${x()} IS TRUE`;
        case 'is_false':
            return `${x()} IS FALSE`;
        case 'is_unknown':
            // IS UNKNOWN is not accepted by every supported backend;
            // for a boolean expression SQL UNKNOWN is exactly NULL.
            return `${x()} IS NULL`;
        case 'cast': {
            const type = node.args[1]?.kind === 'lit' ? sqlTypeName(String(node.args[1]!.value), d) : 'INTEGER';
            return `CAST(${x()} AS ${type})`;
        }
    }
    return null;
}

/** tetaue scalar type name → per-dialect SQL cast type. */
function sqlTypeName(t: string, d: string): string {
    switch (t) {
        case 'int': return d === 'hive' ? 'INT' : d === 'mysql' ? 'SIGNED' : 'INTEGER';
        case 'decimal': return d === 'postgresql' ? 'NUMERIC' : 'DECIMAL';
        case 'float': return d === 'sqlite' ? 'REAL' : d === 'postgresql' ? 'DOUBLE PRECISION' : 'DOUBLE';
        case 'string': return d === 'mysql' ? 'CHAR' : d === 'hive' ? 'STRING' : d === 'sqlite' ? 'TEXT' : 'VARCHAR';
        case 'bool':
            return d === 'sqlite' ? 'INTEGER' : 'BOOLEAN';
        case 'date': return 'DATE';
        case 'timestamp': return 'TIMESTAMP';
    }
    return t.toUpperCase();
}

function renderDateFunction(node: Extract<SqlNode, { kind: 'call' }>, ctx: RenderCtx): string {
    const d = ctx.dialect.name;
    const [value, second, third] = node.args;
    const x = () => renderExpr(value!, ctx, precOf('CALL'));
    const str = (n?: SqlNode): string | null => (n?.kind === 'lit' && typeof n.value === 'string' ? n.value : null);
    const num = (n?: SqlNode): number | null => (n?.kind === 'lit' && typeof n.value === 'number' ? n.value : null);
    const unit = () => str(second) ?? 'day';
    const arg = () => renderExpr(third!, ctx, precOf('CALL'));

    switch (node.name) {
        case 'extract':
            return renderDatePart(d, str(second) ?? 'day', x());

        case 'year': case 'month': case 'day': case 'day_of_week':
        case 'hour': case 'minute': case 'second':
            return renderDatePart(d, node.name, x());

        case 'date_add': return renderDateAdd(d, x(), unit(), third!, arg, num);
        case 'date_diff': return renderDateDiff(d, x(), unit(), arg());
        case 'date_trunc': return renderDateTrunc(d, x(), unit());
        case 'date_format': return renderDateFormat(d, x(), str(second) ?? '%Y-%m-%d', ctx.dialect.stringLiteral);
        case 'date_parse': return renderDateParse(d, x(), str(second) ?? '%Y-%m-%d', ctx.dialect.stringLiteral);
        case 'to_unixtime': return renderToUnixtime(d, x());
        case 'from_unixtime': return renderFromUnixtime(d, x());
    }
    return renderFailure(ctx, node, `unknown date function '${node.name}'`);
}

/** EXTRACT / date-part lowering for the given field over a rendered value. */
function renderDatePart(d: string, field: string, x: string): string {
    switch (d) {
        case 'sqlite': {
            const fmt: Record<string, string> = { year: '%Y', month: '%m', day: '%d', hour: '%H', minute: '%M', second: '%S', day_of_week: '%w' };
            return `CAST(STRFTIME('${fmt[field] ?? '%Y'}', ${x}) AS INTEGER)`;
        }
        case 'postgresql': {
            const f: Record<string, string> = { year: 'YEAR', month: 'MONTH', day: 'DAY', hour: 'HOUR', minute: 'MINUTE', second: 'SECOND', day_of_week: 'DOW' };
            return `EXTRACT(${f[field] ?? field.toUpperCase()} FROM ${x})`;
        }
        case 'mysql':
            if (field === 'day_of_week') return `DAYOFWEEK(${x})`;
            return `EXTRACT(${DATE_UNIT_SQL[field] ?? field.toUpperCase()} FROM ${x})`;
        case 'trino': {
            const f: Record<string, string> = { year: 'YEAR', month: 'MONTH', day: 'DAY', hour: 'HOUR', minute: 'MINUTE', second: 'SECOND', day_of_week: 'DAY_OF_WEEK' };
            return `EXTRACT(${f[field] ?? field.toUpperCase()} FROM ${x})`;
        }
        case 'hive': {
            if (field === 'day_of_week') return `DAYOFWEEK(${x})`;
            return `${DATE_UNIT_SQL[field] ?? field.toUpperCase()}(${x})`;
        }
        default:
            return `EXTRACT(${field.toUpperCase()} FROM ${x})`;
    }
}

/** `date_add value unit amount` — unit is interpreter-validated. */
function renderDateAdd(d: string, x: string, unit: string, amount: SqlNode, renderAmount: () => string, num: (n?: SqlNode) => number | null): string {
    const a = renderAmount();
    switch (d) {
        case 'postgresql':
            return `${x} + (${a}) * INTERVAL '1 ${unit}'`;
        case 'mysql': {
            const amt = num(amount);
            const inner = amt !== null ? `${amt}` : `(${a})`;
            return `DATE_ADD(${x}, INTERVAL ${inner} ${DATE_UNIT_SQL[unit] ?? unit.toUpperCase()})`;
        }
        case 'sqlite': {
            const amt = num(amount);
            if (amt !== null) {
                const mod = unit === 'week' ? `${amt * 7} days` : `${amt} ${unit}s`;
                return `DATETIME(${x}, '${amt >= 0 ? '+' : ''}${mod}')`;
            }
            const modifier = unit === 'week'
                ? `PRINTF('%+d days', (${a}) * 7)`
                : `PRINTF('%+d ${unit}s', ${a})`;
            // The modifier is computed in SQL, so column/parameter amounts
            // work just like literal amounts on the other backends.
            return `DATETIME(${x}, ${modifier})`;
        }
        case 'trino':
            return `DATE_ADD('${unit}', ${a}, ${x})`;
        case 'hive': {
            const amt = num(amount);
            const inner = amt !== null ? `'${amt}'` : `(${a})`;
            return `${x} + INTERVAL ${inner} ${DATE_UNIT_SQL[unit] ?? unit.toUpperCase()}`;
        }
        default:
            return `DATE_ADD('${unit}', ${a}, ${x})`;
    }
}

/** `date_diff value unit other` — calendar-ish diff (other - value) in units. */
function renderDateDiff(d: string, x: string, unit: string, other: string): string {
    switch (d) {
        case 'postgresql':
            if (unit === 'week') return `EXTRACT(DAY FROM (${other} - ${x})) / 7`;
            return `EXTRACT(${DATE_UNIT_SQL[unit] ?? unit.toUpperCase()} FROM (${other} - ${x}))`;
        case 'mysql':
            return `TIMESTAMPDIFF(${DATE_UNIT_SQL[unit] ?? unit.toUpperCase()}, ${x}, ${other})`;
        case 'sqlite': {
            // JULIANDAY is SQLite's portable timestamp primitive.  For units
            // without a calendar-aware builtin, use the corresponding fixed
            // duration; this is the same elapsed-time interpretation used by
            // Trino's DATE_DIFF for timestamps.
            const factor: Record<string, number> = {
                year: 1 / 365, month: 1 / 30, week: 1 / 7,
                day: 1, hour: 24, minute: 1440, second: 86400,
            };
            const diff = `(JULIANDAY(${other}) - JULIANDAY(${x}))`;
            const scale = factor[unit] ?? 1;
            return scale === 1 ? `CAST(${diff} AS INTEGER)` : `CAST(${diff} * ${scale} AS INTEGER)`;
        }
        case 'trino':
            return `DATE_DIFF('${unit}', ${x}, ${other})`;
        case 'hive':
            if (unit === 'day') return `DATEDIFF(${other}, ${x})`;
            // Hive's DATEDIFF is day-granular; convert the timestamp delta to
            // the requested unit so the same source expression remains valid.
            return `CAST((UNIX_TIMESTAMP(${other}) - UNIX_TIMESTAMP(${x})) / ${unitSeconds(unit)} AS BIGINT)`;
        default:
            return `DATE_DIFF('${unit}', ${x}, ${other})`;
    }
}

/** `date_trunc value unit`. */
function renderDateTrunc(d: string, x: string, unit: string): string {
    switch (d) {
        case 'postgresql':
        case 'trino':
            return `DATE_TRUNC('${unit}', ${x})`;
        case 'mysql':
            switch (unit) {
                case 'year': return `STR_TO_DATE(DATE_FORMAT(${x}, '%Y-01-01'), '%Y-%m-%d')`;
                case 'month': return `STR_TO_DATE(DATE_FORMAT(${x}, '%Y-%m-01'), '%Y-%m-%d')`;
                case 'week': return `DATE_SUB(DATE(${x}), INTERVAL WEEKDAY(${x}) DAY)`;
                case 'day': return `DATE(${x})`;
                case 'hour': return `DATE_FORMAT(${x}, '%Y-%m-%d %H:00:00')`;
                case 'minute': return `DATE_FORMAT(${x}, '%Y-%m-%d %H:%i:00')`;
                case 'second': return `DATE_FORMAT(${x}, '%Y-%m-%d %H:%i:%s')`;
                default: return `DATE(${x})`;
            }
        case 'sqlite': {
            if (unit === 'week') {
                return `DATE(${x}, '-' || ((CAST(STRFTIME('%w', ${x}) AS INTEGER) + 6) % 7) || ' days')`;
            }
            const f: Record<string, string> = {
                year: '%Y-01-01', month: '%Y-%m-01',
                day: '%Y-%m-%d', hour: '%Y-%m-%d %H:00:00',
                minute: '%Y-%m-%d %H:%M:00', second: '%Y-%m-%d %H:%M:%S',
            };
            return `STRFTIME('${f[unit] ?? f.day}', ${x})`;
        }
        case 'hive': {
            const f: Record<string, string> = {
                year: 'YYYY', month: 'MM', week: 'WEEK', day: 'DD',
            };
            if (f[unit] !== undefined) return `TRUNC(${x}, '${f[unit]}')`;
            return `FROM_UNIXTIME(FLOOR(UNIX_TIMESTAMP(${x}) / ${unitSeconds(unit)}) * ${unitSeconds(unit)})`;
        }
        default:
            return `DATE_TRUNC('${unit}', ${x})`;
    }
}

/** `date_format value format` — dialect-native format string. */
function renderDateFormat(d: string, x: string, format: string, quote: (v: string) => string): string {
    const f = quote(format);
    switch (d) {
        case 'postgresql':
            return `TO_CHAR(${x}, ${f})`;
        case 'mysql': case 'trino': case 'hive':
            return `DATE_FORMAT(${x}, ${f})`;
        case 'sqlite':
            return `STRFTIME(${f}, ${x})`;
        default:
            return `DATE_FORMAT(${x}, ${f})`;
    }
}

/** `date_parse value format` — dialect-native format string. */
function renderDateParse(d: string, x: string, format: string, quote: (v: string) => string): string {
    const f = quote(format);
    switch (d) {
        case 'postgresql':
            return `TO_TIMESTAMP(${x}, ${f})`;
        case 'mysql':
            return `STR_TO_DATE(${x}, ${f})`;
        case 'sqlite':
            return `DATETIME(${x})`; // sqlite parses many formats natively; the format is ignored
        case 'trino':
            return `DATE_PARSE(${x}, ${f})`;
        case 'hive':
            return `FROM_UNIXTIME(UNIX_TIMESTAMP(${x}, ${f}))`;
        default:
            return `DATE_PARSE(${x}, ${f})`;
    }
}

/** `to_unixtime value` — unix seconds. */
function renderToUnixtime(d: string, x: string): string {
    switch (d) {
        case 'postgresql':
            return `EXTRACT(EPOCH FROM ${x})`;
        case 'mysql': case 'hive':
            return `UNIX_TIMESTAMP(${x})`;
        case 'sqlite':
            return `CAST(STRFTIME('%s', ${x}) AS INTEGER)`;
        case 'trino':
            return `TO_UNIXTIME(${x})`; // double seconds
        default:
            return `TO_UNIXTIME(${x})`;
    }
}

/** `from_unixtime value` — unix seconds to a timestamp. */
function renderFromUnixtime(d: string, x: string): string {
    switch (d) {
        case 'postgresql':
            return `TO_TIMESTAMP(${x})`;
        case 'mysql': case 'hive':
            return `FROM_UNIXTIME(${x})`;
        case 'sqlite':
            return `DATETIME(${x}, 'unixepoch')`;
        case 'trino':
            return `FROM_UNIXTIME(${x})`;
        default:
            return `FROM_UNIXTIME(${x})`;
    }
}

// --- set-operation rendering ------------------------------------------------

const NO_CTES: CteMap = new Map();

function renderSetQuery(q: Query, dialect: DialectSpec, format: RenderFormat, diagnostics: RenderDiagnostic[], ctes: CteMap, parameters: ParameterState, outerAliases: ReadonlySet<string>): string {
    const index = q.steps.findIndex(s => s.kind === 'set');
    const step = q.steps[index]!;
    if (step.kind !== 'set') {
        diagnostics.push({ message: 'internal: set step expected', node: step });
        return 'SELECT * FROM (SELECT NULL) AS "render_error"';
    }
    if (dialect.setOps && !dialect.setOps.includes(step.op)) {
        diagnostics.push({
            message: `${step.op} is not supported for the ${dialect.name} dialect`,
            node: step,
        });
        return 'SELECT NULL';
    }
    const left: Query = { ...q, steps: q.steps.slice(0, index) };
    const right = step.right;

    // SQL set operations match columns POSITIONALLY, while tetaue rows are
    // unordered records. Never rely on `SELECT *` here: project an explicit,
    // shared column order on both operands. A dynamic (un-annotated) table
    // has no known order and cannot be rendered safely as a set operand.
    if (!left.known || !right.known) {
        diagnostics.push({
            message: `${step.op} requires known schemas on both operands — annotate each table or project it with map first`,
            node: step,
        });
        return 'SELECT NULL';
    }
    const labels = [...querySchema(left).keys()];
    const rightLabels = new Set(querySchema(right).keys());
    for (const label of labels) {
        if (!rightLabels.has(label)) {
            diagnostics.push({
                message: `${step.op} requires matching columns — right operand is missing '${label}'`,
                node: step,
            });
            return 'SELECT NULL';
        }
    }

    const innerFormat: RenderFormat = format === 'pretty' ? 'pretty' : 'compact';
    const leftSql = renderQueryWithDiagnostics(left, dialect, innerFormat, diagnostics, ctes, parameters, outerAliases);
    const rightSql = renderQueryWithDiagnostics(right, dialect, innerFormat, diagnostics, ctes, parameters, outerAliases);
    const columns = labels.map(label => dialect.quoteIdentifier(label)).join(', ');
    const wrap = (sql: string, alias: string): string => {
        const aliasSql = dialect.quoteIdentifier(alias);
        return format === 'pretty'
            ? `SELECT ${columns}\nFROM (\n${indentLines(sql, INDENT)}\n) AS ${aliasSql}`
            : `SELECT ${columns} FROM (${sql}) AS ${aliasSql}`;
    };
    const leftOp = wrap(leftSql, '_tetaue_left');
    const rightOp = wrap(rightSql, '_tetaue_right');
    return format === 'pretty' ? `${leftOp}\n${step.op}\n${rightOp}` : `${leftOp} ${step.op} ${rightOp}`;
}

// --- query rendering -------------------------------------------------------

function renderQueryWithDiagnostics(q: Query, dialect: DialectSpec, format: RenderFormat, diagnostics: RenderDiagnostic[], ctes: CteMap = NO_CTES, parameters: ParameterState = new Map(), outerAliases: ReadonlySet<string> = new Set()): string {
    // A set step is a complete relational operation, not a clause in the
    // surrounding SELECT: render it as operand-wrapped UNION/INTERSECT/EXCEPT.
    if (q.steps.some(s => s.kind === 'set')) return renderSetQuery(q, dialect, format, diagnostics, ctes, parameters, outerAliases);

    const innerAliases = new Set(q.aliases);
    const ctx: RenderCtx = { dialect, qualify: countTables(q) > 1, diagnostics, parameters, ctes, innerAliases, outerAliases };
    const pretty = format === 'pretty';
    const clauses: string[] = [];

    let recursivePrefix = '';
    if (q.recursive) {
        if (dialect.recursive === false) {
            diagnostics.push({ message: `recursive CTEs are not supported for the ${dialect.name} dialect`, node: q.recursive });
            return 'SELECT NULL';
        }
        const rec = q.recursive;
        const baseSql = renderQueryWithDiagnostics(q.root.from!, dialect, 'compact', diagnostics, ctes, parameters, outerAliases);
        const termSql = renderQueryWithDiagnostics(rec.term, dialect, 'compact', diagnostics, ctes, parameters, outerAliases);
        const name = dialect.quoteIdentifier(rec.name);
        if (pretty) {
            recursivePrefix = `WITH RECURSIVE ${name} AS (\n${indentLines(baseSql, INDENT)}\nUNION ALL\n${indentLines(termSql, INDENT)}\n)\n`;
        } else {
            recursivePrefix = `WITH RECURSIVE ${name} AS (${baseSql} UNION ALL ${termSql}) `;
        }
    }

    // SELECT
    const projection = lastProjection(q);
    let select: string;
    if (projection) {
        const items = projection.proj.fields.map(({ key, node }) => {
            const rendered = renderExpr(node, ctx);
            const isPlainCol = (node.kind === 'col' && node.name === key)
                || (node.kind === 'group' && node.expr.kind === 'col' && node.expr.name === key);
            return isPlainCol ? rendered : `${rendered} AS ${dialect.quoteIdentifier(key)}`;
        });
        const head = `SELECT${q.distinct ? ' DISTINCT' : ''}`;
        select = pretty && items.length > 1
            ? renderListClause(head, items, true)
            : `${head} ${items.join(', ')}`;
    } else {
        select = `SELECT${q.distinct ? ' DISTINCT' : ''} *`;
    }
    clauses.push(select);
    // A schema-qualified root name (`public.users`) is aliased to its last
    // segment so column references render as `alias.column`, never
    // `schema.table.column` (invalid in Hive, SQLite, and others). Plain
    // names need no alias — the table name is already a valid qualifier.
    // A derived-table root (a fold wrapped by a later map/join) renders as a
    // subquery with its own alias.
    if (q.root.from) {
        if (q.recursive) {
            clauses.push(`FROM ${dialect.quoteIdentifier(q.recursive.name)}`);
        } else {
            const cteName = ctes.get(q.root.from);
            if (cteName !== undefined) {
                // A CTE reference is a bare table; the site's own alias
                // (`q.aliases[0]`, the name outer columns are qualified
                // with) must be reapplied or every `alias.column` reference
                // would point at a nonexistent table. Skipped when the CTE
                // name already matches.
                const siteAlias = q.aliases[0] ?? q.root.name;
                clauses.push(`FROM ${dialect.quoteIdentifier(cteName)}${cteName !== siteAlias ? ` AS ${dialect.quoteIdentifier(siteAlias)}` : ''}`);
            } else {
                const derivedAlias = q.aliases[0] ?? q.root.name;
                clauses.push(pretty
                    ? `FROM (\n${indentLines(renderQueryWithDiagnostics(q.root.from, dialect, 'pretty', ctx.diagnostics, ctes, ctx.parameters, outerAliases), INDENT)}\n) AS ${dialect.quoteIdentifier(derivedAlias)}`
                    : `FROM (${renderQueryWithDiagnostics(q.root.from, dialect, 'compact', ctx.diagnostics, ctes, ctx.parameters, outerAliases)}) AS ${dialect.quoteIdentifier(derivedAlias)}`);
            }
        }
    } else {
        const rootAlias = q.aliases[0] ?? q.root.name;
        const rootAliasClause = ctx.qualify && rootAlias !== q.root.name
            ? ` AS ${dialect.quoteIdentifier(rootAlias)}`
            : '';
        clauses.push(`FROM ${quoteQualifiedName(q.root.name, dialect)}${rootAliasClause}`);
    }

    // JOINs
    for (const step of q.steps) {
        if (step.kind === 'join') {
            if (step.lateral && dialect.lateral === false) {
                ctx.diagnostics.push({ message: `lateral joins are not supported for the ${dialect.name} dialect`, node: step });
                continue;
            }
            const right = step.right;
            const rightAlias = right.aliases[0] ?? right.root.name;
            const plainTable = !step.lateral && right.steps.length === 0 && !right.distinct && !right.root.from;
            let rightSql: string;
            if (plainTable) {
                // plain table: `JOIN orders [AS orders_1]`
                const aliasClause = rightAlias === right.root.name
                    ? ''
                    : ` AS ${dialect.quoteIdentifier(rightAlias)}`;
                rightSql = `${quoteQualifiedName(right.root.name, dialect)}${aliasClause}`;
            } else {
                // stepped or derived right side: render as a subquery so
                // joins compose
                // Lateral rights are correlated with the left row, so they
                // are never collected as CTEs; guard the lookup anyway.
                const cteName = step.lateral ? undefined : ctes.get(right);
                rightSql = cteName !== undefined
                    // Reapply the join-site alias: the CTE name may differ
                    // from the alias the ON clause qualifies columns with.
                    ? `${dialect.quoteIdentifier(cteName)}${cteName !== rightAlias ? ` AS ${dialect.quoteIdentifier(rightAlias)}` : ''}`
                    : pretty
                        ? `(\n${indentLines(renderQueryWithDiagnostics(right, dialect, 'pretty', ctx.diagnostics, ctes, ctx.parameters, step.lateral ? new Set([...ctx.outerAliases, ...ctx.innerAliases]) : outerAliases), INDENT)}\n) AS ${dialect.quoteIdentifier(rightAlias)}`
                        : `(${renderQueryWithDiagnostics(right, dialect, 'compact', ctx.diagnostics, ctes, ctx.parameters, step.lateral ? new Set([...ctx.outerAliases, ...ctx.innerAliases]) : outerAliases)}) AS ${dialect.quoteIdentifier(rightAlias)}`;
            }
            if (dialect.joinKinds && !dialect.joinKinds.includes(step.joinKind)) {
                ctx.diagnostics.push({
                    message: `${step.joinKind} join is not supported for the ${dialect.name} dialect`,
                    node: step,
                });
                continue;
            }
            const onClause = `ON ${renderExpr(step.on, ctx)}`;
            // In pretty mode a subquery join is laid out vertically so the
            // ON condition sits on its own indented line.
            const joinKeyword = step.lateral ? 'INNER JOIN LATERAL' : JOIN_SQL[step.joinKind];
            clauses.push(pretty && !plainTable
                ? `${joinKeyword} ${rightSql}\n${INDENT}${onClause}`
                : `${joinKeyword} ${rightSql} ${onClause}`);
        }
    }

    // WHERE (predicates applied before aggregation)
    const whereNodes = q.steps
        .filter((s): s is Extract<Query['steps'][number], { kind: 'filter' }> => s.kind === 'filter' && !s.having)
        .map(s => s.cond);
    if (whereNodes.length > 0) {
        clauses.push(renderPredicateClause('WHERE', whereNodes, ctx, pretty));
    }

    // GROUP BY (from the last fold)
    const fold = [...q.steps].reverse().find(s => s.kind === 'fold');
    if (fold && fold.kind === 'fold') {
        const groups = fold.proj.fields
            .filter((f): f is { key: string; node: Extract<SqlNode, { kind: 'group' }> } => f.node.kind === 'group')
            .map(f => renderExpr(f.node.expr, ctx));
        if (groups.length > 0) {
            clauses.push(renderListClause('GROUP BY', groups, pretty));
        }
    }

    // HAVING (predicates applied after aggregation)
    const havingNodes = q.steps
        .filter((s): s is Extract<Query['steps'][number], { kind: 'filter' }> => s.kind === 'filter' && s.having)
        .map(s => s.cond);
    if (havingNodes.length > 0) {
        clauses.push(renderPredicateClause('HAVING', havingNodes, ctx, pretty));
    }

    // ORDER BY
    const sorts = q.steps.filter(s => s.kind === 'sort').flatMap(s => s.items);
    if (sorts.length > 0) {
        clauses.push(renderListClause('ORDER BY', sorts.map(s => `${renderExpr(s.node, ctx)} ${s.dir}`), pretty));
    }

    // LIMIT / OFFSET
    // Within one Query object, interpreter boundaries guarantee that all
    // drop steps precede all take steps. SQL's clause order is exactly that:
    // OFFSET skips first, LIMIT keeps the next rows.
    const drops = q.steps.filter(s => s.kind === 'drop');
    const takes = q.steps.filter(s => s.kind === 'take');
    const offset = drops.reduce((sum, s) => sum + s.n, 0);
    if (offset > 0) {
        const offsetMode = dialect.offset ?? 'standard';
        if (offsetMode === 'none') {
            ctx.diagnostics.push({ message: `OFFSET (drop) is not supported for the ${dialect.name} dialect`, node: drops[0] });
        } else if (takes.length > 0) {
            const last = takes[takes.length - 1]!;
            clauses.push(`LIMIT ${last.n} OFFSET ${offset}`);
        } else if (offsetMode === 'mysql') {
            clauses.push(`LIMIT 18446744073709551615 OFFSET ${offset}`);
        } else if (offsetMode === 'sqlite') {
            clauses.push(`LIMIT -1 OFFSET ${offset}`);
        } else {
            clauses.push(`OFFSET ${offset}`);
        }
    } else if (takes.length > 0) {
        const last = takes[takes.length - 1]!;
        clauses.push(`LIMIT ${last.n}`);
    }

    const body = pretty ? clauses.join('\n') : clauses.join(' ');
    return recursivePrefix + body;
}

export interface RenderDiagnostic {
    message: string;
    /** The originating SQL/IR node when known. */
    node?: unknown;
}

export type RenderResult =
    | { ok: true; sql: string; parameters: string[] }
    | { ok: false; diagnostics: RenderDiagnostic[] };

/**
 * Walk the render tree to collect named, non-trivial subqueries in `q` in
 * dependency order so they can be emitted as CTEs. The top-level query is
 * never a CTE. Lateral join rights are correlated with the enclosing left
 * row, so they are never collected (inline only).
 */
function collectCtes(top: Query, dialect: DialectSpec): CteMap {
    const ctes = new Map<Query, string>();
    const used = new Map<string, number>();
    // Real table names anywhere in the render tree (including lateral right
    // subtrees). A CTE must not reuse one: in standard SQL the CTE name is
    // in scope from the WITH keyword on, so `WITH t AS (SELECT * FROM t ...)`
    // self-references the CTE (SQLite: "circular reference") instead of the
    // real table. Suffix the claimed name until it is collision-free.
    const tableNames = new Set<string>();
    const collectTables = (q: Query): void => {
        if (q.root.from) {
            collectTables(q.root.from);
        } else {
            tableNames.add(q.root.name);
        }
        for (const step of q.steps) {
            if (step.kind === 'join' || step.kind === 'set') collectTables(step.right);
        }
    };
    collectTables(top);

    const claim = (name: string): string => {
        let i = used.get(name) ?? 0;
        let candidate = i === 0 ? name : `${name}_${i}`;
        while (tableNames.has(candidate)) {
            i += 1;
            candidate = `${name}_${i}`;
        }
        used.set(name, i + 1);
        return candidate;
    };

    const visit = (q: Query, parent: Query | null): void => {
        if (q.root.from) visit(q.root.from, q);
        for (const step of q.steps) {
            if (step.kind === 'join' && step.lateral) continue; // correlated: inline only
            if (step.kind === 'join' || step.kind === 'set') visit(step.right, q);
        }
        // A shared query is reached once per reference site; claim it on the
        // first visit so repeated references keep a stable, unsuffixed name.
        if (parent !== null && !ctes.has(q) && q.name && (q.steps.length > 0 || q.distinct || q.root.from)) {
            ctes.set(q, claim(q.name));
        }
    };

    visit(top, null);
    return ctes;
}

/** Assemble the `WITH name AS (...), ...` header for a CTE map. */
function renderCtes(bodies: readonly { name: string; sql: string }[], dialect: DialectSpec): string {
    if (bodies.length === 0) return '';
    return `WITH ${bodies.map((b, i) => `${dialect.quoteIdentifier(b.name)} AS (\n${indentLines(b.sql, INDENT)}\n)${i < bodies.length - 1 ? ',' : ''}`).join('\n')}\n`;
}

/**
 * Pure renderer entry point: lowering errors are data, not exceptions.
 * Dialect capability failures are preflighted before this lowering pass;
 * defensive checks remain in the renderer for malformed hand-built IR.
 * Every named intermediate query is emitted as a `WITH name AS (...)` CTE,
 * so the body references it by name instead of duplicating the subquery.
 */
export function renderQuery(q: Query, dialect: DialectSpec, format: RenderFormat = 'pretty'): RenderResult {
    const diagnostics: RenderDiagnostic[] = [];
    const parameters: ParameterState = new Map();
    try {
        const normalized = optimizeQuery(q);
        const capabilityDiagnostics = checkDialectCapabilities(normalized, dialect);
        if (capabilityDiagnostics.length > 0) return { ok: false, diagnostics: capabilityDiagnostics };
        const ctes = collectCtes(normalized, dialect);
        const bodies = [...ctes].map(([query, name]) => {
            const sql = renderQueryWithDiagnostics(query, dialect, 'compact', diagnostics, ctes, parameters);
            return { name, sql };
        });
        const body = renderQueryWithDiagnostics(normalized, dialect, format, diagnostics, ctes, parameters);
        if (diagnostics.length > 0) return { ok: false, diagnostics };
        return { ok: true, sql: renderCtes(bodies, dialect) + body, parameters: [...parameters.keys()] };
    } catch (err) {
        return {
            ok: false,
            diagnostics: [{
                message: err instanceof Error ? err.message : String(err),
                node: undefined,
            }],
        };
    }
}

/**
 * Compatibility alias: CTE rendering is now the default; this entry point
 * exists for callers that previously opted in explicitly.
 */
export function renderQueryWithCtes(q: Query, dialect: DialectSpec, format: RenderFormat = 'pretty'): RenderResult {
    return renderQuery(q, dialect, format);
}
