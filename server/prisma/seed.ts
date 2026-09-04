import bcrypt from 'bcryptjs';
import { type LoanStatus, type Prisma } from '@prisma/client';
import { config } from '../src/config.js';
import { createAdminClient } from '../src/db.js';

/**
 * Demo data.
 *
 * The point is a system that visibly does something: loans in every state,
 * several genuinely overdue, returns spread across the last eight weeks so the
 * dashboard chart has shape, an archived item that still carries its loan
 * history, items with two custodians and items with none.
 *
 * It wipes before writing so re-running is safe, which is exactly why it
 * refuses to run against production without an explicit override.
 */

// Seeding truncates every table, so it needs the owner role, not the
// least-privilege role the application runs as.
const prisma = createAdminClient();

const BCRYPT_COST = 10;

/**
 * One clock for the whole run.
 *
 * Every timestamp written to a loan is derived from this single value. Calling
 * `new Date()` per field, or letting a column fall back to its
 * CURRENT_TIMESTAMP default, mixes the Node clock with the Postgres clock: the
 * two differ by a few milliseconds, which is enough to put `issued_at` before
 * `requested_at` and trip the chronology constraint. It also means a run that
 * straddles midnight cannot produce two different "today"s.
 */
const NOW = new Date();
const TODAY_UTC_MIDNIGHT = Date.UTC(NOW.getUTCFullYear(), NOW.getUTCMonth(), NOW.getUTCDate());

/** UTC midnight, `days` from today. Loan due dates are DATE columns. */
function dayOffset(days: number): Date {
  return new Date(TODAY_UTC_MIDNIGHT + days * 86_400_000);
}

/** A timestamp `days` ago, at a plausible hour rather than exactly midnight. */
function daysAgo(days: number, hour = 10): Date {
  const d = dayOffset(-days);
  d.setUTCHours(hour, 0, 0, 0);
  return d;
}

type UserSeed = {
  key: string;
  email: string;
  name: string;
  role: 'librarian' | 'member';
  password: string;
};

const USERS: UserSeed[] = [
  { key: 'alex', email: 'alex.librarian@example.com', name: 'Alex Whitfield', role: 'librarian', password: 'Librarian123!' },
  { key: 'priya', email: 'priya.librarian@example.com', name: 'Priya Raman', role: 'librarian', password: 'Librarian123!' },
  { key: 'sam', email: 'sam.member@example.com', name: 'Sam Okonkwo', role: 'member', password: 'Member123!' },
  { key: 'dana', email: 'dana.member@example.com', name: 'Dana Feldman', role: 'member', password: 'Member123!' },
  { key: 'rio', email: 'rio.member@example.com', name: 'Rio Alvarez', role: 'member', password: 'Member123!' },
  { key: 'jess', email: 'jess.member@example.com', name: 'Jess Mwangi', role: 'member', password: 'Member123!' },
];

type ItemSeed = { code: string; title: string; category: string; archivedDaysAgo?: number };

const ITEMS: ItemSeed[] = [
  { code: 'CAM-001', title: 'Canon EOS R6 body', category: 'Cameras' },
  { code: 'CAM-002', title: 'Sony A7 III body', category: 'Cameras' },
  { code: 'CAM-003', title: 'GoPro Hero 12', category: 'Cameras' },
  { code: 'LENS-001', title: 'Canon RF 24-70mm f/2.8', category: 'Lenses' },
  { code: 'LENS-002', title: 'Sigma 18-35mm f/1.8', category: 'Lenses' },
  { code: 'PROJ-001', title: 'Epson EB-2250U projector', category: 'Projectors' },
  { code: 'PROJ-002', title: 'Anker Nebula Capsule projector', category: 'Projectors' },
  { code: 'AUD-001', title: 'Zoom H6 field recorder', category: 'Audio' },
  { code: 'AUD-002', title: 'Rode NTG5 shotgun microphone', category: 'Audio' },
  { code: 'AUD-003', title: 'Shure SM7B microphone', category: 'Audio' },
  { code: 'TOOL-001', title: 'DeWalt 18V cordless drill', category: 'Tools' },
  { code: 'TOOL-002', title: 'Bosch GLM 50 laser measure', category: 'Tools' },
  { code: 'TOOL-003', title: 'Makita circular saw', category: 'Tools' },
  { code: 'TOOL-004', title: 'Torque wrench set', category: 'Tools' },
  { code: 'LAP-001', title: 'MacBook Pro 14-inch', category: 'Laptops' },
  { code: 'LAP-002', title: 'ThinkPad X1 Carbon', category: 'Laptops' },
  { code: 'NET-001', title: 'Ubiquiti network test kit', category: 'Networking' },
  { code: 'VR-001', title: 'Meta Quest 3 headset', category: 'VR' },
  { code: 'LIGHT-001', title: 'Aputure 300d LED light', category: 'Lighting' },
  { code: 'LIGHT-002', title: 'Godox softbox kit', category: 'Lighting' },
  // Archived, and deliberately given loan history below: archiving must hide an
  // item from the default catalogue view without destroying what happened to it.
  { code: 'TOOL-005', title: 'Angle grinder (withdrawn from service)', category: 'Tools', archivedDaysAgo: 12 },
];

