# M0 test report — Skeleton

**Verdict: PASS** (10 of 10 checks pass; 3 low-severity defects, none blocking M1)

- Tester: independent M0 tester agent (has not seen builder reasoning).
- Commit under test: `404d17e` "M0: integration fixes" on `main`, working tree clean.
- Environment: Node v24.5.0, darwin 25.6.0, no network used.
- Date of run: 2026-09-02.

Everything below was executed; no claim in this report rests on a builder's assertion.

---

## Results

| # | Check | Status | Key evidence |
|---|---|---|---|
| 1 | `npm ci` + `make prepush` green; tree still clean | **PASS** | exit 0; 10 test files / 224 tests; `git status --short` empty before and after |
| 2 | `node bin/seed.mjs --verify` exits 0 | **PASS** | "Fixtures … match the manifest and regenerate identically." exit 0 |
| 3 | `doctor --json` all `ok` bar `mcp_servers: warn`; `runtime_state: ok` after reset | **PASS** | 8 ok / 1 warn / 0 fail, exit 0; empty temp `TL_DATA_DIR` → `runtime_state: warn`; after `--reset` → `ok` |
| 4 | Template policy makes doctor exit 1 with `tenant_policy: fail` | **PASS** | exit 1, `tenant_policy fail` "still the unpersonalized template (template: true)" |
| 5 | Tampered fixture byte → `fixtures_seeded: fail` naming the file | **PASS** | exit 1, "workers.json: sha256 mismatch"; `seed --verify` on the same copy also flags it |
| 6 | States contract rejects bogus states and illegal transitions | **PASS** | all four assertions behave as specified (see below) |
| 7 | Write allowlist + untrusted-content detector | **PASS** | allow/deny matrix correct; error text names `bin/propose.mjs`; exactly the 2 documented résumés are anomalous |
| 8 | Fixture scenario spot-checks (30 assertions) | **PASS** | 30 pass / 0 fail |
| 9 | House rules: lint clean, no relative imports, ≤650 lines, headers, thin `bin/` | **PASS** | lint exit 0; 0 relative imports; largest file 521 lines; 40/40 lib modules have headers. *(`bin/seed.mjs` thinness — see defect D-1; the row still passes because the file is well under the line cap and lint/format are clean.)* |
| 10 | Invariant probes on ports and engine types | **PASS** | `LedgerPort` = `append`+`list` only; `StatePort` has no `delete`; engine types declare no Tier-1 value field |

---

## Evidence

### 1. Build, format, lint, typecheck, tests

```
$ npm ci && make prepush
...
 ✓ tests/types/engine-shapes.test.ts   (7 tests)
 ✓ tests/safety/allowlist.test.ts      (57 tests)
 ✓ tests/config.test.ts                (16 tests)
 ✓ tests/states/loop-states.test.ts    (28 tests)
 ✓ tests/policy/load.test.ts           (35 tests)
 ✓ tests/fixtures/generate.test.ts     (37 tests)
 ✓ tests/doctor/run.test.ts            (14 tests)
 ✓ tests/fixtures/load.test.ts         (13 tests)
 ✓ tests/cli/doctor.test.ts            (8 tests)
 ✓ tests/cli/seed.test.ts              (9 tests)

 Test Files  10 passed (10)
      Tests  224 passed (224)
PREPUSH_REAL_EXIT=0
```

`make prepush` runs `format` (`prettier --write .`) before `lint`, so a formatting drift would
show up as a dirty tree. It did not:

```
$ git status --short   # before prepush
GIT_STATUS_LINES=0
$ make prepush ; git status --short   # after
PREPUSH_REAL_EXIT=0
GIT_AFTER=0
```

Coverage of the 10 test files maps 1:1 onto the five M0 blocks (types/safety, states, policy,
fixtures, config/doctor) plus two CLI suites.

### 2. `seed --verify`

```
$ node bin/seed.mjs --verify
Fixtures at /Users/detkin/src/ai-ats-poc/fixtures/tenant match the manifest and regenerate identically.
SEED_VERIFY_EXIT=0
```

