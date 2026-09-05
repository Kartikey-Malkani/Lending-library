import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router-dom';
import { dismissAlert, listAlerts } from '../api/alerts.js';
import type { Alert } from '../api/types.js';
import { Empty, ErrorState, Loading } from '../components/DataState.js';
import { Pagination } from '../components/Pagination.js';

/**
 * Overdue alerts — goal 10.
 *
 * The list is derived by the server on every read, so there is nothing here
 * that tracks which alerts have been seen. Dismissal is a real write, scoped to
 * this librarian and keyed on the loan: if the item is issued again later and
 * goes overdue on the new loan, that is a different loan row and the alert
 * comes back on its own.
 */
export function AlertsPage() {
  const [params, setParams] = useSearchParams();
  const queryClient = useQueryClient();

  const query = useQuery({
    queryKey: ['alerts', params.toString()],
    queryFn: () => listAlerts(params),
  });

  const dismiss = useMutation({
    mutationFn: (loanId: string) => dismissAlert(loanId),
    onSuccess: () => {
      // Both this page and the navigation badge read from `/alerts`, and the
      // badge is a separate query. Invalidating the prefix refreshes both, so
      // the count in the header cannot keep showing the dismissed alert.
      queryClient.invalidateQueries({ queryKey: ['alerts'] });
    },
  });

  function goToPage(page: number) {
    const next = new URLSearchParams(params);
    next.set('page', String(page));
    setParams(next);
  }

  return (
    <section>
      <div className="page-head">
        <h1>Overdue alerts</h1>
        {/* `count` is every undismissed overdue loan, not the size of this page. */}
        {query.data && <span className="tag tag--warn">{query.data.count} outstanding</span>}
      </div>

      <p className="hint">
        Loans still out past their due date. Dismissing one hides it from your list only — the
        rest of the team still sees it, and it returns if the item goes overdue on a future loan.
      </p>

      {query.isPending && <Loading label="Loading alerts…" />}
      {query.isError && <ErrorState error={query.error} title="Could not load alerts" />}

      {/*
        A refused dismissal — a loan that was returned in the meantime, so there
        is no alert to dismiss — comes back 409 `not_overdue`. Shown in the
        server's own words rather than swallowed as "nothing happened".
      */}
      {dismiss.isError && <ErrorState error={dismiss.error} title="Could not dismiss that alert" />}

      {query.data && (
        <>
          {query.data.rows.length === 0 ? (
            <Empty>Nothing is overdue. Every issued item is still within its due date.</Empty>
          ) : (
            <table className="table">
              <caption className="visually-hidden">Overdue loans awaiting your attention</caption>
              <thead>
                <tr>
                  <th scope="col">Item</th>
                  <th scope="col">Borrower</th>
                  <th scope="col">Due</th>
                  <th scope="col">Overdue by</th>
                  <th scope="col">
                    <span className="visually-hidden">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {query.data.rows.map((alert: Alert) => (
                  <tr key={alert.loanId}>
                    <td>
                      <Link to={`/catalogue/${alert.item.id}`}>{alert.item.title}</Link>{' '}
                      <code>{alert.item.code}</code>
                      {alert.item.isArchived && <span className="tag tag--muted"> archived</span>}
                    </td>
                    <td>
                      {alert.borrower.name}
                      <br />
                      <span className="hint">{alert.borrower.email}</span>
                    </td>
                    <td>{alert.dueOn.slice(0, 10)}</td>
                    <td>
                      {/* The server's own figure, not a date subtraction done here. */}
                      <span className="tag tag--warn">
                        {alert.daysOverdue} {alert.daysOverdue === 1 ? 'day' : 'days'}
                      </span>
                    </td>
                    <td>
                      <Link to={`/loans/${alert.loanId}`}>Open loan</Link>{' '}
                      <button
                        type="button"
                        onClick={() => dismiss.mutate(alert.loanId)}
                        disabled={dismiss.isPending}
                      >
                        Dismiss
                      </button>
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
