import { useEffect, useState } from 'react';

type HealthState =
  | { kind: 'loading' }
  | { kind: 'ok'; database: string }
  | { kind: 'error'; message: string };

/**
 * Scaffold shell. It exists to prove the two halves are wired together: the SPA
 * calls the API through a relative /api path, which the Vite proxy forwards in
 * development and the Node process serves directly in production.
 *
 * Real routing, auth and views arrive in later milestones.
 */
export function App() {
  const [health, setHealth] = useState<HealthState>({ kind: 'loading' });

  useEffect(() => {
    let cancelled = false;

    fetch('/api/health')
      .then(async (response) => {
        if (!response.ok) throw new Error(`API returned ${response.status}`);
        return (await response.json()) as { status: string; database: string };
      })
      .then((body) => {
        if (!cancelled) setHealth({ kind: 'ok', database: body.database });
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setHealth({ kind: 'error', message: error instanceof Error ? error.message : 'Unknown error' });
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <main style={{ fontFamily: 'system-ui, sans-serif', maxWidth: '40rem', margin: '3rem auto', padding: '0 1rem' }}>
      <h1>Lending Library</h1>
      <p>Scaffold. Catalogue, loans, dashboard and alerts are not built yet.</p>
      <p>
        API status:{' '}
        {health.kind === 'loading' && <span>checking…</span>}
        {health.kind === 'ok' && <span>reachable, database {health.database}</span>}
        {health.kind === 'error' && <span>unreachable ({health.message})</span>}
      </p>
    </main>
  );
}
