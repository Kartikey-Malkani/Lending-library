# Decisions

Decisions that actually shaped this codebase, in the order they were made. Each one had a real
alternative that I considered and rejected.

Only decisions whose consequences are in the code today are recorded here. Choices about work that
has not been built yet are in `docs/plan.md` instead, so this file never describes an idea as though
it were an implementation.

---

## Decision 1 — Enforce "one open loan per item" in the database, not in application code

- **Chose:** a partial unique index —
  `CREATE UNIQUE INDEX loans_one_open_per_item_idx ON loans(item_id) WHERE status IN ('requested','issued')`.
- **Rejected:** the obvious application-level check — look for an open loan on the item, throw if one
  exists, then insert.
- **Why:** the rejected version is correct in every ordinary test and wrong under concurrency. Two
  simultaneous requests both read "no open loan" before either writes, and both succeed — which is
  precisely the failure the brief opens with, two people believing an item is available. A unique
  index makes the second write impossible however the transactions interleave, so the rule is a
  property of the data rather than of one code path remembering to ask.

  The cost is that the application must translate a unique-violation error into a readable message,
  since goal 4 requires a rejection to explain itself. That is a small price for an invariant that
  cannot be bypassed by a future endpoint, a bulk import, or a manual query.

  `server/test/db-invariants.test.ts` fires two loan creations in parallel and asserts exactly one
  survives. That test fails against the application-level version.

---

## Decision 2 — Overdue is a computed property, and unstorable as a state

- **Chose:** a Postgres enum `loan_status` with exactly four members — `requested`, `issued`,
  `returned`, `lost` — and overdue derived at read time as `status = 'issued' AND due_on < current_date`.
- **Rejected:** adding `overdue` to the status set and moving loans into it, whether by a scheduled
  job or on write.
- **Why:** the brief is explicit that overdue is "computed whenever it's viewed rather than stored as
  a state of its own". Making it an enum member the database refuses to accept turns that from a
  convention someone could later break into something structurally impossible: no future migration,
  code path or manual `UPDATE` can put a loan into an overdue state.

  It also removes an entire class of bug. A stored overdue state is only as fresh as the last job
  run, so a loan can be overdue in reality and not in the database. Deriving it means the answer is
  always current, at the cost of every query that cares having to express the condition.

  Storing `due_on` as `DATE` rather than a timestamp follows from the same reasoning — "past its due
  date" is a calendar comparison, and a date column keeps time-of-day out of the most-read rule in
  the system.

---

## Decision 3 — At most one open loan per item, rejecting the literal reading of the brief

- **Chose:** treat "open" as `requested` or `issued`, and allow at most one open loan per catalogue
  item, so a request against an already-open item is refused too.
- **Rejected:** the literal reading, where any number of loans may be `requested` and only *issuing*
  is blocked.
- **Why:** the literal reading deadlocks. Goal 4 says the server must refuse to issue an item that
  has "any open loan against it — Requested or Issued". If two members can both hold requested loans
  on one item, each is the other's blocker and neither can ever be issued.

  The stretch list settles it: "a hold or reservation queue for items that are currently out" is
  listed as **optional**, so the base system is not meant to queue requests. One open loan at a time
  is a strict superset of the stated rule — it satisfies "refuses to issue on a different loan"
  trivially — and it removes the deadlock.

  This is an interpretation, not something the brief states. The consequence I am accepting is real:
  with no cancel or decline action in scope, a request a librarian does not want to fulfil blocks its
  item indefinitely. That gap is recorded rather than quietly patched, and is the first thing I would
  revisit with more time.

---

## Decision 4 — Make the append-only history a privilege as well as a trigger

- **Chose:** two independent mechanisms. A `BEFORE UPDATE OR DELETE` trigger on `loan_events` that
  refuses both for every role including the schema owner, plus a separate least-privilege database
  role (`lending_app`) that the application connects as, holding only `SELECT` and `INSERT` on that
  table and no `TRUNCATE` on any table.
- **Rejected:** the trigger alone; and, before that, simply revoking privileges from the existing
  role.
