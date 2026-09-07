# Lead-Gen Autopilot — $0 build

This is the working implementation of the plan (industry/entity classification →
contact discovery → AI-personalized email → send → reply handling), built on
the free stack: Google Sheets + Apps Script + Groq's free tier + Gmail. (The plan originally called for Gemini; the code uses Groq instead because Gemini's free tier now requires a billing account on file for some Google accounts — Groq's free tier genuinely doesn't. See "Why Groq, not Gemini" below.)

All code lives in [`apps-script/`](apps-script/). It's plain Apps Script
(`.gs` files) — there's nothing to `npm install` and nothing runs on your PC;
it all executes on Google's servers once deployed.

## Production hardening in this version

- **Overlap protection** — every entry point (`classifyLeads`, `findContacts`, `draftEmails`, `queueApprovedDrafts`, `sendQueue`, `checkReplies`) takes a script lock first ([Utils.gs](apps-script/Utils.gs)'s `withLock_`), so a slow run and its next scheduled trigger can never double-process the same rows or double-send.
- **Execution-time budget** — each batch function checks elapsed time against a 4.5-minute budget and stops cleanly, leaving the rest for the next trigger, instead of risking Apps Script's hard 6-minute kill.
- **Retry with backoff** — every external call (Groq, Hunter, Places) goes through `fetchWithRetry_`, which retries 429/5xx responses with exponential backoff before giving up.
- **An `Errors` sheet** — every caught failure is written there with a timestamp, the function, and context, not just to Apps Script's Logger (which you'd otherwise never see).
- **Real `List-Unsubscribe`** — [MimeMail.gs](apps-script/MimeMail.gs) sends through the Gmail advanced service with a proper `List-Unsubscribe` header (and, if you deploy the optional Web App in [Unsubscribe.gs](apps-script/Unsubscribe.gs), a full RFC 8058 one-click `List-Unsubscribe-Post` too) — this is what actually renders Gmail's native "Unsubscribe" pill and lowers spam complaints. It falls back to plain `GmailApp.sendEmail` automatically if that advanced service isn't enabled, so sending never breaks.
- **`runSelfTest()`** ([SelfTest.gs](apps-script/SelfTest.gs)) — checks your config, sheet structure, Groq key, Hunter key, Gmail quota, and sends one real end-to-end test email to yourself. Run this after setup and after any config change, before turning on triggers.

## Why Groq, not Gemini

