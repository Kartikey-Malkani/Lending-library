import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { escapeCsvField } from '../src/http/csv.js';
import { loginAs, seedItem } from './helpers/items.js';
import { dateString, directIssue, markLost, requestLoan, returnLoan } from './helpers/loans.js';
import {
  createLibrarian,
  createMember,
  LIBRARIAN_PASSWORD,
  MEMBER_PASSWORD,
} from './helpers/users.js';

/**
 * GET /api/loans/export.csv — every item currently out on loan.
 *
 * "Currently out" is `status = 'issued'`. That reading comes from the brief:
 * it asks for each item "with its borrower and due date", and a requested loan
 * has no due date at all — the database forbids one.
 */

const app = createApp();

let librarianId: string;
let memberId: string;
let librarianCookie: string;
let memberCookie: string;

beforeEach(async () => {
  librarianId = (await createLibrarian('alex@test.local')).id;
  memberId = (await createMember('sam@test.local')).id;
  librarianCookie = await loginAs(app, 'alex@test.local', LIBRARIAN_PASSWORD);
  memberCookie = await loginAs(app, 'sam@test.local', MEMBER_PASSWORD);
});

function exportCsv(cookie: string) {
  return request(app).get('/api/loans/export.csv').set('Cookie', cookie);
}

async function issueOn(code: string, options: { title?: string; dueInDays?: number } = {}) {
  const item = await seedItem(librarianId, { code, ...(options.title ? { title: options.title } : {}) });
  const response = await directIssue(app, librarianCookie, {
    itemId: item.id,
    borrowerId: memberId,
    dueOn: dateString(options.dueInDays ?? 7),
  });
  return { itemId: item.id, loanId: response.body.loan.id as string };
}

/** Splits a CSV document into records, respecting quoted newlines. */
function parseCsvRecords(csv: string): string[][] {
  const records: string[][] = [];
  let field = '';
  let record: string[] = [];
  let inQuotes = false;

  for (let i = 0; i < csv.length; i += 1) {
    const char = csv[i]!;
    if (inQuotes) {
      if (char === '"' && csv[i + 1] === '"') {
        field += '"';
        i += 1;
      } else if (char === '"') {
        inQuotes = false;
      } else {
        field += char;
      }
    } else if (char === '"') {
      inQuotes = true;
    } else if (char === ',') {
      record.push(field);
      field = '';
    } else if (char === '\r' && csv[i + 1] === '\n') {
      record.push(field);
      records.push(record);
      record = [];
      field = '';
      i += 1;
    } else {
      field += char;
    }
  }
  if (field !== '' || record.length > 0) {
    record.push(field);
    records.push(record);
  }
  return records;
}

describe('authorization', () => {
  it('rejects an unauthenticated request with 401', async () => {
    expect((await request(app).get('/api/loans/export.csv')).status).toBe(401);
  });

  it('rejects a member with 403', async () => {
    const response = await exportCsv(memberCookie);

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('forbidden');
  });

  it('is not shadowed by the /loans/:id route', async () => {
    // `export.csv` is not a uuid, so if `:id` matched first this would 404.
    const response = await exportCsv(librarianCookie);
    expect(response.status).toBe(200);
  });
});

