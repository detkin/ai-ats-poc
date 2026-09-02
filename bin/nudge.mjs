#!/usr/bin/env node
/**
 * bin/nudge.mjs — send and record one policy-checked reminder.
 *
 * Thin CLI (docs/DECISIONS.md D11): parse arguments, call one `lib/cli/*` function, render.
 * All behaviour, flags and exit codes live in `#lib/cli/nudge.ts`; run with `--help` for both.
 */

import { runCli } from '#lib/cli/runtime.ts';
import { NUDGE_SPEC, runNudge } from '#lib/cli/nudge.ts';

process.exitCode = await runCli(NUDGE_SPEC, process.argv.slice(2), runNudge);
