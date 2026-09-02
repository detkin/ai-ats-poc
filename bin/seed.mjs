#!/usr/bin/env node
/**
 * bin/seed.mjs — regenerate, verify or reset the fixture tenant.
 *
 * Thin CLI (docs/DECISIONS.md D11): parse arguments, call one `lib/cli/*` function, render.
 * All behaviour, flags and exit codes live in `#lib/cli/seed.ts`; run with `--help` for both.
 */

import { runCli } from '#lib/cli/runtime.ts';
import { SEED_SPEC, runSeed } from '#lib/cli/seed.ts';

process.exitCode = await runCli(SEED_SPEC, process.argv.slice(2), runSeed, 1);
