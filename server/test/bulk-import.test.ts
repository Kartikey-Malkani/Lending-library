import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { prisma } from '../src/db.js';
import { loginAs, seedItem } from './helpers/items.js';
import {
  createLibrarian,
  createMember,
  LIBRARIAN_PASSWORD,
  MEMBER_PASSWORD,
} from './helpers/users.js';

/**
 * POST /api/items/import — the catalogue-item importer.
 *
 * The brief asks for bulk import of *catalogue items*, not loans: rows carry a
 * title, a category and an identifying code, and importing one creates no loan
 * and no timeline event.
 */

const app = createApp();

type RowResult = {
  row: number;
  ok: boolean;
  itemId?: string;
  code?: string;
  message?: string;
};

let librarianId: string;
let librarianCookie: string;
let memberCookie: string;

beforeEach(async () => {
  librarianId = (await createLibrarian('alex@test.local')).id;
  await createMember('sam@test.local');
  librarianCookie = await loginAs(app, 'alex@test.local', LIBRARIAN_PASSWORD);
  memberCookie = await loginAs(app, 'sam@test.local', MEMBER_PASSWORD);
});

function upload(cookie: string, csv: string) {
  return request(app)
    .post('/api/items/import')
    .set('Cookie', cookie)
    .set('Content-Type', 'text/csv')
    .send(csv);
}

const HEADER = 'title,category,code';

describe('authorization', () => {
  it('rejects an unauthenticated upload with 401', async () => {
    const response = await request(app)
      .post('/api/items/import')
      .set('Content-Type', 'text/csv')
      .send(`${HEADER}\nThing,Cat,A-1`);

    expect(response.status).toBe(401);
  });

  it('rejects a member with 403 and imports nothing', async () => {
    const response = await upload(memberCookie, `${HEADER}\nThing,Cat,A-1`);

    expect(response.status).toBe(403);
    expect(await prisma.catalogueItem.count()).toBe(0);
  });

  it('attributes every imported item to the session librarian', async () => {
    await upload(librarianCookie, `${HEADER}\nThing,Cat,A-1`);

    const item = await prisma.catalogueItem.findFirstOrThrow();
    expect(item.createdById).toBe(librarianId);
  });
});

describe('partial success', () => {
  it('imports the valid rows and reports only the invalid ones', async () => {
    const csv = [
      HEADER,
      'Canon EOS R6,Cameras,CAM-001', // row 2 ok
      ',Cameras,CAM-002', // row 3 blank title
      'DeWalt drill,Tools,TOOL-001', // row 4 ok
      'No code,Tools,', // row 5 blank code
      'Makita saw,Tools,TOOL-002', // row 6 ok
    ].join('\n');

    const response = await upload(librarianCookie, csv);

    expect(response.status).toBe(200);
    expect(response.body.imported).toBe(3);
    expect(response.body.failed).toBe(2);

    // The valid rows really are in the database — the failures did not roll
    // them back.
    const codes = (await prisma.catalogueItem.findMany({ orderBy: { code: 'asc' } })).map(
      (i) => i.code,
    );
    expect(codes).toEqual(['CAM-001', 'TOOL-001', 'TOOL-002']);
  });

  it('numbers rows the way a spreadsheet does, header as row 1', async () => {
    const csv = [HEADER, 'Good,Cat,G-1', ',Cat,B-1', 'Also good,Cat,G-2'].join('\n');

    const response = await upload(librarianCookie, csv);
    const results: RowResult[] = response.body.results;

    expect(results.map((r) => r.row)).toEqual([2, 3, 4]);
    expect(results.find((r) => r.row === 3)!.ok).toBe(false);
  });

  it('keeps row numbers correct when a quoted field contains a newline', async () => {
    const csv = [
      HEADER,
      'First,Cat,F-1',
      '"Title with\nan embedded newline",Cat,N-1',
      ',Cat,BAD-1',
    ].join('\n');

    const response = await upload(librarianCookie, csv);
    const results: RowResult[] = response.body.results;

    // The multi-line record is one spreadsheet row, so the failing row after it
    // is row 4 — not 5, which is where it sits in the raw file.
    expect(results.map((r) => r.row)).toEqual([2, 3, 4]);
    expect(results[2]!.ok).toBe(false);
    expect(await prisma.catalogueItem.findFirst({ where: { code: 'N-1' } })).not.toBeNull();
  });

  it('imports nothing but still reports when every row is invalid', async () => {
    const response = await upload(librarianCookie, [HEADER, ',,', ',Cat,'].join('\n'));

    expect(response.status).toBe(200);
    expect(response.body.imported).toBe(0);
    expect(response.body.failed).toBe(2);
    expect(await prisma.catalogueItem.count()).toBe(0);
  });
});

