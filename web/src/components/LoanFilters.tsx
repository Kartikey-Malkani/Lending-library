import { useQuery } from '@tanstack/react-query';
import type { ChangeEvent } from 'react';
import { listItems } from '../api/catalogue.js';
import { listUsers } from '../api/users.js';

/**
 * Loan filters, driven entirely by the URL.
 *
 * Same contract as the catalogue filters: every control writes to the query
 * string, the list sends that query string to the server verbatim, and nothing
 * is filtered, sorted or paged in the browser. Open the network tab and the
 * request matches the address bar.
 *
 * `status=overdue` is offered alongside the four real statuses because the
 * server accepts it as a filter. Overdue is derived there, from `issued` plus a
 * due date in the past — it is not a stored status, and this component does not
 * compute it either.
 *
 * The borrower filter is shown only to librarians, because the server forces a
 * member's results to their own loans regardless of what the query string says.
 * Offering the control to a member would suggest it does something it does not.
 */
export function LoanFilters({
  params,
  onChange,
  showBorrower,
}: {
  params: URLSearchParams;
  onChange: (next: URLSearchParams) => void;
  showBorrower: boolean;
}) {
  // Enough to populate a picker for a library of this size; the hint below says
  // so when there are more.
  const items = useQuery({
    queryKey: ['items', 'picker'],
    queryFn: () => listItems(new URLSearchParams({ pageSize: '100', archived: 'all' })),
  });

  const people = useQuery({
    queryKey: ['users', 'picker'],
    queryFn: () => listUsers(),
    enabled: showBorrower,
  });

  function set(key: string, value: string) {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    // Any filter change invalidates the current page number.
    next.delete('page');
    onChange(next);
  }

  const handle = (key: string) => (e: ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    set(key, e.target.value);

  return (
    <div className="filters">
      <div className="field">
        <label htmlFor="loan-search">Search item or borrower</label>
        <input
          id="loan-search"
          type="search"
          value={params.get('search') ?? ''}
          onChange={handle('search')}
          placeholder="Title, name or email"
        />
      </div>

      <div className="field">
        <label htmlFor="loan-status">Status</label>
        <select id="loan-status" value={params.get('status') ?? ''} onChange={handle('status')}>
          <option value="">Any status</option>
          <option value="requested">Requested</option>
          <option value="issued">Issued</option>
          <option value="overdue">Overdue</option>
          <option value="returned">Returned</option>
          <option value="lost">Lost</option>
        </select>
      </div>

      <div className="field">
        <label htmlFor="loan-item">Item</label>
        <select id="loan-item" value={params.get('itemId') ?? ''} onChange={handle('itemId')}>
          <option value="">Any item</option>
          {(items.data?.rows ?? []).map((item) => (
            <option key={item.id} value={item.id}>
              {item.code} — {item.title}
            </option>
          ))}
        </select>
      </div>

      {showBorrower && (
        <div className="field">
          <label htmlFor="loan-borrower">Borrower</label>
          <select
            id="loan-borrower"
            value={params.get('borrowerId') ?? ''}
            onChange={handle('borrowerId')}
          >
            <option value="">Any borrower</option>
            {(people.data?.rows ?? []).map((user) => (
              <option key={user.id} value={user.id}>
                {user.name} — {user.email}
              </option>
            ))}
          </select>
        </div>
      )}

      <div className="field">
        <label htmlFor="loan-sort">Sort by</label>
        <select id="loan-sort" value={params.get('sort') ?? 'requestedAt'} onChange={handle('sort')}>
          <option value="requestedAt">Date requested</option>
          <option value="dueOn">Due date</option>
          <option value="status">Status</option>
        </select>
      </div>

      <div className="field">
        <label htmlFor="loan-dir">Direction</label>
        <select id="loan-dir" value={params.get('dir') ?? 'asc'} onChange={handle('dir')}>
          <option value="asc">Ascending</option>
          <option value="desc">Descending</option>
        </select>
      </div>
    </div>
  );
}
