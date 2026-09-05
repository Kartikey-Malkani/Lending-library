import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router-dom';
import { getItem } from '../api/catalogue.js';
import { getLoan, issueLoan, markLoanLost, returnLoan } from '../api/loans.js';
import { listUsers } from '../api/users.js';
import type { LoanEvent } from '../api/types.js';
import { useAuth } from '../auth/AuthProvider.js';
import { Empty, ErrorState, Loading } from '../components/DataState.js';
import { dateTime, isoDate, StatusTag } from '../components/StatusTag.js';

export function LoanDetailPage() {
  const { id = '' } = useParams();
  const { user, hasRole } = useAuth();
  const isLibrarian = hasRole('librarian');

  const query = useQuery({ queryKey: ['loan', id], queryFn: () => getLoan(id) });

  // The loan carries ids; a person needs names. Both come from endpoints the
  // reader is already allowed to call, so nothing new is exposed to fetch them.
  const item = useQuery({
    queryKey: ['item', query.data?.loan.itemId ?? ''],
    queryFn: () => getItem(query.data!.loan.itemId),
    enabled: Boolean(query.data),
  });

  const people = useQuery({
    queryKey: ['users', 'picker'],
    queryFn: () => listUsers(),
    enabled: isLibrarian,
  });

  if (query.isPending) return <Loading label="Loading loan…" />;
  if (query.isError) return <ErrorState error={query.error} title="Could not load this loan" />;

  const { loan, events } = query.data;
  const borrower = people.data?.rows.find((row) => row.id === loan.borrowerId);
  const borrowerLabel =
    loan.borrowerId === user?.id
      ? 'You'
      : borrower
        ? `${borrower.name} (${borrower.email})`
        : loan.borrowerId;

  return (
    <section>
      <p>
        <Link to="/loans">← Back to loans</Link>
      </p>

      <div className="page-head">
        <h1>{item.data?.item.title ?? 'Loan'}</h1>
        <StatusTag status={loan.status} isOverdue={loan.isOverdue} />
      </div>

      <dl className="facts">
        <dt>Item</dt>
        <dd>
          <Link to={`/catalogue/${loan.itemId}`}>
            {item.data ? `${item.data.item.code} — ${item.data.item.title}` : loan.itemId}
          </Link>
        </dd>
        <dt>Borrower</dt>
        <dd>{borrowerLabel}</dd>
        <dt>Requested</dt>
        <dd>{dateTime(loan.requestedAt)}</dd>
        <dt>Issued</dt>
        <dd>{loan.issuedAt ? dateTime(loan.issuedAt) : '—'}</dd>
        <dt>Due</dt>
        <dd>{isoDate(loan.dueOn)}</dd>
        <dt>Returned</dt>
        <dd>{loan.returnedAt ? dateTime(loan.returnedAt) : '—'}</dd>
        <dt>Lost</dt>
        <dd>{loan.lostAt ? dateTime(loan.lostAt) : '—'}</dd>
      </dl>

      {isLibrarian && <LifecycleActions loanId={loan.id} itemId={loan.itemId} />}

      <Timeline events={events} />
    </section>
  );
}

/**
 * Issue, return and mark lost.
 *
 * All three are always offered and always enabled, whatever state the loan is
 * in, and that is deliberate rather than lazy. The rules about which transition
 * is legal live in one place — the conditional UPDATE in the server's
 * `transition()` — and the server answers a refused move with a 409 that names
 * the current state: "Cannot return this loan because it has already been
 * returned. The loan is returned."
 *
 * Greying out a button according to the status this page happens to be holding
 * would recreate that rule in React, where it can drift, and would also hide
 * the genuinely interesting case: the status on screen is a moment old, and
 * another librarian may already have acted on the same loan. Letting the
 * request go and showing the refusal is both simpler and more truthful.
 */
