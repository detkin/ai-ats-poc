/**
 * Loop-1 task derivation on the fixture org (block B1.1, `lib/engine/review-cycle.ts`).
 *
 * Covers: participants are the ACTIVE workers in scope; one self review each; two peer
 * reviews per subject wherever the team can supply them; one manager review per worker who
 * has a manager, assigned to the manager; stagger dates from `tenant/policy.yml`;
 * determinism; and the pending shadow submissions that mirror the tasks.
 */

import { describe, expect, it } from 'vitest';
import {
  participantsFor,
  peersFor,
  staggerDaysFor,
  submissionsFor,
  tasksFor,
} from '#lib/engine/review-cycle.ts';
import { OPENED_AT, makeCycle, policy, tenant, workerMap } from '#tests/engine/helpers.ts';
import type { NewRecord, TlTask } from '#lib/types/engine.ts';

const bundle = tenant();
const workers = workerMap(bundle.workers);
const seededCycle = bundle.state.cycles[0];
if (seededCycle === undefined) throw new Error('fixture tenant has no seeded cycle');
const cycle = { ...seededCycle, opened_at: OPENED_AT };
const participants = participantsFor(cycle, workers);
const tasks = tasksFor(cycle, participants, workers, policy(), OPENED_AT);

const of = (kind: TlTask['kind']): NewRecord<TlTask>[] => tasks.filter((t) => t.kind === kind);

describe('participantsFor', () => {
  it('returns every ACTIVE worker in the seeded cycle scope, sorted by id', () => {
    expect(participants).toHaveLength(120);
    expect(participants.every((w) => w.status === 'ACTIVE')).toBe(true);
    expect([...participants].map((w) => w.id)).toEqual([...participants].map((w) => w.id).sort());
  });

  it('honours a narrowed department scope', () => {
    const engOnly = participantsFor(
      makeCycle({ scope: { department_ids: ['dept_eng'] } }),
      workers,
    );
    expect(engOnly.every((w) => w.department_id === 'dept_eng')).toBe(true);
    expect(engOnly.length).toBe(
      bundle.workers.filter((w) => w.department_id === 'dept_eng').length,
    );
  });

  it('treats an empty scope as the whole company', () => {
    expect(participantsFor(makeCycle({ scope: {} }), workers)).toHaveLength(120);
  });
});

describe('tasksFor', () => {
  it('creates one self review per participant', () => {
    const self = of('write_self_review');
    expect(self).toHaveLength(120);
    expect(new Set(self.map((t) => t.participant_worker_id)).size).toBe(120);
    // A self review is authored by, and about, the same worker.
    expect(self.every((t) => t.participant_worker_id === t.external_ref)).toBe(true);
  });

  it('creates peers_per_subject peer reviews for every subject', () => {
    const peer = of('write_peer_review');
    expect(peer).toHaveLength(120 * policy().review_cycle.peers_per_subject);
    const bySubject = new Map<string, string[]>();
    for (const task of peer) {
      const list = bySubject.get(task.external_ref ?? '') ?? [];
      list.push(task.participant_worker_id);
      bySubject.set(task.external_ref ?? '', list);
    }
    expect(bySubject.size).toBe(120);
    for (const [subject, authors] of bySubject) {
      expect(authors).toHaveLength(2);
      expect(new Set(authors).size).toBe(2);
      expect(authors).not.toContain(subject);
      expect(authors).not.toContain(workers.get(subject)?.manager_id ?? '');
    }
  });

  it('creates one manager review per worker who has a manager, owned by the manager', () => {
    const manager = of('write_manager_review');
    const withManager = bundle.workers.filter((w) => w.manager_id !== null);
    expect(manager).toHaveLength(withManager.length);
    expect(manager).toHaveLength(119);
    for (const task of manager) {
      const subject = workers.get(task.external_ref ?? '');
      expect(subject?.manager_id).toBe(task.participant_worker_id);
    }
  });

  it("assigns w_0009's reports' manager reviews to w_0009", () => {
    const reports = bundle.workers.filter((w) => w.manager_id === 'w_0009').map((w) => w.id);
    expect(reports.length).toBeGreaterThan(0);
    const theirs = of('write_manager_review').filter((t) => reports.includes(t.external_ref ?? ''));
    expect(theirs).toHaveLength(reports.length);
    expect(theirs.every((t) => t.participant_worker_id === 'w_0009')).toBe(true);
  });

  it('staggers due dates self -> peer -> manager at 23:59:59Z', () => {
    const stagger = policy().review_cycle.stagger_days;
    expect(staggerDaysFor('write_self_review', policy())).toBe(stagger.self);
    expect(of('write_self_review')[0]?.due_at).toBe('2026-08-24T23:59:59Z');
    expect(of('write_peer_review')[0]?.due_at).toBe('2026-08-31T23:59:59Z');
    expect(of('write_manager_review')[0]?.due_at).toBe('2026-09-07T23:59:59Z');
    expect(tasks.every((t) => t.due_at === t.original_due_at)).toBe(true);
    expect(tasks.every((t) => t.status === 'pending' && t.attempt_n === 0)).toBe(true);
  });

  it('is deterministic', () => {
    const again = tasksFor(cycle, participantsFor(cycle, workers), workers, policy(), OPENED_AT);
    expect(again).toEqual(tasks);
  });

  it('refuses to build tasks without an opened_at', () => {
    expect(() => tasksFor(makeCycle({ opened_at: null }), participants, workers, policy())).toThrow(
      /opened_at/,
    );
  });
});

describe('peersFor', () => {
  it('falls back to the department when the team cannot supply enough peers', () => {
    const ceo = workers.get('w_0001');
    expect(ceo).toBeDefined();
    if (ceo === undefined) return;
    const teamMates = participants.filter((w) => w.team_id === ceo.team_id && w.id !== ceo.id);
    expect(teamMates).toHaveLength(0); // team_exec is the CEO alone
    const peers = peersFor(ceo, participants, 2);
    expect(peers).toHaveLength(2);
    expect(peers.every((p) => p.department_id === ceo.department_id)).toBe(true);
  });

  it('spreads peer load instead of always picking the two lowest ids', () => {
    const platform = participants.filter((w) => w.team_id === 'team_platform');
    const authors = new Set(platform.flatMap((s) => peersFor(s, participants, 2).map((p) => p.id)));
    expect(authors.size).toBeGreaterThan(2);
  });

  it('returns nothing when asked for no peers', () => {
    const anyone = participants[0];
    expect(anyone).toBeDefined();
    if (anyone === undefined) return;
    expect(peersFor(anyone, participants, 0)).toEqual([]);
  });
});

describe('submissionsFor', () => {
  it('mirrors every review task with a pending shadow record', () => {
    const submissions = submissionsFor(cycle, tasks);
    expect(submissions).toHaveLength(tasks.length);
    expect(submissions.every((s) => s.status === 'pending' && s.shadow === true)).toBe(true);
    expect(submissions.every((s) => s.body_ref === null)).toBe(true);
    const kinds = new Set(submissions.map((s) => s.kind));
    expect([...kinds].sort()).toEqual(['manager', 'peer', 'self']);
    submissions.forEach((submission, index) => {
      const task = tasks[index];
      expect(submission.subject_worker_id).toBe(task?.external_ref);
      expect(submission.author_worker_id).toBe(task?.participant_worker_id);
      expect(submission.real_ref).toBe(task?.external_ref);
    });
  });
});