describe('duplicate codes', () => {
  it('lets the first occurrence in a file win and fails the later one', async () => {
    const csv = [HEADER, 'First,Cat,DUP-1', 'Second,Cat,DUP-1', 'Third,Cat,OK-1'].join('\n');

    const response = await upload(librarianCookie, csv);
    const results: RowResult[] = response.body.results;

    expect(results[0]).toMatchObject({ row: 2, ok: true, code: 'DUP-1' });
    expect(results[1]).toMatchObject({ row: 3, ok: false, code: 'duplicate_code' });
    expect(results[2]).toMatchObject({ row: 4, ok: true, code: 'OK-1' });

    const stored = await prisma.catalogueItem.findMany({ where: { code: 'DUP-1' } });
    expect(stored).toHaveLength(1);
    expect(stored[0]!.title).toBe('First');
  });

  it('fails a row whose code already exists in the catalogue', async () => {
    await seedItem(librarianId, { code: 'EXISTING-1' });

    const response = await upload(
      librarianCookie,
      [HEADER, 'New thing,Cat,EXISTING-1', 'Fine,Cat,NEW-1'].join('\n'),
    );

    expect(response.body.results[0]).toMatchObject({ ok: false, code: 'duplicate_code' });
    expect(response.body.results[1]!.ok).toBe(true);
  });

  it('treats codes case-insensitively, as the single-item endpoint does', async () => {
    const response = await upload(
      librarianCookie,
      [HEADER, 'First,Cat,dup-2', 'Second,Cat,DUP-2'].join('\n'),
    );

    expect(response.body.imported).toBe(1);
    expect(response.body.results[1]).toMatchObject({ ok: false, code: 'duplicate_code' });
  });
});

describe('row validation matches the single-item endpoint', () => {
  it('rejects blank, oversized and missing fields', async () => {
    const csv = [
      HEADER,
      '   ,Cat,W-1', // blank title
      'Fine,   ,W-2', // blank category
      'Fine,Cat,   ', // blank code
      `${'x'.repeat(201)},Cat,W-4`, // title too long
      `Fine,${'y'.repeat(101)},W-5`, // category too long
      `Fine,Cat,${'z'.repeat(51)}`, // code too long
    ].join('\n');

    const response = await upload(librarianCookie, csv);

    expect(response.body.imported).toBe(0);
    expect(response.body.failed).toBe(6);
    expect(response.body.results.every((r: RowResult) => r.ok === false)).toBe(true);
  });

  it('reports a row with the wrong number of columns without aborting the file', async () => {
    const csv = [HEADER, 'Good,Cat,G-9', 'TooFew,Cat', 'TooMany,Cat,X-1,extra', 'Also,Cat,G-8'].join(
      '\n',
    );

    const response = await upload(librarianCookie, csv);
    const results: RowResult[] = response.body.results;

    expect(results[1]).toMatchObject({ row: 3, ok: false });
    expect(results[1]!.message).toMatch(/Expected 3 columns, found 2/);
    expect(results[2]!.message).toMatch(/Expected 3 columns, found 4/);
    // The good rows either side still imported.
    expect(response.body.imported).toBe(2);
  });

  it('trims and normalises exactly as a single create does', async () => {
    await upload(librarianCookie, [HEADER, '  Spaced out  ,  Cameras  ,  low-1  '].join('\n'));

    const item = await prisma.catalogueItem.findFirstOrThrow();
    expect(item).toMatchObject({ title: 'Spaced out', category: 'Cameras', code: 'LOW-1' });
  });
});

