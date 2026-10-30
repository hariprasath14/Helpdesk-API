# Helpdesk: Release 1 Build Plan

> Agreed 2026-10-24. We build **step by step, not by day**. A step is finished only when it passes the done gate below. The next step starts only after that.
> Each feature's product and screen flow is discussed and agreed with the product owner when we reach it, then built.
> Stack and standards: [ARCHITECTURE.md](ARCHITECTURE.md), [ENGINEERING_STANDARDS.md](ENGINEERING_STANDARDS.md).

---

## Done gate (every step)

A step is done only when **all** of these are true:

1. **Works end to end:** every feature in the step works fully, including edge cases and failures, not just the happy path.
2. **Tests pass:** unit, integration (real PostgreSQL) and end-to-end (Playwright) tests for the step, plus tenant-isolation, permission and read-after-write tests for every new endpoint, and audit log entries for every new admin or security change (from F5).
3. **Code checks pass:** lint, type check, and the security checks (secret scan, dependency audit, static analysis).
4. **Screens checked:** desktop and phone width, with loading, empty and error states, keyboard use and accessibility basics, all matching the design system.
5. **Docs updated (after asking):** `helpdesk-web/README.md` and `helpdesk-api/README.md` flows, `.env.example`, ARCHITECTURE.md and its decisions log if anything changed.
6. **Deployed to dev:** through the pipeline, and checked there (from Step 0b onward).
7. **Signed off:** the product owner has reviewed the step and approved it.

---

## Steps

| Step | Name                    | Status      |
| ---- | ----------------------- | ----------- |
| 0    | Foundations             | Done        |
| 0b   | Move to AWS dev         | In progress |
| 1    | Core data               | Done        |
| 2    | Channels                | Done        |
| 3    | Rules engine            | Done        |
| 4    | SLAs                    | Done        |
| 5    | Agent experience        | Done        |
| 5b   | UX upgrade              | Done        |
| 6    | Billing and branding    | Not started |
| 7    | Quality pass and report | Not started |

### Progress checklist

Each item moves through **Not started → In progress → Waiting for review → Done**. A feature (F) starts by agreeing its flow with the product owner and is Done only after their sign-off. Setup items (S) have no flow to agree; the product owner reviews the result.

| #   | Item                                                                   | Step | Status      |
| --- | ---------------------------------------------------------------------- | ---- | ----------- |
| S1  | Backend repo base (`helpdesk-api`)                                     | 0    | Done        |
| S2  | Database setup (Docker Postgres, Mailpit, RLS, migrations)             | 0    | Done        |
| S3  | Backend test setup (real Postgres, tenant isolation, read-after-write) | 0    | Done        |
| S4  | API contract (Zod → OpenAPI)                                           | 0    | Done        |
| S5  | Frontend repo base (`helpdesk-web`)                                    | 0    | Done        |
| S6  | Design system and app shell                                            | 0    | Done        |
| F1  | Sign-up and workspace                                                  | 0    | Done        |
| F2  | Login and password                                                     | 0    | Done        |
| F3  | Two-factor authentication                                              | 0    | Done        |
| F4  | Agents and roles                                                       | 0    | Done        |
| F5  | Audit log                                                              | 0    | Done        |
| S7  | Git and Bitbucket                                                      | 0b   | In progress |
| S8  | AWS infrastructure (CDK)                                               | 0b   | Not started |
| S9  | Bitbucket Pipelines                                                    | 0b   | Not started |
| S10 | Temporary dev server (Lightsail, no budget yet)                        | 0b   | Done        |
| F6  | Custom fields engine                                                   | 1    | Done        |
| F7  | Contacts and companies                                                 | 1    | Done        |
| F8  | Teams                                                                  | 1    | Done        |
| F9  | Tickets                                                                | 1    | Done        |
| F10 | Ticket list                                                            | 1    | Done        |
| F11 | Ticket detail and conversation                                         | 1    | Done        |
| F12 | Manual assignment                                                      | 1    | Done        |
| F13 | Outgoing email and "from" address                                      | 2    | Done        |
| F14 | Email-to-ticket                                                        | 2    | Done        |
| F15 | Customer notification emails                                           | 2    | Done        |
| F16 | Web form                                                               | 2    | Done        |
| F17 | Rules engine core                                                      | 3    | Done        |
| F18 | Assignment rules and round-robin                                       | 3    | Done        |
| F19 | Event-based automation                                                 | 3    | Done        |
| F20 | Time-based automation                                                  | 3    | Done        |
| F21 | Canned responses                                                       | 3    | Done        |
| F22 | Business hours and holidays                                            | 4    | Done        |
| F23 | SLA policies and countdowns                                            | 4    | Done        |
| F24 | Warning and escalation                                                 | 4    | Done        |
| F25 | Notification center                                                    | 4    | Done        |
| F26 | Live updates                                                           | 5    | Done        |
| F27 | Collision detection                                                    | 5    | Done        |
| F28 | Merge and split                                                        | 5    | Done        |
| F29 | Home page                                                              | 5    | Done        |
| F30 | Plans, trials, payments, invoices                                      | 6    | Not started |
| F31 | Seat limits                                                            | 6    | Not started |
| F32 | Branding                                                               | 6    | Not started |

