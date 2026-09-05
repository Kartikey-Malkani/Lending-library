import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { listUsers } from '../api/users.js';
import { ErrorState, Loading } from './DataState.js';

/**
 * Choosing who a loan is for.
 *
 * A borrower is identified to the server by uuid, which is not something a
 * person should ever be asked to type or recognise. So the id is carried
 * invisibly and every borrower is shown by name and email — email included
 * because two people can share a name and the librarian has to be sure.
 *
 * The search box filters on the server (`GET /api/users?search=`), so this
 * works the same whether the library has six accounts or six hundred.
 */
export function BorrowerPicker({
  value,
  onChange,
  id = 'borrower',
}: {
  value: string;
  onChange: (userId: string) => void;
  id?: string;
}) {
  const [search, setSearch] = useState('');

  const users = useQuery({
    queryKey: ['users', 'borrower', search],
    queryFn: () => listUsers(search ? { search } : {}),
  });

  const rows = users.data?.rows ?? [];
  const total = users.data?.total ?? 0;

  return (
    <>
      <div className="field">
        <label htmlFor={`${id}-search`}>Find borrower</label>
        <input
          id={`${id}-search`}
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Name or email"
        />
      </div>

      <div className="field">
        <label htmlFor={id}>Borrower</label>
        <select id={id} value={value} onChange={(e) => onChange(e.target.value)} required>
          <option value="">Select a borrower…</option>
          {rows.map((user) => (
            <option key={user.id} value={user.id}>
              {user.name} — {user.email} ({user.role})
            </option>
          ))}
        </select>
        {users.isPending && <Loading label="Loading people…" />}
        {/* Said plainly rather than silently truncated, so a missing name has an
            explanation and a next step. */}
        {total > rows.length && (
          <p className="hint">
            Showing {rows.length} of {total}. Narrow the search to find someone else.
          </p>
        )}
      </div>

      {users.isError && <ErrorState error={users.error} title="Could not load people" />}
    </>
  );
}
