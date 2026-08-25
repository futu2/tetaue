/******************************************************************************
 * Render every runnable example for every dialect and syntax-check it with
 * node-sql-parser.
 *
 *   bun run scripts/validate-dialects.ts
 *
 * This is intentionally parse-only. PostgreSQL and MySQL are executed with
 * real service containers in the CI workflow; Trino/Hive are validated here
 * until service-container execution is added for them.
 ******************************************************************************/
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { Parser } from 'node-sql-parser';

const ROOT = resolve(new URL('.', import.meta.url).pathname, '..');
const CLI = 'src/cli.ts';
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
const DIALECTS: { [tetaue: string]: string } = {
    sqlite: 'sqlite',
    postgresql: 'postgresql',
    mysql: 'mysql',
    trino: 'trino',
    hive: 'hive',
};

const parser = new Parser();
const failures: string[] = [];
for (const rel of EXAMPLES) {
    const path = resolve(ROOT, rel);
    for (const [tetaueDialect, parserDialect] of Object.entries(DIALECTS)) {
        let sql: string;
        try {
            sql = execFileSync(
                'bun',
                ['run', CLI, 'render', path, '--dialect', tetaueDialect, '--format', 'compact'],
                { cwd: ROOT, encoding: 'utf8' },
            ).trim();
        } catch (err) {
            const detail = err instanceof Error ? err.message.trim() : String(err);
            failures.push(`${rel} (${tetaueDialect}): render failed:\n${detail}`);
            continue;
        }
        try {
            parser.astify(sql, { database: parserDialect });
        } catch (err) {
            const detail = err instanceof Error ? err.message : String(err);
            failures.push(`${rel} (${tetaueDialect}): node-sql-parser parse failed:\n${sql}\n${detail}`);
        }
    }
}

if (failures.length > 0) {
    console.log(failures.join('\n\n'));
    process.exit(1);
}
console.log(`Validated ${EXAMPLES.length} examples across ${Object.keys(DIALECTS).length} SQL dialects.`);
