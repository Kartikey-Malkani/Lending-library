/**
 * CSV output.
 *
 * Only the writing side is hand-rolled — escaping is a handful of rules and is
 * tested directly. Parsing is left to `csv-parse`, because reading CSV has
 * genuinely awkward cases (quoted commas, doubled quotes, embedded newlines,
 * BOM, CRLF) that a hand-rolled splitter gets subtly wrong, and this project's
 * import has to attribute failures to the right row.
 */

/** RFC 4180: quote a field that contains a comma, a quote, CR or LF. */
const NEEDS_QUOTING = /[",\r\n]/;

/**
 * Leading characters a spreadsheet may treat as the start of a formula.
 *
 * Item titles and borrower names are user input, and this file exists to be
 * opened in Excel or Sheets, so a title of `=HYPERLINK(...)` would otherwise be
 * evaluated rather than displayed. Prefixing with an apostrophe makes the cell
 * literal text; the apostrophe is not shown by the spreadsheet.
 *
 * Deliberately a small defensive measure, not a sanitisation framework: the
 * value is not altered beyond the prefix, and nothing is stripped.
 */
const FORMULA_PREFIX = /^[=+\-@\t\r]/;

export function escapeCsvField(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return '';

  const raw = String(value);
  const guarded = FORMULA_PREFIX.test(raw) ? `'${raw}` : raw;

  if (!NEEDS_QUOTING.test(guarded)) return guarded;
  return `"${guarded.replace(/"/g, '""')}"`;
}

export function toCsvRow(fields: readonly (string | number | null | undefined)[]): string {
  return fields.map(escapeCsvField).join(',');
}

/** A complete document, CRLF-delimited per RFC 4180, with a trailing newline. */
export function toCsvDocument(
  header: readonly string[],
  rows: readonly (readonly (string | number | null | undefined)[])[],
): string {
  return [toCsvRow(header), ...rows.map(toCsvRow)].join('\r\n') + '\r\n';
}
