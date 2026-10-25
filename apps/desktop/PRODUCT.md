# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

Electron desktop app (apps/desktop). Renderer: React 19, Tailwind CSS v4 (Vite via electron-vite), TypeScript. Android and iOS companion apps (React Native) are planned later and will share tokens through packages/core.

## Users

Streamers and content creators who run business email alongside their channel: sponsorship and brand-deal threads, collab requests, platform notices (Twitch, YouTube, Kick, payouts, copyright strikes), fan mail, invoices. Built first for its author as a daily driver, then for other creators. Often open on a second monitor in a dim room next to streaming software.

## Product Purpose

A full-featured email client that attaches to many accounts (Gmail and Microsoft via OAuth, any IMAP/SMTP with a password) with a simple interface. It exists so a creator can run all inboxes in one place, answer brand deals without losing them, and not leak private mail while live. Success: one calm inbox, nothing important dropped, nothing private shown on stream.

## Positioning

Creator-specific mail: sponsorship pipeline, smart categories for platform and brand mail, and stream-safe mode that masks mail on screen while live. A general client such as Gmail or Outlook cannot truthfully claim any of these.

## Operating Context

Local-first: mail cache lives on the user's machine. Many accounts at once, each with its own identity color. Used in long sessions, scanning many threads, frequently while streaming or screen sharing. Windows first.

## Capabilities and Constraints

- Built so far: multi-account IMAP sync, Google OAuth (working), Microsoft OAuth (built, awaiting client registration), unified inbox, folder list with unread counts, message list.
- Planned: reading pane and thread view, full composer, search, stream-safe mode, categories, sponsorship board.
- Three user-selectable themes are required: Dark, Mid, Light.
- Tokens must be CSS custom properties usable from Tailwind v4 and portable to React Native later.

## Brand Commitments

Product name is IMC-Mail. It gets its own visual identity: it is not required to match IMC-Chat or IMC-Stream.

## Evidence on Hand

No logo, marketing copy, testimonials, or user data exist yet. Demonstration content must be synthetic and labeled as such.

## Product Principles

- Calm over clever: mail is a task, and the interface should lower anxiety, not add to it.
- Many accounts, one glance: identity color and unread state must be readable at density.
- Safe on camera: nothing about the design may assume the screen is private.
- Scannable first, expressive second: brand lives in precise details, not decoration.

## Accessibility & Inclusion

Treat WCAG AA contrast as the floor in all three themes. Public release to other creators is planned, so keyboard operation, visible focus, and reduced-motion support are required.
