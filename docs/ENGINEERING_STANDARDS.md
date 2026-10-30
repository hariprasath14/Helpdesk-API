# Helpdesk: Engineering Standards

> Applies to both `helpdesk-api` and `helpdesk-web`. Every change follows these rules. Agreed 2026-10-24; update this file when a rule changes and log it in ARCHITECTURE.md.

---

## 1. Database

### Read and write connections

- **One database per environment, two connections:** `db.writer` and `db.reader` are two Sequelize instances (two connection pools) configured from `DATABASE_URL` and `DATABASE_READ_URL`. **Both are required in every environment.** Locally both point to the same database; in dev and prod they are the Aurora writer and reader endpoints. Aurora's reader endpoint routes to the writer when the cluster has no reader instance (dev) and to the reader instance when it has one (prod), so the settings have the same shape everywhere.
- We don't use Sequelize's built-in `replication` option, because tenant isolation needs `SET LOCAL app.workspace_id` inside a transaction, and Sequelize always sends transactions to the writer. A separate reader instance lets read-only transactions run on the replica with row-level security still enforced.
- **Writer:** all writes, and any read that must see data just written (for example the response after creating a ticket).
- **Reader:** heavy read-only queries such as ticket lists, search, and later reports. Replicas can lag by a fraction of a second, so never read from the replica straight after a write in the same flow.
- Only prod's cluster has a reader instance. Adding one to dev later is an AWS change only (`infra/config/dev.ts`); no settings or code change.
- The CDK stacks write both endpoints into SSM automatically; nobody types them by hand. `/health` reports the status of both connections.
- **Read-after-write test:** an automated integration test runs with a reader connection that deliberately returns stale data (a simulated lagging replica) and checks that every create/update flow reads its result from the writer. It runs in the pipeline, so replica-lag bugs are caught without a dev reader.

### Sequelize usage

- Schema changes **only through migrations.** Never `sequelize.sync()` outside tests.
- Migrations are reversible (`up` and `down`) and backward-compatible (expand, deploy, then contract), so deploys never need downtime.
- Typed models (`InferAttributes`, `InferCreationAttributes`); `underscored: true`; timestamps on every table.
- Multi-step writes run inside one transaction.
- Raw SQL only with bound parameters (`replacements` or `bind`), never string concatenation.
- Avoid N+1 queries: load related data with `include` or a single batched query; list endpoints are reviewed for query count.
- Database roles: `helpdesk_app` (read/write, no DDL, no `BYPASSRLS`), `helpdesk_migrator` (owns the schema), `helpdesk_readonly` (reader).
- SSL required on every database connection outside local.

### Indexing

- Every tenant table has indexes that **start with `workspace_id`**, matching the real filters, for example `(workspace_id, status, updated_at DESC)` on tickets.
- Every foreign key has an index.
- Unique constraints are scoped to the workspace, for example `UNIQUE (workspace_id, ticket_number)`.
- No trigram, JSONB or full-text GIN indexes on tenant tables for the app's queries: under row-level security Postgres can't use them (`ILIKE`, `@>` and `@@` are not leakproof), so they only slow writes. Search scans one workspace through its `workspace_id` index; a faster path (a SECURITY DEFINER search function or a search service) is a decision when a feature needs it (ARCHITECTURE.md decisions, 2026-10-26).
- Partial indexes for hot subsets, for example open tickets only.
- Indexes are created in migrations; in prod with `CREATE INDEX CONCURRENTLY`.
- New list or search queries are checked with `EXPLAIN ANALYZE` against realistic seed data. `pg_stat_statements` is on in dev and prod to find slow queries.

### Data conventions

- Times stored in UTC (`timestamptz`); workspace timezone used for display and business hours.
- Primary keys are UUIDs (v7, time-ordered); ticket numbers are per-workspace sequences.
- Soft delete (`deleted_at`) for tickets, contacts and companies; hard delete only through a documented data-deletion flow.

---

## 2. Configuration and secrets

- **All config comes from environment variables,** validated at startup (Zod). The app refuses to start if anything is missing or invalid.
- **Local:** `.env` (git-ignored); `.env.example` documents every variable.
- **AWS:** **SSM Parameter Store**, path `/helpdesk/<env>/<service>/<NAME>`, secrets as `SecureString` (KMS-encrypted). ECS injects them as environment variables, so the code is the same everywhere.
- **Temporary dev server (no budget yet, 2026-10-27):** settings and secrets live in `/srv/helpdesk/.env` on the server, generated there (mode 600) and never copied into Git, until dev moves to the planned AWS setup (ARCHITECTURE.md, "Temporary dev setup").
- The database master password is managed by RDS in Secrets Manager (automatic rotation); the app's own credentials live in SSM.
- Never commit secrets. Secret scanning (gitleaks) runs before commit and in the pipeline.

---

## 3. Code structure and style

- TypeScript **strict mode**; no `any` without a comment explaining why.
- ESLint + Prettier, enforced by a pre-commit hook (Husky + lint-staged) and in the pipeline.
- **Backend layers:** route (HTTP, validation) → service (business logic) → model (database). Routes never query the database directly; services never touch HTTP objects.
- **Frontend:** feature folders; shared components only from the design system; no hard-coded colors (tokens only).
- Small, focused functions and files; names describe purpose; comments explain _why_, not _what_.
- Follow the folder layout in ARCHITECTURE.md section 3a. No custom or clever structures.

---

## 4. API design

- Versioned paths: `/api/v1/...`.
- Every route has Zod schemas for params, query, body and response; these generate the OpenAPI spec.
- Consistent error format: `{ error: { code, message, details? } }`. No stack traces or internal details sent to clients.
- Cursor-based pagination for lists; maximum page size enforced.
- Idempotency keys on create operations that clients may retry (for example web-form submissions).
- Request size limits on every route; stricter limits on uploads.

