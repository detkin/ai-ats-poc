/**
 * tests/adapters/runtime.test.ts — `buildRuntime` composes the right actor and ports.
 *
 * Proves: the default acting identity is the fixture HRBP with her Rippling permissions;
 * `TL_ACTOR` switches identity and is reflected in `created_by` and in the ledger; an unknown
 * actor fails loudly; `ports` are wrapped and `raw` are not; and `TL_ADAPTER=rippling` builds
 * the stub family instead.
 *
 * Spec: docs/SPEC.md §9 (runs as a real user); docs/PLAN.md §2.3, §4 block B1.2 (tests).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ActorNotFoundError } from '#lib/adapters/fixture/graph.ts';
import { buildRuntime } from '#lib/adapters/index.ts';
import { RipplingNotConnectedError } from '#lib/adapters/rippling/index.ts';
import type { TlTask } from '#lib/types/engine.ts';
import {
  makeConfig,
  makeDataDir,
  makeRuntime,
  readLedger,
  removeDataDir,
} from '#tests/adapters/helpers.ts';

let dataDir: string;

beforeEach(() => {
  dataDir = makeDataDir();
});

afterEach(() => removeDataDir(dataDir));

const newTask = (): Omit<TlTask, 'id' | 'created_at' | 'updated_at' | 'created_by'> => ({
  cycle_id: 'tl_cycle_h2_2026',
  participant_worker_id: 'w_0033',
  kind: 'write_self_review',
  external_ref: null,
  due_at: '2026-09-11T23:59:59Z',
  original_due_at: '2026-09-11T23:59:59Z',
  status: 'pending',
  attempt_n: 0,
});

describe('buildRuntime — fixture mode', () => {
  it('acts as the default identity, the HRBP, with her permissions', async () => {
    const runtime = makeRuntime(dataDir);
    expect(runtime.actor.worker_id).toBe('w_0021');
    expect(runtime.actor.email).toBe('priya.raghunathan@acme-robotics.example');
    expect(runtime.actor.adapter).toBe('fixture');
    expect(runtime.actor.permissions).toContain('slack.send_as_user');
    expect(runtime.actor.permissions).toContain('custom_objects.write');
    expect((await runtime.ports.graph.lookupMe()).id).toBe('w_0021');
  });

  it('freezes the clock at TL_NOW and exposes policy and states', () => {
    const runtime = makeRuntime(dataDir);
    expect(runtime.now().toISOString()).toBe('2026-09-02T16:00:00.000Z');
    expect(runtime.policy.template).toBe(false);
    expect(runtime.policy.cadence.max_attempts).toBeGreaterThanOrEqual(1);
    expect(Object.keys(runtime.states.machines).sort()).toEqual(['cycle', 'proposal', 'task']);
  });

  it('switches identity with TL_ACTOR, and stamps created_by from it', async () => {
    const runtime = makeRuntime(dataDir, {}, { TL_ACTOR: 'w_0114' });
    expect(runtime.actor.worker_id).toBe('w_0114');
    expect(runtime.actor.permissions).toContain('calendar.hold.write');
    const task = await runtime.ports.state.create('task', newTask());
    expect(task.created_by).toBe('w_0114');
    expect(readLedger(dataDir).at(-1)?.actor.worker_id).toBe('w_0114');
  });

  it('fails loudly when TL_ACTOR names nobody', () => {
    expect(() => buildRuntime(makeConfig(dataDir, { TL_ACTOR: 'w_9999' }))).toThrow(
      ActorNotFoundError,
    );
  });

  it('wraps ports and leaves raw alone', async () => {
    const runtime = makeRuntime(dataDir);
    await runtime.raw.graph.listLevels();
    expect(readLedger(dataDir)).toHaveLength(0);
    await runtime.ports.graph.listLevels();
    expect(readLedger(dataDir)).toHaveLength(1);
  });

  it('loads the tenant bundle once and shares it', () => {
    const runtime = makeRuntime(dataDir);
    expect(runtime.bundle?.workers.length).toBe(120);
  });
});

describe('buildRuntime — rippling mode', () => {
  it('builds stub ports that fail loudly instead of returning fixtures', async () => {
    const runtime = buildRuntime(makeConfig(dataDir, { TL_ADAPTER: 'rippling' }));
    expect(runtime.actor.adapter).toBe('rippling');
    expect(runtime.bundle).toBeUndefined();
    await expect(runtime.raw.graph.lookupMe()).rejects.toThrow(RipplingNotConnectedError);
    await expect(runtime.raw.ats.listRequisitions({})).rejects.toThrow(/QUESTIONS\.md/);
    await expect(
      runtime.raw.channel.sendDirect({ to_worker_id: 'w_1', text: 'x', template_id: 't' }),
    ).rejects.toThrow(/QUESTIONS\.md Q3/);
  });
});
