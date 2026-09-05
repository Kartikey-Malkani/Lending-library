import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ItemDetailPage } from '../src/pages/ItemDetailPage.js';
import { emptyPage, renderApp, signedInAs, stubFetch, type Routes as StubRoutes } from './harness.js';

afterEach(() => vi.unstubAllGlobals());

const item = {
  id: 'item-1',
  title: 'Canon EOS R6',
  category: 'Camera',
  code: 'CAM-001',
  archivedAt: null,
  isArchived: false,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

const people = {
  json: {
    rows: [
      { id: 'mem-1', name: 'Sam Okonkwo', email: 'sam@example.com', role: 'member' },
      { id: 'mem-2', name: 'Dana Feldman', email: 'dana@example.com', role: 'member' },
    ],
    total: 2,
    page: 1,
    pageSize: 100,
  },
};

function renderItem(routes: StubRoutes, route = '/catalogue/item-1') {
  const calls = stubFetch(routes);
  renderApp(
    <Routes>
      <Route path="/catalogue/:id" element={<ItemDetailPage />} />
    </Routes>,
    { route },
  );
  return calls;
}

describe('a member requesting an item', () => {
  it('posts to the request endpoint and sends no borrower at all', async () => {
    const user = userEvent.setup();
    const calls = renderItem({
      'GET /api/auth/me': signedInAs('member'),
      'GET /api/items/item-1': { json: { item } },
      'POST /api/loans/request': { status: 201, json: { loan: { id: 'loan-9' } } },
    });

    await user.click(await screen.findByRole('button', { name: 'Request this item' }));

    await waitFor(() => {
      const request = calls.find((call) => call.path === '/api/loans/request');
      expect(request).toBeDefined();
      // The whole body. A borrower field would be a way for the browser to
      // request on someone else's behalf, so there must not be one.
      expect(request!.body).toEqual({ itemId: 'item-1' });
    });
  });

  it('names the signed-in member as the borrower, and offers no choice of one', async () => {
    renderItem({
      'GET /api/auth/me': signedInAs('member'),
      'GET /api/items/item-1': { json: { item } },
    });

    expect(await screen.findByText(/Sam Okonkwo/)).toBeInTheDocument();
    expect(screen.queryByLabelText('Borrower')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Issue now' })).not.toBeInTheDocument();
  });

  it('shows the server refusal when the item already has an open loan', async () => {
    const user = userEvent.setup();
    renderItem({
      'GET /api/auth/me': signedInAs('member'),
      'GET /api/items/item-1': { json: { item } },
      'POST /api/loans/request': {
        status: 409,
        json: {
          error: {
            code: 'item_unavailable',
            message: 'This item already has an open loan against it.',
          },
        },
      },
    });

    await user.click(await screen.findByRole('button', { name: 'Request this item' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('This item already has an open loan against it.');
    expect(alert).toHaveTextContent('Error code: item_unavailable');
  });
});

describe('a librarian issuing directly', () => {
  it('picks a borrower by name and sends that borrower id to POST /loans', async () => {
    const user = userEvent.setup();
    const calls = renderItem({
      'GET /api/auth/me': signedInAs('librarian'),
      'GET /api/items/item-1': { json: { item, custodians: [], loans: [] } },
      'GET /api/users': people,
      'POST /api/loans': { status: 201, json: { loan: { id: 'loan-9' } } },
    });

    // Chosen from a list showing name and email — never typed as a uuid.
    const option = await screen.findByRole('option', { name: /Dana Feldman/ });
    expect(option).toHaveTextContent('Dana Feldman — dana@example.com (member)');
    await user.selectOptions(screen.getByLabelText('Borrower'), 'mem-2');

    await user.type(screen.getByLabelText('Due date'), '2026-10-01');
    await user.type(screen.getByLabelText('Note (optional)'), 'Front desk handover');
    await user.click(screen.getByRole('button', { name: 'Issue now' }));

    await waitFor(() => {
      const request = calls.find((call) => call.method === 'POST' && call.path === '/api/loans');
      expect(request).toBeDefined();
      expect(request!.body).toEqual({
        itemId: 'item-1',
        borrowerId: 'mem-2',
        dueOn: '2026-10-01',
        note: 'Front desk handover',
      });
    });
  });

  it('searches for a borrower on the server rather than filtering the list locally', async () => {
    const user = userEvent.setup();
    const calls = renderItem({
      'GET /api/auth/me': signedInAs('librarian'),
      'GET /api/items/item-1': { json: { item, custodians: [], loans: [] } },
      'GET /api/users': people,
    });

    await user.type(await screen.findByLabelText('Find borrower'), 'dana');

    await waitFor(() => {
      const searched = calls.filter(
        (call) => call.path === '/api/users' && call.params.get('search') === 'dana',
      );
      expect(searched.length).toBeGreaterThan(0);
    });
  });

  it('refreshes the loan lists after issuing, so nothing keeps showing the old state', async () => {
    const user = userEvent.setup();
    let itemFetches = 0;
    const calls = renderItem({
      'GET /api/auth/me': signedInAs('librarian'),
      'GET /api/items/item-1': () => {
        itemFetches += 1;
        return { json: { item, custodians: [], loans: [] } };
      },
      'GET /api/users': people,
      'GET /api/loans': emptyPage,
      'POST /api/loans': { status: 201, json: { loan: { id: 'loan-9' } } },
    });

    await screen.findByRole('option', { name: /Dana Feldman/ });
    await user.selectOptions(screen.getByLabelText('Borrower'), 'mem-2');
    await user.type(screen.getByLabelText('Due date'), '2026-10-01');

    const before = itemFetches;
    await user.click(screen.getByRole('button', { name: 'Issue now' }));

    // The item now has a loan against it, so its cached detail is stale and is
    // refetched rather than left on screen.
    await waitFor(() => expect(itemFetches).toBeGreaterThan(before));
    expect(calls.some((call) => call.method === 'POST' && call.path === '/api/loans')).toBe(true);
  });
});
