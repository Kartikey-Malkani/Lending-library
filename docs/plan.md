# Plan

Written as the work happened, updated when each milestone landed. Nothing here is reconstructed
after the fact, and nothing is backdated.

## How the work was split

One milestone per working session, each ending in a reviewed, self-contained commit. Every milestone
was planned in writing and approved before any code was written, which is why several of them changed
shape before implementation rather than during it.

The order is deliberate: nothing is built before the thing it depends on can be trusted.

| # | Milestone | Status | Commit |
|---|---|---|---|
| — | Initialise repository | done | `d0e0e5f` |
| 1 | Scaffold, schema, database-enforced invariants | done | `5ec9e81` |
| 2 | Sessions, role guards, authorization matrix | done | `ec04c16` |
| 3 | Catalogue CRUD, archive/restore, custodians | done | `7bda8f8` |
| 4 | Loan lifecycle, timeline, overdue derivation | done | `f2be968` |
| 5 | Loans list: search, filters, sorting, pagination | done | `3abe170` |
| 6 | Bulk CSV import, bulk return, export | done | `3a2f24e` |
| 7 | Dashboard and overdue alerts | done | `11e5f43` |
| 8 | Deployable single service + Render/Neon | done | `7fd1062`, `e88462e` |
| 9 | Frontend foundation, auth, catalogue | done | `764a591` |
| 10 | Loans, lifecycle actions, bulk operations (frontend) | done | `b14db0f`, `069785b` |
| 11 | Dashboard and alerts (frontend) | done | `8bf2ad1`, `507b7ac` |
| 12 | Live ten-goal verification against production | done | no code change required |
| 13 | Documentation, submission, final cleanup | done | this commit |

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

**Deployment before the frontend.** Milestone 8 was moved to the front of the remaining work rather
than left to the end. Deployment was the highest-risk unknown left, and discovering a broken release
build after writing the whole frontend is the worst possible order to find out. It was the right
call: `npm start` pointed at a path `tsc` had never produced, and the production build had never once
been run.

## Estimates versus actuals

The budget in the brief is a ~12-hour size guide.

| # | Estimated | Actual | Notes |
|---|---|---|---|
| 1 | 1.75 h | ~2 h | Three real bugs found while writing the invariant tests, all worth the time |
| 2 | 1 h | ~1.5 h | A migration that was not replayable, and an Express types mismatch inherited from M1 |
| 3 | 1 h | ~1 h | Came in on estimate; no migration turned out to be needed |
| 4 | 1.5 h | ~2 h | The extra went on discovering the race tests were vacuous, and on a real timeline-ordering bug |
| 5 | 1 h | ~1.25 h | No migration needed again; the extra went on a second vacuous test, this time for pagination ordering |
| 6 | 1.5 h | ~1.75 h | Re-reading the brief caught that the import is of items, not loans; a third vacuous test found by mutation |
| 7 | 1 h | ~1.25 h | No migration again; eight mutations all caught first time, and the chronology CHECK caught an incoherent test fixture |
| 8 | 1 h | ~1.5 h | Real deployment friction: a broken `start` path, a missing root script, a wrong region, and a screenshot that nearly committed a password |
| 9 | 1.5 h | ~1.5 h | On estimate. Needed one backend addition — `GET /api/users` — because nothing else exposed user ids |
| 10 | 1.25 h | ~1.75 h | Two vacuous frontend tests found by mutation; also uncovered a real error-rendering bug (see below) |
| 11 | 0.75 h | ~1 h | 15 mutations, all caught first time |
| 12 | 0.75 h | ~1.5 h | Live UI verification with Playwright; five of my own harness defects to chase down before anything could be trusted |
| 13 | 0.75 h | ~1.25 h | Documentation pass, dependency audit investigation, build-environment fix |

**Total: roughly 17 hours of work.** The brief calls 12 a size guide rather than a limit, and this
went over it. Where the extra time went, honestly: mutation testing (which found five vacuous tests
that would otherwise have shipped as false confidence), live verification through a real browser, and
the documentation pass.

**Elapsed time is not the same number.** The commit timestamps show two working sessions on
consecutive days — 2026-09-04 11:21 to 23:09, and 2026-09-05 15:28 onward. That is what the history
says and I have not adjusted it to look more like a week of steady work.

