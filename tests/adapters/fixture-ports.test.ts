/**
 * tests/adapters/fixture-ports.test.ts — the read ports, the channel and the state store.
 *
 * Proves: Graph/Ats/Bands serve the fixture tenant unchanged; `readDocument` marks résumés
 * untrusted; compa-ratio is `base / mid` to 3 dp; the channel writes `outbox.jsonl` and reads
 * scripted replies; the state adapter assigns unique ids, refuses illegal status moves,
 * refuses to rewrite provenance, and refuses to run at all against an unseeded data dir.
 *
 * Spec: docs/SPEC.md §3, §9; docs/PLAN.md §2.3, §2.8, §4 block B1.2 (tests).
 */

import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { FixtureAtsAdapter } from '#lib/adapters/fixture/ats.ts';
import { FixtureBandsAdapter, compaRatio } from '#lib/adapters/fixture/bands.ts';
import { FixtureChannelAdapter } from '#lib/adapters/fixture/channel.ts';
import { FixtureGraphAdapter } from '#lib/adapters/fixture/graph.ts';
import { FixtureStateAdapter, RuntimeStateMissingError } from '#lib/adapters/fixture/state.ts';
import { repoRoot } from '#lib/config.ts';
import type { AtsPort } from '#lib/ports/ats.ts';
import { loadTenant } from '#lib/fixtures/index.ts';
import type { TenantBundle } from '#lib/fixtures/index.ts';
import { LoopStatesError } from '#lib/states/index.ts';
import type { TlTask } from '#lib/types/engine.ts';
import {
  ANCHOR_NOW,
  makeDataDir,
  readOutbox,
  removeDataDir,
  writeInbox,
} from '#tests/adapters/helpers.ts';

const HRBP = 'w_0021';
const anchor = (): Date => new Date(ANCHOR_NOW);

let dataDir: string;
let bundle: TenantBundle;
let fixturesDir: string;

beforeAll(() => {
  dataDir = makeDataDir();
  fixturesDir = join(repoRoot(), 'fixtures', 'tenant');
  bundle = loadTenant(fixturesDir);
});

afterAll(() => removeDataDir(dataDir));

describe('FixtureGraphAdapter', () => {
  it('lookupMe returns the acting worker', async () => {
    const graph = new FixtureGraphAdapter(bundle, HRBP);
    const me = await graph.lookupMe();
    expect(me.id).toBe(HRBP);
    expect(me.work_email).toContain('@acme-robotics.example');
  });

  it('filters people by department and manager', async () => {
    const graph = new FixtureGraphAdapter(bundle, HRBP);
    const engineering = await graph.searchPeople({ department_id: 'dept_eng', status: 'ACTIVE' });
    expect(engineering.length).toBeGreaterThan(0);
    expect(engineering.every((w) => w.department_id === 'dept_eng')).toBe(true);

    const reports = await graph.lookupDirectReports('w_0009');
    expect(reports.length).toBeGreaterThan(0);
    expect(reports.every((w) => w.manager_id === 'w_0009')).toBe(true);
  });

  it('returns null for unknown ids and never hands out the shared record', async () => {
    const graph = new FixtureGraphAdapter(bundle, HRBP);
    expect(await graph.lookupPerson('w_9999')).toBeNull();
    const worker = await graph.lookupPerson('w_0009');
    expect(worker).not.toBeNull();
    if (worker !== null) worker.title = 'mutated';
    const again = await graph.lookupPerson('w_0009');
    expect(again?.title).not.toBe('mutated');
  });
});

