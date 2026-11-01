# helpdesk-api

Backend for Helpdesk, a multi-tenant SaaS help desk. "Helpdesk" is a placeholder name, set in `src/product.ts` (rename steps: helpdesk-api `docs/BRANDING.md`). Fastify + TypeScript API and pg-boss background worker, sharing one codebase. Also holds the AWS infrastructure (CDK) and the architecture docs.

> Status: Step 0 in progress. S1 (backend base), S2 (database), S3 (test setup) and S4 (API contract) are built; the frontend and features come next. Sections fill in as each feature is built. This README is updated with every backend change.

Full technical design: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). Coding and security rules: [docs/ENGINEERING_STANDARDS.md](docs/ENGINEERING_STANDARDS.md). Release 1 steps and the done gate: [docs/BUILD_PLAN.md](docs/BUILD_PLAN.md). The frontend lives in the separate `helpdesk-web` repository.

## Tech stack

TypeScript · Fastify · Socket.IO · pg-boss · PostgreSQL · Sequelize · Zod + OpenAPI · Stripe · Docker · AWS CDK

## Run locally

Prerequisites: Node.js 24 (LTS; `nvm use 24`), Docker Desktop.

```bash
nvm use                     # picks Node 24 from .nvmrc
cp .env.example .env        # local defaults work as they are
npm install                 # also installs the Git hooks
docker compose up -d        # PostgreSQL 16 + Mailpit (first run creates the roles and databases)
npm run db:migrate          # bring the schema up to date
npm run db:seed             # demo data (none yet)
npm run dev                 # API on http://localhost:4000 (restarts on file changes)
npm run worker              # background worker (separate terminal)
```

`docker compose down` stops the containers and keeps the data; `docker compose down -v` also deletes the database, so the next `up` starts fresh.

| Service                             | URL                             |
| ----------------------------------- | ------------------------------- |
| API health check                    | http://localhost:4000/health    |
| API docs (interactive)              | http://localhost:4000/docs      |
| OpenAPI spec (used by helpdesk-web) | http://localhost:4000/docs/json |
| Mailpit (test inbox)                | http://localhost:8025           |
| Sign-up (through helpdesk-web)      | http://localhost:5173/signup    |

### Scripts

| Script                               | Does                                                                                                    |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| `npm run dev` / `npm run worker`     | Run the API or worker from source with `.env`, restarting on changes                                    |
| `npm run build`                      | Compile TypeScript to `dist/` (tests excluded)                                                          |
| `npm start` / `npm run start:worker` | Run the compiled API or worker (used in the Docker image)                                               |
| `npm run db:migrate`                 | Apply pending migrations (`db:migrate:down` undoes the last one, `db:migrate:status` lists them)        |
| `npm run db:seed`                    | Run pending seed files (local and demo data only)                                                       |
| `npm run openapi`                    | Regenerate `openapi.json` from the route schemas; commit it with the change                             |
| `npm test`                           | Run all tests once against the test databases (Docker must be running); `test:watch` keeps watching     |
| `npm run test:coverage`              | Tests plus a coverage report; fails if coverage drops below the minimums                                |
| `npm run lint` / `lint:fix`          | ESLint with TypeScript strict and security rules                                                        |
| `npm run typecheck`                  | TypeScript check without building                                                                       |
| `npm run format` / `format:check`    | Prettier                                                                                                |
| `npm run audit`                      | Fail on high or critical vulnerabilities in production dependencies                                     |
| `npm run check`                      | Everything in one go: format, lint, types, tests with coverage minimums, audit (the pipeline runs this) |

### Git hooks

Installed automatically by `npm install` (Husky):

- **pre-commit:** ESLint and Prettier fix the staged files, then the type check runs.
- **commit-msg:** the message must follow Conventional Commits, for example `feat: add ticket list filters` or `fix: keep reply in thread`.

Secret scanning (gitleaks) and Semgrep run in Bitbucket Pipelines from Step 0b.

## Folder structure

```
src/
├── server.ts    entry point: API + Socket.IO (listens, shuts down cleanly on SIGTERM)
├── worker.ts    entry point: background jobs
├── app.ts       builds the Fastify app (used by server.ts and by tests)
├── config/      environment variable loading and validation
├── modules/     one folder per feature: routes, service, models, schemas, tests (accounts, audit, custom-fields, …)
├── jobs/        background job handlers
├── adapters/    email (smtp, ses), storage (local, s3), payments (stripe)
├── plugins/     auth, tenancy, permissions, rate limiting, security headers, error handler
├── lib/         small shared helpers: typed errors, shared response schemas, logger settings, OpenAPI tidy-up
├── db/          connections (index.ts), workspace transactions (tenant.ts), RLS helpers (rls.ts),
│                migration runner (migrator.ts, migrate.ts), migrations/, seeders/
├── test/        test helpers: test app and databases, fixtures, tenant-isolation and read-after-write checks
├── openapi.ts   builds the OpenAPI spec (used by `npm run openapi` and the spec test)
└── openapi-export.ts  writes openapi.json
openapi.json     the committed API contract that helpdesk-web generates its client from
docker/          local Postgres first-run script (roles and databases)
Dockerfile       the one image for the API and the worker (every environment)
deploy/dev-lightsail/  TEMPORARY dev server (no budget yet): Compose, Caddy, setup, deploy, certificate and backup scripts
infra/           AWS CDK app (all stacks; config/dev.ts and config/prod.ts)
docs/            ARCHITECTURE.md
```

## Backend flows

### Request lifecycle

1. **Security plugins:** security headers, rate limiting, CSRF check on state-changing requests.
2. **Tenancy:** resolve the workspace from the subdomain.
3. **Auth:** load the session from the cookie; reject if missing or expired.
4. **Membership and role:** confirm the user belongs to this workspace; load their role.
5. **Validation:** check the request body and query against the Zod schema.
6. **Database transaction:** `SET LOCAL app.workspace_id` so PostgreSQL row-level security applies.
7. **Permission check, then the module's service logic.**
8. **Audit log** entry for tracked changes (from F5, in the same transaction); Socket.IO event for live updates; background jobs queued if needed.

Built so far: steps 1 to 5 for the endpoints that exist (S1, F1), plus request IDs and error handling:

