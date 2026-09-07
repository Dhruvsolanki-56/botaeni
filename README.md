# Lead-Gen Autopilot — $0 build

This is the working implementation of the plan (industry/entity classification →
contact discovery → AI-personalized email → send → reply handling), built on
the free stack: Google Sheets + Apps Script + Gemini free tier + Gmail.

All code lives in [`apps-script/`](apps-script/). It's plain Apps Script
(`.gs` files) — there's nothing to `npm install` and nothing runs on your PC;
it all executes on Google's servers once deployed.

## Production hardening in this version

- **Overlap protection** — every entry point (`classifyLeads`, `findContacts`, `draftEmails`, `queueApprovedDrafts`, `sendQueue`, `checkReplies`) takes a script lock first ([Utils.gs](apps-script/Utils.gs)'s `withLock_`), so a slow run and its next scheduled trigger can never double-process the same rows or double-send.
- **Execution-time budget** — each batch function checks elapsed time against a 4.5-minute budget and stops cleanly, leaving the rest for the next trigger, instead of risking Apps Script's hard 6-minute kill.
- **Retry with backoff** — every external call (Gemini, Hunter, Places) goes through `fetchWithRetry_`, which retries 429/5xx responses with exponential backoff before giving up.
- **An `Errors` sheet** — every caught failure is written there with a timestamp, the function, and context, not just to Apps Script's Logger (which you'd otherwise never see).
- **Real `List-Unsubscribe`** — [MimeMail.gs](apps-script/MimeMail.gs) sends through the Gmail advanced service with a proper `List-Unsubscribe` header (and, if you deploy the optional Web App in [Unsubscribe.gs](apps-script/Unsubscribe.gs), a full RFC 8058 one-click `List-Unsubscribe-Post` too) — this is what actually renders Gmail's native "Unsubscribe" pill and lowers spam complaints. It falls back to plain `GmailApp.sendEmail` automatically if that advanced service isn't enabled, so sending never breaks.
- **`runSelfTest()`** ([SelfTest.gs](apps-script/SelfTest.gs)) — checks your config, sheet structure, Gemini key, Hunter key, Gmail quota, and sends one real end-to-end test email to yourself. Run this after setup and after any config change, before turning on triggers.

## 1. Create the sheet and paste in the code

