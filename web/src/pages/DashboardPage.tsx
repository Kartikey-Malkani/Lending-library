import { useQuery } from '@tanstack/react-query';
import { getDashboard } from '../api/dashboard.js';
import type { Dashboard } from '../api/types.js';
import { Empty, ErrorState, Loading } from '../components/DataState.js';
import { ReturnsChart } from '../components/ReturnsChart.js';

/**
 * The dashboard — goal 8.
 *
 * Everything on this page comes from one response. There is deliberately no
 * code here that counts loans, sums statuses or works out which week a return
 * fell in: those are database aggregates, computed against a single `asOf` the
 * server reports, and recomputing any of them in the browser would eventually
 * produce a page that disagrees with itself.
 */
export function DashboardPage() {
  const query = useQuery({ queryKey: ['dashboard'], queryFn: getDashboard });

  if (query.isPending) return <Loading label="Loading the dashboard…" />;
  if (query.isError) return <ErrorState error={query.error} title="Could not load the dashboard" />;

  const { asOf, headline, byStatus, byCustodian, returnsPerWeek } = query.data;

  return (
    <section>
      <div className="page-head">
        <h1>Dashboard</h1>
      </div>
      <p className="hint">
        Every figure below was calculated by the server at {new Date(asOf).toLocaleString()}.
      </p>

      <Headline headline={headline} />

      <div className="panel">
        <h2>Loans by status</h2>
        <StatusBreakdown rows={byStatus} overdue={headline.itemsOverdue} />
      </div>

      <div className="panel">
        <h2>Loans by custodian</h2>
        <CustodianBreakdown rows={byCustodian} />
      </div>

      <div className="panel">
        <h2>Returns per week</h2>
        {returnsPerWeek.length === 0 ? (
          <Empty>No weekly data was returned.</Empty>
        ) : (
          <ReturnsChart weeks={returnsPerWeek} />
        )}
      </div>
    </section>
  );
}

function Headline({ headline }: { headline: Dashboard['headline'] }) {
  const cards: { label: string; value: number; note?: string }[] = [
    { label: 'Items currently out', value: headline.itemsCurrentlyOut },
    { label: 'Items overdue', value: headline.itemsOverdue, note: 'a subset of those out' },
    { label: 'Returned this week', value: headline.loansReturnedThisWeek },
    { label: 'Items in the catalogue', value: headline.totalItems, note: 'active items' },
    { label: 'Archived items', value: headline.archivedItems, note: 'not counted above' },
  ];

  return (
    <div className="cards">
      {cards.map((card) => (
        <div key={card.label} className="card">
          <p className="card__value">{card.value}</p>
          <p className="card__label">{card.label}</p>
          {card.note && <p className="card__note">{card.note}</p>}
        </div>
      ))}
    </div>
  );
}

/**
 * The four lifecycle statuses.
 *
 * Overdue is not one of them and is not added as a fifth row. It is a derived
 * subset of `issued` — the loans whose due date has passed — so it is shown as
 * an annotation on that row instead. Listing it alongside the others would
 * double-count those loans and imply a status the database enum does not have.
 */
function StatusBreakdown({
  rows,
  overdue,
}: {
  rows: Dashboard['byStatus'];
  overdue: number;
}) {
  if (rows.length === 0) return <Empty>No loans have been recorded yet.</Empty>;

  const busiest = Math.max(1, ...rows.map((row) => row.count));

  return (
    <table className="table chart">
      <caption className="visually-hidden">Loans grouped by lifecycle status</caption>
      <thead>
        <tr>
          <th scope="col">Status</th>
          <th scope="col">Loans</th>
          <th scope="col">
            <span className="visually-hidden">Relative size</span>
          </th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.status}>
            <th scope="row">
              {row.status}
              {row.status === 'issued' && overdue > 0 && (
                <span className="tag tag--warn"> {overdue} overdue</span>
              )}
            </th>
            <td>{row.count}</td>
            <td className="chart__cell">
              <span
                className="chart__bar"
                style={{ width: `${(row.count / busiest) * 100}%` }}
                aria-hidden="true"
              />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/**
 * Loans per custodian, including Unassigned.
 *
 * Two things are deliberately left alone. The `Unassigned` bucket — the one
 * with a null `custodianId` — is rendered like any other, because those are
 * real loans on items nobody has been made responsible for, and that is
 * precisely the row a librarian needs to see. And the counts are not summed,
 * reconciled or de-duplicated: custodianship is many-to-many, so a loan on an
 * item with two custodians is counted for both. The note says so, rather than
 * the page quietly making the numbers add up to something.
 */
function CustodianBreakdown({ rows }: { rows: Dashboard['byCustodian'] }) {
  if (rows.length === 0) return <Empty>No loans have been recorded yet.</Empty>;

  return (
    <>
      <p className="hint">
        An item can have several custodians, and each is responsible for it — so a loan is counted
        once for every custodian of its item. These figures are not expected to add up to the total
        number of loans.
      </p>
      <table className="table">
        <caption className="visually-hidden">Loans grouped by custodian</caption>
        <thead>
          <tr>
            <th scope="col">Custodian</th>
            <th scope="col">Loans</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.custodianId ?? 'unassigned'}>
              <th scope="row">
                {row.name}
                {row.custodianId === null && (
                  <span className="tag tag--warn"> no custodian assigned</span>
                )}
              </th>
              <td>{row.count}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