### API changes and deployment order

- **The contract:** `openapi.json` is generated from the route schemas (`npm run openapi`) and committed with every route change. `helpdesk-web` generates its typed client from it on the developer's machine (`npm run api:generate`) and commits the result; pipelines build committed code and never generate.
- **Generate from what will be deployed:** the frontend regenerates from `helpdesk-api` `dev-deploy` (or `release/production`) after the backend change is merged, never from an unmerged backend branch.
- **The backend always deploys first,** and every backend release must keep working with the frontend that is already live.
- **Additive changes** (new endpoint, new optional field or input) need no frontend deploy; the frontend adopts them when it is ready.
- **Breaking changes** (removing or renaming a field, a newly required input, a changed type) are never made in one step. Expand, then contract: add the new shape alongside the old and deploy; move the frontend and deploy; remove the old shape in a later backend release.
- **`/api/v1` is never broken.** A truly incompatible redesign becomes `/api/v2`, and v1 keeps running until the frontend has moved.

---

## 5. Errors and logging

- One central error handler; typed application errors (`NotFound`, `Forbidden`, `Validation`, `Conflict`).
- Structured JSON logs (pino, built into Fastify) with a request ID and workspace ID on every line.
- **Never log** passwords, tokens, session IDs, full email bodies or attachments; personal data is redacted by the logger configuration.
- Unexpected errors trigger CloudWatch alarms in dev and prod.

---

## 6. Security practices

Baseline: **OWASP ASVS Level 2** and the OWASP Top 10.

- **Tenant isolation:** application scoping plus PostgreSQL row-level security; automated cross-tenant tests on every endpoint.
- **Auth:** Argon2id passwords; HttpOnly, Secure, SameSite cookies; session ID rotated on login; idle and absolute session timeouts; all sessions revoked on password change; TOTP 2FA; re-authentication for sensitive admin actions (changing roles, billing, deleting data).
- **Input and output:** server-side validation everywhere; email HTML sanitized; strict Content-Security-Policy; React's escaping kept (`dangerouslySetInnerHTML` only with sanitized content).
- **HTTP:** Helmet security headers; CORS allowlist only; CSRF tokens; rate limiting on auth and public endpoints.
- **Files:** type and size checks, private storage, short-lived signed URLs; virus scanning added before prod.
- **Outbound requests** (webhooks, Release 2): block private IP ranges to prevent SSRF.
- **Least privilege:** separate database roles; one IAM role per container with only the permissions it needs.
- **Audit log:** every change to members, roles, security or workspace settings (and later rules, SLAs, deletions, exports) records an entry with `recordAudit()` in the same transaction, and has a test that checks the entry. Never put secrets in audit details.
- **Data protection:** encryption in transit and at rest; workspace data export and deletion supported, as needed for India's DPDP Act and GDPR.
- **AWS:** CloudTrail and GuardDuty on; WAF in front of CloudFront and the load balancer before prod; database in private subnets.

### Security checks in the pipeline

| Check                      | Tool                                            |
| -------------------------- | ----------------------------------------------- |
| Secret scanning            | gitleaks                                        |
| Dependency vulnerabilities | `npm audit`, Renovate for updates               |
| Static code analysis       | ESLint security rules, Semgrep                  |
| Container image scan       | Amazon ECR scanning / Trivy                     |
| Dynamic scan of dev        | OWASP ZAP baseline                              |
| Before prod                | Manual OWASP review + external penetration test |

---

## 7. Testing

- Unit tests for services and the rules and SLA engines.
- Integration tests against a real PostgreSQL (Docker), including row-level-security and permission tests.
- **Every endpoint that touches workspace data** has a tenant-isolation test (`expectTenantIsolation()`): another workspace gets `404` for single items and never sees the data in lists.
- **Every endpoint that creates or changes data** has a read-after-write test (`expectReadAfterWrite()` with the lagging test reader).
- **Every endpoint** has permission tests for each role (from F4), with `expectOnlyRoles()` from `src/test/accounts.ts`.
- Every migration's `down` is exercised on each test run (undo and reapply on the replica test database).
- Coverage minimums: 90% statements, functions and lines, 75% branches; raised over time, never lowered.
- End-to-end tests (Playwright) for every Release 1 use case.
- Pipeline blocks merging when tests, coverage, type checks, lint or security checks fail.

---

## 8. Git and review (Bitbucket)

Long-lived branches, each deployed automatically by its pipeline:

| Branch               | Deploys to | Purpose                                                               |
| -------------------- | ---------- | --------------------------------------------------------------------- |
| `dev-deploy`         | dev        | Default branch; finished features are merged here                     |
| `release/production` | prod       | Live; promoted from `dev-deploy` and tagged with a version (`v1.2.0`) |

Short-lived branches:

- `feature/<short-name>`: created from `dev-deploy`, merged back into `dev-deploy`. Used for features and fixes alike.
- An urgent live fix is a `feature/*` branch created from `release/production`, merged into `release/production`, then merged back into `dev-deploy` so the two never drift apart.

Flow: `feature/*` → `dev-deploy` → `release/production`. Code only moves forward through pull requests, never by committing directly to a long-lived branch (branch protection on).

- Every change goes through a pull request with at least one review and green pipeline checks.
- Conventional commit messages (`feat:`, `fix:`, `chore:`, `docs:`).
- Lockfiles committed; dependency versions pinned.

---

## 9. Frontend quality

- Accessibility to WCAG 2.1 AA: keyboard navigation, focus states, labels, color contrast.
- Every screen handles loading, empty and error states; error boundaries per feature.
- Responsive down to phone width.
