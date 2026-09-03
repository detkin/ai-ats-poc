/**
 * Tests for the tenant policy layer (block B0.3).
 *
 * Covers: the committed `tenant/policy.yml` loads and matches plan §2.6; the shipped
 * template is recognised as unpersonalized; typo'd and missing sections are named in
 * errors; every numeric bound; `TL_TENANT_DIR` overrides `defaultPolicyPath()`.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import {
  defaultPolicyPath,
  isTemplatePolicy,
  loadPolicy,
  PolicyError,
  POLICY_FILENAME,
  POLICY_TEMPLATE_FILENAME,
  validatePolicy,
} from '#lib/policy/index.ts';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const TENANT_DIR = path.join(REPO_ROOT, 'tenant');
const REAL_POLICY = path.join(TENANT_DIR, POLICY_FILENAME);
const TEMPLATE_POLICY = path.join(TENANT_DIR, POLICY_TEMPLATE_FILENAME);

let tempDirs: string[] = [];
const savedTenantDir = process.env.TL_TENANT_DIR;

function makeTempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'tl-policy-'));
  tempDirs.push(dir);
  return dir;
}

/** Copy the committed policy, apply a mutation, and write it to a temp file. */
function policyFileWith(mutate: (doc: Record<string, unknown>) => void): string {
  const doc = parseYaml(readFileSync(REAL_POLICY, 'utf8')) as Record<string, unknown>;
  mutate(doc);
  const file = path.join(makeTempDir(), POLICY_FILENAME);
  writeFileSync(file, stringifyYaml(doc), 'utf8');
  return file;
}

function errorsFor(mutate: (doc: Record<string, unknown>) => void): string[] {
  const doc = parseYaml(readFileSync(REAL_POLICY, 'utf8')) as Record<string, unknown>;
  mutate(doc);
  return validatePolicy(doc).errors;
}

function sectionOf(doc: Record<string, unknown>, name: string): Record<string, unknown> {
  return doc[name] as Record<string, unknown>;
}

beforeEach(() => {
  tempDirs = [];
  delete process.env.TL_TENANT_DIR;
});

afterEach(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs = [];
  if (savedTenantDir === undefined) delete process.env.TL_TENANT_DIR;
  else process.env.TL_TENANT_DIR = savedTenantDir;
});

describe('the committed tenant policy', () => {
  it('loads, validates, and carries the plan §2.6 values', () => {
    const policy = loadPolicy(REAL_POLICY);

    expect(policy.template).toBe(false);
    expect(policy.tenant).toEqual({ name: 'Acme Robotics', acting_identity_default: 'hrbp' });
    expect(policy.cadence).toEqual({
      tick_interval_hours: 24,
      nudge_min_gap_hours: 48,
      max_attempts: 3,
    });
    expect(policy.quiet_hours).toEqual({
      respect_location_hours: true,
      weekends: true,
      holidays: true,
      default_work_hours: { start: '09:00', end: '18:00' },
      default_timezone: 'America/Los_Angeles',
    });
    expect(policy.channels).toEqual({
      nudge: 'slack_dm',
      escalation: 'slack_dm',
      summary: 'slack_channel',
      summary_channel: '#people-ops',
    });
    expect(policy.escalation).toEqual({
      overdue_days: 3,
      after_attempts: 2,
      escalate_to: 'cycle_owner',
    });
    expect(policy.absence).toEqual({ move_due_date_days_after_return: 2, skip_nudge: true });
    expect(policy.review_cycle).toEqual({
      stagger_days: { self: 0, peer: 7, manager: 14 },
      peers_per_subject: 2,
    });
    expect(policy.interview_loop).toEqual({
      panel_size: 4,
      scorecard_due_hours: 24,
      substitute_same_level: true,
    });
  });

  it('is not the template', () => {
    expect(isTemplatePolicy(loadPolicy(REAL_POLICY))).toBe(false);
  });

  it('is what `loadPolicy()` reads with no arguments', () => {
    expect(defaultPolicyPath()).toBe(REAL_POLICY);
    expect(loadPolicy().tenant.name).toBe('Acme Robotics');
  });
});

describe('the shipped template policy', () => {
  it('is structurally valid so doctor can load it before rejecting it', () => {
    const template = loadPolicy(TEMPLATE_POLICY);
    expect(validatePolicy(template).ok).toBe(true);
  });

  it('is flagged as unpersonalized', () => {
    expect(isTemplatePolicy(loadPolicy(TEMPLATE_POLICY))).toBe(true);
  });

  it('has exactly the same key structure as the real policy', () => {
    const real = loadPolicy(REAL_POLICY) as unknown as Record<string, unknown>;
    const template = loadPolicy(TEMPLATE_POLICY) as unknown as Record<string, unknown>;
    expect(Object.keys(template).sort()).toEqual(Object.keys(real).sort());
    for (const key of Object.keys(real)) {
      const realSection = real[key];
      if (typeof realSection !== 'object' || realSection === null) continue;
      expect(Object.keys(template[key] as object).sort()).toEqual(
        Object.keys(realSection as object).sort(),
      );
    }
  });
});

