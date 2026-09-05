import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router-dom';
import { archiveItem, getItem, restoreItem, setCustodians, updateItem } from '../api/catalogue.js';
import { createIssuedLoan, requestLoan } from '../api/loans.js';
import { listLibrarians } from '../api/users.js';
import type { ItemLoan } from '../api/types.js';
import { useAuth } from '../auth/AuthProvider.js';
import { BorrowerPicker } from '../components/BorrowerPicker.js';
import { Empty, ErrorState, Loading } from '../components/DataState.js';
import { isoDate, StatusTag } from '../components/StatusTag.js';

export function ItemDetailPage() {
  const { id = '' } = useParams();
  const { hasRole } = useAuth();
  const isLibrarian = hasRole('librarian');

  const query = useQuery({ queryKey: ['item', id], queryFn: () => getItem(id) });

  if (query.isPending) return <Loading label="Loading item…" />;
  if (query.isError) return <ErrorState error={query.error} title="Could not load this item" />;

  const { item, custodians, loans } = query.data;

  return (
    <section>
      <p>
        <Link to="/catalogue">← Back to catalogue</Link>
      </p>

      <div className="page-head">
        <h1>{item.title}</h1>
        <span className={item.isArchived ? 'tag tag--muted' : 'tag tag--ok'}>
          {item.isArchived ? 'Archived' : 'Active'}
        </span>
      </div>

      <dl className="facts">
        <dt>Code</dt>
        <dd>
          <code>{item.code}</code>
        </dd>
        <dt>Category</dt>
        <dd>{item.category}</dd>
        <dt>Added</dt>
        <dd>{new Date(item.createdAt).toLocaleDateString()}</dd>
        {item.archivedAt && (
          <>
            <dt>Archived on</dt>
            <dd>{new Date(item.archivedAt).toLocaleDateString()}</dd>
          </>
        )}
      </dl>

      <LoanActions itemId={id} isLibrarian={isLibrarian} />

      {isLibrarian && <EditItem id={id} initial={item} />}
      {isLibrarian && <ArchiveControls id={id} isArchived={item.isArchived} />}
      {isLibrarian && <CustodianEditor id={id} current={custodians ?? []} />}

      {/*
        Loan history is librarian-only. The server does not send it to a member
        at all, because it would reveal who else has borrowed the item.
      */}
      {isLibrarian && <LoanHistory loans={loans ?? []} />}
    </section>
  );
}

function EditItem({
  id,
  initial,
}: {
  id: string;
  initial: { title: string; category: string; code: string };
}) {
  const queryClient = useQueryClient();
  const [title, setTitle] = useState(initial.title);
  const [category, setCategory] = useState(initial.category);
  const [code, setCode] = useState(initial.code);

  const save = useMutation({
    mutationFn: () => updateItem(id, { title, category, code }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['item', id] });
      queryClient.invalidateQueries({ queryKey: ['items'] });
    },
  });

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    save.mutate();
  }

  return (
    <form onSubmit={onSubmit} className="form form--inline panel">
      <h2>Edit details</h2>

      <div className="field">
        <label htmlFor="edit-title">Title</label>
        <input id="edit-title" required value={title} onChange={(e) => setTitle(e.target.value)} />
      </div>
      <div className="field">
        <label htmlFor="edit-category">Category</label>
        <input
          id="edit-category"
          required
          value={category}
          onChange={(e) => setCategory(e.target.value)}
        />
      </div>
      <div className="field">
        <label htmlFor="edit-code">Code</label>
        <input id="edit-code" required value={code} onChange={(e) => setCode(e.target.value)} />
      </div>

      <button type="submit" className="primary" disabled={save.isPending}>
        {save.isPending ? 'Saving…' : 'Save changes'}
      </button>
      {save.isSuccess && (
        <p className="notice" role="status">
          Saved.
        </p>
      )}
      {save.isError && <ErrorState error={save.error} title="Could not save" />}
    </form>
  );
}

