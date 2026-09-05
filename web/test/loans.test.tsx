import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LoanDetailPage } from '../src/pages/LoanDetailPage.js';
import { LoansPage } from '../src/pages/LoansPage.js';
import { emptyPage, renderApp, signedInAs, stubFetch } from './harness.js';

afterEach(() => vi.unstubAllGlobals());

const overdueRow = {
  id: 'loan-1',
  itemId: 'item-1',
  borrowerId: 'mem-1',
  status: 'issued',
  // Deliberately contradictory: a due date far in the future, flagged overdue.
  // Only the server's flag should reach the screen.
  isOverdue: true,
  requestedAt: '2026-01-02T10:00:00.000Z',
  issuedAt: '2026-01-03T10:00:00.000Z',
  dueOn: '2999-01-01',
  returnedAt: null,
  lostAt: null,
  item: { id: 'item-1', title: 'Canon EOS R6', code: 'CAM-001', isArchived: false },
  borrower: { id: 'mem-1', name: 'Sam Okonkwo', email: 'sam@example.com' },
};

describe('the loans list is served by the server', () => {
  it('sends every filter, sort and page from the URL to the API', async () => {
    const calls = stubFetch({
      'GET /api/auth/me': signedInAs('librarian'),
      'GET /api/items': emptyPage,
      'GET /api/users': emptyPage,
      'GET /api/loans': { json: { rows: [overdueRow], total: 137, page: 2, pageSize: 20 } },
    });

    renderApp(<LoansPage />, {
      route: '/loans?search=canon&status=overdue&borrowerId=mem-1&sort=dueOn&dir=desc&page=2',
    });

    await screen.findByText('Canon EOS R6');

    const request = calls.find((call) => call.path === '/api/loans');
    expect(request).toBeDefined();
    expect(Object.fromEntries(request!.params)).toEqual({
      search: 'canon',
      status: 'overdue',
      borrowerId: 'mem-1',
      sort: 'dueOn',
      dir: 'desc',
      page: '2',
    });
  });

  it('reports the total the server counted, not the number of rows on screen', async () => {
    stubFetch({
      'GET /api/auth/me': signedInAs('librarian'),
      'GET /api/items': emptyPage,
      'GET /api/users': emptyPage,
      'GET /api/loans': { json: { rows: [overdueRow], total: 137, page: 2, pageSize: 20 } },
    });

    renderApp(<LoansPage />, { route: '/loans?page=2' });

    // One row is on screen. 137 is a fact from the database, and 21–40 is the
    // window the server was asked for — neither can be derived from `rows`.
    expect(await screen.findByText('Showing 21–40 of 137')).toBeInTheDocument();
  });

  it('takes "overdue" from the server rather than comparing the due date itself', async () => {
    stubFetch({
      'GET /api/auth/me': signedInAs('librarian'),
      'GET /api/items': emptyPage,
      'GET /api/users': emptyPage,
      'GET /api/loans': { json: { rows: [overdueRow], total: 1, page: 1, pageSize: 20 } },
    });

    renderApp(<LoansPage />, { route: '/loans' });

    // The due date says the year 2999. If this label came from a comparison in
    // the browser it would be absent.
    expect(await screen.findByText('overdue')).toBeInTheDocument();
    expect(screen.getByText('2999-01-01')).toBeInTheDocument();
  });

  it('changing a filter rewrites the URL and re-asks the server', async () => {
    const user = userEvent.setup();
    const calls = stubFetch({
      'GET /api/auth/me': signedInAs('librarian'),
      'GET /api/items': emptyPage,
      'GET /api/users': emptyPage,
      'GET /api/loans': { json: { rows: [], total: 0, page: 1, pageSize: 20 } },
    });

    renderApp(<LoansPage />, { route: '/loans?page=3' });

    await screen.findByLabelText('Status');
    await user.selectOptions(screen.getByLabelText('Status'), 'lost');

    await waitFor(() => {
      const last = calls.filter((call) => call.path === '/api/loans').at(-1);
      expect(last?.params.get('status')).toBe('lost');
      // A new filter means a new result set, so the old page number is dropped.
      expect(last?.params.get('page')).toBeNull();
    });
  });
});

