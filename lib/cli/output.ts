/**
 * lib/cli/output.ts — one shape for what a CLI says, in two renderings (block B1.3).
 *
 * Owns: `CliOutput` (`{ code, data, lines }`) and the two renderers. `--json` prints
 * `data` and nothing else, so `JSON.parse(stdout)` always works; otherwise `lines` are
 * printed as concise human text. A CLI never calls `console.log` itself: it returns a
 * `CliOutput` and `lib/cli/runtime.ts` writes it, which is what keeps `bin/*.mjs` thin.
 *
 * Public interface: `CliOutput`, `ok`, `fail`, `render`, `writeOutput`, `table`.
 *
 * Spec: docs/PLAN.md §2.9 (`--json` for the machine form), §4 block B1.3.
 */

/** The complete result of one CLI run. `code` becomes the process exit code. */
export interface CliOutput {
  code: number;
  /** Machine form, printed verbatim under `--json`. */
  data: unknown;
  /** Human form, one line each. */
  lines: string[];
}

/** A successful run (exit 0). */
export function ok(data: unknown, lines: string[]): CliOutput {
  return { code: 0, data, lines };
}

/** A domain failure (exit 1 by default): drift, an unknown id, a refused transition. */
export function fail(data: unknown, lines: string[], code = 1): CliOutput {
  return { code, data, lines };
}

/** Render an output for the chosen mode. Always ends with exactly one newline. */
export function render(output: CliOutput, json: boolean): string {
  if (json) return `${JSON.stringify(output.data, null, 2)}\n`;
  return output.lines.length === 0 ? '' : `${output.lines.join('\n')}\n`;
}

/** Write to stdout and hand back the exit code. */
export function writeOutput(output: CliOutput, json: boolean): number {
  const body = render(output, json);
  if (body.length > 0) process.stdout.write(body);
  return output.code;
}

/**
 * A markdown table from a header row and body rows. Columns are padded so the text form
 * is readable in a terminal and still valid markdown for `audit --format md`.
 */
export function table(headers: string[], rows: string[][]): string[] {
  const widths = headers.map((header, column) =>
    Math.max(header.length, ...rows.map((row) => (row[column] ?? '').length)),
  );
  const line = (cells: string[]): string =>
    `| ${cells.map((cell, column) => (cell ?? '').padEnd(widths[column] ?? 0)).join(' | ')} |`;
  return [
    line(headers),
    `| ${widths.map((width) => '-'.repeat(Math.max(3, width))).join(' | ')} |`,
    ...rows.map(line),
  ];
}
