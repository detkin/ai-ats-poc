#!/usr/bin/env node
/**
 * bin/cycle.mjs — create, open, close or inspect a cycle.
 *
 * Thin CLI (docs/DECISIONS.md D11): parse arguments, call one `lib/cli/*` function, render.
 * All behaviour, flags and exit codes live in `#lib/cli/cycle.ts`; run with `--help` for both.
 */

import { runCli } from '#lib/cli/runtime.ts';
import { CYCLE_SPEC, runCycle } from '#lib/cli/cycle.ts';

process.exitCode = await runCli(CYCLE_SPEC, process.argv.slice(2), runCycle);
