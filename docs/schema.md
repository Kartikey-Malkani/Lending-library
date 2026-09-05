# Schema

Seven tables, three enums, and a deliberate split between what the database guarantees and what the
service layer guarantees. Written for someone trying to understand the data model, not as a
transcription of `schema.prisma` — the Prisma file is the source of truth for column types, and this
is the reasoning around them.

All identifiers are `uuid` with `gen_random_uuid()` defaults. All timestamps are `timestamptz(3)`
except `loans.due_on`, which is a `date` on purpose. Column names are `snake_case` in the database
and camelCase in the client.

---

## The constraint boundary

The single most important thing about this schema is where each rule lives.

**The database guarantees** — invariants that must hold under concurrency, regardless of which code
path writes the row, and against someone at a `psql` prompt:

| Guarantee | Mechanism |
|---|---|
| At most one open loan per item | partial unique index `loans_one_open_per_item_idx` |
| A loan's timestamps match its status | four CHECK constraints, one per state |
| No event precedes its cause | `loans_chronology_chk` |
| Timeline rows are never changed or removed | `loan_events_append_only` trigger **and** the absence of UPDATE/DELETE grants |
| `overdue` can never be stored as a status | the `loan_status` enum has no such member |
| Unique item codes and user emails | unique indexes |
| A custodian cannot be linked twice to one item | composite primary key |
| One dismissal per (loan, librarian) | composite primary key |
| Titles, categories and codes are not blank | CHECK constraints on trimmed length |
| Referential integrity | foreign keys, mostly `ON DELETE RESTRICT` |

**The service layer guarantees** — rules that need context, a human-readable reason, or a decision the
database has no opinion about:

- which transitions are legal, and the message explaining a refusal
- who may do what (the capability matrix), and who owns which loan
- case normalisation: emails lower-cased, item codes upper-cased before writing
- that every loan state change writes its timeline event, in the same transaction
- input shape, size limits, and the whitelists for sort keys and filters

**Derived, never stored:**

- `isOverdue` — `status = 'issued' AND due_on < today`, computed on every read
- alerts — an overdue loan this librarian has not dismissed; there is no alerts table
- every dashboard figure — aggregates computed per request against one `asOf`
- `daysOverdue` — computed at read time from `due_on`

The reason for the split: a rule enforced only in application code holds until the second code path
forgets to ask. A rule in the database holds for every path, including ones that do not exist yet.

---

## Enums

| Enum | Members | Notes |
|---|---|---|
| `role` | `librarian`, `member` | an unknown role is unstorable |
| `loan_status` | `requested`, `issued`, `returned`, `lost` | **declaration order is lifecycle order**, which gives "sort by status" a meaningful ordering for free; no `overdue` member, by design |
| `loan_event_type` | `requested`, `issued`, `returned`, `lost` | mirrors `loan_status` today but kept separate: the timeline records transitions, and the two diverge the moment a non-status event is recorded |

---

## Tables

### `users`

Accounts and roles. One table for both roles rather than separate tables, because a librarian is a
person who can also borrow — and does, in the seed data.

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `email` | text UNIQUE | stored lower-cased by the application, so a plain unique index gives case-insensitive uniqueness without the `citext` extension |
| `password_hash` | text | bcrypt; never leaves the server — `GET /api/users` selects four fields and this is not one |
| `name` | text | |
| `role` | `role` enum | |
| `created_at` | timestamptz | |

- **Index:** `role`, for the librarian/member filter on the directory.
- **Referenced by:** loans (borrower, issuer, returner), catalogue items (creator), loan events
  (actor), item custodians (librarian and assigner), alert dismissals, sessions.

### `sessions`

A signed-in session. Server-side by design, which is what makes logout mean something.

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `user_id` | uuid FK → users **ON DELETE CASCADE** | deleting a user ends their sessions |
| `token_hash` | text UNIQUE | `HMAC-SHA256(token, SESSION_SECRET)`. **The token itself is never stored**, so a database dump yields no usable sessions |
| `created_at` | timestamptz | |
| `expires_at` | timestamptz | checked on read; there is no sweeper |

- **Indexes:** `user_id`, `expires_at`.
- **Cardinality:** one user → many sessions (several devices).

### `catalogue_items`

The things that get lent.

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `title` | text | CHECK: not blank after trimming |
| `category` | text | CHECK: not blank after trimming |
| `code` | text UNIQUE | the brief's identifying code; upper-cased by the application. CHECK: not blank |
| `archived_at` | timestamptz NULL | **NULL means active.** A nullable timestamp rather than a boolean, because "when was this archived" costs nothing extra to keep |
| `created_by` | uuid FK → users, RESTRICT | |
| `created_at` / `updated_at` | timestamptz | both carry database defaults as well as Prisma's `@updatedAt` (see below) |

