/**
 * lib/cli/args.ts — the tiny argument parser every `bin/*.mjs` shares (block B1.3).
 *
 * Owns: the declarative `CliSpec` (name, usage, subcommands, flags), the parser that turns
 * `process.argv` into an `Args` accessor, and `renderHelp`, which prints **every** declared
 * flag. `tests/modes/consistency.test.ts` (block B1.4) asserts that each flag a mode file
 * mentions appears in that CLI's `--help`, so the spec is the single source of both.
 *
 * Public interface:
 *   CliSpec, FlagSpec, SubcommandSpec
 *   parseArgs(argv, spec) -> Args            // throws UsageError (exit 2)
 *   renderHelp(spec) -> string
 *   Args: subcommand, has/bool/get/require/all/rest
 *   UsageError
 *
 * Supported shapes: `--flag value`, `--flag=value`, `--bool`, repeated flags
 * (`--department a --department b`, or `--evidence a,b` for comma-list flags), a leading
 * subcommand, and `--help` / `-h`. Anything else is a `UsageError`: a CLI that silently
 * ignores a typo'd flag is a CLI that silently skips a policy.
 *
 * Spec: docs/SPEC.md §5 (bin/ tree); docs/PLAN.md §2.9 (the CLI contract), §4 block B1.3.
 */

import { TalentLoopsError } from '#lib/safety/errors.ts';

/** A bad invocation: unknown flag, missing value, missing/unknown subcommand. Exit code 2. */
export class UsageError extends TalentLoopsError {
  constructor(message: string) {
    super('USAGE', message);
    this.name = 'UsageError';
  }
}

export interface FlagSpec {
  /** Long name without dashes, e.g. `cycle` for `--cycle`. */
  name: string;
  type: 'string' | 'boolean';
  /** Placeholder shown in `--help`, e.g. `<id>`. Strings should always set one. */
  value?: string;
  description: string;
  /** May appear more than once; `all(name)` returns every value. */
  repeated?: boolean;
  /** Split each value on commas as well (`--evidence a,b`). Implies `repeated`. */
  commaList?: boolean;
}

export interface SubcommandSpec {
  name: string;
  description: string;
}

export interface CliSpec {
  /** File name, e.g. `tick.mjs`. Used in usage lines and error messages. */
  name: string;
  summary: string;
  /** Usage lines, without the leading `node `. */
  usage: string[];
  subcommands?: SubcommandSpec[];
  flags: FlagSpec[];
  /** Extra paragraphs printed after the options block. */
  notes?: string[];
}

/** `--json` and `--help` exist on every CLI; specs never declare them. */
const COMMON_FLAGS: FlagSpec[] = [
  { name: 'json', type: 'boolean', description: 'machine-readable JSON on stdout' },
  { name: 'help', type: 'boolean', description: 'show this message and exit 0' },
];

/** Every flag a spec accepts, declared plus common. */
export function flagsOf(spec: CliSpec): FlagSpec[] {
  const declared = new Set(spec.flags.map((flag) => flag.name));
  return [...spec.flags, ...COMMON_FLAGS.filter((flag) => !declared.has(flag.name))];
}

/** Parsed arguments. Accessors throw `UsageError` when a required value is missing. */
export class Args {
  readonly spec: CliSpec;
  readonly subcommand: string | null;
  /** Positionals after the subcommand. Most CLIs have none. */
  readonly rest: readonly string[];
  private readonly values: Map<string, string[]>;

  constructor(
    spec: CliSpec,
    subcommand: string | null,
    values: Map<string, string[]>,
    rest: string[],
  ) {
    this.spec = spec;
    this.subcommand = subcommand;
    this.values = values;
    this.rest = rest;
  }

  has(name: string): boolean {
    return this.values.has(name);
  }

  bool(name: string): boolean {
    return this.values.get(name)?.at(-1) === 'true';
  }

  get(name: string): string | undefined {
    return this.values.get(name)?.at(-1);
  }

  /** The flag's value, or a `UsageError` naming it. */
  require(name: string): string {
    const value = this.get(name);
    if (value === undefined || value.length === 0) {
      throw new UsageError(`${this.spec.name}: --${name} is required`);
    }
    return value;
  }

  all(name: string): string[] {
    return [...(this.values.get(name) ?? [])];
  }

  /** The subcommand, or a `UsageError` when the CLI needs one. */
  requireSubcommand(): string {
    if (this.subcommand === null) {
      const names = (this.spec.subcommands ?? []).map((sub) => sub.name).join(' | ');
      throw new UsageError(`${this.spec.name}: a command is required (${names})`);
    }
    return this.subcommand;
  }
}

