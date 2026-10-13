# The left bar: leads and their task chats

The left bar shows the role leads and the chats of the tasks they are working on, and nothing else.
Patch: `lead-bar` in [PATCHES.md](../PATCHES.md); Ops queue task #132.

The owner (COO home chat, 2026-10-12 ~19:33 PDT, via COO rm-788e4038): "can you add a task to make the
recent chats, to only the lead + the tasks they are working on, no other items in the left hand bar of
pi-web-ui". Display only: no chat, queue, title or identity changes, nothing is deleted.

## What the bar shows

- **One row per role lead**: each identity with a home chat (`UiIdentityInfo.homeChat`), found by
  identity, never by title. Same order as the Roles page: self-start roles first, then the rest, each
  group by role id (`web/src/roles-view-model.ts` `groupRoles`). Rows never move when a chat gets a
  message.
- **A lead row is that chat's row as it works today**, matched by its transcript file:
  - open on the server (a live `conversations` row): its normal row (status lights, needs-you mark,
    TL;DR line, menu);
  - running in another tab or device (an `elsewhere` entry): today's elsewhere row with its take-over
    click;
  - otherwise saved only: an idle row that opens the saved chat (`switch_session`), the way a History
    row does; it uses the History row's name when History lists it, else its saved Recent chats row's
    title, else the identity's title, and keeps that row's "waiting for you" light. Its menu is a
    History row's (Rename works in place), but it has no hover rename or delete buttons, so a lead's
    home chat can't be deleted from the bar by a stray click (All chats still can);
  - home chat file missing (`UiIdentityInfo.homeChatMissing`, worked out by the server): a greyed row
    that can't be clicked, "home chat not found", so a broken lead shows instead of vanishing.
- **Under each lead, the chats of its open, started tasks**, newest first: chat rows, saved task chats
  that aren't rows (`conversations.queueTasks`) and elsewhere entries whose `queueHomeFile` (the
  server's queue links, `server/queue-groups.ts`) is the lead's home chat. These are tasks with their
  own chat that aren't done or removed: working, asking, needs you, waiting, blocked, paused. They keep
  their status marks; the lead keeps the fold toggle and count (queue-grouping; the fold is kept by the
  lead's home chat file, the same key its row has in Recent chats). Folded away, the task chat on screen
  still shows. Tasks not started yet have no chat and stay in the Queue panel; finished tasks leave, as
  before; tasks from queues in non-lead chats aren't in the bar.
- **Open now**: the chat on screen, when it isn't a lead or one of their task chats (a new chat, a
  link, a search result, a pick from All chats), shows as one "Open now" row at the top. A blank new
  chat shows as "New chat". Once another chat is opened it leaves the bar.
- Nothing else is a row: no ad-hoc, subagent, preset or other-folder chats, and no History section.
  The subscription limits box stays at the bottom; it isn't a chat.

## Reaching every other chat

- **New chat** is the + button in the bar's header.
- **All chats** (a button at the bottom) swaps the bar to today's lists, with a Back button: the
  running and recent chats (with their marks, take-over, subagents and queue grouping) and the History
  list (same rows, menus, delete confirm, identity submenu). The bar always opens on the leads again
  (the view resets when the phone drawer or the collapsed panel hides it, and on reload).
- The button counts the chats outside the leads view that are running or wait on a question
  ("All chats · 2 running · 1 asking"), so nothing running is hidden.
- Search (Ctrl+K and the top bar button) works as before.

## Phone

The same view in the phone drawer, with New chat and All chats there. Rows are at least 44 px tall,
and the drawer closes after picking a chat, as before.

## When the bar falls back to today's lists

No leads at all (a DSH server, or no identity has a home chat): the bar is today's bar unchanged
(Recent chats + History). The identity list comes right after the page's first snapshot, so until it
arrives (a moment after loading) the bar shows those lists too.

## How it is built

- Server (`server/queue-groups.ts`, `server/agent-service.ts`, `server/identities.ts`):
  - `queueHomeFile` on each open task chat row (`ConversationSummary`) and elsewhere entry
    (`ElsewhereRunning`): the transcript of the queue chat the task came from, from the same links
    `queueHomeId` uses, whether or not the queue chat is listed (`applyQueueHomes`,
    `applyElsewhereQueueHomes`).
  - `conversations.queueTasks`: saved rows (`live: false`) for the open tasks' chats that aren't in the
    list (neither open nor a Recent chats row), from the listing of all saved chats
    (`unlistedQueueTasks`, `queueTaskRows`), so a lead's task chats show however old they are. The field
    is left out when there are none.
  - All pure and unit tested in `tests/unit/queue-groups.test.ts`.
  - `homeChatMissing` on an identity whose home chat file isn't there (`identityInfos`).
  - Protocol 48 (`server/protocol-version.ts`, `web/src/protocol-version.ts`).
- Client:
  - `web/src/lead-bar.ts` (pure): builds the leads view from the identity list, the chat rows, the
    elsewhere entries, the saved chats and the open chat. Unit tests: `tests/unit/lead-bar.test.ts`.
  - `web/src/components/LeftPanel.tsx` draws it; the old lists move into the All chats view.
  - Strings: `web/src/i18n.tsx` and every file in `locales/`.
  - Every lead row carries its role's tag, so in the left bar the tag's green is mixed toward the text
    colour: White's tag was 3.77:1 on its panel (under WCAG AA's 4.5:1), now about 6.7:1 (`styles.css`,
    `.lp-panel .identity-tag`). The chat header's tag is unchanged.
- Tests: `tests/unit/lead-bar.test.ts`, `tests/unit/queue-groups.test.ts`, and the sealed browser test
  `tests/lead-bar-test.mjs` (1440 and 390 px, dark and light, axe, 44 px phone rows).

## Undo

`pi-web-deploy rollback`. Nothing on disk changes shape, so the old build reads everything as before.