This is the stronger of the two possible implementations: it re-runs the generator into a temp
dir and diffs the *regenerated* manifest against the committed one, so hand-edited JSON that
was re-hashed into the manifest would still be caught.

### 3. Doctor health, and runtime state after reset

```
$ node bin/doctor.mjs --json
{ "ok": true, "summary": { "ok": 8, "warn": 1, "fail": 0 }, ... }
DOCTOR_EXIT=0
```

| check | status | detail (trimmed) |
|---|---|---|
| `node_version` | ok | Node v24.5.0 (>= 24) |
| `adapter_mode` | ok | fixture adapters (TL_ADAPTER=fixture) — no network needed |
| `clock` | ok | wall clock … (set TL_NOW to freeze it) |
| `tenant_policy` | ok | Acme Robotics — personalized policy … (max_attempts 3, escalate to cycle_owner) |
| `loop_states` | ok | contract v1 valid … (cycle 5, task 5, proposal 3) |
| `fixtures_seeded` | ok | 66 fixture files intact … (488 records, anchor 2026-09-02T16:00:00Z) |
| `runtime_state` | ok | runtime state initialized at ./data/state |
| `mcp_servers` | **warn** | placeholder: rippling, slack, google-calendar — informational in fixture mode |
| `write_dirs` | ok | staging/ and tenant/ledger/ exist and are writable |

`mcp_servers` is `warn`, never `fail`, as B0.5 requires. Fresh temp data dir, before and after reset:

```
$ TL_DATA_DIR=<tmp> node bin/doctor.mjs --json     # empty dir
runtime_state warn | no runtime state at <tmp>          ok=True (overall still passes)

$ TL_DATA_DIR=<tmp> node bin/seed.mjs --reset
Reset runtime state in <tmp> from .../fixtures/tenant
  state/*.json and ledger.jsonl are ready; the ledger starts empty.
RESET_EXIT=0
# 10 state/*.json written; ledger.jsonl is 0 bytes

$ TL_DATA_DIR=<tmp> node bin/doctor.mjs --json
ok=True {'ok': 8, 'warn': 1, 'fail': 0}   runtime_state ok    DOCTOR2_EXIT=0
```

### 4. Template policy is refused

`tenant/` copied to a temp dir, `policy.yml` replaced with `policy.template.yml`:

```
$ TL_TENANT_DIR=<tmp>/tenant node bin/doctor.mjs
  ✗ tenant_policy   <tmp>/tenant/policy.yml is still the unpersonalized template
                    (template: true) — refusing to tick on a stranger's cadence
      fix: copy policy.template.yml to policy.yml and personalize
9 checks: 7 ok, 1 warn, 1 fail
Result: not ready — fix the ✗ checks above before ticking.
DOCTOR3_EXIT=1
```

Exactly the career-ops lesson the spec §5 table calls for, and it fails loudly rather than warning.

### 5. Fixture integrity

One byte flipped inside a string value of a *copy* of `fixtures/tenant/workers.json`
(`Priya` → `Peiya`), leaving the JSON structurally valid:

```
$ TL_FIXTURES_DIR=<copy> node bin/doctor.mjs --json
DOCTOR4_EXIT=1
fixtures_seeded fail | fixture tenant does not match <copy>/manifest.json:
  workers.json: sha256 mismatch (manifest b96bad875336…, on disk 248e4fcea09a…)
```

The file is named and both hashes are shown. `node bin/seed.mjs --verify --dir <copy>` reports
the same drift.

### 6. States contract

```
canonicalState('task','bogus')              → LoopStatesError: unknown task state "bogus"
                                              (known: pending, nudged, escalated, done, waived)
assertTransition('cycle','closed','running')→ LoopStatesError: illegal cycle transition
                                              closed → running: "closed" is terminal
assertTransition('task','nudged','nudged')  → no throw          (attempt counter)
isTerminal('proposal','approved')           → true
listStates('cycle')    = configured,running,escalated,closing,closed
listStates('task')     = pending,nudged,escalated,done,waived
listStates('proposal') = proposed,approved,declined
canonicalState('task','NUDGED')             → "nudged"          (alias/case folding works)
```

