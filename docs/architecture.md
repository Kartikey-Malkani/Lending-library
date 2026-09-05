# Architecture

The system as it actually shipped, not as it was first sketched. Where a piece of this was reversed
or reconsidered along the way, `decisions.md` carries the reasoning; this file describes the result.

---

## The moving pieces

```
                    ┌──────────────────────────────────────────────┐
   Browser ──HTTPS──▶ Render Web Service · Singapore · Node 22     │
                    │                                              │
                    │   Express 4                                  │
                    │     /api/*  ──▶ routers ──▶ services ──▶ ORM │
                    │     /*      ──▶ express.static(web/dist)     │
                    │                 + history fallback           │
                    └───────────────────────┬──────────────────────┘
                                            │ TLS, two roles
                                            ▼
                    ┌──────────────────────────────────────────────┐
                    │ Neon PostgreSQL 17 · ap-southeast-1          │
                    │   lending_app    ← the running application   │
                    │   neondb_owner   ← migrations and seeding    │
                    └──────────────────────────────────────────────┘
```

**One process serves both the API and the SPA.** That is a deliberate choice rather than a
simplification: same-origin means the session cookie stays `SameSite=Lax`, and there is no CORS
configuration anywhere in the codebase. Splitting the SPA onto a second host would force
`SameSite=None; Secure` and a cross-site cookie — more moving parts, and more ways to be broken in
front of a reviewer. Both regions are Singapore so the application and its database are not on
opposite sides of the planet.

### Where each piece runs

| Piece | Runs | Notes |
|---|---|---|
| React 18 SPA | built by Vite into `web/dist`, served as static files | 271 kB raw / 83 kB gzipped |
| Express API | Render web service, Node 22 | `dist/index.js`, compiled from `server/src` |
| PostgreSQL | Neon, managed | migrations applied at deploy time |

In development the two run separately — Vite on 5173 proxying `/api` to Express on 4000 — and the
same relative `/api` paths work unchanged in both. `serveSpa()` is skipped when `web/dist` does not
exist, so `npm run dev` needs no build.

---

## Request path, end to end

A member requesting an item — the shortest path that touches every layer:

```
POST /api/loans/request  { "itemId": "..." }
  │
  ├─ express.json({ limit: '1mb' })          body size ceiling
  ├─ attachSession                            reads the `session` cookie, HMACs the token,
  │                                           looks up the row, populates req.auth.
  │                                           Never rejects — that is a guard's job.
  ├─ requireCapability('loan:request')        consults the capability matrix in policy.ts
  ├─ parseBody(requestSchema)                 zod: itemId must be a uuid, .strict() so an
  │                                           unexpected field is a 400, not silently ignored
  ├─ requestLoan({ itemId, borrowerId })      borrowerId comes from the SESSION, never the body
  │    └─ prisma.$transaction
  │         ├─ SELECT ... FOR UPDATE          locks the item row against a concurrent archive
  │         ├─ archived? → 409 item_archived
  │         ├─ INSERT INTO loans              partial unique index may reject → 409 item_unavailable
  │         └─ INSERT INTO loan_events        same transaction: a state change cannot exist
  │                                           without its timeline entry
  └─ 201 { loan }
```

Errors leave through one handler and one shape: `{ error: { code, message, details? } }`. The
frontend renders `message` verbatim, because the server's wording is the most useful thing it says.

---

## Authentication and sessions

Opaque token in an httpOnly cookie, session state in the database.

- The cookie holds 32 random bytes, base64url. The `sessions` table stores only
  `HMAC-SHA256(token, SESSION_SECRET)` — never the token. A database dump yields no usable sessions.
- Cookie flags: `httpOnly`, `SameSite=Lax`, `Secure` in production, `maxAge` matching the row's TTL.
- Logout deletes the row, so access ends immediately.
- Expiry is checked on read; there is no background sweep of expired rows.

This reverses the phase-1 plan, which chose stateless JWTs. The reason is recorded in full as
Decision 5: a JWT cannot be revoked before it expires, so "sign out" would have been a request to the
browser to please forget something, rather than an act with a server-side consequence. The reversal
is kept in the history rather than tidied away.

Passwords are bcrypt hashes (`bcryptjs`). Comparison of session tokens uses `timingSafeEqual`.

---

## Authorization

Two different questions, deliberately kept apart:

**Role permission** is a capability matrix, as data, in `server/src/auth/policy.ts`. Every protected
route names a capability instead of hand-rolling a role check, so what each role may do can be read
off one table and audited in one test rather than reconstructed by grepping route files.

```ts
'catalogue:read':     ['librarian', 'member'],
'catalogue:write':    ['librarian'],
'loan:create-issued': ['librarian'],
'dashboard:read':     ['librarian'],
```

