/**
 * lib/engine/hash.ts — canonical JSON and sha256, the engine's only "identity" primitives.
 *
 * Owns: the one canonical serialization used for `tl_packet.inputs_hash`,
 * `tl_agent_action.args_hash` and the tick id. Two structurally equal values must produce
 * the same string on every machine and every process, so key order is sorted, `undefined`
 * object properties are dropped, and non-finite numbers are refused rather than silently
 * becoming `null` (the JSON.stringify default).
 *
 * Public interface:
 *   canonicalJson(value: unknown): string
 *   sha256Hex(value: unknown): string      // sha256 over canonicalJson(value)
 *
 * Pure: no I/O, no clock, no environment. `node:crypto` is a computation, not I/O.
 *
 * Spec: docs/SPEC.md §7 (packet refresh when `inputs_hash` changed), §10 (evals);
 * docs/PLAN.md §2.2 (`args_hash` = sha256 hex of canonical JSON).
 */

import { createHash } from 'node:crypto';

/** Thrown when a value cannot be canonicalized (cycles, functions, non-finite numbers). */
export class CanonicalJsonError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CanonicalJsonError';
  }
}

function serialize(value: unknown, seen: Set<object>, path: string): string {
  if (value === null) return 'null';

  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(value)) {
        throw new CanonicalJsonError(`non-finite number at ${path}: ${String(value)}`);
      }
      // -0 and 0 are the same value for hashing purposes.
      return JSON.stringify(value === 0 ? 0 : value);
    case 'string':
      return JSON.stringify(value);
    case 'bigint':
      return JSON.stringify(value.toString());
    case 'undefined':
      throw new CanonicalJsonError(`undefined is not serializable at ${path}`);
    case 'function':
    case 'symbol':
      throw new CanonicalJsonError(`${typeof value} is not serializable at ${path}`);
    default:
      break;
  }

  const obj = value as object;
  if (seen.has(obj)) throw new CanonicalJsonError(`circular reference at ${path}`);
  seen.add(obj);
  try {
    if (Array.isArray(obj)) {
      const items = obj.map((item, i) =>
        item === undefined ? 'null' : serialize(item, seen, `${path}[${i}]`),
      );
      return `[${items.join(',')}]`;
    }
    if (obj instanceof Date) return JSON.stringify(obj.toISOString());
    if (obj instanceof Map) {
      const entries = [...obj.entries()]
        .map(([k, v]) => [String(k), v] as const)
        .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
      const parts = entries
        .filter(([, v]) => v !== undefined)
        .map(([k, v]) => `${JSON.stringify(k)}:${serialize(v, seen, `${path}.${k}`)}`);
      return `{${parts.join(',')}}`;
    }
    if (obj instanceof Set) {
      const items = [...obj].map((item, i) => serialize(item, seen, `${path}[${i}]`)).sort();
      return `[${items.join(',')}]`;
    }

    const record = obj as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    const parts: string[] = [];
    for (const key of keys) {
      const child = record[key];
      if (child === undefined) continue; // omitted, never `null`-ified
      parts.push(`${JSON.stringify(key)}:${serialize(child, seen, `${path}.${key}`)}`);
    }
    return `{${parts.join(',')}}`;
  } finally {
    seen.delete(obj);
  }
}

/**
 * Deterministic JSON: object keys sorted, `undefined` properties dropped, `Map`/`Set`
 * normalized, arrays left in order (order is data). Throws `CanonicalJsonError` on
 * anything JSON cannot represent faithfully.
 */
export function canonicalJson(value: unknown): string {
  return serialize(value, new Set<object>(), '$');
}

/** sha256, lower-case hex, over `canonicalJson(value)`. A plain string hashes as a string. */
export function sha256Hex(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
}
