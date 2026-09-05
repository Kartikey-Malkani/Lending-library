import { screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/App.js';
import { emptyPage, renderApp, signedInAs, signedOut, stubFetch } from './harness.js';

/**
 * Route guarding.
 *
 * These tests describe navigation, not security. The server refuses a member's
 * request to a librarian endpoint whatever the browser does, and there is a
 * backend test for exactly that (`server/test/authorization.test.ts`). What is
 * checked here is the thing only the frontend can get wrong: sending a signed-out
 * visitor to the login screen, and not walking a member into a page of 403s.
 */

afterEach(() => vi.unstubAllGlobals());

describe('route guarding', () => {
  it('sends a signed-out visitor to the login screen instead of the loans page', async () => {
    const calls = stubFetch({ 'GET /api/auth/me': signedOut });

    renderApp(<App />, { route: '/loans' });

    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument();

    // The important half: no loan data was requested on the way past.
    expect(calls.map((call) => call.path)).toEqual(['/api/auth/me']);
  });

  it('does not walk a member into the librarian-only import page', async () => {
    const calls = stubFetch({ 'GET /api/auth/me': signedInAs('member') });

    renderApp(<App />, { route: '/import' });

    expect(await screen.findByText(/This page is for librarians/i)).toBeInTheDocument();
    expect(calls.some((call) => call.path === '/api/items/import')).toBe(false);
  });

  it('lets a librarian into the import page', async () => {
    stubFetch({ 'GET /api/auth/me': signedInAs('librarian') });

    renderApp(<App />, { route: '/import' });

    expect(
      await screen.findByRole('heading', { name: 'Import catalogue items' }),
    ).toBeInTheDocument();
  });

  it('shows a member the loans page, and leaves the borrower filter off it', async () => {
    stubFetch({
      'GET /api/auth/me': signedInAs('member'),
      'GET /api/loans': emptyPage,
      'GET /api/items': emptyPage,
    });

    renderApp(<App />, { route: '/loans' });

    expect(await screen.findByRole('heading', { name: 'Loans' })).toBeInTheDocument();

    // A member's results are scoped by the server, so a borrower control would
    // imply a choice they do not have.
    await waitFor(() => expect(screen.getByLabelText('Status')).toBeInTheDocument());
    expect(screen.queryByLabelText('Borrower')).not.toBeInTheDocument();
  });
});
