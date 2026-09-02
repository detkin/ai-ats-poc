#!/usr/bin/env node
/**
 * bin/decide.mjs — record a named human approving or declining a proposal.
 *
 * Thin CLI (docs/DECISIONS.md D11): parse arguments, call one `lib/cli/*` function, render.
 * All behaviour, flags and exit codes live in `#lib/cli/decide.ts`; run with `--help` for both.
 */

import { runCli } from '#lib/cli/runtime.ts';
import { DECIDE_SPEC, runDecide } from '#lib/cli/decide.ts';

process.exitCode = await runCli(DECIDE_SPEC, process.argv.slice(2), runDecide);
