import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ImportPage } from '../src/pages/ImportPage.js';
import { LoansPage } from '../src/pages/LoansPage.js';
import { emptyPage, renderApp, signedInAs, stubFetch } from './harness.js';

afterEach(() => vi.unstubAllGlobals());

/** The report panel a heading belongs to, so assertions stay inside it. */
function panelFor(heading: HTMLElement): HTMLElement {
  const panel = heading.closest('.panel');
  if (!(panel instanceof HTMLElement)) throw new Error('Report panel not found');
  return panel;
}

const CSV = ['title,category,code', 'Tripod,Support,TRI-001', ',Support,TRI-002'].join('\n');

describe('CSV import', () => {
  const mixedReport = {
    json: {
      imported: 1,
      failed: 1,
      results: [
        { row: 2, ok: true, itemId: 'item-9', code: 'TRI-001' },
        { row: 3, ok: false, code: 'invalid_row', message: 'title: must not be blank' },
      ],
    },
  };

  it('uploads the file exactly as chosen, as text/csv', async () => {
    const user = userEvent.setup();
    const calls = stubFetch({
      'GET /api/auth/me': signedInAs('librarian'),
      'POST /api/items/import': mixedReport,
    });

    renderApp(<ImportPage />, { route: '/import' });

    const file = new File([CSV], 'items.csv', { type: 'text/csv' });
    await user.upload(await screen.findByLabelText('CSV file'), file);
    // Reading the file is asynchronous, and Import stays disabled until it is
    // in hand.
    await screen.findByText(/Ready to upload/);
    await user.click(screen.getByRole('button', { name: 'Import' }));

    await waitFor(() => {
      const upload = calls.find((call) => call.path === '/api/items/import');
      expect(upload).toBeDefined();
      // The bytes from the file, not a re-serialised version of a parsed table.
      expect(upload!.body).toBe(CSV);
      expect(upload!.headers['Content-Type']).toBe('text/csv');
    });
  });

  it('shows a per-row result, keeping row numbers and the server reasons', async () => {
    const user = userEvent.setup();
    stubFetch({
      'GET /api/auth/me': signedInAs('librarian'),
      'POST /api/items/import': mixedReport,
    });

    renderApp(<ImportPage />, { route: '/import' });

    await user.upload(
      await screen.findByLabelText('CSV file'),
      new File([CSV], 'items.csv', { type: 'text/csv' }),
    );
    await screen.findByText(/Ready to upload/);
    await user.click(screen.getByRole('button', { name: 'Import' }));

    const result = panelFor(await screen.findByRole('heading', { name: 'Import result' }));

    // A file where one row succeeded and one failed is a partial success, and
    // must not be reported as a failed import.
    expect(result).toHaveTextContent('1 imported, 1 failed');
    expect(within(result).getByText('TRI-001')).toBeInTheDocument();
    expect(result).toHaveTextContent('title: must not be blank');
    expect(result).toHaveTextContent('invalid_row');
    // The spreadsheet's own row numbers, header included.
    expect(within(result).getByText('2')).toBeInTheDocument();
    expect(within(result).getByText('3')).toBeInTheDocument();
    expect(screen.queryByText(/import failed/i)).not.toBeInTheDocument();
  });
});

