import type { Role } from '@prisma/client';

/**
 * The authorization matrix, in one place, as data.
 *
 * Every protected route names a capability instead of hand-rolling a role
 * check, so what each role may do can be read off one table and audited in one
 * test rather than reconstructed by grepping route files. Adding a route
 * without adding it here is a type error at the call site, not a silent hole.
 *
 * Capabilities cover ROLE permission only. Two rules in this system are about
 * OWNERSHIP and cannot be expressed as a role — a member may read their own
 * loans but not another member's — and those live in the guards in
 * middleware.ts, not here. Keeping the two apart is deliberate: conflating them
 * is how "members can see loans" quietly becomes "members can see all loans".
 */

export const CAPABILITIES = {
  // --- Session (milestone 2) ---
  /** Read own identity, sign out. Any signed-in user. */
  'auth:session': ['librarian', 'member'],

  // --- Catalogue (milestone 5) ---
  /**
   * Members must be able to browse in order to request an item, which goal 3
   * requires. The brief does not say so explicitly; this is an interpretation,
   * recorded in docs/decisions.md.
   */
  'catalogue:read': ['librarian', 'member'],
  'catalogue:write': ['librarian'],
  'catalogue:archive': ['librarian'],

  // --- Custodians (milestone 5) ---
  'custodian:manage': ['librarian'],
  /** "Every librarian can see one list of every item they are a custodian for." */
  'custodian:read-own': ['librarian'],

  // --- Loans (milestone 6) ---
  /** Both roles, but a member's results are scoped to their own loans by the guard. */
  'loan:read': ['librarian', 'member'],
  /** Both roles, but a member's borrower is forced to their own id by the route. */
  'loan:request': ['librarian', 'member'],
  /** Creating an already-issued loan on someone's behalf. */
  'loan:create-issued': ['librarian'],
  'loan:issue': ['librarian'],
  'loan:return': ['librarian'],
  'loan:lost': ['librarian'],

  // --- Bulk operations (milestone 8) ---
  'bulk:import': ['librarian'],
  'bulk:return': ['librarian'],
  /** The CSV names every borrower and due date, so it is not a member view. */
  'export:on-loan': ['librarian'],

  // --- Dashboard and alerts (milestone 9) ---
  /** An operations view. Members get their own loans instead. */
  'dashboard:read': ['librarian'],
  'alerts:read': ['librarian'],
  'alerts:dismiss': ['librarian'],
} as const satisfies Record<string, readonly Role[]>;

export type Capability = keyof typeof CAPABILITIES;

/** Every capability name, for exhaustive matrix testing. */
export const ALL_CAPABILITIES = Object.keys(CAPABILITIES) as Capability[];

export function roleHasCapability(role: Role, capability: Capability): boolean {
  return (CAPABILITIES[capability] as readonly Role[]).includes(role);
}
