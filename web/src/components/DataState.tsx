import type { ReactNode } from 'react';
import { ApiError, detailLines } from '../api/client.js';

/**
 * Loading, error and empty states in one place, so no screen can quietly render
 * nothing after a failed request.
 *
 * The error branch shows the server's own message, and whatever it attached as
 * `details` — the offending fields on a validation failure, or the loan's actual
 * current status on a refused transition. "Invalid request body" alone does not
 * tell anyone what to fix, and a 409 that omits the state it conflicted with
 * does not explain itself.
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
  const lines = detailLines(api?.details);

  return (
    <div className="state state--error" role="alert">
      <h2>{api?.isForbidden ? 'Not allowed' : title}</h2>
      <p>{message}</p>
      {lines.length > 0 && (
        <ul className="state__details">
          {lines.map((line, i) => (
            <li key={`${line.label}-${i}`}>
              <strong>{line.label}</strong>: {line.message}
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
