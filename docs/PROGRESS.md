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

## M1 — Engine + review cycle: IN PROGRESS
