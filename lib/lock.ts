/**
 * lib/lock.ts — the per-cycle advisory lock (block B1.2).
 *
 * Owns: `acquireLock` / `withLock`. A tick holds a lock on its cycle so a scheduled run and a
 * manual run cannot double-nudge the same person (spec §5, "directory-mkdir lock with
 * owner.json + stale reclaim"). The idiom is deliberately boring and dependency-free:
 *
 *   `mkdir TL_DATA_DIR/locks/<cycle_id>` is atomic on every filesystem this POC runs on, so
 *   whoever creates the directory owns the lock. `owner.json` inside it records `{ pid, owner,
 *   acquired_at }` so a held lock can say *who* holds it, and a lock older than `staleMs`
 *   (`TL_LOCK_STALE_MS`, default 10 minutes) is reclaimed rather than blocking forever — a
 *   killed tick must not wedge the cycle.
 *
 * Public interface: `acquireLock`, `withLock`, `LockHandle`, `LockOwner`, `LockOptions`,
 * `LockHeldError`, `locksDirFor`, `LOCKS_DIRNAME`, `OWNER_FILENAME`.
 *
 * Rippling backing: none — this is process coordination, not tenant data.
 *
 * Spec: docs/SPEC.md §5 (lock row), §7 (tick runs under a per-cycle lock);
 * docs/PLAN.md §2.8, §4 block B1.2.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';

import { TalentLoopsError } from '#lib/safety/errors.ts';

/** Lock directory, relative to `TL_DATA_DIR`. */
export const LOCKS_DIRNAME = 'locks';
/** The owner record inside a lock directory. */
export const OWNER_FILENAME = 'owner.json';
/** Used when the caller names no owner. */
const DEFAULT_STALE_MS = 10 * 60 * 1000;

/** Who holds a lock. Written as `owner.json`; read back to name a holder in an error. */
export interface LockOwner {
  pid: number;
  /** Free-form holder label, e.g. `tick@host` or a tick id. */
  owner: string;
  acquired_at: string;
}

export interface LockOptions {
  /** A lock older than this is reclaimable. Defaults to 10 minutes (`TL_LOCK_STALE_MS`). */
  staleMs?: number;
  /** Holder label recorded in `owner.json`. Defaults to `tl@<host>:<pid>`. */
  owner?: string;
  /** Clock, so a frozen-clock run records the frozen instant. */
  now?: () => Date;
}

export interface LockHandle {
  readonly cycleId: string;
  /** The lock directory itself. */
  readonly dir: string;
  readonly owner: LockOwner;
  /** True when this acquisition took over a stale lock instead of creating a fresh one. */
  readonly reclaimed: boolean;
  /** Previous holder, when `reclaimed` is true. */
  readonly previousOwner?: LockOwner;
  /** Idempotent: releasing an already-released lock is a no-op. */
  release(): void;
}

/** Another process holds the lock and it is not stale. */
export class LockHeldError extends TalentLoopsError {
  readonly cycle_id: string;
  readonly holder: LockOwner | null;

  constructor(cycleId: string, dir: string, holder: LockOwner | null, ageMs: number) {
    const who =
      holder === null
        ? 'an unknown holder'
        : `${holder.owner} (pid ${holder.pid}, since ${holder.acquired_at})`;
    super(
      'LOCK_HELD',
      `cycle "${cycleId}" is locked by ${who}, ${Math.round(ageMs / 1000)}s old. ` +
        `Wait for that tick to finish, or remove ${dir} if you are certain it died.`,
    );
    this.name = 'LockHeldError';
    this.cycle_id = cycleId;
    this.holder = holder;
  }
}

/** `TL_DATA_DIR/locks`. */
export function locksDirFor(dataDir: string): string {
  return join(dataDir, LOCKS_DIRNAME);
}

/** A cycle id has to be a single safe path segment — it names a directory. */
function assertSafeCycleId(cycleId: string): void {
  if (typeof cycleId !== 'string' || cycleId.length === 0 || !/^[A-Za-z0-9_.-]+$/.test(cycleId)) {
    throw new TalentLoopsError(
      'BAD_LOCK_ID',
      `"${cycleId}" is not a usable lock id (letters, digits, _ . - only)`,
    );
  }
}

function readOwner(path: string): LockOwner | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (parsed !== null && typeof parsed === 'object') return parsed as LockOwner;
  } catch {
    // An unreadable owner file means an unknown holder, not a crash.
  }
  return null;
}

/** Age of a held lock: from `owner.json`'s `acquired_at`, else the directory's mtime. */
function lockAgeMs(dir: string, ownerPath: string, owner: LockOwner | null, nowMs: number): number {
  if (owner !== null && typeof owner.acquired_at === 'string') {
    const acquired = Date.parse(owner.acquired_at);
    if (!Number.isNaN(acquired)) return nowMs - acquired;
  }
  try {
    return nowMs - statSync(existsSync(ownerPath) ? ownerPath : dir).mtimeMs;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

/**
 * Take the lock on `cycleId`, or throw `LockHeldError`.
 *
 * ```ts
 * const lock = acquireLock(config.dataDir, cycleId, { staleMs: config.lockStaleMs });
 * try { … } finally { lock.release(); }
 * ```
 */
export function acquireLock(
  dataDir: string,
  cycleId: string,
  options: LockOptions = {},
): LockHandle {
  assertSafeCycleId(cycleId);
  const now = options.now ?? ((): Date => new Date());
  const staleMs = options.staleMs ?? DEFAULT_STALE_MS;
  const dir = join(locksDirFor(dataDir), cycleId);
  const ownerPath = join(dir, OWNER_FILENAME);
  const owner: LockOwner = {
    pid: process.pid,
    owner: options.owner ?? `tl@${hostname()}:${process.pid}`,
    acquired_at: now().toISOString(),
  };

  let reclaimed = false;
  let previous: LockOwner | null = null;

  try {
    mkdirSync(dir, { recursive: false });
  } catch (cause) {
    const code = (cause as NodeJS.ErrnoException).code;
    if (code !== 'EEXIST') {
      // The parent may simply not exist yet; create it and retry once.
      if (code === 'ENOENT') {
        mkdirSync(locksDirFor(dataDir), { recursive: true });
        return acquireLock(dataDir, cycleId, options);
      }
      throw cause;
    }
    previous = readOwner(ownerPath);
    const age = lockAgeMs(dir, ownerPath, previous, now().getTime());
    if (age < staleMs) throw new LockHeldError(cycleId, dir, previous, age);
    reclaimed = true;
  }

  writeFileSync(ownerPath, `${JSON.stringify(owner, null, 2)}\n`, 'utf8');

  let released = false;
  return {
    cycleId,
    dir,
    owner,
    reclaimed,
    ...(previous === null ? {} : { previousOwner: previous }),
    release(): void {
      if (released) return;
      released = true;
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Run `fn` under the cycle lock, releasing it whatever happens. */
export async function withLock<T>(
  dataDir: string,
  cycleId: string,
  options: LockOptions,
  fn: (lock: LockHandle) => T | Promise<T>,
): Promise<T> {
  const lock = acquireLock(dataDir, cycleId, options);
  try {
    return await fn(lock);
  } finally {
    lock.release();
  }
}