- **Why:** goal 9 says nothing in the timeline can be edited or deleted "including by librarians", so
  not shipping an edit endpoint is not enough — the guarantee has to survive a future code path.

  The revoke-only version turned out to be theatre. Measuring first showed that the bootstrap role
  `lending` is both the table owner **and** a superuser, and a superuser bypasses every privilege
  check: `REVOKE TRUNCATE ... FROM lending` would have executed successfully and changed nothing.
  Splitting the roles is the only way to make a privilege genuinely absent.

  The two mechanisms cover each other's gap. The trigger stops a privileged operator, which a
  privilege cannot. The privilege stops the application attempting `TRUNCATE`, which the trigger
  cannot — `TRUNCATE` does not fire row-level triggers.

  The cost is operational: migrations, seeding and the test reset need the owner connection while the
  application uses the restricted one, so there are two connection strings to configure. A host that
  issues only one role still works, with the trigger alone; `.env.example` says so explicitly rather
  than letting the weaker posture pass unnoticed.

---

## Decision 5 — Database-backed sessions with an opaque token

- **Chose:** a `sessions` table. The cookie carries 32 bytes of randomness; the database stores only
  `HMAC-SHA256(token, SESSION_SECRET)`. Logout deletes the row.
- **Rejected:** a stateless JWT in an httpOnly cookie — **which is what I originally chose.**
- **Later reversed:** yes. See below.
- **Why:** JWTs were the Phase 1 plan, on the usual grounds: no session table, no database round-trip
  per request, nothing to clean up.

  Implementing logout is what broke it. A stateless token cannot be revoked. `POST /auth/logout`
  could clear the browser's cookie, but the token itself stays valid until it expires — anyone who
  had copied it keeps access for the rest of the window, and the server has no way to say no. For a
  system whose entire subject is who currently holds what, "signed out everywhere except for anyone
  holding a copy" is not a logout.

  The workarounds are worse than the thing they avoid: a token denylist is a session table with extra
  steps, and very short expiries plus refresh tokens is more moving parts than the table itself.

  So the reversal was to a session table, and the cost is honest — one indexed lookup per
  authenticated request, and rows that accumulate until they expire. Storing the HMAC rather than the
  token is a small addition that means a leaked database dump yields no usable sessions without also
  having `SESSION_SECRET`, and it keeps that variable meaningful.

  `server/test/auth.test.ts` asserts the row is gone after logout and that the old cookie then fails.
  Neither assertion can pass with a stateless token.

---

## Decision 6 — A capability matrix as data, with ownership kept separate

- **Chose:** one `CAPABILITIES` map in `server/src/auth/policy.ts` naming every operation and the
  roles allowed to perform it, with routes declaring a capability. Ownership rules — a member may
  read their own loans but not another member's — live in separate guards, not in the map.
- **Rejected:** role checks written inline at each route (`if (user.role !== 'librarian') ...`), and
  folding ownership into the same mechanism as roles.
- **Why:** goal 1 requires the role difference to be enforced on the server, and a reviewer should be
  able to see what each role may do without grepping every route file. One table can be read in
  full, and asserted exhaustively — `authorization.test.ts` walks every capability against both roles
  rather than restating the rules.

  Keeping ownership out of it is the part that matters. Role answers "may a member read loans?" and
  ownership answers "may this member read *this* loan?". Conflating them is exactly how "members can
  see their loans" quietly becomes "members can see all loans". So the borrower a write is recorded
  against, and the borrower filter a list is scoped to, are both derived from the session and never
  from the request — a `borrowerId` supplied by a member is discarded, not validated.

---

## Decision 7 — Drop `cookie-parser` and read the one cookie directly

- **Chose:** a ten-line `readCookie` helper in `server/src/http/cookies.ts`.
- **Rejected:** the `cookie-parser` middleware, which I had already installed.
- **Why:** its published types pull in a different major version of the Express types than the
  runtime uses, which put a genuine type error in the middleware stack. The choice was between
  pinning transitive type versions across the tree or writing the parsing this application actually
  needs — one named cookie, URL-decoded, from a header Express already exposes.

  This is the smallest decision here and the least interesting, but it is the reason a dependency
  that appears in the git history is absent from the final `package.json`, and that is worth being
  able to explain.

---

## Decision 8 — Archive and restore are conflicting state transitions, not idempotent toggles

- **Chose:** archiving an already-archived item returns `409 already_archived`, and restoring an
  active item returns `409 not_archived`. Both are conditional updates
  (`UPDATE ... WHERE archived_at IS NULL`), not read-then-write.
