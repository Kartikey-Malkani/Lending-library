import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render } from '@testing-library/react';
import type { ReactElement } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { vi } from 'vitest';
import { AuthProvider } from '../src/auth/AuthProvider.js';
import type { Role } from '../src/api/types.js';

/**
 * A stub for `fetch`, and a record of everything the app asked for.
 *
 * The point of testing at this level is to check the request, not the render:
 * that a member's request carries no borrower, that a loan filter reaches the
 * server rather than being applied in the browser, that a 409 arrives on screen
 * intact. So the real API client, the real query-string building and the real
 * components all run, and only the network is replaced.
 */

export type RecordedCall = {
  method: string;
  url: string;
  path: string;
  params: URLSearchParams;
  headers: Record<string, string>;
  body: unknown;
};

export type StubResponse = { status?: number; json?: unknown };
export type Responder = StubResponse | ((call: RecordedCall) => StubResponse);

/** Keyed `"METHOD /path"`, matched without the query string. */
export type Routes = Record<string, Responder>;

export function stubFetch(routes: Routes): RecordedCall[] {
  const calls: RecordedCall[] = [];

  vi.stubGlobal('fetch', async (input: string, init?: RequestInit) => {
    const url = String(input);
    const [path, search = ''] = url.split('?');
    const method = init?.method ?? 'GET';

    const call: RecordedCall = {
      method,
      url,
      path: path ?? url,
      params: new URLSearchParams(search),
      headers: (init?.headers as Record<string, string>) ?? {},
      body: typeof init?.body === 'string' ? safeParse(init.body) : undefined,
    };
    calls.push(call);

    const route = routes[`${method} ${call.path}`];
    if (!route) {
      // A missing route is a test bug, not a 404 to be quietly rendered — say so
      // loudly enough to see in the failure output.
      throw new Error(`No stub for ${method} ${call.path}`);
    }

    const { status = 200, json } = typeof route === 'function' ? route(call) : route;

    // Only the parts of `Response` the API client actually uses. Built by hand
    // so the tests do not depend on which fetch primitives jsdom happens to
    // provide.
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: () => 'application/json' },
      json: async () => json,
      text: async () => JSON.stringify(json),
    };
  });

  return calls;
}

function safeParse(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    // A raw CSV upload, for instance. Kept verbatim so a test can assert on the
    // exact bytes that were sent.
    return body;
  }
}

/** The `GET /auth/me` responder for a signed-in user of the given role. */
export function signedInAs(role: Role, overrides: Partial<{ id: string; name: string }> = {}) {
  return {
    json: {
      user: {
        id: overrides.id ?? (role === 'librarian' ? 'lib-1' : 'mem-1'),
        name: overrides.name ?? (role === 'librarian' ? 'Alex Whitfield' : 'Sam Okonkwo'),
        email: role === 'librarian' ? 'alex@example.com' : 'sam@example.com',
        role,
      },
    },
  };
}

/** `GET /auth/me` answering 401 — nobody is signed in. */
export const signedOut: StubResponse = {
  status: 401,
  json: { error: { code: 'unauthenticated', message: 'Authentication required.' } },
};

export function renderApp(ui: ReactElement, { route = '/' }: { route?: string } = {}) {
  const queryClient = new QueryClient({
    // No retries and no caching between tests: a retry would hide a failure
    // behind a second attempt, and a shared cache would let one test answer
    // another's question.
    defaultOptions: {
      queries: { retry: false, gcTime: 0, staleTime: 0 },
      mutations: { retry: false },
    },
  });

  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[route]}>
        <AuthProvider>{ui}</AuthProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/** An empty paginated payload, for endpoints a test does not care about. */
export const emptyPage = { json: { rows: [], total: 0, page: 1, pageSize: 20 } };
