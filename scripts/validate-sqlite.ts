/******************************************************************************
 * Render every runnable example for the SQLite dialect and EXECUTE it against
 * an in-process SQLite database (bun:sqlite — no service container needed, so
 * this runs locally and in CI for every push, unlike the PostgreSQL/MySQL
 * execution jobs).
 *
 *   bun run scripts/validate-sqlite.ts
 *
 * The fixture schema mirrors the CI PostgreSQL/MySQL setup (CI workflows
 * `ci.yml` "Set up PostgreSQL schema"). Each example is rendered compact,
 * wrapped in a transaction with its fixture tables, and executed with
 * ON_ERROR_STOP semantics: the first failing statement aborts that example.
 ******************************************************************************/
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { Database } from 'bun:sqlite';

const ROOT = resolve(new URL('.', import.meta.url).pathname, '..');
const CLI = 'src/cli.ts';

const FIXTURE = `
CREATE TABLE users (id INTEGER, name TEXT, age INTEGER, active INTEGER, email TEXT, nickname TEXT, last_seen TEXT);
CREATE TABLE orders (id INTEGER, user_id INTEGER, total REAL, status TEXT);
INSERT INTO users VALUES (1, 'Ada', 37, 1, 'ada@example.com', NULL, '2024-01-01 12:00:00');
INSERT INTO users VALUES (2, 'Lin', 15, 1, 'lin@example.com', 'linny', '2024-02-03 08:30:00');
INSERT INTO orders VALUES (10, 1, 99.5, 'paid');
INSERT INTO orders VALUES (11, 2, 4.5, 'unpaid');
`;

const FIXTURE_SCHEMA_QUALIFIED = `
ATTACH ':memory:' AS ecs;
CREATE TABLE ecs.dcm_ecs_c_ecis_m_tb1150_sf_f (
    contextroleplayer TEXT, roleplayer TEXT, par_to_par_rel_rol TEXT,
    pt_dt TEXT, rol_lifecycle INTEGER
);
CREATE TABLE ecs.dcm_ecs_p_ecis_m_tb1010_sf_f (
    individualid TEXT, birthdate TEXT, pt_dt TEXT, individual_stat TEXT
);
INSERT INTO ecs.dcm_ecs_c_ecis_m_tb1150_sf_f VALUES ('11114343', '11114344', '101', '2024-01-01', 1);
INSERT INTO ecs.dcm_ecs_p_ecis_m_tb1010_sf_f VALUES ('11114344', '1990-06-15', '2024-01-01', '000');
`;

const EXAMPLES = [
    'examples/adults.tetaue',
    'examples/case.tetaue',
    'examples/joins.tetaue',
    'examples/lpbirthday.tetaue',
    'examples/orders.tetaue',
    'examples/report.tetaue',
    'examples/selective.tetaue',
    'examples/strings.tetaue',
    'examples/lib-project/main.tetaue',
];

const failures: string[] = [];

for (const rel of EXAMPLES) {
    const path = resolve(ROOT, rel);
    let sql: string;
    try {
        sql = execFileSync(
            'bun',
            ['run', CLI, 'render', path, '--dialect', 'sqlite', '--format', 'compact'],
            { cwd: ROOT, encoding: 'utf8' },
        ).trim();
    } catch (err) {
        const detail = err instanceof Error ? err.message.trim() : String(err);
        failures.push(`${rel}: render failed:\n${detail}`);
        continue;
    }
    try {
        // Fresh in-memory database per example: several examples reference
        // example-specific tables (lpbirthday's `ecs.*` schemas) and fixture
        // leakage would mask real failures.
        const db = new Database(':memory:');
        try {
            db.exec(FIXTURE);
            // lpbirthday.tetaue renders schema-qualified table names
            // (`ecs.*`); the fixture attaches a matching database.
            if (rel.endsWith('lpbirthday.tetaue')) db.exec(FIXTURE_SCHEMA_QUALIFIED);
            db.exec(sql);
        } finally {
            db.close();
        }
    } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        failures.push(`${rel}: execution failed:\n${sql}\n${detail}`);
    }
}

if (failures.length > 0) {
    console.log(failures.join('\n\n'));
    process.exit(1);
}
console.log(`Executed ${EXAMPLES.length} rendered examples against in-process SQLite.`);