All three machines match spec §7 exactly. Errors are the typed `LoopStatesError`, not bare `Error`.

### 7. Safety allowlist and untrusted content

```
assertWriteAllowed('state','create','tl_task')        → ALLOWED
assertWriteAllowed('ats','createDraftHire','draft_hire') → ALLOWED
assertWriteAllowed('state','delete','tl_task')        → WriteNotAllowedError
assertWriteAllowed('ats','createRequisition','req')   → WriteNotAllowedError
assertWriteAllowed('graph','update','w_0001')         → WriteNotAllowedError
assertWriteAllowed('state','create','worker')         → WriteNotAllowedError
```

Every denial carries the same message, which names both halves of the escape hatch:

> Write not allowed: ats.createRequisition on "req" is outside the write allowlist. Record it as
> a tl_proposed_action via **bin/propose.mjs** and have a named human decide it via bin/decide.mjs.

`WRITE_ALLOWLIST` matches PLAN §2.4 verbatim. `ledger.append` is deliberately absent from it,
with the reasoning in the module header — the right call: the ledger records calls, it is not a
call the agent elects to make.

`detectInstructionText` over all 40 résumés:

```
cand_0003: anomalous=true  rule=ignore_prior_instructions
cand_0033: anomalous=true  rule=ai_addressed
cand_0001, cand_0002, cand_0005, cand_0010, cand_0040: anomalous=false
full sweep of resumes/: 40 files, anomalous = cand_0003.md, cand_0033.md — exactly 2
```

Matches `fixtures/README.md` precisely, with no false positives across the other 38.

### 8. Fixture scenario spot-checks

Read straight from `fixtures/tenant/*.json` by an independent script (30 assertions, 30 passed):

| Requirement | Result |
|---|---|
| 120 workers, 6 depts, 40 candidates, 44 applications | 120 / 6 / 40 / 44 |
| dept split 45/12/8/25/15/15 | Engineering 45, Product 12, Design 8, Sales 25, Customer Success 15, G&A 15 |
| ≥ 18 workers managing ≥ 1 ACTIVE worker | 22 |
| ≥ 2 managers with ≥ 3 reports on APPROVED absence over 2026-09-02 | `w_0009` (8 reports, `abs_0001` 08-31→09-03), `w_0015` (7 reports, `abs_0002` 08-24→09-08) |
| one parental leave through 2026-10-31 | `abs_0003` `w_0033` 2026-07-13→2026-10-31 APPROVED |
| APPROVED absences covering the anchor | 9 |
| ≥ 3 ACTIVE `Onsite` on `req_staff_eng` | 4 — `app_0001`–`app_0004` |
| ≥ 6 REJECTED `Onsite`/`Offer` on `req_senior_eng_closed`, ~2026-05 | 7 — `app_0033`–`app_0039`, all dated `2026-05-01` |
| `req_designer.headcount_position_id` is null | null (off-plan, as loop 3 needs) |
| reqs: 3 OPEN + 1 CLOSED | `req_staff_eng`, `req_ae`, `req_designer` OPEN; `req_senior_eng_closed` CLOSED |
| every FK resolves (manager, dept, team, level, location, job, candidate, band, leave type, holiday, hcp, rating, identity, referrer) | 0 dangling ids across all 15 files |
| every candidate `resume_ref` resolves | 40 files, 0 missing |
| a band exists for every ACTIVE worker's (level, job_function, location_group) | 120/120 covered by 108 bands |
| ≥ 8 workers outside band | 10 — below `w_0026 w_0043 w_0088 w_0101 w_0111`; above `w_0012 w_0024 w_0050 w_0079 w_0116` |
| one manager, FY2025 mean ≥ 4.5 over ≥ 4 reports | `w_0008`, n=8, mean **4.75** — and *exactly* one, so the calibration packet has one outlier to observe |
| `prior_ratings` only for pre-2026 starters | 96 rows, all start_date < 2026-01-01 |
| identities include hrbp (default), recruiter, manager | `w_0021:hrbp*`, `w_0114:recruiter`, `w_0007:manager`; exactly one default and it is the HRBP |
| US Labor Day 2026-09-07 + 3 India holidays | 3 Labor Day rows (SF/NYC/Remote-US), 3 Bangalore rows (Independence Day, Gandhi Jayanti, Diwali) |
| `tl_cycle_h2_2026`: `configured`, `opened_at` null, type `review` | all three confirmed; owner `w_0021` |
| every other state file `[]`, `ledger.jsonl` empty | 10 state files, only `cycles.json` non-empty; ledger 0 bytes |

