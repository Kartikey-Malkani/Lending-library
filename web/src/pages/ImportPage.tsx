import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState, type ChangeEvent } from 'react';
import { Link } from 'react-router-dom';
import { importItems } from '../api/catalogue.js';
import type { ImportReport } from '../api/types.js';
import { ErrorState } from '../components/DataState.js';

/**
 * Bulk import of catalogue items from a CSV file.
 *
 * The file is read as text and posted as a raw `text/csv` body — the same bytes
 * the librarian chose. Nothing is parsed, validated or repaired here: the server
 * owns the column rules, the row limit and the duplicate-code check, and it is
 * the only party that can check a code against the unique index rather than
 * against a stale copy.
 */
/**
 * Reads the chosen file as text.
 *
 * `FileReader` rather than the shorter `Blob.text()`, which Safari only gained
 * in version 14 — and which jsdom does not implement at all, so the upload path
 * would have had no test behind it.
 */
function readAsText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(reader.error ?? new Error('The file could not be read.'));
    reader.readAsText(file);
  });
}

export function ImportPage() {
  const queryClient = useQueryClient();
  const [csv, setCsv] = useState('');
  const [filename, setFilename] = useState('');
  const [report, setReport] = useState<ImportReport | null>(null);

  const run = useMutation({
    mutationFn: () => importItems(csv),
    onSuccess: (result) => {
      // Rows that succeeded are new catalogue items, so every cached listing is
      // out of date.
      queryClient.invalidateQueries({ queryKey: ['items'] });
      setReport(result);
    },
  });

  async function onFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    setReport(null);
    run.reset();
    if (!file) {
      setCsv('');
      setFilename('');
      return;
    }
    setFilename(file.name);
    setCsv(await readAsText(file));
  }

  return (
    <section>
      <div className="page-head">
        <h1>Import catalogue items</h1>
      </div>

      <p className="hint">
        A CSV with the columns <code>title</code>, <code>category</code>, <code>code</code>. Valid
        rows are imported even when others fail — you get a result for every row rather than an
        all-or-nothing answer.
      </p>

      <div className="panel">
        <div className="form form--inline">
          <div className="field">
            <label htmlFor="csv-file">CSV file</label>
            <input id="csv-file" type="file" accept=".csv,text/csv" onChange={onFile} />
          </div>
          <button
            type="button"
            className="primary"
            onClick={() => run.mutate()}
            disabled={!csv || run.isPending}
          >
            {run.isPending ? 'Importing…' : 'Import'}
          </button>
        </div>

        {filename && (
          <p className="hint">
            Ready to upload <strong>{filename}</strong> ({csv.length.toLocaleString()} bytes).
          </p>
        )}

        {/*
          A rejection of the request as a whole — an empty body, a missing header,
          too many rows — never produces a per-row report, so it is shown as the
          server worded it.
        */}
        {run.isError && <ErrorState error={run.error} title="The file could not be processed" />}
      </div>

      {report && <ImportReportView report={report} />}
    </section>
  );
}

/**
 * The per-row outcome.
 *
 * Partial success is the normal case and is presented as one: how many were
 * imported, how many failed, and then every row with the number a spreadsheet
 * shows it under and the server's own reason. Reducing a file where nine rows
 * of ten succeeded to "import failed" would be both discouraging and false.
 */
function ImportReportView({ report }: { report: ImportReport }) {
  return (
    <div className="panel">
      <h2>Import result</h2>

      <p role="status">
        <strong>{report.imported}</strong> imported, <strong>{report.failed}</strong> failed.
      </p>

      <table className="table">
        <caption className="visually-hidden">Result for each row of the file</caption>
        <thead>
          <tr>
            <th scope="col">Row</th>
            <th scope="col">Result</th>
            <th scope="col">Detail</th>
          </tr>
        </thead>
        <tbody>
          {report.results.map((result) => (
            <tr key={result.row}>
              <td>{result.row}</td>
              <td>
                <span className={result.ok ? 'tag tag--ok' : 'tag tag--warn'}>
                  {result.ok ? 'Imported' : 'Failed'}
                </span>
              </td>
              <td>
                {result.ok ? (
                  <Link to={`/catalogue/${result.itemId}`}>
                    <code>{result.code}</code>
                  </Link>
                ) : (
                  <>
                    {result.message} <span className="state__code">({result.code})</span>
                  </>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