- **Rejected:** idempotent archive/restore, where repeating the call quietly succeeds.
- **Why:** the system already promises that an illegal state change explains itself rather than
  being silently absorbed — that is goal 4's rule for loans. Archiving is a state change on the item,
  and having two different contracts for the same shape of operation would be arbitrary.

  It also matters in the situation the brief opens with: several people acting on stale information.
  If one librarian archives an item while another's screen still shows it active, the second click
  should say "that already happened", not report success and leave them believing they did it.

  The conditional update is what makes this safe under concurrency. A read-then-write version lets
  two simultaneous archives both pass the "is it active?" check before either writes, and both
  report success; here the `WHERE` clause does the checking, so exactly one update matches a row.

  The cost is real: a retried request whose response was lost gets a false error. Archive is a
  deliberate, low-frequency action, so I took that trade — but it is the entry here I would most
  readily reverse if it turned out to annoy in practice.

---

## Decision 9 — Custodians are replaced as a set, and that operation is idempotent

- **Chose:** `PUT /api/items/:id/custodians` with the complete list of librarian ids, replacing the
  set in one transaction. Sending the same set twice is a no-op; duplicate ids within the request are
  deduplicated.
- **Rejected:** granular `POST` and `DELETE /custodians/:librarianId` endpoints.
- **Why:** the UI for this is a multi-select. Granular endpoints would force the client to diff its
  own state into several calls and handle partial failure halfway through; one atomic call cannot
  half-apply.

  Note the deliberate asymmetry with Decision 8. Custodian assignment is **set membership** — "ensure
  this librarian is a custodian" carries no new information when repeated, so idempotence is the
  honest contract. Archiving is a **lifecycle transition**, where a repeat means the caller believed
  something that is no longer true. Same system, opposite contracts, for a reason.

  **The trade I am accepting:** set replacement is last-write-wins. Two librarians editing custodians
  at the same time means one silently loses the other's change. Granular endpoints would not have
  that problem. For a handful of librarians on a small catalogue this is acceptable; at a larger
  scale it would not be.

  One consequence shaped the implementation more than the endpoint shape did: **every id is validated
  before anything is written.** The natural implementation is delete-then-insert inside a
  transaction and trust the rollback, which looks correct but only holds if the failure happens
  inside the transaction. Validating first means a request naming even one member id leaves the
  existing set completely untouched — asserted directly in `custodians.test.ts` rather than inferred
  from rollback semantics.

---

## Decision 10 — Custodianship is responsibility, not permission

- **Chose:** any librarian may edit, archive and manage custodians on any catalogue item, whether or
  not they are one of its custodians. Custodian data is not shown to members at all.
- **Rejected:** treating custodianship as an authorization scope, so that only an item's custodians
  could modify it.
- **Why:** goal 5 describes custodians as "responsible for its condition and location" and requires
  each librarian to be able to see their own list. It says nothing about restricting who may edit
  what, and inventing that restriction would add a permission rule the brief never asked for — one
  that would immediately get in the way when a custodian is on holiday.

  Keeping it out of authorization also keeps the capability matrix honest: `custodian:manage` is a
  librarian capability, full stop, with no per-row exception hiding behind it.

  The member side is the opposite call. Members can browse the catalogue because goal 3 requires them
  to request items, but custodian assignments are internal operational data, so `GET /items/:id`
  omits the field entirely for a member rather than returning it and relying on the UI not to draw
  it. The service does not fetch custodians at all on that path, so there is nothing to leak.

---

## Decision 11 — Three different concurrency mechanisms, one per kind of race

- **Chose:** the partial unique index for "one open loan per item", a row lock on the catalogue item
  (`SELECT ... FOR UPDATE`) for "no new loan on an archived item", and a conditional `UPDATE` naming
  the expected state for "one transition per loan".
- **Rejected:** a single mechanism for all three — in particular, an application-level check of the
  item's `archived_at` before inserting the loan.
