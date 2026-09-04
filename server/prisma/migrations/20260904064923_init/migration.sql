-- CreateEnum
CREATE TYPE "role" AS ENUM ('librarian', 'member');

-- CreateEnum
CREATE TYPE "loan_status" AS ENUM ('requested', 'issued', 'returned', 'lost');

-- CreateEnum
CREATE TYPE "loan_event_type" AS ENUM ('requested', 'issued', 'returned', 'lost');

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "email" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "role" "role" NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "catalogue_items" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "title" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "archived_at" TIMESTAMPTZ(3),
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "catalogue_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "loans" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "item_id" UUID NOT NULL,
    "borrower_id" UUID NOT NULL,
    "status" "loan_status" NOT NULL,
    "requested_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "issued_at" TIMESTAMPTZ(3),
    "due_on" DATE,
    "returned_at" TIMESTAMPTZ(3),
    "lost_at" TIMESTAMPTZ(3),
    "issued_by" UUID,
    "returned_by" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "loans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "loan_events" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "loan_id" UUID NOT NULL,
    "type" "loan_event_type" NOT NULL,
    "actor_id" UUID NOT NULL,
    "note" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "loan_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "item_custodians" (
    "item_id" UUID NOT NULL,
    "librarian_id" UUID NOT NULL,
    "assigned_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "assigned_by" UUID,

    CONSTRAINT "item_custodians_pkey" PRIMARY KEY ("item_id","librarian_id")
);

