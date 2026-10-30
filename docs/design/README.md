# Helpdesk designs

Where every Helpdesk design lives and how to continue it from any account. Start here before changing a screen.

## Status

| What                                                                                 | Status                | Where                                                                                                      |
| ------------------------------------------------------------------------------------ | --------------------- | ---------------------------------------------------------------------------------------------------------- |
| Design system (colours, type, components, logo, app shell)                           | Done, used by the app | Figma, pages "Design system", "Logo", "App shell"                                                          |
| UX audit of Steps 0 to 5 (61 screenshots, findings)                                  | Done 2026-10-28       | [ux-audit-2026-10-28.pdf](ux-audit-2026-10-28.pdf)                                                         |
| UX upgrade foundations (Step 5b)                                                     | Approved 2026-10-29   | Figma board "UX · 1 Foundations"; images in [figma/](figma/)                                               |
| UX upgrade screens (Step 5b): agent workspace, settings, sign-in and customer-facing | Approved 2026-10-29   | Claude Design canvas; exported to [ux-canvas/](ux-canvas/) with images in [ux-canvas/png/](ux-canvas/png/) |
| Build rules for every screen (scrolling, tables, save bars, screen sizes)            | Approved 2026-10-29   | [DEVELOPER_NOTES.md](../DEVELOPER_NOTES.md), section 4, "Step 5b"                                          |

Keep to the existing design system: practical, easy help-desk screens, no grand redesigns (owner, 2026-10-28). The mockups show layout and placement only. Build them from the existing React components and `helpdesk-web/src/styles/tokens.css`; never copy mockup markup. Same data, actions and flows as before Step 5b, except the theme switch the owner asked for.

## Figma

> **Old name in the designs:** Figma, the design canvas and the images of this folder (`figma/*.png`, `ux-canvas/png/`, the UX audit PDF) still show the product's old name and wordmark (2026-10-30). The images are therefore kept on the owner's computer only (Git ignores them) and are not in the published repo; the links to them below work only there. The app now shows the placeholder "Helpdesk" from one constant and draws the wordmark as text ([BRANDING.md](../BRANDING.md)); redo the images when the real name and logo are chosen.

- **File:** key `HFKoMs9DW2QXagSizJnBXm`, https://www.figma.com/design/HFKoMs9DW2QXagSizJnBXm/Helpdesk
- **Account:** the shared design account (in `docs/real-names.local.md`) (team "devfigma's team", Starter plan). It replaces the first file (`SKCwp41FF3pelNAUsWCr6V`), which was deleted.
- **Pages:** Helpdesk color options, Logo, Design system, App shell. The Starter plan allows 3 pages per file and this copy already has 4, so the UX boards sit on the **App shell** page (node `1:1699`) below the earlier frames.
- **Boards on the App shell page:**
  - "UX · 1 Foundations" (node `4003:131`), https://www.figma.com/design/HFKoMs9DW2QXagSizJnBXm/Helpdesk?node-id=4003-131: status, priority and SLA chips; compact ticket row; conversation timeline; reply bar, compact properties, presence; rule editor as sentences; SLA targets table; grouped settings menu with Lucide icons; save bar; toasts; phone filter sheet.
  - "UX · 2 Agent workspace" (node `4012:372`): today's screenshot per screen, with empty "New" frames to fill with the approved screens.
  - Component "App shell · current (Release 1)" (node `4013:295`).
