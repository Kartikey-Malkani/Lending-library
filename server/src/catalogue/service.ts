import type { CatalogueItem, Prisma } from '@prisma/client';
import { prisma } from '../db.js';
import { ApiError, isUniqueViolationOn } from '../http/errors.js';
import type { Paginated } from '../http/validation.js';

/**
 * Catalogue items.
 *
 * Archiving is a soft state change: it sets `archived_at` and touches nothing
 * else. It does not cancel loans, does not remove custodian links, and is not
 * related to a loan's status — an archived item can still have an open loan
 * that needs returning.
 */

/** How the catalogue is represented over the wire. */
export type ItemView = {
  id: string;
  title: string;
  category: string;
  code: string;
  archivedAt: Date | null;
  isArchived: boolean;
  createdAt: Date;
  updatedAt: Date;
};

export type CustodianView = {
  id: string;
  name: string;
  email: string;
  assignedAt: Date;
};

export function toItemView(item: CatalogueItem): ItemView {
  return {
    id: item.id,
    title: item.title,
    category: item.category,
    code: item.code,
    archivedAt: item.archivedAt,
    // Exposed as a derived flag so a client never has to interpret a timestamp,
    // and so milestone 6 has an unambiguous signal for "no new loans".
    isArchived: item.archivedAt !== null,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  };
}

/** `code` identifies the item, so it is normalised before it is stored or compared. */
function normaliseCode(code: string): string {
  return code.toUpperCase();
}

// --- Reads -----------------------------------------------------------------

export type ArchivedFilter = 'false' | 'true' | 'all';
export type ItemSortField = 'title' | 'code' | 'category' | 'createdAt';

export type ListItemsOptions = {
  search?: string | undefined;
  category?: string | undefined;
  archived: ArchivedFilter;
  sort: ItemSortField;
  dir: 'asc' | 'desc';
  page: number;
  pageSize: number;
};

export async function listItems(options: ListItemsOptions): Promise<Paginated<ItemView>> {
  const where: Prisma.CatalogueItemWhereInput = {};

  // Archived items are out of the default view; the brief requires the default
  // catalogue not to show them, and a filter to reach them.
  if (options.archived === 'false') where.archivedAt = null;
  if (options.archived === 'true') where.archivedAt = { not: null };

  if (options.category) where.category = options.category;

  if (options.search) {
    where.OR = [
      { title: { contains: options.search, mode: 'insensitive' } },
      { code: { contains: options.search, mode: 'insensitive' } },
    ];
  }

  // `id` is always the final sort key. Without a tiebreaker, two items sharing
  // a title can swap places between requests, and offset pagination then skips
  // or repeats rows without anything looking wrong.
  const orderBy: Prisma.CatalogueItemOrderByWithRelationInput[] = [
    { [options.sort]: options.dir },
    { id: 'asc' },
  ];

  const [rows, total] = await Promise.all([
    prisma.catalogueItem.findMany({
      where,
      orderBy,
      skip: (options.page - 1) * options.pageSize,
      take: options.pageSize,
    }),
    // Counted over the same filters, so `total` is every match rather than the
    // size of the page just returned.
    prisma.catalogueItem.count({ where }),
  ]);

  return {
    rows: rows.map(toItemView),
    total,
    page: options.page,
    pageSize: options.pageSize,
  };
}

export async function getItemOrThrow(id: string): Promise<CatalogueItem> {
  const item = await prisma.catalogueItem.findUnique({ where: { id } });
  if (!item) throw ApiError.notFound('Catalogue item not found.');
  return item;
}

export async function listCustodians(itemId: string): Promise<CustodianView[]> {
  const rows = await prisma.itemCustodian.findMany({
    where: { itemId },
    include: { librarian: { select: { id: true, name: true, email: true } } },
    orderBy: [{ librarian: { name: 'asc' } }, { librarianId: 'asc' }],
  });

  return rows.map((row) => ({
    id: row.librarian.id,
    name: row.librarian.name,
    email: row.librarian.email,
    assignedAt: row.assignedAt,
  }));
}

