import { describe, expect, test } from 'bun:test';
import { render, errors, typeErrors, allErrors, parseModel, services } from './helpers.ts';
import { inferProject } from '../src/language/inference.ts';
import { standardPrelude } from '../src/language/prelude.ts';

// Schema with date, timestamp and string columns for the date/time builtins.
const ORDERS = `orders: query {
    id: int,
    order_date: date,
    created_at: timestamp,
    note: string,
} = table "orders"`;

const MAP_ALL = `
    q = orders & map (o => {
        y = year o.created_at,
        m = month o.created_at,
        d = day o.created_at,
        dow = dayOfWeek o.created_at,
        h = hour o.created_at,
        mi = minute o.created_at,
        s = second o.created_at,
    })
`;

describe('currentDate / currentTimestamp', () => {
    test('date column compared to currentDate (all dialects are direct)', () => {
        const src = `${ORDERS}\nq = orders & filter (o => o.order_date == currentDate)`;
        for (const dialect of ['trino', 'postgresql', 'mysql', 'sqlite', 'hive']) {
            expect(render(src, dialect)).toContain('order_date = CURRENT_DATE');
        }
    });

    test('bare constant in a projection (no parens, keyword-style)', () => {
        const sql = render(`
            ${ORDERS}
            q = orders & map (o => { today = currentDate, now = currentTimestamp })
        `);
        expect(sql).toContain('CURRENT_DATE AS today');
        expect(sql).toContain('CURRENT_TIMESTAMP AS now');
    });
});

describe('date parts (year, month, day, dayOfWeek, hour, minute, second)', () => {
    test('trino — EXTRACT', () => {
        const sql = render(`${ORDERS}${MAP_ALL}`, 'trino');
        expect(sql).toContain('EXTRACT(YEAR FROM created_at) AS y');
        expect(sql).toContain('EXTRACT(MONTH FROM created_at) AS m');
        expect(sql).toContain('EXTRACT(DAY FROM created_at) AS d');
        expect(sql).toContain('EXTRACT(DAY_OF_WEEK FROM created_at) AS dow');
        expect(sql).toContain('EXTRACT(HOUR FROM created_at) AS h');
        expect(sql).toContain('EXTRACT(MINUTE FROM created_at) AS mi');
        expect(sql).toContain('EXTRACT(SECOND FROM created_at) AS s');
    });

    test('postgresql — EXTRACT with DOW for dayOfWeek', () => {
        const sql = render(`${ORDERS}${MAP_ALL}`, 'postgresql');
        expect(sql).toContain('EXTRACT(YEAR FROM created_at) AS y');
        expect(sql).toContain('EXTRACT(DOW FROM created_at) AS dow');
    });

    test('mysql — EXTRACT except DAYOFWEEK', () => {
        const sql = render(`${ORDERS}${MAP_ALL}`, 'mysql');
        expect(sql).toContain('EXTRACT(YEAR FROM created_at) AS y');
        expect(sql).toContain('DAYOFWEEK(created_at) AS dow');
    });

    test('hive — direct functions', () => {
        const sql = render(`${ORDERS}${MAP_ALL}`, 'hive');
        expect(sql).toContain('YEAR(created_at) AS y');
        expect(sql).toContain('MONTH(created_at) AS m');
        expect(sql).toContain('DAY(created_at) AS d');
        expect(sql).toContain('DAYOFWEEK(created_at) AS dow');
        expect(sql).toContain('SECOND(created_at) AS s');
    });

    test('sqlite — STRFTIME fallback with CAST', () => {
        const sql = render(`${ORDERS}${MAP_ALL}`, 'sqlite');
        expect(sql).toContain(`CAST(STRFTIME('%Y', created_at) AS INTEGER) AS y`);
        expect(sql).toContain(`CAST(STRFTIME('%m', created_at) AS INTEGER) AS m`);
        expect(sql).toContain(`CAST(STRFTIME('%d', created_at) AS INTEGER) AS d`);
        expect(sql).toContain(`CAST(STRFTIME('%w', created_at) AS INTEGER) AS dow`);
        expect(sql).toContain(`CAST(STRFTIME('%H', created_at) AS INTEGER) AS h`);
    });

    test('generic extract with a field string literal', () => {
        const src = `${ORDERS}\nq = orders & map (o => { m = extract o.created_at "month" })`;
        expect(render(src, 'trino')).toContain('EXTRACT(MONTH FROM created_at) AS m');
        expect(render(src, 'postgresql')).toContain('EXTRACT(MONTH FROM created_at) AS m');
        expect(render(src, 'sqlite')).toContain(`CAST(STRFTIME('%m', created_at) AS INTEGER) AS m`);
    });
});

