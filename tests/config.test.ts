/**
 * Tests for `lib/config.ts` (block B0.5).
 *
 * Covers: the zero-environment defaults; `TL_NOW` really freezes the clock (and
 * `now()` hands back a fresh, equal Date each call); every knob that must throw
 * `ConfigError` rather than silently degrade; directory overrides resolving to
 * absolute paths; the repo root coming from `import.meta.url`, not the cwd.
 */

import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  ADAPTER_MODES,
  ConfigError,
  DEFAULT_LOCK_STALE_MS,
  ENV_KEYS,
  loadConfig,
  now,
  repoRoot,
} from '#lib/config.ts';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ANCHOR = '2026-09-02T16:00:00Z';

/** Config is env-only: an empty object is a legitimate, fully defaulted environment. */
const EMPTY: NodeJS.ProcessEnv = {};

describe('loadConfig defaults', () => {
  it('runs on fixtures with no environment at all', () => {
    const config = loadConfig(EMPTY);
    expect(config.adapter).toBe('fixture');
    expect(config.nowFrozen).toBe(false);
    expect(config.actor).toBeUndefined();
    expect(config.lockStaleMs).toBe(DEFAULT_LOCK_STALE_MS);
    expect(DEFAULT_LOCK_STALE_MS).toBe(10 * 60 * 1000);
  });

  it('defaults every directory under the repo root', () => {
    const config = loadConfig(EMPTY);
    expect(config.repoRoot).toBe(REPO_ROOT);
    expect(config.dataDir).toBe(path.join(REPO_ROOT, 'data'));
    expect(config.tenantDir).toBe(path.join(REPO_ROOT, 'tenant'));
    expect(config.fixturesDir).toBe(path.join(REPO_ROOT, 'fixtures', 'tenant'));
  });

  it('resolves the repo root from import.meta.url, not the cwd', () => {
    expect(repoRoot()).toBe(REPO_ROOT);
    expect(existsSync(path.join(repoRoot(), 'package.json'))).toBe(true);
  });

  it('treats blank env values as unset', () => {
    const config = loadConfig({ TL_ADAPTER: '  ', TL_ACTOR: '', TL_NOW: '   ' });
    expect(config.adapter).toBe('fixture');
    expect(config.actor).toBeUndefined();
    expect(config.nowFrozen).toBe(false);
  });
});

describe('adapter mode', () => {
  it.each([...ADAPTER_MODES])('accepts %s', (mode) => {
    expect(loadConfig({ [ENV_KEYS.adapter]: mode }).adapter).toBe(mode);
  });

  it('throws ConfigError naming the variable for an unknown adapter', () => {
    expect(() => loadConfig({ [ENV_KEYS.adapter]: 'greenhouse' })).toThrow(ConfigError);
    expect(() => loadConfig({ [ENV_KEYS.adapter]: 'greenhouse' })).toThrow(/TL_ADAPTER/);
    expect(() => loadConfig({ [ENV_KEYS.adapter]: 'Fixture' })).toThrow(ConfigError);
  });
});

describe('frozen clock', () => {
  it('freezes now at the TL_NOW instant', () => {
    const config = loadConfig({ [ENV_KEYS.now]: ANCHOR });
    expect(config.nowFrozen).toBe(true);
    expect(config.now.toISOString()).toBe('2026-09-02T16:00:00.000Z');
  });

  it('returns equal instants across calls, as distinct Date objects', () => {
    const config = loadConfig({ [ENV_KEYS.now]: ANCHOR });
    const first = now(config);
    const second = now(config);
    expect(first.getTime()).toBe(second.getTime());
    expect(first).not.toBe(second);

    // Mutating a handed-out Date must not move the configured instant.
    first.setFullYear(1999);
    expect(now(config).toISOString()).toBe('2026-09-02T16:00:00.000Z');
    expect(config.now.toISOString()).toBe('2026-09-02T16:00:00.000Z');
  });

  it('accepts a bare ISO date', () => {
    const config = loadConfig({ [ENV_KEYS.now]: '2026-09-02' });
    expect(config.now.toISOString()).toBe('2026-09-02T00:00:00.000Z');
  });

  it('throws ConfigError on a non-ISO or impossible instant', () => {
    for (const bad of ['tomorrow', 'March 3 2026', '2026-13-45T99:00:00Z', '2026/09/02']) {
      expect(() => loadConfig({ [ENV_KEYS.now]: bad })).toThrow(ConfigError);
    }
    expect(() => loadConfig({ [ENV_KEYS.now]: 'tomorrow' })).toThrow(/TL_NOW/);
  });

  it('uses the wall clock when TL_NOW is unset', () => {
    const before = Date.now();
    const config = loadConfig(EMPTY);
    const after = Date.now();
    expect(config.now.getTime()).toBeGreaterThanOrEqual(before);
    expect(config.now.getTime()).toBeLessThanOrEqual(after);
  });
});

describe('directory and actor overrides', () => {
  it('honours every directory knob and resolves to absolute paths', () => {
    const config = loadConfig({
      [ENV_KEYS.dataDir]: '/tmp/tl-data',
      [ENV_KEYS.tenantDir]: '/tmp/tl-tenant',
      [ENV_KEYS.fixturesDir]: '/tmp/tl-fixtures',
      [ENV_KEYS.actor]: 'w_hrbp_001',
    });
    expect(config.dataDir).toBe(path.resolve('/tmp/tl-data'));
    expect(config.tenantDir).toBe(path.resolve('/tmp/tl-tenant'));
    expect(config.fixturesDir).toBe(path.resolve('/tmp/tl-fixtures'));
    expect(config.actor).toBe('w_hrbp_001');
  });

  it('resolves a relative directory to an absolute path', () => {
    const config = loadConfig({ [ENV_KEYS.dataDir]: 'tmp/data' });
    expect(path.isAbsolute(config.dataDir)).toBe(true);
    expect(config.dataDir.endsWith(path.join('tmp', 'data'))).toBe(true);
  });
});

describe('lock staleness', () => {
  it('accepts a positive integer', () => {
    expect(loadConfig({ [ENV_KEYS.lockStaleMs]: '5000' }).lockStaleMs).toBe(5000);
  });

  it('rejects zero, negatives and non-numbers', () => {
    for (const bad of ['0', '-1', 'soon', '1.5']) {
      expect(() => loadConfig({ [ENV_KEYS.lockStaleMs]: bad })).toThrow(ConfigError);
    }
  });
});
