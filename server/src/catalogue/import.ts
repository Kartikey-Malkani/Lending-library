import { parse } from 'csv-parse/sync';
import { ApiError } from '../http/errors.js';
import { createItem } from './service.js';
import { catalogueItemInputSchema, describeFieldIssues } from './validation.js';

/**
 * Bulk import of catalogue items from CSV.
 *
 * The brief's requirement is partial success: "every valid row is still
 * imported" alongside "a per-row report naming exactly which rows failed and
 * why". Two things follow from that, and they shape the whole module.
 *
 * First, **one transaction per row**. Wrapping the file in a single transaction
 * would make one malformed row roll back every good one, which is the exact
 * opposite of what is asked. Each row is its own `createItem` call, so rows
 * succeed and fail independently.
 *
 * Second, **no separate validation semantics**. Every row goes through the same
 * schema and the same `createItem` service that `POST /api/items` uses, so an
 * imported item is held to exactly the rules a hand-created one is. In
 * particular the unique index on `code` stays authoritative for duplicates —
 * this module never pre-checks whether a code exists and then inserts, because
 * that check is stale the moment a concurrent request commits.
 */

export const IMPORT_COLUMNS = ['title', 'category', 'code'] as const;
export const MAX_IMPORT_ROWS = 1000;

export type ImportRowResult =
  | { row: number; ok: true; itemId: string; code: string }
  | { row: number; ok: false; code: string; message: string };

export type ImportReport = {
  imported: number;
  failed: number;
  results: ImportRowResult[];
};

type ParsedRecord = { row: number; fields: string[] };

/**
 * Splits the upload into a header and numbered records.
 *
 * Row numbers come from `info.records`, not from the file's line count. That is
 * the number a spreadsheet shows: the header is row 1, the first data row is
 * row 2, and a quoted field containing a newline stays inside one row rather
 * than pushing every later number out of step. Reporting file lines would be
 * correct for a text editor and wrong for the tool people actually open a CSV
 * in.
 */
function parseCsv(text: string): { header: string[]; records: ParsedRecord[] } {
  let parsed: { info: { records: number }; record: string[] }[];

  try {
    parsed = parse(text, {
      bom: true,
      info: true,
      // Tolerate rows with the wrong number of fields so a single bad row is
      // reported as one failure instead of aborting the entire file.
      relax_column_count: true,
      skip_empty_lines: true,
      trim: false,
    }) as unknown as { info: { records: number }; record: string[] }[];
  } catch {
    // A parse failure means the upload is not CSV at all — an unterminated
    // quote, for instance. Nothing about the parser's internals is echoed back.
    throw ApiError.badRequest('The uploaded file could not be read as CSV.');
  }

  const first = parsed[0];
  if (!first) throw ApiError.badRequest('The CSV file is empty.');

  return {
    header: first.record.map((column) => column.trim().toLowerCase()),
    records: parsed.slice(1).map((entry) => ({ row: entry.info.records, fields: entry.record })),
  };
}

/** The header is validated explicitly, before a single row is imported. */
function assertHeader(header: string[]): void {
  const missing = IMPORT_COLUMNS.filter((column) => !header.includes(column));
  const unexpected = header.filter(
    (column) => !(IMPORT_COLUMNS as readonly string[]).includes(column),
  );

  if (missing.length === 0 && unexpected.length === 0) return;

  const details: { field: string; message: string }[] = [
    ...missing.map((column) => ({ field: 'header', message: `Missing column: ${column}` })),
    ...unexpected.map((column) => ({ field: 'header', message: `Unexpected column: ${column}` })),
  ];

  throw ApiError.badRequest(
    `The CSV header must be exactly: ${IMPORT_COLUMNS.join(', ')}.`,
    details,
  );
}

export async function importCatalogueItems(
  csvText: string,
  createdById: string,
): Promise<ImportReport> {
  const { header, records } = parseCsv(csvText);
  assertHeader(header);

  if (records.length === 0) {
    throw ApiError.badRequest('The CSV file contains a header but no rows.');
  }
  if (records.length > MAX_IMPORT_ROWS) {
    throw ApiError.badRequest(
      `Too many rows: ${records.length}. The limit is ${MAX_IMPORT_ROWS} per import.`,
    );
  }

  const index = Object.fromEntries(header.map((column, position) => [column, position]));
  const results: ImportRowResult[] = [];

  for (const { row, fields } of records) {
    if (fields.length !== header.length) {
      results.push({
        row,
        ok: false,
        code: 'bad_request',
        message: `Expected ${header.length} columns, found ${fields.length}.`,
      });
      continue;
    }

    const parsed = catalogueItemInputSchema.safeParse({
      title: fields[index.title!],
      category: fields[index.category!],
      code: fields[index.code!],
    });

    if (!parsed.success) {
      results.push({
        row,
        ok: false,
        code: 'bad_request',
        message: describeFieldIssues(parsed.error),
      });
      continue;
    }

    try {
      // The same service the single-item endpoint calls, in its own
      // transaction. A duplicate code surfaces here as the unique index
      // rejecting the insert — including a code duplicated earlier in this very
      // file, because that earlier row has already committed.
      const item = await createItem(parsed.data, createdById);
      results.push({ row, ok: true, itemId: item.id, code: item.code });
    } catch (error) {
      if (error instanceof ApiError) {
        results.push({ row, ok: false, code: error.code, message: error.message });
        continue;
      }
      // Anything unexpected is logged for us and reported blandly to the
      // caller: an import report is not the place to leak SQL.
      console.error(`Unexpected error importing row ${row}:`, error);
      results.push({
        row,
        ok: false,
        code: 'internal_error',
        message: 'This row could not be imported.',
      });
    }
  }

  return {
    imported: results.filter((result) => result.ok).length,
    failed: results.filter((result) => !result.ok).length,
    results,
  };
}
