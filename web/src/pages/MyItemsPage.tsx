import { useQuery } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router-dom';
import { listMyItems } from '../api/catalogue.js';
import type { Item } from '../api/types.js';
import { Empty, ErrorState, Loading } from '../components/DataState.js';
import { Pagination } from '../components/Pagination.js';

/**
 * The items this librarian is custodian for — goal 5.
 *
 * Served by `GET /api/items/mine`, which derives the librarian from the session.
 * There is deliberately no parameter for whose items to list, and this page does
 * not filter the general catalogue response down: the server decides whose list
 * this is, so the answer cannot be widened from the browser.
 */
export function MyItemsPage() {
  const [params, setParams] = useSearchParams();

  const query = useQuery({
    queryKey: ['my-items', params.toString()],
    queryFn: () => listMyItems(params),
  });

  function goToPage(page: number) {
    const next = new URLSearchParams(params);
    next.set('page', String(page));
    setParams(next);
  }

  function setArchived(value: string) {
    const next = new URLSearchParams(params);
    if (value === 'false') next.delete('archived');
    else next.set('archived', value);
    next.delete('page');
    setParams(next);
  }

  return (
    <section>
      <div className="page-head">
        <h1>My items</h1>
      </div>
      <p className="hint">Every catalogue item you are a custodian for.</p>

      <div className="filters">
        <div className="field">
          <label htmlFor="mine-archived">Archived</label>
          <select
            id="mine-archived"
            value={params.get('archived') ?? 'false'}
            onChange={(e) => setArchived(e.target.value)}
          >
            <option value="false">Active only</option>
            <option value="true">Archived only</option>
            <option value="all">All</option>
          </select>
        </div>
      </div>

      {query.isPending && <Loading label="Loading your items…" />}
      {query.isError && <ErrorState error={query.error} title="Could not load your items" />}

      {query.data && (
        <>
          {query.data.rows.length === 0 ? (
            <Empty>You are not a custodian for any items yet.</Empty>
          ) : (
            <table className="table">
              <caption className="visually-hidden">Items you are custodian for</caption>
              <thead>
                <tr>
                  <th scope="col">Code</th>
                  <th scope="col">Title</th>
                  <th scope="col">Category</th>
                  <th scope="col">Status</th>
                </tr>
              </thead>
              <tbody>
                {query.data.rows.map((item: Item) => (
                  <tr key={item.id}>
                    <td>
                      <code>{item.code}</code>
                    </td>
                    <td>
                      <Link to={`/catalogue/${item.id}`}>{item.title}</Link>
                    </td>
                    <td>{item.category}</td>
                    <td>
                      <span className={item.isArchived ? 'tag tag--muted' : 'tag tag--ok'}>
                        {item.isArchived ? 'Archived' : 'Active'}
                      </span>
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