describe('bulk return', () => {
  const rows = [
    {
      id: 'loan-1',
      itemId: 'item-1',
      borrowerId: 'mem-1',
      status: 'issued',
      isOverdue: false,
      requestedAt: '2026-01-02T10:00:00.000Z',
      issuedAt: '2026-01-03T10:00:00.000Z',
      dueOn: '2026-03-01',
      returnedAt: null,
      lostAt: null,
      item: { id: 'item-1', title: 'Canon EOS R6', code: 'CAM-001', isArchived: false },
      borrower: { id: 'mem-1', name: 'Sam Okonkwo', email: 'sam@example.com' },
    },
    {
      id: 'loan-2',
      itemId: 'item-2',
      borrowerId: 'mem-2',
      status: 'returned',
      isOverdue: false,
      requestedAt: '2026-01-04T10:00:00.000Z',
      issuedAt: '2026-01-05T10:00:00.000Z',
      dueOn: '2026-03-01',
      returnedAt: '2026-02-01T10:00:00.000Z',
      lostAt: null,
      item: { id: 'item-2', title: 'Tripod', code: 'TRI-001', isArchived: false },
      borrower: { id: 'mem-2', name: 'Dana Feldman', email: 'dana@example.com' },
    },
  ];

  const loansPage = { json: { rows, total: 2, page: 1, pageSize: 20 } };

  async function selectBoth() {
    const user = userEvent.setup();
    const calls = stubFetch({
      'GET /api/auth/me': signedInAs('librarian'),
      'GET /api/items': emptyPage,
      'GET /api/users': emptyPage,
      'GET /api/loans': loansPage,
      'POST /api/loans/bulk-return': {
        json: {
          returned: 1,
          failed: 1,
          results: [
            { loanId: 'loan-1', ok: true, status: 'returned' },
            {
              loanId: 'loan-2',
              ok: false,
              code: 'invalid_transition',
              message:
                'Cannot return this loan because it has already been returned. The loan is returned.',
            },
          ],
        },
      },
    });

    renderApp(<LoansPage />, { route: '/loans' });

    await user.click(await screen.findByLabelText('Select loan of Canon EOS R6 to Sam Okonkwo'));
    await user.click(screen.getByLabelText('Select loan of Tripod to Dana Feldman'));
    return { user, calls };
  }

  it('sends the real loan ids, both of them, untouched', async () => {
    const { user, calls } = await selectBoth();

    await user.click(screen.getByRole('button', { name: 'Return 2 selected' }));

    await waitFor(() => {
      const request = calls.find((call) => call.path === '/api/loans/bulk-return');
      expect(request).toBeDefined();
      // Including the already-returned one. Screening it out here would replace
      // the server's per-loan answer with a guess made in the browser.
      expect(request!.body).toEqual({ loanIds: ['loan-1', 'loan-2'] });
    });
  });

  it('renders each loan outcome, keeping the partial success intact', async () => {
    const { user } = await selectBoth();

    await user.click(screen.getByRole('button', { name: 'Return 2 selected' }));

    const result = panelFor(await screen.findByRole('heading', { name: 'Bulk return result' }));

    expect(result).toHaveTextContent('1 returned, 1 failed');
    expect(within(result).getByText('Returned')).toBeInTheDocument();
    expect(within(result).getByText('Failed')).toBeInTheDocument();
    expect(result).toHaveTextContent(
      'Cannot return this loan because it has already been returned.',
    );
    expect(result).toHaveTextContent('invalid_transition');
  });
});

describe('CSV export', () => {
  const listStubs = {
    'GET /api/items': emptyPage,
    'GET /api/users': emptyPage,
    'GET /api/loans': emptyPage,
  };

  it('is a link to the server endpoint, so the file is the one the server wrote', async () => {
    stubFetch({ 'GET /api/auth/me': signedInAs('librarian'), ...listStubs });

    renderApp(<LoansPage />, { route: '/loans' });

    const link = await screen.findByRole('link', { name: /Export items on loan/ });
    expect(link).toHaveAttribute('href', '/api/loans/export.csv');
    // No `download` attribute: it would override the dated filename the server
    // sets in Content-Disposition.
    expect(link).not.toHaveAttribute('download');
  });

  it('is not offered to a member, who may not export the whole borrower list', async () => {
    stubFetch({ 'GET /api/auth/me': signedInAs('member'), ...listStubs });

    renderApp(<LoansPage />, { route: '/loans' });

    await screen.findByRole('heading', { name: 'Loans' });
    expect(screen.queryByRole('link', { name: /Export items on loan/ })).not.toBeInTheDocument();
  });
});
