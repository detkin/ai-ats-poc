/**
 * tests/states/loop-states.test.ts — B0.2 states contract (spec §7, plan §2.5).
 *
 * Covers: the committed `templates/loop-states.yml` parses and validates; alias and
 * case resolution; transition legality per machine; and that a malformed contract is
 * rejected on load with a named error.
 */

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  LoopStatesError,
  MACHINE_NAMES,
  assertTransition,
  canonicalState,
  defaultLoopStatesPath,
  isTerminal,
  listStates,
  loadLoopStates,
} from '#lib/states/index.ts';
import type { LoopStates } from '#lib/states/index.ts';

let states: LoopStates;

beforeAll(() => {
  states = loadLoopStates();
});

function writeContract(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'tl-loop-states-'));
  const file = join(dir, 'loop-states.yml');
  writeFileSync(file, body, 'utf8');
  return file;
}

/** A minimal but valid contract used as the base for malformed variants. */
function validContract(overrides: { cycleNext?: string; closedNext?: string } = {}): string {
  return [
    'version: 1',
    'machines:',
    '  cycle:',
    '    initial: configured',
    '    states:',
    '      configured:',
    `        next: [${overrides.cycleNext ?? 'running'}]`,
    '      running:',
    '        next: [closing]',
    '      escalated:',
    '        next: [running, closing]',
    '      closing:',
    '        next: [closed]',
    '      closed:',
    '        terminal: true',
    `        next: [${overrides.closedNext ?? ''}]`,
    '  task:',
    '    initial: pending',
    '    states:',
    '      pending:',
    '        next: [done]',
    '      done:',
    '        terminal: true',
    '  proposal:',
    '    initial: proposed',
    '    states:',
    '      proposed:',
    '        next: [approved]',
    '      approved:',
    '        terminal: true',
    '',
  ].join('\n');
}

describe('loadLoopStates', () => {
  it('loads the committed contract from the repo root, not the cwd', () => {
    expect(defaultLoopStatesPath().endsWith('/templates/loop-states.yml')).toBe(true);
    const cwd = process.cwd();
    try {
      process.chdir(tmpdir());
      expect(loadLoopStates().version).toBe(1);
    } finally {
      process.chdir(cwd);
    }
  });

  it('exposes exactly the cycle, task and proposal machines', () => {
    expect(Object.keys(states.machines)).toEqual([...MACHINE_NAMES]);
    expect(states.version).toBe(1);
  });

  it('declares an initial state that exists in every machine', () => {
    for (const machine of MACHINE_NAMES) {
      const m = states.machines[machine];
      expect(listStates(machine, states)).toContain(m.initial);
    }
  });

  it('points every `next` target at a declared state', () => {
    for (const machine of MACHINE_NAMES) {
      const names = listStates(machine, states);
      for (const state of Object.values(states.machines[machine].states)) {
        for (const target of state.next) {
          expect(names, `${machine}.${state.name} -> ${target}`).toContain(target);
        }
      }
    }
  });

  it('gives terminal states no `next` and non-terminal states at least one', () => {
    for (const machine of MACHINE_NAMES) {
      for (const state of Object.values(states.machines[machine].states)) {
        if (state.terminal) {
          expect(state.next, `${machine}.${state.name}`).toEqual([]);
        } else {
          expect(state.next.length, `${machine}.${state.name}`).toBeGreaterThan(0);
        }
      }
    }
  });

  it('never lets an alias collide with a state name in the same machine', () => {
    for (const machine of MACHINE_NAMES) {
      const names = new Set(listStates(machine, states));
      const seen = new Set<string>();
      for (const state of Object.values(states.machines[machine].states)) {
        for (const alias of state.aliases) {
          expect(names.has(alias), `${machine}: alias ${alias}`).toBe(false);
          expect(seen.has(alias), `${machine}: duplicate alias ${alias}`).toBe(false);
          seen.add(alias);
        }
      }
    }
  });
});