- **Why:** the three races are genuinely different and a single tool does not cover them.

  The unique index handles two people grabbing the same free item: the second insert cannot exist,
  whatever the interleaving. The conditional `UPDATE` handles two people acting on the same loan: the
  second matches zero rows once the first commits, so exactly one event is written.

  The archive race needed something else. `SELECT archived_at` followed by `INSERT` leaves a window
  in which an archive can commit between the two statements, and the loan lands against an item that
  is already out of circulation. A constraint cannot express it, because the rule spans two tables.
  So the loan path takes the item's row lock before writing, and archiving takes the same lock via
  its own `UPDATE`. The two serialize: either the loan commits first and the item is archived with a
  legitimate open loan against it, or the archive commits first and the loan attempt re-reads the
  committed row and is refused.

  Returns and mark-lost deliberately take **no** item lock. Archiving stops an item going out; it
  must never stop one coming back, so blocking a return behind an archive would be wrong as well as
  slow.

  Lock order is always item first, then loan, so two operations cannot deadlock by taking the same
  pair in opposite orders.

  **What this cost, and why it was worth finding:** the first version of the race tests fired
  overlapping HTTP requests with `Promise.all` and asserted the outcome. They passed. Then I removed
  `FOR UPDATE` from the service and ran them again — all twelve still passed. The window is
  microseconds wide and the scheduler essentially never lands inside it, so those tests proved
  nothing about the lock. The suite now also holds an uncommitted archive transaction open and
  asserts that a concurrent request *blocks* on the row lock, which does fail without `FOR UPDATE`.
  An outcome-only race test is close to worthless for proving a lock exists.

---

## Decision 12 — Timeline order breaks ties on event type, not on id

- **Chose:** order a loan's timeline by `(created_at, type, id)`, relying on the `loan_event_type`
  enum being declared in lifecycle order.
- **Rejected:** `(created_at, id)`; and adding a monotonic sequence column now.
- **Why:** a librarian issuing an item directly writes two events — `requested` and `issued` — in one
  transaction at the same instant, because the loan genuinely passes through both states. With only
  `created_at` and a random uuid to sort by, those two come back in a random order. It surfaced as a
  test that passed once and failed on the next run, but it was never only a test problem: the API
  returned the timeline backwards roughly half the time.

### Why enum order is sufficient today

Postgres sorts enum columns by declaration order, and `loan_event_type` is declared
`requested, issued, returned, lost` — lifecycle order. So comparing `type` compares lifecycle
position.

That is a *correct* tiebreak, not just a convenient one, because a single loan can never hold two
events of the same type. Every creation path was reviewed to confirm it:

| Type | Written by | Why at most once |
|---|---|---|
| `requested` | loan creation (`requestLoan`, `createIssuedLoan`) | a loan is created exactly once |
| `issued` | `createIssuedLoan` at creation, **or** the `requested → issued` transition | a loan takes one path or the other, and `issued → issued` is refused |
| `returned` | the `issued → returned` transition | `returned → returned` is refused |
| `lost` | the `issued → lost` transition | `lost → lost` is refused |

So `type` is in fact a *total order* over one loan's events, which is stronger than a tiebreak needs
to be. `id` stays as a final key so the `ORDER BY` is fully determined regardless.

`loans-lifecycle.test.ts` asserts this directly — it drives a full lifecycle including refused
transitions and then queries for any `(loan_id, type)` pair occurring more than once, expecting none.
It also asserts the enum's declaration order, since that is the property the ordering depends on.

### The limitation, stated plainly

This holds **only while every event type is a one-per-loan lifecycle transition.**

Adding an event type that can legitimately occur more than once on the same loan — a standalone
librarian note, a renewal, a condition check at handover — would allow two events of the same type
at the same timestamp. Enum order could not separate those, and the timeline would go back to being
non-deterministic in exactly the way it was before this fix.

### What to do at that point

Add a **monotonic ordering column** on `loan_events` in a **new migration** — a `bigserial` sequence,
or a per-loan sequence number — and order by `(loan_id, seq)`. That is unconditionally correct and
needs none of the reasoning above.

It is deliberately not added now: it would be a migration to solve a problem the current event model
does not have, and the enum's ordering is a property chosen on purpose in milestone 1 rather than a
coincidence being exploited. The guard against forgetting is the test, which fails the day the
assumption stops being true.

---

## Decision 13 — Overdue is one rule with two expressions, bound to a single instant

- **Chose:** the loans list expresses overdue as `status = 'issued' AND due_on < todayUtc(asOf)`,
  built from the **same** `todayUtc()` helper the TypeScript `isOverdue` uses, with one `asOf` passed
  to both the query and the row mapper.
