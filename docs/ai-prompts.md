# AI prompts

I used AI assistance throughout this project: Claude Opus 5, driven through Claude Code in the
project directory. This file is written as the work happens, not reconstructed at the end.

Long prompts are abridged where marked. Nothing here is invented — every prompt listed was actually
sent, and every outcome described actually happened.

---

## 1. Understanding the brief before writing any code

### Prompt

Sent before any code existed. Abridged; the full prompt ran to about two pages.

> PHASE 1 — READ AND ANALYZE ONLY. Do NOT write application code yet.
>
> Read README.md, SUBMISSION.md, docs/architecture.md, docs/schema.md, docs/plan.md,
> docs/decisions.md, docs/ai-prompts.md, .gitignore. Then produce a detailed implementation analysis:
> (A) a requirements matrix for all 10 goals with acceptance criteria, UI/API/database/authorization
> requirements, edge cases, tests required, dependencies and risk; (B) hidden or easy-to-miss
> requirements, and exactly how an evaluator could test each one; (C) an adversarial review — "what
> is the simplest implementation that looks correct in a demo but would actually fail the
> requirement?"; (D) 2–3 architecture options with a recommendation; (E) a complete database design;
> (F) API design; (G) frontend structure; (H) a prioritized test plan; (I) a git strategy;
> (J) a documentation strategy; (K) a 12-hour time budget with an explicit "what not to build";
> (L) a final recommendation.
>
> Do not invent requirements. Clearly distinguish explicit requirements from your engineering
> interpretation. Do not fabricate tests, results, implementation history, decisions, time spent, or
> AI prompts.

### What I got

A long analysis document. Three parts of it changed how I built the system:

1. **The conflict rule in goal 4 deadlocks if read literally.** The brief says the server must refuse
   to issue an item that has "any open loan against it — Requested or Issued". If two members can
   both hold Requested loans on one item, each is the other's blocker and neither can ever be issued.
   The analysis proposed reading it as *at most one open loan per item*, and pointed at the stretch
   list as evidence: "a hold or reservation queue for items that are currently out" is listed as
   optional, so the base system is not supposed to queue.
2. **Alert dismissal keyed on the loan, not the item.** Goal 10 says a dismissed alert must return if
   the item is issued again and goes overdue on the new loan. Keying the dismissal on `loan_id` makes
   that fall out for free, because a later issue is a new loan row. Keying it on the item — which is
   the intuitive first guess — fails the requirement while looking identical in a demo.
3. **An application-level check for "does this item already have an open loan?" is wrong under
   concurrency**, even though it passes every ordinary test. Two requests both read "none" and both
   insert.

### What I accepted, modified or rejected

Accepted the analysis as the plan, with corrections I made before implementation started:

- **Rejected** the suggestion to add member self-registration and a cancel/decline path for Requested
  loans. Both are outside the ten goals. The cancel path has a real consequence I chose to accept:
  an unwanted request blocks its item indefinitely. That is recorded in `decisions.md` rather than
  quietly patched.
- **Rejected** Playwright end-to-end tests. Dropped entirely rather than parked as "if time remains",
  so it cannot quietly become an unresolved claim.
- **Trimmed** the proposed git history from ~29 commits to 12–16 real milestones. The original list
  had commits that were not independently meaningful.
- **Deferred** trigram search indexes, composite-FK role enforcement and rate limiting until there is
  evidence they are needed.
- **Confirmed** the stack (TypeScript, Express, Prisma, Postgres, React, Vite), single-service
  deployment, archived items refusing new loans, and per-librarian alert dismissal.

### Lesson

The most useful thing the analysis produced was not the plan, it was the adversarial pass — the list
of implementations that demo correctly and fail the requirement. Two of those (the item-keyed
dismissal and the application-level conflict check) are exactly what I would have written first.

---

## 2. Milestone 1 — scaffold, schema and database invariants

### Prompt

Abridged.

> Now proceed with ONLY Milestone 1: scaffold the npm workspace; configure TypeScript; create the
> Express app and /api/health endpoint; create the React/Vite shell; create Docker Compose for local
> PostgreSQL; create .env.example and safe environment handling; create the Prisma schema for the six
> required tables; create the migration containing the required state/timestamp constraints; create
> the partial unique index preventing multiple open loans per item; create the append-only trigger
> for loan_events; create the initial seed script; create the Vitest + Supertest harness and one
> basic health test.
>
> Do NOT implement authentication, catalogue CRUD, loan endpoints, dashboard, alerts, bulk
> operations. After implementation, run the planned verification commands and report the ACTUAL
> results, including any failures.

### What I got

A working scaffold on the first pass: workspaces, Express app factory, Vite shell, Docker Compose
Postgres, Prisma schema for the six tables, and a migration whose hand-written section carried the
CHECK constraints, the partial unique index and the append-only trigger.