describe('dateAdd', () => {
    const src = `${ORDERS}\nq = orders & filter (o => o.order_date >= dateAdd currentDate "day" (-7))`;

    test('trino', () => {
        expect(render(src, 'trino')).toContain(`DATE_ADD('day', -7, CURRENT_DATE)`);
    });
    test('postgresql — INTERVAL arithmetic', () => {
        expect(render(src, 'postgresql')).toContain(`CURRENT_DATE + (-7) * INTERVAL '1 day'`);
    });
    test('mysql — DATE_ADD with INTERVAL', () => {
        expect(render(src, 'mysql')).toContain('DATE_ADD(CURRENT_DATE, INTERVAL -7 DAY)');
    });
    test('sqlite — DATETIME modifier fallback', () => {
        expect(render(src, 'sqlite')).toContain(`DATETIME(CURRENT_DATE, '-7 days')`);
    });
    test('hive — INTERVAL literal', () => {
        expect(render(src, 'hive')).toContain(`CURRENT_DATE + INTERVAL '-7' DAY`);
    });
});

describe('dateDiff', () => {
    const src = `${ORDERS}\nq = orders & map (o => { age = dateDiff o.created_at "day" currentDate })`;

    test('trino', () => {
        expect(render(src, 'trino')).toContain(`DATE_DIFF('day', created_at, CURRENT_DATE) AS age`);
    });
    test('postgresql — interval field extraction', () => {
        expect(render(src, 'postgresql')).toContain('EXTRACT(DAY FROM (CURRENT_DATE - created_at)) AS age');
    });
    test('mysql — TIMESTAMPDIFF', () => {
        expect(render(src, 'mysql')).toContain('TIMESTAMPDIFF(DAY, created_at, CURRENT_DATE) AS age');
    });
    test('sqlite — JULIANDAY fallback', () => {
        expect(render(src, 'sqlite')).toContain('CAST((JULIANDAY(CURRENT_DATE) - JULIANDAY(created_at)) AS INTEGER) AS age');
    });
    test('hive — DATEDIFF (day only)', () => {
        expect(render(src, 'hive')).toContain('DATEDIFF(CURRENT_DATE, created_at) AS age');
    });
});

describe('dateTrunc', () => {
    const src = `${ORDERS}\nq = orders & map (o => { ms = dateTrunc o.created_at "month" })`;

    test('trino and postgresql — direct', () => {
        expect(render(src, 'trino')).toContain(`DATE_TRUNC('month', created_at) AS ms`);
        expect(render(src, 'postgresql')).toContain(`DATE_TRUNC('month', created_at) AS ms`);
    });
    test('dateTrunc preserves the input date-ness (date to date, timestamp to timestamp)', () => {
        const src = `${ORDERS}\nq = orders & map (o => { d = dateTrunc o.order_date "month", ts = dateTrunc o.created_at "month" })`;
        expect(typeErrors(src)).toEqual([]);
        const model = parseModel(src);
        const result = inferProject([{ model, uri: undefined, imports: [] }], new Map(), standardPrelude(services));
        const q = model.bindings.find(b => b.name === 'q');
        expect(q && result.typeOf(q)).toBe('query { d: date, ts: timestamp }');
    });

    test('a truncated date compares with currentDate; a truncated timestamp does not', () => {
        // `dateTrunc` keeps the input's date-ness, so a truncated date aligns
        // with CURRENT_DATE (month-start bucketing), while a truncated
        // timestamp only aligns with CURRENT_TIMESTAMP.
        const mapThenFilter = (col: string, rhs: string) =>
            `${ORDERS}\nq = orders & map (o => { m = dateTrunc o.${col} "month" }) & filter (r => r.m == ${rhs})`;
        expect(typeErrors(mapThenFilter('order_date', 'currentDate'))).toEqual([]);
        expect(typeErrors(mapThenFilter('created_at', 'currentTimestamp'))).toEqual([]);
        expect(typeErrors(mapThenFilter('created_at', 'currentDate'))).not.toEqual([]);
    });

    test('sqlite — STRFTIME fallback', () => {
        expect(render(src, 'sqlite')).toContain(`STRFTIME('%Y-%m-01', created_at) AS ms`);
    });
    test('hive — TRUNC', () => {
        expect(render(src, 'hive')).toContain(`TRUNC(created_at, 'MM') AS ms`);
    });
    test('mysql — DATE_FORMAT composition', () => {
        expect(render(src, 'mysql')).toContain(`STR_TO_DATE(DATE_FORMAT(created_at, '%Y-%m-01'), '%Y-%m-%d') AS ms`);
    });
});

