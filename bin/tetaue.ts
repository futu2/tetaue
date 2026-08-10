#!/usr/bin/env bun
import { main } from '../src/cli.ts';

process.exitCode = await main(process.argv.slice(2)).catch((err: unknown) => {
    console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
});
