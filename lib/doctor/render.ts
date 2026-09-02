/**
 * lib/doctor/render.ts — human and machine renderings of a doctor report (block B0.5).
 *
 * Owns: every byte `bin/doctor.mjs` prints. Rendering is pure — it never reads the
 * filesystem or the environment — so the CLI stays a thin `loadConfig → runDoctor →
 * render` shell and the output is testable without spawning a process. Spec §5.
 *
 * Public interface:
 *   STATUS_SYMBOLS               -- { ok: '✓', warn: '!', fail: '✗' }
 *   renderText(report, config?)  -- one line per check, plus fixes and a verdict
 *   renderJson(report)           -- pretty JSON: { ok, summary, checks }
 *
 * The JSON shape is a contract for the M0 tester and for `--json` consumers:
 * `{ ok: boolean, summary: { ok, warn, fail }, checks: [{ id, status, detail, fix? }] }`.
 */

import type { Config } from '#lib/config.ts';
import type { CheckStatus } from '#lib/doctor/checks.ts';
import type { DoctorReport } from '#lib/doctor/run.ts';

export const STATUS_SYMBOLS: Readonly<Record<CheckStatus, string>> = {
  ok: '✓',
  warn: '!',
  fail: '✗',
};

function padId(id: string, width: number): string {
  return id.length >= width ? id : id + ' '.repeat(width - id.length);
}

/**
 * Human-readable report.
 * @param config when given, the header names the adapter mode and the instant in use.
 */
export function renderText(report: DoctorReport, config?: Config): string {
  const lines: string[] = [];
  const header =
    config === undefined
      ? 'Talent Loops doctor'
      : `Talent Loops doctor — adapter ${config.adapter}, now ${config.now.toISOString()}` +
        `${config.nowFrozen ? ' (frozen)' : ''}`;
  lines.push(header, '');

  const width = report.checks.reduce((max, check) => Math.max(max, check.id.length), 0);
  for (const check of report.checks) {
    lines.push(`  ${STATUS_SYMBOLS[check.status]} ${padId(check.id, width)}  ${check.detail}`);
    if (check.fix !== undefined && check.status !== 'ok') {
      lines.push(`      fix: ${check.fix}`);
    }
  }

  const { ok, warn, fail } = report.summary;
  lines.push(
    '',
    `${report.checks.length} checks: ${ok} ok, ${warn} warn, ${fail} fail`,
    report.ok
      ? 'Result: healthy — the POC can run.'
      : 'Result: not ready — fix the ✗ checks above before ticking.',
  );
  return lines.join('\n');
}

/** Machine-readable report for `--json`. Key order is stable. */
export function renderJson(report: DoctorReport): string {
  return JSON.stringify(
    {
      ok: report.ok,
      summary: report.summary,
      checks: report.checks.map((check) =>
        check.fix === undefined
          ? { id: check.id, status: check.status, detail: check.detail }
          : { id: check.id, status: check.status, detail: check.detail, fix: check.fix },
      ),
    },
    null,
    2,
  );
}
