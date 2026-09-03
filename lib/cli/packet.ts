/**
 * lib/cli/packet.ts — assemble a packet, merge the drop folder, store it (block B1.3).
 *
 * Owns: `assemblePacket` and `showPacket`. The body has two halves and they are kept
 * separate on purpose:
 *
 *   1. **The engine half** — `assembleCalibration` (pure, no LLM): rating distribution by
 *      manager, compa-ratio against band, tenure, completion, outliers phrased as
 *      observations. Every figure carries a `[kind:id]` citation, and the `inputs_hash` over
 *      the records it read is what makes a packet stale when the records move (spec §7 step 2).
 *   2. **The staging half** — one `*.json` per fan-out worker in `staging/<cycle_id>/`, each
 *      `{ section_id, body_md, citations[] }`. Parallel workers never contend for one file
 *      (spec §5, the career-ops `batch/` drop-folder pattern); `packet.mjs` merges once, in
 *      `section_id` order, so the merge is deterministic however the writers were scheduled.
 *
 * The stored `inputs_hash` is the **engine** hash. Staging partials are contributed prose,
 * not inputs: including them would make the tick's "packet is stale" test depend on who
 * happened to drop a file, and a re-run with the same records would never settle. Noted in
 * `lib/cli/README.md`.
 *
 * Public interface: `PACKET_SPEC`, `runPacket`, `assemblePacket`, `showPacket`,
 * `readPartials`, `stagingDirFor`, `PacketPartial`, `AssembleResult`.
 *
 * Spec: docs/SPEC.md §5 (staging), §7 step 2, §10 (faithfulness); docs/PLAN.md §4 block B1.3.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import type { Runtime } from '#lib/adapters/index.ts';
import { UsageError } from '#lib/cli/args.ts';
import type { Args, CliSpec } from '#lib/cli/args.ts';
import { ok } from '#lib/cli/output.ts';
import type { CliOutput } from '#lib/cli/output.ts';
import { CliError, openRuntime, openRuntimeForRecord } from '#lib/cli/runtime.ts';
import { calibrationInputsFor, loadCycle } from '#lib/cli/snapshot.ts';
import type { Config } from '#lib/config.ts';
import { assembleCalibration, participantsFor } from '#lib/engine/index.ts';
import type { TlCitation, TlPacket, TlPacketKind, TlReviewSubmission } from '#lib/types/engine.ts';
import type { InstantISO } from '#lib/types/tier1.ts';

/** Drop folder for fan-out workers, relative to the repo root. */
export const STAGING_DIRNAME = 'staging';

export const PACKET_SPEC: CliSpec = {
  name: 'packet.mjs',
  summary: 'assemble a packet from the engine plus the staging drop folder, or show one',
  usage: [
    'bin/packet.mjs assemble --cycle <id> --kind calibration [--staging <dir>]',
    'bin/packet.mjs show --packet <id>',
  ],
  subcommands: [
    { name: 'assemble', description: 'build and store a tl_packet for a cycle' },
    { name: 'show', description: 'print a stored packet body' },
  ],
  flags: [
    { name: 'cycle', type: 'string', value: '<id>', description: 'cycle to assemble for' },
    { name: 'kind', type: 'string', value: '<k>', description: 'packet kind (calibration)' },
    {
      name: 'staging',
      type: 'string',
      value: '<dir>',
      description: `partials directory (default: ${STAGING_DIRNAME}/<cycle_id>/)`,
    },
    { name: 'packet', type: 'string', value: '<id>', description: 'tl_packet id, for show' },
  ],
  notes: [
    'A partial is a JSON file: { "section_id": "...", "body_md": "...", "citations": [] }.\n' +
      'Partials merge in section_id order after the engine-assembled body.',
  ],
};

/** One fan-out worker's contribution, dropped into the staging directory. */
export interface PacketPartial {
  section_id: string;
  body_md: string;
  citations: TlCitation[];
  /** File it was read from, for the CLI summary. */
  source_file: string;
}

export interface AssembleResult {
  packet: TlPacket;
  partials: PacketPartial[];
  staging_dir: string;
  /** True when the engine inputs were unchanged and the body is a re-render. */
  inputs_hash: string;
}

/** `staging/<cycle_id>/` under the repo root, unless the caller names a directory. */
export function stagingDirFor(config: Config, cycleId: string, override?: string): string {
  return override ?? join(config.repoRoot, STAGING_DIRNAME, cycleId);
}

function asCitations(value: unknown, file: string): TlCitation[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new CliError('BAD_PARTIAL', `${file}: "citations" must be an array`);
  }
  return value.map((entry) => {
    const record = entry as Partial<TlCitation>;
    if (
      typeof record.claim_id !== 'string' ||
      !Array.isArray(record.record_ids) ||
      (record.kind !== 'source' && record.kind !== 'derived')
    ) {
      throw new CliError(
        'BAD_PARTIAL',
        `${file}: each citation needs claim_id, record_ids[] and kind ('source' or 'derived')`,
      );
    }
    return { claim_id: record.claim_id, record_ids: [...record.record_ids], kind: record.kind };
  });
}

/**
 * Every `*.json` in the staging directory, sorted by `section_id` (file name breaks ties).
 * A missing directory is an empty list: assembling without fan-out is normal.
 */