describe('structural errors', () => {
  it("names a typo'd top-level key and the section it displaced", () => {
    const file = policyFileWith((doc) => {
      doc['cadance'] = doc['cadence'];
      delete doc['cadence'];
    });

    expect(() => loadPolicy(file)).toThrow(PolicyError);
    let thrown: PolicyError | null = null;
    try {
      loadPolicy(file);
    } catch (error) {
      thrown = error as PolicyError;
    }
    expect(thrown).toBeInstanceOf(PolicyError);
    expect(thrown?.path).toBe(file);
    expect(thrown?.errors.join('\n')).toContain("unknown top-level key: 'cadance'");
    expect(thrown?.errors.join('\n')).toContain("missing required section: 'cadence'");
    expect(thrown?.message).toContain('cadance');
  });

  it.each([
    'tenant',
    'cadence',
    'quiet_hours',
    'channels',
    'escalation',
    'absence',
    'review_cycle',
    'interview_loop',
  ])('names a missing %s section', (name) => {
    const errors = errorsFor((doc) => {
      delete doc[name];
    });
    expect(errors).toContain(`missing required section: '${name}'`);
  });

  it('rejects an unknown key inside a section', () => {
    const errors = errorsFor((doc) => {
      sectionOf(doc, 'cadence')['max_atempts'] = 3;
    });
    expect(errors.join('\n')).toContain("unknown key in section 'cadence': 'max_atempts'");
  });

  it('rejects a non-boolean template flag', () => {
    const errors = errorsFor((doc) => {
      doc['template'] = 'false';
    });
    expect(errors).toContain("template must be a boolean (got 'false')");
  });

  it('rejects a policy that is not a mapping', () => {
    expect(validatePolicy(null).ok).toBe(false);
    expect(validatePolicy([]).errors.join('\n')).toContain('must be a mapping');
    expect(validatePolicy('cadence: 24').ok).toBe(false);
  });
});

describe('numeric bounds', () => {
  it('requires max_attempts >= 1', () => {
    expect(errorsFor((doc) => void (sectionOf(doc, 'cadence')['max_attempts'] = 0))).toContain(
      'cadence.max_attempts must be >= 1 (got 0)',
    );
  });

  it('requires tick_interval_hours > 0', () => {
    expect(
      errorsFor((doc) => void (sectionOf(doc, 'cadence')['tick_interval_hours'] = 0)),
    ).toContain('cadence.tick_interval_hours must be > 0 (got 0)');
  });

  it('requires nudge_min_gap_hours >= 0', () => {
    expect(
      errorsFor((doc) => void (sectionOf(doc, 'cadence')['nudge_min_gap_hours'] = -1)),
    ).toContain('cadence.nudge_min_gap_hours must be >= 0 (got -1)');
  });

  it('requires overdue_days >= 0', () => {
    expect(errorsFor((doc) => void (sectionOf(doc, 'escalation')['overdue_days'] = -2))).toContain(
      'escalation.overdue_days must be >= 0 (got -2)',
    );
  });

  it('requires stagger days to be non-negative', () => {
    const stagger = (doc: Record<string, unknown>): Record<string, unknown> =>
      sectionOf(sectionOf(doc, 'review_cycle'), 'stagger_days') as Record<string, unknown>;
    expect(errorsFor((doc) => void (stagger(doc)['peer'] = -1))).toContain(
      'review_cycle.stagger_days.peer must be >= 0 (got -1)',
    );
  });

  it('requires self <= peer <= manager', () => {
    const selfAfterPeer = errorsFor((doc) => {
      const stagger = sectionOf(sectionOf(doc, 'review_cycle'), 'stagger_days');
      stagger['self'] = 9;
    });
    expect(selfAfterPeer.join('\n')).toContain(
      'review_cycle.stagger_days.self (9) must be <= review_cycle.stagger_days.peer (7)',
    );

    const peerAfterManager = errorsFor((doc) => {
      const stagger = sectionOf(sectionOf(doc, 'review_cycle'), 'stagger_days');
      stagger['peer'] = 20;
    });
    expect(peerAfterManager.join('\n')).toContain(
      'review_cycle.stagger_days.peer (20) must be <= review_cycle.stagger_days.manager (14)',
    );
  });

  it('requires peers_per_subject >= 1', () => {
    expect(
      errorsFor((doc) => void (sectionOf(doc, 'review_cycle')['peers_per_subject'] = 0)),
    ).toContain('review_cycle.peers_per_subject must be >= 1 (got 0)');
  });

  it('requires panel_size >= 1 and scorecard_due_hours > 0', () => {
    const errors = errorsFor((doc) => {
      const interview = sectionOf(doc, 'interview_loop');
      interview['panel_size'] = 0;
      interview['scorecard_due_hours'] = 0;
    });
    expect(errors).toContain('interview_loop.panel_size must be >= 1 (got 0)');
    expect(errors).toContain('interview_loop.scorecard_due_hours must be > 0 (got 0)');
  });

  it('reports every violation at once, not just the first', () => {
    const errors = errorsFor((doc) => {
      sectionOf(doc, 'cadence')['max_attempts'] = 0;
      sectionOf(doc, 'interview_loop')['panel_size'] = 0;
      delete doc['absence'];
    });
    expect(errors.length).toBeGreaterThanOrEqual(3);
  });
});

