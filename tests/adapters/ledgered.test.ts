/**
 * tests/adapters/ledgered.test.ts — the allowlist and the ledger, as runtime properties.
 *
 * Proves: every port call lands in `ledger.jsonl` (reads included); a write outside the
 * allowlist is rejected *before* the port sees it and is ledgered as `rejected`; a throwing
 * call is ledgered as `error`; the ledger only ever grows; entries carry the acting identity
 * and its permission context; `args_hash` is the sha256 of the canonical args; and no résumé
 * or message body ever reaches `args_summary`.
 *
 * Spec: docs/SPEC.md §7 step 5, §9, §10; docs/PLAN.md §4 block B1.2 (tests).
 */

import { createHash } from 'node:crypto';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { FixtureLedgerAdapter } from '#lib/adapters/fixture/ledger.ts';
import {
  MAX_ARGS_SUMMARY_CHARS,
  canonicalJson,
  hashArgs,
  ledgered,
  summarizeArgs,
} from '#lib/adapters/ledgered.ts';
import type { LedgerContext } from '#lib/adapters/ledgered.ts';
import type { ActorContext } from '#lib/ports/context.ts';
import { WriteNotAllowedError } from '#lib/safety/errors.ts';
import type { TlTask } from '#lib/types/engine.ts';
import {
  ANCHOR_NOW,
  makeDataDir,
  makeRuntime,
  readLedger,
  removeDataDir,
} from '#tests/adapters/helpers.ts';

const RESUME_REF = 'resumes/cand_0001.md';

let dataDir: string;

beforeEach(() => {
  dataDir = makeDataDir();
});

afterEach(() => removeDataDir(dataDir));

const newTask = (): Omit<TlTask, 'id' | 'created_at' | 'updated_at' | 'created_by'> => ({
  cycle_id: 'tl_cycle_h2_2026',
  participant_worker_id: 'w_0033',
  kind: 'write_self_review',
  external_ref: null,
  due_at: '2026-09-11T23:59:59Z',
  original_due_at: '2026-09-11T23:59:59Z',
  status: 'pending',
  attempt_n: 0,
});

describe('every port call is on the record', () => {
  it('ledgers reads as well as writes, with actor and permission context', async () => {
    const runtime = makeRuntime(dataDir, { tickId: 'tick_test0001' });
    await runtime.ports.graph.lookupPerson('w_0009');
    const created = await runtime.ports.state.create('task', newTask());

    const entries = readLedger(dataDir);
    expect(entries).toHaveLength(2);

    const read = entries[0];
    expect(read?.port).toBe('graph');
    expect(read?.function).toBe('lookupPerson');
    expect(read?.result).toBe('ok');
    expect(read?.ts).toBe(ANCHOR_NOW);
    expect(read?.actor).toEqual({
      worker_id: 'w_0021',
      email: 'priya.raghunathan@acme-robotics.example',
      adapter: 'fixture',
    });
    expect(read?.permission_context).toContain('custom_objects.write');
    expect(read?.tick_id).toBe('tick_test0001');
    expect(read?.id).toMatch(/^tl_agent_action_[0-9a-f]{8}$/);

    const write = entries[1];
    expect(write?.port).toBe('state');
    expect(write?.function).toBe('create');
    expect(write?.result).toBe('ok');
    expect(write?.result_ref).toBe(created.id);
    expect(write?.cycle_id).toBe('tl_cycle_h2_2026');
  });

  it('hashes the canonical args and keeps the summary short and id-only', async () => {
    const runtime = makeRuntime(dataDir);
    await runtime.ports.graph.searchPeople({ status: 'ACTIVE', department_id: 'dept_eng' });
    const entry = readLedger(dataDir)[0];

    const expected = createHash('sha256')
      .update(JSON.stringify([{ department_id: 'dept_eng', status: 'ACTIVE' }]))
      .digest('hex');
    expect(entry?.args_hash).toBe(expected);
    // The hash is canonical (keys sorted); the summary keeps call order.
    expect(entry?.args_summary).toBe('{status:ACTIVE,department_id:dept_eng}');
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
    expect(hashArgs([1])).toHaveLength(64);
  });

  it('never puts a résumé or a message body in args_summary', async () => {
    const runtime = makeRuntime(dataDir);
    const document = await runtime.ports.ats.readDocument(RESUME_REF);
    expect(document.text).toContain('Rice University');

    await runtime.ports.channel.sendDirect({
      to_worker_id: 'w_0033',
      text: document.text,
      template_id: 'self_review',
    });

    for (const entry of readLedger(dataDir)) {
      expect(entry.args_summary.length).toBeLessThanOrEqual(MAX_ARGS_SUMMARY_CHARS);
      expect(entry.args_summary).not.toContain('Rice University');
      expect(entry.args_summary).not.toContain('Petrakis');
    }
    const sent = readLedger(dataDir).find((entry) => entry.function === 'sendDirect');
    expect(sent?.args_summary).toContain('to_worker_id:w_0033');
    expect(sent?.args_summary).toContain('text:<redacted:');
    const read = readLedger(dataDir).find((entry) => entry.function === 'readDocument');
    expect(read?.args_summary).toBe(RESUME_REF);
  });

  it('summarizes prose, ids and nesting without leaking text', () => {
    expect(summarizeArgs(['tl_task_0001', 42, true])).toBe('tl_task_0001 42 true');
    expect(summarizeArgs(['a sentence with spaces'])).toBe('<text:22>');
    expect(summarizeArgs([{ rationale: 'because I said so' }])).toBe('{rationale:<redacted:17>}');
  });
});

