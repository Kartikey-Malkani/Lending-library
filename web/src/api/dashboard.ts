import { apiRequest } from './client.js';
import type { Dashboard } from './types.js';

/**
 * One request paints the whole dashboard.
 *
 * There is no second function here that assembles metrics from the catalogue
 * and loan endpoints. Every figure the page shows is an aggregate the database
 * computed, against a single `asOf` the response carries, so the headline and
 * the chart cannot disagree with each other or with the loans list.
 */
export function getDashboard(): Promise<Dashboard> {
  return apiRequest('/dashboard');
}
