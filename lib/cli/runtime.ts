/**
 * lib/cli/runtime.ts — building a runtime, and the one place exit codes are decided.
 *
 * Owns:
 *   `openRuntime(options)` — `loadConfig()` + `buildRuntime()` in one call, with the frozen
 *     `now` already rendered as an `InstantISO` and, when the caller names a cycle, a
 *     `cycleIdOf` that stamps that cycle on **every** ledger line of the run (so
 *     `audit.mjs --cycle <id>` sees the reads a tick made, not only the writes).
 *   `openRuntimeForRecord(kind, id)` — the same, for a CLI addressed by record rather than
 *     by cycle: it resolves the record's `cycle_id` through the *unledgered* ports first,
 *     then opens the scoped runtime (docs/DECISIONS.md D19).
 *   `runCli(spec, argv, handler)` — parse, `--help`, run, render, and map every error the
 *     lower layers throw onto the project's exit-code contract:
 *
 *       0  success
 *       1  domain failure — lock held, drift, unknown id, illegal transition, refused write
 *       2  usage or configuration — bad flag, bad `TL_*`, template policy, unseeded state
 *
 *   `CliError` — the domain error `lib/cli/*` raises itself (exit 1).
 *
 * `RuntimeStateMissingError`, `ConfigError` and `PolicyError` all carry their own fix line
 * (`node bin/seed.mjs --reset`, the offending variable, the policy path); the CLI prints the
 * message unchanged rather than inventing a second wording for the same problem.
 *
 * Public interface: `openRuntime`, `openRuntimeForRecord`, `OpenedRuntime`,
 * `OpenRuntimeOptions`, `runCli`, `CliError`, `EXIT`.
 *
 * Spec: docs/SPEC.md §5, §9; docs/PLAN.md §2.9, §4 block B1.3.
 */

import {
  RuntimeStateMissingError,
  buildRuntime,
  defaultCycleIdOf,
  toInstant,
} from '#lib/adapters/index.ts';
import type { Runtime } from '#lib/adapters/index.ts';
import { UsageError, parseArgs, renderHelp } from '#lib/cli/args.ts';
import type { Args, CliSpec } from '#lib/cli/args.ts';
import { writeOutput } from '#lib/cli/output.ts';
import type { CliOutput } from '#lib/cli/output.ts';
import { ConfigError, loadConfig, now as clockNow } from '#lib/config.ts';
import type { Config } from '#lib/config.ts';
import { PolicyError } from '#lib/policy/index.ts';
import { TalentLoopsError } from '#lib/safety/errors.ts';
import type { StateKind, StateRecordMap } from '#lib/types/engine.ts';
import type { InstantISO } from '#lib/types/tier1.ts';

/** The exit-code contract, named. */
export const EXIT = { ok: 0, domain: 1, usage: 2 } as const;

/** A domain failure raised by the CLI layer itself: unknown id, drift, refused close. */
export class CliError extends TalentLoopsError {
  constructor(code: string, message: string) {
    super(code, message);
    this.name = 'CliError';
  }
}

export interface OpenRuntimeOptions {
  /** Correlates every ledger line of this run with a cycle, reads included. */
  cycleId?: string;
  /** Stamped as `tick_id` on every ledger line. `bin/tick.mjs` passes one. */
  tickId?: string;
}

export interface OpenedRuntime {
  rt: Runtime;
  config: Config;
  /** The frozen clock, as the `InstantISO` every record of this run is stamped with. */
  now: InstantISO;
}

/**
 * Build the runtime once per process.
 *
 * ```ts
 * const { rt, config, now } = openRuntime({ cycleId, tickId });
 * await rt.ports.state.list('task', { cycle_id: cycleId });   // ledgered
 * ```
 */
export function openRuntime(options: OpenRuntimeOptions = {}): OpenedRuntime {
  const config = loadConfig();
  const now = toInstant(clockNow(config));
  const cycleId = options.cycleId;
  const rt = buildRuntime(config, {
    ...(options.tickId === undefined ? {} : { tickId: options.tickId }),
    ...(cycleId === undefined
      ? {}
      : { cycleIdOf: (fn: string, args: unknown[]) => defaultCycleIdOf(fn, args) ?? cycleId }),
  });
  return { rt, config, now };
}

/** A `tl_*` record that belongs to a cycle. Every kind a record-addressed CLI opens does. */
interface CycleScoped {
  cycle_id?: string;
}

/**
 * Open a ledgered runtime already scoped to the cycle a record belongs to
 * (docs/DECISIONS.md D19).
 *
 * `decide.mjs --proposal`, `nudge.mjs --task` and `packet.mjs show --packet` are addressed by
 * *record*, not by cycle, so without this their ledger lines carried `cycle_id: null` and
 * `audit.mjs --cycle` could not show the decision of record. The lookup itself goes through
 * `rt.raw`, which appends nothing; only the writes that follow are ledgered, and they carry
 * the cycle.
 *
 * A record the state adapter does not have comes back as `null` with the unscoped runtime,
 * so the caller can raise its own "no X with id …" domain error.
 */
export async function openRuntimeForRecord<K extends StateKind>(
  kind: K,
  id: string,
  options: OpenRuntimeOptions = {},
): Promise<{ opened: OpenedRuntime; record: StateRecordMap[K] | null }> {
  const probe = openRuntime(options);
  const record = await probe.rt.raw.state.get(kind, id);
  const cycleId = (record as CycleScoped | null)?.cycle_id;
  if (record === null || cycleId === undefined) return { opened: probe, record };
  return { opened: openRuntime({ ...options, cycleId }), record };
}

/** Errors that mean "the environment is wrong", not "the domain said no". */
function isConfigProblem(error: unknown): boolean {
  return (
    error instanceof ConfigError ||
    error instanceof PolicyError ||
    error instanceof RuntimeStateMissingError
  );
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Run one CLI end to end. `handler` returns a `CliOutput`; everything else — parsing,
 * `--help`, rendering and exit codes — happens here so `bin/*.mjs` stays three lines.
 *
 * @param usageExit override for the usage exit code (`bin/seed.mjs` predates the contract
 *                  and its tests pin exit 1 for a bad flag).
 */
export async function runCli(
  spec: CliSpec,
  argv: readonly string[],
  handler: (args: Args) => Promise<CliOutput>,
  usageExit: number = EXIT.usage,
): Promise<number> {
  let args: Args;
  try {
    args = parseArgs(argv, spec);
  } catch (error) {
    if (error instanceof UsageError) {
      process.stderr.write(`${error.message}\n\n${renderHelp(spec)}\n`);
      return usageExit;
    }
    throw error;
  }

  if (args.bool('help')) {
    process.stdout.write(`${renderHelp(spec)}\n`);
    return EXIT.ok;
  }

  try {
    const output = await handler(args);
    return writeOutput(output, args.bool('json'));
  } catch (error) {
    if (error instanceof UsageError) {
      process.stderr.write(`${error.message}\n\n${renderHelp(spec)}\n`);
      return usageExit;
    }
    if (isConfigProblem(error)) {
      process.stderr.write(`${spec.name}: ${messageOf(error)}\n`);
      return EXIT.usage;
    }
    if (error instanceof TalentLoopsError || error instanceof Error) {
      process.stderr.write(`${spec.name}: ${messageOf(error)}\n`);
      if (!(error instanceof TalentLoopsError) && process.env.TL_DEBUG !== undefined) {
        process.stderr.write(`${error instanceof Error ? error.stack : ''}\n`);
      }
      return EXIT.domain;
    }
    throw error;
  }
}
