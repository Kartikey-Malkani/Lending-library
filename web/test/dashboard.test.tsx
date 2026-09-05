import { screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DashboardPage } from '../src/pages/DashboardPage.js';
import { renderApp, signedInAs, stubFetch } from './harness.js';

afterEach(() => vi.unstubAllGlobals());

/**
 * The dashboard payload used throughout.
 *
 * Chosen to be internally awkward on purpose: the custodian counts (9 + 4 + 3
 * = 16) deliberately exceed the total number of loans (14), because an item
 * with two custodians counts for both. Any code that "reconciled" the figures
 * would have to change one of them, and these tests would notice.
 */
const dashboard = {
  json: {
    asOf: '2026-09-05T09:00:00.000Z',
    headline: {
      itemsCurrentlyOut: 6,
      itemsOverdue: 3,
      loansReturnedThisWeek: 2,
      totalItems: 20,
      archivedItems: 1,
    },
    byStatus: [
      { status: 'requested', count: 2 },
      { status: 'issued', count: 6 },
      { status: 'returned', count: 4 },
      { status: 'lost', count: 2 },
    ],
    byCustodian: [
      { custodianId: 'lib-1', name: 'Alex Whitfield', count: 9 },
      { custodianId: 'lib-2', name: 'Priya Raman', count: 4 },
      { custodianId: null, name: 'Unassigned', count: 3 },
    ],
    returnsPerWeek: [
      { weekStart: '2026-07-13', count: 0 },
      { weekStart: '2026-07-20', count: 3 },
      { weekStart: '2026-07-27', count: 1 },
      { weekStart: '2026-08-03', count: 0 },
      { weekStart: '2026-08-10', count: 5 },
      { weekStart: '2026-08-17', count: 0 },
      { weekStart: '2026-08-24', count: 2 },
      { weekStart: '2026-08-31', count: 2 },
    ],
  },
};

function panelFor(heading: HTMLElement): HTMLElement {
  const panel = heading.closest('.panel');
  if (!(panel instanceof HTMLElement)) throw new Error('Panel not found');
  return panel;
}

function render() {
  const calls = stubFetch({
    'GET /api/auth/me': signedInAs('librarian'),
    'GET /api/dashboard': dashboard,
  });
  renderApp(<DashboardPage />, { route: '/dashboard' });
  return calls;
}

describe('the dashboard renders the API response', () => {
  it('shows the five headline figures exactly as the server reported them', async () => {
    render();

    await screen.findByText('Items currently out');

    for (const [value, label] of [
      ['6', 'Items currently out'],
      ['3', 'Items overdue'],
      ['2', 'Returned this week'],
      ['20', 'Items in the catalogue'],
      ['1', 'Archived items'],
    ] as const) {
      const card = screen.queryByText(label)?.closest('.card');
      expect(card, `card for ${label}`).not.toBeNull();
      expect(card).toHaveTextContent(value);
    }
  });

  it('asks the dashboard endpoint and nothing else — no metric is assembled here', async () => {
    const calls = render();

    await screen.findByText('Items currently out');

    expect(calls.map((call) => call.path).sort()).toEqual(['/api/auth/me', '/api/dashboard']);
  });

  it('lists the four lifecycle statuses and does not invent an overdue one', async () => {
    render();

    const panel = panelFor(await screen.findByRole('heading', { name: 'Loans by status' }));
    const rowHeaders = within(panel)
      .getAllByRole('rowheader')
      .map((cell) => cell.textContent ?? '');

    expect(rowHeaders.map((text) => text.replace(/\s*\d+ overdue$/, ''))).toEqual([
      'requested',
      'issued',
      'returned',
      'lost',
    ]);

    // Overdue appears as an annotation on `issued`, because that is what it is:
    // a subset of those loans, not a fifth status.
    expect(rowHeaders.find((text) => text.startsWith('issued'))).toContain('3 overdue');
  });

  it('keeps the Unassigned custodian bucket', async () => {
    render();

    const panel = panelFor(await screen.findByRole('heading', { name: 'Loans by custodian' }));
    expect(within(panel).getByText('Unassigned')).toBeInTheDocument();
    expect(within(panel).getByRole('rowheader', { name: /Unassigned/ })).toHaveTextContent(
      'no custodian assigned',
    );
  });

  it('reports custodian counts as sent, even though they exceed the loan total', async () => {
    render();

    const panel = panelFor(await screen.findByRole('heading', { name: 'Loans by custodian' }));
    const counts = within(panel)
      .getAllByRole('row')
      .slice(1) // skip the header row
      .map((row) => row.querySelector('td')?.textContent);

    // 9 + 4 + 3 = 16 against 14 loans. Custodianship is many-to-many; nothing
    // here may normalise these into something that adds up.
    expect(counts).toEqual(['9', '4', '3']);
  });

  it('renders all eight weekly buckets, including the empty ones', async () => {
    render();

    const panel = panelFor(await screen.findByRole('heading', { name: 'Returns per week' }));
    const rows = within(panel).getAllByRole('row').slice(1);

    expect(rows).toHaveLength(8);
    expect(rows.map((row) => row.querySelector('td')?.textContent)).toEqual([
      '0',
      '3',
      '1',
      '0',
      '5',
      '0',
      '2',
      '2',
    ]);
    // A week with no returns is data, not a gap to be dropped.
    expect(within(panel).getByText('2026-08-03')).toBeInTheDocument();
    expect(within(panel).getByRole('rowheader', { name: /2026-08-31/ })).toHaveTextContent(
      'this week',
    );
  });

  it('shows the server message when the dashboard cannot be loaded', async () => {
    stubFetch({
      'GET /api/auth/me': signedInAs('librarian'),
      'GET /api/dashboard': {
        status: 500,
        json: {
          error: { code: 'internal_error', message: 'The dashboard could not be calculated.' },
        },
      },
    });

    renderApp(<DashboardPage />, { route: '/dashboard' });

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('The dashboard could not be calculated.');
    expect(alert).toHaveTextContent('Error code: internal_error');
  });
});
