export type Role = 'librarian' | 'member';

export type User = {
  id: string;
  name: string;
  email: string;
  role: Role;
};

export type Item = {
  id: string;
  title: string;
  category: string;
  code: string;
  archivedAt: string | null;
  isArchived: boolean;
  createdAt: string;
  updatedAt: string;
};

export type Custodian = {
  id: string;
  name: string;
  email: string;
  assignedAt: string;
};

export type LoanStatus = 'requested' | 'issued' | 'returned' | 'lost';

/** The loan summary the item detail endpoint returns for a librarian. */
export type ItemLoan = {
  id: string;
  borrowerId: string;
  status: LoanStatus;
  isOverdue: boolean;
  requestedAt: string;
  issuedAt: string | null;
  dueOn: string | null;
  returnedAt: string | null;
  lostAt: string | null;
};

/**
 * `custodians` and `loans` are present only for a librarian — the server omits
 * them entirely for a member rather than sending them and trusting the client
 * not to render them.
 */
export type ItemDetail = {
  item: Item;
  custodians?: Custodian[];
  loans?: ItemLoan[];
};