## What changed from the original plan

- **Sessions replaced JWTs** (Decision 5). The phase 1 architecture chose stateless tokens; logout
  cannot revoke one, so milestone 2 reversed it.
- **`cookie-parser` was dropped** for a ten-line reader after a types conflict (Decision 7).
- **Playwright was dropped from the product**, not deferred, so it could not become an unresolved
  claim. It reappeared in milestone 12 as a *verification* tool only, installed outside the
  repository so that no project dependency changed.
- **Milestones 3 through 7 needed no migration.** Inspecting the schema before planning showed
  milestone 1 had already built what each one required — including `alert_dismissals`, which sat
  unused with the right composite key from milestone 1 until goal 10 needed it in milestone 7. Five
  milestones running with no schema change is what milestone 1 spending its time on the data model
  bought.
- **The CSV import is of catalogue items, not loans.** The milestone was specified to me in
  loan-shaped terms; re-reading goal 7 settled it (Decision 15).
- **One backend endpoint was added during the frontend work.** `GET /api/users`, librarian-only,
  because `POST /api/loans` takes a `borrowerId` and nothing exposed user ids — a librarian cannot be
  asked to type a uuid. Flagged at the time rather than slipped in.
- **A real bug surfaced while building the M10 screens.** The API sends `details` as a
  `{field, message}` array for validation but as a plain object for a conflict; the error renderer
  assumed an array, so a refused transition's `{currentStatus, attempted}` was present in the
  response and silently dropped on screen. Fixed, with a test.

## Known limitations, carried forward deliberately

- **Free-tier cold start.** Render sleeps the service when idle and Neon suspends the database. The
  first request after a quiet period takes ~25 seconds. Measured, not estimated.
- **No cancel or decline for a requested loan.** With one open loan per item, an unwanted request
  blocks its item indefinitely. Out of scope by decision (Decision 3), and the first thing I would
  revisit with more time.
- **No debounce on search inputs.** One request per keystroke. Fine at demo scale, wrong with real
  traffic.
- **Pickers load the first 100 users or items** and say so when there are more, rather than paging or
  type-ahead. The borrower picker searches server-side; the loans-list item and borrower filters do
  not.
- **Verification was headless Chromium only.** No other browser, and no mobile device, was tested.
  No cross-browser or responsive claim is made anywhere in this repository.
- **Two Vitest majors in one repository** — the server on 2.x, the web workspace on 3.x. Vitest 2
  bundles Vite 5, which conflicts with the web workspace's Vite 6 types. Unifying means upgrading the
  server's test runner and re-validating 318 tests, for no functional gain.
- **An unfixable dependency advisory.** `qs`, reached through Express 4, has two moderate advisories.
  There is no fix: the patched `qs` is 6.16.0 and every Express 4 release pins `~6.15.1`. Verified by
  running `npm audit fix` and `npm audit fix --force` in a throwaway clone — neither changes Express.
  See SUBMISSION.md for the full reasoning and why forcing an override was rejected.
- **No cleanup of expired session rows.** Expiry is checked on read, so this is housekeeping, not
  correctness.
- **`GET /items/:id` returns a role-dependent shape** — custodians and loan history for librarians,
  neither for members.
- **No rate limiting** on login or any other endpoint.

## Goals and where they live

| Goal | Backend | Frontend | Verified live |
|---|---|---|---|
| 1 Accounts and roles | M2 | M9 | M12 |
| 2 Catalogue items | M3 | M9 | M12 |
| 3 Loans | M4 | M10 | M12 |
| 4 Loan lifecycle with rules | M4 | M10 | M12 |
| 5 Custodians | M3 | M9 | M12 |
| 6 Finding loans | M5 | M10 | M12 |
| 7 Bulk operations | M6 | M10 | M12 |
| 8 Dashboard | M7 | M11 | M12 |
| 9 History you cannot rewrite | M1 (constraints) + M4 (timeline) | M10 | M12 |
| 10 Overdue alerts | M7 | M11 | M12 |

## What was cut when time ran short

Nothing was cut from the ten goals — all are implemented, tested and verified live.

What was cut was polish and infrastructure, in this order, and each was a decision rather than an
oversight: index-backed text search, keyset pagination, request debouncing, a session sweeper, a
charting library, cross-browser testing, and cancel/decline for requested loans.
