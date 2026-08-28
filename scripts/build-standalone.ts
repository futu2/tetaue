/******************************************************************************
 * Build standalone tetaue executables with `bun build --compile`.
 *
 *   bun run scripts/build-standalone.ts              # every platform
 *   bun run scripts/build-standalone.ts --host       # this machine's target
 *   bun run scripts/build-standalone.ts bun-linux-x64-musl   # one target
 *   bun run scripts/build-standalone.ts --official-runtime   # portable builds
 *   bun run build:standalone                         # just the current platform
 *
 * Each binary embeds the bun runtime + the whole CLI (render/check/parse/
 * format/build/watch/lsp), so it runs on machines without bun or node.
 *
 * WHY `--official-runtime` EXISTS — the default build embeds the *local* bun
 * runtime, whatever distro you develop on. A locally-built bun is dynamically
 * linked against that distro's shared libraries; on Arch that couples the
 * "standalone" binary to libicuuc.so.78 / libicui18n.so.78 (versioned per
 * release), so it fails on Ubuntu, Debian, NixOS, and any other system whose
 * ICU version differs. Passing `--official-runtime` instead embeds the
 * matching release from github.com/oven-sh/bun, which statically links ICU
 * and needs nothing beyond the C runtime:
 *
 *   linux (gnu)   → libc/libm/libpthread/libdl, floor glibc 2.17
 *   linux (musl)  → musl libc + libstdc++.so.6 (present on every Alpine;
 *                   `apk add libstdc++` if absent) — no glibc coupling
 *
 * The release zips are cached under ~/.cache/tetaue/bun-runtime/, keyed by
 * bun version, and reused offline afterwards. Requires curl + unzip for a
 * first-time download.
 *
 * Output (in dist/, git-ignored):
 *   tetaue-linux-x64-musl    tetaue-linux-arm64-musl
 *   tetaue-darwin-x64        tetaue-darwin-arm64     tetaue-windows-x64.exe
 *
 * Linux targets are musl-only: a musl binary runs anywhere musl does (Alpine
 * and friends) with zero distro-library coupling, while a gnu binary embeds
 * whatever libc/ICU the build machine's bun was linked against.
 ******************************************************************************/
import { mkdirSync, existsSync, chmodSync, readdirSync, statSync, rmSync } from 'node:fs';
import { spawnSync, execFileSync } from 'node:child_process';
import { platform, arch, homedir } from 'node:os';
import { join } from 'node:path';

interface Target {
    /** bun build --target= value */
    target: string;
    /** output file name in dist/ */
    file: string;
    /** oven-sh/bun release asset stem (bun's arm64 targets ship as aarch64) */
    asset: string;
    /** bun executable name inside the release zip */
    exe: string;
}

const BUN_VERSION = '1.4.0';
const RELEASE_BASE = `https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}`;

const TARGETS: Target[] = [
    { target: 'bun-linux-x64-musl', file: 'tetaue-linux-x64-musl', asset: 'bun-linux-x64-musl', exe: 'bun' },
    { target: 'bun-linux-arm64-musl', file: 'tetaue-linux-arm64-musl', asset: 'bun-linux-aarch64-musl', exe: 'bun' },
    { target: 'bun-darwin-x64', file: 'tetaue-darwin-x64', asset: 'bun-darwin-x64', exe: 'bun' },
    { target: 'bun-darwin-arm64', file: 'tetaue-darwin-arm64', asset: 'bun-darwin-aarch64', exe: 'bun' },
    { target: 'bun-windows-x64', file: 'tetaue-windows-x64.exe', asset: 'bun-windows-x64', exe: 'bun.exe' },
];

/** bun build --target= value for the machine running the script, if supported. */
function hostTarget(): string | undefined {
    if (platform() === 'linux') return arch() === 'arm64' ? 'bun-linux-arm64-musl' : 'bun-linux-x64-musl';
    if (platform() === 'darwin') return arch() === 'arm64' ? 'bun-darwin-arm64' : 'bun-darwin-x64';
    if (platform() === 'win32') return 'bun-windows-x64';
    return undefined;
}

const args = process.argv.slice(2);
const officialRuntime = args.includes('--official-runtime') || args.includes('--use-official-runtime');
const host = args.includes('--host');
const onlys = args.filter(a => !a.startsWith('--'));

