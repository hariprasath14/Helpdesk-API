-- Runs once, when the local Postgres container is first created (docker compose up on an empty volume).
-- Creates the same three roles we use on Aurora, plus the dev and test databases.
-- Passwords here are for local development only; AWS credentials live in SSM / Secrets Manager.
--
--   helpdesk_migrator  owns the schema; runs migrations (DDL)
--   helpdesk_app       the running API and worker: read/write rows, no DDL, no BYPASSRLS
--   helpdesk_readonly  the reader connection: SELECT only, read-only transactions

CREATE ROLE helpdesk_migrator LOGIN PASSWORD 'migrator_local_only' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
CREATE ROLE helpdesk_app      LOGIN PASSWORD 'app_local_only'      NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
CREATE ROLE helpdesk_readonly LOGIN PASSWORD 'readonly_local_only' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;

ALTER ROLE helpdesk_readonly SET default_transaction_read_only = on;

CREATE DATABASE helpdesk      OWNER helpdesk_migrator;
CREATE DATABASE helpdesk_test OWNER helpdesk_migrator;
-- Stands in for a lagging Aurora reader in read-after-write tests: same schema, never receives writes.
CREATE DATABASE helpdesk_test_replica OWNER helpdesk_migrator;

-- Schema ownership and pg_stat_statements per database. Table grants for the app and readonly roles
-- are made by the first migration, so they work the same way on Aurora.
\connect helpdesk
ALTER SCHEMA public OWNER TO helpdesk_migrator;
REVOKE ALL ON SCHEMA public FROM PUBLIC;
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;

\connect helpdesk_test
ALTER SCHEMA public OWNER TO helpdesk_migrator;
REVOKE ALL ON SCHEMA public FROM PUBLIC;
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;

\connect helpdesk_test_replica
ALTER SCHEMA public OWNER TO helpdesk_migrator;
REVOKE ALL ON SCHEMA public FROM PUBLIC;
