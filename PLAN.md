# IMC-Mail: Project Plan

Multi-account desktop email client for streamers and content creators. Electron + TypeScript.

## Goals
- One clean inbox across many accounts (Gmail, Outlook/Microsoft 365, generic IMAP/SMTP).
- Full-featured composer.
- Creator workflow: sponsorship pipeline, stream-safe mode, smart categories.
- Local-first: mail cache and metadata live on each device. Mail is fetched straight from the providers.
- Android and iOS companion apps (Phase 8) sharing code with desktop. This needs a small IMC backend for push and settings sync (see Mobile).

## Tech stack
| Area | Choice | Why |
|---|---|---|
| Shell | Electron, `electron-vite`, `electron-builder` | Fast HMR, simple packaging and auto-update |
| Language | TypeScript (strict) everywhere | Shared types across main/preload/renderer |
| UI | React, Tailwind, Radix primitives, Zustand, TanStack Query | Small, accessible, fast to iterate |
| Mail protocols | `imapflow` (IMAP), `nodemailer` (SMTP), `mailparser` (parse) | Mature, pure JS |
| Gmail/Microsoft auth | OAuth2 + PKCE via system browser and loopback redirect | No embedded login; works with IMAP XOAUTH2 |
| Secrets | Electron `safeStorage` (DPAPI on Windows) | Tokens and passwords never in plain text |
| Local DB | SQLite (`better-sqlite3`) + FTS5 full-text search | Offline, instant search |
| Composer | TipTap (ProseMirror) | Rich text, Markdown shortcuts, inline images, templates |
| HTML safety | DOMPurify + sandboxed `<iframe sandbox>`, remote images blocked by default | Prevents tracking pixels and script injection |
| Tests | Vitest (unit), Playwright for Electron (e2e), GreenMail/Dovecot container (IMAP integration) | |

## Architecture
```
Renderer (React, sandboxed, no Node)
   |  typed IPC (contextBridge, zod-validated)
Preload
   |
Main process: window mgmt, IPC router, auto-update, safeStorage
   |  MessagePort
Sync worker (utility process): one IMAP connection pool per account,
   IDLE for push, delta sync by UIDVALIDITY/UID/MODSEQ, outbox queue,
   SQLite writes
   |
SQLite: accounts, folders, messages, threads, attachments, FTS,
        labels, deals, templates, rules, settings
```
- Renderer never touches network, disk, or secrets directly.
- Strict CSP, `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`, all navigation and `window.open` denied.
- Sync worker isolates network and crash risk from the UI.

## Data model (core tables)
- `account(id, provider, email, display_name, color, auth_ref, send_as_json)`
- `folder(id, account_id, path, role, uidvalidity, highestmodseq)`
- `message(id, account_id, folder_id, uid, message_id, thread_id, from, to, cc, subject, date, flags, snippet, body_ref, category, priority)`
- `attachment(id, message_id, filename, mime, size, cache_path)`
- `thread(id, subject_norm, last_date, participants)`
- `deal(id, thread_id, brand, stage, rate, currency, deliverables_json, due_date, paid_at)`
- `template(id, name, subject, body_html, variables_json)`
- `rule(id, match_json, action_json)`
- `message_fts` (FTS5 over subject, from, body)

## Features by phase

### Phase 0: Scaffold (day 1-2)
- electron-vite + React + TS template, lint/format, CI build, security defaults, typed IPC layer, SQLite migrations.
- **Done when:** app launches, IPC round-trips a typed call, DB migrates on start, `npm run build` produces a Windows installer.

### Phase 1: Accounts and sync (read-only)
- Add account wizard: Gmail (OAuth), Microsoft (OAuth), generic IMAP/SMTP (autodiscover + manual).
- Folder list, initial sync (recent N days first, backfill later), IMAP IDLE, reconnect/backoff, offline cache.
- **Done when:** 3 accounts of different types show live folders and new mail arrives without refresh.

### Phase 2: Reading experience
- Unified inbox + per-account views, color-coded account chips.
- Conversation threading, message list virtualization (handles 100k+), keyboard navigation.
- Safe HTML rendering, remote-image blocking with "load once / always for sender".
- Attachments: preview images/PDF, save, open.
- Actions: read/unread, star, archive, delete, move, labels, snooze.
- Command palette (Ctrl+K).
- **Done when:** daily-drive reading across all accounts is comfortable.

