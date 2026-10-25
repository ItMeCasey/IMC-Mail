---
version: 1
slug: "src-renderer-src-app-tsx"
primary_target: "src/renderer/src/App.tsx"
related_targets: ["src/renderer/src/Sidebar.tsx","src/renderer/src/MessageList.tsx","src/renderer/src/AddAccount.tsx","src/renderer/src/styles.css"]
---

# IMC-Mail app shell (renderer)

Mode: Operate. Surface: the whole mail window (sidebar, thread list, add-account dialog). Audience: streamers and creators scanning many threads across many accounts, often on a second monitor, sometimes on camera. Task: see what needs an answer, across accounts, fast.

## Direction contract

THESIS: The inbox is a session track sheet: every thread a numbered, ruled row marked up in pen. Refuses the default three-pane grey SaaS arrangement with soft cards, shadows, and one blue accent.

OWN-WORLD: Flat ruled sheet. Ink graphite text, hairline rules, account identity as console-tape colors on a left tab column, red pen for needs-reply, blue pen for pinned/selected, yellow tape for attention. No gradients, glows, or shadows. One grotesque in few sizes; tabular numerals for track numbers and times. Three themes from one token set: Dark (studio board, near-black, bone ink), Mid (graphite slate, lower contrast), Light (cool white sheet).

STORY: The user sees at once which account each thread belongs to, which are unread, which wait on them, and that nothing is hidden. They answer the next marked row.

FIRST VIEWPORT: Left, a narrow column of account tabs in tape colors with folders beneath. Center, a ruled sheet with a header row (No, From, Subject, Waiting, Date) and one row per thread at about 36px; each row starts with a track number in tabular numerals and an 8px square account-tape chip (a filled mark, never an edge stripe). Right of each row, a marks column: unread dot, star, needs-reply circle. Add account sits at the foot of the account column beside the theme switch (Dark / Mid / Light).

FORM: Studio Track Sheet, roll candidate 6 of 7 (seed key e477bda7). Raised by: emission-line (state in mark form, not hue alone), japanese-density (hairline modules, small header tabs), zoo-map (flat color only).

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
