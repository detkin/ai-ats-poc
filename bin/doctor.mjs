#!/usr/bin/env node
/**
 * bin/doctor.mjs — cold-start health check.
 *
 * Thin CLI (docs/DECISIONS.md D11): parse arguments, call one `lib/cli/*` function, render.
 * All behaviour, flags and exit codes live in `#lib/cli/doctor.ts`; run with `--help` for both.
 */

import { DOCTOR_SPEC, runDoctor } from '#lib/cli/doctor.ts';
import { runCli } from '#lib/cli/runtime.ts';

process.exitCode = await runCli(DOCTOR_SPEC, process.argv.slice(2), runDoctor);
