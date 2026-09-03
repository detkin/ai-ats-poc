/**
 * tests/cli/live-run.test.ts — the review cycle, end to end, on `TL_ADAPTER=bridge`.
 *
 * This is the block's real claim: the **unchanged** engine and the **unchanged** CLIs run a
 * review cycle over Tier-1 data that came out of the Rippling MCP, not out of the generator.
 * The scenario is `modes/live-run.md` in miniature, over `tests/bridge/sample-snapshot.json`:
 *
 *   import → cycle create (all departments) → open → tick → tick again → audit → verify →
 *   packet assemble
 *
 * and the four things that must hold on real people hold here too: the person Rippling says
 * is on leave gets a moved due date and no message, the second tick is a no-op, every ledger
 * line says `adapter: bridge`, and the calibration packet states — rather than fabricates —
 * that compensation was not available.
 *
 * `TL_NOW` is frozen for the test (docs/DECISIONS.md D8); the real run in `modes/live-run.md`
 * deliberately uses the wall clock instead.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AUDIT_SPEC, runAudit } from '#lib/cli/audit.ts';
import { BRIDGE_SPEC, runBridge } from '#lib/cli/bridge.ts';
import { CYCLE_SPEC, runCycle } from '#lib/cli/cycle.ts';
import { PACKET_SPEC, runPacket } from '#lib/cli/packet.ts';
import { TICK_SPEC, runTick } from '#lib/cli/tick.ts';
import { VERIFY_SPEC, runVerify } from '#lib/cli/verify.ts';
import type { TlAgentAction, TlCycle, TlTask } from '#lib/types/engine.ts';
import { SAMPLE_SNAPSHOT_PATH, sampleSnapshot } from '#tests/bridge/helpers.ts';
import { readLedger, readOutbox, readState, runCli, runJson } from '#tests/cli/helpers.ts';

/** The person `tests/bridge/sample-snapshot.json` puts on vacation until 2026-09-03. */
const ON_LEAVE = 'w_eng2';
/** The acting user in the snapshot: `lookup_me` is the root of the org walk. */
const ACTOR = 'w_ceo';
const OPEN_AT = '2026-08-24T16:00:00Z';
const TICK_AT = '2026-09-02T16:00:00Z';

let dataDir: string;
let cycleId: string;
const saved = {
  adapter: process.env.TL_ADAPTER,
  dataDir: process.env.TL_DATA_DIR,
  now: process.env.TL_NOW,
};

const tasks = (): TlTask[] => readState<'task'>(dataDir, 'tasks.json');

beforeAll(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'tl-live-run-'));
  process.env.TL_DATA_DIR = dataDir;
  process.env.TL_ADAPTER = 'bridge';
  process.env.TL_NOW = OPEN_AT;
});

afterAll(() => {
  rmSync(dataDir, { recursive: true, force: true });
  for (const [key, value] of [
    ['TL_ADAPTER', saved.adapter],
    ['TL_DATA_DIR', saved.dataDir],
    ['TL_NOW', saved.now],
  ] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('1. import the fetched tenant', () => {
  it('makes a bridged tenant the CLIs can read', async () => {
    const run = await runCli(BRIDGE_SPEC, runBridge, ['import', '--from', SAMPLE_SNAPSHOT_PATH]);
    expect(run.code, run.stderr).toBe(0);
  });

  it('refuses to build a runtime when nothing was imported', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'tl-live-empty-'));
    process.env.TL_DATA_DIR = empty;
    try {
      const run = await runCli(CYCLE_SPEC, runCycle, ['show', '--cycle', 'tl_cycle_x']);
      expect(run.code).not.toBe(0);
      expect(run.stderr).toContain('bin/bridge.mjs import');
    } finally {
      process.env.TL_DATA_DIR = dataDir;
      rmSync(empty, { recursive: true, force: true });
    }
  });
});

describe('2. create and open a review cycle over the whole company', () => {
  it('creates a cycle owned by the acting user', async () => {
    const { run, data } = await runJson<TlCycle>(CYCLE_SPEC, runCycle, [
      'create',
      '--type',
      'review',
      '--name',
      'Bridged pilot cycle',
      '--owner',
      ACTOR,
      '--deadline',
      '2026-09-18',
    ]);
    expect(run.code, run.stderr).toBe(0);
    expect(data.owner_worker_id).toBe(ACTOR);
    // No `--department`: the whole company is in scope (participantsFor, engine untouched).
    expect(data.scope.department_ids).toBeUndefined();
    cycleId = data.id;
  });

  it('opens it and creates tasks for the real people', async () => {
    const { run, data } = await runJson<{
      participants: number;
      tasks: number;
      by_kind: Record<string, number>;
    }>(CYCLE_SPEC, runCycle, ['open', '--cycle', cycleId]);
    expect(run.code, run.stderr).toBe(0);
    expect(data.participants).toBe(8);
    expect(data.tasks).toBeGreaterThan(0);
    expect(data.by_kind.write_self_review).toBe(8);
    // Every participant is one of the people the org walk fetched, not a generated worker.
    const fetched = new Set(sampleSnapshot().people.map((person) => person.id));
    expect(tasks().every((task) => fetched.has(task.participant_worker_id))).toBe(true);
  });
});

