/**
 * lib/adapters/ledgered.ts — every port call, on the record.
 *
 * Owns: `ledgered(portName, port, ctx)`, a `Proxy` that wraps any port implementation so
 * that spec §7 step 5 ("every port call is ledgered") and spec §9 ("the write allowlist is
 * enforced in the adapter, not the prompt") are properties of the runtime rather than of a
 * caller's good behaviour. For every method call it:
 *
 *  1. decides whether the call is a *write* — declared in `PORT_WRITE_FUNCTIONS`, or named
 *     with a write verb (so a method nobody allowlisted, `channel.deleteMessage`, is caught
 *     rather than waved through as an unknown read);
 *  2. for a write, calls `assertWriteAllowed(port, fn, target)` **before** the port sees it —
 *     `target` is the `tl_*` object for `state`, the function name elsewhere. A rejection is
 *     appended as `result: 'rejected'` and `WriteNotAllowedError` is rethrown;
 *  3. runs the call, appending `result: 'ok'` (with `result_ref` when something was created)
 *     or `result: 'error'` and rethrowing.
 *
 * Reads are ledgered too, with a compact `args_summary`. `args_hash` is the sha256 of the
 * canonical JSON of the arguments; `args_summary` is ≤ 120 characters and carries ids only —
 * never a résumé, a review body, a message text or a name (spec §9, §10).
 *
 * The ledger is never ledgered: `ledgered('ledger', …)` returns the port untouched, and
 * `ledger.append` is deliberately absent from the allowlist — the wrapper appends
 * unconditionally, including for the writes it just rejected.
 *
 * Public interface: `ledgered`, `LedgerContext`, `canonicalJson`, `hashArgs`,
 * `summarizeArgs`, `defaultCycleIdOf`, `MAX_ARGS_SUMMARY_CHARS`.
 *
 * Spec: docs/SPEC.md §7 step 5, §9, §10; docs/PLAN.md §2.3, §2.4, §4 block B1.2.
 */

import { createHash } from 'node:crypto';

import { toInstant } from '#lib/adapters/fixture/ledger.ts';
import type { ActorContext } from '#lib/ports/context.ts';
import type { LedgerPort } from '#lib/ports/ledger.ts';
import { PORT_WRITE_FUNCTIONS, assertWriteAllowed } from '#lib/safety/allowlist.ts';
import { STATE_KINDS } from '#lib/types/engine.ts';
import type { NewLedgerEntry, TlLedgerResult } from '#lib/types/engine.ts';

/** `args_summary` is a breadcrumb, not a payload. */
export const MAX_ARGS_SUMMARY_CHARS = 120;

/**
 * Method names that mutate something even though no allowlist entry claims them. A call
 * matching this is treated as a write and therefore rejected unless allowlisted — the safe
 * direction: an unknown verb never silently writes.
 */
const WRITE_VERB =
  /^(?:create|update|upsert|delete|destroy|remove|drop|send|post|publish|place|book|schedule|cancel|set|put|patch|write|add|append|archive|advance|reject|approve|decline|assign|move|close|open|hire|offer)/i;

/** Keys whose values are human text or PII and are never summarized verbatim. */
const REDACTED_KEYS = new Set([
  'text',
  'body',
  'body_md',
  'excerpt',
  'rationale',
  'explanation',
  'note',
  'decision_note',
  'name',
  'first_name',
  'last_name',
  'preferred_name',
  'title',
  'email',
  'work_email',
  'reason',
  'criteria',
  'resume_ref',
]);

