import type { Request } from 'express';
import { z } from 'zod';
import { ApiError } from './errors.js';

/**
 * Request validation.
 *
 * Deliberately thin: two functions and a few shared field schemas. Every route
 * parses its input at the edge, so handlers and services work with values that
 * are already the right shape — nothing downstream re-checks a string for
 * emptiness.
 */

/** Turns a Zod failure into the API's error envelope, one entry per bad field. */
function toBadRequest(error: z.ZodError, what: string): ApiError {
  const details = error.issues.map((issue) => ({
    field: issue.path.join('.') || what,
    message: issue.message,
  }));
  return ApiError.badRequest(`Invalid ${what}.`, details);
}

export function parseBody<T extends z.ZodType>(req: Request, schema: T): z.infer<T> {
  const result = schema.safeParse(req.body ?? {});
  if (!result.success) throw toBadRequest(result.error, 'request body');
  return result.data;
}

export function parseQuery<T extends z.ZodType>(req: Request, schema: T): z.infer<T> {
  const result = schema.safeParse(req.query ?? {});
  if (!result.success) throw toBadRequest(result.error, 'query parameters');
  return result.data;
}

/** Route parameters are the only place a malformed id should read as "not found". */
export function parseUuidParam(req: Request, name: string): string {
  const value = req.params[name];
  const result = z.string().uuid().safeParse(value);
  if (!result.success) {
    // A syntactically invalid id cannot identify anything, and answering 404
    // avoids telling a caller whether a well-formed id would have existed.
    throw ApiError.notFound('Not found.');
  }
  return result.data;
}

/** Trimmed, non-blank, length-bounded text. */
export const boundedText = (max: number) =>
  z
    .string()
    .transform((value) => value.trim())
    .pipe(z.string().min(1, 'must not be blank').max(max, `must be at most ${max} characters`));

/**
 * Pagination shared by every list endpoint.
 *
 * `pageSize` is capped rather than rejected when it is too large: a client
 * asking for more than the server will give is not an error, it just gets the
 * maximum. An unparseable value is an error.
 */
export const MAX_PAGE_SIZE = 100;
export const DEFAULT_PAGE_SIZE = 20;

export const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce
    .number()
    .int()
    .min(1)
    .default(DEFAULT_PAGE_SIZE)
    .transform((value) => Math.min(value, MAX_PAGE_SIZE)),
});

export const sortDirectionSchema = z.enum(['asc', 'desc']).default('asc');

export type Paginated<T> = {
  rows: T[];
  total: number;
  page: number;
  pageSize: number;
};
