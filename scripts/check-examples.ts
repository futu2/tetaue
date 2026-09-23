/******************************************************************************
 * Check EVERY example module in the examples/ tree.
 *
 *   bun run check:examples
 *
 * The examples folder is documentation that must keep compiling: it is the
 * source of most README snippets, and a stale example is a lie in the docs.
 * Enumerating files here (rather than hardcoding a list in package.json) means
 * a NEW example is covered the moment it is added — the previous script named
 * 14 of the 19 files, leaving `dialect-surface.tetaue` checked by nothing.
 *
 * Both kinds of module are handled:
 *   - a query module (has `main`) must check AND render to SQL;
 *   - a library module (exports only, no `main`) must check as a library —
 *     "no main binding" is the expected outcome, not a failure.
 *
 * Modules are compiled in ONE process (the language services are built once)
 * instead of one CLI invocation per file, which keeps this fast enough to run
 * on every push.
 ******************************************************************************/
import { NodeFileSystem } from 'langium/node';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve, relative } from 'node:path';
import { createTetaueServices } from '../src/language/tetaue-module.js';
import { compileModuleText } from '../src/language/compile.js';

const ROOT = resolve(new URL('.', import.meta.url).pathname, '..');
const EXAMPLES = join(ROOT, 'examples');

/** Every `.tetaue` file under `dir`, sorted for stable output. */
function findTetaue(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir).sort()) {
        const path = join(dir, entry);
        if (statSync(path).isDirectory()) findTetaue(path, out);
        else if (path.endsWith('.tetaue')) out.push(path);
    }
    return out;
}

/** A module with no `main` binding is a library: `check` reports it, not fails. */
function isLibraryMessage(message: string): boolean {
    return message.includes('does not compile to SQL');
}

const services = createTetaueServices(NodeFileSystem).tetaue;
const files = findTetaue(EXAMPLES);
const failures: string[] = [];
let queries = 0;
let libraries = 0;

for (const file of files) {
    const rel = relative(ROOT, file);
    const text = readFileSync(file, 'utf8');
    const outcome = compileModuleText(`file://${file}`, text, services, { dialect: 'sqlite' });

    if (outcome.ok) {
        // A rendered query module: its SQL must also be non-empty.
        if (outcome.sql.trim().length === 0) {
            failures.push(`${rel}: rendered empty SQL`);
        } else {
            queries++;
        }
        continue;
    }

    const messages = outcome.diagnostics.map(d => d.message);
    if (messages.length > 0 && messages.every(isLibraryMessage)) {
        libraries++;
        continue;
    }
    failures.push(`${rel}: ${messages.slice(0, 3).join('\n    ')}`);
}

if (failures.length > 0) {
    console.log(failures.join('\n\n'));
    console.log(`\n${failures.length} example(s) failed.`);
    process.exit(1);
}
console.log(`Checked ${files.length} example module(s): ${queries} query module(s), ${libraries} library module(s), 0 error(s).`);