- **Rejected:** writing the SQL predicate independently — the obvious `dueOn: { lt: new Date() }` —
  and letting the two definitions live side by side.
- **Why:** milestone 4 derived overdue in TypeScript; milestone 5 has to filter and sort by it in the
  database. That is the moment a single rule quietly becomes two, and they drift at the boundary
  first: a `lt` that should be `lte`, or a local date where a UTC one was meant, and the list starts
  disagreeing with the badge on exactly the loans due today.

  Passing one `asOf` through both paths means they cannot disagree even in principle — there is one
  date computation per request, not two. `loans-list.test.ts` also cross-checks them directly: it
  seeds loans due at −30, −1, 0, +1 and +30 days plus a closed loan long past its date, then asserts
  the set the SQL filter returns is exactly the set the TypeScript derivation calls overdue.

  Mutating `lt` to `lte` fails two tests, which is how I know the check is real rather than
  decorative.

  The related consequence, tested explicitly: `status=issued` **includes** overdue loans, because an
  overdue loan is issued. `status=overdue` is the subset. Filtering them apart would have meant
  inventing a fifth lifecycle state, which is exactly what the brief forbids.

---

## Decision 14 — Sorting keys are whitelisted, ties break on id, and nulls are pinned

- **Chose:** `sort` limited to `dueOn | requestedAt | status` and `dir` to `asc | desc`, both
  rejected with 400 when unrecognised; `id` appended as the final ordering key on every sort;
  `nulls: 'last'` stated explicitly for `dueOn` in both directions.
- **Rejected:** accepting arbitrary column names; relying on Postgres's default null placement;
  treating "two identical requests return the same rows" as proof the ordering is deterministic.
- **Why:** three separate hazards, each with its own reason.

  **Whitelisting** keeps a caller from ordering by a column they should not be able to observe —
  `password_hash` is the obvious one — and means nothing user-supplied reaches the query builder as
  an identifier.

  **Null placement** cannot be left to the default because Postgres flips it: `NULLS LAST` for `ASC`,
  `NULLS FIRST` for `DESC`. Requested loans have no due date, and a loan with no due date is not
  "due earliest" or "due latest" — it is not in the sequence at all, so it belongs at the end
  whichever way the list is sorted. Pinned, and tested in both directions.

  **The id tiebreak** is the one I nearly got wrong. Loans routinely share a status or a due date,
  and without a deterministic final key, offset pagination silently skips and repeats rows. I wrote
  a stability test — same request twice, and adjacent pages disjoint — and it passed. Then I removed
  the tiebreak entirely and it *still* passed: Postgres returned that small table in a consistent
  order anyway, so the test proved nothing, exactly like the vacuous race tests in milestone 4.

  The test that does discriminate asserts something specific: when the sort field is identical across
  every row, the results come back **in id order**. Loan ids are random uuids, so any other ordering
  — insertion order, physical order, another column — is essentially never also id order. That test
  fails without the tiebreak and passes with it.

  Status sorting needs no special expression: `loan_status` is a Postgres enum declared in lifecycle
  order, and Postgres sorts enums by declaration order, so ascending gives
  requested → issued → returned → lost. Alphabetically it would be issued, lost, requested, returned,
  which reads as nonsense; there is a test asserting the lifecycle order rather than trusting it.

---

## Decision 15 — The CSV import is of catalogue items, and the export is of issued loans

- **Chose:** `POST /api/items/import` imports **catalogue items** (title, category, code). The export
  contains loans with `status = 'issued'` only.
- **Rejected:** a loan importer; and including `requested` loans in the export.
- **Why:** both readings come from the brief rather than from preference, and I had to go back to it
  to settle them.

  **Import.** Goal 7 says "Librarians can bulk-import **catalogue items** from a CSV file". A row is
  an item. It carries no borrower, creates no loan, and writes no timeline event. When the milestone
  was specified to me it was described in loan-shaped terms — borrower ids, conflicts with open
  loans, archived items, `loan_events` — which would have meant building something the brief never
  asks for while possibly not building the thing it does. Worth stopping over.

  **Export.** Goal 7 asks for "every item currently out on loan, with its borrower and **due date**".
  A requested loan has no due date at all — the database forbids one
  (`loans_requested_state_chk` requires `due_on IS NULL` while a loan is requested). Including
  requested loans would emit rows with an empty due-date column, contradicting the description of
  the file. A requested item is also still on the shelf; it is not out. So "currently out" is
  `issued`, which includes overdue loans because an overdue loan is issued, and excludes returned and
  lost because the item has come back or gone for good.

  An archived item appears if it has an issued loan. Archiving withdraws an item from circulation but
  does not end a loan already in someone's hands, and those are precisely the ones a librarian needs
  to chase.

