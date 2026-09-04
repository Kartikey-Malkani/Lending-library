import { Prisma } from '@prisma/client';
import { beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../src/db.js';
import { adminPrisma } from './admin.js';

/**
 * These tests bypass the application entirely and talk to Postgres directly.
 *
 * That is the point. Anything provable here holds no matter what the
 * application does — a future code path, a careless migration, or someone at a
 * psql prompt cannot get around it. Rules that are policy rather than
 * structure (who may call what, which transition is legal, what message
 * explains a rejection) live in the service layer and are tested through the
 * API instead.
 *
 * On asserting the right failure: Prisma reports errors differently depending
 * on how the statement was issued.
 *   - Model operations surface the Postgres text for a CHECK violation, so the
 *     constraint name can be asserted directly.
 *   - Unique violations become P2002 with the offending columns in `meta`; the
 *     index name is not carried through.
 *   - Raw queries lose the constraint name and keep only the SQLSTATE.
 * Each assertion below is written to match, so a test cannot pass because the
 * statement failed for some unrelated reason.
 */

type Fixture = { librarianId: string; memberId: string; itemId: string };

/** SQLSTATE from a raw-query failure, or undefined if it was some other error. */
function sqlState(error: unknown): string | undefined {
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2010') {
    return (error.meta as { code?: string } | undefined)?.code;
  }
  return undefined;
}

/** Runs SQL that must fail, and returns the error for inspection. */
async function expectRejected(sql: string): Promise<unknown> {
  let caught: unknown;
  try {
    await prisma.$executeRawUnsafe(sql);
  } catch (error) {
    caught = error;
  }
  if (caught === undefined) {
    throw new Error(`Expected the database to reject this statement, but it succeeded:\n${sql}`);
  }
  return caught;
}

let f: Fixture;

beforeEach(async () => {
  const librarian = await prisma.user.create({
    data: { email: 'librarian@test.local', name: 'Test Librarian', role: 'librarian', passwordHash: 'not-a-real-hash' },
  });
  const member = await prisma.user.create({
    data: { email: 'member@test.local', name: 'Test Member', role: 'member', passwordHash: 'not-a-real-hash' },
  });
  const item = await prisma.catalogueItem.create({
    data: { code: 'TEST-001', title: 'Test item', category: 'Testing', createdById: librarian.id },
  });
  f = { librarianId: librarian.id, memberId: member.id, itemId: item.id };
});

describe('overdue is not a storable state', () => {
  it('rejects an attempt to write "overdue" as a loan status', async () => {
    const error = await expectRejected(
      `INSERT INTO loans (item_id, borrower_id, status)
       VALUES ('${f.itemId}', '${f.memberId}', 'overdue')`,
    );

    // 22P02 = invalid_text_representation: the enum type has no such value.
    expect(sqlState(error)).toBe('22P02');
    expect((error as Error).message).toMatch(/invalid input value for enum loan_status/i);
  });

  it('defines exactly the four real lifecycle states, in lifecycle order', async () => {
    const rows = await prisma.$queryRawUnsafe<{ label: string }[]>(
      `SELECT e.enumlabel AS label
         FROM pg_enum e
         JOIN pg_type t ON t.oid = e.enumtypid
        WHERE t.typname = 'loan_status'
        ORDER BY e.enumsortorder`,
    );

    expect(rows.map((r) => r.label)).toEqual(['requested', 'issued', 'returned', 'lost']);
  });
});

