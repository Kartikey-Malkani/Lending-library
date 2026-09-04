-- Make the append-only rule a privilege, not only a trigger.
--
-- The trigger on loan_events rejects UPDATE and DELETE for every role, owner
-- included. It cannot cover TRUNCATE, because TRUNCATE does not fire row-level
-- triggers. Removing the privilege from the application role closes that gap
-- and means the running application cannot even attempt a rewrite.
--
-- Guarded by a role-existence check so this migration is a no-op on a database
-- that has no separate application role — a managed host that only issues one
-- role still migrates cleanly, it just relies on the trigger alone. The
-- deployment notes say which posture is in effect.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'lending_app') THEN
    -- Tables that already existed before the role did are not covered by
    -- ALTER DEFAULT PRIVILEGES, so grant them explicitly.
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO lending_app;
    GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO lending_app;

    -- The application never truncates anything.
    REVOKE TRUNCATE ON ALL TABLES IN SCHEMA public FROM lending_app;

    -- History is append-only: read it, add to it, nothing else.
    REVOKE UPDATE, DELETE, TRUNCATE ON loan_events FROM lending_app;

    -- Prisma's migration bookkeeping is not the application's business.
    REVOKE ALL ON _prisma_migrations FROM lending_app;
  END IF;
END $$;