---

## Decision 16 — Bulk operations compose the single-item services rather than reimplementing them

- **Chose:** the importer calls `createItem()` per row; bulk return calls `returnLoan()` per loan.
  Each row and each loan is its own transaction.
- **Rejected:** bulk-specific validation and transition code; and a single transaction spanning the
  whole file or batch.
- **Why:** the brief requires partial success in both directions — "every valid row is still
  imported", and a per-loan report of "what succeeded and what was rejected". A transaction around
  the whole operation would make one bad row roll back every good one, which is the exact opposite.
  Per-row transactions are not a performance compromise here; they are the requirement.

  Composing rather than duplicating matters just as much. Bulk return inherits the conditional
  UPDATE, the immutable `returned` event written in the same transaction, and the rejection messages
  — including the brief's own example, "a loan that was already returned", which is produced by the
  shared service rather than by a bulk-specific check. A second implementation would drift, and the
  two would eventually disagree about what a return means.

  The importer likewise shares the item schema with `POST /api/items`, so a CSV row is held to
  exactly the rules a hand-created item is, and the unique index on `code` stays authoritative for
  duplicates. That last point is what makes "the first occurrence of a duplicated code wins" fall
  out for free: the first row has already committed, so the second hits the index exactly as an
  existing-row duplicate would. No in-memory dedupe pass that could disagree with the database.

---

## Decision 17 — Repeated loan ids in a bulk return are rejected, not deduplicated

- **Chose:** `400 duplicate_loan_id` naming the repeated ids, before any work starts.
- **Rejected:** silently deduplicating (my first proposal); and processing each occurrence and
  reporting the second as "already returned".
- **Why:** the response is a **per-loan result**, so every entry should correspond to exactly one
  requested loan. Deduplicating breaks that correspondence quietly. Processing both is worse: it
  reports the caller's own repetition as though it were a fact about the data, so a client sees
  "already returned" for a loan that was issued when the request was made.

  Rejecting keeps the contract unambiguous and the failure actionable. The cost is that a caller who
  builds a list with a duplicate gets nothing done until they fix it — acceptable, because that list
  is a programming mistake rather than a plausible intent.

---

## Decision 18 — CSV output is escaped by hand; CSV input is parsed by a library

- **Chose:** `csv-parse` for reading uploads; a small hand-written escaper for writing exports, with
  a formula-injection guard.
- **Rejected:** hand-rolling the parser; and adding a second dependency for output.
- **Why:** the two directions are not equally hard. Reading CSV has genuinely awkward cases —
  quoted fields containing commas, doubled quotes, embedded newlines, a BOM, CRLF — and getting one
  wrong would mis-attribute a failure to the wrong row, which is the one thing the per-row report has
  to get right. Writing is a handful of rules that fit in ten lines and are tested directly.

  The injection guard prefixes a field beginning `=`, `+`, `-`, `@`, tab or CR with an apostrophe.
  This file exists to be opened in Excel or Sheets, and item titles are user input, so a title of
  `=HYPERLINK(...)` would otherwise be evaluated rather than displayed. Deliberately small: the
  apostrophe is the whole measure, nothing is stripped, and no sanitisation framework is involved.

  Uploads arrive as a raw `text/csv` body rather than multipart, which avoids a multipart dependency
  entirely. The client is an SPA that reads the file itself and never needs a browser form encoding.

---

## Decision 19 — One `asOf` per dashboard request, and the week boundary computed in TypeScript

- **Chose:** capture a single `asOf` when the request arrives, derive the overdue boundary, the
  "this week" window and all eight chart bucket edges from it, and pass those edges into SQL as
  parameters.
- **Rejected:** letting each query compute its own `now`, and using Postgres `date_trunc('week', …)`
  to find the week boundaries inside each query.
