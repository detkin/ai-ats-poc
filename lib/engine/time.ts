/**
 * lib/engine/time.ts — UTC date arithmetic for the engine (block B1.1, a split of plan.ts).
 *
 * Owns: every date computation the tick makes. There is no clock here: `now` always arrives
 * as an argument (docs/DECISIONS.md D8, frozen clock). All arithmetic is UTC; the engine
 * never reasons in a local timezone, because quiet hours are answered by the Availability
 * port, not computed here (spec §4).
 *
 * Public interface:
 *   parseInstant(iso)            -> epoch ms (throws EngineTimeError on garbage)
 *   dateOf(instant)              -> 'YYYY-MM-DD'
 *   endOfDay(dateISO)            -> 'YYYY-MM-DDT23:59:59Z'
 *   addDays(dateISO, n)          -> 'YYYY-MM-DD'
 *   dueAtAfter(openedAt, days)   -> end of the day `days` after the opened-at date
 *   daysBetween(fromISO, toISO)  -> fractional days (to − from)
 *   fullDaysBetween(fromISO, to) -> floor of the above, may be negative
 *
 * Spec: docs/SPEC.md §7 (due dates, overdue); docs/PLAN.md §2.6 (stagger days, absence move).
 */

import type { DateISO, InstantISO } from '#lib/types/tier1.ts';

export const MS_PER_DAY = 86_400_000;

/** The only error this module throws. */
export class EngineTimeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EngineTimeError';
  }
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Epoch milliseconds for an ISO instant or date. */
export function parseInstant(iso: string): number {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) throw new EngineTimeError(`not an ISO instant: ${JSON.stringify(iso)}`);
  return ms;
}

/** The UTC calendar date of an instant (or the date itself, if already one). */
export function dateOf(instant: string): DateISO {
  if (DATE_RE.test(instant)) return instant;
  return new Date(parseInstant(instant)).toISOString().slice(0, 10);
}

/** Last second of a UTC day — the shape every engine-set `due_at` takes. */
export function endOfDay(dateISO: string): InstantISO {
  return `${dateOf(dateISO)}T23:59:59Z`;
}

/** Add whole days to a calendar date, in UTC. `n` may be negative. */
export function addDays(dateISO: string, n: number): DateISO {
  if (!Number.isInteger(n)) throw new EngineTimeError(`addDays needs an integer, got ${n}`);
  const base = Date.parse(`${dateOf(dateISO)}T00:00:00Z`);
  return new Date(base + n * MS_PER_DAY).toISOString().slice(0, 10);
}

/** `openedAt` + `days`, at 23:59:59Z — how review-cycle stagger becomes a `due_at`. */
export function dueAtAfter(openedAt: string, days: number): InstantISO {
  return endOfDay(addDays(dateOf(openedAt), days));
}

/** Fractional days from `fromISO` to `toISO`; negative when `toISO` is earlier. */
export function daysBetween(fromISO: string, toISO: string): number {
  return (parseInstant(toISO) - parseInstant(fromISO)) / MS_PER_DAY;
}

/** Whole days elapsed, floored. `fullDaysBetween(due, now)` is "days overdue". */
export function fullDaysBetween(fromISO: string, toISO: string): number {
  return Math.floor(daysBetween(fromISO, toISO));
}

/** Hours elapsed from `fromISO` to `toISO`. */
export function hoursBetween(fromISO: string, toISO: string): number {
  return (parseInstant(toISO) - parseInstant(fromISO)) / 3_600_000;
}