const wanted = host ? [hostTarget()] : onlys;
const selected = wanted.length ? TARGETS.filter(t => wanted.includes(t.target)) : TARGETS;
if (selected.length === 0) {
    console.error(host
        ? `no standalone target for ${platform()}-${arch()} — run without arguments to build every platform`
        : `unknown target(s) '${onlys.join(' ')}' — available: ${TARGETS.map(t => t.target).join(', ')}`);
    process.exit(1);
}

/** Fetch + extract a release runtime into the cache; returns the bun executable path. */
function officialRuntimeFor(t: Target): string {
    const cacheRoot = join(
        process.env['XDG_CACHE_HOME'] ?? join(homedir(), '.cache'),
        'tetaue', 'bun-runtime', `bun-v${BUN_VERSION}`, t.asset,
    );
    const exePath = join(cacheRoot, t.asset, t.exe);
    if (existsSync(exePath)) return exePath;

    mkdirSync(cacheRoot, { recursive: true });
    const zipPath = join(cacheRoot, `${t.asset}.zip`);
    console.error(`downloading ${RELEASE_BASE}/${t.asset}.zip → ${zipPath}`);
    execFileSync('curl', ['-fL', '--retry', '3', '--progress-bar', '-o', zipPath, `${RELEASE_BASE}/${t.asset}.zip`], { stdio: 'inherit' });

    const extractDir = join(cacheRoot, `.extract-${Date.now()}`);
    mkdirSync(extractDir, { recursive: true });
    try {
        execFileSync('unzip', ['-q', '-o', zipPath, '-d', extractDir], { stdio: 'inherit' });
        // the zip contains a single top-level directory named after the asset
        const entries = readdirSync(extractDir).filter(n => !n.startsWith('.'));
        const inner = entries.find(n => statSync(join(extractDir, n)).isDirectory()) ?? entries[0];
        if (!inner) throw new Error(`no files in ${t.asset}.zip`);
        const from = join(extractDir, inner);
        const to = join(cacheRoot, t.asset);
        if (existsSync(to)) rmSync(to, { recursive: true, force: true });
        execFileSync('mv', [from, to]);
    } finally {
        rmSync(extractDir, { recursive: true, force: true });
    }
    if (!existsSync(exePath)) {
        throw new Error(`${t.exe} not found after extracting ${t.asset}.zip`);
    }
    if (platform() !== 'win32') chmodSync(exePath, 0o755);
    return exePath;
}

function bunBinary(): string {
    if (typeof Bun === 'undefined') {
        console.error('error: run this script with bun (bun run scripts/build-standalone.ts)');
        process.exit(1);
    }
    return process.execPath;
}

const bun = bunBinary();
mkdirSync('dist', { recursive: true });
let failed = 0;
for (const t of selected) {
    console.error(`\n=== ${t.target} → dist/${t.file}${officialRuntime ? ' (official runtime)' : ''}`);
    const argv = ['build', '--compile', `--target=${t.target}`, 'bin/tetaue.ts', '--outfile', `dist/${t.file}`];
    if (officialRuntime) {
        try {
            argv.push('--compile-executable-path', officialRuntimeFor(t));
        } catch (err) {
            console.error(`failed to fetch the official runtime for ${t.target}: ${err instanceof Error ? err.message : String(err)}`);
            failed++;
            continue;
        }
    }
    const result = spawnSync(bun, argv, { stdio: 'inherit' });
    if (result.status !== 0) {
        console.error(`\nfailed to build ${t.target} (exit ${result.status ?? 'signal ' + result.signal})`);
        if (!officialRuntime && t.target.includes('musl')) {
            console.error(`hint: musl builds need the musl bun base image, which bun could not download here — retry with --official-runtime.`);
        }
        failed++;
    }
}

if (failed > 0) {
    console.error(`\n${failed} of ${selected.length} build(s) failed.`);
    process.exit(1);
}
console.error(`\nbuilt ${selected.length} executable(s) into dist/ — copy them (or a zip) for distribution.`);
console.error(`hint: on ${platform()}-${arch()} run 'bun run build:standalone' for just this platform.`);
console.error(`note: without --official-runtime the binaries embed THIS machine's bun runtime${platform() === 'linux' ? ' (possible shared-library coupling, e.g. Arch ICU)' : ''}; pass --official-runtime for portable builds.`);
console.error(`cache: ${join(process.env['XDG_CACHE_HOME'] ?? join(homedir(), '.cache'), 'tetaue', 'bun-runtime')}`);
