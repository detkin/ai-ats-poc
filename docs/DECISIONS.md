# Decisions log

Deviations from `docs/SPEC.md` v0.2 mechanics, and choices the spec left open. Spec claims (§1) always win.

| # | Date | Decision | Why |
|---|---|---|---|
| D1 | 2026-09-02 | No build step: Node 24 native type stripping; `bin/*.mjs` import `#lib/**/*.ts` directly; `tsx` kept only as a dev convenience. `tsconfig` uses `erasableSyntaxOnly` (no `enum`). | Spec §11 says "no build step for the demo"; verified working on Node 24.5. |
| D2 | 2026-09-02 | Imports use package subpath aliases (`#lib/...`) — never relative. Enforced by ESLint. | House rule (global CLAUDE.md). |
| D3 | 2026-09-02 | Tenant policy is machine-readable YAML at `tenant/policy.yml`; `modes/_tenant.md` is prose generated over it. Doctor's "template policy" check reads `template: true` in the YAML. | Spec §5: "policy is data, not prompt". A markdown-only `_tenant.md` would make the engine parse prose. |
| D4 | 2026-09-02 | Runtime Tier-2/3 state on fixtures lives in `TL_DATA_DIR` (default `./data`, gitignored) as JSON arrays + `ledger.jsonl`; `fixtures/tenant/` is read-only seed. | Tick mutates state; tests need fresh copies; fixtures must stay reproducible. |
| D5 | 2026-09-02 | Fixture tenant has 3 OPEN reqs (spec) plus one CLOSED historical req so rediscovery (M4) has silver medalists ~4 months old. | Spec §8 loop-4 demo needs them; adding later would churn the manifest. |
| D6 | 2026-09-02 | Commit messages end with the `Co-Authored-By: Claude Fable 5.1` trailer per the project mandate, overriding the global commit-message skill's "no co-author" rule. | Project CLAUDE.md is more specific. |
| D7 | 2026-09-02 | Nudge text is templated with injected facts (no LLM call on the tick path in the POC). LLM use is reserved for packet summaries and is marked `derived`. | Spec §7 "LLM use is narrow"; keeps ticks deterministic and evals cheap. |
| D8 | 2026-09-02 | Frozen clock via `TL_NOW`; fixtures anchored at `2026-09-02T16:00:00Z`. | Idempotence and golden tests need a fixed "now". |
| D9 | 2026-09-02 | The seeded review cycle `tl_cycle_h2_2026` ships with `status: configured` and `opened_at: null`. `cycle.mjs open` sets `opened_at` (the plan's 2026-08-24 was the intended open date, not a seeded value) and creates the tasks. | Opening is a ledgered write and belongs to the CLI, not the fixture. |
| D10 | 2026-09-02 | Spec §6 reference columns are implemented with explicit suffixes: `cycle_id`, `owner_worker_id`, `participant_worker_id`, `decided_by_worker_id`, etc. | Consistent with the ledger's `cycle_id`; removes ambiguity between an id and an embedded value. |
| D11 | 2026-09-02 | `bin/*.mjs` must be thin: arg parsing + one `lib/cli/*.ts` call + rendering. `bin/seed.mjs` violates this today (tester defect D-1/D-2); B1.3 moves its logic to `lib/cli/seed.ts` and uses `loadConfig()`. | Logic in a CLI is untestable except by subprocess, and eight more CLIs arrive in M1. |