describe('lifecycle refusals reach the user intact', () => {
  const loanDetail = {
    json: {
      loan: {
        id: 'loan-1',
        itemId: 'item-1',
        borrowerId: 'mem-1',
        status: 'returned',
        isOverdue: false,
        requestedAt: '2026-01-02T10:00:00.000Z',
        issuedAt: '2026-01-03T10:00:00.000Z',
        dueOn: '2026-02-01',
        returnedAt: '2026-01-20T10:00:00.000Z',
        lostAt: null,
      },
      events: [
        {
          id: 'ev-1',
          type: 'requested',
          note: null,
          createdAt: '2026-01-02T10:00:00.000Z',
          actor: { id: 'mem-1', name: 'Sam Okonkwo' },
        },
        {
          id: 'ev-2',
          type: 'returned',
          note: 'Lens cap missing',
          createdAt: '2026-01-20T10:00:00.000Z',
          actor: { id: 'lib-1', name: 'Alex Whitfield' },
        },
      ],
    },
  };

  const itemDetail = {
    json: {
      item: {
        id: 'item-1',
        title: 'Canon EOS R6',
        category: 'Camera',
        code: 'CAM-001',
        archivedAt: null,
        isArchived: false,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
      custodians: [],
      loans: [],
    },
  };

  it('shows a 409 message, its code and its details rather than "something went wrong"', async () => {
    const user = userEvent.setup();
    stubFetch({
      'GET /api/auth/me': signedInAs('librarian'),
      'GET /api/loans/loan-1': loanDetail,
      'GET /api/items/item-1': itemDetail,
      'GET /api/users': emptyPage,
      'POST /api/loans/loan-1/return': {
        status: 409,
        json: {
          error: {
            code: 'invalid_transition',
            message:
              'Cannot return this loan because it has already been returned. The loan is returned.',
            details: { currentStatus: 'returned', attempted: 'return' },
          },
        },
      },
    });

    renderApp(
      <Routes>
        <Route path="/loans/:id" element={<LoanDetailPage />} />
      </Routes>,
      { route: '/loans/loan-1' },
    );

    // The action is offered even though the loan is already returned: the
    // server decides, and this is how its refusal becomes visible.
    await user.click(await screen.findByRole('button', { name: 'Mark returned' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(
      'Cannot return this loan because it has already been returned. The loan is returned.',
    );
    expect(alert).toHaveTextContent('Error code: invalid_transition');
    // The 409's context is an object, not a field list. It must still show.
    expect(alert).toHaveTextContent('currentStatus');
    expect(alert).toHaveTextContent('returned');
  });

  it('renders the timeline read-only, with actor, time, type and note', async () => {
    stubFetch({
      'GET /api/auth/me': signedInAs('librarian'),
      'GET /api/loans/loan-1': loanDetail,
      'GET /api/items/item-1': itemDetail,
      'GET /api/users': emptyPage,
    });

    renderApp(
      <Routes>
        <Route path="/loans/:id" element={<LoanDetailPage />} />
      </Routes>,
      { route: '/loans/loan-1' },
    );

    const history = (await screen.findByRole('heading', { name: 'History' })).closest('div')!;
    expect(history).toHaveTextContent('requested');
    expect(history).toHaveTextContent('Sam Okonkwo');
    expect(history).toHaveTextContent('returned');
    expect(history).toHaveTextContent('Alex Whitfield');
    expect(history).toHaveTextContent('Lens cap missing');

    // Nothing offers to change a timeline entry, because nothing can: the table
    // is append-only in the database and the app role holds no UPDATE on it.
    expect(within(history).queryByRole('button')).toBeNull();
  });
});
