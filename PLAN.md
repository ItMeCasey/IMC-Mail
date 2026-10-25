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

**Mail access on mobile:** raw IMAP sockets and long-lived IDLE are unreliable on mobile (iOS suspends background apps). Use provider adapters behind a common `MailProvider` interface:
- Gmail API and Microsoft Graph for Gmail/Outlook accounts (REST, no sockets).
- IMAP via a native module (e.g. react-native-tcp-socket) for generic accounts, foreground sync only.
- Local cache in SQLite (op-sqlite / expo-sqlite) with FTS5, same schema as desktop.
- Tokens in Keychain (iOS) / Keystore (Android).

**Push backend (required):** iOS cannot hold IMAP connections in the background, so new-mail notifications need a server.
- Small service (Node/TypeScript) that subscribes to Gmail watch (Pub/Sub) and Graph change notifications, then sends APNs/FCM pushes containing only an account id and message id (no content). The app fetches content itself.
- Generic IMAP accounts: server-side IDLE needs stored credentials, so these get foreground refresh and periodic background fetch only, unless the user opts in.
- Backend stores device tokens and subscription state; no mail bodies.

**Sync between devices (settings, not mail):** end-to-end encrypted blob sync for accounts list, templates, signatures, rules, sponsorship deals, labels, and stream-safe settings. Key derived from a user passphrase; server cannot read it. Mail itself is never synced through IMC.

**Mobile feature scope (v1):**
- Unified inbox, thread view, search, swipe actions, snooze.
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
- **Mobile skips raw IMAP where possible:** Gmail API and Graph on phones; generic IMAP is foreground-only.
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
