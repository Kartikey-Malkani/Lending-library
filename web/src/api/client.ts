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

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: ApiErrorDetail[],
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

async function toApiError(response: Response): Promise<ApiError> {
  let code = 'unknown_error';
  let message = `Request failed with status ${response.status}.`;
  let details: ApiErrorDetail[] | undefined;

  try {
    const body = (await response.json()) as {
      error?: { code?: string; message?: string; details?: ApiErrorDetail[] };
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
