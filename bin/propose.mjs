#!/usr/bin/env node
/**
 * bin/propose.mjs — record a tl_proposed_action for a human to decide.
 *
 * Thin CLI (docs/DECISIONS.md D11): parse arguments, call one `lib/cli/*` function, render.
 * All behaviour, flags and exit codes live in `#lib/cli/propose.ts`; run with `--help` for both.
 */

import { runCli } from '#lib/cli/runtime.ts';
import { PROPOSE_SPEC, runPropose } from '#lib/cli/propose.ts';

process.exitCode = await runCli(PROPOSE_SPEC, process.argv.slice(2), runPropose);
