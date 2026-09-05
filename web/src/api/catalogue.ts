import { apiRequest, type Paginated } from './client.js';
import type { Custodian, ImportReport, Item, ItemDetail } from './types.js';

/**
 * Catalogue calls.
 *
 * The list takes the query string verbatim from the URL, so what the browser
 * shows and what the server is asked are the same thing by construction —
 * nothing is filtered or paged in React.
 */
export function listItems(search: URLSearchParams): Promise<Paginated<Item>> {
  const query = search.toString();
  return apiRequest(`/items${query ? `?${query}` : ''}`);
}

export function listMyItems(search: URLSearchParams): Promise<Paginated<Item>> {
  const query = search.toString();
  return apiRequest(`/items/mine${query ? `?${query}` : ''}`);
}

export function getItem(id: string): Promise<ItemDetail> {
  return apiRequest(`/items/${id}`);
}

export type ItemInput = { title: string; category: string; code: string };

export function createItem(input: ItemInput): Promise<{ item: Item }> {
  return apiRequest('/items', { method: 'POST', body: input });
}

export function updateItem(id: string, input: Partial<ItemInput>): Promise<{ item: Item }> {
  return apiRequest(`/items/${id}`, { method: 'PATCH', body: input });
}

export function archiveItem(id: string): Promise<{ item: Item }> {
  return apiRequest(`/items/${id}/archive`, { method: 'POST' });
}

export function restoreItem(id: string): Promise<{ item: Item }> {
  return apiRequest(`/items/${id}/restore`, { method: 'POST' });
}

/** Replaces the whole custodian set — the server treats it as set membership. */
export function setCustodians(id: string, librarianIds: string[]): Promise<{ custodians: Custodian[] }> {
  return apiRequest(`/items/${id}/custodians`, { method: 'PUT', body: { librarianIds } });
}

/**
 * Bulk import of catalogue items.
 *
 * The file is sent as a raw `text/csv` body — the same bytes the user chose,
 * not a re-serialised version of a parsed table. The response is a report, so a
 * mixed file resolves successfully and names each failed row.
 */
export function importItems(csv: string): Promise<ImportReport> {
  return apiRequest('/items/import', {
    method: 'POST',
    rawBody: { contentType: 'text/csv', content: csv },
  });
}
