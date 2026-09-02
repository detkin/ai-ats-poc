/**
 * tests/cli/packet.test.ts — the drop-folder merge and the stored packet.
 *
 * The merge is the part that has to be deterministic: fan-out workers write one JSON file
 * each into `staging/<cycle_id>/` in whatever order they finish, and `packet.mjs` merges them
 * in `section_id` order after the engine-assembled body (spec §5, the career-ops `batch/`
 * pattern). A malformed partial fails the assembly rather than silently dropping somebody's
 * section.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { CYCLE_SPEC, runCycle } from '#lib/cli/cycle.ts';
import { PACKET_SPEC, runPacket } from '#lib/cli/packet.ts';
import { readPartials } from '#lib/cli/packet.ts';
import type { TlCycle, TlPacket } from '#lib/types/engine.ts';
import {
  ANCHOR,
  OPEN_AT,
  cleanupDataDirs,
  readState,
  runCli,
  runJson,
  seedDataDir,
  setNow,
} from '#tests/cli/helpers.ts';

let dataDir: string;
let cycleId: string;
let staging: string;

interface AssembleOutput {
  packet_id: string;
  inputs_hash: string;
  citations: number;
  partials: string[];
  staging_dir: string;
}

beforeAll(async () => {
  dataDir = seedDataDir();
  staging = mkdtempSync(join(tmpdir(), 'tl-staging-'));
  setNow(OPEN_AT);
  const { data } = await runJson<TlCycle>(CYCLE_SPEC, runCycle, [
    'create',
    '--type',
    'review',
    '--name',
    'Design H2 2026',
    '--owner',
    'w_0021',
    '--department',
    'dept_design',
    '--deadline',
    '2026-09-18',
  ]);
  cycleId = data.id;
  await runCli(CYCLE_SPEC, runCycle, ['open', '--cycle', cycleId]);
});

afterAll(() => {
  rmSync(staging, { recursive: true, force: true });
  cleanupDataDirs();
  delete process.env.TL_NOW;
  delete process.env.TL_DATA_DIR;
});

/** Drop a partial into the staging dir under an arbitrary file name. */
function drop(file: string, partial: Record<string, unknown>): void {
  mkdirSync(staging, { recursive: true });
  writeFileSync(join(staging, file), `${JSON.stringify(partial, null, 2)}\n`, 'utf8');
}

describe('packet assemble', () => {
  it('assembles from the engine alone when the drop folder is empty', async () => {
    setNow(ANCHOR);
    const { run, data } = await runJson<AssembleOutput>(PACKET_SPEC, runPacket, [
      'assemble',
      '--cycle',
      cycleId,
      '--kind',
      'calibration',
      '--staging',
      staging,
    ]);
    expect(run.code).toBe(0);
    expect(data.partials).toEqual([]);
    expect(data.inputs_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(data.citations).toBeGreaterThan(0);

    const packet = readState<'packet'>(dataDir, 'packets.json').find(
      (row) => row.id === data.packet_id,
    ) as TlPacket | undefined;
    expect(packet?.body).toContain('## 1.');
    expect(packet?.body).not.toContain('## Contributed sections');
  });

  it('merges two partials in section_id order, whatever the file names', async () => {
    // Dropped out of order on purpose: `z-…` holds section 8, `a-…` holds section 9.
    drop('z-tenure.json', {
      section_id: '8. Tenure context',
      body_md: 'Two participants joined after the prior cycle. [worker:w_0071]',
      citations: [{ claim_id: 'c8', record_ids: ['w_0071'], kind: 'source' }],
    });
    drop('a-managers.json', {
      section_id: '9. Manager notes',
      body_md: 'One manager asked for a second look at team_design. [cycles:tl_cycle_x]',
      citations: [{ claim_id: 'c9', record_ids: ['tl_cycle_x'], kind: 'derived' }],
    });

    setNow(ANCHOR);
    const { run, data } = await runJson<AssembleOutput>(PACKET_SPEC, runPacket, [
      'assemble',
      '--cycle',
      cycleId,
      '--kind',
      'calibration',
      '--staging',
      staging,
    ]);
    expect(run.code).toBe(0);
    expect(data.partials).toEqual(['8. Tenure context', '9. Manager notes']);

    const packet = readState<'packet'>(dataDir, 'packets.json').find(
      (row) => row.id === data.packet_id,
    ) as TlPacket | undefined;
    const body = packet?.body ?? '';
    expect(body).toContain('## Contributed sections');
    expect(body.indexOf('### 8. Tenure context')).toBeLessThan(
      body.indexOf('### 9. Manager notes'),
    );
    expect(body).toContain('Two participants joined after the prior cycle.');

    // Both partials' citations survive into the stored record.
    const claims = (packet?.citations ?? []).map((citation) => citation.claim_id);
    expect(claims).toContain('c8');
    expect(claims).toContain('c9');
  });

  it('keeps the same inputs_hash: contributed prose is not an engine input', async () => {
    const packets = readState<'packet'>(dataDir, 'packets.json') as TlPacket[];
    const hashes = new Set(packets.map((packet) => packet.inputs_hash));
    expect(hashes.size).toBe(1);
  });

  it('refuses a malformed partial rather than dropping a section', () => {
    drop('broken.json', { body_md: 'no section id here' });
    expect(() => readPartials(staging)).toThrow(/needs "section_id" and "body_md"/);
    rmSync(join(staging, 'broken.json'));

    drop('bad-citation.json', {
      section_id: '7. Bad',
      body_md: 'x',
      citations: [{ claim_id: 'c7' }],
    });
    expect(() => readPartials(staging)).toThrow(/each citation needs claim_id/);
    rmSync(join(staging, 'bad-citation.json'));
  });

  it('reports the debrief packet as an M2 feature', async () => {
    setNow(ANCHOR);
    const run = await runCli(PACKET_SPEC, runPacket, [
      'assemble',
      '--cycle',
      cycleId,
      '--kind',
      'debrief',
    ]);
    expect(run.code).toBe(1);
    expect(run.stderr).toContain('M2');
  });

  it('rejects a kind it has never heard of, as usage', async () => {
    setNow(ANCHOR);
    const run = await runCli(PACKET_SPEC, runPacket, [
      'assemble',
      '--cycle',
      cycleId,
      '--kind',
      'summary',
    ]);
    expect(run.code).toBe(2);
    expect(run.stderr).toContain('is not assemblable here');
  });
});

describe('packet show', () => {
  it('prints the stored body', async () => {
    setNow(ANCHOR);
    const packets = readState<'packet'>(dataDir, 'packets.json') as TlPacket[];
    const packet = packets.at(-1);
    const run = await runCli(PACKET_SPEC, runPacket, ['show', '--packet', packet?.id ?? '']);
    expect(run.code).toBe(0);
    expect(run.stdout.trim()).toBe(packet?.body.trimEnd());
  });

  it('reports an unknown packet id', async () => {
    setNow(ANCHOR);
    const run = await runCli(PACKET_SPEC, runPacket, ['show', '--packet', 'tl_packet_nope']);
    expect(run.code).toBe(1);
    expect(run.stderr).toContain('no packet with id "tl_packet_nope"');
  });
});
