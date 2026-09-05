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

/** A loan event, exactly as the immutable timeline stores it. */
export type LoanEvent = {
  id: string;
  type: string;
  note: string | null;
  createdAt: string;
  actor: { id: string; name: string };
};

/** The full loan the single-loan endpoint returns. */
export type Loan = {
  id: string;
  itemId: string;
  borrowerId: string;
  status: LoanStatus;
  isOverdue: boolean;
  requestedAt: string;
  issuedAt: string | null;
  dueOn: string | null;
  returnedAt: string | null;
  lostAt: string | null;
};

export type LoanDetail = { loan: Loan; events: LoanEvent[] };

/**
 * A row in the loans list. The item and borrower are joined by the server, so
 * the table renders from one request rather than one request per row.
 */
export type LoanListRow = Loan & {
  item: { id: string; title: string; code: string; isArchived: boolean };
  borrower: { id: string; name: string; email: string };
};

/**
 * Per-row and per-loan reports from the bulk endpoints.
 *
 * Both are discriminated on `ok`, and both are rendered row by row: a report in
 * which some entries failed is a partial success, not a failed request, and the
 * UI must not flatten it into one.
 */
export type ImportRowResult =
  | { row: number; ok: true; itemId: string; code: string }
  | { row: number; ok: false; code: string; message: string };

export type ImportReport = { imported: number; failed: number; results: ImportRowResult[] };

export type BulkReturnResult =
  | { loanId: string; ok: true; status: 'returned' }
  | { loanId: string; ok: false; code: string; message: string };

export type BulkReturnReport = { returned: number; failed: number; results: BulkReturnResult[] };