- **Variables:** collection "Helpdesk Brand" (modes Help Teal and Ocean Cyan, `primary/50…900` and `brand/*` roles) and "Helpdesk Core" (text, surface, border, status, SLA, priority, feedback, shell). The code tokens mirror them.
- **Font:** the file uses Inter as a stand-in; the app ships Satoshi.
- **Limits met on 2026-10-29:** the Starter plan's limit on calls from connected tools ran out, so later screens were designed on the Claude canvas instead. A paid plan (or the file in a paid team where the editing account has a full seat) removes both limits.
- **Still to do in Figma** (when access allows): copy the approved canvas screens into the "New" frames; add the later decisions (thin scrollbars, the Update bar's unsaved state, pinned table headers, tablet and phone rules) to the Foundations board; in "App shell · current" move Home off Contacts (the sidebar uses fixed positions) and set the demo user to Hari Prasath, Admin · HpTech Support.

## Claude Design canvas

- **Canvas:** "Helpdesk UX · Agent workspace", https://claude.ai/artifact/JSb4MXCqg1Y1Z3K4Rm8CqM. Private to the owner's Claude account; other accounts can open it only if the owner shares it from the page's Share menu.
- **Export in this repo:** [ux-canvas/](ux-canvas/) holds the canvas exactly as approved (2026-10-29): `canvas.json` (layout of the boards) and one `.dc.html` file per screen. [ux-canvas/png/](ux-canvas/png/) has an image of each screen in its first state, rendered from those files.

| Screen                                              | Source file                                                                                          | Image                                                                                        |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Ticket list                                         | [Main.dc.html](ux-canvas/Main.dc.html)                                                               | [Main.png](ux-canvas/png/Main.png)                                                           |
| Ticket page                                         | [TicketPage.dc.html](ux-canvas/TicketPage.dc.html)                                                   | [TicketPage.png](ux-canvas/png/TicketPage.png)                                               |
| Home (bell opens notifications)                     | [Home.dc.html](ux-canvas/Home.dc.html)                                                               | [Home.png](ux-canvas/png/Home.png)                                                           |
| New ticket                                          | [NewTicket.dc.html](ux-canvas/NewTicket.dc.html)                                                     | [NewTicket.png](ux-canvas/png/NewTicket.png)                                                 |
| Contact page                                        | [Contact.dc.html](ux-canvas/Contact.dc.html)                                                         | [Contact.png](ux-canvas/png/Contact.png)                                                     |
| Phone · ticket list                                 | [PhoneList.dc.html](ux-canvas/PhoneList.dc.html)                                                     | [PhoneList.png](ux-canvas/png/PhoneList.png)                                                 |
| Phone · ticket                                      | [PhoneTicket.dc.html](ux-canvas/PhoneTicket.dc.html)                                                 | [PhoneTicket.png](ux-canvas/png/PhoneTicket.png)                                             |
| Settings overview and grouped menu                  | [SettingsOverview.dc.html](ux-canvas/SettingsOverview.dc.html)                                       | [SettingsOverview.png](ux-canvas/png/SettingsOverview.png)                                   |
| Settings · rules (click a rule: editor)             | [Rules.dc.html](ux-canvas/Rules.dc.html)                                                             | [Rules.png](ux-canvas/png/Rules.png)                                                         |
| Settings · SLA policies (click: editor)             | [Slas.dc.html](ux-canvas/Slas.dc.html)                                                               | [Slas.png](ux-canvas/png/Slas.png)                                                           |
| Settings · fields                                   | [Fields.dc.html](ux-canvas/Fields.dc.html)                                                           | [Fields.png](ux-canvas/png/Fields.png)                                                       |
| Settings · email                                    | [Email.dc.html](ux-canvas/Email.dc.html)                                                             | [Email.png](ux-canvas/png/Email.png)                                                         |
| Your account · Appearance (theme)                   | [Account.dc.html](ux-canvas/Account.dc.html)                                                         | [Account.png](ux-canvas/png/Account.png)                                                     |
| Phone · settings                                    | [PhoneSettings.dc.html](ux-canvas/PhoneSettings.dc.html)                                             | [PhoneSettings.png](ux-canvas/png/PhoneSettings.png)                                         |
| Sign in (also sign-up, reset, two-step, invitation) | [SignIn.dc.html](ux-canvas/SignIn.dc.html)                                                           | [SignIn.png](ux-canvas/png/SignIn.png)                                                       |
| Public web form                                     | [WebForm.dc.html](ux-canvas/WebForm.dc.html)                                                         | [WebForm.png](ux-canvas/png/WebForm.png)                                                     |
| Customer email layout                               | [CustomerEmail.dc.html](ux-canvas/CustomerEmail.dc.html)                                             | [CustomerEmail.png](ux-canvas/png/CustomerEmail.png)                                         |
| Shared sidebar, shared settings menu                | [Sidebar.dc.html](ux-canvas/Sidebar.dc.html), [SettingsMenu.dc.html](ux-canvas/SettingsMenu.dc.html) | [Sidebar.png](ux-canvas/png/Sidebar.png), [SettingsMenu.png](ux-canvas/png/SettingsMenu.png) |

- **Opening the export from another Claude account:** create a new Design canvas, then publish `canvas.json` and every `.dc.html` file under `project/` (same names). The files load the display script `./support.js`, which the canvas supplies. Images and the font are referenced as `/_blob/<id>`; upload these repo files to the new canvas and replace the ids with the ones it returns:

  | Id in the files                    | Repo file                                                    |
  | ---------------------------------- | ------------------------------------------------------------ |
  | `c2f8d14f91715996350f7d5819d785c9` | `helpdesk-web/src/assets/fonts/Satoshi-Variable.woff2`       |
  | `8bf4d583b302740e0d6706384007c2fa` | `helpdesk-web/src/assets/brands/help-teal/logo-on-dark.svg`  |
  | `a0c201e08955ad1c872f7ee2ba174fbd` | `helpdesk-web/src/assets/brands/help-teal/logo-on-light.svg` |

- **Interactive states** (not in the images): ticket list views menu; ticket page reply bar opening the composer and the Priority field turning the Update bar to "1 unsaved change"; home bell panel; phone filters sheet and Details tab; rule and SLA editors; email Save bar; theme choice; phone business hours with Save; web form success screen. Open the canvas (or a re-published copy) to try them.

## Images of the Figma foundations

[figma/](figma/) has images taken from the Figma board on 2026-10-28 and 2026-10-29: the whole Foundations board, the ticket row, the rule editor and the settings menu with icons. They are a reference copy for when Figma cannot be opened; Figma stays the source.
