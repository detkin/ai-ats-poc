# Progress

## M0 — Skeleton: DONE (2026-09-02)

**Shipped** (commits `4f8c11f`…`404d17e` on `main`):
- Toolchain: TypeScript ESM on Node 24 with native type stripping (no build), `vitest`, ESLint + Prettier, `make prepush`. Subpath imports (`#lib/...`), relative imports are a lint error.
- `lib/types` (Tier-1 real entities, Tier-2/3 `tl_*` objects with a compile-time guard that engine records never carry Tier-1 values), `lib/ports` (Graph, Ats, Bands, Availability, Channel, State, Ledger; ledger has no update/delete, state has no delete), `lib/safety` (write allowlist + untrusted-content detector), `DATA_CONTRACT.md`.
- `templates/loop-states.yml` + validator; `tenant/policy.yml` (machine-readable policy) + template + validator.
- Fixture tenant: 120 workers / 6 depts / 108 bands / 3 open + 1 closed req / 40 candidates / 44 applications / 17 absences / 96 prior ratings / 1 configured review cycle; deterministic generator, manifest with hashes, `bin/seed.mjs --verify|--reset`.
- `bin/doctor.mjs` with 9 checks; healthy on fixtures.
- 224 tests.

**Tester found** (`docs/testing/M0-report.md`): PASS, 10/10 checks. Three low defects: `bin/seed.mjs` carries logic and re-resolves `TL_DATA_DIR` (fix assigned to M1's CLI block, see D11); two decisions were undocumented (now D9, D10).

**Next:** M1 — engine core + fixture adapters (parallel), then CLIs + modes (parallel), then the M1 tester running the spec §8 loop-1 demo.

## M1 — Engine + review cycle: DONE (2026-09-02)

**Shipped** (commits `6d54188`…`c08c6be` on `main`):
- `lib/engine/*`: pure tick planner (detect → plan → apply), review-cycle participants/tasks, calibration packet with per-claim citations and a golden.
- `lib/adapters/fixture/*` for all seven ports, every call ledgered with actor + permission context; write allowlist enforced in the adapter; rippling stubs with the 31 real `codemode.*` names; per-cycle mkdir lock.
- Ten thin CLIs: `tick cycle propose decide nudge packet audit verify-loops doctor seed`.
- Router skill `.claude/skills/talent-loops/SKILL.md` (49 lines), `modes/_shared _tenant _custom review-cycle`.
- 535 tests.

**Tester** (`docs/testing/M1-report.md`): first run FAIL (nudges fanned out per task, audit missed record-addressed CLIs, doctor not thin, walkthrough claimed things the engine does not do). Fixed in one block (D17–D20: batched nudges per recipient, cycle-scoped audit, holidays quiet but never move deadlines). Re-run: PASS 13/13. Demo story verified from state, outbox and ledger: PTO'd manager gets no nudge and a moved due date; one escalation with 111 evidence refs and one DM; injected résumé → one anomaly, no action; second tick byte-identical state and read-only ledger growth; packet cites every number; verify-loops passes and fails loudly on injected drift.

**Open observation to fold into M2:** `nudge.mjs --task` on one task consumes the recipient's whole 48 h gap; the mode should say so or the CLI should nudge the recipient's bundle.

**Next:** M2 — availability composition + interview engine functions, then the interview-loop mode and wiring, then the M2 tester (spec §8 loop 2).

## M2 — Interview loop on the same engine: DONE (2026-09-02)

**Shipped** (commits `22a63cd`…`41923b8` on `main`):
- `lib/availability/compose.ts`: Rippling absence is authoritative, Google Calendar free/busy (fixture) is secondary and only consulted for people Rippling says are present; holds refuse absent attendees. Labeled seam for Smart Scheduling.
- `lib/engine/interview-loop.ts`, `interview-plan.ts`, `packet-debrief.ts`: panel, slot, substitute (same team, same level rank, never a prior decliner), scorecard completion, cited debrief with PII stripped and injected text withheld.
- `modes/interview-loop.md`, CLI dispatch on `cycle.type`, four new action kinds; advance/reject exist only as `tl_proposed_action`.
- M1 follow-ups: `nudge.mjs --task` bundles the recipient's tasks; attendance is never nudged; holidays keep due dates.
- 663 tests.

**Claim 1 proven** ("one primitive, many loops"): M2's footprint on the shared planner is two imports, one predicate, one `cycle.type` dispatch; the same ten CLIs run both loops; the M1 review-cycle numbers are unchanged at HEAD.

**Tester** (`docs/testing/M2-report.md`): first run FAIL (a second decline re-booked the first decliner; two rebooks in one tick clobbered each other; verify-loops did not catch it; proposal evidence omitted the packet). Fixed in one block (D24). Re-run: PASS 13/13. Loop-2 story verified: interviewer declines → same-level peer re-booked and posted to `#people-ops` → scorecards chased → debrief cites every quote → advance only ever a proposal; the real application record is byte-identical afterwards.

**Carry-forwards (not blocking):** the substitute never receives an interviewer brief; `lib/cli/verify.ts` is at 610 lines and should split before M3; the Channel port needs an author field before a real Slack adapter (Q7).

## Checkpoint — first run complete (M0–M2)

Next, per user direction: **M2.5 live Rippling smoke** once the Rippling MCP is authorized (`docs/PLAN.md` §7). Then decide on M3–M5.
