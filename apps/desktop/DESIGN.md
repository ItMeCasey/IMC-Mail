---
name: IMC-Mail
description: A flat, ruled track sheet for running many inboxes, in Dark, Mid and Light themes.
colors:
  dark-ground: "#0d0f12"
  dark-sheet: "#171a1f"
  dark-ink: "#e8ebef"
  dark-ink-muted: "#8f97a3"
  dark-accent: "#7d9fff"
  dark-alert: "#ff7a70"
  dark-line-strong: "#667180"
  mid-ground: "#2a2f36"
  mid-sheet: "#373e48"
  mid-ink: "#f0f2f5"
  mid-ink-muted: "#b8c0cb"
  mid-accent: "#9db8ff"
  mid-alert: "#ffa098"
  mid-line-strong: "#96a0af"
  light-ground: "#e6e9ed"
  light-sheet: "#fafbfc"
  light-ink: "#1b1f24"
  light-ink-muted: "#5b6571"
  light-accent: "#2650c9"
  light-alert: "#bf241b"
  light-line-strong: "#7d8794"
typography:
  title:
    fontFamily: "Geist Variable, Segoe UI Variable Text, Segoe UI, system-ui, sans-serif"
    fontSize: "0.9375rem"
    fontWeight: 600
    lineHeight: 1.2
  body:
    fontFamily: "Geist Variable, Segoe UI Variable Text, Segoe UI, system-ui, sans-serif"
    fontSize: "0.8125rem"
    fontWeight: 400
    lineHeight: 1.4
  label:
    fontFamily: "Geist Variable, Segoe UI Variable Text, Segoe UI, system-ui, sans-serif"
    fontSize: "0.75rem"
    fontWeight: 500
    lineHeight: 1.4
rounded:
  sm: "2px"
  md: "4px"
  full: "999px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "12px"
  lg: "16px"
  xl: "24px"
components:
  button-primary:
    backgroundColor: "{colors.dark-accent}"
    textColor: "#0a1020"
    rounded: "{rounded.md}"
    height: "36px"
    padding: "0 16px"
  button-secondary:
    backgroundColor: "transparent"
    textColor: "{colors.dark-ink}"
    rounded: "{rounded.md}"
    height: "36px"
    padding: "0 16px"
  input-field:
    backgroundColor: "{colors.dark-sheet}"
    textColor: "{colors.dark-ink}"
    rounded: "{rounded.md}"
    height: "36px"
    padding: "0 12px"
  thread-row:
    textColor: "{colors.dark-ink}"
    height: "36px"
    padding: "0 12px"
---

# Design System: IMC-Mail

Normative values live in `src/renderer/src/styles/tokens.css`; this file describes how to apply them. Contrast of every pairing below is enforced by `tokens.test.ts`.

## Overview

**Creative North Star: "The Track Sheet"**

IMC-Mail is a session sheet for a creator's mail: every thread is a numbered row ruled in hairlines, marked up like a producer's pen on a studio track sheet. It is flat. Surfaces are tonal steps of one cool graphite family, separated by 1px rules. Nothing glows, floats, or casts a shadow.

The system is built for scanning many accounts at once, on a second monitor, sometimes on camera. Account identity is a filled square of console tape beside each row; state is carried by the shape of a mark as well as its color. Brand lives in these precise details, not in decoration.

Three themes share one token set: Dark is the studio board for dim rooms; Mid is a lower-contrast graphite slate for bright days; Light is a cool white sheet.

**Key Characteristics:**
- Flat tonal layering, hairline rules, no shadows or gradients.
- Square-leaning geometry: 2px and 4px radii only.
- One grotesque family, tabular numerals for data.
- Accent color only for selection, primary actions, links, and the unread mark.
- State carried by mark shape and weight, never hue alone.

## Colors

A restrained palette: tinted graphite neutrals, one blue pen accent, one red pen alert, yellow tape for attention. Hex values in the frontmatter are the Dark, Mid and Light sets for the roles that carry text and borders; the full semantic set (`--ground`, `--rail`, `--sheet`, `--raised`, `--hover`, `--selected`, `--line`, `--ink`, `--ink-2`, `--ink-3`, `--accent`, `--alert`, `--attn`, `--ok`, `--tape-1..8`) is in `tokens.css`.

