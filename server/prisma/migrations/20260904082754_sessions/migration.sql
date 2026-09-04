-- CreateTable
CREATE TABLE "sessions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "sessions_token_hash_key" ON "sessions"("token_hash");

-- CreateIndex
CREATE INDEX "sessions_user_id_idx" ON "sessions"("user_id");

-- CreateIndex
CREATE INDEX "sessions_expires_at_idx" ON "sessions"("expires_at");

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Privileges for the application role on sessions.
--
-- SELECT, INSERT and DELETE are what the implementation actually uses: look a
-- session up, create one at login, delete it at logout or when it has expired.
-- UPDATE is not granted because nothing updates a session row — sessions are
-- created and destroyed, never mutated — and TRUNCATE is never granted to the
-- application on any table.
--
-- Guarded on role existence so a host that issues only one database role still
-- migrates cleanly.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'lending_app') THEN
    GRANT SELECT, INSERT, DELETE ON sessions TO lending_app;
    REVOKE UPDATE, TRUNCATE ON sessions FROM lending_app;
  END IF;
END $$;
