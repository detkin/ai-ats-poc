/**
 * lib/states/loop-states.ts — the states contract (spec §7, plan §2.5).
 *
 * Owns: reading and validating `templates/loop-states.yml`, the single source of
 * truth for the `cycle`, `task` and `proposal` state machines. No other module may
 * hard-code a state name or a transition; scripts reject non-canonical states here.
 *
 * Public interface:
 *   loadLoopStates(path?)                         -> LoopStates
 *   canonicalState(machine, input, states?)       -> string
 *   isTerminal(machine, state, states?)           -> boolean
 *   assertTransition(machine, from, to, states?)  -> void
 *   listStates(machine, states?)                  -> readonly string[]
 *   LoopStatesError, MACHINE_NAMES
 *   types: MachineName, LoopStates, LoopMachine, LoopStateDef
 *
 * Every function throws `LoopStatesError` (and nothing else) on bad input. When
 * `states` is omitted the default contract is loaded from the repo root — resolved
 * from `import.meta.url`, never from the cwd — and cached for the process.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

export const MACHINE_NAMES = ['cycle', 'task', 'proposal'] as const;

export type MachineName = (typeof MACHINE_NAMES)[number];

/** One state in a machine. `next` is empty exactly when the state is terminal. */
export interface LoopStateDef {
  readonly name: string;
  readonly aliases: readonly string[];
  readonly next: readonly string[];
  readonly terminal: boolean;
  /** tl_* field incremented when the state is re-entered (task `nudged` → attempt_n). */
  readonly counter?: string;
}

export interface LoopMachine {
  readonly initial: string;
  readonly states: Readonly<Record<string, LoopStateDef>>;
}

export interface LoopStates {
  readonly version: number;
  readonly source: string;
  readonly machines: Readonly<Record<MachineName, LoopMachine>>;
}

/** The only error this module throws. */
export class LoopStatesError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LoopStatesError';
  }
}

const SUPPORTED_VERSION = 1;
const RELATIVE_CONTRACT_PATH = 'templates/loop-states.yml';

let cachedDefault: LoopStates | undefined;

/** Repo root = nearest ancestor of this module that holds a package.json. */
function repoRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 10; i += 1) {
    if (existsSync(resolve(dir, 'package.json'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // lib/states/loop-states.ts → two levels up is the repo root.
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
}

export function defaultLoopStatesPath(): string {
  return resolve(repoRoot(), RELATIVE_CONTRACT_PATH);
}

/**
 * Fold a state or alias into its comparison form: trimmed, lower-cased, with
 * runs of whitespace or hyphens collapsed to a single underscore.
 */
function normalizeToken(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asStringArray(value: unknown, label: string, issues: string[]): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    issues.push(`${label}: expected a list of strings`);
    return [];
  }
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string' || item.trim() === '') {
      issues.push(`${label}: expected a list of non-empty strings, got ${JSON.stringify(item)}`);
      continue;
    }
    out.push(item.trim());
  }
  return out;
}

function fail(source: string, issues: readonly string[]): never {
  throw new LoopStatesError(
    `invalid loop-states contract (${source}):\n  - ${issues.join('\n  - ')}`,
  );
}

