import { prisma } from '../db.js';
import { ApiError } from '../http/errors.js';
import { type CustodianView, getItemOrThrow, listCustodians } from './service.js';

/**
 * Custodian assignment.
 *
 * The brief makes this a genuine many-to-many: an item can have any number of
 * librarian custodians, and a librarian can be custodian for any number of
 * items. The join table's composite primary key makes a duplicate link
 * impossible at the database level; this module never relies on that as its
 * mechanism, it just cannot violate it.
 *
 * Custodianship is responsibility for an item's condition and location. It is
 * deliberately NOT an authorization boundary: any librarian may edit any item,
 * whether or not they are its custodian.
 */

/**
 * Replaces an item's custodians with exactly the given set.
 *
 * Set replacement rather than add/remove endpoints: the UI for this is a
 * multi-select, and one atomic call cannot half-apply the way a client-side
 * diff of several calls can. The trade is last-write-wins — two librarians
 * editing custodians at the same time means one silently loses the other's
 * change. Acceptable for a handful of librarians; noted rather than hidden.
 *
 * Every id is checked before anything is written, so a request naming even one
 * invalid or non-librarian id leaves the existing set completely untouched.
 */
export async function replaceCustodians(
  itemId: string,
  librarianIds: string[],
  assignedById: string,
): Promise<CustodianView[]> {
  await getItemOrThrow(itemId);

  // Duplicates in the input are the caller repeating themselves, not an error.
  const requested = [...new Set(librarianIds)];

  await assertAllAreLibrarians(requested);

  // Removals and additions in one transaction, so the item is never briefly
  // left with a partial custodian set.
  await prisma.$transaction(async (tx) => {
    await tx.itemCustodian.deleteMany({
      where:
        requested.length === 0
          ? { itemId }
          : { itemId, librarianId: { notIn: requested } },
    });

    if (requested.length > 0) {
      await tx.itemCustodian.createMany({
        data: requested.map((librarianId) => ({ itemId, librarianId, assignedById })),
        // Re-sending an existing member of the set is a no-op, which is what
        // makes the whole operation idempotent.
        skipDuplicates: true,
      });
    }
  });

  return listCustodians(itemId);
}

/**
 * Rejects the whole request unless every id belongs to an existing librarian.
 *
 * Runs before any write. The brief says custodians are librarians, so a member
 * id is a bad request rather than something to silently drop — and reporting
 * which ids were wrong is more useful than a bare rejection.
 */
async function assertAllAreLibrarians(librarianIds: string[]): Promise<void> {
  if (librarianIds.length === 0) return;

  const found = await prisma.user.findMany({
    where: { id: { in: librarianIds } },
    select: { id: true, role: true },
  });

  const byId = new Map(found.map((user) => [user.id, user.role]));

  const unknown = librarianIds.filter((id) => !byId.has(id));
  const notLibrarians = librarianIds.filter((id) => byId.get(id) === 'member');

  if (unknown.length === 0 && notLibrarians.length === 0) return;

  const details: { field: string; message: string }[] = [];
  for (const id of unknown) {
    details.push({ field: 'librarianIds', message: `No such user: ${id}` });
  }
  for (const id of notLibrarians) {
    details.push({ field: 'librarianIds', message: `User ${id} is not a librarian` });
  }

  throw ApiError.badRequest(
    'Custodians must be existing librarians. No changes were made.',
    details,
  );
}