describe('dateFormat / dateParse', () => {
    const src = `
        ${ORDERS}
        q = orders & map (o => {
            f = dateFormat o.created_at "%Y-%m-%d",
            p = dateParse o.note "%Y-%m-%d",
        })
    `;

    test('trino', () => {
        expect(render(src, 'trino')).toContain(`DATE_FORMAT(created_at, '%Y-%m-%d') AS f`);
        expect(render(src, 'trino')).toContain(`DATE_PARSE(note, '%Y-%m-%d') AS p`);
    });
    test('postgresql — TO_CHAR / TO_TIMESTAMP', () => {
        expect(render(src, 'postgresql')).toContain(`TO_CHAR(created_at, '%Y-%m-%d') AS f`);
        expect(render(src, 'postgresql')).toContain(`TO_TIMESTAMP(note, '%Y-%m-%d') AS p`);
    });
    test('sqlite — STRFTIME / DATETIME', () => {
        expect(render(src, 'sqlite')).toContain(`STRFTIME('%Y-%m-%d', created_at) AS f`);
        expect(render(src, 'sqlite')).toContain('DATETIME(note) AS p');
    });
});

describe('toUnixtime / fromUnixtime', () => {
    const src = `${ORDERS}\nq = orders & map (o => { t = toUnixtime o.created_at, b = fromUnixtime o.id })`;

    test('trino', () => {
        expect(render(src, 'trino')).toContain('TO_UNIXTIME(created_at) AS t');
        expect(render(src, 'trino')).toContain('FROM_UNIXTIME(id) AS b');
    });
    test('postgresql — EXTRACT(EPOCH) / TO_TIMESTAMP', () => {
        expect(render(src, 'postgresql')).toContain('EXTRACT(EPOCH FROM created_at) AS t');
        expect(render(src, 'postgresql')).toContain('TO_TIMESTAMP(id) AS b');
    });
    test('sqlite — STRFTIME %s / unixepoch', () => {
        expect(render(src, 'sqlite')).toContain(`CAST(STRFTIME('%s', created_at) AS INTEGER) AS t`);
        expect(render(src, 'sqlite')).toContain(`DATETIME(id, 'unixepoch') AS b`);
    });
});