Two design choices in that output I kept and would defend:

- Modelling `loan_status` as a **native Postgres enum with no `overdue` member**, so "overdue is
  computed, not stored" is enforced by the type system rather than by convention.
- Splitting the Express **app factory** from the listener, so the integration tests drive the real
  middleware stack through supertest instead of testing handlers in isolation.

### What was wrong, and what I did about it

The first version of `test/db-invariants.test.ts` was wrong, and it was wrong in a way that would
have been easy to miss. **Eight of sixteen tests failed on the first run.** Three separate causes:

1. **Assertions that could never match.** The tests issued raw SQL through
   `prisma.$executeRawUnsafe` and asserted on constraint names — `/loans_issued_state_chk/`. Prisma
   does not carry the constraint name through for raw queries; it keeps only the SQLSTATE. I probed
   the actual error objects rather than guessing, and found the shapes differ by call style: model
   operations preserve the Postgres text for a CHECK violation, unique violations arrive as `P2002`
   with the offending columns in `meta` but no index name, and raw queries keep only the SQLSTATE.
   I rewrote each assertion to match how the error actually arrives. This matters beyond the tests —
   the service layer will have to map these same errors to HTTP responses.

2. **Tests that would have passed for the wrong reason.** Prisma maintains `updated_at` from the
   client, so the generated DDL gives the column no default. Every raw `INSERT` in the test file was
   therefore failing with a *not-null* violation, not the constraint being tested. A test asserting
   only "this was rejected" would have gone green while proving nothing. Fixed by adding a database
   default in a second migration, and by asserting the specific failure rather than any failure.

3. **A genuine clock-skew bug.** The chronology constraint (`issued_at >= requested_at`) rejected
   rows where `issued_at` came from Node's `new Date()` and `requested_at` fell back to the column's
   `CURRENT_TIMESTAMP` default — the database clock ran two to three milliseconds later, so the loan
   appeared to be issued before it was requested. This is not a test artefact: the "librarian creates
   a loan directly as Issued" path would hit it in production. The rule is now that the application
   supplies every timestamp on a loan row from a single `now`, and the tests use fixed timestamps so
   exactly one constraint can be the cause of a failure.

I kept the chronology constraint rather than removing the friction. It found a real bug within
minutes of existing, which is the argument for it.

### Lesson

A test that asserts "this was rejected" is close to worthless. All three problems above were
invisible until the assertions named the *specific* reason the database refused the row. The
`updated_at` case is the sharpest example: the test would have passed, the constraint would have been
untested, and I would have believed it worked.

Second lesson: I verified the error shapes by writing a throwaway probe script and printing the real
error objects, instead of trusting either my own assumption or the model's. That took about three
minutes and corrected seven assertions.

---

## 3. Pre-commit verification of Milestone 1

### Prompt

Abridged.

> Do one final verification pass only. Do NOT start Milestone 2. Show the exact `git status` and
> file list; confirm `.env` is ignored and not tracked while `.env.example` is; confirm no hardcoded
> secrets in committed files. Inspect the database role/privilege situation around `loan_events`:
> confirm the application user cannot UPDATE or DELETE it; determine whether that user has TRUNCATE
> privilege; if it does, remove that privilege if practical and safe; keep the existing append-only
> trigger; do not weaken the normal append-only guarantee just to make tests easier. Verify the
> timestamp fix is implemented consistently and do not remove or weaken the chronology constraint.
> Re-run the full verification and report the actual final results.

### What I got

The privilege question turned out to have a harder answer than "revoke it". Measuring first showed
why: the bootstrap role `lending` is both the **table owner and a SUPERUSER**, and a superuser
bypasses every privilege check. `REVOKE TRUNCATE ... FROM lending` would have executed successfully
and changed nothing — the worst kind of security control, one that reports success while doing
nothing.

So the fix was a second role rather than a revoke:

- `lending` — owner and superuser. Runs migrations, the seed and the test reset. Never serves a
  request.
- `lending_app` — what the running application connects as. `SELECT` and `INSERT` on `loan_events`,
  nothing else; no `TRUNCATE` on any table.

That produces two independent guarantees that cover each other's gap: the trigger stops `UPDATE` and
`DELETE` for **every** role including the owner, and the missing privilege stops the application from
attempting `UPDATE`, `DELETE` **or** `TRUNCATE` — which the trigger cannot cover, because `TRUNCATE`
does not fire row-level triggers.

### What I corrected

- **The test suite was relying on the privilege I was removing.** It truncated `loan_events` between
  tests. Rather than grant the privilege back to make tests convenient, the reset now runs on the
  owner connection while the application under test keeps the restricted role — so the tests exercise
  the real production posture instead of a relaxed one.