- **Why:** the dashboard shows "loans returned this week" as a headline **and** as the last bar of
  the eight-week chart. Those are the same number, and if the two queries each ask the clock
  separately they can straddle midnight or a Monday and disagree — on one screen, by one. That reads
  as a bug in the data rather than a rounding artefact, and it is the kind of thing nobody can
  reproduce later.

  Computing the ISO week start in TypeScript rather than in SQL keeps every boundary derived from one
  value in one timezone, and makes `generate_series` take explicit parameters instead of consulting
  the database clock. `loans-list.test.ts` and the alerts list use the same `todayUtc()` helper, so
  the overdue boundary is stated once for the whole system.

  A test asserts the headline equals the final chart bucket. Mutating the week calculation to a
  trailing seven days fails it.

---

## Decision 20 — Custodian counts do not sum to the loan total, and that is the correct answer

- **Chose:** count a loan once for **each** custodian of its item, and put loans on items with no
  custodian into an explicit `Unassigned` bucket.
- **Rejected:** counting each loan once by picking a "primary" custodian; and omitting items that
  have no custodian.
- **Why:** custodianship is many-to-many by requirement — "any number of librarians can be assigned
  to a catalogue item as its custodians". If two librarians are both responsible for an item, a
  breakdown that shows the loan under only one of them is wrong for the other, and choosing which one
  would mean inventing a precedence rule the brief does not have.

  So the figures can exceed the number of loans. On the seeded data: 20 loans, custodian counts
  summing to 23, because two items have two custodians each. That is not double counting to be
  corrected — it answers "how much is each custodian responsible for", which is a different question
  from "how many loans are there", and the response type says so.

  The `Unassigned` bucket is the other half. Four seeded items have no custodian; without that bucket
  their loans vanish from the breakdown and nothing looks wrong. It is implemented as a `LEFT JOIN`
  through the join table, and mutating it to an inner join fails two tests.

---

## Decision 21 — Dismissing an alert requires the loan to be overdue *now*, checked in the write itself

- **Chose:** `INSERT ... SELECT ... WHERE status = 'issued' AND due_on < today ... ON CONFLICT DO
  NOTHING` — one statement that both checks and writes. A loan that is not currently overdue gets
  `409 not_overdue`.
- **Rejected:** reading the loan, deciding, then inserting; and allowing dismissal of any loan.
- **Why:** a dismissal must mean "I have seen this alert and dealt with it". If a librarian could
  dismiss a loan that is issued but not yet due, the row would sit there and silently mute the alert
  **when the loan later became overdue** — the warning would simply never appear. Requiring the loan
  to be overdue at the moment of dismissal closes that.

  Doing the check inside the insert removes the window entirely: there is no point at which a
  decision has been made but not yet written. That matters more than it looks, because this is the
  one place in the system where a stale read could create a row that suppresses a future warning.

  The opposite staleness is harmless and deliberately unguarded: if the loan is returned a moment
  after the insert, the dismissal refers to a loan that can never alert again — `returned` and `lost`
  are terminal, and a later loan on the same item is a different row. That asymmetry is why no lock
  is needed here, unlike the archive/loan race in milestone 4.


---

## Decision 22 — One process serves both the API and the SPA

- **Chose:** a single Render web service. Express handles `/api/*`, then `express.static(web/dist)`
  and a history fallback handle everything else.
- **Rejected:** a static host for the SPA plus a separate API service, which is the more common shape.
- **Why:** the session cookie. Same-origin means it stays `SameSite=Lax` and there is no CORS
  configuration anywhere in the codebase. Splitting across two hosts would force
  `SameSite=None; Secure`, a cross-site cookie, and an allowlist to maintain — three more things that
  can be wrong in front of a reviewer, in exchange for a separation this size of application does not
  need.

  The ordering inside the process is load-bearing and easy to get wrong: the API 404 is registered
  *before* the static handler, so a mistyped endpoint returns a JSON 404 rather than falling through
  and being answered with the SPA's HTML. The history fallback is registered after it, so a deep link
  like `/loans/:id` still reloads correctly.

  `serveSpa()` is skipped when `web/dist` does not exist, so `npm run dev` — where Vite serves the SPA
  and proxies `/api` — does not require a build to have been run.

---

## Decision 23 — Two database roles in production, not one

- **Chose:** `lending_app` for every request the application serves, `neondb_owner` for migrations,
  seeding and the test-harness reset. Both exist on Neon; the application's `DATABASE_URL` never has
  DDL rights and holds no `UPDATE`, `DELETE` or `TRUNCATE` on `loan_events`.
