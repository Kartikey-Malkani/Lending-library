import { apiRequest, type Paginated } from './client.js';
import type { Custodian, Item, ItemDetail, User } from './types.js';

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

export function listLibrarians(): Promise<Paginated<User>> {
  return apiRequest('/users?role=librarian&pageSize=100');
}