describe('date function validation', () => {
    // The date family is defined in `base/sql/time.tetaue`, so its contract is
    // checked in TWO places, matching where each rule lives:
    //
    //   - argument TYPES come from the library's annotations, so a wrong type
    //     is an ordinary overload-resolution error;
    //   - a compile-time NAME (`extract x "quarter"`, `dateAdd x "night" 1`)
    //     is rejected by the library itself, which reports it through
    //     `sql_error` from the fallback arm of its dispatch.
    test('date parts thread the calendar type instead of rejecting by name', () => {
        // `year : a -> int` and `dateTrunc : a -> string -> a` — the calendar
        // type is an ordinary type VARIABLE, so any value is accepted and the
        // type flows through to the result. What is checked is what the result
        // is USED as: a truncated timestamp does not compare with a date (see
        // "a truncated date compares with currentDate" below).
        expect(allErrors(`${ORDERS}\nq = orders & map (o => { x = year o.id })`)).toEqual([]);
        expect(allErrors(`${ORDERS}\nq = orders & map (o => { x = toUnixtime o.note })`)).toEqual([]);
        // The calendar type really is threaded: a timestamp in, a timestamp out.
        expect(typeErrors(`${ORDERS}\nq = orders & map (o => { m = dateAdd o.created_at "day" 1 }) & filter (r => r.m == currentTimestamp)`)).toEqual([]);
    });

    test('extract rejects unknown date parts', () => {
        expect(errors(`${ORDERS}\nq = orders & map (o => { x = extract o.created_at "quarter" })`).join('\n'))
            .toContain('extract expects a string literal — one of: year, month, day, dayOfWeek, hour, minute, second');
    });

    test('dateAdd/dateDiff/dateTrunc reject unknown units', () => {
        expect(errors(`${ORDERS}\nq = orders & map (o => { x = dateAdd o.created_at "fortnight" 1 })`).join('\n'))
            .toContain('dateAdd expects a string literal — one of: year, month, week, day, hour, minute, second');
        expect(errors(`${ORDERS}\nq = orders & map (o => { x = dateDiff o.created_at "fortnight" currentTimestamp })`).join('\n'))
            .toContain('dateDiff expects a string literal — one of: year, month, week, day, hour, minute, second');
        expect(errors(`${ORDERS}\nq = orders & map (o => { x = dateTrunc o.created_at "fortnight" })`).join('\n'))
            .toContain('dateTrunc expects a string literal — one of: year, month, week, day, hour, minute, second');
        expect(errors(`${ORDERS}\nq = orders & map (o => { x = dateTrunc o.created_at "month" })`).length).toBe(0); // valid
    });

    test('dateAdd requires a numeric amount', () => {
        expect(allErrors(`${ORDERS}\nq = orders & map (o => { x = dateAdd o.created_at "day" "soon" })`).join('\n'))
            .toContain('dateAdd');
    });

    test('dateDiff keeps its two date arguments independent', () => {
        // Both positions accept any calendar-ish value, and the two are
        // separate variables, so combining a date and a timestamp is legal
        // (see the type-inference tests below).
        expect(errors(`${ORDERS}\nq = orders & map (o => { x = dateDiff o.created_at "day" o.order_date })`)).toEqual([]);
    });

    test('dateFormat/dateParse take the format as a string', () => {
        // The format is an ordinary string argument, so a non-string one is a
        // type error while a COLUMN format is accepted — the dialect's format
        // language is not something the type system can check.
        expect(allErrors(`${ORDERS}\nq = orders & map (o => { x = dateFormat o.created_at 5 })`).join('\n'))
            .toContain('cannot apply');
        expect(errors(`${ORDERS}\nq = orders & map (o => { x = dateFormat o.created_at o.note })`)).toEqual([]);
        expect(errors(`${ORDERS}\nq = orders & map (o => { x = dateParse o.note "%Y-%m-%d" })`)).toEqual([]);
    });

    test('group/order cannot be wrapped by date functions', () => {
        // A date function is an ordinary call, so wrapping a group key in it
        // is caught by the fold checker rather than by a per-function rule.
        expect(allErrors(`${ORDERS}\nq = orders & fold (o => { x = year (group o.created_at) })`).join('\n'))
            .toContain('fold');
    });

    test('all validated dialect/unit combinations render', () => {
        const trunc = `${ORDERS}\nq = orders & map (o => { x = dateTrunc o.created_at "hour" })`;
        expect(render(trunc, 'sqlite')).toContain("STRFTIME('%Y-%m-%d %H:00:00', created_at) AS x");
        const parse = `${ORDERS}\nq = orders & map (o => { x = dateParse o.note "%Y" })`;
        expect(render(parse, 'hive')).toContain("FROM_UNIXTIME(UNIX_TIMESTAMP(note, '%Y')) AS x");
    });
});

describe('type inference', () => {
    test('a module using the date/time family type-checks', () => {
        const src = `
            ${ORDERS}
            q = orders
                & filter (o => o.order_date == currentDate || o.order_date >= dateAdd currentDate "day" (-7))
                & map (o => {
                    y = year o.created_at,
                    age = dateDiff o.created_at "day" currentDate,
                    f = dateFormat o.created_at "%Y-%m-%d",
                })
        `;
        expect(typeErrors(src)).toEqual([]);
    });
});

describe('review fix: date argument types are checked statically', () => {
    test('inference rejects non-date values for the date family', () => {
        expect(typeErrors('q = year 5').join('\n')).toContain('year expects a date or timestamp expression');
        expect(typeErrors('q = dateAdd currentDate "day" "soon"').join('\n')).toContain('dateAdd expects a numeric amount, got type string');
        expect(typeErrors('q = dateDiff currentDate "day" 5').join('\n')).toContain('dateDiff expects a date or timestamp expression');
    });

    test('dateDiff does not unify its two date arguments (no type pollution)', () => {
        expect(typeErrors(`${ORDERS}\nq = orders & map (o => { d = dateDiff o.created_at "day" currentDate })`)).toEqual([]);
    });
});
