import type { Express } from 'express';
import request from 'supertest';
import { prisma } from '../../src/db.js';

/** A UTC calendar date `offsetDays` from today, as the API's YYYY-MM-DD form. */
export function dateString(offsetDays: number): string {
  const now = new Date();
  const utcMidnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return new Date(utcMidnight + offsetDays * 86_400_000).toISOString().slice(0, 10);
}

export function requestLoan(app: Express, cookie: string, itemId: string) {
  return request(app).post('/api/loans/request').set('Cookie', cookie).send({ itemId });
}

export function directIssue(
  app: Express,
  cookie: string,
  body: { itemId: string; borrowerId: string; dueOn: string; note?: string },
) {
  return request(app).post('/api/loans').set('Cookie', cookie).send(body);
}

export function issueLoan(
  app: Express,
  cookie: string,
  loanId: string,
  body: { dueOn: string; note?: string },
) {
  return request(app).post(`/api/loans/${loanId}/issue`).set('Cookie', cookie).send(body);
}

export function returnLoan(app: Express, cookie: string, loanId: string, note?: string) {
  return request(app)
    .post(`/api/loans/${loanId}/return`)
    .set('Cookie', cookie)
    .send(note === undefined ? {} : { note });
}

export function markLost(app: Express, cookie: string, loanId: string, note?: string) {
  return request(app)
    .post(`/api/loans/${loanId}/lost`)
    .set('Cookie', cookie)
    .send(note === undefined ? {} : { note });
}

export function getLoan(app: Express, cookie: string, loanId: string) {
  return request(app).get(`/api/loans/${loanId}`).set('Cookie', cookie);
}

/**
 * The timeline as stored, in the order the API returns it.
 *
 * Mirrors the service's ordering exactly, including the `type` tiebreak that
 * disambiguates the two same-instant events a direct issue writes.
 */
export async function storedEvents(loanId: string) {
  return prisma.loanEvent.findMany({
    where: { loanId },
    orderBy: [{ createdAt: 'asc' }, { type: 'asc' }, { id: 'asc' }],
  });
}

/**
 * Drives a loan to Issued through the API, the way a librarian would.
 *
 * Used by tests that need an issued loan as their starting point but are not
 * themselves testing how it got there.
 */
export async function issuedLoan(
  app: Express,
  librarianCookie: string,
  options: { itemId: string; borrowerId: string; dueOn?: string },
): Promise<string> {
  const response = await directIssue(app, librarianCookie, {
    itemId: options.itemId,
    borrowerId: options.borrowerId,
    dueOn: options.dueOn ?? dateString(14),
  });
  if (response.status !== 201) {
    throw new Error(`Could not issue loan: ${response.status} ${JSON.stringify(response.body)}`);
  }
  return response.body.loan.id as string;
}