/** Parse one machine block. Structural problems are pushed onto `issues`. */
function parseMachine(name: string, raw: unknown, issues: string[]): LoopMachine {
  if (!isRecord(raw)) {
    issues.push(`machine "${name}": expected a mapping`);
    return { initial: '', states: {} };
  }
  const rawStates = raw.states;
  if (!isRecord(rawStates)) {
    issues.push(`machine "${name}": missing "states" mapping`);
    return { initial: '', states: {} };
  }

  const states: Record<string, LoopStateDef> = {};
  for (const [stateName, rawState] of Object.entries(rawStates)) {
    const label = `machine "${name}" state "${stateName}"`;
    if (normalizeToken(stateName) !== stateName) {
      issues.push(`${label}: state names must be lower_snake_case`);
    }
    if (!isRecord(rawState)) {
      issues.push(`${label}: expected a mapping`);
      continue;
    }
    const terminal = rawState.terminal === true;
    if (rawState.terminal !== undefined && typeof rawState.terminal !== 'boolean') {
      issues.push(`${label}: "terminal" must be a boolean`);
    }
    const counter = rawState.counter;
    if (counter !== undefined && (typeof counter !== 'string' || counter.trim() === '')) {
      issues.push(`${label}: "counter" must be a non-empty string`);
    }
    const def: LoopStateDef =
      typeof counter === 'string' && counter.trim() !== ''
        ? {
            name: stateName,
            aliases: asStringArray(rawState.aliases, `${label} aliases`, issues),
            next: asStringArray(rawState.next, `${label} next`, issues),
            terminal,
            counter: counter.trim(),
          }
        : {
            name: stateName,
            aliases: asStringArray(rawState.aliases, `${label} aliases`, issues),
            next: asStringArray(rawState.next, `${label} next`, issues),
            terminal,
          };
    states[stateName] = def;
  }

  const initial = typeof raw.initial === 'string' ? raw.initial.trim() : '';
  if (initial === '') issues.push(`machine "${name}": missing "initial" state`);

  return { initial, states };
}

/** Cross-checks that only make sense once a whole machine is parsed. */
function validateMachine(name: string, machine: LoopMachine, issues: string[]): void {
  const stateNames = Object.keys(machine.states);
  if (stateNames.length === 0) {
    issues.push(`machine "${name}": has no states`);
    return;
  }
  if (machine.initial !== '' && machine.states[machine.initial] === undefined) {
    issues.push(`machine "${name}": initial state "${machine.initial}" is not a declared state`);
  }

  const seenTokens = new Map<string, string>();
  for (const stateName of stateNames) {
    const token = normalizeToken(stateName);
    const owner = seenTokens.get(token);
    if (owner !== undefined) {
      issues.push(`machine "${name}": state "${stateName}" duplicates "${owner}"`);
    }
    seenTokens.set(token, stateName);
  }

  for (const state of Object.values(machine.states)) {
    const label = `machine "${name}" state "${state.name}"`;
    for (const target of state.next) {
      if (machine.states[target] === undefined) {
        issues.push(`${label}: next target "${target}" is not a declared state`);
      }
    }
    if (state.terminal && state.next.length > 0) {
      issues.push(`${label}: terminal states must have no "next" (found ${state.next.join(', ')})`);
    }
    if (!state.terminal && state.next.length === 0) {
      issues.push(`${label}: non-terminal states need at least one "next" target`);
    }
    for (const alias of state.aliases) {
      const token = normalizeToken(alias);
      const owner = seenTokens.get(token);
      if (owner !== undefined) {
        issues.push(`${label}: alias "${alias}" collides with "${owner}"`);
        continue;
      }
      seenTokens.set(token, `${state.name} (alias ${alias})`);
    }
  }
}

/**
 * Read, parse and validate a loop-states contract.
 * @param path contract file; defaults to `<repo root>/templates/loop-states.yml`.
 */
