import { z } from 'zod';
import { boundedText } from '../http/validation.js';

/**
 * The fields required to create a catalogue item.
 *
 * Shared deliberately between `POST /api/items` and the CSV importer, so a row
 * in an uploaded file is held to exactly the same rules as a single create.
 * Two copies of these bounds would drift, and the import would quietly start
 * accepting things the API rejects.
 */
export const catalogueItemInputSchema = z
  .object({
    title: boundedText(200),
    category: boundedText(100),
    code: boundedText(50),
  })
  .strict();

export type CatalogueItemInput = z.infer<typeof catalogueItemInputSchema>;

/** Flattens a Zod failure into one readable sentence for a per-row report. */
export function describeFieldIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join('.') || 'row'} ${issue.message}`)
    .join('; ');
}