Two extras the fixtures got right that the brief did not ask for: two **PENDING** absences also
overlap the anchor (`abs_0010`, `abs_0011`), so a test can prove a PENDING absence does *not*
suppress a nudge; and six absences sit clear of the anchor, so a broken date filter that always
answers "absent" would be caught.

### 9. House rules

```
$ npm run lint                                          LINT_EXIT=0
  eslint . && prettier --check .  →  "All matched files use Prettier code style!"
$ grep -rnE "from ['\"]\.\.?/" --include='*.ts' --include='*.mjs' lib bin tests
  HITS=0
```

Not just absent — enforced: `eslint.config.js` has `no-restricted-imports` on `./*` and `../*`
with the message "Use package subpath imports (#lib/..., #tests/...)".

```
$ find lib bin tests -name '*.ts' -o -name '*.mjs' | xargs wc -l | sort -rn
  9272 total; largest: lib/fixtures/load.ts 521, lib/doctor/checks.ts 430,
  tests/fixtures/generate.test.ts 400, lib/types/engine.ts 398
  files over 650 lines: none
```

All 40 `lib/**/*.ts` modules open with a header comment naming what they own, the public
interface, and the spec section (spot-read `lib/ports/ledger.ts`, `lib/safety/allowlist.ts`,
`lib/types/engine.ts` — all three also name the Rippling `codemode.*` / REST call behind them,
which B0.1 required).

`bin/doctor.mjs` (79 lines) is genuinely thin: parse args, `loadConfig()`, `runDoctor()`,
render, exit code. `bin/seed.mjs` (204 lines) is not — see defect D-1.

### 10. Invariant probes

```
$ grep -nE "update|delete|remove|patch" lib/ports/ledger.ts
  5: * ...There is deliberately no `update` and no `delete` on this
  interface: corrections are new lines (spec §5, career-ops status-log.tsv rule).
  methods declared: append(entry): Promise<TlAgentAction>;  list(q): Promise<TlAgentAction[]>;

$ grep -nE "delete|remove|destroy" lib/ports/state.ts
  16: * `delete_custom_record` exists on Rippling and is deliberately NOT exposed here.
  methods declared: get, list, create, update   (no delete)
```

`lib/types/engine.ts` declares **no** field named `rating`, `base_annual`, `compensation`,
`stage`, `min`, `mid`, `max`, `first_name`, `last_name`, `work_email`, `title` or `resume_ref`.
The only occurrences of those strings are entries in the `TIER1_VALUE_FIELDS` constant, which
backs both a compile-time guard and a runtime test:

```ts
export type NoTier1Values<T> = Extract<keyof T, Tier1ValueField> extends never ? T : never;
```

`tests/types/engine-shapes.test.ts` additionally asserts at runtime that no sample `tl_*` record
carries one of those keys. This is the "engine never stores a value a real object holds"
invariant enforced in code rather than prose, exactly as spec §9 and the mandate require.

---

## Defects