describe('canonicalState', () => {
  it('resolves aliases to canonical names', () => {
    expect(canonicalState('cycle', 'draft', states)).toBe('configured');
    expect(canonicalState('cycle', 'active', states)).toBe('running');
    expect(canonicalState('task', 'completed', states)).toBe('done');
    expect(canonicalState('task', 'excused', states)).toBe('waived');
    expect(canonicalState('proposal', 'rejected', states)).toBe('declined');
  });

  it('is case-insensitive and tolerates spaces and hyphens', () => {
    expect(canonicalState('cycle', 'CLOSED', states)).toBe('closed');
    expect(canonicalState('cycle', '  In Progress ', states)).toBe('running');
    expect(canonicalState('task', 'Not-Started', states)).toBe('pending');
  });

  it('returns canonical names unchanged', () => {
    for (const machine of MACHINE_NAMES) {
      for (const name of listStates(machine, states)) {
        expect(canonicalState(machine, name, states)).toBe(name);
      }
    }
  });

  it('throws LoopStatesError on an unknown state', () => {
    expect(() => canonicalState('cycle', 'frozen', states)).toThrow(LoopStatesError);
    expect(() => canonicalState('cycle', 'frozen', states)).toThrow(/unknown cycle state "frozen"/);
    // An alias belonging to a different machine is still unknown here.
    expect(() => canonicalState('proposal', 'nudged', states)).toThrow(LoopStatesError);
    expect(() => canonicalState('task', '', states)).toThrow(LoopStatesError);
  });
});

describe('isTerminal', () => {
  it('marks closed, done, waived, approved and declined as terminal', () => {
    expect(isTerminal('cycle', 'closed', states)).toBe(true);
    expect(isTerminal('task', 'done', states)).toBe(true);
    expect(isTerminal('task', 'waived', states)).toBe(true);
    expect(isTerminal('proposal', 'approved', states)).toBe(true);
    expect(isTerminal('proposal', 'declined', states)).toBe(true);
  });

  it('leaves working states open', () => {
    expect(isTerminal('cycle', 'running', states)).toBe(false);
    expect(isTerminal('cycle', 'escalated', states)).toBe(false);
    expect(isTerminal('task', 'nudged', states)).toBe(false);
    expect(isTerminal('proposal', 'proposed', states)).toBe(false);
  });

  it('accepts aliases', () => {
    expect(isTerminal('cycle', 'archived', states)).toBe(true);
    expect(isTerminal('task', 'chased', states)).toBe(false);
  });
});

describe('assertTransition', () => {
  it('walks the cycle happy path', () => {
    expect(() => assertTransition('cycle', 'configured', 'running', states)).not.toThrow();
    expect(() => assertTransition('cycle', 'running', 'escalated', states)).not.toThrow();
    expect(() => assertTransition('cycle', 'escalated', 'running', states)).not.toThrow();
    expect(() => assertTransition('cycle', 'escalated', 'closing', states)).not.toThrow();
    expect(() => assertTransition('cycle', 'closing', 'closed', states)).not.toThrow();
  });

  it('rejects cycle shortcuts and any move out of a terminal state', () => {
    expect(() => assertTransition('cycle', 'configured', 'closed', states)).toThrow(
      /illegal cycle transition configured/,
    );
    expect(() => assertTransition('cycle', 'closed', 'running', states)).toThrow(/is terminal/);
    expect(() => assertTransition('task', 'done', 'pending', states)).toThrow(LoopStatesError);
  });

  it('allows nudged → nudged, which carries the attempt counter', () => {
    expect(() => assertTransition('task', 'nudged', 'nudged', states)).not.toThrow();
    expect(states.machines.task.states.nudged?.counter).toBe('attempt_n');
    expect(states.machines.task.states.pending?.counter).toBeUndefined();
  });

  it('routes tasks to done, waived or escalated', () => {
    for (const to of ['nudged', 'done', 'waived', 'escalated']) {
      expect(() => assertTransition('task', 'pending', to, states)).not.toThrow();
    }
    expect(() => assertTransition('task', 'escalated', 'done', states)).not.toThrow();
    expect(() => assertTransition('task', 'escalated', 'waived', states)).not.toThrow();
    expect(() => assertTransition('task', 'escalated', 'nudged', states)).toThrow(LoopStatesError);
  });

  it('resolves aliases on both ends', () => {
    expect(() => assertTransition('cycle', 'draft', 'in_progress', states)).not.toThrow();
    expect(() => assertTransition('proposal', 'open', 'rejected', states)).not.toThrow();
  });

  it('throws on unknown states', () => {
    expect(() => assertTransition('cycle', 'running', 'frozen', states)).toThrow(LoopStatesError);
    expect(() => assertTransition('cycle', 'frozen', 'running', states)).toThrow(LoopStatesError);
  });
});

describe('proposal machine', () => {
  it('has exactly proposed, approved and declined', () => {
    expect(listStates('proposal', states)).toEqual(['proposed', 'approved', 'declined']);
    expect(states.machines.proposal.initial).toBe('proposed');
    expect(states.machines.proposal.states.proposed?.next).toEqual(['approved', 'declined']);
  });
});