/** Items the given librarian is custodian for. The id always comes from the session. */
export async function listItemsForCustodian(
  librarianId: string,
  options: { archived: ArchivedFilter; page: number; pageSize: number },
): Promise<Paginated<ItemView>> {
  const where: Prisma.CatalogueItemWhereInput = {
    custodians: { some: { librarianId } },
  };
  if (options.archived === 'false') where.archivedAt = null;
  if (options.archived === 'true') where.archivedAt = { not: null };

  const [rows, total] = await Promise.all([
    prisma.catalogueItem.findMany({
      where,
      orderBy: [{ title: 'asc' }, { id: 'asc' }],
      skip: (options.page - 1) * options.pageSize,
      take: options.pageSize,
    }),
    prisma.catalogueItem.count({ where }),
  ]);

  return { rows: rows.map(toItemView), total, page: options.page, pageSize: options.pageSize };
}

// --- Writes ----------------------------------------------------------------

export type CreateItemInput = { title: string; category: string; code: string };

export async function createItem(
  input: CreateItemInput,
  createdById: string,
): Promise<ItemView> {
  try {
    const item = await prisma.catalogueItem.create({
      data: {
        title: input.title,
        category: input.category,
        code: normaliseCode(input.code),
        createdById,
      },
    });
    return toItemView(item);
  } catch (error) {
    throw translateDuplicateCode(error, normaliseCode(input.code));
  }
}

export type UpdateItemInput = { title?: string; category?: string; code?: string };

export async function updateItem(id: string, input: UpdateItemInput): Promise<ItemView> {
  await getItemOrThrow(id);

  const data: Prisma.CatalogueItemUpdateInput = {};
  if (input.title !== undefined) data.title = input.title;
  if (input.category !== undefined) data.category = input.category;
  if (input.code !== undefined) data.code = normaliseCode(input.code);

  try {
    const item = await prisma.catalogueItem.update({ where: { id }, data });
    return toItemView(item);
  } catch (error) {
    throw translateDuplicateCode(error, input.code ? normaliseCode(input.code) : '');
  }
}

function translateDuplicateCode(error: unknown, code: string): unknown {
  if (isUniqueViolationOn(error, 'code')) {
    return ApiError.conflict(
      'duplicate_code',
      `Another catalogue item already uses the code ${code}.`,
    );
  }
  return error;
}

/**
 * Archive and restore.
 *
 * Both are conditional updates rather than read-then-write. Two librarians
 * archiving the same item concurrently would both pass a "is it active?" check
 * before either wrote; here the WHERE clause does the checking, so exactly one
 * update matches a row and the loser is told the state already changed.
 *
 * Repeating the transition is a 409 rather than a silent success. Archiving is
 * a state change on the item, and the same contract applies to loans: a client
 * acting on stale state should be told, not quietly agreed with.
 *
 * Neither operation touches loans or custodian links.
 */
export async function archiveItem(id: string): Promise<ItemView> {
  const { count } = await prisma.catalogueItem.updateMany({
    where: { id, archivedAt: null },
    data: { archivedAt: new Date() },
  });

  if (count === 0) {
    const item = await getItemOrThrow(id); // 404 if it never existed.
    throw ApiError.conflict(
      'already_archived',
      `"${item.title}" is already archived.`,
    );
  }

  return toItemView(await getItemOrThrow(id));
}

export async function restoreItem(id: string): Promise<ItemView> {
  const { count } = await prisma.catalogueItem.updateMany({
    where: { id, archivedAt: { not: null } },
    data: { archivedAt: null },
  });

  if (count === 0) {
    const item = await getItemOrThrow(id);
    throw ApiError.conflict('not_archived', `"${item.title}" is not archived.`);
  }

  return toItemView(await getItemOrThrow(id));
}