describe('loan state and timestamp coherence', () => {
  // Fixed, explicitly ordered timestamps rather than `new Date()`.
  //
  // Leaving requested_at to its CURRENT_TIMESTAMP default while setting the
  // other columns from Node puts requested_at a few milliseconds AFTER
  // issued_at, so the chronology constraint fires and the test passes for the
  // wrong reason. Postgres does not promise which of several failing CHECKs it
  // reports, so each row here is made valid in every respect except the one
  // being tested.
  const REQUESTED = new Date('2026-01-01T09:00:00Z');
  const ISSUED = new Date('2026-01-03T09:00:00Z');
  const DUE = new Date('2026-01-17T00:00:00Z');
  const CLOSED = new Date('2026-01-10T09:00:00Z');

  it('rejects an issued loan with no due date', async () => {
    await expect(
      prisma.loan.create({
        data: {
          itemId: f.itemId,
          borrowerId: f.memberId,
          status: 'issued',
          requestedAt: REQUESTED,
          issuedAt: ISSUED,
        },
      }),
    ).rejects.toThrow(/loans_issued_state_chk/);
  });

  it('rejects a requested loan that already carries a due date', async () => {
    await expect(
      prisma.loan.create({
        data: {
          itemId: f.itemId,
          borrowerId: f.memberId,
          status: 'requested',
          requestedAt: REQUESTED,
          dueOn: DUE,
        },
      }),
    ).rejects.toThrow(/loans_requested_state_chk/);
  });

  it('rejects a returned loan that was never issued', async () => {
    await expect(
      prisma.loan.create({
        data: {
          itemId: f.itemId,
          borrowerId: f.memberId,
          status: 'returned',
          requestedAt: REQUESTED,
          returnedAt: CLOSED,
        },
      }),
    ).rejects.toThrow(/loans_returned_state_chk/);
  });

  it('rejects a loan that is both returned and lost', async () => {
    await expect(
      prisma.loan.create({
        data: {
          itemId: f.itemId,
          borrowerId: f.memberId,
          status: 'lost',
          requestedAt: REQUESTED,
          issuedAt: ISSUED,
          dueOn: DUE,
          returnedAt: CLOSED,
          lostAt: CLOSED,
        },
      }),
    ).rejects.toThrow(/loans_lost_state_chk/);
  });

  it('rejects a loan returned before it was issued', async () => {
    await expect(
      prisma.loan.create({
        data: {
          itemId: f.itemId,
          borrowerId: f.memberId,
          status: 'returned',
          requestedAt: REQUESTED,
          issuedAt: ISSUED,
          dueOn: DUE,
          returnedAt: new Date('2026-01-02T09:00:00Z'),
        },
      }),
    ).rejects.toThrow(/loans_chronology_chk/);
  });

  it('accepts a fully coherent returned loan', async () => {
    const loan = await prisma.loan.create({
      data: {
        itemId: f.itemId,
        borrowerId: f.memberId,
        status: 'returned',
        requestedAt: REQUESTED,
        issuedAt: ISSUED,
        dueOn: DUE,
        returnedAt: CLOSED,
      },
    });

    expect(loan.status).toBe('returned');
  });
});

describe('at most one open loan per item', () => {
  /** Assert this was the partial unique index on loans.item_id, not some other failure. */
  function expectOpenLoanConflict(error: unknown): void {
    expect(error).toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
    const known = error as Prisma.PrismaClientKnownRequestError;
    expect(known.code).toBe('P2002');
    expect((known.meta as { target?: string[] }).target).toEqual(['item_id']);
  }

  it('rejects a second requested loan on the same item', async () => {
    await prisma.loan.create({ data: { itemId: f.itemId, borrowerId: f.memberId, status: 'requested' } });

    await prisma.loan
      .create({ data: { itemId: f.itemId, borrowerId: f.librarianId, status: 'requested' } })
      .then(
        () => {
          throw new Error('Expected the second open loan to be rejected.');
        },
        expectOpenLoanConflict,
      );
  });

  it('rejects issuing an item that already has a requested loan', async () => {
    await prisma.loan.create({ data: { itemId: f.itemId, borrowerId: f.memberId, status: 'requested' } });

    const now = new Date();
    await prisma.loan
      .create({
        data: {
          itemId: f.itemId,
          borrowerId: f.librarianId,
          status: 'issued',
          requestedAt: now,
          issuedAt: now,
          dueOn: now,
        },
      })
      .then(
        () => {
          throw new Error('Expected issuing an already-open item to be rejected.');
        },
        expectOpenLoanConflict,
      );
  });

  it('allows a new loan once the previous one is closed', async () => {
    // One clock for every timestamp on the row. Mixing Node's `new Date()` with
    // the column's CURRENT_TIMESTAMP default puts requested_at a few
    // milliseconds after issued_at and trips the chronology constraint.
    const now = new Date();
    const first = await prisma.loan.create({
      data: {
        itemId: f.itemId,
        borrowerId: f.memberId,
        status: 'issued',
        requestedAt: now,
        issuedAt: now,
        dueOn: now,
      },
    });
    await prisma.loan.update({
      where: { id: first.id },
      data: { status: 'returned', returnedAt: new Date() },
    });

    const second = await prisma.loan.create({
      data: { itemId: f.itemId, borrowerId: f.librarianId, status: 'requested' },
    });

    expect(second.status).toBe('requested');
    expect(await prisma.loan.count({ where: { itemId: f.itemId } })).toBe(2);
  });

  it('holds when two clients race to open a loan on the same item', async () => {
    // The check that matters. An application-level "does an open loan exist?"
    // lookup passes every test above and fails this one, because both
    // transactions read "none" before either writes.
    const attempts = await Promise.allSettled([
      prisma.loan.create({ data: { itemId: f.itemId, borrowerId: f.memberId, status: 'requested' } }),
      prisma.loan.create({ data: { itemId: f.itemId, borrowerId: f.librarianId, status: 'requested' } }),
    ]);

    const rejected = attempts.filter((a) => a.status === 'rejected');
    expect(attempts.filter((a) => a.status === 'fulfilled')).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expectOpenLoanConflict((rejected[0] as PromiseRejectedResult).reason);

    expect(await prisma.loan.count({ where: { itemId: f.itemId } })).toBe(1);
  });
});

