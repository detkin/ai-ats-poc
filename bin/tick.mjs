#!/usr/bin/env node
/**
 * bin/tick.mjs — run one tick for a cycle (locked, idempotent).
 *
 * Thin CLI (docs/DECISIONS.md D11): parse arguments, call one `lib/cli/*` function, render.
 * All behaviour, flags and exit codes live in `#lib/cli/tick.ts`; run with `--help` for both.
 */

import { runCli } from '#lib/cli/runtime.ts';
import { TICK_SPEC, runTick } from '#lib/cli/tick.ts';

process.exitCode = await runCli(TICK_SPEC, process.argv.slice(2), runTick);
