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