describe('loan_events is append-only', () => {
  /**
   * Two independent guarantees, tested separately because they fail
   * differently:
   *
   *   privilege — the application's role holds only SELECT and INSERT, so an
   *               UPDATE, DELETE or TRUNCATE from application code is refused
   *               before it executes (SQLSTATE 42501).
   *   trigger   — the trigger refuses UPDATE and DELETE for every role, the
   *               schema owner included (SQLSTATE 23001).
   *
   * The privilege alone would not stop a privileged operator; the trigger alone
   * cannot cover TRUNCATE, which does not fire row-level triggers. Each covers
   * the other's gap.
   */

  async function loanWithEvent(): Promise<string> {
    const loan = await prisma.loan.create({
      data: { itemId: f.itemId, borrowerId: f.memberId, status: 'requested' },
    });
    await prisma.loanEvent.create({
      data: { loanId: loan.id, type: 'requested', actorId: f.memberId, note: 'original note' },
    });
    return loan.id;
  }

  describe('as the application role', () => {
    it('has no UPDATE, DELETE or TRUNCATE privilege on loan_events', async () => {
      const rows = await prisma.$queryRawUnsafe<{ privilege_type: string }[]>(
        `SELECT privilege_type
           FROM information_schema.role_table_grants
          WHERE table_name = 'loan_events'
            AND grantee = current_user
          ORDER BY privilege_type`,
      );
      const granted = rows.map((r) => r.privilege_type);

      expect(granted).toContain('SELECT');
      expect(granted).toContain('INSERT');
      expect(granted).not.toContain('UPDATE');
      expect(granted).not.toContain('DELETE');
      expect(granted).not.toContain('TRUNCATE');
    });

    it('is refused an UPDATE on privilege', async () => {
      await loanWithEvent();

      const error = await expectRejected(`UPDATE loan_events SET note = 'tampered with'`);
      expect(sqlState(error)).toBe('42501');
      expect((error as Error).message).toMatch(/permission denied for table loan_events/i);

      const event = await prisma.loanEvent.findFirstOrThrow();
      expect(event.note).toBe('original note');
    });

    it('is refused a DELETE on privilege', async () => {
      await loanWithEvent();

      const error = await expectRejected(`DELETE FROM loan_events`);
      expect(sqlState(error)).toBe('42501');
      expect((error as Error).message).toMatch(/permission denied for table loan_events/i);

      expect(await prisma.loanEvent.count()).toBe(1);
    });

    it('is refused a TRUNCATE on privilege, which the trigger cannot catch', async () => {
      await loanWithEvent();

      const error = await expectRejected(`TRUNCATE TABLE loan_events CASCADE`);
      expect(sqlState(error)).toBe('42501');
      expect((error as Error).message).toMatch(/permission denied for table loan_events/i);

      expect(await prisma.loanEvent.count()).toBe(1);
    });

    it('can still append new events', async () => {
      const loanId = await loanWithEvent();

      await prisma.loanEvent.create({
        data: { loanId, type: 'issued', actorId: f.librarianId, note: 'handed over' },
      });

      expect(await prisma.loanEvent.count()).toBe(2);
    });
  });

  describe('as the schema owner', () => {
    it('is refused an UPDATE by the trigger despite holding the privilege', async () => {
      await loanWithEvent();

      let caught: unknown;
      try {
        await adminPrisma.$executeRawUnsafe(`UPDATE loan_events SET note = 'tampered with'`);
      } catch (error) {
        caught = error;
      }
      expect(caught, 'the owner must not be able to rewrite history either').toBeDefined();
      expect(sqlState(caught)).toBe('23001');
      expect((caught as Error).message).toMatch(/loan_events is append-only; UPDATE is not permitted/);

      const event = await adminPrisma.loanEvent.findFirstOrThrow();
      expect(event.note).toBe('original note');
    });

    it('is refused a DELETE by the trigger despite holding the privilege', async () => {
      await loanWithEvent();

      let caught: unknown;
      try {
        await adminPrisma.$executeRawUnsafe(`DELETE FROM loan_events`);
      } catch (error) {
        caught = error;
      }
      expect(caught, 'the owner must not be able to delete history either').toBeDefined();
      expect(sqlState(caught)).toBe('23001');
      expect((caught as Error).message).toMatch(/loan_events is append-only; DELETE is not permitted/);

      expect(await adminPrisma.loanEvent.count()).toBe(1);
    });
  });
});
