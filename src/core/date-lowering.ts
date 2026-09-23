/******************************************************************************
 * Date/time SQL lowerings — pure per-dialect string functions.
 *
 * Each helper takes a `LowerCtx`: the call's ALREADY-RENDERED argument texts,
 * the dialect name, and a few literal readers. They touch no IR, no evaluator
 * state, and no renderer internals — which is what lets the builtin registry
 * (`../../language/builtin.ts`) reference them directly for the date family's
 * `lower` entries.
 *
 * This module is a LEAF: it imports nothing but the `LowerCtx` type. Keeping
 * it out of render.ts is what avoids a cycle — builtin.ts must not import the
 * renderer, and the renderer imports the registry in turn.
 *
 * Extracted from render.ts during stage 1b of docs/design/architecture.md.
 ******************************************************************************/
import type { LowerCtx } from '../language/builtin.js';

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

/** EXTRACT / date-part lowering for the given field over a rendered value. */
export function renderDatePart(ctx: LowerCtx, field: string, x: string): string {
    switch (ctx.dialect) {
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
export function renderDateAdd(ctx: LowerCtx, x: string, unit: string, a: string, amt: number | null): string {
    switch (ctx.dialect) {
        case 'postgresql':
            return `${x} + (${a}) * INTERVAL '1 ${unit}'`;
        case 'mysql': {
            const inner = amt !== null ? `${amt}` : `(${a})`;
            return `DATE_ADD(${x}, INTERVAL ${inner} ${DATE_UNIT_SQL[unit] ?? unit.toUpperCase()})`;
        }
        case 'sqlite': {
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
            const inner = amt !== null ? `'${amt}'` : `(${a})`;
            return `${x} + INTERVAL ${inner} ${DATE_UNIT_SQL[unit] ?? unit.toUpperCase()}`;
        }
        default:
            return `DATE_ADD('${unit}', ${a}, ${x})`;
    }
}

/** `date_diff value unit other` — calendar-ish diff (other - value) in units. */
export function renderDateDiff(ctx: LowerCtx, x: string, unit: string, other: string): string {
    switch (ctx.dialect) {
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
export function renderDateTrunc(ctx: LowerCtx, x: string, unit: string): string {
    const d = ctx.dialect;
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
export function renderDateFormat(ctx: LowerCtx, x: string, format: string): string {
    const d = ctx.dialect;
    const f = ctx.stringLiteral(format);
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
export function renderDateParse(ctx: LowerCtx, x: string, format: string): string {
    const d = ctx.dialect;
    const f = ctx.stringLiteral(format);
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
export function renderToUnixtime(ctx: LowerCtx, x: string): string {
    switch (ctx.dialect) {
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
export function renderFromUnixtime(ctx: LowerCtx, x: string): string {
    switch (ctx.dialect) {
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