describe('CSV shape and header validation', () => {
  it('handles quoted commas, doubled quotes and CRLF', async () => {
    const csv =
      `${HEADER}\r\n` +
      '"Tripod, carbon fibre",Accessories,TRI-001\r\n' +
      '"He said ""hello""",Cat,Q-1\r\n';

    const response = await upload(librarianCookie, csv);

    expect(response.body.imported).toBe(2);
    const titles = (await prisma.catalogueItem.findMany({ orderBy: { code: 'asc' } })).map(
      (i) => i.title,
    );
    expect(titles).toEqual(['He said "hello"', 'Tripod, carbon fibre']);
  });

  it('accepts a UTF-8 byte order mark', async () => {
    const response = await upload(librarianCookie, `﻿${HEADER}\nThing,Cat,BOM-1`);

    expect(response.body.imported).toBe(1);
  });

  it('accepts the columns in any order', async () => {
    const response = await upload(librarianCookie, 'code,title,category\nORD-1,Thing,Cat');

    expect(response.body.imported).toBe(1);
    expect(await prisma.catalogueItem.findFirstOrThrow()).toMatchObject({
      code: 'ORD-1',
      title: 'Thing',
      category: 'Cat',
    });
  });

  it('rejects a missing, misspelled or extra header column', async () => {
    const bad = [
      'title,category\nThing,Cat',
      'title,category,codes\nThing,Cat,A-1',
      'title,category,code,notes\nThing,Cat,A-1,hi',
    ];

    for (const csv of bad) {
      const response = await upload(librarianCookie, csv);
      expect(response.status, csv).toBe(400);
      expect(response.body.error.message).toMatch(/header must be exactly/i);
    }

    expect(await prisma.catalogueItem.count()).toBe(0);
  });

  it('rejects an empty body and a header with no rows', async () => {
    expect((await upload(librarianCookie, '')).status).toBe(400);
    expect((await upload(librarianCookie, HEADER)).status).toBe(400);
  });

  it('rejects a body that is not CSV at all', async () => {
    const response = await upload(librarianCookie, `${HEADER}\n"unterminated,Cat,X-1`);
    expect(response.status).toBe(400);
  });
});

describe('limits', () => {
  it('rejects more rows than the import limit, importing none of them', async () => {
    const rows = Array.from({ length: 1001 }, (_, i) => `Item ${i},Cat,LIMIT-${i}`);
    const response = await upload(librarianCookie, [HEADER, ...rows].join('\n'));

    expect(response.status).toBe(400);
    expect(response.body.error.message).toMatch(/Too many rows/);
    expect(await prisma.catalogueItem.count()).toBe(0);
  });

  it('rejects an oversized body with 413 rather than a 500', async () => {
    const rows = Array.from({ length: 40_000 }, (_, i) => `${'x'.repeat(60)},Cat,BIG-${i}`);
    const response = await upload(librarianCookie, [HEADER, ...rows].join('\n'));

    expect(response.status).toBe(413);
    expect(response.body.error.code).toBe('payload_too_large');
  });
});

describe('the import creates no loan activity', () => {
  it('writes items only — no loans, no timeline events', async () => {
    await upload(librarianCookie, [HEADER, 'Thing,Cat,Q-9', 'Other,Cat,Q-8'].join('\n'));

    expect(await prisma.catalogueItem.count()).toBe(2);
    expect(await prisma.loan.count()).toBe(0);
    expect(await prisma.loanEvent.count()).toBe(0);
  });
});
