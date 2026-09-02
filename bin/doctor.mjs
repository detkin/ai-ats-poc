#!/usr/bin/env node
/**
 * bin/doctor.mjs — cold-start health check (block B0.5).
 *
 * Owns: nothing but argument parsing and exit codes. All logic lives in
 * `#lib/doctor/index.ts`; this file is the thin CLI the spec's §5 tree calls
 * `doctor.mjs` ("MCP connected? adapter mode? tenant policy still a template?
 * fixtures seeded?").
 *
 * Usage:  node bin/doctor.mjs [--json] [--help]
 * Exit:   0 when every check is ok or warn; 1 when any check fails, or when the
 *         environment itself is invalid (ConfigError); 2 on a bad argument.
 */

import { ConfigError, loadConfig } from '#lib/config.ts';
import { renderJson, renderText, runDoctor } from '#lib/doctor/index.ts';

const USAGE = `Usage: node bin/doctor.mjs [--json]

Reports whether this checkout can run a Talent Loops tick.

Options:
  --json   machine-readable report: { ok, summary, checks: [{ id, status, detail, fix? }] }
  --help   show this message

Exit codes: 0 healthy (ok/warn only), 1 at least one failing check, 2 bad argument.

Environment: TL_ADAPTER TL_NOW TL_DATA_DIR TL_TENANT_DIR TL_FIXTURES_DIR TL_ACTOR TL_LOCK_STALE_MS`;

function parseArgs(argv) {
  const options = { json: false, help: false };
  for (const arg of argv) {
    if (arg === '--json') options.json = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else {
      process.stderr.write(`doctor: unknown argument "${arg}"\n${USAGE}\n`);
      process.exit(2);
    }
  }
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }

  let config;
  try {
    config = loadConfig();
  } catch (cause) {
    if (cause instanceof ConfigError) {
      const body = options.json
        ? `${JSON.stringify({ ok: false, error: 'ConfigError', detail: cause.message }, null, 2)}\n`
        : `doctor: invalid environment — ${cause.message}\n`;
      process.stderr.write(body);
      return 1;
    }
    throw cause;
  }

  const report = await runDoctor(config);
  process.stdout.write(
    options.json ? `${renderJson(report)}\n` : `${renderText(report, config)}\n`,
  );
  return report.ok ? 0 : 1;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error) => {
    process.stderr.write(`doctor: ${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  },
);