function findFlag(spec: CliSpec, name: string): FlagSpec {
  const found = flagsOf(spec).find((flag) => flag.name === name);
  if (found === undefined) throw new UsageError(`${spec.name}: unknown argument "--${name}"`);
  return found;
}

function push(values: Map<string, string[]>, flag: FlagSpec, raw: string): void {
  const list = values.get(flag.name) ?? [];
  const repeated = flag.repeated === true || flag.commaList === true;
  const parts = flag.commaList === true ? raw.split(',').map((part) => part.trim()) : [raw];
  const kept = parts.filter((part) => part.length > 0);
  values.set(flag.name, repeated ? [...list, ...kept] : kept.slice(-1));
}

/**
 * Parse `argv` (already sliced past `node script`) against `spec`.
 * @throws UsageError — the caller maps it to exit code 2.
 */
export function parseArgs(argv: readonly string[], spec: CliSpec): Args {
  const values = new Map<string, string[]>();
  const rest: string[] = [];
  let subcommand: string | null = null;
  let literal = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? '';
    if (literal) {
      rest.push(arg);
      continue;
    }
    if (arg === '--') {
      literal = true;
      continue;
    }
    if (arg === '-h') {
      push(values, findFlag(spec, 'help'), 'true');
      continue;
    }
    if (arg.startsWith('--')) {
      const equals = arg.indexOf('=');
      const name = equals === -1 ? arg.slice(2) : arg.slice(2, equals);
      const inline = equals === -1 ? undefined : arg.slice(equals + 1);
      const flag = findFlag(spec, name);
      if (flag.type === 'boolean') {
        if (inline !== undefined && inline !== 'true' && inline !== 'false') {
          throw new UsageError(`${spec.name}: --${name} is a flag and takes no value`);
        }
        push(values, flag, inline === 'false' ? 'false' : 'true');
        continue;
      }
      const value = inline ?? argv[i + 1];
      if (inline === undefined) i += 1;
      if (value === undefined || (inline === undefined && value.startsWith('--'))) {
        throw new UsageError(`${spec.name}: --${name} needs a value`);
      }
      push(values, flag, value);
      continue;
    }
    if (arg.startsWith('-') && arg.length > 1) {
      throw new UsageError(`${spec.name}: unknown argument "${arg}"`);
    }
    if (spec.subcommands !== undefined && subcommand === null) {
      const known = spec.subcommands.some((sub) => sub.name === arg);
      if (!known) {
        const names = spec.subcommands.map((sub) => sub.name).join(' | ');
        throw new UsageError(`${spec.name}: unknown command "${arg}" (expected ${names})`);
      }
      subcommand = arg;
      continue;
    }
    rest.push(arg);
  }

  return new Args(spec, subcommand, values, rest);
}

function flagLabel(flag: FlagSpec): string {
  const base = `--${flag.name}`;
  if (flag.type === 'boolean') return base;
  return `${base} ${flag.value ?? '<value>'}`;
}

/** The `--help` text. Lists every declared flag, which the modes test relies on. */
export function renderHelp(spec: CliSpec): string {
  const lines: string[] = [`${spec.name} — ${spec.summary}`, '', 'Usage:'];
  for (const usage of spec.usage) lines.push(`  node ${usage}`);

  if (spec.subcommands !== undefined && spec.subcommands.length > 0) {
    lines.push('', 'Commands:');
    const width = Math.max(...spec.subcommands.map((sub) => sub.name.length));
    for (const sub of spec.subcommands) {
      lines.push(`  ${sub.name.padEnd(width)}  ${sub.description}`);
    }
  }

  const flags = flagsOf(spec);
  lines.push('', 'Options:');
  const labels = flags.map(flagLabel);
  const width = Math.max(...labels.map((label) => label.length));
  flags.forEach((flag, index) => {
    const label = labels[index] ?? flagLabel(flag);
    const suffix = flag.repeated === true || flag.commaList === true ? ' (repeatable)' : '';
    lines.push(`  ${label.padEnd(width)}  ${flag.description}${suffix}`);
  });

  lines.push(
    '',
    'Exit codes: 0 success, 1 domain failure (drift, lock held, unknown id), 2 usage or config.',
  );
  for (const note of spec.notes ?? []) lines.push('', note);
  return lines.join('\n');
}