function ArchiveControls({ id, isArchived }: { id: string; isArchived: boolean }) {
  const queryClient = useQueryClient();

  const change = useMutation({
    mutationFn: () => (isArchived ? restoreItem(id) : archiveItem(id)),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['item', id] });
      queryClient.invalidateQueries({ queryKey: ['items'] });
    },
  });

  return (
    <div className="panel">
      <h2>{isArchived ? 'Restore' : 'Archive'}</h2>
      <p className="hint">
        {isArchived
          ? 'Restoring puts the item back into the default catalogue view and allows new loans.'
          : 'Archiving hides the item from the default catalogue and stops new loans. Loans already open stay open and can still be returned.'}
      </p>
      <button type="button" onClick={() => change.mutate()} disabled={change.isPending}>
        {change.isPending ? 'Working…' : isArchived ? 'Restore item' : 'Archive item'}
      </button>
      {/*
        A 409 here is the server saying the item is already in that state.
        Shown as-is rather than reduced to "failed".
      */}
      {change.isError && <ErrorState error={change.error} title="Could not change the item" />}
    </div>
  );
}

function CustodianEditor({
  id,
  current,
}: {
  id: string;
  current: { id: string; name: string }[];
}) {
  const queryClient = useQueryClient();
  const librarians = useQuery({ queryKey: ['librarians'], queryFn: listLibrarians });
  const [selected, setSelected] = useState<string[]>(current.map((c) => c.id));

  // Re-sync when the item reloads, so the checkboxes reflect the server rather
  // than whatever was last clicked.
  useEffect(() => {
    setSelected(current.map((c) => c.id));
  }, [current]);

  const save = useMutation({
    mutationFn: () => setCustodians(id, selected),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['item', id] }),
  });

  function toggle(librarianId: string) {
    setSelected((prev) =>
      prev.includes(librarianId) ? prev.filter((x) => x !== librarianId) : [...prev, librarianId],
    );
  }

  return (
    <div className="panel">
      <h2>Custodians</h2>
      <p className="hint">
        Librarians responsible for the condition and location of this item. An item can have
        several, and a librarian can look after many. Being a custodian does not restrict who may
        edit the item.
      </p>

      {librarians.isPending && <Loading label="Loading librarians…" />}
      {librarians.isError && (
        <ErrorState error={librarians.error} title="Could not load librarians" />
      )}

      {librarians.data && (
        <>
          <fieldset className="checklist">
            <legend className="visually-hidden">Choose custodians</legend>
            {librarians.data.rows.map((librarian) => (
              <label key={librarian.id} className="checklist__item">
                <input
                  type="checkbox"
                  checked={selected.includes(librarian.id)}
                  onChange={() => toggle(librarian.id)}
                />
                {librarian.name} <span className="hint">({librarian.email})</span>
              </label>
            ))}
          </fieldset>

          <button
            type="button"
            className="primary"
            onClick={() => save.mutate()}
            disabled={save.isPending}
          >
            {save.isPending ? 'Saving…' : 'Save custodians'}
          </button>
          {save.isSuccess && (
            <p className="notice" role="status">
              Custodians updated.
            </p>
          )}
          {save.isError && <ErrorState error={save.error} title="Could not update custodians" />}
        </>
      )}
    </div>
  );
}

