# Plan

Written as the work happens. Milestones 5 onward are intent, not record — this file is updated when
each one lands, so the estimates below stay honest about what was guessed and what was measured.

## How the work was split

One milestone per working session, each ending in a reviewed, self-contained commit. Every milestone
was planned in writing and approved before any code was written, which is why several of them changed
shape before implementation rather than during it.

The order is deliberate: nothing is built before the thing it depends on can be trusted.

| # | Milestone | Status | Commit |
|---|---|---|---|
| 1 | Scaffold, schema, database-enforced invariants | done | `5ec9e81` |
| 2 | Sessions, role guards, authorization matrix | done | `ec04c16` |
| 3 | Catalogue CRUD, archive/restore, custodians | done | `7bda8f8` |
| 4 | Loan lifecycle, timeline, overdue derivation | done | `f2be968` |
| 5 | Loans list: search, filters, sorting, pagination | done | *pending review* |
| 6 | Bulk CSV import, bulk return, export | planned | — |
| 7 | Dashboard and overdue alerts | planned | — |
| 8 | Frontend | planned | — |
| 9 | Deployment and seeded demo data | planned | — |
| 10 | Documentation pass and `SUBMISSION.md` | planned | — |

## Why this order

**Constraints before code.** Milestone 1 put the invariants in the database — the partial unique
index, the state and chronology CHECKs, the append-only trigger — before any feature could depend on
them. That ordering paid for itself repeatedly: the chronology constraint caught a real clock-skew
bug in milestone 1, and the append-only trigger has since refused several operations that should have
been refused, including one of my own cleanup scripts during milestone 4 verification.

**Authorization before features.** Milestone 2 built the capability matrix and the guards before
there was anything to guard, so every subsequent endpoint declares a capability instead of
hand-rolling a role check. Catalogue and loans added no new authorization mechanism at all.

**Catalogue before loans.** A loan needs an item, and the archived-item rule needed archive to exist
first. Milestone 3 left one requirement explicitly untestable — "an archived item cannot receive a new
loan" — recorded as an `it.todo` rather than faked, and turned into real tests in milestone 4.

**Lists after lifecycle.** The loans list is goal 6's search/filter/sort/pagination requirement. A
"minimal" version in milestone 4 would have been built twice, so only `GET /loans/:id` shipped there
and the full list followed in milestone 5, reusing `resolveBorrowerScope` — written and probe-tested
back in milestone 2, and given its first real route here.

## Estimates versus actuals

Recorded per milestone as it lands. The budget is ~12 hours total.

| # | Estimated | Actual | Notes |
|---|---|---|---|
| 1 | 1.75 h | ~2 h | Three real bugs found while writing the invariant tests, all worth the time |
| 2 | 1 h | ~1.5 h | A migration that was not replayable, and an Express types mismatch inherited from M1 |
| 3 | 1 h | ~1 h | Came in on estimate; no migration turned out to be needed |
| 4 | 1.5 h | ~2 h | The extra went on discovering the race tests were vacuous, and on a real timeline-ordering bug |
| 5 | 1 h | ~1.25 h | No migration needed again; the extra went on a second vacuous test, this time for pagination ordering |

Running total is ahead of the original plan's estimate for the same point, mostly because each
milestone has been planned before being written.

## What changed from the original plan

- **Sessions replaced JWTs** (Decision 5). The phase 1 architecture chose stateless tokens; logout
  cannot revoke one, so milestone 2 reversed it.
- **`cookie-parser` was dropped** for a ten-line reader after a types conflict (Decision 7).
- **Playwright was dropped entirely**, not deferred, so it could not become an unresolved claim.
- **Milestone 3 needed no migration.** Inspecting the schema before planning showed milestone 1 had
  already built everything the catalogue and custodians required.
- **Milestone 4 needed no migration either**, for the same reason.
- **Milestone 5 needed no migration either.** The indexes on `status`, `due_on`, `requested_at`,
  `borrower_id` and `(status, due_on)` from milestone 1 already cover every filter and sort the
  loans list offers.

## Known gaps, carried forward deliberately

- **No cancel or decline for a requested loan.** With one open loan per item, an unwanted request
  blocks its item indefinitely. Out of scope by decision (Decision 3), and the first thing I would
  revisit with more time.
- **No cleanup of expired session rows.** Expiry is checked on read, so this is housekeeping, not
  correctness.
- **A user lookup endpoint is missing.** `POST /api/loans` takes a `borrowerId` and the loans list
  filters by one, but nothing exposes user ids, so a librarian cannot discover who to issue to.
  Deliberately deferred out of milestone 5 to keep it scoped to goal 6; the frontend milestone will
  need the smallest possible librarian-only endpoint.
- **`GET /items/:id` returns a role-dependent shape** — custodians and loan history for librarians,
  neither for members.

## What was cut when time ran short

Nothing yet. This section is filled in at the end, from what actually happened.