- **Indexes:** `archived_at` (the default "active only" filter), `category`.
- **Cardinality:** one item → many loans; one item ↔ many custodians.
- **Deliberate:** archiving is a soft state, not a delete. There is no delete endpoint at all — loans
  reference items with `ON DELETE RESTRICT`, so history cannot be orphaned by removing an item.

> **Why `updated_at` has a database default.** It originally had only Prisma's `@updatedAt`, which is
> maintained client-side. Raw SQL INSERTs in the constraint tests then failed with a not-null
> violation — meaning those tests were passing for the wrong reason. Migration 2 added the default,
> and the model declares `@default(now())` alongside `@updatedAt` so that `migrate dev` does not
> generate a `DROP DEFAULT` to "correct" the drift and quietly undo it.

### `loans`

The heart of the model. One row per loan, holding the whole lifecycle, rather than a row per state.

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `item_id` | uuid FK → catalogue_items, RESTRICT | |
| `borrower_id` | uuid FK → users, RESTRICT | |
| `status` | `loan_status` enum | |
| `requested_at` | timestamptz | |
| `issued_at` | timestamptz NULL | |
| `due_on` | **date** NULL | a calendar date, not a timestamp: "past its due date" is a calendar comparison, and this keeps time-of-day out of the most-read rule in the system |
| `returned_at` | timestamptz NULL | |
| `lost_at` | timestamptz NULL | |
| `issued_by` / `returned_by` | uuid NULL FK → users, RESTRICT | who acted, taken from the session |
| `created_at` / `updated_at` | timestamptz | |

**The partial unique index — the one to look at:**

```sql
CREATE UNIQUE INDEX loans_one_open_per_item_idx
  ON loans (item_id)
  WHERE status IN ('requested', 'issued');
```

An application-level "does an open loan exist?" check is correct in a demo and wrong under
concurrency: two simultaneous requests both read "none" and both insert. This index makes the second
insert fail however the transactions interleave, so the rule is a property of the data rather than a
property of one code path remembering to ask. It is `PARTIAL` because closed loans must be allowed to
accumulate — an item can be lent many times, just not twice at once.

**State coherence CHECKs**, one per status, each of the form "if the status is X, the timestamps must
look like X":

| Constraint | Requires |
|---|---|
| `loans_requested_state_chk` | no `issued_at`, `due_on`, `returned_at`, `lost_at`, `issued_by`, `returned_by` |
| `loans_issued_state_chk` | `issued_at` and `due_on` present; not returned; not lost |
| `loans_returned_state_chk` | issued first, `returned_at` present, `lost_at` null |
| `loans_lost_state_chk` | issued first, `lost_at` present, `returned_at` null |
| `loans_chronology_chk` | `issued_at ≥ requested_at`, `returned_at ≥ issued_at`, `lost_at ≥ issued_at` |

The chronology constraint has earned its place three times: it caught a clock-skew bug in M1 (the
application supplied `issued_at` from Node while `requested_at` came from the database clock — the
rule since then is that the application supplies all loan timestamps from one `now`), and two
incoherent test fixtures afterwards.

