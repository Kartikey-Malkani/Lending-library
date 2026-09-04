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

  console.error('Unhandled error:', err);
  res.status(500).json({
    error: { code: 'internal_error', message: 'An unexpected error occurred.' },
  } satisfies ErrorBody);
}
