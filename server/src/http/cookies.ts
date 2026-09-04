import type { Request } from 'express';

/**
 * Reads one named cookie from the request.
 *
 * Deliberately not `cookie-parser`. The application needs exactly one cookie,
 * and the published types for that package pull in a different major version of
 * the Express types than the runtime uses, which puts a type conflict in the
 * middleware stack in exchange for parsing we can do in a few lines. Express
 * still writes cookies for us via `res.cookie`.
 *
 * Values are URL-decoded because `res.cookie` URL-encodes them on the way out.
 */
export function readCookie(req: Request, name: string): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;

  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator === -1) continue;

    if (part.slice(0, separator).trim() !== name) continue;

    const raw = part.slice(separator + 1).trim();
    try {
      return decodeURIComponent(raw);
    } catch {
      // A malformed percent-escape is a malformed cookie, not a crash.
      return undefined;
    }
  }

  return undefined;
}
