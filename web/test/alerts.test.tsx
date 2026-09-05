import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/App.js';
import { AlertsPage } from '../src/pages/AlertsPage.js';
import { emptyPage, renderApp, signedInAs, stubFetch } from './harness.js';

afterEach(() => vi.unstubAllGlobals());

/**
 * Two rows on the page, but 37 overdue loans in total.
 *
 * The gap is the point: the badge and the heading must read `count`, and a
 * component that used `rows.length` would say 2.
 */
const alertsPage = {
  json: {
    count: 37,
    total: 37,
    page: 1,
    pageSize: 20,
    rows: [
      {
        loanId: 'loan-1',
        dueOn: '2026-08-10',
        daysOverdue: 26,
        item: { id: 'item-1', code: 'AUD-001', title: 'Zoom H6 recorder', isArchived: false },
        borrower: { id: 'mem-1', name: 'Sam Okonkwo', email: 'sam@example.com' },
      },
      {
        loanId: 'loan-2',
        dueOn: '2026-08-20',
        daysOverdue: 1,
        item: { id: 'item-2', code: 'CAM-002', title: 'Sony A7 III', isArchived: true },
        borrower: { id: 'mem-2', name: 'Dana Feldman', email: 'dana@example.com' },
      },
    ],
  },
};

describe('the alerts list', () => {
  it('renders item, borrower, due date and overdue duration', async () => {
    stubFetch({ 'GET /api/auth/me': signedInAs('librarian'), 'GET /api/alerts': alertsPage });

    renderApp(<AlertsPage />, { route: '/alerts' });

    const row = (await screen.findByText('Zoom H6 recorder')).closest('tr')!;
    expect(row).toHaveTextContent('AUD-001');
    expect(row).toHaveTextContent('Sam Okonkwo');
    expect(row).toHaveTextContent('sam@example.com');
    expect(row).toHaveTextContent('2026-08-10');
    // The server's own figure, not a subtraction performed in the browser.
    expect(row).toHaveTextContent('26 days');

    expect(screen.getByText('Sony A7 III').closest('tr')).toHaveTextContent('1 day');
  });

  it('uses the server total, not the number of rows on the page', async () => {
    stubFetch({ 'GET /api/auth/me': signedInAs('librarian'), 'GET /api/alerts': alertsPage });

    renderApp(<AlertsPage />, { route: '/alerts' });

    expect(await screen.findByText('37 outstanding')).toBeInTheDocument();
    expect(screen.getByText('Showing 1–20 of 37')).toBeInTheDocument();
  });

  it('treats an empty list as an answer, not a failure', async () => {
    stubFetch({
      'GET /api/auth/me': signedInAs('librarian'),
      'GET /api/alerts': { json: { count: 0, total: 0, page: 1, pageSize: 20, rows: [] } },
    });

    renderApp(<AlertsPage />, { route: '/alerts' });

    expect(await screen.findByText(/Nothing is overdue/)).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});

describe('dismissing an alert', () => {
  it('posts the loan id of the row that was clicked', async () => {
    const user = userEvent.setup();
    const calls = stubFetch({
      'GET /api/auth/me': signedInAs('librarian'),
      'GET /api/alerts': alertsPage,
      'POST /api/alerts/loan-2/dismiss': { status: 204 },
    });

    renderApp(<AlertsPage />, { route: '/alerts' });

    const secondRow = (await screen.findByText('Sony A7 III')).closest('tr')!;
    await user.click(within(secondRow).getByRole('button', { name: 'Dismiss' }));

    await waitFor(() => {
      const posted = calls.filter((call) => call.method === 'POST');
      expect(posted.map((call) => call.path)).toEqual(['/api/alerts/loan-2/dismiss']);
    });
  });

  it('refetches the alerts afterwards, so the list and badge stop showing it', async () => {
    const user = userEvent.setup();
    let listFetches = 0;
    stubFetch({
      'GET /api/auth/me': signedInAs('librarian'),
      'GET /api/alerts': () => {
        listFetches += 1;
        return alertsPage;
      },
      'POST /api/alerts/loan-1/dismiss': { status: 204 },
    });

    renderApp(<AlertsPage />, { route: '/alerts' });

    const firstRow = (await screen.findByText('Zoom H6 recorder')).closest('tr')!;
    const before = listFetches;
    await user.click(within(firstRow).getByRole('button', { name: 'Dismiss' }));

    await waitFor(() => expect(listFetches).toBeGreaterThan(before));
  });

  it('shows the 409 when the loan is no longer overdue', async () => {
    const user = userEvent.setup();
    stubFetch({
      'GET /api/auth/me': signedInAs('librarian'),
      'GET /api/alerts': alertsPage,
      'POST /api/alerts/loan-1/dismiss': {
        status: 409,
        json: {
          error: {
            code: 'not_overdue',
            message: 'This loan is not currently overdue, so there is no alert to dismiss.',
          },
        },
      },
    });

    renderApp(<AlertsPage />, { route: '/alerts' });

    const firstRow = (await screen.findByText('Zoom H6 recorder')).closest('tr')!;
    await user.click(within(firstRow).getByRole('button', { name: 'Dismiss' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('This loan is not currently overdue');
    expect(alert).toHaveTextContent('Error code: not_overdue');
  });
});

describe('the navigation badge', () => {
  it('shows the server count, and asks for a single row to get it', async () => {
    const calls = stubFetch({
      'GET /api/auth/me': signedInAs('librarian'),
      'GET /api/alerts': alertsPage,
      'GET /api/items': emptyPage,
    });

    renderApp(<App />, { route: '/catalogue' });

    const badge = await screen.findByLabelText('37 overdue alerts');
    expect(badge).toHaveTextContent('37');

    // One row is enough: `count` is the full total, so the badge never depends
    // on how many alerts happen to fit on a page.
    const badgeRequest = calls.find((call) => call.path === '/api/alerts');
    expect(badgeRequest?.params.get('pageSize')).toBe('1');
  });

  it('is not requested for a member, whom the endpoint would refuse anyway', async () => {
    const calls = stubFetch({
      'GET /api/auth/me': signedInAs('member'),
      'GET /api/items': emptyPage,
    });

    renderApp(<App />, { route: '/catalogue' });

    await screen.findByRole('heading', { name: 'Catalogue' });
    expect(calls.some((call) => call.path === '/api/alerts')).toBe(false);
    expect(screen.queryByRole('link', { name: /Alerts/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Dashboard' })).not.toBeInTheDocument();
  });

  it('keeps a member out of the dashboard and alerts pages', async () => {
    const calls = stubFetch({ 'GET /api/auth/me': signedInAs('member') });

    renderApp(<App />, { route: '/dashboard' });

    expect(await screen.findByText(/This page is for librarians/i)).toBeInTheDocument();
    expect(calls.some((call) => call.path === '/api/dashboard')).toBe(false);
  });
});