export function loadLoopStates(path?: string): LoopStates {
  const source = path === undefined ? defaultLoopStatesPath() : resolve(path);

  let text: string;
  try {
    text = readFileSync(source, 'utf8');
  } catch (cause) {
    throw new LoopStatesError(
      `cannot read loop-states contract at ${source}: ${(cause as Error).message}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(text);
  } catch (cause) {
    throw new LoopStatesError(`cannot parse YAML at ${source}: ${(cause as Error).message}`);
  }

  const issues: string[] = [];
  if (!isRecord(parsed)) fail(source, ['expected a top-level mapping']);

  const version = parsed.version;
  if (typeof version !== 'number' || !Number.isInteger(version)) {
    issues.push('missing integer "version" key');
  } else if (version !== SUPPORTED_VERSION) {
    issues.push(`unsupported contract version ${version} (expected ${SUPPORTED_VERSION})`);
  }

  const rawMachines = parsed.machines;
  if (!isRecord(rawMachines)) {
    issues.push('missing "machines" mapping');
    fail(source, issues);
  }

  for (const key of Object.keys(rawMachines)) {
    if (!(MACHINE_NAMES as readonly string[]).includes(key)) {
      issues.push(`unknown machine "${key}" (expected ${MACHINE_NAMES.join(', ')})`);
    }
  }

  const machines: Record<string, LoopMachine> = {};
  for (const name of MACHINE_NAMES) {
    const raw = rawMachines[name];
    if (raw === undefined) {
      issues.push(`missing machine "${name}"`);
      continue;
    }
    const machine = parseMachine(name, raw, issues);
    validateMachine(name, machine, issues);
    machines[name] = machine;
  }

  if (issues.length > 0) fail(source, issues);

  return {
    version: version as number,
    source,
    machines: machines as Record<MachineName, LoopMachine>,
  };
}

/** The default contract, loaded once per process. */
function defaultStates(): LoopStates {
  cachedDefault ??= loadLoopStates();
  return cachedDefault;
}

function machineOf(machine: MachineName, states: LoopStates | undefined): LoopMachine {
  const resolved = states ?? defaultStates();
  const found = resolved.machines[machine];
  if (found === undefined) {
    throw new LoopStatesError(
      `unknown machine "${machine}" (expected ${MACHINE_NAMES.join(', ')})`,
    );
  }
  return found;
}

/** Canonical state names of a machine, in declaration order. */
export function listStates(machine: MachineName, states?: LoopStates): readonly string[] {
  return Object.keys(machineOf(machine, states).states);
}

/**
 * Resolve `input` (a canonical name or an alias, in any case) to the canonical
 * state name. Throws `LoopStatesError` if it is not part of the machine.
 */
export function canonicalState(machine: MachineName, input: string, states?: LoopStates): string {
  const m = machineOf(machine, states);
  if (typeof input !== 'string' || input.trim() === '') {
    throw new LoopStatesError(`empty state for machine "${machine}"`);
  }
  const token = normalizeToken(input);
  for (const state of Object.values(m.states)) {
    if (normalizeToken(state.name) === token) return state.name;
    for (const alias of state.aliases) {
      if (normalizeToken(alias) === token) return state.name;
    }
  }
  throw new LoopStatesError(
    `unknown ${machine} state "${input}" (known: ${Object.keys(m.states).join(', ')})`,
  );
}

/** Look up a state definition by canonical name or alias. */
function stateDef(machine: MachineName, input: string, states?: LoopStates): LoopStateDef {
  const m = machineOf(machine, states);
  const name = canonicalState(machine, input, states);
  const def = m.states[name];
  if (def === undefined) {
    throw new LoopStatesError(`unknown ${machine} state "${input}"`);
  }
  return def;
}

/** True when the state accepts no further transitions. */
export function isTerminal(machine: MachineName, state: string, states?: LoopStates): boolean {
  return stateDef(machine, state, states).terminal;
}

/**
 * Assert that `from → to` is a declared transition. Both ends may be aliases.
 * Throws `LoopStatesError` when either state is unknown or the edge is not declared.
 */
export function assertTransition(
  machine: MachineName,
  from: string,
  to: string,
  states?: LoopStates,
): void {
  const fromDef = stateDef(machine, from, states);
  const toName = canonicalState(machine, to, states);
  if (fromDef.terminal) {
    throw new LoopStatesError(
      `illegal ${machine} transition ${fromDef.name} → ${toName}: "${fromDef.name}" is terminal`,
    );
  }
  if (!fromDef.next.includes(toName)) {
    throw new LoopStatesError(
      `illegal ${machine} transition ${fromDef.name} → ${toName} ` +
        `(allowed from "${fromDef.name}": ${fromDef.next.join(', ')})`,
    );
  }
}
