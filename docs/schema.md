# Schema

This file grows as the schema does. The table-by-table column listing, the one-to-many versus
many-to-many breakdown, and the database-versus-application constraint boundary are written up in the
final documentation pass; what is recorded here as each milestone lands are the decisions and
tradeoffs that would otherwise be forgotten.

Still to write: the full table/column reference, and the constraint-boundary rationale (the short
version, already visible in the migrations: invariants that must survive concurrency or tampering
live in the database — the partial unique index, the state and chronology CHECKs, the append-only
trigger — while anything needing context or a human-readable reason lives in the service layer).

---

## Indexes and what they serve

*(Written as milestones land; this section grows with the schema rather than being reconstructed.)*

| Index | Serves |
|---|---|
| `loans_one_open_per_item_idx` — partial UNIQUE on `(item_id) WHERE status IN ('requested','issued')` | the one-open-loan-per-item invariant, under concurrency |
| `loans_status_due_on_idx` — `(status, due_on)` | overdue lookups: `status = 'issued' AND due_on < today`, behind the loans list filter, and later the alerts badge and dashboard |
| `loans_status_idx`, `loans_due_on_idx`, `loans_requested_at_idx` | the loans list's three sort keys and the status filter |
| `loans_borrower_id_idx` | member scoping, and the librarian's borrower filter |
| `loans_item_id_requested_at_idx` | an item's loan history, newest first |
| `catalogue_items_archived_at_idx`, `catalogue_items_category_idx` | the catalogue's default archived filter and category filter |
| `item_custodians` PK `(item_id, librarian_id)` + `librarian_id` index | duplicate custodian links made impossible; "items I am custodian for" |

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