export function readPartials(dir: string): PacketPartial[] {
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .sort();

  const partials: PacketPartial[] = [];
  for (const file of files) {
    const path = join(dir, file);
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(path, 'utf8'));
    } catch (error) {
      throw new CliError(
        'BAD_PARTIAL',
        `${path} is not valid JSON (${error instanceof Error ? error.message : 'parse error'})`,
      );
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new CliError('BAD_PARTIAL', `${path} must be a JSON object`);
    }
    const record = parsed as Partial<PacketPartial>;
    if (typeof record.section_id !== 'string' || typeof record.body_md !== 'string') {
      throw new CliError('BAD_PARTIAL', `${path} needs "section_id" and "body_md" strings`);
    }
    partials.push({
      section_id: record.section_id,
      body_md: record.body_md,
      citations: asCitations(record.citations, path),
      source_file: file,
    });
  }

  return partials.sort((a, b) =>
    a.section_id === b.section_id
      ? a.source_file < b.source_file
        ? -1
        : 1
      : a.section_id < b.section_id
        ? -1
        : 1,
  );
}

/** Validate `--kind`. `debrief` is block B2.2. */
export function parsePacketKind(raw: string): TlPacketKind {
  if (raw === 'calibration') return raw;
  if (raw === 'debrief') {
    throw new CliError('PACKET_KIND_NOT_YET', 'the debrief packet lands in M2 (block B2.2).');
  }
  throw new UsageError(
    `packet.mjs: --kind "${raw}" is not assemblable here (expected calibration)`,
  );
}

/**
 * Assemble and store the packet. Called by `bin/packet.mjs assemble` and by the tick's
 * `refresh_packet` action, so the stored artefact is identical either way.
 */
export async function assemblePacket(
  rt: Runtime,
  config: Config,
  input: { cycleId: string; kind: TlPacketKind; stagingDir?: string; now: InstantISO },
): Promise<AssembleResult> {
  const cycle = await loadCycle(rt, input.cycleId);
  if (cycle.type !== 'review') {
    throw new CliError(
      'PACKET_KIND_MISMATCH',
      `cycle ${cycle.id} is a ${cycle.type} cycle; the calibration packet is for review cycles.`,
    );
  }

  const submissions: TlReviewSubmission[] = await rt.ports.state.list('review_submission', {
    cycle_id: cycle.id,
  });
  const workers = await rt.ports.graph.searchPeople({});
  const participants = participantsFor(cycle, new Map(workers.map((w) => [w.id, w])));
  const inputs = await calibrationInputsFor(rt, cycle, participants, submissions, input.now);
  const assembled = assembleCalibration(inputs);

  const stagingDir = stagingDirFor(config, cycle.id, input.stagingDir);
  const partials = readPartials(stagingDir);

  const bodyParts = [assembled.body_md.trimEnd()];
  if (partials.length > 0) {
    bodyParts.push('', '## Contributed sections');
    for (const partial of partials) {
      bodyParts.push('', `### ${partial.section_id}`, '', partial.body_md.trim());
    }
  }

  const citations: TlCitation[] = [
    ...assembled.citations,
    ...partials.flatMap((partial) => partial.citations),
  ];

  const packet = await rt.ports.state.create('packet', {
    cycle_id: cycle.id,
    kind: input.kind,
    inputs_hash: assembled.inputs_hash,
    body: `${bodyParts.join('\n')}\n`,
    citations,
  });

  return { packet, partials, staging_dir: stagingDir, inputs_hash: assembled.inputs_hash };
}

/** Read one stored packet. */
export async function showPacket(rt: Runtime, packetId: string): Promise<TlPacket> {
  const packet = await rt.ports.state.get('packet', packetId);
  if (packet === null) {
    throw new CliError('PACKET_NOT_FOUND', `no packet with id "${packetId}" in the runtime state.`);
  }
  return packet;
}

export async function runPacket(args: Args): Promise<CliOutput> {
  const command = args.requireSubcommand();

  if (command === 'show') {
    const packetId = args.require('packet');
    // Scoped to the packet's own cycle, so the ledgered read lands in `audit --cycle` (D19).
    const { opened } = await openRuntimeForRecord('packet', packetId);
    const packet = await showPacket(opened.rt, packetId);
    return ok(packet, [packet.body.trimEnd()]);
  }

  const cycleId = args.require('cycle');
  const kind = parsePacketKind(args.get('kind') ?? 'calibration');
  const { rt, config, now } = openRuntime({ cycleId });
  const staging = args.get('staging');
  const result = await assemblePacket(rt, config, {
    cycleId,
    kind,
    now,
    ...(staging === undefined ? {} : { stagingDir: staging }),
  });

  return ok(
    {
      packet_id: result.packet.id,
      cycle_id: result.packet.cycle_id,
      kind: result.packet.kind,
      inputs_hash: result.packet.inputs_hash,
      citations: result.packet.citations.length,
      partials: result.partials.map((partial) => partial.section_id),
      staging_dir: result.staging_dir,
      bytes: result.packet.body.length,
    },
    [
      `Assembled ${result.packet.kind} packet ${result.packet.id} for ${result.packet.cycle_id}.`,
      `  inputs_hash  ${result.packet.inputs_hash}`,
      `  citations    ${result.packet.citations.length}`,
      `  partials     ${result.partials.length}${
        result.partials.length === 0
          ? ` (none in ${result.staging_dir})`
          : `: ${result.partials.map((p) => p.section_id).join(', ')}`
      }`,
      `  show it      node bin/packet.mjs show --packet ${result.packet.id}`,
    ],
  );
}
