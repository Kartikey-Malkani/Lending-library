import type { NextFunction, Request, RequestHandler, Response } from 'express';

/**
 * One error shape for the whole API: `{ error: { code, message, details? } }`.
 *
 * The brief requires rejections to explain themselves — an illegal loan move
 * must come back "with a message explaining why" — so `message` is written for
 * a person to read, and `code` is what the client branches on.
 */
export type ErrorBody = {
  error: { code: string; message: string; details?: unknown };
};

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

  toBody(): ErrorBody {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.details === undefined ? {} : { details: this.details }),
      },
    };
  }

  static unauthorized(message = 'Authentication required.'): ApiError {
    return new ApiError(401, 'unauthenticated', message);
  }

  static forbidden(message = 'You do not have permission to do that.'): ApiError {
    return new ApiError(403, 'forbidden', message);
  }

  static notFound(message = 'Not found.'): ApiError {
    return new ApiError(404, 'not_found', message);
  }

  static badRequest(message: string, details?: unknown): ApiError {
    return new ApiError(400, 'bad_request', message, details);
  }

  /**
   * A request that is well-formed but conflicts with the current state of the
   * system: an illegal transition, a duplicate identifier, an item that already
   * has an open loan. The brief requires these rejections to explain
   * themselves, so `message` is always written for a person.
   */
  static conflict(code: string, message: string, details?: unknown): ApiError {
    return new ApiError(409, code, message, details);
  }
}

/** Prisma's unique-constraint violation. */
const PRISMA_UNIQUE_VIOLATION = 'P2002';

/**
 * Recognises a unique-constraint violation on a specific column.
 *
 * Prisma reports these as P2002 with the offending columns in `meta.target`.
 * Callers use this to turn a database error into a readable 409 rather than
 * letting it surface as an unexplained 500.
 */
export function isUniqueViolationOn(error: unknown, column: string): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const candidate = error as { code?: unknown; meta?: { target?: unknown } };
  if (candidate.code !== PRISMA_UNIQUE_VIOLATION) return false;
  const target = candidate.meta?.target;
  return Array.isArray(target) && target.includes(column);
}

/**
 * Express 4 does not forward a rejected promise from an async handler to the
 * error middleware — the request simply hangs until the client gives up. Every
 * async route is wrapped in this.
 */
export function asyncHandler(
  handler: (req: Request, res: Response, next: NextFunction) => Promise<unknown>,
): RequestHandler {
  return (req, res, next) => {
    handler(req, res, next).catch(next);
  };
}

/** Terminal error handler. Never leaks a stack trace to a client. */
export function errorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction,
): void {
  if (err instanceof ApiError) {
    res.status(err.status).json(err.toBody());
    return;
  }

  /*
   * body-parser rejections (a payload over the limit, malformed JSON) arrive as
   * plain errors carrying a status and an `entity.*` type. Without this they
   * fall through to the 500 below, which would report a client mistake as a
   * server fault — and would have told a caller uploading an oversized CSV that
   * the server had broken.
   */
  const bodyError = err as { type?: unknown; status?: unknown; statusCode?: unknown };
  if (typeof bodyError.type === 'string' && bodyError.type.startsWith('entity.')) {
    const status = typeof bodyError.status === 'number' ? bodyError.status : 400;
    res.status(status).json({
      error: {
        code: status === 413 ? 'payload_too_large' : 'bad_request',
        message:
          status === 413
            ? 'The uploaded content is too large.'
            : 'The request body could not be parsed.',
      },
    } satisfies ErrorBody);
    return;
  }

  console.error('Unhandled error:', err);
  res.status(500).json({
    error: { code: 'internal_error', message: 'An unexpected error occurred.' },
  } satisfies ErrorBody);
}
