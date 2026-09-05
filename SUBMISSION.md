# Submission

## Links

- **GitHub repository:** https://github.com/Kartikey-Malkani/Lending-library
- **Live application:** https://lending-library-u9ze.onrender.com

## Before you open the link

**The first request takes about 25 seconds.** Render's free tier sleeps the service when idle and
Neon suspends the database; both wake on the first request. This is measured, not estimated. Every
request after that is normal. If the page looks stuck, it is waking up.

## Demo credentials

| Role | Email | Password |
|------|-------|----------|
| Librarian | `alex.librarian@example.com` | `Librarian123!` |
| Librarian | `priya.librarian@example.com` | `Librarian123!` |
| Member | `sam.member@example.com` | `Member123!` |
| Member | `dana.member@example.com` | `Member123!` |

Two librarians are seeded on purpose — custodianship is many-to-many, and you need two accounts to
see that an item can belong to both, and that dismissing an alert does not hide it from the other.

**Suggested two-minute tour, as the librarian:** Dashboard → Alerts (note the badge count) → Loans
(change a filter and watch the network tab: the request matches the address bar) → open a loan → try
**Mark returned** on one that is already returned, to see the server's refusal reach the screen.

## Stack

| Layer | What | Why |
|-------|------|-----|
| Frontend | React 18, Vite 6, TypeScript, `react-router-dom`, `@tanstack/react-query` | Two dependencies only. Routing and server-state caching are genuinely hard to hand-roll well; forms, tables and one chart are not. No component library, no design system, no charting library. |
| Backend | Node 22, Express 4, TypeScript, Prisma 6, zod 4 | Boring on purpose. zod at every boundary so an unknown sort key is a 400, not something interpolated into a query. |
| Database | PostgreSQL 17 (Neon, Singapore) | The invariants that matter are database constraints, so the database choice is doing real work. |
| Hosting | Render web service (Singapore) | One process serves the API and the SPA. Same origin, same region as the database. |
| Tests | Vitest + supertest (backend), Vitest + Testing Library (frontend), Playwright (live verification only) | Playwright is not a project dependency — it was installed outside the repository for M12. |

## Architecture in one paragraph

One Node process on Render serves `/api/*` from Express and everything else from the built SPA, with
a history fallback. Single origin, so the session cookie stays `SameSite=Lax` and there is no CORS
configuration anywhere. Sessions are server-side: the cookie holds an opaque random token and the
database stores only its HMAC, so logout genuinely revokes access and a database dump yields no usable
sessions. Authorization is a capability matrix as data, with ownership rules kept deliberately
separate from role rules. The application connects as a least-privilege database role that cannot
alter or delete timeline rows; a separate owner role runs migrations. Full detail in
[`docs/architecture.md`](docs/architecture.md).

## Ten-goal checklist

| # | Goal | Status | Where it lives | Live evidence (M12) |
|---|------|--------|----------------|---------------------|
| 1 | Accounts and roles | **Done** | `auth/`, `policy.ts`; login/logout + role-aware nav | Both roles signed in; member → `/api/items/import` **403** |
| 2 | Catalogue items | **Done** | `routes/items.ts`, `CataloguePage`, `ItemDetailPage` | Create → edit → archive → restore; archived item refuses a loan (`409 item_archived`) |
| 3 | Loans | **Done** | `loans/service.ts`, `LoansPage`, `LoanDetailPage` | Member requested; borrower shown as "You"; appears in item history |
| 4 | Loan lifecycle with rules | **Done** | `transition()` in `loans/service.ts` | requested→issued→returned; issued→lost; illegal move → `409 invalid_transition` visible in the UI |
| 5 | Custodians | **Done** | `catalogue/custodians.ts`, `MyItemsPage` | Two librarians assigned to one item; it appears in **both** their "My items" |
| 6 | Finding loans | **Done** | `listLoans()`, `LoanFilters` | Search, status (incl. overdue), item, borrower, 3 sorts, direction, paging — all URL-driven; `Showing 6–10 of 22` |
| 7 | Bulk operations | **Done** | `catalogue/import.ts`, `loans/bulk.ts`, `loans/export.ts` | Mixed CSV → `2 imported, 3 failed` per row; mixed bulk return → `1 returned, 1 failed`; real CSV download |
| 8 | Dashboard | **Done** | `dashboard/service.ts`, `DashboardPage` | 5 headline figures, 4 statuses, custodian breakdown **including Unassigned**, 8 weekly buckets |
| 9 | History you cannot rewrite | **Done** | trigger + grants + `loan_events` | Timeline shows actor/time/type/note; no UI control; PATCH/PUT/DELETE all **404** |
| 10 | Overdue loan alerts | **Done** | `alerts/service.ts`, `AlertsPage`, nav badge | Alert raised, badge count from the server, dismissed, **and returned on a new loan for the same item** |

