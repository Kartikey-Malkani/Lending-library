/**
 * The one place the frontend talks to the server.
 *
 * Everything goes through here so that error handling is consistent and, more
 * importantly, so the server's own error text survives to the screen. The API
 * answers with `{ error: { code, message, details? } }` and those messages are
 * written for a person to read — an illegal loan transition explains why it was
 * refused. Replacing them with "Something went wrong" would throw away the most
 * useful thing the server says.
 */

export type ApiErrorDetail = { field: string; message: string };

/**
 * `details` is whatever the server attached, and the server attaches two
 * genuinely different shapes: an array of `{ field, message }` for validation
 * and per-row failures, and a plain object for context on a conflict — a
 * refused transition sends `{ currentStatus, attempted }`. It is therefore typed
 * as `unknown` and normalised at the point of display by `detailLines()`, rather
 * than declared as an array that a 409 would quietly fail to match.
 */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  /** Not signed in, or the session expired. The app should show the login screen. */
  get isUnauthenticated(): boolean {
    return this.status === 401;
  }

  /** Signed in, but this role may not do it. A different problem, and a different message. */
  get isForbidden(): boolean {
    return this.status === 403;
  }
}

type RequestOptions = {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  body?: unknown;
  /** For CSV uploads, which are sent as a raw text/csv body. */
  rawBody?: { contentType: string; content: string };
  signal?: AbortSignal;
};

/**
 * Flattens whatever came back in `details` into lines a person can read.
 *
 * Nothing is discarded on the grounds of being an unexpected shape: an object
 * becomes one line per key, a string becomes one line, an array of
 * `{ field, message }` keeps its field names. The alternative — assuming an
 * array — is what made a 409's `{ currentStatus, attempted }` disappear from the
 * screen while still being present in the response.
 */
export function detailLines(details: unknown): { label: string; message: string }[] {
  if (details === undefined || details === null) return [];

  if (Array.isArray(details)) {
    return details.map((entry, index) => {
      if (entry && typeof entry === 'object' && 'message' in entry) {
        const detail = entry as ApiErrorDetail;
        return { label: detail.field ?? String(index + 1), message: String(detail.message) };
      }
      return { label: String(index + 1), message: String(entry) };
    });
  }

  if (typeof details === 'object') {
    return Object.entries(details as Record<string, unknown>).map(([label, value]) => ({
      label,
      message: String(value),
    }));
  }

  return [{ label: 'detail', message: String(details) }];
}

async function toApiError(response: Response): Promise<ApiError> {
  let code = 'unknown_error';
  let message = `Request failed with status ${response.status}.`;
  let details: unknown;

  try {
    const body = (await response.json()) as {
      error?: { code?: string; message?: string; details?: unknown };
    };
    if (body.error) {
      code = body.error.code ?? code;
      message = body.error.message ?? message;
      details = body.error.details;
    }
  } catch {
    // A non-JSON error body (a proxy timeout, say). Keep the generic message
    // rather than pretending we know more than we do.
  }

  return new ApiError(response.status, code, message, details);
}

export async function apiRequest<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  let body: BodyInit | undefined;

  if (options.rawBody) {
    headers['Content-Type'] = options.rawBody.contentType;
    body = options.rawBody.content;
  } else if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(options.body);
  }

  const response = await fetch(`/api${path}`, {
    method: options.method ?? 'GET',
    headers,
    body,
    // The session is an httpOnly cookie. Same-origin in the deployed
    // single-service setup, and proxied through Vite in development.
    credentials: 'same-origin',
    ...(options.signal ? { signal: options.signal } : {}),
  });

  if (!response.ok) throw await toApiError(response);
  if (response.status === 204) return undefined as T;

  const contentType = response.headers.get('content-type') ?? '';
  if (contentType.includes('application/json')) return (await response.json()) as T;
  return (await response.text()) as T;
}

/** A paginated list, the shape every list endpoint returns. */
export type Paginated<T> = {
  rows: T[];
  total: number;
  page: number;
  pageSize: number;
};
