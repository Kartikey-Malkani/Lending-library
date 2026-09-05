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

/**
 * The dashboard, exactly as `GET /api/dashboard` returns it.
 *
 * Every number here is a database aggregate computed against one `asOf`
 * instant. Nothing in this shape is derived a second time in the browser.
 */
export type Dashboard = {
  /** The instant the server computed every number below against. */
  asOf: string;
  headline: {
    itemsCurrentlyOut: number;
    itemsOverdue: number;
    loansReturnedThisWeek: number;
    /** Active items. Archived ones are reported separately, not folded in. */
    totalItems: number;
    archivedItems: number;
  };
  /** The four real lifecycle statuses. Overdue is not one of them. */
  byStatus: { status: LoanStatus; count: number }[];
  /**
   * Loans per custodian, including an `Unassigned` bucket whose `custodianId`
   * is null. These counts deliberately do not sum to the number of loans: an
   * item may have several custodians and a loan counts once for each, because
   * each is responsible for it.
   */
  byCustodian: { custodianId: string | null; name: string; count: number }[];
  /** Exactly eight buckets, oldest first, the current ISO week last. */
  returnsPerWeek: { weekStart: string; count: number }[];
};

/** One overdue loan this librarian has not dismissed. */
export type Alert = {
  loanId: string;
  dueOn: string;
  daysOverdue: number;
  item: { id: string; code: string; title: string; isArchived: boolean };
  borrower: { id: string; name: string; email: string };
};

/**
 * `count` is every undismissed overdue loan, and `rows` is one page of them.
 * The navigation badge reads `count`; using `rows.length` would make the badge
 * say 20 on a library with 200 overdue items.
 */
export type AlertsPage = {
  rows: Alert[];
  count: number;
  total: number;
  page: number;
  pageSize: number;
};
