-- Least-privilege application role.
--
-- The bootstrap role (`lending`) is a SUPERUSER and owns every table, so it
-- bypasses privilege checks entirely — REVOKE against it is cosmetic. Splitting
-- the roles is the only way to make a privilege actually absent:
--
--   lending      owner/superuser. Runs migrations, the seed, and the test
--                harness reset. Never used to serve a request.
--   lending_app  what the running application connects as. Can read and write
--                the working tables, and can only INSERT into loan_events.
--
-- Combined with the append-only trigger this gives two independent guarantees:
-- the trigger stops an UPDATE or DELETE from anyone including the owner, and
-- the missing privilege stops the application from even attempting one — and
-- also closes the TRUNCATE hole, which the trigger cannot cover because
-- TRUNCATE does not fire row-level triggers.

CREATE ROLE lending_app LOGIN PASSWORD 'lending_app_dev_password';

\connect lending_library

GRANT CONNECT ON DATABASE lending_library TO lending_app;
GRANT USAGE ON SCHEMA public TO lending_app;

-- Tables created later by migrations are granted automatically. TRUNCATE is
-- deliberately absent from this list: the application never needs it.
ALTER DEFAULT PRIVILEGES FOR ROLE lending IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO lending_app;
ALTER DEFAULT PRIVILEGES FOR ROLE lending IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO lending_app;

\connect lending_library_test

GRANT CONNECT ON DATABASE lending_library_test TO lending_app;
GRANT USAGE ON SCHEMA public TO lending_app;

ALTER DEFAULT PRIVILEGES FOR ROLE lending IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO lending_app;
ALTER DEFAULT PRIVILEGES FOR ROLE lending IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO lending_app;
