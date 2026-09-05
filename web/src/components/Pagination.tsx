/**
 * Server-side pagination controls.
 *
 * `total` is the number of matches the server counted before paging, not the
 * length of the current page, so "Showing 21–40 of 137" is a fact from the
 * database rather than an estimate from what happens to be in memory.
 */
export function Pagination({
  page,
  pageSize,
  total,
  onPageChange,
}: {
  page: number;
  pageSize: number;
  total: number;
  onPageChange: (page: number) => void;
}) {
  const lastPage = Math.max(1, Math.ceil(total / pageSize));
  const first = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const last = Math.min(page * pageSize, total);

  return (
    <nav className="pagination" aria-label="Pagination">
      <button type="button" onClick={() => onPageChange(page - 1)} disabled={page <= 1}>
        ← Previous
      </button>
      <span aria-live="polite">
        {total === 0 ? 'No matches' : `Showing ${first}–${last} of ${total}`}
      </span>
      <button type="button" onClick={() => onPageChange(page + 1)} disabled={page >= lastPage}>
        Next →
      </button>
    </nav>
  );
}