- **Request ID:** every request gets a server-generated UUID, returned in the `x-request-id` header and on every log line (`reqId`). A client-sent ID is ignored.
- **Security headers (Helmet):** strict `Content-Security-Policy: default-src 'none'`, HSTS, `nosniff`, `no-referrer`, frame blocking.
- **CORS:** only origins listed in `CORS_ORIGINS` (exact match) get CORS headers; credentials (cookies) allowed for them.
- **Rate limit:** `RATE_LIMIT_MAX` requests per `RATE_LIMIT_WINDOW_MS` per client IP; `/health` is never limited. Over the limit: `429` with `Retry-After`.
- **Body limit:** `BODY_LIMIT_BYTES` (1 MB by default); larger bodies get `413`.
- **Same-origin check** (`src/plugins/same-origin.ts`, the first CSRF layer): `POST`, `PUT`, `PATCH` and `DELETE` get `403` when the browser marks the request cross-site (`Sec-Fetch-Site: cross-site`) or its `Origin` host differs from the request host. A CSRF token is added with F2 (login).
- **Workspace from the address:** the request host is compared with `APP_PUBLIC_URL`'s host: `localhost:5173` is the main address, `acme.localhost:5173` is workspace `acme`. Workspace endpoints answer `404` for an unknown or unconfirmed workspace.
- **Session:** the `helpdesk_session` cookie (`HttpOnly`, `SameSite=Lax`, `Secure` from `COOKIE_SECURE`, host-only so the browser sends it only to that workspace's address). The database stores only a SHA-256 hash of the token. A session ends after `SESSION_IDLE_HOURS` without use or `SESSION_ABSOLUTE_DAYS` after sign-in, whichever comes first; `last_seen_at` is refreshed at most every 5 minutes. `requireSignedIn()` loads the session, the person and their membership (read under row-level security) or answers `401`.
- **CSRF token:** derived from the session secret (`sha256("csrf:" + token)`), so nothing extra is stored and it changes with the session. It is returned as `csrfToken` by `/me`, login, email confirmation and password change. Every signed-in POST, PUT, PATCH and DELETE must send it in `X-CSRF-Token`, or gets `403 CSRF_FAILED`.
- **Permissions:** each endpoint names the permission it needs (`requirePermission()`, from the member's role); otherwise `403 FORBIDDEN`. Sensitive admin actions also need a recently confirmed password (`403 REAUTH_REQUIRED`).
- **Two-step verification rule:** in a workspace that requires it, a member who has not set it up gets `403 TWO_FACTOR_SETUP_REQUIRED` everywhere except who-am-I and the setup itself.
- **Errors:** services throw typed errors (`ValidationError`, `UnauthorizedError`, `ForbiddenError`, `NotFoundError`, `ConflictError` in `src/lib/errors.ts`). Every error response has the shape `{ "error": { "code", "message", "details"? } }`. Unexpected errors return a generic `500 INTERNAL_ERROR`; the full error goes only to the logs.
- **Logs:** JSON lines (pino) with `service`, `version` and `reqId`. Cookies, authorization headers, CSRF tokens, passwords, tokens, secrets and 2FA codes are replaced with `[REDACTED]`.

### Health check

`GET /health` checks both database connections (`SELECT 1`, 2-second limit each):

- All fine: `200 {"status":"ok","version","uptimeSeconds","checks":{"databaseWriter":"ok","databaseReader":"ok"}}`
- Anything down: `503` with `"status":"error"` and the failing check marked `"error"`. The load balancer then replaces the task. Connection details never appear in the response.

Later steps add email and storage checks.

### Database

**One database per environment, three roles, two app connections:**

| Role                | Used by                               | Can                                                                 |
| ------------------- | ------------------------------------- | ------------------------------------------------------------------- |
| `helpdesk_migrator` | `npm run db:migrate` / `db:seed` only | Own and change the schema                                           |
| `helpdesk_app`      | `db.writer` (`DATABASE_URL`)          | Read and write rows; no schema changes; row-level security applies  |
| `helpdesk_readonly` | `db.reader` (`DATABASE_READ_URL`)     | Read rows only (read-only transactions); row-level security applies |

None of the roles is a superuser or can bypass row-level security. Locally, `docker/postgres-init.sql` creates the roles plus the `helpdesk` and `helpdesk_test` databases on the container's first start; on AWS the same roles are created at Step 0b. The first migration grants the app and readonly roles access to every table the migrator creates.

**Which connection to use:** `db.writer` for every write and for any read that must see something just written; `db.reader` for heavy read-only lists and search. On AWS the reader can lag by a fraction of a second.

**Workspace isolation in code:** every query on tenant data runs inside `withWorkspace()`:

```ts
await withWorkspace(app.db.writer, workspaceId, async (transaction) => {
  // Every query here sees and changes only this workspace's rows.
});
```

It opens a transaction and sets `app.workspace_id` for that transaction only. Outside it, tenant tables return no rows at all.

**Creating a tenant table:** a migration creates the table with a `workspace_id uuid NOT NULL` column and indexes starting with `workspace_id`, then calls `enableTenantIsolation(queryInterface, 'table_name')` (and `disableTenantIsolation` in `down`). This adds the row-level security policy: rows are visible and writable only when their `workspace_id` matches the transaction's workspace. The migrator owns the tables and is not bound by the policy, so cross-workspace data migrations still work.

**Migrations:** TypeScript files in `src/db/migrations`, named `YYYYMMDD-NNNN-description.ts`, each exporting `up` and `down`. They run in name order, as the migrator role, and are recorded in the `schema_migrations` table without the file extension (so the same migration matches in development and in the built image). Every migration must be reversible and backward-compatible with the running code (add first, remove in a later release). In the Docker image: `node dist/db/migrate.js up`.

**Seeds:** files in `src/db/seeders`, recorded in `schema_seeds` so each runs once. `db:seed` refuses to run while migrations are pending. Seeds are for local and demo data only.

**Connection settings:** TLS is on unless `DATABASE_SSL=false` (local Docker only); queries longer than `DATABASE_STATEMENT_TIMEOUT_MS` are cancelled by Postgres; each process tags its connections (`helpdesk-api:writer`, `helpdesk-api:reader`, `helpdesk-worker:writer`, `helpdesk-migrate`) so they are easy to spot in `pg_stat_activity`.

### Startup and shutdown

Settings are validated before anything starts. If any are missing or invalid, the process prints every problem and exits with code 1. On `SIGTERM` or `SIGINT` (ECS stopping a task, Ctrl+C) the API stops accepting connections, finishes in-flight requests, and exits; after 10 seconds it forces the exit.

### Background jobs (worker)

The worker (`src/worker.ts`) runs pg-boss on the writer connection, in its own `pgboss` schema. The schema and every queue are created by migrations (the app role has no DDL rights), so the API and worker start pg-boss with schema creation and migration turned off. The API only adds jobs, inside the transaction of the change that causes them (`JobQueue.enqueue`), and starts pg-boss on its first job; the worker supervises the queues, runs schedules and the handlers in `src/jobs/handlers.ts`. Each handler works inside the job's workspace (`withWorkspace`), so row-level security applies there too. It exits with code 1 if the database is not reachable at startup; on `SIGTERM` it lets running jobs finish (up to 30 seconds), then exits.

| Queue              | Added by                                    | What it does                                     |
| ------------------ | ------------------------------------------- | ------------------------------------------------ |
| `ticket-email`     | a reply or forward (F11), Send again (F13)  | Emails it (outgoing email, F13); retried 4 times |
| `assignment-email` | assigning someone else (F12)                | The "assigned to you" email; retried 4 times     |
| `clean-uploads`    | the worker's daily schedule (03:30 IST)     | Removes uploads never sent, older than a day     |
| `inbound-email`    | the worker picking up email (F14)           | Makes a received email a ticket or a reply       |
| `customer-email`   | a ticket received, resolved or opened (F15) | Tells the requester; retried 4 times             |

With `INBOUND_EMAIL_DRIVER=mailpit` the worker also picks up email sent to workspace addresses every `INBOUND_POLL_SECONDS` (F14). A new queue needs a migration that creates it. Planned jobs: SLA warning and breach checks, time-based rules, and Stripe event follow-up.

### API contract

Zod is the single source of truth for every route's input and output (`src/plugins/api-contract.ts`):

- **Requests** are validated against the route's `params`, `querystring`, `body` and `headers` schemas. Invalid input gets `400 VALIDATION_ERROR`, a message naming the part that is wrong ("The request body is invalid.") and `details.fields`: a list of `{ field, message }`, for example `{ "field": "email", "message": "Invalid email address" }`.
- **Responses** are serialized through the route's response schema for that status code. Fields not in the schema are dropped, so internal columns (for example a password hash) can never leak. A response that breaks its own schema is our bug: it becomes a logged `500 INTERNAL_ERROR`.
- **Every route declares its error responses** with `errorResponses(...)` from `src/lib/schemas.ts`: 400, 429 and 500 always, plus any others the route can return, for example `errorResponses(401, 403, 404)`.
- **Named schemas** (`.meta({ id: 'Ticket' })`) become named components in the spec, so the frontend gets one `Ticket` type. Unused copies are removed from the spec.

**Writing a route** (feature modules, from F1):

```ts
const routes = app.withTypeProvider<ZodTypeProvider>();
routes.post(
  '/tickets',
  {
    schema: {
      tags: ['tickets'],
      body: CreateTicketSchema,
      response: { 201: TicketSchema, ...errorResponses(401, 403) },
    },
  },
  handler,
); // request.body is fully typed from the schema
```

**The contract file:** `openapi.json` at the repo root is generated from the route schemas with `npm run openapi` and committed. A test fails while it is out of date, so a route change and its contract always land together. `helpdesk-web` generates its typed client from it (`npm run api:generate`).

**Docs page:** `/docs` (interactive Swagger UI) and `/docs/json` exist only when `API_DOCS_ENABLED=true`: on locally and in dev (office/VPN only), off in prod. The page sets its own Content-Security-Policy because it needs scripts and styles; every API response keeps the strict `default-src 'none'`.

### Testing

Tests sit next to the code they test (`*.test.ts`) and run with Vitest against real PostgreSQL in Docker. Nothing is mocked at the database level.

**Test databases** (created by `docker/postgres-init.sql`):

| Database                | Purpose                                                                                        |
| ----------------------- | ---------------------------------------------------------------------------------------------- |
| `helpdesk_test`         | All tests. Uses the same three roles as the app.                                               |
| `helpdesk_test_replica` | Same schema, never receives writes. Stands in for an Aurora reader that has not caught up yet. |

Before the tests start, `src/test/global-setup.ts` undoes and reapplies every migration on the replica (so a broken `down` fails the test run, not a rollback in production), then brings `helpdesk_test` up to date. Tests never rely on empty tables: each one creates its own data under fresh random workspace IDs, so tests can run in parallel and leftovers do no harm.

**Required checks for every endpoint** (ENGINEERING_STANDARDS.md section 7):

1. **Tenant isolation**, with `expectTenantIsolation()` from `src/test/tenant-isolation.ts`. It creates data in one workspace, proves the owner can reach it, then proves another workspace cannot: single items must return `404` (never `403`, which would reveal that the item exists), and lists must not contain the data.
2. **Read-after-write** for endpoints that create or change data, with `expectReadAfterWrite()` from `src/test/read-after-write.ts` on an app built with the `LAGGING_READER` override. If the endpoint reads its own result from `db.reader`, the test fails with a message saying to use `db.writer`.
3. **Permissions** for each role (Admin, Supervisor, Agent), added with F4.

Both helpers are tested themselves in `src/test/harness.test.ts`: they pass correct endpoints and catch a table without row-level security and an endpoint that reads its own write from the reader.

**Fixtures:** `createProbeTable()` creates a throwaway tenant table in both test databases for testing plumbing before real tables exist. Feature tests create real data through the API (for example sign up, then confirm with the link from the captured email); `accountsKit()` in `src/test/accounts.ts` gives account tests a fresh app, captured emails, a schema-owner connection, `signedUpWorkspace()`, and `teamWorkspace()` (an admin, a supervisor and an agent, each signed in). Permission tests are one call per endpoint: `expectOnlyRoles(kit, team, ['admin'], (member) => request)` sends it as each role and expects `403 FORBIDDEN` exactly for the others. `testApp(overrides, { email, breachCheck })` swaps in `captureEmails()` instead of SMTP and turns the breach check off, so tests never send mail or call outside services.

**Coverage minimums** (`vitest.config.ts`): 90% statements, functions and lines; 75% branches. `npm run check` and the pipeline fail below them. Raise them as the code grows; never lower them. Entry points (`server.ts`, `worker.ts`, `db/migrate.ts`) and migrations are excluded, because they are exercised by running them and by the migration round trip.

### Feature flows

Added here as each feature is built (login and 2FA, email-to-ticket, replies, assignment rules, SLAs, automation, billing).

#### Sign-up and workspace (F1)

Code: `src/modules/accounts/`. Tables: `users`, `workspaces`, `memberships`, `email_verifications`, `sessions`.

| Endpoint                                  | Address   | Limit per IP  | What it does                                                                      |
| ----------------------------------------- | --------- | ------------- | --------------------------------------------------------------------------------- |
| `GET /api/v1/signup/address-availability` | main      | 60 a minute   | Is a workspace address free? Format, reserved and taken, with alternatives        |
| `POST /api/v1/signup`                     | main      | 5 an hour     | Creates the person, a pending workspace and the owner's membership; emails a link |
| `POST /api/v1/signup/resend`              | main      | 3 an hour     | Sends a fresh link (at most one a minute per sign-up)                             |
| `POST /api/v1/auth/verify-email`          | workspace | 10 per 15 min | Confirms the link, activates the workspace, starts the trial, signs the owner in  |
| `GET /api/v1/me`                          | workspace | general       | The signed-in person, workspace and role                                          |

1. **Sign up:** the request is validated (password at least 12 characters and not found in a data breach, valid timezone, Terms accepted). The person, a `pending` workspace and an Admin owner membership are created in one transaction; the password is stored as an Argon2id hash. A confirmation email goes out with a link to `https://<address>.<domain>/verify-email?token=…`.
2. **The link:** 32 random bytes; only its SHA-256 hash is stored. It works once, only on its own workspace's address, and expires after 24 hours. Asking for a new one replaces the old one.
3. **Confirm:** marks the email verified, activates the workspace, records `trial_started_at`, creates a session and sets the cookie. A used, expired or unknown link answers `400` with `details.reason` (`used`, `expired`, `invalid`); an expired one also returns the email so the page can offer a new link.
4. **Existing email:** the answer is the same `202` as a new sign-up (with matching hashing time), and the person gets an "already have an account" email instead. Nothing reveals who has an account. One email can belong to several workspaces later (invites); the tables are designed for it.
5. **Unconfirmed sign-ups** release their workspace address after 7 days, and signing up again with the same email replaces an unconfirmed sign-up.

**Throwaway email services** (Mailinator, 10minutemail and about 8,900 others, including their subdomains) are refused at sign-up with a message under the email field: a workspace owner needs an inbox they keep. The list is the community-maintained one in `disposable-email-domains-js` (`src/modules/accounts/email-rules.ts`); updating the package updates it. Free providers such as Gmail, Outlook.com and Yahoo are accepted, and invitations are not restricted.

The breached-password check sends only the first 5 characters of the password's SHA-1 hash to Have I Been Pwned (k-anonymity). If the service is slow or down (2-second limit), sign-up continues and a warning is logged.

#### Login and password (F2)

Code: `src/modules/accounts/auth.service.ts` and `auth.routes.ts`. Tables: `password_history`, `password_resets`, `login_failures`.

| Endpoint                                   | Address   | Limit per IP  | What it does                                                                   |
| ------------------------------------------ | --------- | ------------- | ------------------------------------------------------------------------------ |
| `POST /api/v1/auth/login`                  | workspace | 20 per 15 min | Signs a member in; new session every time (an existing one is deleted)         |
| `POST /api/v1/auth/logout`                 | workspace | general       | Ends the session (needs the CSRF token while it is live) and clears the cookie |
| `POST /api/v1/auth/forgot-password`        | workspace | 10 an hour    | Emails a reset link to a member of this workspace; same `202` for any email    |
| `POST /api/v1/auth/reset-password/check`   | workspace | 30 per 15 min | Is a reset link still usable? Returns the email it resets                      |
| `POST /api/v1/auth/reset-password`         | workspace | 10 per 15 min | Sets the new password from a link                                              |
| `POST /api/v1/auth/find-workspaces`        | main      | 5 an hour     | Emails links to every workspace the email belongs to; same `202` for any email |
| `PATCH /api/v1/me`                         | workspace | general       | Changes your name or your colour theme (`theme`: forest, indigo or null)       |
| `POST /api/v1/me/password`                 | workspace | 10 per 15 min | Changes your password (current password required)                              |
| `POST /api/v1/me/sessions/sign-out-others` | workspace | general       | Ends every other session of yours, in every workspace                          |

1. **Login:** wrong password, unknown email, unconfirmed account and "not a member of this workspace" all answer `401 INVALID_CREDENTIALS` and take the same time (a decoy hash runs for unknown emails).
2. **Lockout:** each failure is recorded by the email typed (`login_failures`), whether or not it has an account. 5 failures within 15 minutes lock that email until 15 minutes after the last one (`429 LOGIN_LOCKED`, with `retryAfterSeconds`); attempts while locked are not counted. A successful login or a password reset clears the count; rows older than a day are deleted as new failures come in.
3. **Reset link:** 32 random bytes, only its hash stored, expires after 1 hour, works once and only on the workspace address it was requested on. At most 3 emails an hour per person; a new link expires older ones. Used, expired and unknown links answer `400` with `details.reason`.
4. **New passwords** (reset and change): at least 12 characters, not found in a data breach, and not the current password or any of the 4 before it (`password_history` keeps 4 old hashes). The person is signed out everywhere and gets a "Your password was changed" email. A reset does not sign in; changing the password gives this browser a fresh session (new cookie and CSRF token).
5. **Find your workspace** reads the person's memberships across workspaces through the `own_memberships` policy: a read-only RLS policy that shows rows whose `user_id` equals `app.user_id`. It is set only by this one service function.

#### Two-step verification (F3)

Code: `src/modules/accounts/authenticator.ts` (codes, secrets, recovery codes, challenges), `two-factor.service.ts` and `two-factor.routes.ts`. Tables: `user_two_factor`, `recovery_codes`, `login_challenges`, `trusted_devices`; `workspaces.require_two_factor`.

| Endpoint                                    | Address   | Limit per IP  | What it does                                                                       |
| ------------------------------------------- | --------- | ------------- | ---------------------------------------------------------------------------------- |
| `POST /api/v1/me/two-factor/setup`          | workspace | 10 per 15 min | Password → new secret, setup key, `otpauth://` address and QR code (SVG)           |
| `POST /api/v1/me/two-factor/confirm`        | workspace | 10 per 15 min | First code turns it on; returns 10 recovery codes; signs out other devices         |
| `POST /api/v1/me/two-factor/recovery-codes` | workspace | 10 per 15 min | Password → 10 new recovery codes; the old ones stop working                        |
| `POST /api/v1/me/two-factor/disable`        | workspace | 10 per 15 min | Password + a code or recovery code; refused (409) while a workspace requires it    |
| `POST /api/v1/auth/login/two-factor`        | workspace | 10 per 15 min | The code step of login (app code or recovery code), optionally trusting the device |
| `GET /api/v1/workspace/security`            | workspace | general       | Admins: the "require for everyone" rule and how many members have it on            |
| `PATCH /api/v1/workspace/security`          | workspace | general       | Admins: turn the rule on or off (on needs it on for yourself first)                |

1. **Codes:** TOTP (RFC 6238, SHA-1, 6 digits, 30-second steps, one step of clock drift either way) through `otpauth`. A code is accepted once: its time step must be newer than `last_used_step`.
2. **Secrets:** encrypted with AES-256-GCM (`src/lib/encryption.ts`) using `TWO_FACTOR_ENCRYPTION_KEY`; a key ID (fingerprint) is stored with each secret so a future key change can tell them apart. The QR code is made on the server (`qrcode`, SVG), so the frontend needs no library.
3. **Recovery codes:** 10 per person, `xxxx-xxxx` from an alphabet without look-alike characters, stored as SHA-256 hashes, each usable once (case, spaces and hyphens ignored). Using one emails a notice with how many are left.
4. **Login:** `POST /auth/login` checks the password as before. With two-step verification on and no trusted-device cookie for this person, it answers `202 { twoFactorRequired: true }` and sets the `helpdesk_2fa` cookie (HttpOnly, SameSite=Strict, path `/api/v1/auth`, 5 minutes, hash stored). No session exists until `POST /auth/login/two-factor` accepts a code. Wrong codes answer `401 INVALID_CODE` and count toward the same lockout as wrong passwords; a missing, expired or used-up challenge (5 wrong codes) answers `401 TWO_FACTOR_EXPIRED`.
5. **Trusted devices:** "don't ask again for 30 days" sets `helpdesk_trusted` (HttpOnly, SameSite=Strict, host-only, hash stored). All of a person's trusted devices are forgotten on password change or reset, when two-step verification is turned on again or off, and on "sign out of all other devices".
6. **Required by the workspace:** when `require_two_factor` is on and the person has not set it up, `/me` reports `twoFactor.setupRequired` and every other signed-in endpoint answers `403 TWO_FACTOR_SETUP_REQUIRED`, except the setup endpoints (routes pass `duringTwoFactorSetup`). Sign-out still works.
7. **Lost phone without recovery codes:** an admin resets it from the members page (F4) when the person belongs to that workspace only; otherwise, and for an owner, our support team resets it after confirming who they are (a support procedure, not an app feature).

#### Agents and roles (F4)

Code: `src/modules/accounts/permissions.ts` (the role table), `members.service.ts`, `invitations.service.ts`, `members.routes.ts`. Tables: `invitations` (row-level security); `memberships.status`, `deactivated_at`, `invited_by`; `sessions.reauthenticated_at`.

| Endpoint                                        | Who                     | What it does                                                                |
| ----------------------------------------------- | ----------------------- | --------------------------------------------------------------------------- |
| `GET /api/v1/members`                           | admins, supervisors     | Members (active and deactivated) and open invitations                       |
| `PATCH /api/v1/members/:userId`                 | admins                  | Change a role (making an admin needs a recent password)                     |
| `POST /api/v1/members/:userId/deactivate`       | admins, recent password | Signs them out of this workspace at once; they cannot sign in to it         |
| `POST /api/v1/members/:userId/reactivate`       | admins                  | Lets them back in                                                           |
| `POST /api/v1/members/:userId/reset-two-factor` | admins, recent password | Removes their two-step verification and signs them out everywhere           |
| `POST /api/v1/invitations`                      | admins                  | Invites up to 20 emails with a role (an admin role needs a recent password) |
| `POST /api/v1/invitations/:id/resend`           | admins                  | Fresh 7-day link; the old one stops working                                 |
| `DELETE /api/v1/invitations/:id`                | admins                  | Revokes an open invitation                                                  |
| `POST /api/v1/invitations/check`                | anyone with the link    | What the accept page shows, or why the link cannot be used                  |
| `POST /api/v1/invitations/accept`               | anyone with the link    | Joins the workspace and signs in                                            |
| `POST /api/v1/me/reauthenticate`                | any signed-in member    | Confirms the password for sensitive actions (10 minutes)                    |

1. **Roles and permissions:** three fixed roles (`admin`, `supervisor`, `agent`) mapped to permission keys in `permissions.ts` (`members.view`, `members.manage`, `teams.manage`, `settings.manage`, `tickets.assign_any`, `contacts.edit` for every role, `contacts.delete` for admins and supervisors, and the rest). Every endpoint calls `requirePermission()`; `/me` returns `permissions` so the app hides what a role cannot do. The workspace security settings use `settings.manage`.
2. **Recent password:** making someone an admin (by role change or invitation), deactivating, and resetting two-step verification need the password confirmed on this session in the last 10 minutes; otherwise `403 REAUTH_REQUIRED`. Signing in counts; `POST /me/reauthenticate` refreshes it. Wrong passwords count toward the login lock.
3. **Invitations:** one open invitation per email per workspace (inviting again replaces it); the link token is stored as a hash, works once and expires after 7 days. Active members are skipped ("Already a member."), deactivated ones too ("Reactivate them instead."). Accepting: someone new sends a name and a password (same rules as sign-up; the emailed link confirms the email); someone with a Helpdesk account sends their password, plus a code when they use two-step verification (`details.codeRequired`). Used, expired, revoked and other-workspace links answer `400` with `details.reason`.
4. **Safety rules:** the owner's role cannot change and the owner cannot be deactivated; a workspace always keeps one active admin; nobody deactivates themselves or resets their own two-step verification here. A deactivated member's sessions in that workspace end at once; their other workspaces are untouched; at login they get the same "Email or password is incorrect." as anyone else.
5. **Two-step reset by an admin** is refused (`409 MEMBER_IN_OTHER_WORKSPACES`) when the person also belongs to another workspace: two-step verification belongs to the person, and one workspace's admin must not weaken another workspace's security.
6. **Members list:** read from the writer (the page reloads it right after each change) and not paginated: it is bounded by the workspace's seats; the page searches and filters it.

#### Audit log (F5)

Code: `src/modules/audit/` (`audit.service.ts` records and reads, `describe.ts` turns entries into sentences, `audit.routes.ts`). Table: `audit_events` (row-level security; append-only for the app).

| Endpoint                       | Who    | What it does                                                                                        |
| ------------------------------ | ------ | --------------------------------------------------------------------------------------------------- |
| `GET /api/v1/audit-log`        | admins | Newest first, 50 a page (up to 100) with `cursor`; filters `from`, `to`, `actorId`, `category`, `q` |
| `GET /api/v1/audit-log/export` | admins | The same filters as a CSV download, up to 10,000 rows                                               |

| Category   | Recorded actions                                                                                                                                                    |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `members`  | invited, invitation resent or revoked, joined, role changed (from and to), deactivated, reactivated                                                                 |
| `security` | two-step reset by an admin; a person's password changed or reset, two-step on or off, new recovery codes, other devices signed out                                  |
| `settings` | workspace created, "require two-step verification" turned on or off; custom field added, changed (renamed, with what changed), archived, restored, fields reordered |
| `sign_in`  | signed in (with how: password, app code, recovery code, invitation, email confirmation), locked after too many attempts                                             |

1. **Recording:** `recordAudit(db, record, transaction)` writes the entry inside the same transaction as the change, so neither exists without the other. It switches `app.workspace_id` to the entry's workspace for the insert and puts the previous value back. Changes that fail or change nothing record nothing.
2. **A person's own security events** (`recordForPerson()`) are recorded in every active workspace they belong to, with their role in each; sign-ins only in the workspace signed in to. A lock is recorded by "Helpdesk" (the system) when the locked email belongs to a member of that workspace.
3. **Each entry** keeps the actor's name, email and role at that moment, the category and action, the person or invitation affected, details (for example the role before and after), IP address and User-Agent. Never passwords, codes or tokens. The API adds a plain sentence (`summary`) and a device name ("Chrome on Windows").
4. **Append-only:** the migration revokes `UPDATE`, `DELETE` and `TRUNCATE` on `audit_events` from `helpdesk_app`; a test proves the app role cannot edit or delete entries. Retention per plan (F30) will be a scheduled job with its own role; until then nothing is deleted. Deleting a workspace deletes its log.
5. **Reading** uses the reader connection (a read-only list) and a cursor of (time, id), so pages never repeat or skip. Search covers the person affected, who acted and their email; `%` and `_` are matched literally.
6. **CSV:** times in the workspace time zone and in UTC; cells starting with `=`, `+`, `-` or `@` get a leading apostrophe so a spreadsheet never runs them as formulas.
7. **Later features** record their own events (rules, SLAs, business hours, teams, shared canned replies, branding, billing, ticket deletes and merges, exports) with `recordAudit()`; it is part of their done gate.

#### Custom fields (F6)

Code: `src/modules/custom-fields/` (`custom-fields.service.ts` manages definitions, `values.ts` checks values, `custom-fields.routes.ts`, `models.ts`). Tables: `custom_fields` and `custom_field_choices` (row-level security).

| Endpoint                                      | Who                  | What it does                                                                                |
| --------------------------------------------- | -------------------- | ------------------------------------------------------------------------------------------- |
| `GET /api/v1/custom-fields?recordType=`       | any signed-in member | A record type's fields in order, archived ones too (forms need them)                        |
| `POST /api/v1/custom-fields`                  | admins               | Add a field: record type, label, help text, type, required rule, checkbox default, choices  |
| `PATCH /api/v1/custom-fields/:fieldId`        | admins               | Change label, help text, required rule, checkbox default or choices (never the key or type) |
| `POST /api/v1/custom-fields/:fieldId/archive` | admins               | Hide from forms; values stay on records                                                     |
| `POST /api/v1/custom-fields/:fieldId/restore` | admins               | Bring back at the end of the list (409 at the 50-field limit)                               |
| `PUT /api/v1/custom-fields/order`             | admins               | Set the order of all active fields of a record type (409 when the list changed meanwhile)   |

Every call returns `{ standardFields, fields }`: the record type's built-in fields (from `standardFieldsFor()` in `src/modules/contacts/standard-fields.ts`, with the limits the checks use; tickets since F9) and its custom fields. A test fails if a contact or company request property is missing from the built-in list, so Settings always shows the whole form.

1. **Record types and types:** tickets, contacts and companies; text (255), paragraph (5,000), whole number, decimal, date (`YYYY-MM-DD`), dropdown, multi-select and checkbox. Up to 50 active fields per record type and 200 choices per field.
2. **Key:** made from the label when the field is added (`Employee ID` → `employee_id`; `_2`, `_3` when taken; `field_` in front when it does not start with a letter) and never changes, so rules, the API and exports keep working after a rename. The type never changes either.
3. **Required:** never, always, or "when resolving" (ticket fields only).
4. **Choices** are stored with ids; records keep choice ids, so renaming a choice renames it everywhere. A choice left out of an update is marked removed, not deleted: records that have it still show it as "(removed)", and sending its id again brings it back. Defaults: one choice for a dropdown, any for a multi-select, true or false for a checkbox; they fill new records only.
5. **Values** (for F7 and F9): records store `custom_fields` as JSONB keyed by field key. `fieldDefinitions()` gives the definitions and `checkCustomFieldValues(definitions, input, { existing, creating, resolving })` returns the values to store, or refuses with `customFields.<key>` messages: unknown fields, archived fields being changed, wrong types, unknown or removed choices (unless the record already has it), missing required values. `null` or empty clears a value.
6. **Audit:** every change is recorded in the same transaction (category `settings`); a change that changes nothing records nothing.

#### Contacts and companies (F7)

Code: `src/modules/contacts/` (`contacts.service.ts`, `companies.service.ts`, `contacts.routes.ts`, `models.ts`, `paging.ts` for cursors and search patterns, `email-domains.ts` for domain clean-up and free email services). Tables: `contacts`, `contact_emails`, `companies`, `company_domains` (row-level security).

| Endpoint                              | Who                 | What it does                                                                                                                                       |
| ------------------------------------- | ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/v1/contacts`                | every member        | A page (50, up to 100) with `cursor`; `q` searches name, phone and every email; `companyId`; `sort` `name` or `updated`; `total` on the first page |
| `POST /api/v1/contacts`               | every member        | Add: name, email or phone, up to 5 other emails, job title, company, note, custom fields                                                           |
| `GET /api/v1/contacts/:contactId`     | every member        | One contact                                                                                                                                        |
| `PATCH /api/v1/contacts/:contactId`   | every member        | Change only the fields given; `otherEmails` replaces the list; custom fields merge by key                                                          |
| `DELETE /api/v1/contacts/:contactId`  | admins, supervisors | Delete for good; audited                                                                                                                           |
| `GET /api/v1/companies`               | every member        | A to Z with contact counts; `q` searches name and domains; cursor pages                                                                            |
| `POST /api/v1/companies`              | every member        | Add: name, email domains (up to 20), phone, website, note, custom fields                                                                           |
| `GET /api/v1/companies/:companyId`    | every member        | One company with its contact count                                                                                                                 |
| `PATCH /api/v1/companies/:companyId`  | every member        | Change only the fields given; `domains` replaces the list                                                                                          |
| `DELETE /api/v1/companies/:companyId` | admins, supervisors | Delete for good; its contacts stay without a company; audited                                                                                      |

1. **Emails** are stored in lowercase in `contact_emails` (the main one included), unique per workspace, so one address never belongs to two contacts and email-to-ticket (F13) can match any of them. A refused email names the contact that has it.
2. **A contact** needs a name and an email or a phone; other emails need a main email first.
3. **Domains** are tidied (`@Acme.com`, `https://www.acme.com/` → `acme.com`), unique per workspace, and free email services (gmail.com, yahoo.*, outlook.com and the like) are refused. A new contact with no company given is linked to the company whose domain matches its email; so is a contact without a company whose email changes. `companyId: null` means "no company" and skips the match.
4. **Company names** are unique per workspace, ignoring case.
5. **Custom fields** are checked with F6's `checkCustomFieldValues()`: defaults on create, required fields on every save, archived fields unchanged.
6. **Lists** read the reader, page with a (sort value, id) cursor and count only on the first page. Search scans the workspace's own rows through the `workspace_id` indexes: under row-level security Postgres can't use trigram or JSONB GIN indexes for the app role, so none are created (measured: about 150 ms for a search over 50,000 contacts in one workspace; paging stays under 15 ms).
7. **Audit:** deletes only (`contact.deleted`, `company.deleted`, category `contacts`). Field-level history comes later with record history.

#### Teams (F8)

Code: `src/modules/teams/` (`teams.service.ts`, `teams.routes.ts`, `models.ts`). Tables: `teams`, `team_members`, `invitation_teams` (row-level security).

| Endpoint                       | Who          | What it does                                                                                                    |
| ------------------------------ | ------------ | --------------------------------------------------------------------------------------------------------------- |
| `GET /api/v1/teams`            | every member | Every team A to Z with its members (name, email, role, status, lead); not paginated (at most 100 teams)         |
| `POST /api/v1/teams`           | admins       | Add: name (unique ignoring case, 80 characters), description (500), members with `isLead`                       |
| `GET /api/v1/teams/:teamId`    | every member | One team                                                                                                        |
| `PATCH /api/v1/teams/:teamId`  | admins       | Change only the fields given; `members` replaces the list; `updatedAt` (the loaded version) refuses stale saves |
| `DELETE /api/v1/teams/:teamId` | admins       | Delete; its people stay in the workspace; audited                                                               |

1. **Members:** any active member of the workspace, of any role; a person can be in several teams. `team_members` has a foreign key to `memberships (workspace_id, user_id)`, so only members of the same workspace can be added. Deactivated members keep their place (and can stay leads) but cannot be added; later assignment and round-robin skip them.
2. **Leads** (`isLead`): one or more per team, or none. They get the team's escalations from F24.
3. **Stale saves:** the team's `updatedAt` moves on every change, members included; a save sent with an older `updatedAt` gets `409 TEAM_CHANGED`.
4. **Permission** `teams.manage` (admins only). Reading needs only a signed-in member, because every role picks teams on tickets (F9).
5. **Members page and invitations:** `GET /members` lists each member's teams (`teams`, with `isLead`) and each open invitation's teams. `POST /invitations` takes optional `teamIds`; accepting the invitation adds the person to those teams (teams deleted meanwhile are skipped) and the audit entry names them.
6. **Audit** (category `settings`): `team.created` (with its people), `team.updated` (rename, description, people added and removed, leads), `team.deleted`. A save that changes nothing records nothing.
7. **Reads** use the writer, like the members list: the settings page reloads the list right after each change.

#### Tickets (F9)

Code: `src/modules/tickets/` (`tickets.service.ts`, `tickets.routes.ts`, `models.ts`). Tables: `tickets`, `ticket_tags`, `ticket_activities`, `ticket_counters` (row-level security).

| Endpoint                               | Who          | What it does                                                                                                                                                  |
| -------------------------------------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/v1/tickets`                  | every member | A page (50, up to 100), most recently updated first, with `cursor`; `contactId`, `companyId`; `deleted=true` (admins) is the trash; `total` on the first page |
| `POST /api/v1/tickets`                 | every member | Create: subject, description, a requester (`contactId`, or `contact` by name and email or phone), status, priority, type, team, tags, custom fields           |
| `GET /api/v1/tickets/:number`          | every member | One ticket by its number (deleted ones too, with `deletedAt`)                                                                                                 |
| `PATCH /api/v1/tickets/:number`        | every member | Change only the fields given (also the requester); `tags` replaces the list; custom fields merge by key; 409 while deleted                                    |
| `GET /api/v1/tickets/:number/activity` | every member | The ticket's history, oldest first                                                                                                                            |
| `GET /api/v1/tickets/tags`             | every member | Up to 10 tags in use, most used first; `q` matches the start                                                                                                  |
| `DELETE /api/v1/tickets/:number`       | admins       | Move to the trash (kept, hidden from lists); audited                                                                                                          |
| `POST /api/v1/tickets/:number/restore` | admins       | Bring back from the trash; audited                                                                                                                            |

1. **Numbers** are per workspace, from 1, given out by `ticket_counters` (`INSERT … ON CONFLICT DO UPDATE … RETURNING`), so tickets created at the same moment never share one. Addresses use the number (`/tickets/42`), never the id.
2. **Requester:** every ticket has one contact. `contact` (a name with an email or phone) uses the contact that already has that email, or adds one (linked to a company by the email's domain, F7). The ticket takes the requester's company; changing the requester takes the new one's company. A contact who raised tickets (trashed ones included) can't be deleted (409).
3. **Fields:** status (Open, Pending, Waiting on customer, Resolved, Closed; starts Open), priority (Low, Medium, High, Urgent; starts Medium), type (Question, Incident, Problem, Feature request, or none), team (F8), tags (up to 20 of 40 characters, stored lowercase in `ticket_tags`), custom fields (F6). The description is the first message, plain text; it does not change after creating (replies and notes come with F11). `source` is `agent` for now (`email` with F14, `web_form` with F16). The assignee column is there for F12.
4. **Resolving:** reaching Resolved or Closed checks the "required when resolving" custom fields; `resolvedAt` and `closedAt` are set on reaching those statuses and cleared on reopening.
5. **History** (`ticket_activities`): created, every change (subject, status, priority, type, team and requester by name, custom fields with their label, tags added and removed), deleted and restored, with who and when. A save that changes nothing records nothing and leaves `updatedAt` alone.
6. **Who sees what:** every role sees and works every ticket in Release 1; only admins (`tickets.delete`) delete, restore and see the trash.
7. **Reads:** single tickets and their history read the writer (the app opens a ticket right after saving it); lists read the reader. A list page costs a fixed number of queries (names load in one query per kind).
8. **Audit** (category `tickets`): `ticket.deleted`, `ticket.restored`. Everyday changes live in the ticket's own history, not the audit log.
9. **Built-in fields** for Settings → Fields: `standardFieldsFor('ticket')` (requester, subject, description, status, priority, type, team, tags).

#### Ticket list (F10)

Code: `src/modules/tickets/ticket-list.ts` (filters, sorts, cursors), `views.service.ts`, `listTickets()` in `tickets.service.ts`; `listPeople()` in `src/modules/accounts/members.service.ts`. Tables: `ticket_views` (row-level security); `tickets.priority_rank` (generated).

| Endpoint                              | Who                               | What it does                                                                                                                                                                      |
| ------------------------------------- | --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/v1/tickets`                 | every member                      | Also takes `status`, `priority`, `type`, `teamId`, `assignee`, `tag` (comma-separated; `none` = not set, `me` = you), `q` and `sort` (`updated`, `created`, `oldest`, `priority`) |
| `GET /api/v1/ticket-views`            | every member                      | Your saved views and every shared one, A to Z, with `canEdit`                                                                                                                     |
| `POST /api/v1/ticket-views`           | every member                      | Save a view: name, filters, sort; `shared` needs `views.manage_shared` (admins, supervisors); up to 50 per person                                                                 |
| `PATCH /api/v1/ticket-views/:viewId`  | owner or managers of shared views | Rename, change filters or sort, share or unshare                                                                                                                                  |
| `DELETE /api/v1/ticket-views/:viewId` | owner or managers of shared views | Delete the view (tickets are not touched)                                                                                                                                         |
| `GET /api/v1/people`                  | every member                      | Everyone's name, role and status (no emails), active first, for choosing or filtering by an assignee                                                                              |

1. **Filters** combine with "and"; values inside one filter with "or". Unknown values answer 400 naming the parameter. Saved views store the same filter shape and are checked by the same schema.
2. **Search** (`q`) matches the ticket number (`42` or `#42`), the subject, the requester's name or any of their emails, or an exact tag. It also finds the start of words in descriptions and messages (F14, below).
3. **Orders and cursors:** every order is one direction over indexed columns (`updated_at, id`; `created_at, id`; `priority_rank, updated_at, id`), so "after the cursor" is a single row comparison; a cursor only works with the order it came from. Each page costs a fixed number of queries (tickets, their tags, then names).
4. **Built-in views** (All unresolved, My unresolved, Unassigned, All tickets, Resolved and closed, Trash) are defined by the app, not stored.

#### Ticket conversation (F11)

Code: `src/modules/conversation/` (`messages.service.ts`, `attachments.service.ts`, `conversation.routes.ts`, `models.ts`); `src/adapters/storage/` (file storage); `applyTicketChanges()` in `tickets.service.ts` (shared with replies that set a status). Tables: `ticket_messages`, `ticket_attachments` (row-level security); `tickets.first_response_at`.

| Endpoint                                   | Who                                              | What it does                                                                                                                                                                         |
| ------------------------------------------ | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GET /api/v1/tickets/:number/messages`     | every member                                     | The conversation, oldest first: replies, notes and forwards with their files                                                                                                         |
| `POST /api/v1/tickets/:number/messages`    | every member                                     | `kind` reply (to the requester, plus `cc`), note (private, `mentions`) or forward (`to`); `body`, `attachmentIds`, and `status` for replies and notes; answers with the conversation |
| `POST /api/v1/attachments`                 | every member                                     | Upload one file (multipart, field `file`) for a message being written; up to `ATTACHMENT_MAX_MB`                                                                                     |
| `DELETE /api/v1/attachments/:attachmentId` | the uploader                                     | Remove an upload not sent yet (409 once sent)                                                                                                                                        |
| `GET /api/v1/attachments/:attachmentId`    | every member (sent files), the uploader (unsent) | Download: always `application/octet-stream` with `Content-Disposition: attachment`, a sandbox CSP and `no-store`                                                                     |

1. **Messages** are plain text (up to 20,000 characters; a message needs text or a file). A reply goes to the requester's main email (409 when the contact has none) and up to 10 copies; a forward to 1–10 addresses. Replies and forwards are stored with `emailStatus: queued` and sent by the worker (outgoing email, F13). Notes are never emailed.
2. **@mentions** (notes only) must be active members, up to 20; they are stored on the note and notified with F25.
3. **Status with a reply or note** goes through `applyTicketChanges()` in the same transaction, so "required when resolving" fields and the ticket history work exactly as when changing the ticket; if the status is refused, nothing is saved. The first reply sets `firstResponseAt` (SLAs, F23). Every message moves the ticket's `updatedAt`.
4. **Files** go through the storage adapter (`STORAGE_DRIVER=local`: a git-ignored folder, `STORAGE_LOCAL_DIR`; S3 with signed links comes at Step 0b) under `<workspace id>/<file id>`, never a name from the request. File names are cleaned (no folders or control characters, 255 characters). Programs (.exe, .bat, .js, .ps1 and similar) are refused; over the size limit answers 413 `FILE_TOO_LARGE`. Files are never shown inside the app. An upload is attached when its message is sent (only by the person who uploaded it, at most 10 per message); uploads never sent are removed after a day: the next time the same person uploads, and by the worker's daily clean-up (F13). Virus scanning is added before prod.
5. **Description** stays on the ticket (F9); the conversation starts with it.

#### Manual assignment (F12)

Code: `checkAssignee()` and `unassignOpenTickets()` in `src/modules/tickets/tickets.service.ts`; `deactivateMember()` in `src/modules/accounts/members.service.ts`. Column: `tickets.assignee_user_id` (F9).

1. **Who assigns:** `POST /tickets` and `PATCH /tickets/:number` take `assigneeUserId` (null for nobody). Admins and supervisors (`tickets.assign_any`) assign anyone. Agents may only take an unassigned ticket (themselves) or give back their own; anything else answers 403 with "You can take unassigned tickets or give back your own. A supervisor or admin can reassign others." Saving the same assignee is no change.
2. **Who can be assigned:** active members of the workspace (400 on `assigneeUserId` otherwise). The team does not limit the choice; the app lists the team's members first.
3. **History:** every change is a ticket history entry (`assignee`, by name, from and to).
4. **Deactivating a member** unassigns their unresolved tickets (Open, Pending, Waiting on customer) in the same transaction, each with a history entry by the admin; resolved and closed tickets keep their name.
5. **Telling the new assignee:** the "assigned to you" email is sent by the worker (F13, below); in-app alerts come with the notification center (F25).

#### Outgoing email (F13)

Code: `src/modules/email/` (`outgoing.service.ts` sends, `addresses.ts` builds addresses and Message-IDs, `templates.ts` the email text, `email-settings.service.ts` and `email.routes.ts` for Settings → Email); `src/jobs/` (`queue.ts` adds jobs, `handlers.ts` runs them in the worker); `cleanAbandonedUploads()` in `attachments.service.ts`. Columns: `workspaces.email_sender_name`; `ticket_messages.email_message_id`, `email_sent_at`, `email_attempts`, `email_error`. Migration `20261027-0013-outgoing-email` also creates the pg-boss schema and queues.

| Endpoint                                                  | Who          | What it does                                                                                        |
| --------------------------------------------------------- | ------------ | --------------------------------------------------------------------------------------------------- |
| `GET /api/v1/workspace/email`                             | admins       | Sender name (null means the workspace name), the workspace address and how the From line looks      |
| `PATCH /api/v1/workspace/email`                           | admins       | `senderName` (up to 80; empty or null goes back to the workspace name); audited                     |
| `POST /api/v1/workspace/email/test`                       | admins       | Sends the admin a test email from the workspace address straight away (503 `EMAIL_NOT_SENT` if not) |
| `POST /api/v1/tickets/:number/messages/:messageId/resend` | every member | Sends a failed reply or forward again (409 unless it failed); answers with the conversation         |

1. **Addresses:** every workspace has its own address, `<workspace address>@TICKET_EMAIL_DOMAIN` (for example `acme@mail.helpdesk.example.com`). Ticket email goes out from it as `"<sender name>" <acme@…>`. Reply-To is `acme+<ticket number>-<signature>@…`: the signature is an HMAC of the workspace and ticket (key derived from `TWO_FACTOR_ENCRYPTION_KEY` with HKDF), so a customer's reply finds its ticket even if their email program drops the threading headers, and nobody can aim email at another ticket by changing the number (read by F14).
2. **Sending a reply or forward:** `POST /tickets/:number/messages` saves the message with `emailStatus: queued`, its own Message-ID (`<message id>@TICKET_EMAIL_DOMAIN`) and a `ticket-email` job in the same transaction, so a job exists only for a saved message. The worker builds the email: subject `Re: <subject> [#N]` (forward: `Fwd:`), In-Reply-To and References from earlier messages' Message-IDs (the last 10), plain text and HTML with the "reply above this line" marker (F14 cuts customers' replies there), the agent's name and sender name, the last message quoted (a forward quotes up to 10), and the files (up to 20 MB together; larger ones are listed by name). A reply goes to the requester with copies in Cc; a forward to its addresses.
3. **Retries:** a failed send is retried by pg-boss 4 more times over about 15 minutes (30 seconds doubling, at most 10 minutes apart). After the last try the message is `failed` with the reason (shown with "Couldn't send" and **Send again**). A message already sent is never sent again, even if its job runs twice.
4. **"Assigned to you" email:** assigning someone else (on create or change) queues an `assignment-email` job with the ticket; nobody is emailed about a ticket they took themselves. The worker skips it if the ticket has moved to someone else meanwhile or the person is no longer active. The email links to the ticket on the workspace address. The in-app alert comes with F25.
5. **Daily clean-up:** the `clean-uploads` job runs at 03:30 India time and removes uploads never sent, older than a day, in every workspace. It visits only workspaces that have some, through `abandoned_upload_workspaces()` (a SECURITY DEFINER function that answers workspace ids only), then works inside each workspace as usual; rows are removed before files.
6. **Email on dev and AWS:** all of this goes through the email adapter (`EMAIL_DRIVER`), so locally and on the temporary dev server ticket email lands in Mailpit. With SES, the From domain (`TICKET_EMAIL_DOMAIN`) must be verified in SES first.

#### Email-to-ticket (F14)

Code: `src/modules/email/incoming.service.ts` (`receiveEmail()`), `src/adapters/inbound-email/` (the mailbox), `src/jobs/inbound.ts` (picking up and the `inbound-email` job), `createEmailTicket()` and `reopenForCustomer()` in `tickets.service.ts`, `search_ticket_ids()` in migration `20261027-0014-email-to-ticket`. Columns: `tickets.email_message_id`; `ticket_attachments` may now have no uploader (files from email) and belong to a ticket without a message (files of the email that raised it).

1. **Getting the email:** `INBOUND_EMAIL_DRIVER` lists where email to workspace addresses waits (comma separated). `mailpit` (locally, and test email on the temporary dev server): every `INBOUND_POLL_SECONDS` the worker takes the emails whose To, Cc or Bcc is on `TICKET_EMAIL_DOMAIN`. `s3` (real email): SES receiving saves each email in `INBOUND_EMAIL_BUCKET` under `INBOUND_EMAIL_PREFIX`, and the worker reads those. Either way the worker stores each raw email in file storage (`inbound/<id>`), adds an `inbound-email` job and only then removes it from the mailbox (larger than `INBOUND_EMAIL_MAX_MB` are removed unread). `none`: nothing is picked up. To try it locally, send an email to `<workspace address>@mail.helpdesk.local` through Mailpit (`POST http://localhost:8025/api/v1/send`, or any mail program on SMTP port 1025).
2. **Which workspace and ticket:** the first recipient on `TICKET_EMAIL_DOMAIN` that names a workspace (a signed `acme+42-<signature>` address wins). A reply finds its ticket by the Message-IDs it answers (In-Reply-To, then References: ours or earlier customer emails, or the email that raised the ticket), then by the signed reply address; a changed number or signature is just a new email. An email to a closed or deleted ticket starts a new ticket that says so ("This email answers ticket #1, which is closed.").
3. **New ticket:** subject (spaces tidied, `(no subject)` if empty, up to 200), description = the text, source `email`, open, medium, nobody assigned (assignment rules: F18). The requester is the contact with the sender's email, or a new contact named from the From line (its local part when there is no name), linked to the company of its domain. Ticket and contact fields get their defaults; required ones are asked for when a member next saves (`skipRequired`). The history shows the customer as who raised it.
4. **Reply on a ticket:** a `customer` message by the sender's contact (anyone on the thread, not only the requester), with To and Cc kept. A waiting, pending or resolved ticket opens again, with a history entry by the customer. The ticket moves up "last updated".
5. **Only what the customer wrote:** the text is cut at our "reply above this line" marker, and the quoted earlier email under it ("On … wrote:" and the `>` lines) is dropped; at most 20,000 characters. Only plain text is kept: HTML-only email is converted to text, and no HTML from email is stored or shown, which is how email HTML is made safe in Release 1 (`body_html` stays empty until rich text, Release 2).
6. **Files:** up to 10 per email, each up to `ATTACHMENT_MAX_MB`; programs and larger files are not added and listed at the end of the text ("[Files not added: run-me.exe (a program)]"); inline images under 10 KB (signatures, logos) are skipped. Files of the email that raised a ticket are the ticket's description files (`descriptionFiles` in the conversation).
7. **Never twice, never loops:** an email whose Message-ID the workspace already has is a duplicate (also when two copies arrive at once: the unique index stops one). Not turned into tickets: email from a workspace address, bounces (`mailer-daemon`, `postmaster`, delivery reports), `Auto-Submitted` other than `no`, `Precedence: bulk/junk/auto_reply`, `X-Autoreply`/`X-Autorespond`, `X-Loop` naming our domain, and a sender's email after 20 in an hour to the same workspace. Mailing lists are allowed (a company's support@ group often forwards to the workspace address). Every outcome is logged with the reason.
8. **Search inside tickets:** the ticket list's `q` also finds the start of words in the subject, description and every message (notes too), through `search_ticket_ids(query, max)`. The function runs as the schema owner because row-level security stops the app role using the full-text indexes, and it limits itself to the workspace in `app.workspace_id`, as the policy does. It splits the search with the same `simple` parser as the GIN indexes (so `ZX-981`, `INV/2026/42` and Indian scripts match as typed), uses the first 8 words, and each must start a word.

#### Customer notification emails (F15)

Code: `sendCustomerEmail()` in `src/modules/email/outgoing.service.ts`, `customerNotificationBodies()` in `templates.ts`, `queueCustomerEmail()` in `tickets.service.ts`; Settings → Email in `email-settings.service.ts`. Column: `workspaces.customer_notifications` (JSON, migration `20261027-0015-customer-notifications`).

| Notification   | Sent when                                                          | Default |
| -------------- | ------------------------------------------------------------------ | ------- |
| `received`     | a ticket is raised by email (F14) or the web form (F16)            | on      |
| `resolved`     | a member sets a ticket to Resolved (not when saved resolved again) | on      |
| `agentCreated` | a member logs a ticket for a customer                              | off     |

1. **Queued with the change:** each event adds a `customer-email` job in the same transaction. The worker checks when it sends: the notification is on in Settings → Email (so turning one off also stops those already queued), the ticket is not deleted, a "resolved" ticket is still resolved, and the requester has an email that is not a workspace address.
2. **The email:** from the workspace address with its sender name, Reply-To the signed ticket address (F13), subject `Re: <subject> [#N]` (`<subject> [#N]` for a ticket opened by an agent), In-Reply-To/References the email that raised the ticket and the latest email on it, so it sits in the customer's thread. It starts with the "reply above this line" marker; answering adds to the ticket and opens it again (F14). The text is fixed in Release 1 (editable templates: Release 2).
3. **Settings:** `PATCH /api/v1/workspace/email` takes `customerNotifications` (only the ones given change), admins only, audited (`workspace.customer_notifications_changed`, "Ravi Shankar turned off the "ticket resolved" email.").
4. **No loops:** customers' auto-replies to these emails are dropped by F14's checks.

#### Web form (F16)

Code: `src/modules/web-form/` (`web-form.service.ts`, `web-form.routes.ts`); `createCustomerTicket()` in `tickets.service.ts` (shared with email). Column: `workspaces.web_form` (JSON: `enabled`, `title`, `intro`; migration `20261027-0016-web-form`).

| Endpoint                           | Who                            | What it does                                                                                       |
| ---------------------------------- | ------------------------------ | -------------------------------------------------------------------------------------------------- |
| `GET /api/v1/web-form`             | anyone, on a workspace address | The form's title and intro, or `enabled: false`                                                    |
| `POST /api/v1/web-form/requests`   | anyone, on a workspace address | `name`, `email`, `subject`, `description` (and the hidden `website`); answers `{ received: true }` |
| `GET /api/v1/workspace/web-form`   | admins                         | The settings and the page's address (`url`, `<workspace>/support`)                                 |
| `PATCH /api/v1/workspace/web-form` | admins                         | `enabled`, `title` (1–80), `intro` (up to 1,000); only what is given; audited                      |

1. **Off until an admin turns it on.** While off, the page says the form is not available and requests answer 404.
2. **A request becomes a ticket** from the contact with that email (found or added, as for email; required fields skipped), source `web_form`, open, nobody assigned, with the customer as who raised it in the history, and the "request received" email (F15).
3. **Spam:** 5 requests per 10 minutes from one network address; a hidden `website` field that only bots fill (the request is dropped but answered as usual, so bots learn nothing); and the per-sender limit shared with email (20 an hour). Requests from another site are refused (403) like every change; the page calls the API on its own address, so this also holds when it is embedded.
4. **Embedding:** the page is `/support` on the workspace address; other sites show it with an iframe (Settings → Web form gives the code). Only that path may be framed (`Content-Security-Policy: frame-ancestors *`); every other page keeps `X-Frame-Options: DENY` (dev server: `deploy/dev-lightsail/site.caddy`; the planned CloudFront setup must do the same).

#### Rules engine (F17)

Code: `src/modules/rules/` (`conditions.ts` what a rule looks at and how it matches, `actions.ts` what it does, `engine.ts` running rules, `rules.service.ts` and `rules.routes.ts` Settings → Rules). Table: `automation_rules` (row-level security); `ticket_messages.author_name` for notes a rule adds.

| Endpoint                       | Who    | What it does                                                                  |
| ------------------------------ | ------ | ----------------------------------------------------------------------------- |
| `GET /api/v1/rules`            | admins | The rules, in order                                                           |
| `POST /api/v1/rules`           | admins | Add a rule at the end (up to 100); audited                                    |
| `PATCH /api/v1/rules/:ruleId`  | admins | Change a rule (only what is given), including turning it on or off; audited   |
| `DELETE /api/v1/rules/:ruleId` | admins | Delete a rule; audited                                                        |
| `PUT /api/v1/rules/order`      | admins | Every rule's id in the new order (409 if the list changed meanwhile); audited |
| `POST /api/v1/rules/test`      | admins | Whether conditions would match ticket #N now, and which did; changes nothing  |

1. **A rule** is: when (the event; F17 has "a ticket is created", by an agent, email or the web form), if (conditions, all or any of up to 20; none means every ticket), then (1 to 10 actions), and optionally "stop here".
2. **Conditions** look at the subject, description, both together, the requester's email, status, priority, type, how it came in, team, assignee, company, tags, and any custom field of the ticket, the requester or their company (`ticket.<key>`, `contact.<key>`, `company.<key>`). Comparisons by kind of field: text contains any or none of some words, is, is not, is empty or not (ignoring case); choices are any or none of a list (`none` for not set); lists (tags, multi-select) contain any or none; checkboxes are checked or not. Every condition is checked against the workspace when the rule is saved (fields, teams, people, choices).
3. **Actions:** set priority, status, type, team or assignee (`none` to clear), assign in turn within a team (F18, below), add or remove tags, add a private note.
4. **Running:** inside the same transaction as the new ticket, enabled rules run top to bottom; each sees what the rules above changed; a matching rule with "stop here" ends the run. A rule changes the ticket through the same code and checks as a member, as "Rule: <name>" in the ticket history, and its notes are written by "Rule: <name>". A change the ticket refuses (for example resolving it while a required field is empty) is skipped, and the rule says why in a private note; the ticket is still created. Assigning someone sends the "assigned to you" email. Changes made by rules never start rules, so rules cannot loop.

#### Assignment rules and round-robin (F18)

Code: `nextInTurn()` and `applyRule()` in `src/modules/rules/engine.ts`. Column: `teams.round_robin_last_user_id`.

1. **Routing** ("billing" → Accounts, company plan Premium → Senior agents, a catch-all "everything else" at the bottom) is done with F17 rules; F18 adds the action **assign in turn within team**.
2. **In turn:** the action sets the team and gives the ticket to the next active member of that team, in the order they joined it, after whoever got the team's last ticket this way; it goes round. Deactivated members are skipped. The team row is locked while choosing, so tickets arriving at once go to different people.
3. **Nobody available:** with no active member in the team, the ticket keeps the team, stays unassigned, and the rule says so in a private note.
4. A later "assign to" action in the same rule wins over the turn. The person gets the "assigned to you" email, as with any assignment.
5. **Not in Release 1:** assigning by load (fewest open tickets) and skipping people marked away (with the notification center, F25).

#### Event-based automation (F19)

Code: `afterMemberChange()` and `changedFields()` in `tickets.service.ts`, the `customer_replied` run in `incoming.service.ts`, `emailRequester()` in `rules/engine.ts`, `sendTeamEmail()` in `outgoing.service.ts`. Queue: `team-email`.

1. **Two more events.** `ticket_updated`: a member changed a ticket (Edit, or a reply or note that set the status), after the change is saved. `customer_replied`: a customer's email landed on a ticket (F14), after it reopened. Changes made by rules never start rules, so rules cannot loop.
2. **Fields only those events have.** `changed` (what the change touched: status, priority, type, team, assignee, requester, subject, tags, or any custom field as `custom_fields`) for changes; `previous_status` (the status before) for changes and replies; `message` (the customer's text) for replies. A rule for another event is refused with "This field is only for rules that run when a ticket is changed".
3. **Three email actions.** Email the requester: a reply on the ticket by "Rule: <name>", sent like any reply (from the workspace address, threaded, signed by the workspace), so the team sees what went out; no email address means a note instead. Email the assignee, or the ticket's team leads: a `team-email` job; the worker sends "Ticket #N: <subject>" with the rule's message, a link and "Sent by the rule", only to active members; nobody fitting means nothing is sent.

#### Time-based automation (F20)

Code: `runTimeRules()` in `rules/schedule.ts`, the `time-rules` job in `src/jobs/handlers.ts`. Migration `0020-time-rules`.

1. **The event `time`.** The worker's `time-rules` job runs every 15 minutes (Asia/Kolkata). It asks `workspaces_with_time_rules()` (SECURITY DEFINER, workspace ids only) which workspaces have scheduled rules turned on, then inside each workspace checks up to 1000 tickets that are not closed or deleted, longest in their status first, against those rules in order.
2. **Time fields.** `hours_in_status` (since `tickets.status_changed_at`, set whenever the status changes), `hours_since_created`, `hours_since_updated`, with `at_least` and `less_than` and whole hours from 1 to 8760. A scheduled rule must match all its conditions and have at least one "is at least" time condition, so it can never run on every open ticket at once.
3. **Once per stay.** `automation_rule_runs` (rule, ticket, the `status_changed_at` it ran for) records each run, so "3 days waiting: remind" sends one reminder, not one every 15 minutes. When the ticket leaves the status and comes back, it can run again. The primary key also stops two workers running the same one twice. Changes made by scheduled rules start no other rules, and closed tickets are left alone.

#### Canned responses (F21)

Code: `src/modules/canned-responses/` (service, routes, `placeholders.ts`). Migration `0021-canned-responses`.

1. **Personal or shared.** `canned_responses.owner_user_id` is the person a personal one belongs to; NULL means shared with the workspace. Everyone who works tickets keeps their own (up to 100); admins and supervisors (`canned_responses.manage_shared`) add, change, share and delete the shared ones (up to 300 per workspace). Someone else's personal one answers 404. A personal one goes when its owner leaves the workspace; shared ones stay.
2. **Placeholders.** `{{contact.name}}`, `{{contact.first_name}}`, `{{contact.email}}`, `{{ticket.number}}`, `{{ticket.subject}}`, `{{agent.name}}`, `{{agent.first_name}}`, `{{workspace.name}}`. `GET /canned-responses` returns the list with the placeholders; a save with an unknown one is refused (400 on `body`).
3. **Use.** `GET /canned-responses/:id/filled?ticketNumber=N` returns the text filled in for that ticket and the signed-in agent. Nothing is sent: the composer puts the text in the message box to edit and send as usual.

#### Business hours and holidays (F22)

Code: `src/modules/business-hours/` (service, routes, `calendar.ts`). Migration `0022-business-hours`.

1. **Settings.** `GET` and `PUT /workspace/business-hours` (admins, `settings.manage`): the workspace time zone (`workspaces.timezone`, the one used everywhere), 24×7 or working days, each with one stretch of hours (`"HH:MM"`, `24:00` ends at midnight). A workspace that never saved them works Monday to Friday, 09:00 to 18:00 (`saved: false` until the first save). `POST /workspace/holidays` and `DELETE /workspace/holidays/:id` keep the days off, one per date, up to 200. Every change is audited (`workspace.time_zone_changed`, `workspace.business_hours_changed`, `holiday.added`, `holiday.removed`).
2. **Working time.** `calendar.ts` is plain functions over a workspace calendar (`loadCalendar()`): the working windows from a moment on (holidays and closed days skipped, clock changes in the time zone followed), adding counted minutes with paused stretches left out, counting minutes between two moments, and adding whole working days at the same time of day. With 24×7 every moment counts and holidays do not apply. SLA clocks (F23) use them.

#### SLA policies and countdowns (F23)

Code: `src/modules/sla/` (service, routes, `clock.ts`). Migration `0023-sla-policies`.

1. **Policies.** `GET /sla-policies`, `POST`, `PATCH /sla-policies/:id`, `DELETE`, `PUT /sla-policies/order` (admins). Per priority a reply time and a resolve time (minutes, hours or days, up to 365 days) and whether they count business hours (F22) or round the clock. Every workspace has one default policy, added with the starting values (Urgent 1 h / 4 h, High 4 h / 1 day, Medium 8 h / 3 days, Low 1 day / 5 days, business hours) the first time it is needed; it has no conditions and cannot be deleted. Extra policies have conditions from the rule condition builder (event-only fields refused, `checkTicketConditions()`), are tried in order, and the first match wins. Audited (`sla_policy.*`).
2. **Due times.** `updateSla()` runs inside the transaction that creates or changes a ticket (agent tickets, email and web form tickets after their creation rules, `applyTicketChanges()` for members and rules, a customer reopening by email). It picks the policy, and works the due times out from creation (`tickets.sla_reply_due_at`, `sla_resolve_due_at`) when the ticket is new, its priority changes or another policy now matches. In business hours a day is a working day: the same time on the next working day, or the next opening. Policy and business-hours changes apply to due times worked out from then on.
3. **Clocks.** The first reply the customer sees (a reply, not a note) meets the reply target. Waiting on customer pauses both clocks: the stay is added to `tickets.sla_pauses` when it ends and the clocks leave it out (Pending still counts). Resolved or closed stops them; reopening starts the resolve clock again from that moment (`sla_resolve_from`). `tickets.sla_due_at` is the next deadline still running (null while paused or done).
4. **Showing them.** A ticket has `sla`: the policy, and per target the due time and a state (running, overdue, paused, met, missed). Lists have `due` (the next deadline and which target), the `overdue=true` filter and the `sort=due` order (generated `sla_due_rank`, tickets without a running deadline last); saved views keep both.

#### SLA warning and escalation (F24)

Code: `src/modules/sla/escalation.ts`, `clock.ts` (`dueAlerts()`, `nextAlertAt()`), `src/modules/notifications/notify.ts`. Migration `0024-sla-escalation`.

1. **Settings.** Each policy has `escalation`: `warnMinutes` (1 to 1,440, or null for no warning; 10 to start with) and what happens at a deadline besides marking it overdue and telling the leads: `reassign` = `nobody`, `team_lead` (the first active lead of the ticket's team who is not the assignee), `person` (`reassignUserId`, an active member) or `team` (unassigned, the team kept).
2. **When.** `updateSla()` also keeps `tickets.sla_alert_at`, the next warning or escalation not done yet for the running clocks. The worker's `sla-check` job runs every minute: `workspaces_with_sla_alerts()` (SECURITY DEFINER, ids only) finds the workspaces with one due, then inside each workspace up to 500 tickets, each locked in its own transaction.
3. **Once.** `tickets.sla_alerts` records each warning and escalation against the start of its clock (creation; for resolve, the last reopening), so each happens once per ticket, and again only after a reopening. A deadline already passed is escalated without a warning.
4. **What happens.** Warning: the assignee is told, or the team's leads when nobody has it (the admins when there is no team either). Escalation: a history entry "SLA: <policy> marked the first reply overdue", the reassignment through the normal ticket change (history, "assigned to you" email), and the leads (or admins) are told, with the outcome. Members are told through `notifyMembers()` (F25: in the app, and by email if they chose it).

#### Notification center (F25)

Code: `src/modules/notifications/` (`notify.ts`, service, routes). Migration `0025-notifications`.

1. **Telling people.** Everything goes through `notifyMembers()` inside the transaction of the change: it skips anyone no longer active, adds a row to `notifications` per person, and for those who chose email for that kind queues the email (`member-notice`, or the caller's own: assignments keep the "assigned to you" email). Kinds and who gets them: `assigned` (the new assignee, not when you take a ticket yourself), `mention` (the people @mentioned in a note, not its writer), `sla_warning` and `sla_breach` (F24), `customer_reply` (the assignee, when the customer answers by email).
2. **Email choices.** `memberships.notification_email`, per workspace: `GET` and `PATCH /notifications/email`. All kinds on to start with except customer replies. In the app every kind always shows.
3. **Reading.** `GET /notifications` (your own, newest first, cursor pages, with the unread count), `GET /notifications/unread` (counted up to 100, from the reader, for the bell's check every minute until live updates, F26), `POST /notifications/read` (the ids given, or all; another person's id answers 404).
4. **Clean-up.** Notifications older than 90 days are removed by the worker's daily clean-up (`delete_old_notifications()`, SECURITY DEFINER).

#### Live updates (F26)

Code: `src/modules/live/` (`live.server.ts`, `signals.ts`), started by `src/server.ts`. Migration `0026-live-updates`.

1. **Connection.** Socket.IO on the API's own server and address, path `/socket.io` (the Vite dev server and the dev server's Caddy forward it, WebSocket included). It is a signed-in member on their workspace address: the session cookie is checked as for any request (`requireSignedIn()`), a browser's Origin must be the same address and cross-site requests are refused. Each connection is in a room for its workspace and one for the member, and joins a ticket's room when the browser opens it (`watch` with the ticket id, only tickets of its workspace).
2. **Signals.** Changes are sent as short signals with `NOTIFY helpdesk_live` (`sendSignal()`) inside the transaction that makes them, so only saved changes are signalled, from the API and the worker alike: Sequelize hooks on tickets, messages, ticket history and notifications. Each API task listens on one connection and passes them to its own browsers: `ticket` (an open ticket changed), `tickets` (for lists: which ticket, and whether it is new), `notifications` (the member's bell). The browser reloads what it shows through the REST API, so permissions and workspace separation stay in one place.
3. **Several API tasks.** Broadcasts made by a connection (F27) reach the other tasks through `@socket.io/postgres-adapter` (no Redis); its `socket_io_attachments` table holds broadcasts too large for one NOTIFY for 30 seconds.
4. **Ending.** Signing out, a password change ending other sessions and deactivation close the member's connections at once (signals `session-ended`, `sessions-ended`, `member-removed`); each connection also checks every minute that its session is still live (without counting as activity, `sessionStillLive()`).

#### Collision detection (F27)

Code: `src/modules/live/live.server.ts` (the `presence` message). No migration.

1. **Presence.** A browser with a ticket open sends `presence` (`{ ticketId, typing: 'reply' | 'forward' | null }`) after the server confirms it watches that ticket, whenever that changes and every 10 seconds. The server passes it, with the name from the session (never from the browser), to the others in the ticket's room through the adapter, at most twice a second per connection; it ignores presence for tickets the connection does not watch. Someone silent for 30 seconds drops off; leaving the ticket or disconnecting sends `left` at once.
2. **Who is already here.** When a connection starts watching a ticket, the server sends it a `presence` for each other person already in the room, with what they are writing (`fetchSockets()`, across API tasks).
3. **Replied meanwhile.** Not a server rule: before sending a reply or forward, the app reloads the conversation and warns if another member replied or forwarded since the ticket was opened. The existing "Someone else changed this ticket" check on properties stays.

#### Merge and split (F28)

Code: `src/modules/tickets/merge.service.ts`. Migration `0027-merge-split`.

1. **Merge.** `POST /tickets/:number/merge` (`{ numbers, tellCustomers }`; admins and supervisors, `tickets.merge`): 1 to 4 other tickets into this one, locked in one order. Each other ticket's description becomes a customer message on the main ticket (with its files) at its original time; its messages, notes and files move over (`ticket_messages.from_ticket_number`, "From #41"); tags are combined; its requester (and its own copies) join `tickets.cc_emails`, which every reply on the main ticket copies. The others are closed with `tickets.merged_into_id`: read-only (`lockTicketForChange()` answers 409 "merged into #42") and email to their old threads lands on the main ticket (`threadOf()` follows merges). Ticket lists (`GET /tickets`) also carry `mergedInto`, so a contact's or company's tickets can say "Merged into #42". With `tellCustomers`, each other requester gets the `merged` customer email (not a workspace setting), whose replies go to the main ticket. History on both, audit `ticket.merged`, no undo. Rules do not run for a merge.
2. **Split.** `POST /tickets/:number/messages/:messageId/split` (every member): a customer's message becomes a new ticket: the same requester, company, priority, type and team, the message's files as its description files, nobody assigned. The message leaves the original ticket; the histories say "split into #57" and "split from #42". The new ticket runs the "ticket created" rules and gets its SLA; no customer email.

#### Home page (F29)

Code: `src/modules/home/`. No migration.

1. **Counts.** `GET /home` (every member, from the reader): `counts.mine` (unresolved, assigned to me), `overdue`, `unassigned` (unresolved) and `waitingOnCustomer` (mine), each made with `filterConditions()` and the same filters as the ticket list the web card opens (`HOME_COUNTS`).
2. **Setup checklist.** `setup` for people with `settings.manage`, `null` for others: `teamInvited` (more than one membership, or any invitation), `emailConnected` (a ticket with source `email`), `businessHoursSet` (a `business_hours` row).

## Environments

The same Docker image runs everywhere. Only settings change.

|                            | Local                    | AWS dev (planned)                                        | AWS prod                                                                           |
| -------------------------- | ------------------------ | -------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Git branch                 | `feature/*`              | `dev-deploy`                                             | `release/production`                                                               |
| Purpose                    | Development              | Integration and testing of finished features             | Live customers                                                                     |
| API + worker               | Your machine             | ECS Fargate (small, always on)                           | ECS Fargate (autoscaling)                                                          |
| Access                     | localhost                | office/VPN IPs only                                      | Public                                                                             |
| Database                   | One PostgreSQL in Docker | One Aurora PostgreSQL Serverless v2 cluster (1 instance) | One Aurora PostgreSQL Serverless v2 cluster (writer + reader instances, same data) |
| `DATABASE_URL` (write)     | Local database           | Aurora writer endpoint                                   | Aurora writer endpoint                                                             |
| `DATABASE_READ_URL` (read) | Same local database      | Aurora reader endpoint (routes to the single instance)   | Aurora reader endpoint (routes to the reader instance)                             |
| Email                      | Mailpit                  | SES                                                      | SES                                                                                |
| Files                      | `./storage`              | S3                                                       | S3                                                                                 |

**Temporary dev (no budget yet):** until the planned AWS dev exists, dev runs on one Lightsail server: the same image in Docker Compose, PostgreSQL in a container (both connections point to it), the Mailpit test mailbox for email, files on the server's disk; the site is open and only the test mailbox has a shared dev password. See "Temporary dev server" under Deployment.

### Switching an environment

| To switch    | Change                                                                                      |
| ------------ | ------------------------------------------------------------------------------------------- |
| Database     | `DATABASE_URL`, `DATABASE_READ_URL` and `DATABASE_MIGRATION_URL`, then `npm run db:migrate` |
| Email        | `EMAIL_DRIVER` (`smtp` or `ses`) and its settings                                           |
| File storage | `STORAGE_DRIVER` (`local` or `s3`) and its settings                                         |
| AWS sizing   | `infra/config/dev.ts` or `infra/config/prod.ts`, then deploy                                |

## Environment variables

Available now (S1):

| Variable                        | Default                       | Purpose                                                                                             |
| ------------------------------- | ----------------------------- | --------------------------------------------------------------------------------------------------- |
| `HOST`                          | `0.0.0.0`                     | Address to listen on. `.env.example` uses `127.0.0.1` so the local API stays off your network       |
| `PORT`                          | `4000`                        | Port to listen on                                                                                   |
| `APP_VERSION`                   | `local`                       | Release tag or commit, set by the pipeline; shown in `/health` and every log line                   |
| `LOG_LEVEL`                     | `info`                        | `fatal`, `error`, `warn`, `info`, `debug`, `trace` or `silent`                                      |
| `LOG_FORMAT`                    | `json`                        | `json` (AWS) or `pretty` (local only; needs dev dependencies)                                       |
| `TRUST_PROXY`                   | `false`                       | `true` behind the AWS load balancer, so client IPs come from `X-Forwarded-For`                      |
| `CORS_ORIGINS`                  | (required)                    | Comma-separated browser origins allowed to call the API, exact match                                |
| `RATE_LIMIT_MAX`                | `300`                         | Requests allowed per client IP per window                                                           |
| `RATE_LIMIT_WINDOW_MS`          | `60000`                       | Rate-limit window in milliseconds                                                                   |
| `BODY_LIMIT_BYTES`              | `1048576`                     | Largest accepted request body                                                                       |
| `API_DOCS_ENABLED`              | `false`                       | `true` serves `/docs` and `/docs/json` (local and dev); keep `false` in prod                        |
| `DATABASE_URL`                  | (required)                    | Writer connection, `helpdesk_app` role. AWS: Aurora writer endpoint                                 |
| `DATABASE_READ_URL`             | (required)                    | Reader connection, `helpdesk_readonly` role. Locally the same database; AWS: Aurora reader endpoint |
| `DATABASE_MIGRATION_URL`        | (required for `db:*` scripts) | Schema-owner connection, `helpdesk_migrator` role. Never used by the running app                    |
| `DATABASE_SSL`                  | `true`                        | TLS to the database; `false` only for the local Docker database                                     |
| `DATABASE_SSL_CA_FILE`          | (none)                        | CA bundle for verifying the database certificate (the Amazon RDS bundle on AWS)                     |
| `DATABASE_POOL_MAX`             | `10`                          | Maximum connections per pool (writer and reader each)                                               |
| `DATABASE_STATEMENT_TIMEOUT_MS` | `15000`                       | Postgres cancels any single query that runs longer                                                  |

Added in F1 to F3:

| Variable                    | Default                              | Purpose                                                                                                                                                                                                                                 |
| --------------------------- | ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `APP_PUBLIC_URL`            | (required)                           | The main address people open, no path (`http://localhost:5173` locally). Workspaces are subdomains of its host; email links use it                                                                                                      |
| `COOKIE_SECURE`             | `true`                               | Sign-in cookie only over HTTPS. `false` only for local http                                                                                                                                                                             |
| `SESSION_IDLE_HOURS`        | `8`                                  | A sign-in ends after this many hours without activity (at most 720)                                                                                                                                                                     |
| `TWO_FACTOR_ENCRYPTION_KEY` | (required)                           | Encrypts authenticator secrets: 32 random bytes, base64 (`openssl rand -base64 32`). A secret (SSM `SecureString` on AWS), different in every environment; replacing it makes existing setups unreadable                                |
| `SESSION_ABSOLUTE_DAYS`     | `7`                                  | A sign-in ends this many days after signing in, however active (at most 90)                                                                                                                                                             |
| `PASSWORD_BREACH_CHECK`     | `true`                               | Refuse passwords found in data breaches (Have I Been Pwned). Tests turn it off                                                                                                                                                          |
| `EMAIL_DRIVER`              | `smtp`                               | `smtp` (Mailpit locally and on the temporary dev server) or `ses` (Amazon SES API; credentials from the AWS SDK's usual sources: the ECS task role on AWS, `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY` on the temporary dev server)     |
| `EMAIL_FROM`                | `Helpdesk <no-reply@helpdesk.local>` | Sender of system emails                                                                                                                                                                                                                 |
| `TICKET_EMAIL_DOMAIN`       | `mail.helpdesk.local`                | Domain of every workspace's own address (`acme@<domain>`): ticket email goes out from it and replies come back to it. Must be verified in SES before sending with `EMAIL_DRIVER=ses`; the temporary dev server uses `mail.<dev domain>` |
| `INBOUND_EMAIL_DRIVER`      | `none`                               | Where email to workspace addresses is picked up (F14), comma separated: `mailpit` (Mailpit's API), `s3` (real email SES receiving saved in `INBOUND_EMAIL_BUCKET`), or `none`                                                           |
| `MAILPIT_API_URL`           | `http://127.0.0.1:8025`              | Mailpit's API, for `INBOUND_EMAIL_DRIVER=mailpit`                                                                                                                                                                                       |
| `INBOUND_POLL_SECONDS`      | `10`                                 | How often the worker looks for new email                                                                                                                                                                                                |
| `INBOUND_EMAIL_MAX_MB`      | `25`                                 | Larger emails are dropped                                                                                                                                                                                                               |
| `INBOUND_EMAIL_BUCKET`      | (none; required for `s3`)            | The S3 bucket SES receiving writes incoming email to                                                                                                                                                                                    |
| `INBOUND_EMAIL_PREFIX`      | `inbound/`                           | The key prefix of those emails in the bucket                                                                                                                                                                                            |
| `INBOUND_EMAIL_REGION`      | `ap-south-1`                         | The bucket's region                                                                                                                                                                                                                     |
| `SMTP_HOST`                 | `127.0.0.1`                          | SMTP server (Mailpit locally)                                                                                                                                                                                                           |
| `SMTP_PORT`                 | `1025`                               | SMTP port                                                                                                                                                                                                                               |
| `SMTP_SECURE`               | `false`                              | TLS from the start of the SMTP connection                                                                                                                                                                                               |
| `SMTP_USER`                 | (none)                               | SMTP user name, if the server needs one                                                                                                                                                                                                 |
| `SMTP_PASS`                 | (none)                               | SMTP password (a secret: SSM `SecureString` on AWS)                                                                                                                                                                                     |
| `SES_REGION`                | `ap-south-1`                         | AWS region for `ses`                                                                                                                                                                                                                    |
| `SES_CONFIGURATION_SET`     | (none)                               | SES configuration set for sending events, if any                                                                                                                                                                                        |
| `EMAIL_ALLOWED_RECIPIENTS`  | (none)                               | Safety list for dev: when set, only these addresses (`name@x.com` or `@x.com`, comma separated) get real email through `EMAIL_DRIVER`; everyone else's goes to SMTP (the test mailbox). Leave empty in prod                             |
| `STORAGE_DRIVER`            | `local`                              | Where files (ticket attachments) are kept: `local` now, `s3` from Step 0b                                                                                                                                                               |
| `STORAGE_LOCAL_DIR`         | `./storage`                          | Folder for `local` storage (git-ignored)                                                                                                                                                                                                |
| `ATTACHMENT_MAX_MB`         | `20`                                 | Largest attachment, in MB (at most 50)                                                                                                                                                                                                  |

Added in later steps:

| Variable         | Step | Purpose         |
| ---------------- | ---- | --------------- |
| `STORAGE_DRIVER` | 1    | `local` or `s3` |

Full list: `.env.example`. The app refuses to start if a required variable is missing or invalid.

### Where settings and secrets live

| Environment              | Source                                                                                                                                                                                                                      |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Local                    | `.env` file (git-ignored)                                                                                                                                                                                                   |
| AWS (dev, prod)          | **SSM Parameter Store**, path `/helpdesk/<env>/api/<NAME>`, secrets stored as `SecureString`. ECS passes them to the container as environment variables, so the code is the same everywhere.                                |
| Temporary dev server     | `/srv/helpdesk/.env` on the server: created by `setup-server.sh` with fresh passwords, mode 600, never in Git. Compose passes it to the containers as environment variables.                                                |
| Database master password | **AWS Secrets Manager**, created and rotated automatically by Aurora. Used only by administrators and migrations setup, never by the running app. The app uses its own limited database user, whose credentials are in SSM. |

## Deployment

Infrastructure is defined in `infra/` with AWS CDK. Pipeline steps (`bitbucket-pipelines.yml`) are added at the move to the dev environment.

### Temporary dev server (no budget yet)

Until there is an AWS budget for the planned dev setup, dev runs on one Lightsail server (ARCHITECTURE.md, "Temporary dev setup"): `https://<dev domain>`, workspaces on `*.<dev domain>`, the test mailbox on `https://mail.<dev domain>`. The site itself is open (the owner's choice for now); only the test mailbox asks for the shared dev password, because it holds every password-reset and invite link. Everything is in `deploy/dev-lightsail/`; deploys run from a developer's computer and send only committed code.

**The server (created 2026-10-27):** Lightsail `<server name>` in ap-south-1a (Ubuntu 24.04, 2 GB), static IP `<static IP>` (`<static IP name>`), key pair `<key pair>`: its private key stays with the developer (the key file named in `deploy/dev-lightsail/dev.local.env`), never in Git. Firewall: 80 and 443 open; 22 open to all addresses with key-only login (password login is off), because the owner's network changes its outgoing address. DNS: A records for `<dev domain>` and `*.<dev domain>` in the Lightsail DNS zone.

**Rehearse on your computer first** (Docker Desktop; the same Compose file and Caddy, without HTTPS):

```bash
# in helpdesk-web
REHEARSAL_DIR=../helpdesk-api/deploy/dev-lightsail/.rehearsal-web bash deploy/dev-lightsail/deploy.sh
# in helpdesk-api
bash deploy/dev-lightsail/rehearse.sh
```

Open `http://helpdesk.localhost:8080`; the test mailbox is `http://mail.helpdesk.localhost:8080` (user `helpdesk`, password `rehearsal-only`). End-to-end tests against it: `E2E_BASE_URL=http://helpdesk.localhost:8080 E2E_MAILPIT_URL=http://mail.helpdesk.localhost:8080 E2E_SITE_USER=helpdesk E2E_SITE_PASSWORD=rehearsal-only npx playwright test` in helpdesk-web. `bash deploy/dev-lightsail/rehearse.sh down` stops it and deletes its data.

**First time on a new server** (Ubuntu 24.04; the SSH key file is set as `HELPDESK_DEV_SSH_KEY` in `dev.local.env`):

1. `HELPDESK_DEV_HOST=<static IP> bash deploy/dev-lightsail/deploy.sh`: copies the server files, gets the HTTPS certificate (see below), then stops and asks for the dev password.
2. On the server: `cd /srv/helpdesk && bash setup-server.sh`. It installs Docker, adds swap, creates `.env` from `env.example` with fresh database passwords and two-step key (mode 600), and schedules the nightly backup. Sign out and back in once so the `docker` group applies.
3. On the server, yourself: `bash /srv/helpdesk/set-site-password.sh` (asks twice for the shared dev password for the test mailbox, at least 12 characters, without showing it; only its hash is stored).
4. Run step 1 again, then deploy the web app (helpdesk-web README, "Deployment").

**Every deploy:** commit, then `HELPDESK_DEV_HOST=<static IP> bash deploy/dev-lightsail/deploy.sh` (or `HELPDESK_DEV_HOST=<dev domain>`: on an IPv6-only network, such as some mobile hotspots, the raw IPv4 address times out while the name works). It builds the image on the server, runs migrations, restarts the API and worker and waits for `/health`. Deploy the web app after the API when both changed.

**On the server** (`cd /srv/helpdesk`):

| Task                  | Command                                                                                                                                                                            |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Logs                  | `docker compose logs -f api` (or `worker`, `caddy`, `postgres`)                                                                                                                    |
| Status                | `docker compose ps`                                                                                                                                                                |
| Change a setting      | Edit `.env`, then `docker compose up -d`                                                                                                                                           |
| Backup now            | `bash backup.sh` (nightly at 02:30 by cron; the database dump and the uploaded files in `backups/`, kept 7 days)                                                                   |
| Restore a backup      | `docker compose stop api worker`, then `docker compose exec -T postgres pg_restore -U postgres -d helpdesk --clean --if-exists < backups/<file>.dump`, then `docker compose up -d` |
| Restore files         | `docker compose exec -T worker sh -c "rm -rf /app/storage/* && tar -C /app/storage -xzf -" < backups/files-<stamp>.tar.gz` (restore the dump with the same stamp too)              |
| Roll back the API     | Set `APP_VERSION` in `.env` to one of the last three tags (`docker image ls helpdesk-api`), then `docker compose up -d`. Migrations are not undone                                 |
| Roll back the web app | `ln -sfn releases/<commit> web/current` from `/srv/helpdesk/web` (the last three releases are kept)                                                                                |

**Email on dev:** workspace addresses end in `@in.<dev domain>` (`TICKET_EMAIL_DOMAIN`); that domain is verified in SES (Mumbai) with DKIM records in the dev DNS zone, so ticket email can go out from it. Real email is turned on with `bash set-aws-key.sh` on the server, run by the owner: it asks for the AWS key without showing it, keeps it only in `.env`, sets `EMAIL_DRIVER=ses` and the safety list (`EMAIL_ALLOWED_RECIPIENTS`). **Since 2026-10-28 the safety list is empty on dev (owner's decision), so every email dev sends goes out for real through SES**; the test mailbox no longer gets outgoing email. While it is empty, the end-to-end tests' made-up customer addresses would get real email and bounce on the SES account the company's other product shares, so **for a test run against dev turn the list on first and empty it again afterwards** (owner's rule): `EMAIL_ALLOWED_RECIPIENTS=@<company domain>` in `.env`, then `docker compose up -d api worker`; the same with an empty value to undo it. With the list on, email to anyone else goes to the test mailbox. System email comes from the company sender address, named with the product name, ticket email from the workspace address. Test email sent through the mailbox's send API to a workspace address still becomes a ticket. **Real email in:** an MX record sends mail for `in.<dev domain>` to SES receiving (Mumbai), whose active rule set `<receipt rule set>` (rule `<receipt rule>`, spam and virus scanning on) saves each email in the private bucket `<inbound bucket>` under `inbound/` (deleted after 7 days); the worker reads it there with `INBOUND_EMAIL_DRIVER=mailpit,s3`, so an email from any inbox to a workspace address becomes a ticket or a reply within about a minute. Test email through the test mailbox still works alongside.

**HTTPS certificate:** one Let's Encrypt certificate covers `<dev domain>` and `*.<dev domain>` (every workspace and the mailbox), so an address that is no workspace shows the app's own "workspace not found" page. A wildcard can only be proven through DNS, and only the developer's AWS access may change the dev DNS zone, so `certificate.sh` runs on the developer's computer: every deploy calls it, and it renews when the server's certificate has fewer than 30 days left (it lasts 90). It needs Docker and the developer's AWS credentials in `~/.aws`; lego adds a temporary `_acme-challenge` record, removes it, and only the certificate goes to the server (`/srv/helpdesk/certificates`). **If nobody deploys for about 60 days it expires**; run `HELPDESK_DEV_HOST=<static IP> bash deploy/dev-lightsail/certificate.sh` to renew (`--force` to renew early). With a DNS-only AWS key (Step 0b pending list) the server could renew by itself.

**Moving to the planned dev setup:** DEVELOPER_NOTES.md, section 6.

### Prod deploy checklist

- [ ] `infra/config/prod.ts` reviewed (instance counts, ACU limits, task counts)
- [ ] CDK deploy has written the DB writer and reader endpoints into SSM (`/helpdesk/prod/api/DATABASE_URL`, `DATABASE_READ_URL`)
- [ ] Prod-only secrets set in SSM: Stripe live keys, SES domain settings
- [ ] `/health` shows both database connections, email and storage as OK
- [ ] Release tagged on `release/production` (`vX.Y.Z`)
