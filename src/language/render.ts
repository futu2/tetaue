/******************************************************************************
 * tetaue SQL renderer — lowers a Query value to a SQL string.
 *
 * Dialects are capability-driven (like teta's backend): identifier quoting,
 * boolean literals and function-name mappings are resolved at render time.
 ******************************************************************************/
import type { JoinKind, Query, SqlNode } from './interpreter.js';

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
    functions: Record<string, string>;
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
        quoteIdentifier: name => quoteOnlyIfNeeded(name, n => `"${n}"`),
        boolLiteral: b => (b ? '1' : '0'),
        stringLiteral: quoteSingleQuoted,
        functions: {
            upper: 'UPPER', lower: 'LOWER', length: 'LENGTH', coalesce: 'COALESCE',
            abs: 'ABS', count: 'COUNT', sum: 'SUM', avg: 'AVG', min: 'MIN', max: 'MAX',
            list: 'JSON_GROUP_ARRAY', // sqlite has no array type — a JSON array is the closest list
            ceil: 'CEILING', // sqlite has CEILING, not CEIL
        },
    },
    postgresql: {
        name: 'postgresql',
        quoteIdentifier: name => quoteOnlyIfNeeded(name, n => `"${n}"`),
        boolLiteral: b => (b ? 'TRUE' : 'FALSE'),
        stringLiteral: quoteSingleQuoted,
        functions: {
            upper: 'UPPER', lower: 'LOWER', length: 'LENGTH', coalesce: 'COALESCE',
            abs: 'ABS', count: 'COUNT', sum: 'SUM', avg: 'AVG', min: 'MIN', max: 'MAX',
            list: 'ARRAY_AGG',
        },
    },
    mysql: {
        name: 'mysql',
        quoteIdentifier: name => quoteOnlyIfNeeded(name, n => `\`${n}\``),
        boolLiteral: b => (b ? 'TRUE' : 'FALSE'),
        stringLiteral: quoteMysql,
        functions: {
            upper: 'UPPER', lower: 'LOWER', length: 'LENGTH', coalesce: 'COALESCE',
            abs: 'ABS', count: 'COUNT', sum: 'SUM', avg: 'AVG', min: 'MIN', max: 'MAX',
            list: 'JSON_ARRAYAGG',
        },
    },
    trino: {
        name: 'trino',
        quoteIdentifier: name => quoteOnlyIfNeeded(name, n => `"${n}"`),
        boolLiteral: b => (b ? 'TRUE' : 'FALSE'),
        stringLiteral: quoteSingleQuoted,
        functions: {
            upper: 'UPPER', lower: 'LOWER', length: 'LENGTH', coalesce: 'COALESCE',
            abs: 'ABS', count: 'COUNT', sum: 'SUM', avg: 'AVG', min: 'MIN', max: 'MAX',
            list: 'ARRAY_AGG',
        },
    },
    hive: {
        name: 'hive',
        quoteIdentifier: name => quoteOnlyIfNeeded(name, n => `\`${n}\``),
        boolLiteral: b => (b ? 'TRUE' : 'FALSE'),
        stringLiteral: quoteMysql,
        functions: {
            upper: 'UPPER', lower: 'LOWER', length: 'LENGTH', coalesce: 'COALESCE',
            abs: 'ABS', count: 'COUNT', sum: 'SUM', avg: 'AVG', min: 'MIN', max: 'MAX',
            list: 'COLLECT_LIST',
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

interface RenderCtx {
    dialect: DialectSpec;
    qualify: boolean;
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
            const q = ctx.qualify && node.table ? `${quoteQualifiedName(node.table, ctx.dialect)}.` : '';
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
            const special = renderCall(node, ctx);
            if (special !== null) {
                return parenIf(special, precOf('CALL'), parentPrec);
            }
            const name = ctx.dialect.functions[node.name] ?? node.name.toUpperCase();
            const text = `${name}(${node.args.map(a => renderExpr(a, ctx)).join(', ')})`;
            return parenIf(text, precOf('CALL'), parentPrec);
        }
        case 'current-date':
            return parenIf('CURRENT_DATE', precOf('ATOM'), parentPrec);
        case 'current-timestamp':
            return parenIf('CURRENT_TIMESTAMP', precOf('ATOM'), parentPrec);
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
        case 'window': {
            const fn = renderExpr(node.fn, ctx, precOf('CALL'));
            const inner: string[] = [];
            if (node.partition.length > 0) {
                inner.push(`PARTITION BY ${node.partition.map(p => renderExpr(p, ctx)).join(', ')}`);
            }
            if (node.order.length > 0) {
                inner.push(`ORDER BY ${node.order.map(o => `${renderExpr(o.node, ctx)} ${o.dir}`).join(', ')}`);
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
const DATE_FUNCTIONS = new Set([
    'extract', 'year', 'month', 'day', 'day_of_week', 'hour', 'minute', 'second',
    'date_add', 'date_diff', 'date_trunc',
    'date_format', 'date_parse', 'to_unixtime', 'from_unixtime',
]);

const DATE_UNIT_SQL: Record<string, string> = {
    year: 'YEAR', month: 'MONTH', week: 'WEEK', day: 'DAY',
    hour: 'HOUR', minute: 'MINUTE', second: 'SECOND',
};

/**
 * Dialect-specific render for a `call` node, or `null` to fall through to the
 * plain `NAME(args)` renderer. Covers the general SQL function set (teta's
 * spec): date/time functions plus the scalar functions whose lowering is not a
 * plain same-name call (sqlite fallbacks, binary forms, casts, gaps that must
 * error explicitly).
 */
const SPECIAL_CALLS = new Set([
    // date/time family (see renderDateFunction)
    'extract', 'year', 'month', 'day', 'day_of_week', 'hour', 'minute', 'second',
    'date_add', 'date_diff', 'date_trunc', 'date_format', 'date_parse',
    'to_unixtime', 'from_unixtime',
    // scalar family
    'concat', 'substring', 'position', 'reverse', 'left_substring', 'right_substring',
    'lpad', 'rpad', 'regex_like', 'regex_replace', 'regex_extract', 'cast', 'try_cast',
]);

function renderCall(node: Extract<SqlNode, { kind: 'call' }>, ctx: RenderCtx): string | null {
    if (DATE_FUNCTIONS.has(node.name)) return renderDateFunction(node, ctx);
    if (!SPECIAL_CALLS.has(node.name)) return null;
    const d = ctx.dialect.name;
    const x = (i = 0) => renderExpr(node.args[i]!, ctx, precOf('CALL'));

    switch (node.name) {
        case 'concat': {
            const parts = node.args.map(a => renderExpr(a, ctx));
            if (d === 'sqlite') return parts.join(' || '); // sqlite has no CONCAT
            return `CONCAT(${parts.join(', ')})`;
        }
        case 'substring': {
            // value, start, length?
            const len = node.args[2] ? x(2) : null;
            if (d === 'sqlite') return len ? `SUBSTR(${x()}, ${x(1)}, ${len})` : `SUBSTR(${x()}, ${x(1)})`;
            return len ? `SUBSTRING(${x()}, ${x(1)}, ${len})` : `SUBSTRING(${x()}, ${x(1)})`;
        }
        case 'position': {
            // position(value, needle) — SQL's POSITION(needle IN value)
            if (d === 'postgresql' || d === 'trino') return `POSITION(${x(1)} IN ${x()})`;
            if (d === 'mysql') return `LOCATE(${x(1)}, ${x()})`;
            return `INSTR(${x()}, ${x(1)})`; // sqlite, hive
        }
        case 'reverse':
            if (d === 'sqlite') throw new Error(`reverse is not supported for the sqlite dialect`);
            return `REVERSE(${x()})`;
        case 'left_substring':
            return d === 'sqlite' ? `SUBSTR(${x()}, 1, ${x(1)})` : `LEFT(${x()}, ${x(1)})`;
        case 'right_substring':
            return d === 'sqlite' ? `SUBSTR(${x()}, -${x(1)})` : `RIGHT(${x()}, ${x(1)})`;
        case 'lpad': case 'rpad':
            // sqlite has no LPAD/RPAD; other dialects render LPAD/RPAD via the default path
            if (d === 'sqlite') throw new Error(`${node.name} is not supported for the sqlite dialect`);
            return null;
        case 'regex_like': {
            if (d === 'sqlite') throw new Error(`regex_like is not supported for the sqlite dialect`);
            if (d === 'postgresql') return `REGEXP_MATCH(${x()}, ${x(1)}) IS NOT NULL`;
            if (d === 'hive') return `${x()} RLIKE ${x(1)}`;
            return `REGEXP_LIKE(${x()}, ${x(1)})`; // mysql, trino
        }
        case 'regex_replace': {
            if (d === 'sqlite') throw new Error(`regex_replace is not supported for the sqlite dialect`);
            return `REGEXP_REPLACE(${x()}, ${x(1)}, ${x(2)})`; // pg, mysql, trino, hive
        }
        case 'regex_extract': {
            if (d === 'mysql' || d === 'sqlite') throw new Error(`regex_extract is not supported for the ${d} dialect`);
            if (d === 'postgresql') return `REGEXP_SUBSTR(${x()}, ${x(1)})`;
            if (d === 'trino' || d === 'hive') return `REGEXP_EXTRACT(${x()}, ${x(1)})`;
            return null;
        }
        case 'cast': case 'try_cast': {
            if (node.name === 'try_cast' && d !== 'trino') throw new Error(`try_cast is not supported for the ${d} dialect`);
            const type = node.args[1]?.kind === 'lit' ? sqlTypeName(String(node.args[1]!.value), d) : 'INTEGER';
            return `${node.name === 'cast' ? 'CAST' : 'TRY_CAST'}(${x()} AS ${type})`;
        }
    }
    return null;
}

/** tetaue scalar type name → per-dialect SQL cast type. */
function sqlTypeName(t: string, d: string): string {
    switch (t) {
        case 'int': return d === 'hive' ? 'INT' : d === 'mysql' ? 'SIGNED' : 'INTEGER';
        case 'float': return d === 'sqlite' ? 'REAL' : d === 'postgresql' ? 'DOUBLE PRECISION' : 'DOUBLE';
        case 'string': return d === 'mysql' ? 'CHAR' : d === 'hive' ? 'STRING' : d === 'sqlite' ? 'TEXT' : 'VARCHAR';
        case 'bool':
            if (d === 'sqlite') throw new Error(`casting to bool is not supported for the sqlite dialect`);
            return 'BOOLEAN';
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
        case 'date_format': return renderDateFormat(d, x(), str(second) ?? '%Y-%m-%d');
        case 'date_parse': return renderDateParse(d, x(), str(second) ?? '%Y-%m-%d');
        case 'to_unixtime': return renderToUnixtime(d, x());
        case 'from_unixtime': return renderFromUnixtime(d, x());
    }
    throw new Error(`unknown date function '${node.name}'`);
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
            if (amt === null) throw new Error(`date_add with a non-literal amount is not supported for the sqlite dialect`);
            const mod = unit === 'week' ? `${amt * 7} days` : `${amt} ${unit}s`;
            return `DATETIME(${x}, '${amt >= 0 ? '+' : ''}${mod}')`;
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
            const factor: Record<string, number> = { day: 1, hour: 24, minute: 1440, second: 86400 };
            if (factor[unit] === undefined) throw new Error(`date_diff unit '${unit}' is not supported for the sqlite dialect — supported: day, hour, minute, second`);
            const diff = `(JULIANDAY(${other}) - JULIANDAY(${x}))`;
            return factor[unit] === 1 ? `CAST(${diff} AS INTEGER)` : `CAST(${diff} * ${factor[unit]} AS INTEGER)`;
        }
        case 'trino':
            return `DATE_DIFF('${unit}', ${x}, ${other})`;
        case 'hive':
            if (unit !== 'day') throw new Error(`date_diff unit '${unit}' is not supported for the hive dialect — supported: day`);
            return `DATEDIFF(${other}, ${x})`;
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
            throw new Error(`date_trunc is not supported for the mysql dialect`);
        case 'sqlite': {
            if (unit === 'day') return `DATE(${x})`;
            const f: Record<string, string> = { year: '%Y-01-01', month: '%Y-%m-01' };
            if (f[unit] !== undefined) return `STRFTIME('${f[unit]}', ${x})`;
            throw new Error(`date_trunc unit '${unit}' is not supported for the sqlite dialect — supported: year, month, day`);
        }
        case 'hive': {
            const f: Record<string, string> = { year: 'YYYY', month: 'MM', week: 'WEEK', day: 'DD' };
            if (f[unit] === undefined) throw new Error(`date_trunc unit '${unit}' is not supported for the hive dialect — supported: year, month, week, day`);
            return `TRUNC(${x}, '${f[unit]}')`;
        }
        default:
            return `DATE_TRUNC('${unit}', ${x})`;
    }
}

/** `date_format value format` — dialect-native format string. */
function renderDateFormat(d: string, x: string, format: string): string {
    switch (d) {
        case 'postgresql':
            return `TO_CHAR(${x}, '${format}')`;
        case 'mysql': case 'trino': case 'hive':
            return `DATE_FORMAT(${x}, '${format}')`;
        case 'sqlite':
            return `STRFTIME('${format}', ${x})`;
        default:
            return `DATE_FORMAT(${x}, '${format}')`;
    }
}

/** `date_parse value format` — dialect-native format string. */
function renderDateParse(d: string, x: string, format: string): string {
    switch (d) {
        case 'postgresql':
            return `TO_TIMESTAMP(${x}, '${format}')`;
        case 'mysql':
            return `STR_TO_DATE(${x}, '${format}')`;
        case 'sqlite':
            return `DATETIME(${x})`; // sqlite parses many formats natively; the format is ignored
        case 'trino':
            return `DATE_PARSE(${x}, '${format}')`;
        case 'hive':
            throw new Error(`date_parse is not supported for the hive dialect — use date_format with to_unixtime/from_unixtime instead`);
        default:
            return `DATE_PARSE(${x}, '${format}')`;
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

// --- query rendering -------------------------------------------------------

export function renderQuery(q: Query, dialect: DialectSpec, format: RenderFormat = 'pretty'): string {
    const ctx: RenderCtx = { dialect, qualify: countTables(q) > 1 };
    const pretty = format === 'pretty';
    const clauses: string[] = [];

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
        const derivedAlias = q.aliases[0] ?? q.root.name;
        clauses.push(pretty
            ? `FROM (\n${indentLines(renderQuery(q.root.from, dialect, 'pretty'), INDENT)}\n) AS ${dialect.quoteIdentifier(derivedAlias)}`
            : `FROM (${renderQuery(q.root.from, dialect, 'compact')}) AS ${dialect.quoteIdentifier(derivedAlias)}`);
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
            const right = step.right;
            const rightAlias = right.aliases[0] ?? right.root.name;
            const plainTable = right.steps.length === 0 && !right.distinct && !right.root.from;
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
                rightSql = pretty
                    ? `(\n${indentLines(renderQuery(right, dialect, 'pretty'), INDENT)}\n) AS ${dialect.quoteIdentifier(rightAlias)}`
                    : `(${renderQuery(right, dialect, 'compact')}) AS ${dialect.quoteIdentifier(rightAlias)}`;
            }
            const onClause = `ON ${renderExpr(step.on, ctx)}`;
            // In pretty mode a subquery join is laid out vertically so the
            // ON condition sits on its own indented line.
            clauses.push(pretty && !plainTable
                ? `${JOIN_SQL[step.joinKind]} ${rightSql}\n${INDENT}${onClause}`
                : `${JOIN_SQL[step.joinKind]} ${rightSql} ${onClause}`);
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

    // LIMIT
    const takes = q.steps.filter(s => s.kind === 'take');
    if (takes.length > 0) {
        const last = takes[takes.length - 1]!;
        clauses.push(`LIMIT ${last.n}`);
    }

    return pretty ? clauses.join('\n') : clauses.join(' ');
}
