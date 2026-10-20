# chat-slots: open-chat limit 40, and empty chats never hold a slot

Ops #266. Owner, 2026-10-19 19:2x: "This project already has the max open conversations (24). Open one and
leave it (without continuing) to remove it from the list. this needs to be fixed"; then, in the dialog,
19:3x: "raise it to 40". PATCHES.md entry `chat-slots`.

## Evidence (2026-10-19, from the app's own state: counts and titles only, no chat text)

- 19:28: the rollcall project held 24 open chats, the limit: 14 real ones and 10 blank "New chat" chats.
- Blank chats aren't shown in the left list (`shownInRunningList`), but every open chat of the project
  counted toward `MAX_OPEN_CONVERSATIONS` (`server/conversation-limits.ts`). `dismissConversation` refuses
  a chat that isn't listed, so the owner had no way to close them, and the message told him to do something
  that couldn't work.
- 8 of the 10 came from Ops' look-only checks: each run connected with a new pseudo client id
  (`carry-on:ops-live-look-load-*`). A pseudo client's session starts with a blank chat of its own; when the
  client left, nothing closed it, so it stayed until the next restart. The other 2 were windows' blank chats.
- The restart at 19:33 freed them (journal: "[carry-on] restarted (free open-chat slots held by 10 hidden
  empty chats)"; 32 open chats before, 13 after).

## H-CHAT-CAP-1

- **Wrong.** Blank chats nobody can see or close fill the project's slots (10 of 24 at 19:28).
- **Change.** Blank chats stop counting toward the limit and close by themselves, and the limit is 40:
  - Blank means the same test `newChatNow` uses to reuse a chat: no messages, no terminals, no queue
    entries, not a retained Team participant. Both engines (pi and DSH).
  - A pseudo client's blank chat (`carry-on:`, `plugin:`, `scheduler:`) closes as soon as that client
    disconnects.
  - Any other blank chat that no connected window has open closes after 10 minutes (a sweep every minute).
  - A window that comes back after its blank chat closed gets a fresh blank chat.
  - Closing reuses the existing release path (`removeConversation`); no new way of disposing a chat.
  - Never closed: a chat with messages, a running one, one a connected window has open, a role's home
    chat, a task's chat, a Team participant, one with terminals or queue entries, or one with an unsent
    draft in its composer.
  - One limit message everywhere: "This project has 40 open chats, the most it can hold. Close one in the
    left list (✕) to open another."
- **Expected.** The focused unit tests and the sealed browser test pass (30 pseudo clients come and go and
  the open count doesn't change; 39 real + 5 blank chats still let a new chat open; 40 real chats show the
  new message; a window whose blank chat closed reconnects to a fresh one). Live, after one look run with 3
  new pseudo ids, the project's open-chat count is back to its earlier number within 2 minutes.
- **Disproved if.** Blank chats still pile up live: more blank open chats than connected windows after an
  hour of normal use. Then find the other source before going on.

## Result

**H-CHAT-CAP-1: HIT** on its measures, with one side effect in the server log (H-CHAT-CAP-1b below).

- Checks before landing: focused vitest 7 files, 76 tests passed; sealed `chat-slots-test` and
  `conversation-capacity-test` passed (30 pseudo clients came and went and the count was back in 46 ms,
  without the sweep; the sweep closed the away window's blank chat after 3.8 s with a 4 s idle time).
- Landed as 7610a8e4 (wt land 96-4820ee, batch 94-7ebb6f, checked once); live since the 21:04 install.
- Live look, 2026-10-19 21:08, counts only (`GET /api/open-chats`), one look run with 3 new pseudo ids
  (`carry-on:ops-live-look-chat-slots-1..3`): before, all projects: open 23, counted 23, blank 0; with the
  three connected: open 26, counted 23, blank 3; after they left: open 23, counted 23, blank 0, back
  **52 ms** after they left (limit 2 minutes). No server restart during the look. Receipts:
  `~/kept-from-tmp/2026-10-19/chat-slots-live/run1/result.json`.
- Side effect: the install's own check failed its log step, "the log has 2 crash-guard notices". Server,
  page, reply and big chat passed; the install stayed.
- Final build 05129317 (with H-CHAT-CAP-1b), installed 21:31, all checks passed. Second look run at 21:33
  with 3 new pseudo ids (`carry-on:ops-live-look-chat-slots-b-1..3`): before, open 24, counted 24, blank 0;
  with the three connected: open 27, counted 24, blank 3; after they left: open 24, counted 24, blank 0,
  back **74 ms** after they left. No server restart during the look. Receipts:
  `~/kept-from-tmp/2026-10-19/chat-slots-live/run2/result.json`.
- The "Disproved if" check (blank chats piling up after an hour of normal use) runs at 22:35, an hour
  after the install: blank open chats per project against the server's open connections. Its result goes
  in the Ops note; a MISS there opens a new task.

## H-CHAT-CAP-1b: a blank chat closed on purpose isn't logged as a crash

- **Wrong.** The 21:04 install of 7610a8e4 failed pi-web-deploy's log check: two lines
  `[crash-guard] window carry-on:pi-web-check-page: its chat c2 was closed (its blank chat was closed); no open
  chat to move it to yet, it gets one when it reconnects` (and c3). The check's own page client left, its
  blank chat closed as designed, and `recoverLostActive` logged that window's planned outcome under the
  crash tag. pi-web-check counts every `[crash-guard]` line except "moved it to", so every install from
  now on would fail its log step, and a real crash notice would hide among these.
- **Change.** When the chat a window lost is the blank chat chat-slots closed for it (`releasedBlankId`),
  `recoverLostActive` logs one `[chat-slots]` line instead (console.log, not console.warn): it gets a fresh
  blank chat when it comes back, or one is opened now. Real crash recoveries keep their `[crash-guard]`
  lines unchanged. The closing itself doesn't change.
- **Expected.** A unit test: a window whose released blank chat is gone logs no `[crash-guard]` line, and
  one whose chat closed any other way still does. The sealed `chat-slots-test` reads its server's log: no
  `[crash-guard]` line besides "moved it to", and at least one `[chat-slots]` closing line. The next
  install's checks all pass, the log step included.
- **Disproved if.** The next install's log step still finds crash-guard notices from a blank chat closing;
  then find which path logs them.
- Checks before landing: `tests/unit/crash-guard.test.ts` 19 passed (the new case fails on the old code,
  which warns `[crash-guard]` for the released chat); sealed `chat-slots-test` passed, "31 blank chats
  closed, logged as [chat-slots]; no crash-guard notice in the log", and `conversation-capacity-test`.
- **Result: HIT.** Landed as 05129317 (wt land 100-9840db). The first try, 98-6864df, failed only on an
  unrelated 5 s timeout: `tests/unit/initiatives-projects-done.test.ts`, 5467 ms at load average 23; it took
  2.2 s in its two earlier gates, so this was its first sighting. Installed 21:31: `pi-web-deploy result
  05129317` = "live, and the checks all passed" (server, page, reply, big chat and log). Live log since
  21:31: no `[crash-guard]` line; 5 blank chats closed, each logged as `[chat-slots]` (the install check's 2
  page clients and the look's 3).
