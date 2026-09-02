/**
 * tests/lock.test.ts — the per-cycle lock (block B1.2).
 *
 * Proves: the first acquire wins and writes `owner.json`; a second acquire throws
 * `LockHeldError` naming the holder; release makes the lock available again; a lock older
 * than `staleMs` is reclaimed and says so; `withLock` releases even when the body throws;
 * and two different cycles never contend.
 *
 * Spec: docs/SPEC.md §5 (lock row), §7; docs/PLAN.md §4 block B1.2 (tests).
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { LockHeldError, acquireLock, locksDirFor, withLock } from '#lib/lock.ts';
import type { LockOwner } from '#lib/lock.ts';
import { makeDataDir, removeDataDir } from '#tests/adapters/helpers.ts';

const CYCLE = 'tl_cycle_h2_2026';
const T0 = new Date('2026-09-02T16:00:00Z');
const T_LATER = new Date('2026-09-02T16:20:00Z');
const TEN_MINUTES = 10 * 60 * 1000;

let dataDir: string;

beforeEach(() => {
  dataDir = makeDataDir();
});

afterEach(() => removeDataDir(dataDir));

describe('acquireLock', () => {
  it('creates the lock directory and records the owner', () => {
    const lock = acquireLock(dataDir, CYCLE, { owner: 'tick_one', now: () => T0 });
    try {
      expect(lock.dir).toBe(join(locksDirFor(dataDir), CYCLE));
      expect(lock.reclaimed).toBe(false);
      const owner = JSON.parse(readFileSync(join(lock.dir, 'owner.json'), 'utf8')) as LockOwner;
      expect(owner.owner).toBe('tick_one');
      expect(owner.pid).toBe(process.pid);
      expect(owner.acquired_at).toBe(T0.toISOString());
    } finally {
      lock.release();
    }
  });

  it('refuses a second acquire and names the holder', () => {
    const first = acquireLock(dataDir, CYCLE, { owner: 'tick_one', now: () => T0 });
    try {
      expect(() =>
        acquireLock(dataDir, CYCLE, { owner: 'tick_two', now: () => T0, staleMs: TEN_MINUTES }),
      ).toThrow(LockHeldError);
      try {
        acquireLock(dataDir, CYCLE, { owner: 'tick_two', now: () => T0, staleMs: TEN_MINUTES });
      } catch (error) {
        expect((error as LockHeldError).holder?.owner).toBe('tick_one');
        expect((error as Error).message).toContain('tick_one');
      }
    } finally {
      first.release();
    }
  });

  it('is available again after release', () => {
    const first = acquireLock(dataDir, CYCLE, { now: () => T0 });
    first.release();
    expect(existsSync(first.dir)).toBe(false);
    const second = acquireLock(dataDir, CYCLE, { now: () => T0 });
    expect(second.reclaimed).toBe(false);
    second.release();
    // Releasing twice is a no-op, not an error.
    expect(() => second.release()).not.toThrow();
  });

  it('reclaims a stale lock and reports the previous holder', () => {
    acquireLock(dataDir, CYCLE, { owner: 'dead_tick', now: () => T0 });
    const reclaimed = acquireLock(dataDir, CYCLE, {
      owner: 'live_tick',
      now: () => T_LATER,
      staleMs: TEN_MINUTES,
    });
    try {
      expect(reclaimed.reclaimed).toBe(true);
      expect(reclaimed.previousOwner?.owner).toBe('dead_tick');
      const owner = JSON.parse(
        readFileSync(join(reclaimed.dir, 'owner.json'), 'utf8'),
      ) as LockOwner;
      expect(owner.owner).toBe('live_tick');
    } finally {
      reclaimed.release();
    }
  });

  it('does not contend across cycles', () => {
    const a = acquireLock(dataDir, 'tl_cycle_a', { now: () => T0 });
    const b = acquireLock(dataDir, 'tl_cycle_b', { now: () => T0 });
    expect(a.dir).not.toBe(b.dir);
    a.release();
    b.release();
  });

  it('refuses a lock id that is not a single safe path segment', () => {
    expect(() => acquireLock(dataDir, '../escape', { now: () => T0 })).toThrow(
      /not a usable lock id/,
    );
    expect(() => acquireLock(dataDir, 'a/b', { now: () => T0 })).toThrow(/not a usable lock id/);
  });
});

describe('withLock', () => {
  it('releases when the body succeeds', async () => {
    const result = await withLock(dataDir, CYCLE, { now: () => T0 }, (lock) => {
      expect(existsSync(lock.dir)).toBe(true);
      return 'done';
    });
    expect(result).toBe('done');
    expect(existsSync(join(locksDirFor(dataDir), CYCLE))).toBe(false);
  });

  it('releases when the body throws', async () => {
    await expect(
      withLock(dataDir, CYCLE, { now: () => T0 }, () => {
        throw new Error('tick blew up');
      }),
    ).rejects.toThrow('tick blew up');
    expect(existsSync(join(locksDirFor(dataDir), CYCLE))).toBe(false);
  });
});
