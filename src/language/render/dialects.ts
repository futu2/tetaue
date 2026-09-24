import type { JoinKind, SetOp } from '../../core/ir.js';
import type { BuiltinName } from '../builtin.js';

/**
 * Dialect configuration for the SQL renderer.
 */

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
export function quoteQualifiedName(name: string, dialect: DialectSpec): string {
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