describe('enums and channel names', () => {
  it('rejects an unknown channel kind', () => {
    expect(errorsFor((doc) => void (sectionOf(doc, 'channels')['nudge'] = 'email'))).toContain(
      "channels.nudge must be one of slack_dm | slack_channel (got 'email')",
    );
  });

  it('rejects an unknown escalation target', () => {
    expect(
      errorsFor((doc) => void (sectionOf(doc, 'escalation')['escalate_to'] = 'ceo')),
    ).toContain("escalation.escalate_to must be one of cycle_owner | department_head (got 'ceo')");
  });

  it("requires summary_channel to start with '#'", () => {
    expect(
      errorsFor((doc) => void (sectionOf(doc, 'channels')['summary_channel'] = 'people-ops')),
    ).toContain("channels.summary_channel must start with '#' (got 'people-ops')");
  });
});

describe('loading failures', () => {
  it('throws PolicyError when the file is missing', () => {
    const missing = path.join(makeTempDir(), POLICY_FILENAME);
    expect(() => loadPolicy(missing)).toThrow(PolicyError);
    expect(() => loadPolicy(missing)).toThrow(/cannot read tenant policy/);
  });

  it('throws PolicyError on malformed YAML', () => {
    const file = path.join(makeTempDir(), POLICY_FILENAME);
    writeFileSync(file, 'cadence: [unclosed\n', 'utf8');
    expect(() => loadPolicy(file)).toThrow(/not valid YAML/);
  });
});

describe('defaultPolicyPath', () => {
  it('resolves inside the repo when TL_TENANT_DIR is unset', () => {
    expect(defaultPolicyPath()).toBe(path.join(TENANT_DIR, POLICY_FILENAME));
  });

  it('follows TL_TENANT_DIR, read on every call', () => {
    const dir = makeTempDir();
    process.env.TL_TENANT_DIR = dir;
    expect(defaultPolicyPath()).toBe(path.join(dir, POLICY_FILENAME));

    const policyText = readFileSync(TEMPLATE_POLICY, 'utf8');
    writeFileSync(path.join(dir, POLICY_FILENAME), policyText, 'utf8');
    expect(isTemplatePolicy(loadPolicy())).toBe(true);

    delete process.env.TL_TENANT_DIR;
    expect(defaultPolicyPath()).toBe(path.join(TENANT_DIR, POLICY_FILENAME));
  });

  it('ignores a blank TL_TENANT_DIR', () => {
    process.env.TL_TENANT_DIR = '   ';
    expect(defaultPolicyPath()).toBe(path.join(TENANT_DIR, POLICY_FILENAME));
  });
});

/**
 * `quiet_hours.default_work_hours` and `quiet_hours.default_timezone` (block B2.6).
 *
 * A Rippling work location carries an address and nothing else — no hours, no timezone
 * (docs/testing/live-rippling.md, DECISIONS D27) — so these two are the only thing standing
 * between a bridged tenant and a `Location` with no working window at all. A bad value here
 * would silence every nudge or send them all at midnight, so the validator is strict.
 */
describe('quiet_hours defaults (B2.6)', () => {
  it('requires both keys', () => {
    for (const key of ['default_work_hours', 'default_timezone']) {
      const errors = errorsFor((doc) => {
        delete sectionOf(doc, 'quiet_hours')[key];
      });
      expect(errors.join('\n')).toContain(
        key === 'default_timezone'
          ? 'quiet_hours.default_timezone is required'
          : "missing required section: 'default_work_hours'",
      );
    }
  });

  it('rejects a start or end that is not HH:MM', () => {
    const errors = errorsFor((doc) => {
      const quiet = sectionOf(doc, 'quiet_hours');
      quiet.default_work_hours = { start: '9am', end: '18:00' };
    });
    expect(errors.join('\n')).toContain('quiet_hours.default_work_hours.start must be HH:MM');
  });

  it('rejects a window that ends before it starts', () => {
    const errors = errorsFor((doc) => {
      const quiet = sectionOf(doc, 'quiet_hours');
      quiet.default_work_hours = { start: '18:00', end: '09:00' };
    });
    expect(errors.join('\n')).toContain('must be earlier than');
  });

  it('rejects a timezone that is not an IANA zone', () => {
    const errors = errorsFor((doc) => {
      sectionOf(doc, 'quiet_hours').default_timezone = 'PST';
    });
    expect(errors.join('\n')).toContain('quiet_hours.default_timezone must be an IANA zone');
  });

  it('rejects an unknown key inside default_work_hours', () => {
    const errors = errorsFor((doc) => {
      sectionOf(doc, 'quiet_hours').default_work_hours = {
        start: '09:00',
        end: '18:00',
        lunch: '12:00',
      };
    });
    expect(errors.join('\n')).toContain("unknown key in section 'default_work_hours': 'lunch'");
  });
});