The plan this was built from assumed Gemini's free tier, and the code originally called Gemini. In practice, Google now gates some accounts' Gemini free-tier access behind "add a billing account" — even a $0-spend one — and in at least one case, that same account was also blocked from creating a *new* Google Cloud project ("the request is suspicious"), meaning the restriction is on the account, not just the API. Rather than require a card on file, [Groq.gs](apps-script/Groq.gs) calls [Groq's API](https://console.groq.com) instead — genuinely free, no card, 14,400 requests/day, OpenAI-compatible. Every prompt, every other file, and the whole pipeline is unchanged; only the HTTP call inside `callGemini_`/`callGeminiJson_` (names kept for minimal diff) points at Groq now. If your Google account isn't restricted, you can switch back by reverting to the Gemini call and setting `GEMINI_API_KEY` instead of `GROQ_API_KEY`.

## 1. Create the sheet and paste in the code

1. Go to [sheets.new](https://sheets.new) and create a blank spreadsheet. Name it something like "Lead-Gen Autopilot".
2. In it, open **Extensions → Apps Script**.
3. Delete the default `Code.gs` content. For each file in `apps-script/` (`Config.gs`, `Utils.gs`, `Groq.gs`, `SheetSetup.gs`, `Sourcing.gs`, `Classification.gs`, `ContactDiscovery.gs`, `Personalization.gs`, `Unsubscribe.gs`, `MimeMail.gs`, `Sender.gs`, `ReplyHandler.gs`, `Triggers.gs`, `SelfTest.gs`, `Dashboard.gs`, `DashboardHtml.gs`, `WebApp.gs`), create a matching script file in the editor (**+ → Script**) and paste its contents in.
4. Open the project's manifest (gear icon → check "Show appsscript.json") and replace its contents with [`apps-script/appsscript.json`](apps-script/appsscript.json).
5. In the left sidebar, click **Services (+)** and add **Gmail API** — this is what actually wires up the advanced Gmail service in your project's Cloud config; pasting the manifest alone sometimes isn't enough for Google to enable it.
6. Save (Ctrl/Cmd+S).

*(If you're comfortable with the command line, `npm i -g @google/clasp`, `clasp login` in a browser tab, then `clasp create --type sheet --rootDir apps-script` and `clasp push` does steps 1-5 for you. Manual copy-paste above works with zero extra tools — the two produce the same project.)*

## 2. Run the one-time setup

In the Apps Script editor, select the function `setupSheets` from the dropdown next to the Run button, then click **Run**. First run asks you to authorize the script — that's expected (it's your own script asking your own account for Sheets/Gmail access).

This creates every tab (`RawLeads`, `Classified`, `Contacts`, `Drafts`, `SendQueue`, `SentLog`, `Replies`, `Suppression`, `SourceQueries`) plus a `ReadMe` tab listing every setting below.

## 3. Set your Script Properties

**Project Settings** (gear icon, left sidebar) → **Script Properties** → **Add script property**. Set:

| Key | Value |
|---|---|
| `GROQ_API_KEY` | Free key from [console.groq.com](https://console.groq.com) — sign in with any Google account, no card needed, go to API Keys → Create |
| `BUSINESS_NAME` | Your business name, shown in every email footer |
| `PHYSICAL_ADDRESS` | A real mailing address — required in every outreach email |
| `REPLY_TO_EMAIL` | `adsolutions200@gmail.com` |
| `SENDER_ACCOUNTS` | Comma-separated Gmail addresses that will actually send, e.g. `sendbox1@gmail.com,sendbox2@gmail.com` — **not** adsolutions200@gmail.com itself, see the plan's §00 |
| `ICP_DESCRIPTION` | One or two sentences on who you actually want to reach, e.g. `Small retail and service businesses in India that don't yet run paid ads.` |
| `HUNTER_API_KEY` | Optional — from [hunter.io](https://hunter.io) free plan. Leave unset to fill `Contacts.contact_email` by hand instead |
| `PLACES_API_KEY` | Optional — only needed if you use `importLeadsFromPlaces()` for Google Maps-sourced leads. Not needed for `autoSourceLeads()` (the OpenStreetMap-based one) — see "Automatic lead sourcing" below |
| `DAILY_CAP_PER_SENDER` | Leave unset for the default of `10`. Do not raise this in week 1 — see the plan's warm-up schedule |

## 4. Prepare your sending accounts (do this before sending anything)

For each address in `SENDER_ACCOUNTS`:
- It should be phone-verified and have some real, pre-existing activity — not a same-day-created account (plan §07).
- In that account's Gmail: **Settings → Forwarding and POP/IMAP → Add a forwarding address** → enter `adsolutions200@gmail.com`. Gmail sends a confirmation link to that inbox — open it and click confirm. Then choose "Forward a copy of incoming mail to adsolutions200@gmail.com". This is what lets replies land in one place for `checkReplies()` to process centrally.
- Share your Google Sheet with that account as **Editor** (Share button, top right).

Then, **for each sending account**, logged into that Google account:
1. Go to [sheets.google.com](https://sheets.google.com), open the shared sheet.
2. **Extensions → Apps Script** — this creates a *separate* script project bound to the same sheet, owned by that account.
3. Paste in `Config.gs`, `Utils.gs`, `Groq.gs`, `Unsubscribe.gs`, `MimeMail.gs`, `Sender.gs`, and the manifest (this deployment only ever needs to send — it doesn't need Classification.gs, ContactDiscovery.gs, Personalization.gs, or ReplyHandler.gs).
4. Click **Services (+) → Gmail API** here too, so this account's sends carry a real `List-Unsubscribe` header (optional — sending still works without it, see MimeMail.gs).
5. Set that account's own Script Properties (same values as step 3 above — they read the same sheet, so values should match).
6. Run `runSelfTest` once — it's safe to run from any deployment — then `installSenderTriggers`, authorizing when asked.

The main account (adsolutions200@gmail.com's own script, from steps 1-3) handles everything else — classification, contact discovery, drafting, and reply processing — via `installCentralTriggers`.

## 5. First run, in order

Back in the **main** account's script project:

0. Run `runSelfTest` and read the Logger output (**View → Logs**, or Ctrl/Cmd+Enter). Fix anything marked `FAIL` before continuing — it checks your config, sheet structure, Groq key, and sends you one real test email.
1. Add a few test leads to `RawLeads` (fill `company_name`, `website`, `category`, `address` — leave the rest blank), or fill in the `SourceQueries` tab and run `autoSourceLeads` — see "Automatic lead sourcing" below.
2. Run `normalizeRawLeads` — fills in `lead_id` / `status`.
3. Run `classifyLeads` — calls Groq, writes to `Classified`. **Read every row it produces.** This is the step the whole plan says to hand-check before trusting it.
4. Run `findContacts` — fills `Contacts` (or marks `manual_needed` if `HUNTER_API_KEY` isn't set).
5. Run `draftEmails` — writes drafts to `Drafts` with status `pending_review`.
6. **Open the `Drafts` tab and read every single draft.** Change `status` to `approved` for the ones you'd actually send, or `rejected` for the rest.
7. Run `queueApprovedDrafts` — moves approved drafts into `SendQueue`, assigned round-robin across your `SENDER_ACCOUNTS`.
8. Only once you're comfortable with steps 1-7: run `installCentralTriggers` (main account) and `installSenderTriggers` (each sending account) to put the whole thing on autopilot. `installCentralTriggers` already includes `autoSourceLeads` on a 6-hour timer, so once `SourceQueries` is filled in, lead generation itself runs unattended too — not just the pipeline downstream of it.

## Automatic lead sourcing

Two ways to keep `RawLeads` filled without touching the sheet by hand:

- **`importLeadsFromPlaces(query, regionBias)`** — Google Places, best coverage, but needs a `PLACES_API_KEY` from a Google Cloud project, and Google now gates that behind a billing account on file (a card, even for the free tier that would normally cover it). Skip this if that's a wall you'd rather not hit — see "Why Groq, not Gemini" above for the same issue with a different API.
- **`autoSourceLeads()`** — [Sourcing.gs](apps-script/Sourcing.gs), genuinely free, no signup, no card, ever. Pulls from OpenStreetMap instead: Nominatim resolves a place name to an area, Overpass lists businesses tagged in it. This is the one that's wired into `installCentralTriggers()`/`installAllTriggersSingleAccount()` on a 6-hour timer, so it's the actual "automatic" half of automatic lead generation.

To use it, fill in the **`SourceQueries`** tab (created by `setupSheets()`) with one row per thing you want to search for:

| category | osm_tag | location |
|---|---|---|
| Bakery | `shop=bakery` | Ahmedabad, India |
| Restaurant | `amenity=restaurant` | Ahmedabad, India |
| Dentist | `amenity=dentist` | Ahmedabad, India |
| Real estate agency | `office=real_estate_agent` | Ahmedabad, India |

Leave `area_id`, `last_run_at`, and `total_found` blank — the script fills those in itself (it geocodes each `location` once and caches the result, so later runs only call Overpass). Each call to `autoSourceLeads()` processes whichever row has gone longest without running, so a handful of rows all get covered over time rather than one row hogging every run. More `osm_tag` examples are at [wiki.openstreetmap.org/wiki/Map_features](https://wiki.openstreetmap.org/wiki/Map_features); pick ones that match who `ICP_DESCRIPTION` describes.

Coverage depends on how well local businesses are mapped on OpenStreetMap — it's crowdsourced, so it's patchier than Google Places in some areas and just as good in others. A result only becomes a `RawLeads` row if it has both a name and a website tag — `findContacts` has nothing to work with otherwise, so there's no point adding it. If a run finds nothing, that usually means the category/location combination just isn't well-tagged in OSM yet, not that anything's broken; try a nearby city or a broader/different tag.

## Live dashboard

The same Web App deployment used for one-click unsubscribe (§7 in Production hardening above) also serves a real-time dashboard — funnel counts, reply breakdown, per-sender send caps, a recent-activity feed, recent errors, and a raw-data explorer that can page through any of the ten sheets in full detail. It reads the live sheet on every load; there's no separate database to keep in sync.

1. Set a `DASHBOARD_ACCESS_KEY` script property to any random string. **This is required** — without it, the deployed URL shows nothing, on purpose. The sheet holds real prospect emails and reply text, and a Web App's "Anyone with the link" access mode means anyone who obtains the URL can otherwise open it; the key is what stands in for real access control on a $0 setup.
2. If you haven't already, deploy the project: **Deploy → New deployment → Web app** (execute as "Me", access "Anyone"). Copy the `/exec` URL it gives you.
3. Open `<that URL>?key=<your DASHBOARD_ACCESS_KEY>` in a browser and bookmark it. That's your dashboard.
4. Redeploy (**Deploy → Manage deployments → Edit → New version**) any time you change `Dashboard.gs`, `DashboardHtml.gs`, or `WebApp.gs` — Web Apps serve whatever was live at the last deployment, not your latest saved code, until you do this.

## What's deliberately manual, and why

- **Approving drafts** stays a human click until you've watched ~50 go out and trust the prompt (plan §03/§04). `queueApprovedDrafts` only ever reads rows you marked `approved`.
- **Contact discovery without `HUNTER_API_KEY`** stays manual — Hunter's free tier is 25 searches/month, which won't cover volume, so the code is written to degrade gracefully rather than fail.
- **Domain-based sending and higher volume** are the paid-tier upgrade in the plan's §05/§07 — not something to bolt onto this $0 version. (Real `List-Unsubscribe` headers, unusually, you get for free here — see MimeMail.gs.) Come back to the paid tier once a lead from this system actually replies "interested."

## Automated tests

[`test/`](test/) is a full Node.js test suite (64 tests, zero npm dependencies — just Node's built-in test runner) that loads the *actual* `.gs` files into a mocked Apps Script environment ([`test/appsScriptEnv.js`](test/appsScriptEnv.js) stands in for `SpreadsheetApp`, `GmailApp`, `UrlFetchApp`, `PropertiesService`, `HtmlService`, etc.) and exercises every function directly — no Google account needed, no network calls. Run it with:

```bash
npm test
```

It covers: classification (grounding, malformed-JSON handling, idempotency), contact discovery (Hunter matching, graceful degradation without an API key), drafting (INSUFFICIENT_SIGNAL handling, suppression checks, round-robin sender assignment), sending (daily caps, send-window enforcement, suppression, the List-Unsubscribe header actually landing in the raw MIME, lock-based overlap protection), reply handling (classification, suppression, notification, idempotency), trigger installation, `runSelfTest`'s own failure modes, and the dashboard (funnel/breakdown math against seeded data, the raw-data explorer, and the access-key gate on `doGet`).

**What this does and doesn't prove.** Every branch of business logic above ran, for real, against realistic inputs and asserted outputs — that's genuine coverage, and it's what caught (and let me fix) real bugs while building this: `SHEETS`/`HEADERS` needing to be `var` instead of `const` to be visible outside the script's own scope, a test that asserted the wrong average on its own seed data, and a couple of other test-side mistakes. What it *cannot* do from here is prove Google's actual APIs behave the way their docs say, or that your specific account/API keys work — that requires your real credentials, which only exist once you've done the setup above. That's exactly what `runSelfTest()` (§5, step 0) is for: the equivalent live check, run inside Apps Script once you're deployed. Treat "64/64 passing" as "the logic is correct" and "runSelfTest: PASS" as "it's correct *and* wired up right" — you want both before turning on triggers.

## Reference

The full architecture, legal notes (US/EU/India), prompts, and KPI targets this code implements are in the plan artifact from this conversation — this repo is the "build it" half of that document.
