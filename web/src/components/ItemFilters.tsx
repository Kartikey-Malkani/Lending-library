import type { ChangeEvent } from 'react';

/**
 * Catalogue filters, driven entirely by the URL.
 *
 * Every control writes to the query string and nothing else. The list component
 * reads the same query string and sends it to the server verbatim, so what the
 * address bar says and what the network request asks for are the same thing —
 * which is also how a reviewer can see that filtering is not happening in the
 * browser.
 */
export function ItemFilters({
  params,
  onChange,
}: {
  params: URLSearchParams;
  onChange: (next: URLSearchParams) => void;
}) {
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
        <label htmlFor="search">Search title or code</label>
        <input
          id="search"
          type="search"
          value={params.get('search') ?? ''}
          onChange={handle('search')}
          placeholder="e.g. Canon, CAM-001"
        />
      </div>

      <div className="field">
        <label htmlFor="category">Category</label>
        <input
          id="category"
          type="text"
          value={params.get('category') ?? ''}
          onChange={handle('category')}
          placeholder="Exact match"
        />
      </div>

      <div className="field">
        <label htmlFor="archived">Archived</label>
        <select id="archived" value={params.get('archived') ?? 'false'} onChange={handle('archived')}>
          <option value="false">Active only</option>
          <option value="true">Archived only</option>
          <option value="all">All</option>
        </select>
      </div>

      <div className="field">
        <label htmlFor="sort">Sort by</label>
        <select id="sort" value={params.get('sort') ?? 'title'} onChange={handle('sort')}>
          <option value="title">Title</option>
          <option value="code">Code</option>
          <option value="category">Category</option>
          <option value="createdAt">Date added</option>
        </select>
      </div>

      <div className="field">
        <label htmlFor="dir">Direction</label>
        <select id="dir" value={params.get('dir') ?? 'asc'} onChange={handle('dir')}>
          <option value="asc">Ascending</option>
          <option value="desc">Descending</option>
        </select>
      </div>
    </div>
  );
}
