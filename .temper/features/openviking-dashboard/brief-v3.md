# Memory Explorer: Product Brief, v3

Replaces the original dashboard brief and brief-v2's order. Carried into the repo from
`/home/shinelay/design-lab/results/openviking-redesign-20261113/brief-v3.md` (design #315).
The source's prototype data snapshot and pre-build API gaps are historical; the requirements below
are the explorer's current product intent, not a claim that those gaps remain open.

## User Moment

The owner, on a laptop (1440px) or phone (390px), opens pi-web-ui's Memory tab to find out what
memory knows, see where and how it is stored, and fix or remove what is wrong. It also fits 320px.

Owner, comment c_zz6upftr56, 2026-11-13: “i like P better but ultimately its the content and how
its displayed i want to be able to look at all the path we have and how its stored, i want to be
able to query and get results out. i want to be able find things, not just ops asked and it
worked... it has no value to me”. Dialog dr-57cc897d32d3: “Also delete or fix entries”.

## Metrics vs Noise

1. Find first: one box, By meaning / Exact words, scoped to everything, shared notes, a department
   or project documents. Results show title, copyable stored path, summary or matching line,
   changed time and match quality in plain words, not raw scores.
2. Browse every path: shared notes, project documents and each department's notes. Folder counts,
   file sizes and change times help inspection. Plain folder labels do not conceal real paths.
3. Read how memory keeps it: one-line summary, overview and full text. Explain missing summaries;
   show author/task/time only when a record supports it.
4. Fix or remove notes: confirm the named change, offer roughly 10-second Undo, and record what
   changed, which note, when and by whom. Never delete folders from this page.
5. Status is one compact line: whether memory is up, last save and total notes. Activity reporting
   about chats receiving and saving memory is not the purpose of this page.

Use plain language in labels; paths may retain their technical spelling as data. Turn file names
into readable titles. Do not show internal protocols, implementation terms or storage jargon as
headings/buttons. Reuse pi-web-ui's established light/dark themes and design tokens.

## Non-Goals

- No old activity dashboard, summary-card telemetry or internal-operation glossary.
- No unauthenticated access, setup-file disclosure or bypass of server write protections.
- No full-text walls in result rows, fake health, invented counts or prototype-only controls.
- No claim that the source prototype's fixed counts/search samples describe the current store.

## Screen States

Live; loading; memory down with any retained snapshot labelled and editing off; no search results
with alternate-method/scope recovery; empty department; missing folder summary; confirmation;
Undo; failed save retaining the draft and offering retry; owner checking and passkey sign-in.
See [design.md](design.md) for the delivered state's presentation.

## Acceptance Checks

- In five seconds the owner can type a question or open a folder and see relevant notes/contents;
  in thirty seconds he can inspect a note's three levels and fix or remove it.
- Search supports meaning and exact words with scope, clear result context and no-result recovery.
- Tree/folder/note views expose copyable paths and honest missing-data states; setup files stay locked.
- Edits/deletes confirm first, offer Undo and a change record; failures retain work and allow recovery.
- Loading/down/access-refused states are honest; 320/390/1440 light/dark fit without overflow,
  overlap or browser errors, using the standard documentation, repository and UI checkers.