**Ownership** cannot be expressed as a role — a member may read their own loans but not another
member's — so it lives in guards, not in the matrix:

- `resolveBorrowerScope()` replaces a member's `borrowerId` query parameter with their own id, so
  editing the URL can never widen what they see.
- `assertCanAccessOwnedResource()` compares against the borrower id on the row the server loaded,
  so changing an id in a URL yields 403 or 404, never someone else's loan.

Conflating the two is how "members can see loans" quietly becomes "members can see all loans".

### Enforcement boundaries that matter

- **No client-supplied actor identity, anywhere.** The borrower on a request, the actor on every
  timeline event, and the librarian behind "my items" all come from the session. `POST /api/loans`
  accepts a `borrowerId` because acting on someone else's behalf is the point of that endpoint — and
  it is librarian-only.
- **Navigation is not authorization.** The SPA hides links a member cannot use; every page behind
  them calls an endpoint the server guards independently. Verified live in M12: a member navigating
  to `/import` sees a message, and the same member's session posting to `/api/items/import` gets 403.
- **Every list parameter is whitelisted.** Sort keys and directions are zod enums, so an unknown key
  is a 400 rather than something interpolated into a query or silently ignored.
- **Role-dependent payload shapes.** `GET /api/items/:id` omits `custodians` and `loans` entirely for
  a member rather than sending them and trusting the client not to render them.

---

## Two database roles

Both exist in production. This was attempted with a documented fallback in case the managed provider
made it impractical; **the fallback was not needed** — Neon supports it, and the deployment runs the
two-role split.

| Role | Used for | Privileges |
|---|---|---|
| `lending_app` | every request the running application serves | SELECT/INSERT/UPDATE/DELETE on the working tables; **SELECT and INSERT only on `loan_events`**; no TRUNCATE anywhere; no access to `_prisma_migrations` |
| `neondb_owner` | migrations, seeding, the test harness reset | owns the schema; never serves a request |

`DATABASE_URL` (the application) points at `lending_app` on Neon's **pooled** endpoint;
`ADMIN_DATABASE_URL` points at `neondb_owner` on the **direct** endpoint, because pgbouncer cannot run
DDL. That constraint maps exactly onto the split that already existed.

The point is that the append-only history is a *privilege*, not only a trigger. A trigger protects
against a mistake; removing the grant protects against a code path that intends to do it. Neon's
`neondb_owner` is not a superuser, which makes the separation stronger there than it is locally.

---

## Loan lifecycle and the concurrency invariant

Four states, and only four: `requested → issued → returned | lost`. The `loan_status` enum has no
`overdue` member, so the database itself rejects an attempt to store one.

Three different races needed three different mechanisms — one per kind of race, not one mechanism
applied three times:

| Race | Mechanism |
|---|---|
| Two people request the same item at once | **Partial unique index** `loans_one_open_per_item_idx` on `(item_id) WHERE status IN ('requested','issued')`. The second INSERT fails however the transactions interleave. |
| Two librarians act on the same loan at once | **Conditional UPDATE** naming the state the caller believed the loan was in. The second matches zero rows and is refused with a message naming the real state. |
| A loan racing an archive of its item | **`SELECT ... FOR UPDATE`** on the item row inside the transaction. |

A refused transition leaves no trace: the event is written after the conditional UPDATE and inside
the same transaction, so a successful change can never exist without its timeline entry, and a
refused one writes nothing.

State/timestamp coherence is enforced by CHECK constraints rather than by convention — a `requested`
loan cannot carry a due date, a `returned` loan must have been issued first, and no event may precede
its cause. That last one caught a real clock-skew bug in M1 and an incoherent test fixture in M7.

---

## Immutable history

`loan_events` is append-only, guaranteed three ways:

1. **No endpoint exists** to update or delete an event. (M12 verified: PATCH/PUT/DELETE all 404.)
2. **A database trigger** rejects UPDATE and DELETE with `restrict_violation`.
3. **The runtime role holds no UPDATE or DELETE grant** on the table.

Stated rather than glossed over: `TRUNCATE` does not fire row-level triggers. That is why the grant
matters, and why `lending_app` holds no TRUNCATE privilege in production. The integration test suite
relies on TRUNCATE to reset between tests — as the *owner* role, never the application role.

Timeline ordering is `(created_at, type, id)`. The `type` tiebreak is load-bearing: a direct issue
writes `requested` and `issued` in one transaction at the same instant, and ordering by a random uuid
returned the timeline backwards about half the time. The `loan_event_type` enum is declared in
lifecycle order and Postgres sorts enum columns by declaration order, so comparing `type` compares
lifecycle position. The limit of that reasoning, and what to do when it stops holding, is Decision 12.

---

## Overdue as derived state

A loan is overdue when it is still `issued` and its due date is strictly before today, UTC. Due
*today* is not overdue.