All ten are implemented, tested, and verified against the live deployment. Nothing is partial.

## Testing

| | Count | Notes |
|---|---|---|
| Backend integration tests | **318** (15 files) | Real Express app through supertest against real PostgreSQL. Not unit tests with mocks. |
| Frontend tests | **38** (6 files) | `fetch` is stubbed; the real API client, query construction and components run. Assertions are about *what the app sends*. |
| Live UI verification | **52 checks** | Real Chromium against the deployed URL. |

### Mutation testing

A green suite proves nothing until you check it can go red. Across the project I deliberately broke
the implementation and confirmed tests noticed. **This found five vacuous tests that would otherwise
have shipped as false confidence:**

| Milestone | Found |
|---|---|
| M4 | All 12 concurrency tests passed against an implementation with the `FOR UPDATE` lock removed |
| M5 | Removing the id tiebreak entirely — all 37 tests still passed |
| M6 | A "concurrent request" test whose second request never dispatched |
| M10 | Export rebuilt in the browser, and borrower search done client-side — both passed |
| M11 | — (15 mutants, all caught first time) |

Final sweeps: **M10 — 15 mutants, 15 caught. M11 — 15 mutants, 15 caught**, covering exactly the
semantics that are easy to get subtly wrong: overdue vs issued, the eight-bucket count, the
`Unassigned` custodian bucket, many-to-many counts, badge count vs page rows, and the dismissal loan
id.

## Production verification

M12 walked all ten goals against the live URL in real Chromium — clicking buttons, filling forms,
downloading files — with a production baseline recorded before and after so every change is
attributable.

**52 checks, 0 failures, no code changes required.** Every initial failure turned out to be a defect
in my own verification harness, including one that looked like silent data loss in custodian
assignment and took two probes to prove was not. That investigation is written up in
[`docs/ai-prompts.md`](docs/ai-prompts.md) §12.

Test data created (4 items, 7 loans) was closed and archived afterwards; seeded demo data was left
untouched. Active catalogue returned to exactly 20 items, overdue count to 3.

> **Verified in headless Chromium only.** No other browser and no mobile device was tested, and no
> cross-browser or responsive claim is made anywhere in this repository.

## Running it locally

```bash
cp .env.example .env          # then set DATABASE_URL / ADMIN_DATABASE_URL
npm install
npm run db:up                 # docker compose: PostgreSQL on 5433
npm run db:migrate            # applies migrations as the owner role
npm run db:seed               # 6 users, 21 items, 20 loans, 50 timeline events
npm run dev                   # API on :4000, SPA on :5173 (proxies /api)
```

`npm test` runs both suites — the backend one needs the database up. `npm run typecheck` covers both
workspaces including the tests. `npm run build` produces exactly what deploys.

Two database roles locally as well as in production: `lending` owns the schema, `lending_app` is what
the application connects as.

## How production works

```
build   npm ci --include=dev && npm run build && npm run db:migrate:deploy
start   npm start          →  node dist/index.js
health  GET /api/health    →  {"status":"ok","database":"up"}
```

`--include=dev` matters: Render sets `NODE_ENV=production`, which would otherwise make `npm ci` skip
the devDependencies the build needs. Both workspaces have a `tsconfig.build.json` that excludes
tests, so no test tooling is compiled into a release.

**Migrations** run at deploy time as `ADMIN_DATABASE_URL` (the owner role, on Neon's *direct*
endpoint — pgbouncer cannot run DDL). The application then runs as `DATABASE_URL`, the
least-privilege `lending_app` role on the pooled endpoint, which holds no DDL rights and **only
SELECT and INSERT on `loan_events`**. That two-role split is what makes the append-only history a
privilege rather than only a trigger. It was planned with a single-role fallback in case the managed
provider made it impractical; **the fallback was not needed.**

**Seeding** is a one-off manual step guarded by `ALLOW_PRODUCTION_SEED`, because it truncates.

