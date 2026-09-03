#!/usr/bin/env node
/**
 * bin/bridge.mjs — plan, import and inspect a Rippling MCP snapshot (TL_ADAPTER=bridge).
 *
 * Thin CLI (docs/DECISIONS.md D11): parse arguments, call one `lib/cli/*` function, render.
 * All behaviour, flags and exit codes live in `#lib/cli/bridge.ts`; run with `--help` for both.
 */

import { runCli } from '#lib/cli/runtime.ts';
import { BRIDGE_SPEC, runBridge } from '#lib/cli/bridge.ts';

process.exitCode = await runCli(BRIDGE_SPEC, process.argv.slice(2), runBridge);