describe('the write allowlist is enforced in the adapter', () => {
  it('rejects state.create on a non-tl_* kind and ledgers the rejection', async () => {
    const runtime = makeRuntime(dataDir);
    await expect(
      runtime.ports.state.create('worker' as never, { id: 'w_9999' } as never),
    ).rejects.toThrow(WriteNotAllowedError);

    const entries = readLedger(dataDir);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.result).toBe('rejected');
    expect(entries[0]?.port).toBe('state');
    expect(entries[0]?.function).toBe('create');
    expect(entries[0]?.args_summary).toContain('worker');
    // The rejection happened before the port ran: no state file was touched.
    expect(await runtime.raw.state.list('task')).toHaveLength(0);
  });

  it('names bin/propose.mjs in the rejection', async () => {
    const runtime = makeRuntime(dataDir);
    await expect(runtime.ports.state.create('worker' as never, {} as never)).rejects.toThrow(
      /bin\/propose\.mjs/,
    );
  });

  it('rejects an ATS write that is not createDraftHire', async () => {
    const runtime = makeRuntime(dataDir);
    const ats = ledgered(
      'ats',
      { createRequisition: async (): Promise<string> => 'req_should_not_happen' },
      ledgerContextFor(runtime.actor, dataDir),
    );
    await expect(ats.createRequisition()).rejects.toThrow(WriteNotAllowedError);
    const entry = readLedger(dataDir).at(-1);
    expect(entry?.result).toBe('rejected');
    expect(entry?.function).toBe('createRequisition');
  });

  it('rejects a channel method nobody allowlisted', async () => {
    const runtime = makeRuntime(dataDir);
    let called = false;
    const channel = ledgered(
      'channel',
      {
        deleteMessage: async (): Promise<void> => {
          called = true;
        },
      },
      ledgerContextFor(runtime.actor, dataDir),
    );
    await expect(channel.deleteMessage()).rejects.toThrow(WriteNotAllowedError);
    expect(called).toBe(false);
    expect(readLedger(dataDir).at(-1)?.result).toBe('rejected');
  });

  it('ledgers a throwing call as an error and rethrows it', async () => {
    const runtime = makeRuntime(dataDir);
    await expect(
      runtime.ports.availability.placeHold(
        { start_at: ANCHOR_NOW, end_at: ANCHOR_NOW, worker_ids: [] },
        { title: 'Onsite', attendees: [] },
      ),
    ).rejects.toThrow(/M2/);
    const entry = readLedger(dataDir).at(-1);
    expect(entry?.result).toBe('error');
    expect(entry?.function).toBe('placeHold');
  });
});

describe('the ledger only grows', () => {
  it('adds one line per call — rejected, ok and read alike — and never removes one', async () => {
    const runtime = makeRuntime(dataDir);
    expect(readLedger(dataDir)).toHaveLength(0);

    await expect(runtime.ports.state.create('worker' as never, {} as never)).rejects.toThrow();
    const afterRejected = readLedger(dataDir);
    expect(afterRejected).toHaveLength(1);

    await runtime.ports.state.create('task', newTask());
    const afterWrite = readLedger(dataDir);
    expect(afterWrite).toHaveLength(2);
    expect(afterWrite.slice(0, 1)).toEqual(afterRejected);

    await runtime.ports.state.list('task');
    const afterRead = readLedger(dataDir);
    expect(afterRead).toHaveLength(3);
    expect(afterRead.slice(0, 2)).toEqual(afterWrite);
  });

  it('gives the fixture ledger exactly append and list — no rewrite path', () => {
    const ledger = new FixtureLedgerAdapter(dataDir, () => new Date(ANCHOR_NOW));
    const methods = Object.getOwnPropertyNames(Object.getPrototypeOf(ledger)).filter(
      (name) => name !== 'constructor',
    );
    expect(methods.sort()).toEqual(['append', 'list']);
  });

  it('never ledgers the ledger itself', async () => {
    const runtime = makeRuntime(dataDir);
    expect(runtime.ports.ledger).toBe(runtime.raw.ledger);
    await runtime.ports.ledger.list({});
    expect(readLedger(dataDir)).toHaveLength(0);
  });

  it('filters list by cycle and since', async () => {
    const runtime = makeRuntime(dataDir);
    await runtime.ports.state.create('task', newTask());
    await runtime.ports.graph.listLevels();
    expect(await runtime.ports.ledger.list({ cycle_id: 'tl_cycle_h2_2026' })).toHaveLength(1);
    expect(await runtime.ports.ledger.list({ since: '2027-01-01T00:00:00Z' })).toHaveLength(0);
  });
});

/** A ledger context wired to the temp data dir, for hand-built ports. */
function ledgerContextFor(actor: ActorContext, dir: string): LedgerContext {
  return {
    actor,
    ledger: new FixtureLedgerAdapter(dir, () => new Date(ANCHOR_NOW)),
    now: () => new Date(ANCHOR_NOW),
  };
}