- **The append-only tests were rewritten to prove both mechanisms separately**, because they fail
  differently: `42501 permission denied` as the application role, `23001` from the trigger as the
  owner. A single test could not have shown both.
- **The migration scripts broke and that was correct.** `prisma migrate deploy` started failing with
  `permission denied for table _prisma_migrations` because it was still connecting as the
  application role, which now has no DDL rights. Fixed with a small wrapper
  (`scripts/prisma-admin.mjs`) that substitutes the admin URL, which also let me drop the
  `dotenv-cli` dependency added earlier.
- **The single-clock rule was made real rather than described.** The seed now derives every timestamp
  from one `NOW` captured at start; `new Date()` appears exactly once in the file. Previously the
  date helper called `new Date()` per invocation, which was latent inconsistency even though it had
  not yet produced a wrong row.

### Lesson

Verify the control, do not assume it. Had I written the `REVOKE` without first checking `rolsuper`,
I would have committed a privilege restriction that was pure theatre — and, worse, documented it as
a guarantee. The check that mattered was one query: `SELECT rolname, rolsuper FROM pg_roles`.

The related lesson is that the test suite depending on a privilege was a signal, not an obstacle.
The tempting fix — grant `TRUNCATE` back so the tests stay simple — would have quietly removed the
guarantee the tests exist to prove.

---

## 4. Milestone 2 — authentication, role guards and the authorization matrix

### Prompt

Two prompts. First, a planning one:

> Proceed to Milestone 2: authentication, role guards, and the authorization matrix. Before writing
> application code, first inspect the existing Milestone 1 implementation and the assignment
> requirements. Then give me a concise implementation plan for Milestone 2 and STOP for review.
> [...] Members must not be able to obtain librarian capabilities by manipulating request parameters,
> IDs, or frontend state. [...] Do not over-engineer. Do not add OAuth, JWT, registration, email
> verification, password reset, MFA, rate limiting, or external identity providers unless the
> assignment actually requires them.

Then, after review, an approval that settled the open questions — database-backed sessions, keep the
HMAC, catalogue read for both roles, dashboard and export librarian-only, sessions granted
`SELECT, INSERT, DELETE` and nothing more.

### What I got

The plan surfaced a conflict I had not noticed when writing the Phase 1 architecture: **Phase 1 chose
stateless JWTs, and this milestone requires "logout invalidates the session".** A stateless token
cannot be revoked — logout can clear the browser's cookie, but the token stays valid until it
expires. That is a genuine contradiction between my own earlier plan and the requirement, and it
became the reversal now recorded as Decision 5 in `docs/decisions.md`.

Implementation went to plan: a `sessions` table, opaque random tokens with only the HMAC stored, a
capability matrix as data, guards that read identity solely from the session, and ownership handled
separately from role.

### What went wrong

Four things, three of which were near-misses rather than visible failures.

1. **A migration that was not replayable.** `prisma migrate dev` failed with "The underlying table
   for model `_prisma_migrations` does not exist". The cause was in Milestone 1's least-privilege
   migration, which does `REVOKE ALL ON _prisma_migrations` — fine against a real database, but
   `migrate dev` replays migrations into a *shadow* database that has no such table, so the whole
   command aborted. I confirmed the migrations still replay cleanly under `migrate deploy` on a fresh
   database before touching anything, then guarded the statement with a `to_regclass` existence
   check. Committed migrations are normally untouchable, so I verified Prisma's checksum algorithm
   (plain SHA-256 of the file) and updated the recorded checksum rather than destroying the
   development database.

2. **Prisma tried to silently undo an earlier fix.** The generated `sessions` migration also
   contained `ALTER TABLE ... ALTER COLUMN "updated_at" DROP DEFAULT` for two unrelated tables —
   Prisma "correcting" drift, because the database default added in Milestone 1 was not declared in
   `schema.prisma`. Deleting those two lines would have fixed this migration and left the trap armed
   for the next one. I declared `@default(now())` alongside `@updatedAt` in the schema instead, so
   Prisma stops seeing drift at all, and regenerated.

3. **Wrong Express types since Milestone 1.** I had installed `@types/express@5` against
   `express@4`. It surfaced as a type error on `req.params`, and pinning the types to v4 then exposed
   a second conflict: `@types/cookie-parser` pulls in the v5 types, so the middleware stack would not
   typecheck. Rather than pin transitive type versions across the tree, I dropped `cookie-parser` for
   a ten-line cookie reader — which is why a dependency visible in the git history is absent from the
   final `package.json` (Decision 7).

4. **Two failing tests, one of which was a good failure.** The expiry test tried to `UPDATE` a
   session row through the application's database connection and got `42501 permission denied` —
   because the migration deliberately grants `SELECT, INSERT, DELETE` and no `UPDATE`. The privilege
   model was right and the test was wrong. I moved that write to the owner connection rather than
   granting `UPDATE` to make the test convenient. The other failure was an ordinary fixture mistake.