/**
 * A loan plus the timeline that would have produced it. Terminal states carry
 * their whole history so the seeded data looks like the app made it rather than
 * something inserted sideways.
 */
type LoanSeed = {
  itemCode: string;
  borrower: string;
  status: LoanStatus;
  requestedDaysAgo: number;
  issuedDaysAgo?: number;
  dueInDays?: number;
  returnedDaysAgo?: number;
  lostDaysAgo?: number;
  librarian?: string;
  issueNote?: string;
  closeNote?: string;
};

const LOANS: LoanSeed[] = [
  // --- Open: awaiting a librarian ---
  { itemCode: 'CAM-003', borrower: 'dana', status: 'requested', requestedDaysAgo: 1 },
  { itemCode: 'AUD-003', borrower: 'jess', status: 'requested', requestedDaysAgo: 3 },

  // --- Open: issued, not yet due ---
  { itemCode: 'CAM-001', borrower: 'sam', status: 'issued', requestedDaysAgo: 6, issuedDaysAgo: 5, dueInDays: 9, librarian: 'alex' },
  { itemCode: 'LAP-001', borrower: 'rio', status: 'issued', requestedDaysAgo: 4, issuedDaysAgo: 4, dueInDays: 3, librarian: 'priya' },
  { itemCode: 'VR-001', borrower: 'dana', status: 'issued', requestedDaysAgo: 2, issuedDaysAgo: 2, dueInDays: 12, librarian: 'alex', issueNote: 'Headset and both controllers. Charger not included.' },

  // --- Open: issued and past due. These drive the alerts area and the badge. ---
  { itemCode: 'PROJ-001', borrower: 'jess', status: 'issued', requestedDaysAgo: 34, issuedDaysAgo: 33, dueInDays: -12, librarian: 'alex' },
  { itemCode: 'TOOL-001', borrower: 'sam', status: 'issued', requestedDaysAgo: 25, issuedDaysAgo: 24, dueInDays: -3, librarian: 'priya' },
  { itemCode: 'AUD-001', borrower: 'rio', status: 'issued', requestedDaysAgo: 48, issuedDaysAgo: 47, dueInDays: -26, librarian: 'alex', issueNote: 'Includes two SD cards.' },

  // --- Closed: lost ---
  { itemCode: 'LENS-002', borrower: 'rio', status: 'lost', requestedDaysAgo: 70, issuedDaysAgo: 69, dueInDays: -48, lostDaysAgo: 20, librarian: 'priya', closeNote: 'Borrower reported it stolen from a locked car. Police reference filed.' },

  // --- Closed: returned, spread across the last eight weeks so the dashboard
  //     chart shows a real distribution rather than a single spike. ---
  { itemCode: 'CAM-002', borrower: 'sam', status: 'returned', requestedDaysAgo: 60, issuedDaysAgo: 59, dueInDays: -45, returnedDaysAgo: 52, librarian: 'alex' },
  { itemCode: 'PROJ-002', borrower: 'dana', status: 'returned', requestedDaysAgo: 54, issuedDaysAgo: 53, dueInDays: -39, returnedDaysAgo: 44, librarian: 'priya' },
  { itemCode: 'TOOL-002', borrower: 'jess', status: 'returned', requestedDaysAgo: 47, issuedDaysAgo: 46, dueInDays: -32, returnedDaysAgo: 38, librarian: 'alex', closeNote: 'Returned with a cracked case. Still functional.' },
  { itemCode: 'LENS-001', borrower: 'rio', status: 'returned', requestedDaysAgo: 40, issuedDaysAgo: 39, dueInDays: -25, returnedDaysAgo: 31, librarian: 'priya' },
  { itemCode: 'LAP-002', borrower: 'sam', status: 'returned', requestedDaysAgo: 33, issuedDaysAgo: 32, dueInDays: -18, returnedDaysAgo: 24, librarian: 'alex' },
  { itemCode: 'TOOL-003', borrower: 'dana', status: 'returned', requestedDaysAgo: 26, issuedDaysAgo: 25, dueInDays: -11, returnedDaysAgo: 17, librarian: 'priya' },
  { itemCode: 'LIGHT-001', borrower: 'jess', status: 'returned', requestedDaysAgo: 19, issuedDaysAgo: 18, dueInDays: -4, returnedDaysAgo: 10, librarian: 'alex' },
  { itemCode: 'NET-001', borrower: 'rio', status: 'returned', requestedDaysAgo: 12, issuedDaysAgo: 11, dueInDays: 3, returnedDaysAgo: 5, librarian: 'priya' },
  { itemCode: 'AUD-002', borrower: 'sam', status: 'returned', requestedDaysAgo: 9, issuedDaysAgo: 8, dueInDays: 6, returnedDaysAgo: 2, librarian: 'alex' },
  // An earlier, closed loan on an item that is currently issued again. Proves
  // "opening an item shows every loan ever made against it".
  { itemCode: 'CAM-001', borrower: 'jess', status: 'returned', requestedDaysAgo: 45, issuedDaysAgo: 44, dueInDays: -30, returnedDaysAgo: 36, librarian: 'priya' },
  // History on the archived item.
  { itemCode: 'TOOL-005', borrower: 'dana', status: 'returned', requestedDaysAgo: 30, issuedDaysAgo: 29, dueInDays: -15, returnedDaysAgo: 14, librarian: 'alex', closeNote: 'Guard damaged. Withdrawn from service after this return.' },
];