Secrets are set on the host, never in a file. `SESSION_SECRET` is generated by Render, and the server
refuses to start in production if it is missing or still the development placeholder.

## Dependency advisory, stated plainly

`npm audit` reports 11 advisories. Ten are development-only. **One reaches the production runtime and
cannot currently be fixed:**

`qs`, pulled in by Express 4, has two moderate advisories. The patched version is **6.16.0**, and
every Express 4 release — including the current 4.22.2 — pins `~6.15.1`, which excludes it. I checked
this rather than assuming: in a throwaway clone, `npm audit fix` changes **nothing at all**, and
`npm audit fix --force` bumps only the test runner and leaves Express on 4.22.2 with the advisory
intact.

I rejected an `overrides` entry forcing `qs@6.16.0`. It would work mechanically, and that is exactly
why it needs care: it would run Express against a transitive version outside its declared range, and
the fix changes array-limit handling in the query parser — the code path Express uses on every
request. Weighed against a moderate DoS on query-string parsing, further limited by Node's ~16 KB URL
cap and by every parameter being zod-whitelisted after parsing, forcing it is the worse trade.

The other ten are `vitest`→`vite`→`esbuild` (a Vite **dev-server** issue that never runs in
production) and `deepmerge-ts` under the Prisma **CLI**, a devDependency. Fixing them means a major
version bump of the backend test runner, risking 318 tests for no production benefit.
See `docs/decisions.md` Decision 26.

## Time actually spent

**Roughly 17 hours**, against the brief's ~12-hour size guide. Where the extra went: mutation testing
(which found five vacuous tests), live browser verification, and the documentation pass.

The commit history shows two working sessions on consecutive days — 2026-09-04 and 2026-09-05. I have
not backdated or squashed anything to make that look like a week of steady work. 15 incremental
commits, one per milestone, never squashed, all on `main`.

## Known limitations

- **Free-tier cold start**, ~25 seconds after idle.
- **No cancel or decline for a requested loan.** With one open loan per item, an unwanted request
  blocks its item. The first thing I would add.
- **No debounce** on search inputs — one request per keystroke.
- **Pickers load the first 100** users or items and say so when there are more. The borrower picker
  searches server-side; the loans-list item and borrower filters do not.
- **Headless Chromium only** for live verification.
- **Two Vitest majors** in one repository (server 2.x, web 3.x) — Vitest 2 bundles Vite 5, which
  conflicts with the web workspace's Vite 6 types.
- **No rate limiting** on login or anywhere else.
- **No cleanup of expired session rows** — expiry is checked on read.
- **Text search is not index-backed** (`ILIKE '%term%'`); `pg_trgm` is the fix when it matters.

## What I would do next, with another 12 hours

1. **Cancel/decline for a requested loan**, with the timeline event to match. It is the one real
   functional gap, and it has a user-visible consequence today.
2. **Rate limiting on login**, and a session sweeper. Both are small; neither is correctness.
3. **Debounce the search inputs and make the pickers type-ahead**, removing the first-100 limit.
4. **Component-level frontend tests for the pages I verified only end-to-end.** The 38 tests cover the
   request/response contract well; they do not cover rendering permutations.
5. **`pg_trgm` indexes** behind both searches, plus keyset pagination — the id tiebreak needed for it
   is already in place.
6. **Cross-browser and responsive verification**, which I have deliberately made no claim about.

## What I am least happy with

**The frontend is thinner than the backend, and it shows.** The backend has 318 integration tests
against a real database and invariants enforced by the database itself. The frontend has 38 tests
that stub the network, and its correctness rests more on the live walkthrough than I would like on a
system anyone depended on. The screens are correct and I verified them, but the depth is uneven.

**Second: the two Vitest majors.** It is the kind of small inconsistency that is easy to justify in
the moment and annoying to live with — a future contributor will hit it and wonder why.

**Third, and most instructive: I reported wrong bundle sizes for three consecutive milestones.**
`vite.config.ts` pointed Vite's `envDir` at the repository root, where the *server's* `.env` sets
`NODE_ENV=development`; Vite honoured it and emitted a development React bundle locally. The deployed
artifact was always correct at 271 kB, but the numbers I reported were not, and no test would ever
have caught it. Fixed in this milestone — the local build now produces byte-for-byte the same bundle
hash as production — but I had repeated a wrong number three times before checking it.