-- CreateTable
CREATE TABLE "alert_dismissals" (
    "loan_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "dismissed_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "alert_dismissals_pkey" PRIMARY KEY ("loan_id","user_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE INDEX "users_role_idx" ON "users"("role");

-- CreateIndex
CREATE UNIQUE INDEX "catalogue_items_code_key" ON "catalogue_items"("code");

-- CreateIndex
CREATE INDEX "catalogue_items_archived_at_idx" ON "catalogue_items"("archived_at");

-- CreateIndex
CREATE INDEX "catalogue_items_category_idx" ON "catalogue_items"("category");

-- CreateIndex
CREATE INDEX "loans_borrower_id_idx" ON "loans"("borrower_id");

-- CreateIndex
CREATE INDEX "loans_status_idx" ON "loans"("status");

-- CreateIndex
CREATE INDEX "loans_due_on_idx" ON "loans"("due_on");

-- CreateIndex
CREATE INDEX "loans_requested_at_idx" ON "loans"("requested_at");

-- CreateIndex
CREATE INDEX "loans_item_id_requested_at_idx" ON "loans"("item_id", "requested_at");

-- CreateIndex
CREATE INDEX "loans_status_due_on_idx" ON "loans"("status", "due_on");

-- CreateIndex
CREATE INDEX "loan_events_loan_id_created_at_idx" ON "loan_events"("loan_id", "created_at");

-- CreateIndex
CREATE INDEX "item_custodians_librarian_id_idx" ON "item_custodians"("librarian_id");

-- AddForeignKey
ALTER TABLE "catalogue_items" ADD CONSTRAINT "catalogue_items_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "loans" ADD CONSTRAINT "loans_item_id_fkey" FOREIGN KEY ("item_id") REFERENCES "catalogue_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "loans" ADD CONSTRAINT "loans_borrower_id_fkey" FOREIGN KEY ("borrower_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "loans" ADD CONSTRAINT "loans_issued_by_fkey" FOREIGN KEY ("issued_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "loans" ADD CONSTRAINT "loans_returned_by_fkey" FOREIGN KEY ("returned_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "loan_events" ADD CONSTRAINT "loan_events_loan_id_fkey" FOREIGN KEY ("loan_id") REFERENCES "loans"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "loan_events" ADD CONSTRAINT "loan_events_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "item_custodians" ADD CONSTRAINT "item_custodians_item_id_fkey" FOREIGN KEY ("item_id") REFERENCES "catalogue_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "item_custodians" ADD CONSTRAINT "item_custodians_librarian_id_fkey" FOREIGN KEY ("librarian_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "item_custodians" ADD CONSTRAINT "item_custodians_assigned_by_fkey" FOREIGN KEY ("assigned_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "alert_dismissals" ADD CONSTRAINT "alert_dismissals_loan_id_fkey" FOREIGN KEY ("loan_id") REFERENCES "loans"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "alert_dismissals" ADD CONSTRAINT "alert_dismissals_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ===========================================================================
-- Everything below is hand-written. Prisma cannot express CHECK constraints,
-- partial indexes or triggers in schema.prisma, and these are the rules that
-- have to hold regardless of which code path writes the row.
-- ===========================================================================

-- --- Catalogue items: no blank required text -------------------------------

ALTER TABLE "catalogue_items"
  ADD CONSTRAINT "catalogue_items_title_not_blank_chk" CHECK (length(btrim(title)) > 0);

ALTER TABLE "catalogue_items"
  ADD CONSTRAINT "catalogue_items_category_not_blank_chk" CHECK (length(btrim(category)) > 0);

ALTER TABLE "catalogue_items"
  ADD CONSTRAINT "catalogue_items_code_not_blank_chk" CHECK (length(btrim(code)) > 0);

-- --- Loans: state and timestamp coherence ----------------------------------
--
-- A loan's status and its timestamps are two views of the same fact, so they
-- are not allowed to disagree. Note what is NOT here: there is no `overdue`
-- status, because the loan_status enum has no such member. Overdue is derived
-- at read time as (status = 'issued' AND due_on < current_date), which is why
-- an attempt to store it fails at the type level rather than being silently
-- accepted.

-- A requested loan has not been acted on yet: no due date, no issuer, nothing.
ALTER TABLE "loans" ADD CONSTRAINT "loans_requested_state_chk" CHECK (
  status <> 'requested' OR (
    issued_at IS NULL AND due_on IS NULL AND returned_at IS NULL
    AND lost_at IS NULL AND issued_by IS NULL AND returned_by IS NULL
  )
);

-- An issued loan has been handed over and has a due date; it is still open.
ALTER TABLE "loans" ADD CONSTRAINT "loans_issued_state_chk" CHECK (
  status <> 'issued' OR (
    issued_at IS NOT NULL AND due_on IS NOT NULL
    AND returned_at IS NULL AND lost_at IS NULL
  )
);

-- A returned loan must have been issued first, and cannot also be lost.
ALTER TABLE "loans" ADD CONSTRAINT "loans_returned_state_chk" CHECK (
  status <> 'returned' OR (
    issued_at IS NOT NULL AND due_on IS NOT NULL
    AND returned_at IS NOT NULL AND lost_at IS NULL
  )
);

-- A lost loan must have been issued first, and cannot also be returned.
ALTER TABLE "loans" ADD CONSTRAINT "loans_lost_state_chk" CHECK (
  status <> 'lost' OR (
    issued_at IS NOT NULL AND due_on IS NOT NULL
    AND lost_at IS NOT NULL AND returned_at IS NULL
  )
);

-- Events cannot precede their causes.
ALTER TABLE "loans" ADD CONSTRAINT "loans_chronology_chk" CHECK (
  (issued_at IS NULL OR issued_at >= requested_at)
  AND (returned_at IS NULL OR returned_at >= issued_at)
  AND (lost_at IS NULL OR lost_at >= issued_at)
);

-- --- Loans: at most one OPEN loan per catalogue item -----------------------
--
-- The brief requires the server to refuse issuing an item that already has an
-- open loan against it, where open means Requested or Issued.
--
-- An application-level "does an open loan exist?" check is correct in a demo
-- and wrong under concurrency: two simultaneous requests both read "none" and
-- both insert. A partial unique index makes the second insert fail no matter
-- how the two transactions interleave, so the rule is a property of the data
-- rather than a property of one code path remembering to ask.
CREATE UNIQUE INDEX "loans_one_open_per_item_idx"
  ON "loans" ("item_id")
  WHERE status IN ('requested', 'issued');

-- --- Loan events: append-only ----------------------------------------------
--
-- The brief says nothing in a loan's timeline can be edited or deleted after
-- the fact, "including by librarians". Not shipping an edit endpoint is a
-- design choice; this trigger is a guarantee, and it holds against a stray
-- migration, a future code path, or someone at a psql prompt.
--
-- Known limit, stated rather than glossed over: TRUNCATE does not fire
-- row-level triggers, so a role with TRUNCATE privilege on the table can still
-- clear it. The integration test suite relies on exactly that to reset between
-- tests. In production the application's database role should not hold that
-- privilege.
CREATE OR REPLACE FUNCTION reject_loan_event_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION
    'loan_events is append-only; % is not permitted', TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "loan_events_append_only"
  BEFORE UPDATE OR DELETE ON "loan_events"
  FOR EACH ROW EXECUTE FUNCTION reject_loan_event_mutation();
