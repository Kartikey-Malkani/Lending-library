/**
 * Returns per week, for the eight weeks the server sent.
 *
 * Built as a real `<table>` with a bar drawn inside each row, rather than as an
 * SVG picture with a caption. The markup a screen reader walks is the actual
 * data — week, count — and the bar is a CSS width on top of it, so there is one
 * source of truth for what the chart says rather than a graphic and a
 * description that can drift apart.
 *
 * The buckets are rendered exactly as supplied. Weeks are not computed, filled
 * in or trimmed here: the server generates the series so that a quiet fortnight
 * still produces a zero bucket instead of silently shortening the chart, and
 * rebuilding it from the returned rows in React would undo that.
 */
export function ReturnsChart({ weeks }: { weeks: { weekStart: string; count: number }[] }) {
  // Only for scaling the bars. `1` as the floor keeps a run of zeroes from
  // dividing by zero; it never changes a displayed number.
  const busiest = Math.max(1, ...weeks.map((week) => week.count));

  return (
    <table className="table chart">
      <caption className="visually-hidden">
        Loans returned in each of the last {weeks.length} weeks
      </caption>
      <thead>
        <tr>
          <th scope="col">Week beginning</th>
          <th scope="col">Returned</th>
          <th scope="col">
            <span className="visually-hidden">Relative size</span>
          </th>
        </tr>
      </thead>
      <tbody>
        {weeks.map((week, index) => (
          <tr key={week.weekStart}>
            <th scope="row">
              {week.weekStart}
              {index === weeks.length - 1 && <span className="tag tag--muted"> this week</span>}
            </th>
            <td>{week.count}</td>
            <td className="chart__cell">
              {/*
                Presentational only — the number is already in the cell before
                it, so nothing is lost when this is not rendered.
              */}
              <span
                className="chart__bar"
                style={{ width: `${(week.count / busiest) * 100}%` }}
                aria-hidden="true"
              />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
