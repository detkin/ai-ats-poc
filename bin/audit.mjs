#!/usr/bin/env node
/**
 * bin/audit.mjs — render the agent-action ledger for a cycle.
 *
 * Thin CLI (docs/DECISIONS.md D11): parse arguments, call one `lib/cli/*` function, render.
 * All behaviour, flags and exit codes live in `#lib/cli/audit.ts`; run with `--help` for both.
 */

import { runCli } from '#lib/cli/runtime.ts';
import { AUDIT_SPEC, runAudit } from '#lib/cli/audit.ts';

process.exitCode = await runCli(AUDIT_SPEC, process.argv.slice(2), runAudit);