1. Go to [sheets.new](https://sheets.new) and create a blank spreadsheet. Name it something like "Lead-Gen Autopilot".
2. In it, open **Extensions → Apps Script**.
3. Delete the default `Code.gs` content. For each file in `apps-script/` (`Config.gs`, `Utils.gs`, `Gemini.gs`, `SheetSetup.gs`, `Sourcing.gs`, `Classification.gs`, `ContactDiscovery.gs`, `Personalization.gs`, `Unsubscribe.gs`, `MimeMail.gs`, `Sender.gs`, `ReplyHandler.gs`, `Triggers.gs`, `SelfTest.gs`), create a matching script file in the editor (**+ → Script**) and paste its contents in.
4. Open the project's manifest (gear icon → check "Show appsscript.json") and replace its contents with [`apps-script/appsscript.json`](apps-script/appsscript.json).
5. In the left sidebar, click **Services (+)** and add **Gmail API** — this is what actually wires up the advanced Gmail service in your project's Cloud config; pasting the manifest alone sometimes isn't enough for Google to enable it.
6. Save (Ctrl/Cmd+S).

*(If you're comfortable with the command line, `npm i -g @google/clasp`, `clasp login` in a browser tab, then `clasp create --type sheet --rootDir apps-script` and `clasp push` does steps 1-5 for you. Manual copy-paste above works with zero extra tools — the two produce the same project.)*

## 2. Run the one-time setup

In the Apps Script editor, select the function `setupSheets` from the dropdown next to the Run button, then click **Run**. First run asks you to authorize the script — that's expected (it's your own script asking your own account for Sheets/Gmail access).

This creates every tab (`RawLeads`, `Classified`, `Contacts`, `Drafts`, `SendQueue`, `SentLog`, `Replies`, `Suppression`) plus a `ReadMe` tab listing every setting below.

## 3. Set your Script Properties

**Project Settings** (gear icon, left sidebar) → **Script Properties** → **Add script property**. Set:

| Key | Value |
|---|---|
| `GEMINI_API_KEY` | Free key from [aistudio.google.com/apikey](https://aistudio.google.com/apikey) — sign in with any Google account, no card needed |
| `BUSINESS_NAME` | Your business name, shown in every email footer |
| `PHYSICAL_ADDRESS` | A real mailing address — required in every outreach email |
| `REPLY_TO_EMAIL` | `adsolutions200@gmail.com` |
| `SENDER_ACCOUNTS` | Comma-separated Gmail addresses that will actually send, e.g. `sendbox1@gmail.com,sendbox2@gmail.com` — **not** adsolutions200@gmail.com itself, see the plan's §00 |
| `ICP_DESCRIPTION` | One or two sentences on who you actually want to reach, e.g. `Small retail and service businesses in India that don't yet run paid ads.` |
| `HUNTER_API_KEY` | Optional — from [hunter.io](https://hunter.io) free plan. Leave unset to fill `Contacts.contact_email` by hand instead |
| `PLACES_API_KEY` | Optional — only needed if you use `importLeadsFromPlaces()` for Google Maps-sourced leads |
| `DAILY_CAP_PER_SENDER` | Leave unset for the default of `10`. Do not raise this in week 1 — see the plan's warm-up schedule |

## 4. Prepare your sending accounts (do this before sending anything)

For each address in `SENDER_ACCOUNTS`:
- It should be phone-verified and have some real, pre-existing activity — not a same-day-created account (plan §07).
- In that account's Gmail: **Settings → Forwarding and POP/IMAP → Add a forwarding address** → enter `adsolutions200@gmail.com`. Gmail sends a confirmation link to that inbox — open it and click confirm. Then choose "Forward a copy of incoming mail to adsolutions200@gmail.com". This is what lets replies land in one place for `checkReplies()` to process centrally.
- Share your Google Sheet with that account as **Editor** (Share button, top right).

Then, **for each sending account**, logged into that Google account:
1. Go to [sheets.google.com](https://sheets.google.com), open the shared sheet.
2. **Extensions → Apps Script** — this creates a *separate* script project bound to the same sheet, owned by that account.
3. Paste in `Config.gs`, `Utils.gs`, `Gemini.gs`, `Unsubscribe.gs`, `MimeMail.gs`, `Sender.gs`, and the manifest (this deployment only ever needs to send — it doesn't need Classification.gs, ContactDiscovery.gs, Personalization.gs, or ReplyHandler.gs).
4. Click **Services (+) → Gmail API** here too, so this account's sends carry a real `List-Unsubscribe` header (optional — sending still works without it, see MimeMail.gs).
5. Set that account's own Script Properties (same values as step 3 above — they read the same sheet, so values should match).
6. Run `runSelfTest` once — it's safe to run from any deployment — then `installSenderTriggers`, authorizing when asked.

The main account (adsolutions200@gmail.com's own script, from steps 1-3) handles everything else — classification, contact discovery, drafting, and reply processing — via `installCentralTriggers`.

## 5. First run, in order

Back in the **main** account's script project:

0. Run `runSelfTest` and read the Logger output (**View → Logs**, or Ctrl/Cmd+Enter). Fix anything marked `FAIL` before continuing — it checks your config, sheet structure, Gemini key, and sends you one real test email.
1. Add a few test leads to `RawLeads` (fill `company_name`, `website`, `category`, `address` — leave the rest blank), or run `importLeadsFromPlaces("digital marketing agency", "IN")` from the editor for a live test batch.
2. Run `normalizeRawLeads` — fills in `lead_id` / `status`.
3. Run `classifyLeads` — calls Gemini, writes to `Classified`. **Read every row it produces.** This is the step the whole plan says to hand-check before trusting it.
4. Run `findContacts` — fills `Contacts` (or marks `manual_needed` if `HUNTER_API_KEY` isn't set).
5. Run `draftEmails` — writes drafts to `Drafts` with status `pending_review`.
6. **Open the `Drafts` tab and read every single draft.** Change `status` to `approved` for the ones you'd actually send, or `rejected` for the rest.
7. Run `queueApprovedDrafts` — moves approved drafts into `SendQueue`, assigned round-robin across your `SENDER_ACCOUNTS`.
8. Only once you're comfortable with steps 1-7: run `installCentralTriggers` (main account) and `installSenderTriggers` (each sending account) to put the whole thing on autopilot.

## What's deliberately manual, and why

- **Approving drafts** stays a human click until you've watched ~50 go out and trust the prompt (plan §03/§04). `queueApprovedDrafts` only ever reads rows you marked `approved`.
- **Contact discovery without `HUNTER_API_KEY`** stays manual — Hunter's free tier is 25 searches/month, which won't cover volume, so the code is written to degrade gracefully rather than fail.
- **Domain-based sending and higher volume** are the paid-tier upgrade in the plan's §05/§07 — not something to bolt onto this $0 version. (Real `List-Unsubscribe` headers, unusually, you get for free here — see MimeMail.gs.) Come back to the paid tier once a lead from this system actually replies "interested."

## Automated tests

[`test/`](test/) is a full Node.js test suite (56 tests, zero npm dependencies — just Node's built-in test runner) that loads the *actual* `.gs` files into a mocked Apps Script environment ([`test/appsScriptEnv.js`](test/appsScriptEnv.js) stands in for `SpreadsheetApp`, `GmailApp`, `UrlFetchApp`, `PropertiesService`, etc.) and exercises every function directly — no Google account needed, no network calls. Run it with:

```bash
npm test
```

It covers: classification (grounding, malformed-JSON handling, idempotency), contact discovery (Hunter matching, graceful degradation without an API key), drafting (INSUFFICIENT_SIGNAL handling, suppression checks, round-robin sender assignment), sending (daily caps, send-window enforcement, suppression, the List-Unsubscribe header actually landing in the raw MIME, lock-based overlap protection), reply handling (classification, suppression, notification, idempotency), trigger installation, and `runSelfTest`'s own failure modes.

**What this does and doesn't prove.** Every branch of business logic above ran, for real, against realistic inputs and asserted outputs — that's genuine coverage, and it's what caught (and let me fix) real bugs while building this: `SHEETS`/`HEADERS` needing to be `var` instead of `const` to be visible outside the script's own scope, and a couple of test-side mistakes. What it *cannot* do from here is prove Google's actual APIs behave the way their docs say, or that your specific account/API keys work — that requires your real credentials, which only exist once you've done the setup above. That's exactly what `runSelfTest()` (§5, step 0) is for: the equivalent live check, run inside Apps Script once you're deployed. Treat "56/56 passing" as "the logic is correct" and "runSelfTest: PASS" as "it's correct *and* wired up right" — you want both before turning on triggers.

## Reference

The full architecture, legal notes (US/EU/India), prompts, and KPI targets this code implements are in the plan artifact from this conversation — this repo is the "build it" half of that document.
