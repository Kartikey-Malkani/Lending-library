import { ApiError } from '../http/errors.js';
import { returnLoan } from './service.js';

/**
 * Returning several loans in one action.
 *
 * This module contains no business rules of its own. Each loan goes through the
 * same `returnLoan()` the single-loan endpoint calls, which means bulk return
 * inherits, rather than reimplements:
 *
 *   - the conditional UPDATE that makes a concurrent return or mark-lost lose
 *     safely instead of both succeeding
 *   - the immutable `returned` event, written in the same transaction as the
 *     state change
 *   - the rejection messages, including the brief's own example of "a loan that
 *     was already returned"
 *
 * A bulk-specific copy of those rules would drift from the single path, and the
 * two would eventually disagree about what a return means.
 *
 * Loans are processed one at a time, each in its own transaction, so one
 * rejection cannot roll back the returns that already succeeded.
 */

export const MAX_BULK_RETURN = 200;

export type BulkReturnResult =
  | { loanId: string; ok: true; status: 'returned' }
  | { loanId: string; ok: false; code: string; message: string };

export type BulkReturnReport = {
  returned: number;
  failed: number;
  results: BulkReturnResult[];
};

export async function bulkReturnLoans(input: {
  loanIds: string[];
  note?: string | undefined;
  actorId: string;
}): Promise<BulkReturnReport> {
  const results: BulkReturnResult[] = [];

  for (const loanId of input.loanIds) {
    try {
      const loan = await returnLoan({ loanId, note: input.note, actorId: input.actorId });
      results.push({ loanId, ok: true, status: loan.status as 'returned' });
    } catch (error) {
      if (error instanceof ApiError) {
        results.push({ loanId, ok: false, code: error.code, message: error.message });
        continue;
      }
      console.error(`Unexpected error returning loan ${loanId}:`, error);
      results.push({
        loanId,
        ok: false,
        code: 'internal_error',
        message: 'This loan could not be returned.',
      });
    }
  }

  return {
    returned: results.filter((result) => result.ok).length,
    failed: results.filter((result) => !result.ok).length,
    results,
  };
}