describe('FixtureAtsAdapter', () => {
  it('reads requisitions and applications by query', async () => {
    const ats = new FixtureAtsAdapter(bundle, fixturesDir);
    const open = await ats.listRequisitions({ status: 'OPEN' });
    expect(open.length).toBe(3);
    const onsite = await ats.listApplications({ job_id: 'req_staff_eng', stage: 'Onsite' });
    expect(onsite.length).toBeGreaterThanOrEqual(3);
  });

  it('serves a résumé as an untrusted document', async () => {
    const ats = new FixtureAtsAdapter(bundle, fixturesDir);
    const candidate = await ats.getCandidate('cand_0001');
    expect(candidate).not.toBeNull();
    const document = await ats.readDocument(candidate?.resume_ref ?? '');
    expect(document.untrusted).toBe(true);
    expect(document.source).toBe('resume');
    expect(document.text.length).toBeGreaterThan(0);
  });

  it('refuses a ref that escapes the fixtures directory', async () => {
    const ats = new FixtureAtsAdapter(bundle, fixturesDir);
    await expect(ats.readDocument('../../etc/passwd')).rejects.toThrow(/no document at ref/);
  });

  it('does not implement the M3 writes', () => {
    const ats: AtsPort = new FixtureAtsAdapter(bundle, fixturesDir);
    expect(ats.createRequisition).toBeUndefined();
    expect(ats.createDraftHire).toBeUndefined();
  });
});

describe('FixtureBandsAdapter', () => {
  it('computes compa_ratio to three decimals', () => {
    expect(compaRatio(200_000, 190_000)).toBe(1.053);
    expect(compaRatio(100, 0)).toBeNull();
  });

  it('places a worker in the band for their level, function and location group', async () => {
    const bands = new FixtureBandsAdapter(bundle);
    const comp = await bands.getWorkerCompensation('w_0024');
    expect(comp.band_id).toBe('band_L5_engineering_US');
    expect(comp.currency).toBe('USD');
    const band = await bands.findBand({
      level_id: 'lvl_L5',
      job_function: 'engineering',
      location_group: 'US',
    });
    expect(band).not.toBeNull();
    expect(comp.compa_ratio).toBe(compaRatio(comp.base_annual ?? 0, band?.mid ?? 0));
    // w_0024 is one of the pinned above-band workers (fixtures/README.md).
    expect(comp.compa_ratio ?? 0).toBeGreaterThan(1);
  });
});

describe('FixtureChannelAdapter', () => {
  it('appends to outbox.jsonl and returns a message ref', async () => {
    const channel = new FixtureChannelAdapter(dataDir, HRBP, anchor);
    const sent = await channel.sendDirect({
      to_worker_id: 'w_0033',
      text: 'Your self review is due Friday.',
      template_id: 'self_review',
    });
    expect(sent.delivered).toBe(true);
    expect(sent.message_ref).toMatch(/^msg_[0-9a-f]{8}$/);

    const posted = await channel.postChannel({
      channel: '#people-ops',
      text: 'H2 cycle summary',
      template_id: 'summary',
    });

    const outbox = readOutbox(dataDir);
    const line = outbox.find((row) => row.message_ref === sent.message_ref);
    expect(line?.actor).toBe(HRBP);
    expect(line?.to_worker_id).toBe('w_0033');
    expect(line?.ts).toBe(ANCHOR_NOW);
    expect(outbox.find((row) => row.message_ref === posted.message_ref)?.channel).toBe(
      '#people-ops',
    );
  });

  it('reads scripted replies as untrusted documents', async () => {
    const replyDir = makeDataDir();
    try {
      writeInbox(replyDir, [
        { thread_ref: 'thr_1', text: 'On it, thanks.', message_ref: 'msg_reply1' },
        { thread_ref: 'thr_2', text: 'Different thread.' },
      ]);
      const channel = new FixtureChannelAdapter(replyDir, HRBP, anchor);
      const replies = await channel.readReplies('thr_1');
      expect(replies).toHaveLength(1);
      expect(replies[0]?.untrusted).toBe(true);
      expect(replies[0]?.source).toBe('slack');
      expect(await channel.readReplies('thr_none')).toEqual([]);
    } finally {
      removeDataDir(replyDir);
    }
  });
});