/** Values that read as identifiers rather than prose. */
const ID_LIKE = /^[A-Za-z0-9_@.#/:+-]{1,48}$/;

export interface LedgerContext {
  /** Who the call is made as; copied into `actor` and `permission_context`. */
  actor: ActorContext;
  /** Where entries go. Never itself wrapped. */
  ledger: LedgerPort;
  /** The (frozen) clock. */
  now: () => Date;
  /** Correlates every entry written by one `bin/tick.mjs` run. */
  tickId?: string;
  /** Resolves the cycle a call belongs to; defaults to `defaultCycleIdOf`. */
  cycleIdOf?: (fn: string, args: unknown[]) => string | null;
}

/** JSON with object keys sorted at every level, so the hash is stable across key order. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) out[key] = canonicalize(source[key]);
    return out;
  }
  return value;
}

/** sha256 hex of the canonical JSON of the argument list. */
export function hashArgs(args: unknown[]): string {
  return createHash('sha256').update(canonicalJson(args)).digest('hex');
}

function summarizeValue(value: unknown, depth: number): string {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (typeof value === 'string') {
    return ID_LIKE.test(value) ? value : `<text:${value.length}>`;
  }
  if (Array.isArray(value)) {
    if (depth <= 0) return `[${value.length}]`;
    const head = value.slice(0, 3).map((item) => summarizeValue(item, depth - 1));
    return `[${head.join(',')}${value.length > 3 ? ',…' : ''}]`;
  }
  if (typeof value === 'object') {
    if (depth <= 0) return '{…}';
    const source = value as Record<string, unknown>;
    const parts: string[] = [];
    for (const key of Object.keys(source).slice(0, 6)) {
      const raw = source[key];
      if (REDACTED_KEYS.has(key)) {
        const length = typeof raw === 'string' ? raw.length : 0;
        parts.push(`${key}:<redacted:${length}>`);
        continue;
      }
      parts.push(`${key}:${summarizeValue(raw, depth - 1)}`);
    }
    return `{${parts.join(',')}}`;
  }
  return typeof value;
}

/**
 * A short, PII-free rendering of the arguments: ids, numbers and booleans survive; anything
 * that looks like prose becomes `<text:n>`, and known body/PII keys become `<redacted:n>`.
 */
export function summarizeArgs(args: unknown[]): string {
  const rendered = args.map((arg) => summarizeValue(arg, 2)).join(' ');
  return rendered.length <= MAX_ARGS_SUMMARY_CHARS
    ? rendered
    : `${rendered.slice(0, MAX_ARGS_SUMMARY_CHARS - 1)}…`;
}

/**
 * Best-effort cycle correlation: an explicit `cycle_id` on an argument object, a `tl_cycle_…`
 * id anywhere in the arguments, or `state.get('cycle', id)`.
 */
export function defaultCycleIdOf(fn: string, args: unknown[]): string | null {
  const first = args[0];
  if (fn === 'get' && first === 'cycle' && typeof args[1] === 'string') return args[1];
  for (const arg of args) {
    if (typeof arg === 'string' && arg.startsWith('tl_cycle_')) return arg;
    if (arg !== null && typeof arg === 'object') {
      const candidate = (arg as Record<string, unknown>).cycle_id;
      if (typeof candidate === 'string') return candidate;
    }
  }
  return null;
}

/** True when this call must clear the write allowlist before it runs. */
function isWriteCall(portName: string, fn: string): boolean {
  const declared: readonly string[] | undefined = Object.prototype.hasOwnProperty.call(
    PORT_WRITE_FUNCTIONS,
    portName,
  )
    ? PORT_WRITE_FUNCTIONS[portName as keyof typeof PORT_WRITE_FUNCTIONS]
    : undefined;
  if (declared !== undefined && declared.includes(fn)) return true;
  return WRITE_VERB.test(fn);
}

/**
 * What the write is *aimed at*. For `state` that is the `tl_*` object named by the `kind`
 * argument — and an unrecognised kind is passed through unprefixed, so `state.create('worker')`
 * is measured against `worker` and rejected rather than smuggled in as `tl_worker`.
 */
function writeTarget(portName: string, fn: string, args: unknown[]): string {
  if (portName !== 'state') return fn;
  const kind = args[0];
  if (typeof kind !== 'string') return String(kind);
  return (STATE_KINDS as readonly string[]).includes(kind) ? `tl_${kind}` : kind;
}

/** The id a call created, when it created something. */
function resultRefOf(value: unknown): string | undefined {
  if (value === null || typeof value !== 'object') return undefined;
  const source = value as Record<string, unknown>;
  for (const key of ['id', 'message_ref', 'hold_ref', 'draft_hire_ref']) {
    const candidate = source[key];
    if (typeof candidate === 'string' && candidate.length > 0) return candidate;
  }
  return undefined;
}

/**
 * Wrap a port so every call is checked and recorded. The returned object satisfies the same
 * interface; each method becomes async (they already were).
 */
export function ledgered<P extends object>(portName: string, port: P, ctx: LedgerContext): P {
  if (portName === 'ledger') return port;
  const cycleIdOf = ctx.cycleIdOf ?? defaultCycleIdOf;

  return new Proxy(port, {
    get(target, property) {
      const value = Reflect.get(target, property) as unknown;
      if (typeof property === 'symbol' || typeof value !== 'function') return value;
      const fn = property;
      const call = value as (...args: unknown[]) => unknown;

      return async (...args: unknown[]): Promise<unknown> => {
        const base = {
          cycle_id: cycleIdOf(fn, args),
          actor: {
            worker_id: ctx.actor.worker_id,
            email: ctx.actor.email,
            adapter: ctx.actor.adapter,
          },
          port: portName,
          function: fn,
          args_hash: hashArgs(args),
          args_summary: summarizeArgs(args),
          permission_context: [...ctx.actor.permissions],
          ...(ctx.tickId === undefined ? {} : { tick_id: ctx.tickId }),
        };

        const write = async (result: TlLedgerResult, resultRef?: string): Promise<void> => {
          const entry: NewLedgerEntry = {
            ...base,
            ts: toInstant(ctx.now()),
            result,
            ...(resultRef === undefined ? {} : { result_ref: resultRef }),
          };
          await ctx.ledger.append(entry);
        };

        if (isWriteCall(portName, fn)) {
          try {
            assertWriteAllowed(portName, fn, writeTarget(portName, fn, args));
          } catch (rejection) {
            await write('rejected');
            throw rejection;
          }
        }

        let outcome: unknown;
        try {
          outcome = await call.apply(target, args);
        } catch (failure) {
          try {
            await write('error');
          } catch {
            // A ledger failure must not mask the failure being recorded.
          }
          throw failure;
        }

        const ref = resultRefOf(outcome);
        await write('ok', ref);
        return outcome;
      };
    },
  });
}
