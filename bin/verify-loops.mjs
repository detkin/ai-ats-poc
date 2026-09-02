#!/usr/bin/env node
/**
 * bin/verify-loops.mjs — reconcile state against the ledger and Tier-1 records.
 *
 * Thin CLI (docs/DECISIONS.md D11): parse arguments, call one `lib/cli/*` function, render.
 * All behaviour, flags and exit codes live in `#lib/cli/verify.ts`; run with `--help` for both.
 */

import { runCli } from '#lib/cli/runtime.ts';
import { VERIFY_SPEC, runVerify } from '#lib/cli/verify.ts';

process.exitCode = await runCli(VERIFY_SPEC, process.argv.slice(2), runVerify);