describe('3. tick', () => {
  let first: { changed: boolean; actions: { kind: string; task_id?: string }[] };

  it('runs and changes something', async () => {
    process.env.TL_NOW = TICK_AT;
    const { run, data } = await runJson<typeof first>(TICK_SPEC, runTick, ['--cycle', cycleId]);
    expect(run.code, run.stderr).toBe(0);
    expect(data.changed).toBe(true);
    first = data;
  });

  it('moves the due date of the person Rippling says is on leave', () => {
    const moves = first.actions.filter((action) => action.kind === 'move_due_date');
    expect(moves.length).toBeGreaterThan(0);
    const movedTaskIds = new Set(moves.map((move) => move.task_id));
    const moved = tasks().filter((task) => movedTaskIds.has(task.id));
    expect(moved.length).toBe(moves.length);
    expect(new Set(moved.map((task) => task.participant_worker_id))).toEqual(new Set([ON_LEAVE]));
    // Two days after they return (2026-09-03), per tenant policy.
    expect(moved.every((task) => task.due_at.startsWith('2026-09-06'))).toBe(true);
    expect(moved.every((task) => task.original_due_at !== task.due_at)).toBe(true);
  });

  it('sends that person nothing at all', () => {
    expect(readOutbox(dataDir).map((line) => line.to_worker_id)).not.toContain(ON_LEAVE);
    expect(
      tasks()
        .filter((task) => task.participant_worker_id === ON_LEAVE)
        .every((task) => task.attempt_n === 0),
    ).toBe(true);
  });

  it('reminds the people it can reach, once each', () => {
    const recipients = readOutbox(dataDir)
      .filter((line) => line.template_id.startsWith('nudge.'))
      .map((line) => line.to_worker_id);
    expect(recipients.length).toBeGreaterThan(0);
    expect(new Set(recipients).size).toBe(recipients.length);
  });

  it('is a no-op the second time at the same instant', async () => {
    const { run, data } = await runJson<{ changed: boolean; actions: unknown[] }>(
      TICK_SPEC,
      runTick,
      ['--cycle', cycleId],
    );
    expect(run.code, run.stderr).toBe(0);
    expect(data.changed).toBe(false);
    expect(data.actions).toEqual([]);
  });
});

describe('4. the ledger says where the data came from', () => {
  it('stamps adapter: bridge on every single line', () => {
    const lines: TlAgentAction[] = readLedger(dataDir);
    expect(lines.length).toBeGreaterThan(0);
    expect(new Set(lines.map((line) => line.actor.adapter))).toEqual(new Set(['bridge']));
    expect(new Set(lines.map((line) => line.actor.worker_id))).toEqual(new Set([ACTOR]));
  });

  it('renders through audit.mjs, scoped to the cycle', async () => {
    const { run, data } = await runJson<{
      cycle_id: string;
      entries: { actor: { adapter: string } }[];
    }>(AUDIT_SPEC, runAudit, ['--cycle', cycleId]);
    expect(run.code, run.stderr).toBe(0);
    expect(data.cycle_id).toBe(cycleId);
    expect(data.entries.length).toBeGreaterThan(0);
    expect(data.entries.every((entry) => entry.actor.adapter === 'bridge')).toBe(true);
  });
});

describe('5. verify and packet', () => {
  it('verify-loops passes on the bridged run', async () => {
    const { run, data } = await runJson<{ ok: boolean; checks: { id: string; ok: boolean }[] }>(
      VERIFY_SPEC,
      runVerify,
      ['--cycle', cycleId],
    );
    expect(run.code, run.stderr).toBe(0);
    expect(data.ok).toBe(true);
  });

  it('assembles a calibration packet that says compensation was not available', async () => {
    const assembled = await runJson<{ packet_id: string }>(PACKET_SPEC, runPacket, [
      'assemble',
      '--cycle',
      cycleId,
      '--kind',
      'calibration',
      '--staging',
      'staging',
    ]);
    expect(assembled.run.code, assembled.run.stderr).toBe(0);

    const shown = await runJson<{ body: string }>(PACKET_SPEC, runPacket, [
      'show',
      '--packet',
      assembled.data.packet_id,
    ]);
    expect(shown.run.code, shown.run.stderr).toBe(0);
    expect(shown.data.body).toContain('Compensation not available via MCP');
    // And it invents nothing: no compa-ratio table, no pay figure.
    expect(shown.data.body).not.toContain('Mean compa-ratio');
  });
});

describe('6. doctor is healthy on a bridged data dir', () => {
  it('reports the imported tenant rather than telling the operator to import one', async () => {
    const { DOCTOR_SPEC, runDoctor } = await import('#lib/cli/doctor.ts');
    const { run, data } = await runJson<{
      ok: boolean;
      checks: { id: string; status: string; detail: string }[];
    }>(DOCTOR_SPEC, runDoctor, []);
    expect(run.code).toBe(0);
    const check = data.checks.find((row) => row.id === 'tier1_snapshot');
    expect(check?.status).toBe('ok');
    expect(check?.detail).toContain('rippling-mcp');
  });
});