function LoanHistory({ loans }: { loans: ItemLoan[] }) {
  return (
    <div className="panel">
      <h2>Loan history</h2>
      {loans.length === 0 ? (
        <Empty>This item has never been loaned.</Empty>
      ) : (
        <table className="table">
          <caption className="visually-hidden">Every loan ever made against this item</caption>
          <thead>
            <tr>
              <th scope="col">Status</th>
              <th scope="col">Requested</th>
              <th scope="col">Due</th>
              <th scope="col">Closed</th>
              <th scope="col">
                <span className="visually-hidden">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {loans.map((loan) => (
              <tr key={loan.id}>
                <td>
                  <StatusTag status={loan.status} isOverdue={loan.isOverdue} />
                </td>
                <td>{isoDate(loan.requestedAt)}</td>
                <td>{isoDate(loan.dueOn)}</td>
                <td>
                  {loan.returnedAt
                    ? `returned ${isoDate(loan.returnedAt)}`
                    : loan.lostAt
                      ? `lost ${isoDate(loan.lostAt)}`
                      : '—'}
                </td>
                <td>
                  <Link to={`/loans/${loan.id}`}>Open</Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

/**
 * Borrowing this item.
 *
 * Two genuinely different actions, kept apart because the endpoints behind them
 * are different:
 *
 *   - Requesting is for yourself. `POST /loans/request` has no borrower field at
 *     all, so the borrower is the session user by construction. There is nothing
 *     for the browser to set and nothing for a member to tamper with.
 *   - Direct issue is acting on someone else's behalf, which is a librarian
 *     capability (`loan:create-issued`). It goes to `POST /loans` with a chosen
 *     borrower and a due date.
 *
 * Whether the item is free is not checked here. A partial unique index in the
 * database permits one open loan per item, so the honest answer comes from
 * trying — and a pre-check in React would be stale the moment another librarian
 * commits.
 */
function LoanActions({ itemId, isLibrarian }: { itemId: string; isLibrarian: boolean }) {
  return (
    <div className="panel">
      <h2>Loans</h2>
      <RequestForMyself itemId={itemId} />
      {isLibrarian && <DirectIssue itemId={itemId} />}
    </div>
  );
}

function RequestForMyself({ itemId }: { itemId: string }) {
  const queryClient = useQueryClient();
  const { user } = useAuth();

  const request = useMutation({
    mutationFn: () => requestLoan(itemId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['item', itemId] });
      queryClient.invalidateQueries({ queryKey: ['loans'] });
    },
  });

  return (
    <div className="form form--inline">
      <p className="hint">
        Requesting puts this item aside for <strong>{user?.name}</strong> — you. A librarian issues
        it when you collect it.
      </p>
      <button
        type="button"
        className="primary"
        onClick={() => request.mutate()}
        disabled={request.isPending}
      >
        {request.isPending ? 'Requesting…' : 'Request this item'}
      </button>

      {request.isSuccess && (
        <p className="notice" role="status">
          Requested. <Link to={`/loans/${request.data.loan.id}`}>View the loan</Link>.
        </p>
      )}
      {/*
        "This item already has an open loan against it." and "This item is
        archived and cannot be loaned out." both arrive here as 409s, worded by
        the server.
      */}
      {request.isError && <ErrorState error={request.error} title="Could not request this item" />}
    </div>
  );
}

function DirectIssue({ itemId }: { itemId: string }) {
  const queryClient = useQueryClient();
  const [borrowerId, setBorrowerId] = useState('');
  const [dueOn, setDueOn] = useState('');
  const [note, setNote] = useState('');

  const issue = useMutation({
    mutationFn: () =>
      createIssuedLoan({
        itemId,
        borrowerId,
        dueOn,
        ...(note.trim() ? { note: note.trim() } : {}),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['item', itemId] });
      queryClient.invalidateQueries({ queryKey: ['loans'] });
      setNote('');
    },
  });

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    issue.mutate();
  }

  return (
    <form onSubmit={onSubmit} className="form form--inline">
      <h2>Issue directly to someone</h2>
      <p className="hint">
        For handing an item over at the desk, with no request beforehand. The loan is created
        already issued and its history records both steps.
      </p>

      <BorrowerPicker value={borrowerId} onChange={setBorrowerId} id="issue-borrower" />

      <div className="field">
        <label htmlFor="direct-due">Due date</label>
        <input
          id="direct-due"
          type="date"
          required
          value={dueOn}
          onChange={(e) => setDueOn(e.target.value)}
        />
      </div>
      <div className="field">
        <label htmlFor="direct-note">Note (optional)</label>
        <input id="direct-note" value={note} onChange={(e) => setNote(e.target.value)} />
      </div>

      <button type="submit" className="primary" disabled={issue.isPending}>
        {issue.isPending ? 'Issuing…' : 'Issue now'}
      </button>

      {issue.isSuccess && (
        <p className="notice" role="status">
          Issued. <Link to={`/loans/${issue.data.loan.id}`}>View the loan</Link>.
        </p>
      )}
      {issue.isError && <ErrorState error={issue.error} title="Could not issue this item" />}
    </form>
  );
}
