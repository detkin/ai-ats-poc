/**
 * lib/fixtures/gen/dates.ts — UTC-only date arithmetic for the fixture generator.
 *
 * Owns: conversion between `YYYY-MM-DD` and a day number, plus the two formatters the
 * generator uses. Everything is UTC so generated fixtures do not depend on the machine's
 * timezone — a byte-identical regeneration is the whole point (docs/DECISIONS.md D8).
 *
 * Public interface: `toDayNumber`, `fromDayNumber`, `addDays`, `instantAt`, `daysBetween`,
 * `isWeekend`, `overlapsDate`.
 *
 * Spec: docs/PLAN.md §0 (fixture anchor time).
 */

import type { DateISO, InstantISO } from '#lib/types/tier1.ts';

const MS_PER_DAY = 86_400_000;

/** Days since the Unix epoch for a `YYYY-MM-DD` date. */
export function toDayNumber(date: DateISO): number {
  const ms = Date.parse(`${date}T00:00:00Z`);
  if (Number.isNaN(ms)) throw new Error(`Not a YYYY-MM-DD date: ${date}`);
  return Math.round(ms / MS_PER_DAY);
}

/** Inverse of `toDayNumber`. */
export function fromDayNumber(day: number): DateISO {
  const iso = new Date(day * MS_PER_DAY).toISOString();
  return iso.slice(0, 10);
}

export function addDays(date: DateISO, days: number): DateISO {
  return fromDayNumber(toDayNumber(date) + days);
}

export function daysBetween(from: DateISO, to: DateISO): number {
  return toDayNumber(to) - toDayNumber(from);
}

/** `YYYY-MM-DDTHH:MM:SSZ` at the given UTC hour on `date`. */
export function instantAt(date: DateISO, hour: number, minute = 0): InstantISO {
  const hh = String(hour).padStart(2, '0');
  const mm = String(minute).padStart(2, '0');
  return `${date}T${hh}:${mm}:00Z`;
}

/** Saturday or Sunday in UTC. */
export function isWeekend(date: DateISO): boolean {
  const day = new Date(`${date}T00:00:00Z`).getUTCDay();
  return day === 0 || day === 6;
}

/** True when `date` falls inside `[start, end]` (both inclusive). */
export function overlapsDate(start: DateISO, end: DateISO, date: DateISO): boolean {
  return start <= date && date <= end;
}
