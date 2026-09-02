/**
 * tests/cli/args.test.ts — the shared argument parser and help renderer (block B1.3).
 *
 * The parser is the reason a typo'd flag is an error instead of a silently skipped policy,
 * and `renderHelp` is what `tests/modes/consistency.test.ts` checks mode files against, so
 * both are covered here rather than only through the CLIs that use them.
 */

import { describe, expect, it } from 'vitest';

import { UsageError, parseArgs, renderHelp } from '#lib/cli/args.ts';
import type { CliSpec } from '#lib/cli/args.ts';

const SPEC: CliSpec = {
  name: 'demo.mjs',
  summary: 'a spec used only by this test',
  usage: ['bin/demo.mjs run --cycle <id>'],
  subcommands: [
    { name: 'run', description: 'do the thing' },
    { name: 'show', description: 'show the thing' },
  ],
  flags: [
    { name: 'cycle', type: 'string', value: '<id>', description: 'cycle id' },
    { name: 'department', type: 'string', value: '<id>', description: 'scope', repeated: true },
    { name: 'evidence', type: 'string', value: '<id,id>', description: 'refs', commaList: true },
    { name: 'dry-run', type: 'boolean', description: 'plan only' },
  ],
};

describe('parseArgs', () => {
  it('reads a subcommand, a flag value and a boolean', () => {
    const args = parseArgs(['run', '--cycle', 'tl_cycle_1', '--dry-run'], SPEC);
    expect(args.subcommand).toBe('run');
    expect(args.require('cycle')).toBe('tl_cycle_1');
    expect(args.bool('dry-run')).toBe(true);
    expect(args.bool('json')).toBe(false);
  });

  it('accepts --flag=value', () => {
    expect(parseArgs(['show', '--cycle=tl_cycle_2'], SPEC).get('cycle')).toBe('tl_cycle_2');
  });

  it('collects repeated flags and comma lists', () => {
    const args = parseArgs(
      ['run', '--department', 'dept_eng', '--department', 'dept_ga', '--evidence', 'a,b,c'],
      SPEC,
    );
    expect(args.all('department')).toEqual(['dept_eng', 'dept_ga']);
    expect(args.all('evidence')).toEqual(['a', 'b', 'c']);
  });

  it('keeps the last value of a non-repeated flag', () => {
    expect(parseArgs(['run', '--cycle', 'a', '--cycle', 'b'], SPEC).get('cycle')).toBe('b');
  });

  it('treats -h as --help', () => {
    expect(parseArgs(['-h'], SPEC).bool('help')).toBe(true);
  });

  it('rejects an unknown flag', () => {
    expect(() => parseArgs(['run', '--nope'], SPEC)).toThrow(UsageError);
    expect(() => parseArgs(['run', '--nope'], SPEC)).toThrow('unknown argument "--nope"');
  });

  it('rejects an unknown subcommand', () => {
    expect(() => parseArgs(['fly'], SPEC)).toThrow(/unknown command "fly"/);
  });

  it('rejects a value-less string flag', () => {
    expect(() => parseArgs(['run', '--cycle'], SPEC)).toThrow(/--cycle needs a value/);
    expect(() => parseArgs(['run', '--cycle', '--dry-run'], SPEC)).toThrow(/--cycle needs a value/);
  });

  it('rejects a value on a boolean flag', () => {
    expect(() => parseArgs(['run', '--dry-run=maybe'], SPEC)).toThrow(/takes no value/);
  });

  it('names the missing flag in require(), and the missing subcommand', () => {
    expect(() => parseArgs(['run'], SPEC).require('cycle')).toThrow(/--cycle is required/);
    expect(() => parseArgs([], SPEC).requireSubcommand()).toThrow(/a command is required/);
  });
});

describe('renderHelp', () => {
  const help = renderHelp(SPEC);

  it('lists every declared flag with its placeholder', () => {
    for (const flag of SPEC.flags) {
      expect(help).toContain(`--${flag.name}`);
    }
    expect(help).toContain('--cycle <id>');
    expect(help).toContain('(repeatable)');
  });

  it('lists the common flags and the subcommands', () => {
    expect(help).toContain('--json');
    expect(help).toContain('--help');
    expect(help).toContain('run');
    expect(help).toContain('show');
  });

  it('documents the exit codes', () => {
    expect(help).toContain('Exit codes: 0 success, 1 domain failure');
  });
});
