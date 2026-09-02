/**
 * lib/fixtures/gen/rng.ts — the seeded PRNG the fixture generator runs on.
 *
 * Owns: mulberry32 and the small sampling helpers built on it. Every draw is a pure
 * function of the seed and the order of calls, which is what makes `generateTenant`
 * reproducible byte for byte (docs/DECISIONS.md D8: fixtures must regenerate identically).
 *
 * Public interface: `Rng`, `makeRng`.
 *
 * Spec: docs/SPEC.md §5 (fixture tenant); docs/PLAN.md §2.7, §3 block B0.4.
 */

/** A deterministic source of draws. Consume it in a fixed order or determinism breaks. */
export interface Rng {
  /** Uniform in [0, 1). */
  next(): number;
  /** Uniform integer in [min, max] inclusive. */
  int(min: number, max: number): number;
  /** Uniform element of a non-empty array. */
  pick<T>(items: readonly T[]): T;
  /** Element of `items` chosen by matching `weights` (same length, positive). */
  weighted<T>(items: readonly T[], weights: readonly number[]): T;
  /** True with probability `p`. */
  chance(p: number): boolean;
  /** A copy of `items` in a deterministic shuffled order (Fisher–Yates). */
  shuffle<T>(items: readonly T[]): T[];
}

/**
 * mulberry32 — 32-bit, one multiply-xorshift round per draw. Small, fast, and stable
 * across Node versions, which matters because the committed fixtures are hashed.
 */
export function makeRng(seed: number): Rng {
  let state = seed >>> 0;

  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  const int = (min: number, max: number): number => min + Math.floor(next() * (max - min + 1));

  const pick = <T>(items: readonly T[]): T => {
    if (items.length === 0) throw new Error('rng.pick: empty array');
    const chosen = items[int(0, items.length - 1)];
    if (chosen === undefined) throw new Error('rng.pick: index out of range');
    return chosen;
  };

  const weighted = <T>(items: readonly T[], weights: readonly number[]): T => {
    if (items.length === 0 || items.length !== weights.length) {
      throw new Error('rng.weighted: items and weights must be the same non-zero length');
    }
    const total = weights.reduce((sum, w) => sum + w, 0);
    let roll = next() * total;
    for (let i = 0; i < items.length; i += 1) {
      roll -= weights[i] ?? 0;
      if (roll < 0) {
        const chosen = items[i];
        if (chosen === undefined) throw new Error('rng.weighted: index out of range');
        return chosen;
      }
    }
    const last = items[items.length - 1];
    if (last === undefined) throw new Error('rng.weighted: index out of range');
    return last;
  };

  const chance = (p: number): boolean => next() < p;

  const shuffle = <T>(items: readonly T[]): T[] => {
    const out = items.slice();
    for (let i = out.length - 1; i > 0; i -= 1) {
      const j = int(0, i);
      const a = out[i];
      const b = out[j];
      if (a === undefined || b === undefined) continue;
      out[i] = b;
      out[j] = a;
    }
    return out;
  };

  return { next, int, pick, weighted, chance, shuffle };
}
