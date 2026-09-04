-- Give `updated_at` a database default.
--
-- Prisma maintains this column from the client (`@updatedAt`), so the generated
-- DDL leaves it with no default. Any INSERT that does not go through Prisma
-- then fails with a not-null violation instead of whatever rule was actually
-- being exercised — which is misleading in tests and would bite the CSV import
-- path later.
--
-- Found while writing the database invariant tests: raw INSERTs meant to prove
-- a CHECK constraint were being rejected for the wrong reason.
ALTER TABLE "loans" ALTER COLUMN "updated_at" SET DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE "catalogue_items" ALTER COLUMN "updated_at" SET DEFAULT CURRENT_TIMESTAMP;