/**
 * Item code to librarian keys. Two items get two custodians each; four are left
 * without one, so the dashboard breakdown has to account for unassigned items
 * rather than quietly dropping them.
 */
const CUSTODIANS: Record<string, string[]> = {
  'CAM-001': ['alex', 'priya'],
  'CAM-002': ['alex'],
  'CAM-003': ['alex'],
  'LENS-001': ['alex'],
  'LENS-002': ['alex'],
  'PROJ-001': ['priya'],
  'PROJ-002': ['priya'],
  'AUD-001': ['priya'],
  'AUD-002': ['priya'],
  'AUD-003': ['priya'],
  'TOOL-001': ['alex'],
  'TOOL-002': ['alex'],
  'TOOL-003': ['alex'],
  'LAP-001': ['priya'],
  'LAP-002': ['priya'],
  'VR-001': ['alex', 'priya'],
  'TOOL-005': ['alex'],
  // TOOL-004, NET-001, LIGHT-001 and LIGHT-002 intentionally have no custodian.
};

async function main(): Promise<void> {
  if (config.isProduction && process.env.ALLOW_PRODUCTION_SEED !== 'true') {
    throw new Error(
      'Refusing to seed in production: this script truncates every table. ' +
        'Set ALLOW_PRODUCTION_SEED=true only if that is genuinely what you want.',
    );
  }

  console.log(`Seeding ${config.nodeEnv} database...`);

  await prisma.$executeRawUnsafe(`
    TRUNCATE TABLE
      alert_dismissals, loan_events, loans, item_custodians, catalogue_items, users
    RESTART IDENTITY CASCADE
  `);

  // --- Users ---
  const userIds = new Map<string, string>();
  for (const user of USERS) {
    const created = await prisma.user.create({
      data: {
        email: user.email.toLowerCase(),
        name: user.name,
        role: user.role,
        passwordHash: await bcrypt.hash(user.password, BCRYPT_COST),
      },
    });
    userIds.set(user.key, created.id);
  }
  const alexId = userIds.get('alex');
  if (!alexId) throw new Error('Seed user "alex" was not created.');

  // --- Catalogue items ---
  const itemIds = new Map<string, string>();
  for (const item of ITEMS) {
    const created = await prisma.catalogueItem.create({
      data: {
        code: item.code.toUpperCase(),
        title: item.title,
        category: item.category,
        createdById: alexId,
        archivedAt: item.archivedDaysAgo === undefined ? null : daysAgo(item.archivedDaysAgo),
      },
    });
    itemIds.set(item.code, created.id);
  }

  // --- Custodians ---
  for (const [code, librarianKeys] of Object.entries(CUSTODIANS)) {
    const itemId = itemIds.get(code);
    if (!itemId) throw new Error(`Custodian seed references unknown item code ${code}`);
    for (const key of librarianKeys) {
      const librarianId = userIds.get(key);
      if (!librarianId) throw new Error(`Custodian seed references unknown user ${key}`);
      await prisma.itemCustodian.create({
        data: { itemId, librarianId, assignedById: alexId },
      });
    }
  }

  // --- Loans, each with the timeline that produced it ---
  for (const seed of LOANS) {
    const itemId = itemIds.get(seed.itemCode);
    if (!itemId) throw new Error(`Loan seed references unknown item code ${seed.itemCode}`);
    const borrowerId = userIds.get(seed.borrower);
    if (!borrowerId) throw new Error(`Loan seed references unknown borrower ${seed.borrower}`);
    const librarianId = seed.librarian ? (userIds.get(seed.librarian) ?? null) : null;

    const requestedAt = daysAgo(seed.requestedDaysAgo, 9);
    const issuedAt = seed.issuedDaysAgo === undefined ? null : daysAgo(seed.issuedDaysAgo, 11);
    const returnedAt = seed.returnedDaysAgo === undefined ? null : daysAgo(seed.returnedDaysAgo, 15);
    const lostAt = seed.lostDaysAgo === undefined ? null : daysAgo(seed.lostDaysAgo, 16);
    const dueOn = seed.dueInDays === undefined ? null : dayOffset(seed.dueInDays);

    const loan = await prisma.loan.create({
      data: {
        itemId,
        borrowerId,
        status: seed.status,
        requestedAt,
        issuedAt,
        dueOn,
        returnedAt,
        lostAt,
        issuedById: issuedAt ? librarianId : null,
        returnedById: returnedAt ? librarianId : null,
      },
    });

    const events: Prisma.LoanEventCreateManyInput[] = [
      { loanId: loan.id, type: 'requested', actorId: borrowerId, createdAt: requestedAt },
    ];
    if (issuedAt && librarianId) {
      events.push({
        loanId: loan.id,
        type: 'issued',
        actorId: librarianId,
        note: seed.issueNote ?? null,
        createdAt: issuedAt,
      });
    }
    if (returnedAt && librarianId) {
      events.push({
        loanId: loan.id,
        type: 'returned',
        actorId: librarianId,
        note: seed.closeNote ?? null,
        createdAt: returnedAt,
      });
    }
    if (lostAt && librarianId) {
      events.push({
        loanId: loan.id,
        type: 'lost',
        actorId: librarianId,
        note: seed.closeNote ?? null,
        createdAt: lostAt,
      });
    }
    await prisma.loanEvent.createMany({ data: events });
  }

  const [users, items, loans, loanEvents, custodians] = await Promise.all([
    prisma.user.count(),
    prisma.catalogueItem.count(),
    prisma.loan.count(),
    prisma.loanEvent.count(),
    prisma.itemCustodian.count(),
  ]);
  const overdue = await prisma.loan.count({
    where: { status: 'issued', dueOn: { lt: dayOffset(0) } },
  });

  console.log(
    `Seeded ${users} users, ${items} items (1 archived), ${custodians} custodian links, ` +
      `${loans} loans (${overdue} currently overdue), ${loanEvents} timeline events.`,
  );
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => void prisma.$disconnect());
