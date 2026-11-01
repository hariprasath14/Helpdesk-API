# Branding: the product name and look

The product is called **Helpnest** (chosen by the owner, 2026-11-01). The name customers and agents
see is set in **one constant per repo**; everything else reads it from there. The look (logo, font
and colour themes) is described under "The look" below.

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

## The look (2026-11-01)

- **Logo mark:** a white chat bubble with three dots resting in a nest (two curved strands) on a
  rounded tile in the brand's 600 shade. One SVG per theme in
  `helpdesk-web/src/assets/brands/<id>/mark.svg`; the browser tab icon and phone home-screen icon
  are in `helpdesk-web/public/brands/<id>/`. It has no letters, so a rename doesn't need it.
- **Wordmark:** the product name as live text in Nunito ExtraBold, in the brand's 900 shade on
  white (the `wordmark` token) and white on the dark sidebar.
- **Font:** Nunito, from the npm package `@fontsource-variable/nunito` (SIL Open Font License, free
  for any use, including customers' content).
- **Colour themes:** **Forest** (default, 600 `#2B7343`) and **Indigo** (600 `#4F46E5`). Each
  person picks one in Your account → Appearance (`users.theme`); empty uses the deployment's
  `VITE_BRAND`. Every text and background pair passes WCAG AA; the values and contrast notes are in
  `helpdesk-web/src/styles/tokens.css`.
- **System emails** use the Forest button (`#2B7343`) and header text (`#12301D`).
- **Figma:** the owner's file (key `ZdJJBvC9LkWEAxbazvmbK5`) has the new logo, Nunito and the
  Forest colours; details in [design/README.md](design/README.md).

## What stays "helpdesk" (on purpose)

`helpdesk` is also the project's neutral internal name, so a rename never touches it: the repos
(`helpdesk-api`, `helpdesk-web`), package names, database roles and names (`helpdesk_app`,
`helpdesk_migrator`, `helpdesk_readonly`, `helpdesk`, `helpdesk_test`), cookies
(`helpdesk_session`, `helpdesk_2fa`, `helpdesk_trusted`), browser storage keys, settings
(`HELPDESK_DOMAIN`, `HELPDESK_DEV_*`), Docker names and the docs. Changing those would sign
everyone out and need database migrations, for no change customers can see.

## Not covered by the constant

- **Domains and email addresses:** the app's domain (`APP_PUBLIC_URL`, `HELPDESK_DOMAIN`,
  `VITE_APP_DOMAIN`), the ticket email domain (`TICKET_EMAIL_DOMAIN`) and the sender address
  (`EMAIL_FROM`) are settings per environment. A new domain also needs DNS, a certificate and an
  SES identity.
- **The design canvas and the images in `docs/design/`** (screenshots and the UX audit) still show
  the earlier name, logo and colours. They show layout only; the app and Figma are the reference
  for the look.
- **Customer branding** (F32, a workspace's own logo on its emails and web form) is a separate
  feature and does not change the product's name.

## Real names

The company's and the dev server's real names (domain, AWS resources, accounts) are not in the
committed files. On the owner's computer they are in `docs/real-names.local.md` and
`deploy/dev-lightsail/dev.local.env` (both repos), which Git ignores. Copy
`deploy/dev-lightsail/dev.local.env.example` to start one on another computer.