> **Phase 2 status (built):** message bodies (on-demand download, cached), reading pane, conversation threading across folders, sandboxed HTML with remote images blocked by default, attachment save, read/unread and star with rollback. **Still open from this phase:** archive/delete/move, labels, snooze, attachment preview, and "load older mail" backfill.

> **Phase 3 status (built):** rich-text composer (TipTap), reply / reply-all / forward with quoted original and threading headers, recipient chips with suggestions from your mail, attachments (picker and drag-drop, 25 MB cap), per-account signature, From-account switch, SMTP send (password and OAuth), 10-second undo send backed by a persisted outbox, local autosaved drafts, Sent copy for plain IMAP servers. **Templates and scheduled send (built):** saved replies with {{first_name}}, {{brand}}, {{my_name}}, {{date}} and similar variables filled from the recipient and your account, optional attached files (a media kit), a send-time guard for unfilled variables, and send-later with presets or a picked date and time, a Scheduled list, and recovery of overdue messages the next time the app opens. **Still open:** drafts synced to the IMAP Drafts folder, forwarding attachments, inline images, an attachment-reminder prompt.

> **Mail actions and Phase 4 search (built):** archive, move to Trash or Junk, move to any folder, delete forever (Trash and Junk only), with keyboard shortcuts (E, #, !, R), auto-advance to the next message, and rollback when the server refuses. Full-text search over everything cached (subject, sender, recipients, body) with `from:`, `to:`, `subject:`, `"phrases"`, `-exclusions`, `is:`, `has:attachment`, `account:`, `in:`, `before:`, `after:`; focus with `/` or Ctrl+K. **Still open:** labels, snooze, saved searches, local rules, undo for moves, searching mail that has not been downloaded (server-side search), and `has:attachment` only knows about messages whose body was opened.

> **Phase 6 status (core built):** smart categories (sponsorship, collab, platform, invoice, fan mail, cold outreach) filed by rules as mail arrives and sharpened once a body is downloaded, with a manual override; Needs reply and Waiting on reply views; a sponsorship board with drag-or-select stage moves, rate, deliverables, deadline and overdue flag; start a deal from any email. **Scam shield (built):** flags display-name spoofing and look-alike domains for 20+ brands, failed DMARC/SPF/DKIM, Reply-To mismatches, links whose text lies about their destination, shortened or bare-IP links, gift-card/crypto requests, urgency plus a login, off-platform chat requests, fake verified-badge and appeal offers, program or disguised attachments, and "run our game build" bait. Dangerous messages get a warning with plain-language reasons and inert links until you opt in; "This message is fine" overrides it; a Suspicious view and `is:suspicious` search collect them. **Still open:** deadline extraction from message text, media-kit attach, invoice/income tracker and CSV export, follow-up reminders, per-category notification rules, and a learned (AI) classifier.

> **Meetings (built, Outlook compatible):** invitations from Outlook, Exchange, Microsoft 365, Teams, Google Calendar and Zoom are read from `text/calendar` parts and `.ics` attachments (Windows time zone names, folded lines, quoted names, `MAILTO:` case) and shown as an invitation card with Accept / Tentative / Decline, an optional message, the time in your zone, a Join button for Teams / Zoom / Meet links, conflict warnings, and cancelled or out-of-date notices. Answers go to the organizer as standard iMIP `REPLY` mail (same UID and SEQUENCE, one `ATTENDEE`, `Content-Class: urn:content-classes:calendarmessage`, "Accepted:" / "Tentative:" / "Declined:" subjects) with no undo delay. Scheduling sends a `REQUEST` that Outlook shows as a meeting; edits bump SEQUENCE ("Updated:"), moving the time asks everyone to answer again, and cancelling sends `CANCEL` ("Canceled:"). Attendee replies update your meeting. A 30-day Calendar agenda lists accepted invitations and your own meetings, and any meeting exports as `.ics`. **Still open:** creating repeating meetings (received series are expanded, but new ones are single), all-day meetings in the dialog, replying to a single occurrence, two-way sync with a calendar account (CalDAV / Graph), and a month view.

> **Unread badge (built):** the Windows taskbar overlay (and the dock or launcher count on macOS and Linux) shows unread inbox mail across accounts, capped at 99, excluding snoozed mail, and shows nothing while stream-safe mode is hiding mail. Not checked on a real taskbar, only by tests of the image and the count.

> **Follow-up reminders (built):** on any message in a Sent folder, the bell button sets "remind me if nobody replies" (2 days, 3 days, 1 week, 2 weeks, or a date you pick). When it comes due you get one desktop notification ("No reply yet: …"; generic or silent under the stream-safe rules, and quiet hours apply), the message shows a banner, and it stays in a **Follow-ups** view (soonest first, with a count) until you press Done. A reply from anyone but you removes the reminder automatically; sending another message yourself does not. **Still open:** setting a reminder from the composer at send time, and reminders for mail you did not send.

> **Deal export (built):** the sponsorship board has an Export CSV button that saves every deal (brand, stage, rate, currency, deliverables, due date, paid date, created, notes) as a UTF-8 CSV for a spreadsheet or an accountant. Cells that start with = + - @ are defused so a spreadsheet cannot run them as formulas. Column totals per stage were already on the board. Not checked: the native save dialog (covered by tests of the CSV itself). **Still open:** a separate invoice list with due and paid reminders.

> **Deadline extraction (built):** when you track a deal from an email, the soonest upcoming date it asks for ("by November 15", "due 11/20", "no later than Friday", "within 10 days", "by the 30th of Nov") fills the deal's due date, with a note quoting the words it came from. Only dates next to a cue word count, numeric dates are read month first, and a date you set yourself is never overwritten. **Still open:** non-English emails and suggesting a deadline for deals that already exist.

> **Mobile groundwork (built):** `packages/core` (schemas, IPC contract, threading, categories, scam shield, calendar parsing, deadlines, CSV, templates) uses no Node or Electron APIs and depends only on zod; a test (`portable.test.ts`) fails if that changes, so the Android and iOS apps can import it as is. Mail sync, SMTP, storage and OAuth loopback stay in the desktop main process and will need mobile counterparts.

> **Open-items sweep (built):** **Undo for moves** (an Undo toast after archive, trash, junk or move; the server is asked to put the message back, found by Message-ID). **Attachment preview** for PNG, JPEG, GIF, WebP and plain-text files, judged by file contents rather than label, never SVG or HTML. **Labels**, local to this computer: tick them from the tag button, filter from the sidebar, they follow a message when it moves. **Load older mail** under any folder list, 200 at a time. **Repeating and all-day meetings** in the New meeting dialog (daily, weekly, every 2 weeks, monthly, with a count); repeating meetings are sent in your time zone with a VTIMEZONE so they hold their hour across daylight-saving changes. **Follow-up reminder when sending**, from a dropdown in the composer. Tests cover all of these, but the IMAP parts (undo, load older) were only run against a stubbed server, and the repeating-meeting format was not opened in real Outlook. **Still open:** real-account testing, Microsoft sign-in, a label search operator, previewing PDFs, and the Android and iOS apps.

> **Search by label and PDFs (built):** `label:taxes` (or `tag:`, quotes for names with spaces) finds labelled mail from the search box. PDF attachments get an Open PDF button that checks the file really is a PDF and opens it in the computer's own viewer (not shown inside the app). **Still open:** real-account testing and Microsoft sign-in (both need your accounts), and the Android and iOS apps.

> **Organization and shortcuts (built):** **Saved searches** (bookmark button in the search box; they list in the sidebar). **Rules** (sidebar, Rules): when from / to / subject / text contains something, add a label, file under a category, mark read, star or archive; they run on new inbox mail before notifications, and Run now applies one to the newest 500 inbox messages. **Command palette** on Ctrl+K (search stays on /): actions, views, folders, labels, saved searches, stream-safe toggle; names stay out of it while stream-safe mode hides things. **Media kit**: choose a file once, then one click in the composer attaches it. Checked in the running app: rules, saved search, palette. **Still open:** CalDAV or Graph calendar sync, a month view, tray, multi-window, settings import and export, auto-update, crash reporting, installer signing, and the mobile apps.

> **Dialogs, folders and selection (built):** in-app confirmation and text dialogs replace the browser's confirm and prompt (which did not work in Electron: link and template names are fixed). **Rename folder** (not for standard folders; its cached mail reloads under the new name). **Select several messages:** Ctrl+click ticks, Shift+click ticks a range, a bar offers Archive, Trash, Junk, Mark read and Mark unread, and dragging a ticked message drags them all onto a folder; Esc clears. **Calendar month view** beside the agenda: Sunday-first weeks, click a meeting to open it, click a day to start a meeting at 9:00. **Still open:** CalDAV or Graph calendar sync, tray and multi-window, settings import and export, auto-update, crash reporting, installer signing, and the mobile apps.

> **Shell and housekeeping (built):** tray icon (click shows or hides the window; menu: Open, Check mail now, Quit; hover shows the unread count), an optional **keep running in the tray when I close the window** setting (off by default), and a single-instance lock so opening the app again brings the first one forward. **Settings export and import** (labels, rules, saved searches, reply template text, notification choices; no accounts or mail; importing twice adds nothing). **Double-click the title bar** to maximize or restore. **Shortcuts for ticked messages:** Ctrl+A ticks all, then e, #, !, Shift+I (read), Shift+U (unread). **Updates** from GitHub Releases (installed app only; untested until a release exists). **Not built:** crash reporting, which needs a server to send reports to.

### Phase 3: Composer and sending
- TipTap editor: formatting, lists, links, quotes, inline images/GIFs, attachments (drag-drop, size warnings).
- From-account switcher mid-draft, per-account signatures, reply / reply-all / forward with correct headers (`In-Reply-To`, `References`).
- Autosave drafts (synced to the IMAP Drafts folder), undo send, scheduled send (local outbox + timezone-aware), attachment reminder, plain-text fallback part.
- Templates/snippets with `{variables}`.
- **Done when:** replies thread correctly in Gmail and Outlook web, and drafts survive crashes.

### Phase 4: Search and organization
- FTS5 search with operators (`from:`, `has:attachment`, `account:`, `before:`).
- Saved searches, local rules (move/label/categorize), contacts auto-collected.

> **Phase 5 status (built):** Auto / Always on / Off modes, detection of streaming software by process name (OBS, Streamlabs, Twitch Studio, XSplit, vMix and more, editable list), global hotkey Ctrl+Shift+L, window excluded from screen and window capture (OS-level), senders, subjects, bodies, account names and errors replaced by bars, composer and dialogs blocked. **Notifications (built):** desktop notifications for new inbox mail (not the first catch-up sync, not mail older than 15 minutes, never likely scams), filtered by category, with quiet hours and one toast for a burst; clicking opens the message. While stream-safe mode is on they are silent by default, or generic ("New message", no sender or subject). **Still open:** a taskbar unread badge, per-account rules, sound choice, a UI to edit the watch list, hotkey customization, per-account exclusions.

### Phase 5: Stream-safe mode (signature feature)
- Toggle (hotkey) that masks senders, subjects, previews, and avatars, silences notifications, and blurs the reading pane.
- Auto-trigger when OBS / Streamlabs / Twitch Studio process is detected, or via manual "Live" toggle; optional per-account exclusions.
- Window content protection (`setContentProtection`) so window capture shows blank.
- **Done when:** nothing identifiable appears in OBS capture while the mode is on.

### Phase 6: Creator workflow
- **Smart categories:** Sponsorship, Collab, Platform notice (Twitch/YouTube/Kick/payouts/strikes), Fan mail, Invoice, Cold outreach. Start with rules and domain lists; optional AI classifier later.
- **Sponsorship board:** kanban (Lead -> Negotiating -> Contracted -> Delivered -> Paid), created from any thread, with rate, deliverables, and deadline.
- **Follow-up reminders:** "needs reply" and "waiting on them" tracking.
- **Deadline extraction:** dates from message text to reminders/calendar.
- **Scam shield:** lookalike-domain, fake-strike, and credential-phish warnings; suspicious attachment flags.
- **Media kit / rate card attach** as a managed attachment with template.
- **Invoice/income tracker** with CSV export.

### Phase 7: Polish and release
- Themes (dark default), notifications, tray, multi-window, import/export settings.
- Auto-update (GitHub Releases), crash reporting (opt-in), accessibility pass, installer signing.
- Optional later: calendar integration, team sharing, mobile companion.

### Phase 8: Mobile (Android + iOS)
- Build after the desktop MVP (Phases 0-3) is stable; the shared packages below should exist before then.
- See the Mobile section for stack and backend.

## Mobile

**Stack:** React Native (Expo, dev client) with TypeScript, so types, zod schemas, categorization rules, and business logic are shared with desktop. One codebase ships Android and iOS.

**Monorepo:** move to pnpm workspaces.
```
apps/desktop   # Electron (current src/)
apps/mobile    # Expo / React Native
apps/push      # push + sync backend
packages/core  # types, zod schemas, rules, categorizer, deal model, templates
packages/mail  # provider adapters behind one interface
```

**Decisions (2026-10-26):** React Native (Expo) rather than native Kotlin, so `packages/core` is shared as is. Android first; iOS follows from the same codebase. Generic IMAP and POP3 accounts are in from the start, not deferred. The sync and push service lives at `sync.itmecasey.com` (the droplet; the hostname makes it movable).

**Mail access on mobile:** raw IMAP sockets and long-lived IDLE are unreliable on iOS (it suspends background apps) and constrained on Android (Doze). Accounts go through provider adapters behind one `MailProvider` interface:
- **Gmail API and Microsoft Graph** for Google and Microsoft accounts: REST, no sockets, tokens stay on the phone.
- **IMAP, POP3 and SMTP** for everything else, through a small native Android module wrapping Jakarta Mail (it speaks IMAP, POP3, SMTP and IDLE and is built for Android; `imapflow` and `nodemailer` need Node sockets and will not run in React Native). Exposed to JS as an Expo module. POP3 has no server folders or flags, so those accounts get an inbox only, with read and star kept locally.
- Generic accounts refresh in the foreground and through WorkManager every 15 minutes. An optional "instant mail" setting runs IMAP IDLE in a foreground service with a persistent notification; it is off by default.
- Local cache in SQLite (op-sqlite or expo-sqlite) with FTS5, same table shapes as desktop where it makes sense.
- Passwords and refresh tokens in the Android Keystore. They are never synced.

**Push backend (required for Google and Microsoft push):** a small Node service at `sync.itmecasey.com`, content-free by design.
- The phone itself calls Gmail `users.watch` (Pub/Sub topic owned by IMC) and creates Graph change subscriptions pointing at the backend, so the server never holds a mail token. Watches and subscriptions are renewed by WorkManager.
- The backend relays each notification as an FCM data message containing only an account id and a message id; the phone fetches the content and builds the notification itself.
- Generic IMAP and POP3 accounts get no server push (that would mean storing their passwords); they use the foreground service above or periodic fetch.
- The backend stores device tokens and subscription state, no mail.

**Sync between devices (settings, not mail).** Mail is never synced through IMC: every device reads the mail server itself, and every device signs in on its own.

What syncs: labels, rules, saved searches, templates, sponsorship deals, snoozes, follow-ups, label and flag assignments on messages (keyed by account email plus the `Message-ID` header, since local row ids differ per device), your own meetings, preferences (holiday country, reminder choices, notification choices), and the account list as names only so the phone can say "sign in to add this account". What does not: mail, bodies, attachments, tokens and passwords, window and tray settings.

Design:
- **Records, not a blob.** Each item is `{id, type, hlc, deleted, payload}` where `payload` is the record encrypted on the device (AES-256-GCM, key never leaves your devices) and `hlc` is a hybrid logical clock, so device clock drift does not matter. Conflicts resolve per record, newest clock wins; deletes are tombstones. Two devices editing different labels never overwrite each other.
- **Authenticated encryption binds the envelope.** The record id, type, clock and deleted flag are authenticated data, so the server cannot swap one record's payload for another's or replay an old version as current.
- **The server is an append log.** A device pushes its changes and pulls everything after the last sequence number it has seen. The server learns record types, sizes and timing, never contents.
- **Pairing without accounts or passwords.** Desktop, Settings, Devices, "Add phone" shows a QR code holding the server address, a random sync-group id and a random 256-bit data key. The phone scans it, creates a signing key (ECDSA P-256) and registers its public key. Every later request is signed. The join proof is derived from the data key with HKDF, and the server stores only its hash, so the server never learns the key. A written recovery code covers a lost phone or a reinstall.
- **Revoking a device** deletes its public key at the server. Rotating the data key to lock a removed device out of future records is a later step.
- **Transport:** HTTPS for push and pull, plus an FCM ping (or server-sent events while the app is open) that says "something changed, pull now". Both sides are offline-first and sync on change, on launch and on a timer.
- **Library first.** The clock, the encryption, the merge, the wire schemas and the pairing code live in `packages/core` (flat `sync-*.ts` files, portable test enforced), so desktop, the phone and the server share one implementation and one test suite.

> **Device sync (desktop and server built):** `packages/core` holds the whole device side (`SyncClient`: finds changes by comparing what is stored with what was last synced, sends and applies records, keeps bookkeeping behind a small storage interface) so the phone reuses it unchanged. `services/sync` is the server (one file, Node 22.13+, SQLite), tested against the real client with two simulated devices. The desktop syncs labels, rules, saved searches, reply templates (without attached files), app and notification choices, sponsorship deals, message labels, snoozes, follow-ups and meetings, every 3 minutes and a few seconds after a change. Settings > Devices turns it on, shows the pairing QR code, lists and removes devices. Things that belong to an account or a message are named by the account address and the Message-ID header; if the account or message is not on a device yet, the item waits and is asked for again every 15 minutes, or at once when an account is added. **Still open:** rotating the key when a device is removed, and clearing old deletion records.

> **Android phase 0 (built):** `apps/mobile` is an Expo (SDK 58, React Native 0.88, React 19) app in the workspace, package `com.itmecasey.imcmail`, URL scheme `imcmail`. `pnpm --filter @imc/mobile bundle` exports the Android bundle and compiles it to Hermes bytecode (`@imc/core` and `sanitize-html` both bundle: 796 modules, 2.7 MB), with no Android SDK needed. A smoke screen runs the shared categorizer, meeting parser, scam shield, link check, sanitizer and sync encryption on the phone. **Findings:** Hermes has no `crypto.subtle`, so sync needs `react-native-quick-crypto` (which needs a development build, not Expo Go); **Verified on a real phone (EAS development build, `react-native-quick-crypto` installed as the Web Crypto polyfill):** the categorizer, meeting parser, sanitizer, link check, scam shield, ECDSA signing and AES-GCM sealing all give the same results as on the desktop. The Expo project is `@itmecasey/imc-mail` (the account name is lowercase). A development build is reached from the computer with `pnpm exec expo start --dev-client` on the same Wi-Fi. **Next:** phase 1, read-only mail for Google and Microsoft accounts.

> **Phone mail over IMAP (library built):** the desktop already reads Gmail and Outlook over IMAP with OAuth tokens, so the phone does the same instead of using the Gmail API and Graph: one protocol for every account, the same scopes and server behavior as desktop, and generic IMAP comes for free. `packages/mail` is a portable IMAP client (sign in with a password or an OAuth token, list folders with their special purpose, read headers and whole messages, change flags) that takes its network connection as a parameter, so it runs in React Native and in tests; the tests run it against an in-memory fake server (27 tests, including responses split at every byte and message text that looks like protocol). The cost is no server push: new-mail notifications from Gmail watch and Graph subscriptions (phase 5) still need the sync service, and generic accounts refresh in the foreground, on a timer, or through an opt-in foreground service. **Next:** a socket for the phone on `react-native-tcp-socket`, OAuth sign-in on the phone (needs an Android OAuth client in Google Cloud and a mobile redirect in Azure), a SQLite cache, and the inbox screens.

> **Android phase 1 (reading mail, built; the newest part untested on a device):** signing in with Google and Microsoft (PKCE, Android OAuth client, refresh token in the keystore), an IMAP connection over TLS with the host name checked (the TCP library is patched, see `patches/`), the inbox, and opening a message all work on a real phone for both providers. Built since and not yet run on the phone: a saved copy of the inbox in SQLite (`packages/mail/src/mailbox.ts` keeps it in step with the server: new mail, deletions, read marks, a rebuilt folder; 8 tests), message bodies saved after first opening, the inbox shown at once from the saved copy and updated afterwards, and HTML mail shown in a locked-down web view (the sanitizer moved from the desktop into `@imc/mail/render` so both use one policy; the page forbids scripts and remote loads, web images stay off until allowed, links in scam-looking messages are turned off). **Needs a native build:** expo-sqlite and react-native-webview. **Next:** try the saved inbox and HTML view on the phone; settings sync on the phone (pairing by pasting the code, then the shared `SyncClient`); sending and replying (SMTP); attachments; push; the IMAP/POP3 account form.

**Android build order:**
0. Monorepo: add `apps/mobile` (Expo dev client), `apps/sync` (server), Android OAuth clients (Google with the app's SHA-1; Microsoft with an `msauth` redirect), check that `packages/core` bundles under Hermes.
1. Sync library in core, then the sync server and the desktop client (testable with no phone).
2. Read-only mail for Google and Microsoft: cache, unified inbox, threads, search, bodies in a sandboxed WebView with the same sanitizer and CSP (check `sanitize-html` under Hermes).
3. Actions and composer: archive, star, read, snooze, send, attachments, drafts.
4. Pairing and settings sync on the phone.
5. Push (FCM, Gmail watch, Graph subscriptions).
6. IMAP, POP3 and SMTP module.
7. Meeting and holiday reminders, day, week and month calendar, privacy cover (`FLAG_SECURE`, optional biometric lock).
8. Internal beta: a sideloaded APK from GitHub Releases (sign every build with the same keystore), then Play internal testing when the $25 Play account exists.

**Mobile feature scope (v1):**
- Unified inbox, thread view, search, swipe actions, snooze, for Google, Microsoft, IMAP and POP3 accounts.
- Composer (TipTap in a WebView or a native rich editor), send-as, attachments from camera/files, drafts, scheduled send.
- Push notifications with per-account and per-category rules.
- Sponsorship board and "needs reply" list (read/update).
- Privacy cover: blur in app switcher, optional biometric lock. Stream-safe mode toggles remotely from desktop where available.
- Deferred: full offline backfill, widgets, share-sheet "save to deal".

**Release:** EAS Build and Submit. Apple Developer ($99/yr) and Google Play ($25 one-time) accounts needed. Gmail restricted-scope verification applies here too, and Apple/Google review will want a privacy policy.

## Risks and decisions
- **Gmail OAuth for public release:** restricted Gmail scopes require Google app verification and a security assessment. For personal use and testing, "Testing" mode (100 users) or app passwords work. Decide before public distribution.
- **Microsoft:** IMAP OAuth is supported for Outlook.com and M365; some tenants disable it. Fall back to Graph API later if needed.
- **Native module:** `better-sqlite3` needs rebuild per Electron version (handled by electron-builder `install-app-deps`).
- **HTML email sanitization** is the main security surface: allow-list, no scripts, no remote loads by default, tested against a corpus of real newsletters.
- **Backend exists after all:** mobile push forces a small hosted service (push + encrypted settings sync). It adds hosting cost and a privacy story to maintain. Keep it content-free.
- **Mobile uses the Gmail API and Graph where it can;** generic IMAP and POP3 go through a native Jakarta Mail module and refresh in the foreground, periodically, or through an opt-in foreground service.
- **Scope control:** ship Phases 0-3 as a usable MVP before any creator features.

## Repo layout (pnpm monorepo; Phase 0 done)
```
IMC-Mail/
  apps/desktop/
    src/main/       # main process, IPC router, SQLite + migrations.ts, (later) safeStorage, updater
    src/preload/    # contextBridge API
    src/renderer/   # React app
    src/worker/     # (Phase 1) sync worker: IMAP, SMTP outbox, DB writes
  packages/core/    # types, zod schemas, IPC contract (shared with mobile later)
  apps/mobile/      # (Phase 8)
  apps/push/        # (Phase 8)
  packages/mail/    # (Phase 1+) provider adapters
```
Commands: `pnpm dev`, `pnpm build`, `pnpm typecheck`, `pnpm test`, `pnpm --filter @imc/desktop package` (Windows installer in `apps/desktop/dist`).

## MVP definition
Phases 0-3, plus stream-safe mode from Phase 5 as the first differentiator.
