# Talent Loops POC

Agent-first talent loops on Rippling: one cycle engine (detect → do → escalate → close) that runs a
performance review cycle, an interview loop, and a req/offer approval loop as *configurations*, with
every write logged and every decision of record left to a named human.

- Spec: `docs/SPEC.md` (v0.2). Plan: `docs/PLAN.md`. Status: `docs/PROGRESS.md`.
- Stack: TypeScript ESM on Node 24 (native type stripping, no build step), `vitest`, ESLint + Prettier.
- Adapters: `TL_ADAPTER=fixture` (default, no network) or `rippling` (stubs until a tenant exists).

```bash
npm install
make prepush      # format, lint, typecheck, test
npm run doctor    # cold-start health check
```

Imports use package subpath aliases (`#lib/...`, `#tests/...`), never relative paths.
