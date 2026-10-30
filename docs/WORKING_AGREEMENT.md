# Helpdesk working agreement

How Helpdesk is built, agreed with the product owner. Read it with [ARCHITECTURE.md](ARCHITECTURE.md), [BUILD_PLAN.md](BUILD_PLAN.md) and [ENGINEERING_STANDARDS.md](ENGINEERING_STANDARDS.md); [DEVELOPER_NOTES.md](DEVELOPER_NOTES.md) holds the open questions, approved plans and notes by developer, and [design/README.md](design/README.md) every design (Figma, the Claude design canvas and its export). [BRANDING.md](BRANDING.md) explains the product name: one constant per repo, never typed anywhere else; no company or old product names in the repos. Anyone continuing the work, person or AI session, follows it.

## How each feature is built

1. **Propose the flow, then wait.** Before building a feature, propose its flow with honest recommendations and open questions. Build only after the owner approves it. No upfront specs or screen designs; flows are decided feature by feature.
2. **"What else this touches" in every proposal.** List the earlier screens and settings the new feature should change (for example a new form's fields in Settings → Fields, a new team column on the members page), and check them end to end from an admin's point of view before showing the feature for review.
3. **Honest suggestion first.** A question from the owner is not a decision. Give a recommendation, even one that disagrees, then decide together.
4. **Full stack in one feature:** backend, frontend, tests and docs together.
5. **Done gate plus sign-off.** A feature or step is Done only when it passes the done gate in BUILD_PLAN.md (tests, checks, desktop and phone screens, docs) and the owner has reviewed it and signed off. Quality over dates: no deadlines push out half-tested work.
6. **Mark Done and commit only after approval.** Then update BUILD_PLAN.md, commit both repos on `dev-deploy`, and push both to `origin`.
7. **Docs in the same change.** Update the READMEs, ARCHITECTURE.md (with a decisions log row) and ENGINEERING_STANDARDS.md when something changes. Mid-discussion, ask before editing the docs.
8. **Future plans go in the repo, never only in memory.** Anything planned for later that is not already in these docs (a Release 2 item, a follow-up, a postponed decision) goes into [DEVELOPER_NOTES.md](DEVELOPER_NOTES.md), section "Notes by developer", under the writer's name, saying which feature it came from: "While working on F11, we discussed …". Another developer or session on another account must be able to find it.

## Tests while building

- While building, run only the feature's own tests.
- At the end, run the full checks (`npm run check` in both repos) and the full end-to-end suite once.
- The API allows 5 sign-ups an hour from one network, so run sign-up end-to-end tests once per feature. If the limit is hit, say so and rerun those tests when it clears.
- **Run the end-to-end suite in batches** of at most 4 sign-up specs, restarting the API between batches, since its sign-up limit is kept in memory (locally `touch src/server.ts` in helpdesk-api; on dev `docker compose restart api` in `/srv/helpdesk`). Note which batches passed: after a pause or a failure, rerun only the batches that did not pass.
- **End-to-end against dev:** open an SSH tunnel to the dev Mailpit (`ssh -N -L 18025:<Mailpit container IP>:8025 ubuntu@<dev domain>`; the IP from `docker inspect` of the `mailpit` service) and set `E2E_BASE_URL=https://<dev domain>`, `E2E_MAILPIT_URL=http://localhost:18025`, `E2E_TICKET_EMAIL_DOMAIN=in.<dev domain>`. Use the host name, not the IP: on an IPv6-only network (some mobile hotspots) the IPv4 address times out while the name works; the same goes for `HELPDESK_DEV_HOST` when deploying.
- **UX checks (Step 5b on):** every screen a change touches is checked in a real browser at 390, 768, 1280 and 1440 px against a local workspace with realistic data: no sideways scrolling, one scrollbar per area, save buttons in view. The rules are in DEVELOPER_NOTES.md section 4, "Step 5b".
- **Slow or flaky runs:** check the computer's load first (other apps can hold the CPU at 100%, and the dev server then compiles pages slower than tests wait). A test that fails only under load and passes alone is not a code fault; say so in the report. If the local test database (`helpdesk_test`) has grown to many thousands of workspaces from earlier runs, reset it by migrating it down to 0 and up again; it holds only test data.
- **Testing against the dev server:** dev sends every email for real (its safety list is empty, owner's choice). Before end-to-end tests or anything else that emails made-up addresses there, turn the safety list on (`EMAIL_ALLOWED_RECIPIENTS=@<company domain>` in `/srv/helpdesk/.env`, then `docker compose up -d api worker`); afterwards empty it again the same way, also when the run fails, and say so in the report (owner, 2026-10-28).

## Safety rules

- **AWS:** nothing that creates, changes or deletes anything in the company AWS account (the shared dev account; its id is in `docs/real-names.local.md`) until the owner has seen exactly what will happen and said yes. Reading and listing is fine; say it is look-only.
- **Never connect to or change the company's existing MySQL databases.** Helpdesk has its own database.
- **Browsers:** never drive the owner's own Chrome. Use the built-in browser pane; Chrome only when the owner asks for it for a specific step.
- **Credentials:** never type the owner's passwords; they sign in themselves. Project test values on local hosts are fine.

## Handover

If the owner says "prepare for handover" in the middle of a feature:

1. Commit the work in progress to a `feature/*` branch and push it.
2. Add a "Where this stands" note to BUILD_PLAN.md: what is done, what is not, how to continue.

## Reminders due later

| When                                                      | Reminder                                                                                                                                                                                                                                                          |
| --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Start of Step 0b (move to AWS dev)                        | Assets to S3: frontend static files served from CloudFront with long cache headers; a public logo PNG for emails (F13, F15); user and workspace files on S3 (`STORAGE_DRIVER=s3`, private bucket, signed URLs); ask where the team keeps the master design files. |
| Step 7 quality pass, and the prod deploy checklist        | Write the support procedure for resetting two-step verification (owners without recovery codes, people in several workspaces): how support checks identity, who may reset, how it is logged.                                                                      |
| When Release 1 is done                                    | Show the full Release 2 list, basic reports and dashboard first.                                                                                                                                                                                                  |
| Start of the next release, or when load tests show a need | Decide whether to add Redis (ElastiCache) for jobs, Socket.IO and caching.                                                                                                                                                                                        |

## Step 0b pending list

Step 0b (move to AWS dev) waits on access. Pending items:

- **S7 branch protection** for `dev-deploy` and `release/production`, after the repos move from the personal Bitbucket workspace `hariprasathselvaraj` to the company Bitbucket workspace.
- **AWS from the AWS admin:** deploy rights (or CDK bootstrap plus a deploy role), the dev domain, a budget alert, and the Elastic IP limit.
- **Budget:** no AWS budget for the planned dev environment yet (2026-10-27); dev runs on the temporary Lightsail server meanwhile (ARCHITECTURE.md, "Temporary dev setup").
- **Dev protection:** no office/VPN IP allow-list for now. The temporary dev server is open for now (owner's choice, 2026-10-27), with a shared dev password only on its test mailbox; decide the protection for the planned dev before it is built (for example a shared password through a CloudFront Function).
- **Pipeline minutes:** the free personal Bitbucket workspace has about 50 minutes a month; raise at S9 (move to the company Bitbucket workspace or check its plan).
- **Sender address:** the company's existing sender address (in `docs/real-names.local.md`; there is no separate product address), with the product name as the sender name (owner's decision, 2026-10-27).
- **DNS key for the dev certificate:** an IAM user allowed only `lightsail:CreateDomainEntry` and `lightsail:DeleteDomainEntry` on the dev Lightsail DNS zone, so the temporary dev server renews its HTTPS certificate by itself instead of on deploys.
- **SES for dev:** a send-only key (only as the company sender address) for real sending to the dev safety list, and whether to use the company's SES configuration set or our own.
