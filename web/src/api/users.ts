import { apiRequest, type Paginated } from './client.js';
import type { Role, User } from './types.js';

/**
 * The user directory — librarian-only on the server.
 *
 * Used for picking a custodian and for picking a borrower. A librarian should
 * never be asked to type a uuid, so the id travels through the UI while the
 * name and email are what a person actually sees.
 */
export function listUsers(options: { role?: Role; search?: string } = {}): Promise<Paginated<User>> {
  const params = new URLSearchParams({ pageSize: '100' });
  if (options.role) params.set('role', options.role);
  if (options.search) params.set('search', options.search);
  return apiRequest(`/users?${params.toString()}`);
}

export function listLibrarians(): Promise<Paginated<User>> {
  return listUsers({ role: 'librarian' });
}
