import { describe, expect, test } from 'bun:test';
import { render, errors, typeErrors } from './helpers.ts';

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
        dow = day_of_week o.created_at,
        h = hour o.created_at,
        mi = minute o.created_at,
        s = second o.created_at,
    })
`;

describe('current_date / current_timestamp', () => {
    test('date column compared to current_date (all dialects are direct)', () => {
        const src = `${ORDERS}\nq = orders & filter (o => o.order_date == current_date)`;
        for (const dialect of ['trino', 'postgresql', 'mysql', 'sqlite', 'hive']) {
            expect(render(src, dialect)).toContain('order_date = CURRENT_DATE');
        }
    });

    test('bare constant in a projection (no parens, keyword-style)', () => {
        const sql = render(`
            ${ORDERS}
            q = orders & map (o => { today = current_date, now = current_timestamp })
        `);
        expect(sql).toContain('CURRENT_DATE AS today');
        expect(sql).toContain('CURRENT_TIMESTAMP AS now');
    });
});

describe('date parts (year, month, day, day_of_week, hour, minute, second)', () => {
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

    test('postgresql — EXTRACT with DOW for day_of_week', () => {
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

describe('date_add', () => {
    const src = `${ORDERS}\nq = orders & filter (o => o.order_date >= date_add current_date "day" (-7))`;

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

describe('date_diff', () => {
    const src = `${ORDERS}\nq = orders & map (o => { age = date_diff o.created_at "day" current_date })`;

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

describe('date_trunc', () => {
    const src = `${ORDERS}\nq = orders & map (o => { ms = date_trunc o.created_at "month" })`;

    test('trino and postgresql — direct', () => {
        expect(render(src, 'trino')).toContain(`DATE_TRUNC('month', created_at) AS ms`);
        expect(render(src, 'postgresql')).toContain(`DATE_TRUNC('month', created_at) AS ms`);
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

describe('date_format / date_parse', () => {
    const src = `
        ${ORDERS}
        q = orders & map (o => {
            f = date_format o.created_at "%Y-%m-%d",
            p = date_parse o.note "%Y-%m-%d",
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

describe('to_unixtime / from_unixtime', () => {
    const src = `${ORDERS}\nq = orders & map (o => { t = to_unixtime o.created_at, b = from_unixtime o.id })`;

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
    test('date parts require a date/timestamp expression', () => {
        expect(errors(`${ORDERS}\nq = orders & map (o => { x = year o.id })`).join('\n')).toContain('year expects a date or timestamp expression');
        expect(errors(`${ORDERS}\nq = orders & map (o => { x = to_unixtime o.note })`).join('\n')).toContain('to_unixtime expects a date or timestamp expression');
    });

    test('extract rejects unknown date parts', () => {
        expect(errors(`${ORDERS}\nq = orders & map (o => { x = extract o.created_at "quarter" })`).join('\n')).toContain('extract expects a string literal — one of: year, month, day, day_of_week, hour, minute, second');
    });

    test('date_add/date_diff/date_trunc reject unknown units', () => {
        expect(errors(`${ORDERS}\nq = orders & map (o => { x = date_add o.created_at "fortnight" 1 })`).join('\n')).toContain('date_add expects a string literal — one of: year, month, week, day, hour, minute, second');
        expect(errors(`${ORDERS}\nq = orders & map (o => { x = date_diff o.created_at 5 current_date })`).join('\n')).toContain('date_diff expects a string literal');
        expect(errors(`${ORDERS}\nq = orders & map (o => { x = date_trunc o.created_at "month" })`).length).toBe(0); // valid
    });

    test('date_add requires a numeric amount', () => {
        expect(errors(`${ORDERS}\nq = orders & map (o => { x = date_add o.created_at "day" "soon" })`).join('\n')).toContain('date_add expects a numeric amount');
    });

    test('date_diff requires a date/timestamp other value', () => {
        expect(errors(`${ORDERS}\nq = orders & map (o => { x = date_diff o.created_at "day" o.note })`).join('\n')).toContain('date_diff expects a date or timestamp expression');
    });

    test('format arguments must be string literals', () => {
        expect(errors(`${ORDERS}\nq = orders & map (o => { x = date_format o.created_at o.note })`).join('\n')).toContain('date_format expects a format string literal');
        expect(errors(`${ORDERS}\nq = orders & map (o => { x = date_parse o.note o.id })`).join('\n')).toContain('date_parse expects a format string literal');
    });

    test('group/order cannot be wrapped by date functions', () => {
        expect(errors(`${ORDERS}\nq = orders & fold (o => { x = year (group o.created_at) })`).join('\n')).toContain('year cannot contain group');
    });

    test('all validated dialect/unit combinations render', () => {
        const trunc = `${ORDERS}\nq = orders & map (o => { x = date_trunc o.created_at "hour" })`;
        expect(render(trunc, 'sqlite')).toContain("STRFTIME('%Y-%m-%d %H:00:00', created_at) AS x");
        const parse = `${ORDERS}\nq = orders & map (o => { x = date_parse o.note "%Y" })`;
        expect(render(parse, 'hive')).toContain("FROM_UNIXTIME(UNIX_TIMESTAMP(note, '%Y')) AS x");
    });
});

describe('type inference', () => {
    test('a module using the date/time family type-checks', () => {
        const src = `
            ${ORDERS}
            q = orders
                & filter (o => o.order_date == current_date || o.order_date >= date_add current_date "day" (-7))
                & map (o => {
                    y = year o.created_at,
                    age = date_diff o.created_at "day" current_date,
                    f = date_format o.created_at "%Y-%m-%d",
                })
        `;
        expect(typeErrors(src)).toEqual([]);
    });
});

describe('review fix: date argument types are checked statically', () => {
    test('inference rejects non-date values for the date family', () => {
        expect(typeErrors('q = year 5').join('\n')).toContain('year expects a date or timestamp expression');
        expect(typeErrors('q = date_add current_date "day" "soon"').join('\n')).toContain('date_add expects a numeric amount, got type string');
        expect(typeErrors('q = date_diff current_date "day" 5').join('\n')).toContain('date_diff expects a date or timestamp expression');
    });

    test('date_diff does not unify its two date arguments (no type pollution)', () => {
        expect(typeErrors(`${ORDERS}\nq = orders & map (o => { d = date_diff o.created_at "day" current_date })`)).toEqual([]);
    });
});