Final state: 58 tests passing, both workspaces typechecking, live authentication verified against the
real database.

### Lesson

The valuable failure here was the one where the code refused to do what the test asked. It would have
taken one word in a migration to make that test pass — grant `UPDATE` — and the privilege model would
have been quietly weakened to suit a test that had no business updating a session row. Test
convenience is a bad reason to widen a permission, and the same instinct is what turns "members can
see their loans" into "members can see all loans".

The near-misses share a shape too: two of them (the `DROP DEFAULT`, the type mismatch) were tools
confidently offering to undo earlier work. Reading generated migrations before applying them is not
optional.

---

## 5. Milestone 3 — catalogue CRUD, archive/restore and custodians

### Prompt

Planning first, again — the pattern that has worked best so far:

> Proceed to Milestone 3 planning only. Scope: catalogue CRUD; archive/restore; many-to-many
> custodians; corresponding server-side authorization and integration tests. Do NOT implement
> anything yet. First inspect the existing code/schema/auth architecture and the assignment
> requirements, then produce a concrete implementation plan and STOP for my review. [...] Think
> carefully about whether archive/restore should be idempotent or return a conflict when already
> archived/restored, and explain the choice. [...] Do not over-engineer search. No trigram/full-text
> infrastructure unless there is an actual requirement.

Then an approval that pinned down the decisions, with one addition worth quoting because it shaped a
test:

> IMPORTANT TEST: If the submitted librarianIds contains an invalid/non-librarian ID, the API must
> return 400 and the item's existing custodian set must remain completely unchanged. Prove this with
> an integration test.

### What I got

The most useful outcome of the planning step was discovering there was **nothing to build in the
database**. Inspecting the schema before proposing changes showed Milestone 1 had already created
everything this milestone needed: `archived_at` as a nullable timestamp, the composite primary key on
`item_custodians` that makes a duplicate link impossible, `ON DELETE CASCADE` from items to the join
table, and indexes on `archived_at` and `category`. So Milestone 3 ships **no migration at all**,
which is the right answer and one I would have missed by planning less carefully.

Two design questions were worth the time:

- **Archive/restore returns 409 when the item is already in that state**, rather than being
  idempotent. The system already promises that an illegal state transition explains itself; archive
  is a state transition, and in a tool where several librarians act on the same catalogue, silently
  agreeing with a click made against stale state is worse than a clear conflict. Implemented as a
  conditional `UPDATE ... WHERE archived_at IS NULL` so two concurrent archives cannot both win.
- **Custodians are replaced as a set, and that is idempotent** — the opposite contract. The
  distinction is that set membership ("ensure X is a custodian") carries no information when
  repeated, while a lifecycle transition does. Both are in `decisions.md` with that reasoning.

### What went wrong

Less than in previous milestones, and nothing that reached the test run.

The one thing I wrote badly and rewrote before running anything: the first version of
`replaceCustodians` handled "empty set" by passing a sentinel UUID into a `notIn` clause, so that
`deleteMany` would match everything. It worked, and it was the kind of clever-looking line that a
reader has to stop and decode. Replaced with an explicit branch — delete all when the set is empty,
delete the complement otherwise.

The genuinely valuable part was the test the approval insisted on. Validating custodian ids *before*
touching the existing set is easy to get wrong in a way no ordinary test catches: the natural
implementation is delete-then-insert inside a transaction, which looks correct because the
transaction rolls back — but only if the failure happens inside it. Validating first, outside the
write, and asserting afterwards that the original two custodians are still there, is a much stronger
guarantee than trusting rollback semantics.

Final state: 106 tests passing plus one explicit `todo`, both workspaces typechecking, and the
catalogue and custodian endpoints verified live against real Postgres.

### The test I deliberately did not write

"An archived item cannot receive a new loan" is a Milestone 6 rule. Writing a loan endpoint now, just
so this milestone had something to assert against, would have manufactured coverage for functionality
that does not exist. Instead the test file carries an `it.todo` naming the exact Milestone 6 test,
and this milestone proves the part it actually owns: `isArchived` and `archivedAt` are exposed
correctly, and archiving leaves existing loans byte-for-byte untouched — which *is* testable now, by
seeding loans through Prisma rather than through an endpoint that has not been built.

### Lesson

Inspecting before planning paid for itself twice: once by avoiding a migration that would have been
pure churn, and once by finding that the composite primary key I needed already existed. The habit
worth keeping is treating "what does the schema already do?" as a question to answer with a query,
not from memory of having written it two sessions ago.

---

## Not yet written

Milestones 4 onward. This file is appended to as each one lands.