| id | File | What | Severity |
|---|---|---|---|
| D-1 | `bin/seed.mjs` | Not a thin CLI. 204 lines carrying real logic: `diffManifests()` (the whole manifest-comparison algorithm, incl. seed / generator_version / anchor comparison) and `runReset()` (the state-copy implementation, including the non-obvious "delete the copied `state/ledger.jsonl`, then seed the ledger from the fixtures root instead" step). Violates the standing rule in `CLAUDE.md` and `docs/PLAN.md` §0 that `bin/*.mjs` are thin CLIs over `lib/`. It works and is tested via `tests/cli/seed.test.ts`, but the logic is only reachable through a subprocess, so it cannot be unit-tested or reused by `verify-loops.mjs` later. M1 adds eight more CLIs; this is the template they would copy. Fix: move `diffManifests` and the reset body into `lib/fixtures/`. | Low–Medium |
| D-2 | `bin/seed.mjs` (`dataDir()`, ~line 60) | Re-implements `TL_DATA_DIR` resolution (`process.env.TL_DATA_DIR ?? './data'`) instead of calling `loadConfig()` from `lib/config.ts`, which B0.5 made the single owner of the env knobs. Two files now own one fact; they agree today, and a default change in `lib/config.ts` would silently not reach `seed --reset`. | Low |
| D-3 | `docs/DECISIONS.md` | Two deliberate deviations from `docs/PLAN.md` are recorded only in `fixtures/README.md`, not in the deviation log the mandate designates: (a) the seeded cycle's `opened_at` is `null` where PLAN §3 B0.4 specifies `2026-08-24` — the reasoning given (an "open" cycle with zero tasks is drift `verify-loops` should be free to flag) is sound and I would keep the behaviour, but it belongs in DECISIONS.md; (b) `TlCycle`'s owner field is `owner_worker_id`, where SPEC §6 and PLAN §2.2 both say `owner`. | Low |

None of the three blocks M1. D-3 is worth resolving before M1 starts, since B1.3's
`cycle.mjs open` is written against whichever of the two `opened_at` stories the builder reads first.

## Observations (not defects)

- **`.mcp.json` ships a live-looking Rippling URL.** `rippling` points at
  `https://mcp.rippling.com/mcp`, while `slack` and `google-calendar` use `.example.invalid`.
  It is flagged `_placeholder: true` and the doctor never treats it as connected, but Claude
  Code reads root `.mcp.json`, so opening this repo may offer to connect an unverified endpoint.
  Making all three `.invalid` until a tenant exists would be more consistent with QUESTIONS Q2.
- **All 120 fixture workers are `ACTIVE`.** `Worker.status` allows `TERMINATED` and the M4
  rediscovery loop wants alumni; no M0 requirement asks for one, but M4 will need to add some,
  which churns the manifest. Worth deciding before the fixture is depended on further.
- **108 comp bands, not a full cross-product.** Coverage was verified the way the engine will
  query it — a band exists for every ACTIVE worker's `(level_id, job_function, location_group)` —
  rather than for every theoretically possible triple. That is the right shape; noting it so a
  later block does not assume `findBand` always resolves for an arbitrary triple.
- **The clock check reports wall clock, not the anchor.** Correct: `TL_NOW` is unset outside
  tests, and the check text tells the operator how to freeze it. Fixture dates are anchored at
  `2026-09-02T16:00:00Z`, which is today's date in this environment, so a stale-date bug would
  currently be invisible. M1 tests should set `TL_NOW` explicitly (PLAN §0 already says so).
- **`seed --verify` is stronger than a hash check.** It regenerates from the seed and diffs
  manifests, so hand-edited JSON with a re-hashed manifest is still caught. Good.
- `bin/` holds only `doctor.mjs` and `seed.mjs`; the other eight CLIs are M1's B1.3, as planned.

---

## How to reproduce

```bash
npm ci && make prepush && git status --short          # must print nothing
node bin/seed.mjs --verify                            # exit 0
node bin/doctor.mjs --json                            # ok:true, mcp_servers warn
TL_DATA_DIR=$(mktemp -d) node bin/seed.mjs --reset && TL_DATA_DIR=$SAME node bin/doctor.mjs
cp -R tenant /tmp/t && cp /tmp/t/policy.template.yml /tmp/t/policy.yml
TL_TENANT_DIR=/tmp/t node bin/doctor.mjs             # exit 1, tenant_policy fail
cp -R fixtures/tenant /tmp/fx && <flip one byte in /tmp/fx/workers.json>
TL_FIXTURES_DIR=/tmp/fx node bin/doctor.mjs          # exit 1, fixtures_seeded fail
```

The probe scripts used for checks 6, 7 and 8 were written outside the repo (they import
`lib/**/*.ts` by absolute path) and are not committed. No source file, fixture or config was
modified by this test pass; the only write is this report.
