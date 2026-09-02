#!/usr/bin/env node
/**
 * bin/packet.mjs — assemble a packet from the engine plus staging, or show one.
 *
 * Thin CLI (docs/DECISIONS.md D11): parse arguments, call one `lib/cli/*` function, render.
 * All behaviour, flags and exit codes live in `#lib/cli/packet.ts`; run with `--help` for both.
 */

import { runCli } from '#lib/cli/runtime.ts';
import { PACKET_SPEC, runPacket } from '#lib/cli/packet.ts';

process.exitCode = await runCli(PACKET_SPEC, process.argv.slice(2), runPacket);
