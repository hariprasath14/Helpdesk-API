# Branding: the product name in one place

"Helpdesk" is a placeholder until the product's real name is chosen. The name customers and agents
see is set in **one constant per repo**; everything else reads it from there.

## Rename the product (about 2 minutes)

1. In `helpdesk-api/src/product.ts`, set `PRODUCT_NAME` to the new name.
2. In `helpdesk-web/src/product.ts`, set the same name.
3. Check: `npm run check` in both repos (the tests read the same constant, so they follow the name).

That is all. Nothing to regenerate: the API contract (`openapi.json`) and the web's API client do
not contain the name. Deploy as usual and every place below shows the new name.

## What follows the name

| Where               | What                                                                                                                                                                         |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Web app             | The logo's wordmark (live text beside the mark), the browser tab title, sign-in and sign-up, welcome and help texts, "Powered by …" on the web form, the recovery codes file |
| System emails (API) | Subjects, texts and the header of sign-up, password, two-step, invitation and assignment emails                                                                              |
| Email sender        | The sender name, when `EMAIL_FROM` is a bare address (`noreply@…`); an `EMAIL_FROM` with its own name (`Support <noreply@…>`) is used as it is                               |
| Authenticator apps  | The account label shown in Google Authenticator and similar apps (for new setups)                                                                                            |
| Audit log           | The name of the "system" actor (for example a sign-in lock)                                                                                                                  |
| Workspace addresses | The product's name is a reserved workspace address                                                                                                                           |

## What stays "helpdesk" (on purpose)

`helpdesk` is also the project's neutral internal name, so a rename never touches it: the repos
(`helpdesk-api`, `helpdesk-web`), package names, database roles and names (`helpdesk_app`,
`helpdesk_migrator`, `helpdesk_readonly`, `helpdesk`, `helpdesk_test`), cookies
(`helpdesk_session`, `helpdesk_2fa`, `helpdesk_trusted`), browser storage keys, settings
(`HELPDESK_DOMAIN`, `HELPDESK_DEV_*`), Docker names and the docs. Changing those would sign
everyone out and need database migrations, for no change customers can see.

## Not covered by the constant

- **The logo mark** (support agent in a chat bubble): `helpdesk-web/src/assets/brands/<id>/mark.svg`
  and the icons in `helpdesk-web/public/brands/<id>/`. It has no letters, so a rename doesn't need it.
- **Domains and email addresses:** the app's domain (`APP_PUBLIC_URL`, `HELPDESK_DOMAIN`,
  `VITE_APP_DOMAIN`), the ticket email domain (`TICKET_EMAIL_DOMAIN`) and the sender address
  (`EMAIL_FROM`) are settings per environment. A new domain also needs DNS, a certificate and an
  SES identity.
- **Figma and the design canvas** still show the old name and wordmark; the images in
  `docs/design/` (screenshots and the UX audit) too. Update them when the real name and logo are
  designed.
- **Customer branding** (F32, a workspace's own logo on its emails and web form) is a separate
  feature and does not change the product's name.

## Real names

The company's and the dev server's real names (domain, AWS resources, accounts) are not in the
committed files. On the owner's computer they are in `docs/real-names.local.md` and
`deploy/dev-lightsail/dev.local.env` (both repos), which Git ignores. Copy
`deploy/dev-lightsail/dev.local.env.example` to start one on another computer.
