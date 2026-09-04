-- The integration tests run against a real Postgres, not a mock, so they need
-- their own database to truncate freely without destroying dev data.
CREATE DATABASE lending_library_test OWNER lending;