describe('what the export contains', () => {
  it('includes exactly the issued loans and nothing else', async () => {
    await issueOn('OUT-1');
    await issueOn('OUT-2', { dueInDays: -5 }); // overdue, still issued, still out

    const returned = await issueOn('BACK-1');
    await returnLoan(app, librarianCookie, returned.loanId);

    const lost = await issueOn('GONE-1');
    await markLost(app, librarianCookie, lost.loanId);

    const requestedItem = await seedItem(librarianId, { code: 'WAIT-1' });
    await requestLoan(app, memberCookie, requestedItem.id);

    await seedItem(librarianId, { code: 'SHELF-1' }); // never loaned

    const response = await exportCsv(librarianCookie);
    const records = parseCsvRecords(response.text);
    const codes = records.slice(1).map((row) => row[0]);

    expect(codes.sort()).toEqual(['OUT-1', 'OUT-2']);
  });

  it('includes an archived item that still has an issued loan', async () => {
    const { itemId } = await issueOn('ARCH-1');
    await request(app).post(`/api/items/${itemId}/archive`).set('Cookie', librarianCookie);

    const records = parseCsvRecords((await exportCsv(librarianCookie)).text);

    // Archiving withdraws an item from circulation but does not end a loan
    // already in someone's hands — those are exactly the ones to chase.
    expect(records.slice(1).map((row) => row[0])).toEqual(['ARCH-1']);
  });

  it('emits the agreed header even when nothing is out', async () => {
    const response = await exportCsv(librarianCookie);
    const records = parseCsvRecords(response.text);

    expect(records).toHaveLength(1);
    expect(records[0]).toEqual([
      'item_code',
      'item_title',
      'borrower_name',
      'borrower_email',
      'issued_on',
      'due_on',
      'days_overdue',
    ]);
  });

  it('carries the borrower and due date the brief asks for', async () => {
    await issueOn('COL-1', { title: 'Canon EOS R6' });

    const records = parseCsvRecords((await exportCsv(librarianCookie)).text);
    const row = records[1]!;

    expect(row[0]).toBe('COL-1');
    expect(row[1]).toBe('Canon EOS R6');
    expect(row[2]).toBe('Test Member');
    expect(row[3]).toBe('sam@test.local');
    expect(row[4]).toMatch(/^\d{4}-\d{2}-\d{2}$/); // issued_on
    expect(row[5]).toBe(dateString(7)); // due_on
    expect(row[6]).toBe('0'); // not overdue
  });

  it('reports days overdue for a loan past its due date', async () => {
    await issueOn('LATE-1', { dueInDays: -12 });

    const records = parseCsvRecords((await exportCsv(librarianCookie)).text);
    expect(records[1]![6]).toBe('12');
  });
});

describe('ordering', () => {
  it('is deterministic, most urgent first, and stable across calls', async () => {
    await issueOn('DUE-C', { dueInDays: 30 });
    await issueOn('DUE-A', { dueInDays: -10 });
    await issueOn('DUE-B', { dueInDays: 3 });

    const first = parseCsvRecords((await exportCsv(librarianCookie)).text).slice(1);
    const again = parseCsvRecords((await exportCsv(librarianCookie)).text).slice(1);

    expect(first.map((row) => row[0])).toEqual(['DUE-A', 'DUE-B', 'DUE-C']);
    expect(again.map((row) => row[0])).toEqual(first.map((row) => row[0]));
  });
});

describe('CSV escaping', () => {
  it('quotes commas, doubles quotes and preserves embedded newlines', async () => {
    const item = await seedItem(librarianId, {
      code: 'ESC-1',
      title: 'Tripod, "carbon" fibre\nwith a note',
    });
    await directIssue(app, librarianCookie, {
      itemId: item.id,
      borrowerId: memberId,
      dueOn: dateString(7),
    });

    const response = await exportCsv(librarianCookie);

    // The raw document quotes the field and doubles the inner quotes...
    expect(response.text).toContain('"Tripod, ""carbon"" fibre');
    // ...and a compliant reader recovers the original value exactly.
    const records = parseCsvRecords(response.text);
    expect(records[1]![1]).toBe('Tripod, "carbon" fibre\nwith a note');
    // The embedded newline did not create a spurious record.
    expect(records).toHaveLength(2);
  });

  it('neutralises a value a spreadsheet would treat as a formula', async () => {
    const item = await seedItem(librarianId, { code: 'INJ-1', title: '=HYPERLINK("http://x","click")' });
    await directIssue(app, librarianCookie, {
      itemId: item.id,
      borrowerId: memberId,
      dueOn: dateString(7),
    });

    const records = parseCsvRecords((await exportCsv(librarianCookie)).text);

    // Prefixed with an apostrophe so Excel shows it as text rather than
    // evaluating it. The original characters are all still present.
    expect(records[1]![1]).toBe(`'=HYPERLINK("http://x","click")`);
  });

  it('escapes each dangerous leading character', () => {
    for (const prefix of ['=', '+', '-', '@', '\t', '\r']) {
      expect(escapeCsvField(`${prefix}danger`).replace(/^"|"$/g, '')).toMatch(/^'/);
    }
    expect(escapeCsvField('safe value')).toBe('safe value');
    expect(escapeCsvField(null)).toBe('');
    expect(escapeCsvField(0)).toBe('0');
  });
});

describe('response headers', () => {
  it('is served as a downloadable CSV attachment', async () => {
    const response = await exportCsv(librarianCookie);

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toMatch(/^text\/csv/);
    expect(response.headers['content-type']).toMatch(/charset=utf-8/);
    expect(response.headers['content-disposition']).toMatch(
      /^attachment; filename="items-on-loan-\d{4}-\d{2}-\d{2}\.csv"$/,
    );
  });
});
