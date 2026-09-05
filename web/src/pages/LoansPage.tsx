import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { bulkReturn, listLoans, ON_LOAN_EXPORT_URL } from '../api/loans.js';
import type { BulkReturnReport, LoanListRow } from '../api/types.js';
import { useAuth } from '../auth/AuthProvider.js';
import { Empty, ErrorState, Loading } from '../components/DataState.js';
import { LoanFilters } from '../components/LoanFilters.js';
import { Pagination } from '../components/Pagination.js';
import { isoDate, StatusTag } from '../components/StatusTag.js';

/**
 * Every loan, or — for a member — every loan of theirs.
 *
 * The scoping is not done here. `GET /api/loans` replaces a member's
 * `borrowerId` with their own id before it builds the query, so a member who
 * edits the URL still gets their own loans. This page shows what came back.
 */
export function LoansPage() {
  const [params, setParams] = useSearchParams();
  const { hasRole } = useAuth();
  const isLibrarian = hasRole('librarian');

  // The query key is the URL. Change a filter, change the request — there is no
  // second copy of the filtering logic in React to drift from the server's.
  const query = useQuery({
    queryKey: ['loans', params.toString()],
    queryFn: () => listLoans(params),
  });

  const [selected, setSelected] = useState<string[]>([]);
  const [report, setReport] = useState<BulkReturnReport | null>(null);

  // Selection belongs to the result set it was made in. When the filters or the
  // page change the rows on screen change, and a hidden selection would be a
  // bulk action nobody could see the contents of.
  const paramKey = params.toString();
  useEffect(() => {
    setSelected([]);
  }, [paramKey]);

  function goToPage(page: number) {
    const next = new URLSearchParams(params);
    next.set('page', String(page));
    setParams(next);
  }

  const rows = query.data?.rows ?? [];

  return (
    <section>
      <div className="page-head">
        <h1>Loans</h1>
        {isLibrarian && (
          /*
           * A plain link, not a fetch.
           *
           * The server answers with `Content-Disposition: attachment` and its
           * own dated filename, so following the URL saves exactly the bytes it
           * generated. Downloading the rows and rebuilding a CSV here would
           * produce a different file that merely looks similar — and one that
           * could only ever contain the current page.
           */
          <a className="button-link" href={ON_LOAN_EXPORT_URL}>
            Export items on loan (CSV)
          </a>
        )}
      </div>

      {!isLibrarian && (
        <p className="hint">These are your loans. The server decides that, not this page.</p>
      )}

      <LoanFilters params={params} onChange={setParams} showBorrower={isLibrarian} />

      {isLibrarian && selected.length > 0 && (
        <BulkReturnPanel
          selected={selected}
          rows={rows}
          onDone={(result) => {
            setReport(result);
            setSelected([]);
          }}
        />
      )}

      {report && <BulkReturnReportView report={report} onDismiss={() => setReport(null)} />}

      {query.isPending && <Loading label="Loading loans…" />}
      {query.isError && <ErrorState error={query.error} title="Could not load loans" />}

      {query.data && (
        <>
          {rows.length === 0 ? (
            <Empty>No loans match these filters.</Empty>
          ) : (
            <table className="table">
              <caption className="visually-hidden">Loans</caption>
              <thead>
                <tr>
                  {isLibrarian && (
                    <th scope="col">
                      <span className="visually-hidden">Select for bulk return</span>
                    </th>
                  )}
                  <th scope="col">Item</th>
                  <th scope="col">Borrower</th>
                  <th scope="col">Status</th>
                  <th scope="col">Requested</th>
                  <th scope="col">Due</th>
                  <th scope="col">
                    <span className="visually-hidden">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((loan: LoanListRow) => (
                  <tr key={loan.id}>
                    {isLibrarian && (
                      <td>
                        <input
                          type="checkbox"
                          checked={selected.includes(loan.id)}
                          onChange={(e) =>
                            setSelected((prev) =>
                              e.target.checked
                                ? [...prev, loan.id]
                                : prev.filter((id) => id !== loan.id),
                            )
                          }
                          aria-label={`Select loan of ${loan.item.title} to ${loan.borrower.name}`}
                        />
                      </td>
                    )}
                    <td>
                      <Link to={`/catalogue/${loan.item.id}`}>{loan.item.title}</Link>{' '}
                      <code>{loan.item.code}</code>
                      {loan.item.isArchived && <span className="tag tag--muted"> archived</span>}
                    </td>
                    <td>
                      {loan.borrower.name}
                      <br />
                      <span className="hint">{loan.borrower.email}</span>
                    </td>
                    <td>
                      <StatusTag status={loan.status} isOverdue={loan.isOverdue} />
                    </td>
                    <td>{isoDate(loan.requestedAt)}</td>
                    <td>{isoDate(loan.dueOn)}</td>
                    <td>
                      <Link to={`/loans/${loan.id}`}>Open</Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          <Pagination
            page={query.data.page}
            pageSize={query.data.pageSize}
            total={query.data.total}
            onPageChange={goToPage}
          />
        </>
      )}
    </section>
  );
}

/**
 * Returning several loans at once.
 *
 * The selected ids are sent exactly as they are. Nothing is filtered out first
 * for being the wrong status — the point of the per-loan report is that the
 * server says which ones it could return and why the others could not, and
 * pre-screening in the browser would replace that answer with a guess.
 */
function BulkReturnPanel({
  selected,
  rows,
  onDone,
}: {
  selected: string[];
  rows: LoanListRow[];
  onDone: (report: BulkReturnReport) => void;
}) {
  const queryClient = useQueryClient();
  const [note, setNote] = useState('');

  const run = useMutation({
    mutationFn: () => bulkReturn(selected, note.trim() || undefined),
    onSuccess: (report) => {
      // Loans changed state, so every cached view of a loan is now suspect.
      queryClient.invalidateQueries({ queryKey: ['loans'] });
      queryClient.invalidateQueries({ queryKey: ['loan'] });
      queryClient.invalidateQueries({ queryKey: ['item'] });
      onDone(report);
    },
  });

  const names = selected.map((id) => rows.find((row) => row.id === id)?.item.title ?? id);

  return (
    <div className="panel">
      <h2>Bulk return</h2>
      <p className="hint">
        {selected.length} selected: {names.join(', ')}
      </p>

      <div className="form form--inline">
        <div className="field">
          <label htmlFor="bulk-note">Note (optional, applied to every return)</label>
          <input id="bulk-note" value={note} onChange={(e) => setNote(e.target.value)} />
        </div>
        <button
          type="button"
          className="primary"
          onClick={() => run.mutate()}
          disabled={run.isPending}
        >
          {run.isPending ? 'Returning…' : `Return ${selected.length} selected`}
        </button>
      </div>

      {/*
        A request-level rejection — a repeated id, or more than the server's
        limit — is a 400 and never reaches the per-loan report. Shown as the
        server worded it.
      */}
      {run.isError && <ErrorState error={run.error} title="The bulk return was rejected" />}
    </div>
  );
}

/**
 * The per-loan outcome.
 *
 * A run in which some loans failed is a partial success and is shown as one:
 * counts for both, then a row per loan carrying the server's own code and
 * message. Collapsing this into "bulk return failed" would hide the returns
 * that actually happened, which is worse than unhelpful — it is untrue.
 */
function BulkReturnReportView({
  report,
  onDismiss,
}: {
  report: BulkReturnReport;
  onDismiss: () => void;
}) {
  return (
    <div className="panel">
      <div className="page-head">
        <h2>Bulk return result</h2>
        <button type="button" onClick={onDismiss}>
          Dismiss
        </button>
      </div>

      <p role="status">
        <strong>{report.returned}</strong> returned, <strong>{report.failed}</strong> failed.
      </p>

      <table className="table">
        <caption className="visually-hidden">Result for each selected loan</caption>
        <thead>
          <tr>
            <th scope="col">Loan</th>
            <th scope="col">Result</th>
            <th scope="col">Detail</th>
          </tr>
        </thead>
        <tbody>
          {report.results.map((result) => (
            <tr key={result.loanId}>
              <td>
                <Link to={`/loans/${result.loanId}`}>
                  <code>{result.loanId.slice(0, 8)}</code>
                </Link>
              </td>
              <td>
                <span className={result.ok ? 'tag tag--ok' : 'tag tag--warn'}>
                  {result.ok ? 'Returned' : 'Failed'}
                </span>
              </td>
              <td>
                {result.ok ? (
                  result.status
                ) : (
                  <>
                    {result.message} <span className="state__code">({result.code})</span>
                  </>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