describe('FixtureStateAdapter', () => {
  const newTask = (
    cycleId: string,
  ): Omit<TlTask, 'id' | 'created_at' | 'updated_at' | 'created_by'> => ({
    cycle_id: cycleId,
    participant_worker_id: 'w_0033',
    kind: 'write_self_review',
    external_ref: null,
    due_at: '2026-09-11T23:59:59Z',
    original_due_at: '2026-09-11T23:59:59Z',
    status: 'pending',
    attempt_n: 0,
  });

  it('assigns tl_<kind>_<8 hex> ids that are unique across 100 creates', async () => {
    const dir = makeDataDir();
    try {
      const state = new FixtureStateAdapter(dir, HRBP, anchor);
      const ids: string[] = [];
      for (let i = 0; i < 100; i += 1) {
        const created = await state.create('task', newTask('tl_cycle_h2_2026'));
        ids.push(created.id);
      }
      expect(new Set(ids).size).toBe(100);
      expect(ids.every((id) => /^tl_task_[0-9a-f]{8}$/.test(id))).toBe(true);
      expect((await state.list('task')).length).toBe(100);
    } finally {
      removeDataDir(dir);
    }
  });

  it('stamps timestamps and the acting identity, and filters on list', async () => {
    const dir = makeDataDir();
    try {
      const state = new FixtureStateAdapter(dir, HRBP, anchor);
      const created = await state.create('task', newTask('tl_cycle_h2_2026'));
      expect(created.created_at).toBe(ANCHOR_NOW);
      expect(created.updated_at).toBe(ANCHOR_NOW);
      expect(created.created_by).toBe(HRBP);

      await state.create('task', { ...newTask('tl_cycle_other'), participant_worker_id: 'w_0009' });
      const mine = await state.list('task', { cycle_id: 'tl_cycle_h2_2026' });
      expect(mine).toHaveLength(1);
      expect(await state.get('task', created.id)).not.toBeNull();
      expect(await state.get('task', 'tl_task_deadbeef')).toBeNull();
    } finally {
      removeDataDir(dir);
    }
  });

  it('refuses an illegal status transition (task pending → closed)', async () => {
    const dir = makeDataDir();
    try {
      const state = new FixtureStateAdapter(dir, HRBP, anchor);
      const task = await state.create('task', newTask('tl_cycle_h2_2026'));
      await expect(state.update('task', task.id, { status: 'closed' as never })).rejects.toThrow(
        LoopStatesError,
      );
      // …and the legal one goes through.
      const nudged = await state.update('task', task.id, { status: 'nudged', attempt_n: 1 });
      expect(nudged.status).toBe('nudged');
      expect((await state.get('task', task.id))?.attempt_n).toBe(1);
    } finally {
      removeDataDir(dir);
    }
  });

  it('refuses unknown ids and any change to id, created_at or created_by', async () => {
    const dir = makeDataDir();
    try {
      const state = new FixtureStateAdapter(dir, HRBP, anchor);
      const task = await state.create('task', newTask('tl_cycle_h2_2026'));
      await expect(state.update('task', 'tl_task_00000000', { attempt_n: 1 })).rejects.toThrow(
        /no task record/,
      );
      for (const patch of [
        { id: 'tl_task_ffffffff' },
        { created_at: '2020-01-01T00:00:00Z' },
        { created_by: 'w_0007' },
      ]) {
        await expect(state.update('task', task.id, patch as never)).rejects.toThrow(/immutable/);
      }
    } finally {
      removeDataDir(dir);
    }
  });

  it('exposes no delete of any kind', () => {
    const state = new FixtureStateAdapter(dataDir, HRBP, anchor);
    const methods = new Set<string>();
    for (const name of Object.getOwnPropertyNames(Object.getPrototypeOf(state))) {
      if (name !== 'constructor') methods.add(name);
    }
    expect([...methods].filter((name) => /delete|remove|destroy|truncate/i.test(name))).toEqual([]);
  });

  it('names `node bin/seed.mjs --reset` when the data dir was never seeded', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'tl-unseeded-'));
    try {
      expect(existsSync(join(empty, 'state'))).toBe(false);
      const state = new FixtureStateAdapter(empty, HRBP, anchor);
      await expect(state.list('task')).rejects.toThrow(RuntimeStateMissingError);
      await expect(state.list('task')).rejects.toThrow(/node bin\/seed\.mjs --reset/);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});
