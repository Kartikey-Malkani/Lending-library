import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { createItem, listItems } from '../api/catalogue.js';
import type { Item } from '../api/types.js';
import { useAuth } from '../auth/AuthProvider.js';
import { Empty, ErrorState, Loading } from '../components/DataState.js';
import { ItemFilters } from '../components/ItemFilters.js';
import { Pagination } from '../components/Pagination.js';

export function CataloguePage() {
  const [params, setParams] = useSearchParams();
  const { hasRole } = useAuth();
  const isLibrarian = hasRole('librarian');
  const [showCreate, setShowCreate] = useState(false);

  // The query key is the URL, so changing a filter changes the request. There
  // is no client-side filtering anywhere in this component.
  const query = useQuery({
    queryKey: ['items', params.toString()],
    queryFn: () => listItems(params),
  });

  function goToPage(page: number) {
    const next = new URLSearchParams(params);
    next.set('page', String(page));
    setParams(next);
  }

  return (
    <section>
      <div className="page-head">
        <h1>Catalogue</h1>
        {isLibrarian && (
          <button type="button" className="primary" onClick={() => setShowCreate((v) => !v)}>
            {showCreate ? 'Cancel' : 'Add item'}
          </button>
        )}
      </div>

      {isLibrarian && showCreate && <CreateItemForm onDone={() => setShowCreate(false)} />}

      <ItemFilters params={params} onChange={setParams} />

      {query.isPending && <Loading label="Loading catalogue…" />}
      {query.isError && <ErrorState error={query.error} title="Could not load the catalogue" />}

      {query.data && (
        <>
          {query.data.rows.length === 0 ? (
            <Empty>No items match these filters.</Empty>
          ) : (
            <table className="table">
              <caption className="visually-hidden">Catalogue items</caption>
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
                    <td><code>{item.code}</code></td>
                    <td>
                      <Link to={`/catalogue/${item.id}`}>{item.title}</Link>
                    </td>
                    <td>{item.category}</td>
                    <td>
                      {/* Text, not only colour — the state must be readable without it. */}
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

function CreateItemForm({ onDone }: { onDone: () => void }) {
  const queryClient = useQueryClient();
  const [title, setTitle] = useState('');
  const [category, setCategory] = useState('');
  const [code, setCode] = useState('');

  const create = useMutation({
    mutationFn: () => createItem({ title, category, code }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['items'] });
      onDone();
    },
  });

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    create.mutate();
  }

  return (
    <form onSubmit={onSubmit} className="form form--inline panel">
      <h2>New item</h2>

      <div className="field">
        <label htmlFor="new-title">Title</label>
        <input id="new-title" required value={title} onChange={(e) => setTitle(e.target.value)} />
      </div>
      <div className="field">
        <label htmlFor="new-category">Category</label>
        <input id="new-category" required value={category} onChange={(e) => setCategory(e.target.value)} />
      </div>
      <div className="field">
        <label htmlFor="new-code">Identifying code</label>
        <input id="new-code" required value={code} onChange={(e) => setCode(e.target.value)} />
      </div>

      <button type="submit" className="primary" disabled={create.isPending}>
        {create.isPending ? 'Creating…' : 'Create'}
      </button>

      {/* The server's message verbatim — including "Another catalogue item
          already uses the code CAM-001", which is more useful than anything
          this form could invent. */}
      {create.isError && <ErrorState error={create.error} title="Could not create the item" />}
    </form>
  );
}
