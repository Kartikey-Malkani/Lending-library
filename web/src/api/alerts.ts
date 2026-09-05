import { apiRequest } from './client.js';
import type { AlertsPage } from './types.js';

/**
 * Overdue alerts.
 *
 * An alert is not a stored row: the server derives it on every read from the
 * loans that are still issued past their due date and that this librarian has
 * not dismissed. So there is nothing to cache locally and nothing to mark read
 * in the browser — the list and the badge both come from here.
 */
export function listAlerts(search: URLSearchParams): Promise<AlertsPage> {
  const query = search.toString();
  return apiRequest(`/alerts${query ? `?${query}` : ''}`);
}

/**
 * The badge count only.
 *
 * Asks for the smallest page the server allows and reads `count`, which is the
 * full total rather than the size of that page.
 */
export function fetchAlertCount(): Promise<AlertsPage> {
  return apiRequest('/alerts?pageSize=1');
}

/** Dismissal is per librarian, and is keyed on the loan — never on the item. */
export function dismissAlert(loanId: string): Promise<void> {
  return apiRequest(`/alerts/${loanId}/dismiss`, { method: 'POST' });
}
