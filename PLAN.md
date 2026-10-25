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

### Phase 3: Composer and sending
- TipTap editor: formatting, lists, links, quotes, inline images/GIFs, attachments (drag-drop, size warnings).
- From-account switcher mid-draft, per-account signatures, reply / reply-all / forward with correct headers (`In-Reply-To`, `References`).
- Autosave drafts (synced to the IMAP Drafts folder), undo send, scheduled send (local outbox + timezone-aware), attachment reminder, plain-text fallback part.
- Templates/snippets with `{variables}`.
- **Done when:** replies thread correctly in Gmail and Outlook web, and drafts survive crashes.

### Phase 4: Search and organization
- FTS5 search with operators (`from:`, `has:attachment`, `account:`, `before:`).
- Saved searches, local rules (move/label/categorize), contacts auto-collected.

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