function LifecycleActions({ loanId, itemId }: { loanId: string; itemId: string }) {
  const queryClient = useQueryClient();
  const [dueOn, setDueOn] = useState('');
  const [note, setNote] = useState('');

  function afterChange() {
    // The loan, every list it appears in, and the item's own loan history all
    // just became stale. Refetch rather than leave a screen showing the state
    // from before the action.
    queryClient.invalidateQueries({ queryKey: ['loan', loanId] });
    queryClient.invalidateQueries({ queryKey: ['loans'] });
    queryClient.invalidateQueries({ queryKey: ['item', itemId] });
    setNote('');
  }

  const issue = useMutation({
    mutationFn: () => issueLoan(loanId, note.trim() ? { dueOn, note: note.trim() } : { dueOn }),
    onSuccess: afterChange,
  });
  const giveBack = useMutation({
    mutationFn: () => returnLoan(loanId, note.trim() || undefined),
    onSuccess: afterChange,
  });
  const lost = useMutation({
    mutationFn: () => markLoanLost(loanId, note.trim() || undefined),
    onSuccess: afterChange,
  });

  function onIssue(event: FormEvent) {
    event.preventDefault();
    issue.mutate();
  }

  return (
    <div className="panel">
      <h2>Actions</h2>
      <p className="hint">
        Every action is sent to the server, which decides whether it is allowed. A move that is not
        permitted comes back refused, with the reason.
      </p>

      <form onSubmit={onIssue} className="form form--inline">
        <div className="field">
          <label htmlFor="issue-due">Due date</label>
          <input
            id="issue-due"
            type="date"
            required
            value={dueOn}
            onChange={(e) => setDueOn(e.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor="action-note">Note (optional)</label>
          <input id="action-note" value={note} onChange={(e) => setNote(e.target.value)} />
        </div>
        <button type="submit" className="primary" disabled={issue.isPending}>
          {issue.isPending ? 'Issuing…' : 'Issue'}
        </button>
      </form>

      <div className="form form--inline">
        <button type="button" onClick={() => giveBack.mutate()} disabled={giveBack.isPending}>
          {giveBack.isPending ? 'Returning…' : 'Mark returned'}
        </button>
        <button type="button" onClick={() => lost.mutate()} disabled={lost.isPending}>
          {lost.isPending ? 'Saving…' : 'Mark lost'}
        </button>
      </div>

      {/*
        The server's own words, including the 409s. `ErrorState` also renders
        the `details` payload, which for a refused transition carries the loan's
        actual current status.
      */}
      {issue.isError && <ErrorState error={issue.error} title="Could not issue this loan" />}
      {giveBack.isError && <ErrorState error={giveBack.error} title="Could not return this loan" />}
      {lost.isError && <ErrorState error={lost.error} title="Could not mark this loan lost" />}

      {(issue.isSuccess || giveBack.isSuccess || lost.isSuccess) &&
        !issue.isError &&
        !giveBack.isError &&
        !lost.isError && (
          <p className="notice" role="status">
            Done. The loan and its timeline have been reloaded.
          </p>
        )}
    </div>
  );
}

/**
 * The immutable timeline.
 *
 * Read-only, and not by convention: `loan_events` has a database trigger that
 * rejects UPDATE and DELETE, and the application role holds only SELECT and
 * INSERT on the table. There is deliberately no edit or delete control here,
 * because there is no endpoint behind one and no way for the database to
 * satisfy it.
 *
 * Ordering comes from the server — (created_at, type, id) — and is not re-sorted
 * here. A direct issue writes `requested` and `issued` at the same instant, and
 * only the server's tiebreak puts them in lifecycle order.
 */
function Timeline({ events }: { events: LoanEvent[] }) {
  return (
    <div className="panel">
      <h2>History</h2>
      <p className="hint">
        Every state change this loan has been through. Entries are append-only and cannot be edited
        or removed.
      </p>

      {events.length === 0 ? (
        <Empty>No events recorded.</Empty>
      ) : (
        <ol className="timeline">
          {events.map((event) => (
            <li key={event.id} className="timeline__item">
              <span className="tag">{event.type}</span>
              <div>
                <strong>{event.actor.name}</strong>
                <span className="hint"> · {dateTime(event.createdAt)}</span>
                {event.note && <p className="timeline__note">{event.note}</p>}
              </div>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
