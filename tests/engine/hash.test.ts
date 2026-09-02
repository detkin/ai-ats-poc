/**
 * Canonical JSON and sha256 (block B1.1, `lib/engine/hash.ts`).
 *
 * The point of these tests: two structurally equal inputs must hash the same, and two
 * different ones must not — everything downstream (`inputs_hash`, `args_hash`, `tick_id`)
 * rests on that.
 */

import { describe, expect, it } from 'vitest';
import { canonicalJson, CanonicalJsonError, sha256Hex } from '#lib/engine/hash.ts';

describe('canonicalJson', () => {
  it('sorts object keys at every depth', () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}');
  });

  it('is insensitive to key insertion order but sensitive to array order', () => {
    expect(canonicalJson({ a: 1, b: 2 })).toBe(canonicalJson({ b: 2, a: 1 }));
    expect(canonicalJson([1, 2])).not.toBe(canonicalJson([2, 1]));
  });

  it('omits undefined properties rather than nulling them', () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}');
    expect(canonicalJson({ a: 1 })).toBe(canonicalJson({ a: 1, b: undefined }));
    expect(canonicalJson({ a: null })).toBe('{"a":null}');
  });

  it('normalizes Map and Set, and serializes Date as an instant', () => {
    expect(
      canonicalJson(
        new Map([
          ['b', 1],
          ['a', 2],
        ]),
      ),
    ).toBe('{"a":2,"b":1}');
    expect(canonicalJson(new Set(['b', 'a']))).toBe('["a","b"]');
    expect(canonicalJson(new Date('2026-09-03T16:00:00Z'))).toBe('"2026-09-03T16:00:00.000Z"');
  });

  it('refuses values JSON cannot represent faithfully', () => {
    expect(() => canonicalJson({ n: Number.NaN })).toThrow(CanonicalJsonError);
    expect(() => canonicalJson({ f: () => 1 })).toThrow(CanonicalJsonError);
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => canonicalJson(cyclic)).toThrow(/circular/);
  });

  it('treats -0 and 0 as one value', () => {
    expect(canonicalJson(-0)).toBe(canonicalJson(0));
  });
});

describe('sha256Hex', () => {
  it('is stable and 64 lower-case hex characters', () => {
    const hash = sha256Hex({ b: 1, a: 2 });
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(sha256Hex({ a: 2, b: 1 })).toBe(hash);
  });

  it('hashes the canonical string, pinned so a serialization change is caught', () => {
    // sha256 of `"abc"` — the JSON string, quotes included, which is what canonicalJson emits.
    expect(sha256Hex('abc')).toBe(
      '6cc43f858fbb763301637b5af970e2a46b46f461f27e5a0f41e009c59b827b25',
    );
    expect(sha256Hex('abc')).not.toBe(sha256Hex('abcd'));
  });

  it('separates structurally different values', () => {
    expect(sha256Hex({ a: [1] })).not.toBe(sha256Hex({ a: [1, 1] }));
    expect(sha256Hex([{ a: 1 }])).not.toBe(sha256Hex({ '0': { a: 1 } }));
  });
});