- **Indexes:** `borrower_id` (member scoping and the librarian's borrower filter); `status`, `due_on`,
  `requested_at` (the three sort keys); `(item_id, requested_at)` (an item's history, newest first);
  `(status, due_on)` (**the overdue lookup** behind the loans filter, the alerts list, the nav badge
  and the dashboard).
- **Cardinality:** many loans → one item, one borrower; one loan → many events, many dismissals.

### `loan_events`

The append-only timeline: what happened, who did it, when, and any note the librarian left.

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `loan_id` | uuid FK → loans, RESTRICT | |
| `type` | `loan_event_type` enum | |
| `actor_id` | uuid FK → users, RESTRICT | always from the session; nothing client-supplied |
| `note` | text NULL | optional — the brief says the timeline carries "any notes left by a librarian", so a note is never required, but one that *is* supplied must not be blank |
| `created_at` | timestamptz | |

**Append-only, enforced three ways:**

1. No endpoint exists to update or delete an event.
2. A `BEFORE UPDATE OR DELETE` trigger raises `restrict_violation`.
3. The runtime role `lending_app` holds **only SELECT and INSERT** on this table.

The third matters because of a limit worth stating plainly: `TRUNCATE` does not fire row-level
triggers, so a role holding TRUNCATE could still clear the table. That privilege is revoked from the
application role in production. The test suite does use TRUNCATE to reset between tests — as the
owner role, never as the application role.

- **Index:** `(loan_id, created_at)`.
- **Ordering:** reads use `(created_at, type, id)`. The `type` tiebreak is load-bearing — a direct
  issue writes `requested` and `issued` in one transaction at the same instant, and falling back to a
  random uuid returned the timeline backwards about half the time. Enum declaration order is
  lifecycle order, so comparing `type` compares lifecycle position.

### `item_custodians`

Many-to-many join: an item can have several custodians, and a librarian can look after many items.

| Column | Type | Notes |
|---|---|---|
| `item_id` | uuid FK → catalogue_items, **CASCADE** | |
| `librarian_id` | uuid FK → users, RESTRICT | |
| `assigned_at` | timestamptz | |
| `assigned_by` | uuid NULL FK → users, **SET NULL** | who assigned; nulled rather than blocking that user's deletion |

- **Primary key:** `(item_id, librarian_id)` — a duplicate link is impossible, which is what makes
  "replace the custodian set" idempotent.
- **Index:** `librarian_id`, for "every item I am custodian for".
- **Consequence, stated because the dashboard depends on it:** a loan on an item with two custodians
  counts once for *each* of them, so the per-custodian breakdown does not sum to the number of loans.
  That is the correct answer to "how many loans is each librarian responsible for", not a bug.
- **Deliberate:** custodianship is responsibility, not permission. Being a custodian does not restrict
  who may edit the item.

### `alert_dismissals`

One librarian dismissing one overdue alert.

| Column | Type | Notes |
|---|---|---|
| `loan_id` | uuid FK → loans, **CASCADE** | |
| `user_id` | uuid FK → users, **CASCADE** | |
| `dismissed_at` | timestamptz | |

- **Primary key:** `(loan_id, user_id)`, which makes repeat dismissal idempotent via
  `ON CONFLICT DO NOTHING`.
- **Both halves of that key are load-bearing:**
  - `loan_id`, not `item_id`, is the entire mechanism behind the brief's rule that the alert returns
    if the item is issued again and goes overdue on the new loan. A later issue is a *new loan row*,
    so no dismissal exists for it. Keying on the item instead would suppress the alert forever while
    looking identical in a demo.
  - `user_id` stops one librarian silently hiding an overdue item from the rest of the team, and
    makes the navigation badge belong to its viewer.

### `_prisma_migrations`

Prisma's own bookkeeping. Access is revoked from the application role.

---

## Indexes and what they serve

| Index | Serves |
|---|---|
| `loans_one_open_per_item_idx` — partial UNIQUE on `(item_id) WHERE status IN ('requested','issued')` | the one-open-loan-per-item invariant, under concurrency |
| `loans_status_due_on_idx` — `(status, due_on)` | overdue lookups: `status = 'issued' AND due_on < today`, behind the loans list filter, the alerts badge and the dashboard |
| `loans_status_idx`, `loans_due_on_idx`, `loans_requested_at_idx` | the loans list's three sort keys and the status filter |
| `loans_borrower_id_idx` | member scoping, and the librarian's borrower filter |
| `loans_item_id_requested_at_idx` | an item's loan history, newest first |
| `catalogue_items_archived_at_idx`, `catalogue_items_category_idx` | the catalogue's default archived filter and category filter |
| `item_custodians` PK `(item_id, librarian_id)` + `librarian_id` index | duplicate custodian links made impossible; "items I am custodian for" |
| `sessions_token_hash_key`, `sessions_user_id_idx`, `sessions_expires_at_idx` | session lookup on every authenticated request |

## A deliberate tradeoff: text search is not index-backed

Both list endpoints search with case-insensitive `ILIKE '%term%'`:

- the catalogue over `title` and `code`
- the loans list over the joined `catalogue_items.title` and `users.name` / `users.email`

A leading wildcard cannot use a B-tree index, so these are sequential scans. That is a conscious
choice for an assignment at demo scale — a few dozen items and loans — not an oversight.

**What it would take to fix**, in order of when it would be worth doing:

1. `pg_trgm` with GIN indexes on the searched columns, which makes `ILIKE '%x%'` index-backed.
2. A generated `tsvector` column with a GIN index, if the requirement grew into real full-text
   search with stemming and ranking.

Neither is built, because at this size an index would be slower than the scan and would add
infrastructure the brief does not ask for.

## What would break first at 100x

1. The `COUNT(*)` behind every list's `total`, which scans the whole filtered set on every request.
2. The unindexed `ILIKE` searches above.
3. Deep offset pagination — `OFFSET 5000` still walks the rows it skips; keyset pagination on
   `(sort_key, id)` would be the fix, and the id tiebreak is already in place to support it.
4. The per-custodian dashboard breakdown, which fans out across the join table.