### Primary
- **Blue Pen** (Dark #7d9fff, Mid #9db8ff, Light #2650c9): primary actions, links, the selected row tint, the unread mark, focus ring.

### Secondary
- **Red Pen** (Dark #ff7a70, Mid #ffa098, Light #bf241b): errors and "needs a reply" marks. Always paired with an icon or ring, never color alone.

### Neutral
- **Studio Board** (Dark ground #0d0f12, Mid #2a2f36, Light #e6e9ed): the window ground behind the panes.
- **Sheet** (Dark #171a1f, Mid #373e48, Light #fafbfc): the thread list and form inputs.
- **Rail** (a step off the sheet): the sidebar and the table header.
- **Ink** (primary text), **Ink 2** (secondary), **Ink 3** (metadata): all three reach 4.5:1 on every surface.
- **Rule** (`--line`) for hairlines; **Strong Rule** (`--line-strong`) for control borders, at least 3:1.

### Tape
Eight account identity colors (`--tape-1..8`), retuned per theme so each reaches 3:1 on sheet, rail and raised surfaces.

### Named Rules
**The One Pen Rule.** The blue accent appears on selection, the primary action, links, focus, and the unread mark, and nowhere else.
**The Flat Color Rule.** Every fill is one flat token. No gradients, glows, blurs, or shadows.
**The Shape Over Hue Rule.** A state is never signaled by color alone: unread is a solid mark, needs-reply a ring, waiting a dashed ring, handled a strike, priority a doubled ring (`.mark-*` in `base.css`).

## Typography

**Font:** Geist Variable, self-hosted via `@fontsource-variable/geist`, with Segoe UI Variable and the system stack as fallback. One family carries everything.

**Character:** A neutral, slightly engineered grotesque that stays out of the way and sets numerals cleanly.

### Hierarchy
- **Title** (600, 0.9375rem, 1.2): the view heading above the sheet.
- **Dialog heading** (600, 1.125rem, 1.2): modal titles and empty-state headings.
- **Body** (400, 0.8125rem, 1.4): rows, labels, controls.
- **Label** (500, 0.75rem): table column headers, account names, field labels.
- **Meta** (400, 0.75rem, `--ink-3`): dates, counts, helper text.

Numbers (track numbers, dates, unread counts, ports) use `.num` for tabular figures. The scale is fixed rem, not fluid. Prose measure stays under 75ch.

### Named Rules
**The Tabular Rule.** Any column of numbers uses tabular figures.

## Layout

A two-region window: a 15rem rail on the left, the sheet filling the rest. The sheet is a real table: sticky header, 36px rows, fixed columns for track number, tape chip, sender, subject, date, and marks, with the subject taking the remaining width and truncating on one line. Spacing follows a 4px base (4, 8, 12, 16, 24, 32, 48). The window minimum is 900px wide; the rail does not collapse yet.

## Elevation & Depth

Flat by design. Depth is a tonal step (ground, rail, sheet, raised) plus a 1px hairline. The modal is distinguished by a `--raised` fill, a `--line-strong` border, and a scrim over the page; it has no shadow.

### Named Rules
**The No Shadow Rule.** If a layer needs separating, step its tone or draw a rule. Never add a shadow.

## Shapes

Square-leaning. Controls use a 4px radius, the tape chip a 2px radius, marks and scrollbar thumbs are fully round. Rows are not cards: they are ruled lines with no radius, no inset, and no individual container.

## Components

### Buttons
- **Primary:** blue-pen fill, on-accent text, 36px high, 4px radius, medium weight. Hover steps to `--accent-hover`; disabled drops to 60% opacity.
- **Secondary:** transparent, 1px strong-rule border, ink text; hover fills with `--hover`.
- **Focus:** 2px accent outline with 2px offset on every focusable element.

### Inputs / Fields
- **Style:** `--sheet` fill, 1px `--line-strong` border, 4px radius, 36px high, visible label above (not placeholder-only).
- **Focus:** the border shifts to the accent.
- **Error:** a bordered alert block with a warning icon and plain text naming the problem.

### Navigation (rail)
- 32px rows with a 16px line icon, label, and a tabular unread count. The selected row takes the `--selected` tint and medium weight, with `aria-current`.
- Each account is a labeled group: tape square, name, sync state (icon plus text), hover-revealed sync and remove icons.
- A three-way theme switch (Dark, Mid, Light) is a radio group at the foot of the rail.

### Thread row (signature)
36px, one hairline rule below, hover tint. Reads left to right: track number, tape chip, sender, subject, date, marks. Unread rows are semibold with a solid mark; read rows use secondary ink.

### Compact list row
With a message open, the sheet narrows to a 26rem two-line list (`--list-w`): tape square, sender and time on the first line, subject and marks on the second, 1px rule below. The open row takes the `--selected` tint. A conversation shows its size as a small outlined count, so it reads without color.

### Reading pane
A hairline-ruled stack, not cards. The header carries the subject, message count, and icon actions (mark read/unread, star, close). Each message is a full-width row that expands in place: sender, address and date on top, then recipients when open or a one-line snippet when collapsed. The newest and the selected message start expanded.

### Email frame
Message HTML always renders on white inside a bordered, sandboxed frame, because senders design for white; only plain-text mail follows the theme. Remote images are hidden by default behind a bordered notice with "Show images" and "Always for this sender". Attachments are outlined chips with a paperclip, name, and tabular size.

### Composer
Takes the reading pane's slot, so the list stays visible beside it. Header fields are hairline-ruled rows with a fixed 40px label column: From (tape square plus account select), To / Cc / Bcc as recipient chips, Subject. Invalid recipients get an alert border and a title. A single icon toolbar sits above a plain editing surface with no inner box. Send is the one primary button; Ctrl+Enter sends. A bordered raised bar at the bottom center shows the undo countdown, then "Sent", or the error with an Edit action.

### Category tag and smart views
A category shows as a small outlined text label (`border-line-strong`, 11px), never as a color; plain mail gets no tag. The sidebar groups Needs reply, Waiting on reply, the Sponsorship board and one row per non-empty category under All inboxes, each with a line icon and a tabular count. The open view takes the `--selected` tint.

### Composer menus
The template menu (toolbar icon) and the schedule menu (arrow attached to the right edge of Send) are bordered `--raised` popovers with 32px rows, closing on outside click or Escape. The Send button and its arrow are one accent-filled control separated by a hairline in `--on-accent` at 40%. Placeholders such as {{rate}} stay as visible text until filled; a status line names what is left.

### Settings dialogs
Small modal `<dialog>` forms (28rem, `--raised`, `--line-strong` border, no shadow): a heading, grouped fieldsets with a muted legend, native checkboxes and radios in the accent, time inputs styled like text fields, one primary Done button. Changes save immediately, so there is no Cancel.

### Scam warnings
In lists, `Likely scam` (alert border and text, shield icon) and `Suspicious` (neutral border, triangle icon) tags sit before the category tag, always icon plus words. In the reading pane a bordered notice precedes a flagged message body: a headline with icon, a bulleted list of plain-language reasons, one line of advice, and two outlined buttons. The border is `--alert` only for danger; caution stays neutral. Links in dangerous mail render struck through and inert.

### Sponsorship board
Five flat columns (Lead, Negotiating, Contracted, Delivered, Paid) on `--rail` with hairline dividers; Passed is hidden behind a toggle. Cards are 1px-ruled `--sheet` blocks with brand, rate, a two-line deliverables note and a deadline; an overdue deadline turns `--alert` and gains a warning icon and the word Overdue. A card is dragged between columns, or moved with the stage select that appears on keyboard focus. A dragged-over column takes the `--selected` tint.

### Meeting invitation and agenda
The invitation card is a ruled box in the reading pane (`border-line-strong`, no fill): title and local-time range, then place, organizer and attendees as a quiet list, a conflict note in words, and one row of actions. Join is the single accent button; Accept, Tentative and Decline are outlined with an icon and a word each, and the chosen answer is shown with `aria-pressed` and a selected fill plus a sentence, never color alone. The agenda is a ruled day list (sticky day heads, time column, title, place, and a bordered status word). The meeting dialog reuses the dialog and recipient-chip patterns.

### Search box
Sits at the right end of the list header (about 18rem, capped at 45% of the list): a 32px field with a leading search icon and a clear button, using the same input styling as forms. Focused and empty, it opens a bordered raised cheat sheet of query examples in tabular type. Results replace the list under the title "Search results" with a count.

### Message actions
A row of icon buttons in the reading pane header, after Reply / Reply all / Forward and a hairline divider: Archive, Move to Trash (becomes Delete forever inside Trash and Junk), Report as junk, and a Move menu listing the account's other folders in a bordered raised popover. Destructive actions have no color treatment; the permanent one asks for confirmation instead.

### Redaction
When stream-safe mode is on, private text renders as a flat `--line-strong` bar roughly the length of the text (`.redacted`); the real string never reaches the DOM. Message bodies and the composer are not mounted or are hidden, replaced by a centered notice with an eye-off icon. The sidebar footer shows the mode with a shield icon and the reason ("Automatic: obs64.exe is running"), tinted `--selected` while active.

### Layering
`base.css` wraps resets in `@layer base` and component classes (`.mark`, `.tape`, `.composer-body`) in `@layer components`, so Tailwind utilities always win. Never add unlayered element selectors: they silently beat utilities.

## Do's and Don'ts

### Do:
- **Do** take every color from a semantic token; never write a hex in a component.
- **Do** keep text at 4.5:1 and control borders at 3:1 in all three themes (run the token tests after changing a value).
- **Do** carry state with a mark shape plus color.
- **Do** use `.num` for any column of figures.
- **Do** show hover, focus-visible, disabled, loading (skeleton rows), empty, and error states on every control.

### Don't:
- **Don't** add shadows, gradients, glows, or backdrop blur.
- **Don't** use a colored stripe on the edge of a row or card; account identity is a filled tape square.
- **Don't** use an emoji or text glyph as an icon; draw icons from the Lucide set at 1.75 stroke.
- **Don't** let a state rely on color alone.
- **Don't** use Tailwind's default palette; it is disabled, so only token-backed color utilities compile.
