/**
 * tests/adapters/rippling.test.ts — the stubs carry the real names and fail loudly.
 *
 * Proves: all 31 `codemode.*` functions from docs/research/rippling-06-api-mcp-surface.md
 * exist and throw `RipplingNotConnectedError` naming themselves and pointing at
 * `docs/QUESTIONS.md`; every rippling port method throws the same; and `delete_custom_record`
 * — which Rippling has and the POC must never use — is backed by no port method.
 *
 * Spec: docs/SPEC.md §2, §9; docs/PLAN.md §4 block B1.2 (tests); docs/QUESTIONS.md Q2.
 */

import { describe, expect, it } from 'vitest';

import {
  CHANNEL_BACKING,
  CODEMODE_FUNCTIONS,
  MCP_BACKING,
  REST_BACKING,
  RipplingNotConnectedError,
  buildRipplingPorts,
  codemode,
} from '#lib/adapters/rippling/index.ts';

describe('codemode stubs', () => {
  it('lists exactly the 31 functions the Rippling MCP exposes', () => {
    expect(CODEMODE_FUNCTIONS).toHaveLength(31);
    expect(new Set(CODEMODE_FUNCTIONS).size).toBe(31);
    for (const name of [
      'ask_ai',
      'lookup_me',
      'lookup_absence',
      'request_time_off',
      'create_draft_hire',
      'create_custom_record',
      'update_custom_record',
      'delete_custom_record',
      'setup_custom_object',
    ]) {
      expect(CODEMODE_FUNCTIONS).toContain(name);
    }
  });

  it('throws RipplingNotConnectedError naming the function and the question', () => {
    for (const name of CODEMODE_FUNCTIONS) {
      const fn = codemode[name];
      expect(typeof fn).toBe('function');
      try {
        fn();
        throw new Error(`codemode.${name} did not throw`);
      } catch (error) {
        expect(error).toBeInstanceOf(RipplingNotConnectedError);
        expect((error as RipplingNotConnectedError).call).toBe(`codemode.${name}`);
        expect((error as Error).message).toContain('docs/QUESTIONS.md');
      }
    }
  });
});

describe('rippling ports', () => {
  it('every method of every port throws, and none returns data', async () => {
    const ports = buildRipplingPorts();
    const calls: Promise<unknown>[] = [
      ports.graph.lookupMe(),
      ports.graph.searchPeople({}),
      ports.graph.listLocations(),
      ports.ats.getRequisition('req_staff_eng'),
      ports.ats.listApplications({}),
      ports.ats.readDocument('resumes/cand_0001.md'),
      ports.bands.listBands(),
      ports.bands.getWorkerCompensation('w_0021'),
      ports.availability.absenceOn('w_0021', '2026-09-02'),
      ports.availability.quietHours('w_0021', '2026-09-02T16:00:00Z'),
      ports.channel.sendDirect({ to_worker_id: 'w_0021', text: 'x', template_id: 't' }),
      ports.channel.readReplies('thr_1'),
      ports.state.list('task'),
      ports.state.create('task', {} as never),
      ports.ledger.append({} as never),
      ports.ledger.list({}),
    ];
    for (const call of calls) {
      await expect(call).rejects.toBeInstanceOf(RipplingNotConnectedError);
    }
  });

  it('maps the ATS to REST, because the MCP redacts it', () => {
    expect(REST_BACKING.ats.listApplications).toContain('/ats/candidate-applications');
    expect(REST_BACKING.bands.getWorkerCompensation).toContain('expand=compensation');
    expect(MCP_BACKING.state.create).toBe('codemode.create_custom_record');
    expect(CHANNEL_BACKING.sendDirect).toContain('slack');
  });

  it('never wires delete_custom_record — or any delete — to a port method', () => {
    const backings = [
      ...Object.values(MCP_BACKING).flatMap((port) => Object.values(port)),
      ...Object.values(REST_BACKING).flatMap((port) => Object.values(port)),
      ...Object.values(CHANNEL_BACKING),
    ] as string[];
    expect(backings.length).toBeGreaterThan(20);
    for (const backing of backings) {
      expect(backing).not.toContain('delete_custom_record');
      expect(backing).not.toMatch(/\bDELETE\b/);
    }
    // …and no port declares a delete method at all.
    const ports = buildRipplingPorts();
    for (const port of Object.values(ports)) {
      const methods = Object.getOwnPropertyNames(Object.getPrototypeOf(port));
      expect(methods.filter((name) => /delete|destroy|remove/i.test(name))).toEqual([]);
    }
  });
});