- **Rejected:** a single connection string for everything, which was the documented fallback if the
  managed provider made the split impractical. **It was not needed** — Neon supports it, and the
  fallback is recorded here only because it was planned for, not because it shipped.
- **Why:** it is what makes the append-only history a *privilege* rather than only a trigger. A
  trigger stops a mistake; a missing grant stops a code path that fully intends to do it. And
  `TRUNCATE` does not fire row-level triggers, so without the grant separation the trigger has a hole
  that the test suite itself demonstrates every time it resets the database.

  Two details worth recording because they were not obvious in advance:

  - Neon's `neondb_owner` is **not** a superuser. That makes the separation stronger there than it is
    on a local Postgres, where the owner often is.
  - Neon's *pooled* endpoint cannot run DDL, because pgbouncer in transaction mode does not support
    it. So `ADMIN_DATABASE_URL` must use the direct endpoint while `DATABASE_URL` uses the pooled one.
    That provider constraint maps exactly onto the split that already existed for privilege reasons —
    the two requirements happened to want the same shape.

---

## Decision 24 — Two frontend dependencies, and no more

- **Chose:** `react-router-dom` and `@tanstack/react-query`. Plain controlled forms, one hand-written
  stylesheet, and the weekly chart built as a real `<table>` with CSS bars.
- **Rejected:** a component library, a design system, a form library, and a charting library.
- **Why:** the brief rewards judgement rather than visual polish. Routing and server-state caching are
  genuinely hard to hand-roll well — cache invalidation after a mutation is exactly where a
  hand-rolled version would drift and start showing stale loan state. Everything else on these screens
  is a form, a table or a list, and a dependency for those buys nothing while adding surface area.

  The chart in particular: a charting library for one chart on one page is a poor trade, and building
  it as a table rather than an SVG picture means the markup a screen reader walks *is* the data, not
  a caption describing a graphic that could drift from it.

---

## Decision 25 — Lifecycle buttons are always enabled, and the server's refusal is the feedback

- **Chose:** on a loan, Issue / Mark returned / Mark lost are always rendered and always clickable,
  whatever state the loan is in. A refused action renders the server's 409 verbatim, including the
  `{ currentStatus, attempted }` detail.
- **Rejected:** disabling or hiding the actions that are not legal for the current status — the more
  conventional choice.
- **Why:** the rule about which transition is legal already exists in exactly one place, the
  conditional UPDATE in `transition()`. Greying out a button re-implements that rule in React, where
  it can drift from the server's version, and the two disagreeing is worse than either alone.

  It also hides the genuinely interesting case. The status on screen is a moment old, and another
  librarian may already have acted on the same loan. A disabled button says "you cannot do this"; a
  refused request says "the loan is already returned" — which is true, current, and actually useful.

  The cost is honest and accepted: an action that is obviously wrong is still offered. That is the
  trade for having one authority on the rules rather than two.

---

## Decision 26 — The `qs` advisory is documented rather than forced

- **Chose:** leave Express 4 and its `qs` dependency exactly as they are, and describe the advisory
  plainly in `SUBMISSION.md`.
- **Rejected:** an npm `overrides` entry pinning `qs` to the patched 6.16.0; and upgrading to
  Express 5.
- **Why:** there is no fix to apply. The patched `qs` is 6.16.0, and every Express 4 release — up to
  and including the current 4.22.2 — pins `~6.15.1`, which excludes it. This was checked rather than
  assumed: `npm audit fix` in a throwaway clone changes nothing at all, and `npm audit fix --force`
  bumps only the test runner and leaves Express on 4.22.2 with the advisory intact.

  An `overrides` entry would work mechanically, and that is the reason to be careful with it: it would
  run Express against a transitive version outside the range its maintainers declared, and the
  advisory's fix changes array-limit handling in the query parser — precisely the code path Express
  uses on every request. Passing tests would not tell me much, because the failure mode of that change
  is subtle and input-dependent.

  Weighed against a moderate-severity denial-of-service on query-string parsing, further limited by
  Node's default ~16 KB cap on request URLs and by every parameter being whitelisted with zod after
  parsing, forcing the override is the worse trade. Stability of a verified implementation beats a
  cleaner `npm audit` line.
