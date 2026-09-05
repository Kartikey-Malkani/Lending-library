import type { ReactNode } from 'react';
import { ApiError } from '../api/client.js';

/**
 * Loading, error and empty states in one place, so no screen can quietly render
 * nothing after a failed request.
 *
 * The error branch shows the server's own message. When the server sent field
 * details — a per-row import report, a validation failure — those are listed
 * too, because "Invalid request body" alone does not tell anyone what to fix.
 */

export function Loading({ label = 'Loading…' }: { label?: string }) {
  return (
    <p className="state" role="status">
      {label}
    </p>
  );
}

export function ErrorState({ error, title = 'Something went wrong' }: { error: unknown; title?: string }) {
  const api = error instanceof ApiError ? error : null;
  const message = api?.message ?? (error instanceof Error ? error.message : 'Unknown error');

  return (
    <div className="state state--error" role="alert">
      <h2>{api?.isForbidden ? 'Not allowed' : title}</h2>
      <p>{message}</p>
      {api?.details && api.details.length > 0 && (
        <ul className="state__details">
          {api.details.map((detail, i) => (
            <li key={`${detail.field}-${i}`}>
              <strong>{detail.field}</strong>: {detail.message}
            </li>
          ))}
        </ul>
      )}
      {api && <p className="state__code">Error code: {api.code}</p>}
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="state state--empty">{children}</p>;
}