The rule has two expressions that must agree — TypeScript for the `isOverdue` flag on every response,
SQL for filtering and sorting — so it is stated once in `loans/views.ts` and once as the matching
predicate in the query builder, both evaluated against a single `asOf` threaded through the request.
Nothing is stored, nothing is cached, and no timer recomputes anything. The frontend never derives
it: M11's mutation testing includes a case where the browser recomputes overdue from `dueOn`, and a
test fails.

Alerts follow the same shape: an alert is not a row. It is an overdue loan this librarian has not
dismissed, computed on read. Dismissals are keyed `(loan_id, user_id)` — the loan half is what makes
the brief's re-appearance rule work with no special case, because a later issue is a new loan row;
the user half stops one librarian hiding an overdue item from the team. Verified live in M12.

---

## Dashboard and alerts

The dashboard is **one request**, and every number in it is a database aggregate. That is a single
request because a landing page should not need five round trips — not because the work moved into the
application. Nothing loads loans into the process and counts them in TypeScript.

One `asOf` is threaded through the whole request, so "returned this week" and the final bar of the
eight-week chart cannot disagree — on one screen that would read as a bug, not a rounding difference.

Two aggregates are worth naming:

- **Loans per custodian** is raw SQL, because the shape Prisma cannot express is the important one: a
  LEFT JOIN through the join table so a loan on an item with two custodians produces two rows, and a
  loan on an item with none produces one row with a NULL custodian. That NULL is the `Unassigned`
  bucket. These counts deliberately **do not** sum to the number of loans, and the UI says so rather
  than forcing them to balance.
- **Returns per week** uses `generate_series` to fix eight buckets and a LEFT JOIN to fill them. A
  plain GROUP BY would emit only the weeks that had a return, silently shortening the chart from
  eight bars to six with nothing looking wrong.

The navigation badge reads `count` from `GET /api/alerts?pageSize=1` — the full total, not the size of
a page. There is no client-side unread counter to drift.

---

## Frontend

React 18, `react-router-dom`, `@tanstack/react-query`, and one hand-written stylesheet. No component
library, no design system, no charting library — the eight-week chart is a real `<table>` with CSS
bars, so what a screen reader walks is the data itself rather than a description of a picture.

Two properties are load-bearing:

- **The URL is the query.** Every list's query key *is* `params.toString()`, passed to the server
  verbatim. What the address bar says and what the network tab shows cannot disagree, and nothing is
  filtered, sorted, paged or judged overdue in the browser.
- **The server's errors reach the screen intact.** One `fetch` wrapper preserves `code`, `message`
  and `details`. Lifecycle actions are always enabled whatever state a loan is in, precisely so a
  refused transition produces a visible 409 naming the real state, rather than a greyed-out button
  reimplementing the rule where it can drift.

---

## Build, deploy and run

```
build    npm ci --include=dev
         && npm run build          web:    tsc -p tsconfig.build.json --noEmit && vite build
                                   server: prisma generate && tsc -p tsconfig.build.json
         && npm run db:migrate:deploy      prisma migrate deploy, as ADMIN_DATABASE_URL
start    npm start                         node dist/index.js
health   GET /api/health                   Render's health check path
```

`--include=dev` matters: Render sets `NODE_ENV=production`, which would otherwise make `npm ci` skip
the devDependencies the build needs. Both `tsconfig.build.json` files exclude tests, so test tooling
is not compiled into a release and the deployed image contains no test suite or seed script.

Environment: `NODE_ENV`, `PORT`, `DATABASE_URL`, `ADMIN_DATABASE_URL`, `SESSION_SECRET`. Nothing is
read from a file in production; the two connection strings are `sync: false` in `render.yaml` so they
are entered by hand rather than committed. The server refuses to start in production if
`SESSION_SECRET` is missing or still the development placeholder.

---

## What was deliberately not built

- **A reservation queue.** Goal 4's conflict rule reads literally as a deadlock; resolved as "at most
  one open loan per item", which the brief's own stretch list marks optional (Decision 3).
- **Cancel or decline for a requested loan.** The consequence is real and stated: an unwanted request
  blocks its item. The first thing I would add next.
- **Caching, materialised views, or keyset pagination.** The id tiebreak that keyset pagination needs
  is already in place; the rest would be infrastructure for a problem this size does not have.
- **Index-backed text search.** Both lists use `ILIKE '%term%'`, which cannot use a B-tree index.
  At demo scale an index would be slower than the scan; `pg_trgm` is the fix when it is not.
- **A session cleanup job.** Expiry is checked on read, so this is housekeeping, not correctness.
- **Multipart upload handling.** CSV arrives as a raw `text/csv` body because the SPA reads the file
  itself, so a multipart dependency would buy nothing.