Decided with the owner on 2026-10-27 (were open questions): the workspace's "from" address setting moves from Step 6 to F13; F15 customer notification emails stay in Release 1; the "assigned to you" email comes with F13 and its in-app alert with F25; searching inside descriptions and replies is built with F14. Details in DEVELOPER_NOTES.md.

**Branding change (2026-10-30):** the product is renamed to the placeholder "Helpdesk", set in one constant per repo ([BRANDING.md](BRANDING.md)), and every company and old product name is removed from the repos. Checked locally, not on dev. Published to GitHub (`Helpdesk-API`, `Helpdesk-Web`) as a fresh history without the old names; the Bitbucket repos are unchanged. Before deploying it to the dev server, it needs the one-time move in `docs/real-names.local.md` (on the owner's computer). F30's flow is proposed and waits for the owner's approval.

**Where this stands (2026-10-30):** branch `dev-deploy` in both repos, everything committed and pushed; the dev server runs API `28dbef8` and web `2a4ae2e`. Steps 2 to 5 (F13 to F29) are Done and signed off (2026-10-28). **Step 5b, the UX upgrade (U1 to U6), is Done: the owner reviewed it on dev and signed it off on 2026-10-30 with no changes.** It includes the one functional change the owner asked for, a colour theme per person (Your account → Appearance, `users.theme`). **Next:** Step 6 (billing and branding, F30 to F32): its plan is approved (DEVELOPER_NOTES.md section 4, "Step 6"); each feature's detailed flow is proposed and approved before it is built. Billing needs the owner's Stripe test account (test-mode keys only); branding can start without it. Designs and how to open them from another account: [design/README.md](design/README.md).

**Step 0b is waiting on access (decided 2026-10-25):** the code is on Bitbucket (personal workspace `hariprasathselvaraj` for now). S7 branch protection waits for the move to the company Bitbucket workspace; S8 and S9 deploys wait for AWS deploy rights, the dev domain and a budget alert from the AWS admin. Step 1 goes ahead meanwhile; done-gate point 6 ("deployed to dev") stays pending for each step and is caught up once Step 0b is done.

**Temporary dev setup (decided 2026-10-27):** there is no AWS budget for dev yet, so dev runs on one Lightsail server with the owner's current access (S10, see ARCHITECTURE.md "Temporary dev setup"). Done-gate point 6 is checked on that server until the planned dev exists. S8 and S9 stay as planned and start once there is budget.

**Done-gate point 6 caught up (2026-10-27):** S10 signed off by the owner. Steps 0 and 1 are deployed to the temporary dev server from `dev-deploy` and checked there: health of both database connections, sign-up through the confirmation email in the test mailbox to signed in, HTTPS on the main, workspace and mailbox addresses, and an unknown workspace address reaching the app. Deployed with the scripts in `deploy/dev-lightsail/`, not yet a pipeline (S9).

### Step 0: Foundations

- **Both repos:** `helpdesk-web` and `helpdesk-api` with the standard folder structure, TypeScript strict, ESLint, Prettier, Husky pre-commit hooks, conventional commits.
- **Backend base:** Fastify server and worker entry points; config loading and validation (`DATABASE_URL`, `DATABASE_READ_URL` and the rest); central error handler; structured logging; security headers; rate limiting; `/health` (reports both DB connections).
- **Database:** Docker Compose (PostgreSQL + Mailpit); Sequelize writer and reader instances; database roles (app, migrator, read-only); migrations and seed data; row-level security from the first tenant table; transaction-per-request with `SET LOCAL app.workspace_id`.
- **API contract:** Zod route schemas → OpenAPI spec at `/docs/json`; frontend `npm run api:generate` producing the typed client.
- **Frontend base:** Vite + React app; design tokens (Help Teal, swappable), Satoshi font, core components; app shell (navy sidebar, top bar, breadcrumbs); shared loading, empty, error, no-access, toast, confirm-dialog and drawer patterns; phone layout.
- **Multi-tenancy:** sign-up creates a workspace; subdomain routing (`acme.localhost`); workspace resolved on every request.
- **Authentication:** sign-up with email verification, login, logout, password reset, password policy, authenticator-app 2FA with recovery codes, server-side sessions in secure cookies, brute-force protection.
- **Agents and roles:** invite agent, accept invite, roles Admin / Supervisor / Agent with permission checks on every endpoint.
- **Audit log:** the table and the write path, used by every later step.
- **Tests:** the test setup for both repos, the tenant-isolation test helper, and the read-after-write test with a simulated lagging reader.

### Step 0b: Move to AWS dev

**Now (temporary, no budget yet):** S10, one Lightsail server running the whole dev environment with Docker Compose (Caddy, API and worker, PostgreSQL, Mailpit) at `<dev domain>`, deployed with scripts from a developer's computer. The plan below is unchanged and replaces it once there is budget.

**Planned:**

- AWS CDK app in `helpdesk-api/infra` with `config/dev.ts` and `config/prod.ts`.
- Dev stacks: VPC with private subnets and NAT Gateway, Aurora PostgreSQL Serverless v2 (1 instance, ACU capped), ECS Fargate API and worker (ARM), ALB restricted to the office/VPN IPs, S3 + CloudFront for the frontend, S3 for files, SES, SSM parameters (DB endpoints written automatically), CloudWatch logs (14 days), GuardDuty, AWS Budget alerts.
- **Bitbucket Pipelines** for both repos: `helpdesk-web` (install, lint, type check, test, build, upload to S3, CloudFront invalidation) and `helpdesk-api` (install, lint, type check, test, security scans, Docker image to ECR, migrations, ECS deploy). `dev-deploy` deploys to dev.
- **API contract checks:** the `helpdesk-api` pipeline compares the new `openapi.json` with the one on the target branch (oasdiff) and fails on a breaking change; the `helpdesk-web` pipeline checks that the committed API client matches the backend's current contract and fails with "regenerate your API client" if not (exact source of the contract decided in this step).
- **Needed from the product owner:** access to the company dev AWS account, Bitbucket workspace and repo creation, and the office/VPN IP addresses.

### Step 1: Core data

- Contacts and companies with custom fields.
- Teams, and agents in teams.
- Tickets: per-workspace number, statuses (Open, Pending, Waiting on customer, Resolved, Closed), priority, type, tags, custom fields.
- Ticket list: filters, search, sorting, saved views, cursor pagination.
- Ticket detail: conversation timeline, attachments (storage adapter), reply, forward, private notes, @mentions.
- Manual assignment.

### Step 2: Channels

- Outgoing email through the email adapter (Mailpit locally, SES on AWS), with the workspace's "from" address (its setting, moved here from Step 6), branded templates and threading headers. Sends the replies and forwards queued since F11, and the "assigned to you" email (F12).
- Email-to-ticket: ingest (simulated locally, SES → S3 → worker on AWS), threading of replies onto the same ticket, de-duplication by `Message-ID`, mail-loop and auto-reply protection, HTML sanitizing.
- Search inside ticket descriptions and replies: a full-text index used through one SECURITY DEFINER search function that limits results to the signed-in workspace itself (row-level security stops the app role using the index directly).
- Embeddable web form that creates tickets.
- **Use case covered:** customer emails "Employees can't mark attendance" → Ticket #1042, assigned to Ravi, full history visible.

### Step 3: Rules engine

- Condition and action builder (when this happens + these conditions match → do this).
- Assignment rules: keyword → team, customer field (Plan = Premium) → senior agents, default team; round-robin within a team.
- Event-based automation.
- Time-based automation (worker jobs).
- Canned responses with placeholders.
- **Use cases covered:** "billing" → Accounts team; Premium → senior agents; round-robin; "Password reset steps" canned reply; 3-day reminder and 7-day auto-close.

### Step 4: SLAs

- Business hours and holidays per workspace (workspace timezone).
- SLA policies by priority; due times calculated and shown as countdowns on tickets.
- Warning before breach and escalation on breach (notify, mark overdue, reassign) through worker jobs.
- Notification center: email and in-app, including @mentions (F11) and "assigned to you" (F12).
- **Use case covered:** urgent tickets need a reply within 1 hour, the team lead is alerted at 50 minutes, the ticket is marked overdue and reassigned at 1 hour.

### Step 5: Agent experience

- Live updates over Socket.IO (Postgres adapter): ticket list refresh, in-app notifications.
- Collision detection ("Ravi is replying…").
- Merge and split tickets.
- Home page (added 2026-10-28): the admins' setup checklist and each person's work counts.

### Step 5b: UX upgrade (added 2026-10-28)

The owner asked for every screen to be checked and improved for help desk UX before Step 6, **without changing any flow or functionality**. Until now screens were built straight from the coded components, with no per-screen design.

1. **UX audit:** every feature of Steps 0 to 5, desktop and phone, with a realistic demo workspace; findings per step ranked High, Medium and Low; anything that would need new functionality is parked, not designed. The owner approves which findings to design. **Done 2026-10-28:** 61 screenshots of every feature and state; 5 defects and the findings per step in DEVELOPER_NOTES.md section 4; the owner approved designing all of them.
2. **Figma, one step at a time:** foundations (type, density, status, priority and SLA styles, shared components) first, then a full frame only where a layout is unique, Before next to After; repeated patterns get a note instead of a frame. File: `HFKoMs9DW2QXagSizJnBXm`. Each step's designs are approved before the next.
3. **Build the approved designs** (all designs approved 2026-10-29; [docs/design/README.md](design/README.md)). In groups, each like a feature: build, that group's tests, UX checks at 390, 768, 1280 and 1440 px (one scrollbar per area, nothing cut off, save buttons in view, no change in behaviour), docs, commit and push `dev-deploy`, deploy to dev, "Waiting for review". Step 6 (billing and branding) waits for this step, so it is built in the new style.

| #   | Group                                                                                                                                                                                                  | Status |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------ |
| U1  | Shared: the 5 audit defects, fixed app frame with scrolling inside areas, thin scrollbars, toasts bottom right, unsaved-changes guard, grouped settings menu with icons and the settings overview page | Done   |
| U2  | Ticket list: compact rows, Due column, views in the title menu, table scrolling inside with a pinned header; phone cards and filter sheet                                                              | Done   |
| U3  | Ticket page and new ticket: one-band header, presence avatars, timeline styles, reply bar, requester card, compact properties with the Update bar; phone tabs; new ticket in two columns               | Done   |
| U4  | Home (due soonest, latest notifications), contact and company pages, notification panel                                                                                                                | Done   |
| U5  | Settings screens: rules editor as sentences, SLA targets table, fields, email, Your account tabs with Appearance (theme switch), phone settings                                                        | Done   |
| U6  | Sign-in layout family, public web form, customer email layout                                                                                                                                          | Done   |

### Step 6: Billing and branding

- Stripe (test mode): plans, trials, per-agent seats, subscriptions, invoices, signature-verified webhooks.
- Seat limits enforced by plan; trial ending reminders.
- Branding settings: logo and colors (the custom "from" address moved to F13).
- **Needed from the product owner:** a Stripe account for the business (test mode is enough for this step).

### Step 7: Quality pass and report

- Full end-to-end run of every Release 1 use case on dev.
- Security review against OWASP ASVS Level 2, OWASP ZAP baseline scan on dev, dependency and image scans clean.
- Interface review across every screen (states, phone width, accessibility, consistent wording).
- Load test to measure per-task limits (WebSocket connections, requests per second).
- Backup and restore test.
- The stack- and application-level report (see ARCHITECTURE.md section 9).
- The external penetration test happens before prod, after this step.

---

## Release 1 use cases (must all pass by Step 7)

| #   | Use case                                                                                      | Step |
| --- | --------------------------------------------------------------------------------------------- | ---- |
| 1   | Email "Can't mark attendance" → Ticket #1042 → Ravi, with visible history                     | 2    |
| 3   | "billing" → Accounts team; Premium → senior agents; round-robin                               | 3    |
| 4   | Urgent reply within 1 hour; team lead alerted at 50 minutes; overdue and reassigned at 1 hour | 4    |
| 5a  | "Password reset steps" canned reply                                                           | 3    |
| 5b  | Waiting on customer 3 days → reminder; 7 days → auto-close                                    | 3    |

Use case 2 (WhatsApp and Facebook messages as tickets) is in Release 2.
