import { apiRequest, type Paginated } from './client.js';
import type { BulkReturnReport, Loan, LoanDetail, LoanListRow } from './types.js';

/**
 * Loan calls.
 *
 * Every function here is a thin wrapper over one endpoint. There is deliberately
 * no logic in this file: which transitions are legal, whether a loan is overdue,
 * whether an item is free — all of that is decided by the server and simply
 * reported back. The frontend's job is to ask and to show the answer.
 */

/** The query string goes to the server verbatim, so the URL *is* the request. */
export function listLoans(search: URLSearchParams): Promise<Paginated<LoanListRow>> {
  const query = search.toString();
  return apiRequest(`/loans${query ? `?${query}` : ''}`);
}

export function getLoan(id: string): Promise<LoanDetail> {
  return apiRequest(`/loans/${id}`);
}

/**
 * A member (or a librarian borrowing for themselves) requesting an item.
 *
 * Note what is *not* sent: there is no borrower field. The endpoint takes the
 * borrower from the session, so the browser has nothing to tamper with.
 */
export function requestLoan(itemId: string): Promise<{ loan: Loan }> {
  return apiRequest('/loans/request', { method: 'POST', body: { itemId } });
}

/** A librarian issuing an item straight to a borrower, with no prior request. */
export function createIssuedLoan(input: {
  itemId: string;
  borrowerId: string;
  dueOn: string;
  note?: string;
}): Promise<{ loan: Loan }> {
  return apiRequest('/loans', { method: 'POST', body: input });
}

export function issueLoan(
  id: string,
  input: { dueOn: string; note?: string },
): Promise<{ loan: Loan }> {
  return apiRequest(`/loans/${id}/issue`, { method: 'POST', body: input });
}

export function returnLoan(id: string, note?: string): Promise<{ loan: Loan }> {
  return apiRequest(`/loans/${id}/return`, { method: 'POST', body: note ? { note } : {} });
}

export function markLoanLost(id: string, note?: string): Promise<{ loan: Loan }> {
  return apiRequest(`/loans/${id}/lost`, { method: 'POST', body: note ? { note } : {} });
}

/**
 * Bulk return.
 *
 * The ids are sent exactly as chosen. Nothing here deduplicates or reorders
 * them: the server rejects a repeated id with `duplicate_loan_id`, and quietly
 * "fixing" the request in the browser would hide a real mistake and change what
 * the per-loan report means.
 */
export function bulkReturn(loanIds: string[], note?: string): Promise<BulkReturnReport> {
  return apiRequest('/loans/bulk-return', {
    method: 'POST',
    body: note ? { loanIds, note } : { loanIds },
  });
}

/**
 * The CSV export is a plain link, not a fetch.
 *
 * The server sends `Content-Disposition: attachment` with its own filename, so
 * letting the browser follow the URL produces a genuine download of exactly the
 * bytes the server generated. Fetching it and rebuilding a Blob in JavaScript
 * would mean the file the user saves was written by the frontend — a different
 * file that only resembles the export.
 */
export const ON_LOAN_EXPORT_URL = '/api/loans/export.csv';
