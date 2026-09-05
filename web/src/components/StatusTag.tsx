import type { LoanStatus } from '../api/types.js';

/**
 * A loan's status as text, with colour only as reinforcement.
 *
 * `isOverdue` is taken from the server response and never recomputed here.
 * Overdue is a derived property of a loan with a rule attached to it — issued,
 * and due strictly before today in UTC — and having React re-derive it from
 * `dueOn` in the browser's timezone would eventually disagree with the filter,
 * the dashboard and the export.
 */
export function StatusTag({ status, isOverdue }: { status: LoanStatus; isOverdue: boolean }) {
  const tone =
    status === 'issued' ? 'tag--ok' : status === 'lost' ? 'tag--warn' : 'tag--muted';

  return (
    <>
      <span className={`tag ${tone}`}>{status}</span>
      {isOverdue && <span className="tag tag--warn"> overdue</span>}
    </>
  );
}

/** Dates arrive as ISO strings; `dueOn` is a calendar date, so it is shown as one. */
export function isoDate(value: string | null): string {
  return value ? value.slice(0, 10) : '—';
}

export function dateTime(value: string): string {
  return new Date(value).toLocaleString();
}
