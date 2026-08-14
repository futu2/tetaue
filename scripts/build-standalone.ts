/******************************************************************************
 * Build standalone tetaue executables with `bun build --compile`.
 *
 *   bun run scripts/build-standalone.ts            # every platform
 *   bun run scripts/build-standalone.ts bun-windows-x64   # one target
 *   bun run build:standalone                       # just the current platform
 *
 * Each binary embeds the bun runtime + the whole CLI (render/check/parse/
 * format/build/watch/lsp), so it runs on machines without bun or node. The
 * first cross-compile for a target downloads that platform's bun runtime
 * (cached afterwards) — Linux can build for all five platforms.
 *
 * Output (in dist/, git-ignored):
 *   tetaue                    tetaue-linux-x64        tetaue-linux-arm64
 *   tetaue-darwin-x64         tetaue-darwin-arm64     tetaue-windows-x64.exe
 ******************************************************************************/
import { mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { platform } from 'node:os';

const TARGETS: { target: string; file: string }[] = [
    { target: 'bun-linux-x64', file: 'tetaue-linux-x64' },
    { target: 'bun-linux-arm64', file: 'tetaue-linux-arm64' },
    { target: 'bun-darwin-x64', file: 'tetaue-darwin-x64' },
    { target: 'bun-darwin-arm64', file: 'tetaue-darwin-arm64' },
    { target: 'bun-windows-x64', file: 'tetaue-windows-x64.exe' },
];

const only = process.argv[2];
const selected = only ? TARGETS.filter(t => t.target === only) : TARGETS;
if (selected.length === 0) {
    console.error(`unknown target '${only}' — available: ${TARGETS.map(t => t.target).join(', ')}`);
    process.exit(1);
}

mkdirSync('dist', { recursive: true });
for (const { target, file } of selected) {
    console.error(`\n=== ${target} → dist/${file}`);
    const result = spawnSync(
        'bun',
        ['build', '--compile', `--target=${target}`, 'bin/tetaue.ts', '--outfile', `dist/${file}`],
        { stdio: 'inherit' },
    );
    if (result.status !== 0) {
        console.error(`\nfailed to build ${target} (exit ${result.status ?? 'signal ' + result.signal})`);
        process.exit(result.status ?? 1);
    }
}
console.error(`\nbuilt ${selected.length} executable(s) into dist/ — copy them (or a zip) for distribution.`);
console.error(`hint: on ${platform()} run 'bun run build:standalone' for just this platform.`);