describe('malformed contracts are rejected on load', () => {
  it('rejects a `next` target that is not a declared state', () => {
    const file = writeContract(validContract({ cycleNext: 'runnning' }));
    expect(() => loadLoopStates(file)).toThrow(LoopStatesError);
    expect(() => loadLoopStates(file)).toThrow(/next target "runnning" is not a declared state/);
  });

  it('rejects a terminal state that declares transitions', () => {
    const file = writeContract(validContract({ closedNext: 'running' }));
    expect(() => loadLoopStates(file)).toThrow(/terminal states must have no "next"/);
  });

  it('rejects an alias that collides with a state name', () => {
    const file = writeContract(
      validContract().replace('      running:\n', '      running:\n        aliases: [closed]\n'),
    );
    expect(() => loadLoopStates(file)).toThrow(/alias "closed" collides with "closed"/);
  });

  it('rejects a missing machine, a bad version and an unknown machine', () => {
    const noTask = writeContract(
      validContract().replace(/ {2}task:[\s\S]*? {2}proposal:/, '  proposal:'),
    );
    expect(() => loadLoopStates(noTask)).toThrow(/missing machine "task"/);

    const badVersion = writeContract(validContract().replace('version: 1', 'version: 7'));
    expect(() => loadLoopStates(badVersion)).toThrow(/unsupported contract version 7/);

    const extra = writeContract(
      `${validContract()}  offer:\n    initial: a\n    states:\n      a:\n        terminal: true\n`,
    );
    expect(() => loadLoopStates(extra)).toThrow(/unknown machine "offer"/);
  });

  it('rejects an initial state that does not exist', () => {
    const file = writeContract(validContract().replace('initial: proposed', 'initial: drafted'));
    expect(() => loadLoopStates(file)).toThrow(/initial state "drafted" is not a declared state/);
  });

  it('rejects unparsable YAML and a missing file', () => {
    const broken = writeContract('version: 1\nmachines:\n  cycle: [\n');
    expect(() => loadLoopStates(broken)).toThrow(LoopStatesError);
    expect(() => loadLoopStates(join(tmpdir(), 'tl-does-not-exist.yml'))).toThrow(
      /cannot read loop-states contract/,
    );
  });

  it('names the error class so callers can distinguish it', () => {
    try {
      loadLoopStates(writeContract(validContract({ cycleNext: 'nope' })));
      expect.unreachable('expected a LoopStatesError');
    } catch (err) {
      expect((err as Error).name).toBe('LoopStatesError');
    }
  });
});

describe('parsed structure', () => {
  it('matches the committed contract (snapshot)', () => {
    expect(states.machines).toEqual({
      cycle: {
        initial: 'configured',
        states: {
          configured: {
            name: 'configured',
            aliases: ['new', 'draft', 'created'],
            next: ['running'],
            terminal: false,
          },
          running: {
            name: 'running',
            aliases: ['open', 'active', 'in_progress'],
            next: ['escalated', 'closing'],
            terminal: false,
          },
          escalated: {
            name: 'escalated',
            aliases: ['at_risk', 'blocked'],
            next: ['running', 'closing'],
            terminal: false,
          },
          closing: {
            name: 'closing',
            aliases: ['wrapping_up', 'finalizing'],
            next: ['closed'],
            terminal: false,
          },
          closed: {
            name: 'closed',
            aliases: ['complete', 'completed', 'done', 'archived'],
            next: [],
            terminal: true,
          },
        },
      },
      task: {
        initial: 'pending',
        states: {
          pending: {
            name: 'pending',
            aliases: ['todo', 'not_started', 'open'],
            next: ['nudged', 'done', 'waived', 'escalated'],
            terminal: false,
          },
          nudged: {
            name: 'nudged',
            aliases: ['reminded', 'chased'],
            counter: 'attempt_n',
            next: ['nudged', 'done', 'waived', 'escalated'],
            terminal: false,
          },
          escalated: {
            name: 'escalated',
            aliases: ['raised', 'flagged'],
            next: ['done', 'waived'],
            terminal: false,
          },
          done: {
            name: 'done',
            aliases: ['complete', 'completed', 'submitted'],
            next: [],
            terminal: true,
          },
          waived: {
            name: 'waived',
            aliases: ['excused', 'skipped', 'exempt'],
            next: [],
            terminal: true,
          },
        },
      },
      proposal: {
        initial: 'proposed',
        states: {
          proposed: {
            name: 'proposed',
            aliases: ['awaiting_decision', 'pending_decision', 'open'],
            next: ['approved', 'declined'],
            terminal: false,
          },
          approved: {
            name: 'approved',
            aliases: ['accepted', 'approve'],
            next: [],
            terminal: true,
          },
          declined: {
            name: 'declined',
            aliases: ['rejected', 'decline', 'denied'],
            next: [],
            terminal: true,
          },
        },
      },
    });
  });
});
