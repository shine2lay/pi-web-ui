# Feature Design: Memory Explorer (`openviking-dashboard`)

## Direction and sources

The live Memory tab is an owner-only explorer: find, browse, read, fix or remove memory.
It is not an activity dashboard. Product intent: [brief-v3.md](brief-v3.md).
Use the existing [app direction](../../design/DESIGN.md) and [tokens](../../design/tokens.json).
API and security contracts remain Architecture-owned in `spec-explorer*.md`.

Design source: `/home/shinelay/design-lab/results/openviking-redesign-20261113/explorer/HANDOFF.md`
(design #315 round 2). Its “exists today” table records the pre-build snapshot, not the current API.
Live implementation: `web/src/components/MemoryExplorerPage.tsx` and `web/src/memory-explorer/`.
This document describes the delivered explorer; do not rebuild the superseded dashboard.

## First view and progressive disclosure

- Header: Memory title, compact health line (up/down/checking, last save, note count, check time).
  Owner account controls appear only after a successful session read; neither Sign out nor
  Passkeys appears during Checking or when owner access is refused (design #317).
- Find comes first: one question box, Search, “By meaning” / “Exact words”, scope selector and
  example questions. Scopes cover everything, shared notes, project documents and departments.
- Work area starts with “Changed most recently” (12 notes). Search replaces it with results:
  title, plain-language match strength or matching line, location, kind, change age, size and summary.
- Open a folder: breadcrumb, copyable path, metadata, summary/overview and paginated contents.
  Open a note: title, copyable path, metadata, Edit/Delete and “How memory keeps it”:
  one-line summary, folded overview and full text. Missing summaries say “No summary written yet.”
- “Where memory keeps things”: tree grouped into shared notes, project documents and departments;
  folder note counts and kind bars help browsing. Back returns focus to the originating row.
- “Changes you made”: recorded edits/deletes and their undo status, not chat activity telemetry.

## Changes and access

Edit keeps full text in a textarea. Save requires confirmation with old/new length and explains
when chats receive the new text. Delete confirms the named note and location and explains the
consequence. Both offer 10-second Undo and record the change. Folders are not deletable here.
Setup files (`identity.md`, `soul.md`) are locked: no text disclosure or mutation controls.
Owner-only access is enforced by the server, not merely hidden buttons. Passkey sign-in replaces
protected content when access is refused; use the owner contract for exact ceremony details.

## Screen states

| State | Visible behaviour and recovery |
|---|---|
| Live | Real tree, recent notes/results and reader; edits enabled only when memory answers. |
| Loading | Checking health; placeholders while lists/tree load; no invented zero counts. |
| Empty | No notes or no search matches stated plainly; offer the other search method or Everything. |
| Partial | Missing summary gets its own explanation; available content remains readable. |
| Memory down | Show down status and last-seen age; retain any loaded snapshot, identify its age; disable editing/deleting with a reason. |
| Read/search error | Explain the failed operation and offer retry without exposing secrets. |
| Save error | Keep the draft text, explain failure and offer Try again. |
| Confirm / pending | Named edit/delete confirmation, immediate busy feedback; prevent duplicate changes. |
| Done / undone | Saved/deleted toast and change record; Undo updates the list; failed Undo explains recovery. |
| Owner checking / refused | No account controls during Checking; refusal shows passkey sign-in instead of notes. |

## Responsive layout and accessibility

At 1440px the tree is a 330px left column beside the work area. Below 1000px use one column,
with the tree after the work area; support 390px and 320px without horizontal overflow.
Use light and dark app themes, visible keyboard focus, labelled controls and modal focus containment.
Status is text as well as colour. Paths are copyable data, not jargon used as navigation labels.

## Show&Tell

Explorer Show&Tell: `/showtell/#/d/d_mtpsg67izk` v2 (source RUN.md).
The explorer hand-off above is the canonical design reference; no new owner review is requested
for this documentation cleanup. The previous dashboard Show&Tell is not the build target.

## Reference Screenshots

Live explorer account-state captures (@2x, 320/390/1440, light/dark):
`/home/shinelay/design-lab/results/memory-explorer-317/ui/checking/1440-dark@2x.png`
and `/home/shinelay/design-lab/results/memory-explorer-317/ui/checking/390-light@2x.png`.
Other widths/themes and signed-in states are alongside these in the same ui evidence directory.
The source hand-off's old shots directory is absent; use these live captures instead.
Live account-state proof:
`/home/shinelay/design-lab/results/memory-explorer-317/proof.md`.

## Prototype-only exclusions

Never ship sample-state menus, fake app tabs, theme/demo bars, preview notes, fixed snapshots,
local fixture searches, sampled/truncated note content or in-memory fake mutations. Do not mount
`#stateStrip`, emit `data-st-state`, define `window.__hidePrototypeChrome`, or branch on prototype
query overrides. Live reads and changes use the explorer API seam, not embedded fixture payloads.

## Cleanup hypothesis and check

Problem: retired dashboard docs/checks still specified a removed UI and data contract.
Change: replace that guidance with this explorer reference and remove its unused prototype artifacts.
Expected result: no retired field/route references outside Architecture specs and tests; documentation
checks and the repository gate pass. Any remaining non-spec consumer disproves cleanup completeness.
