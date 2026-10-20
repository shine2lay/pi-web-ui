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

(written after the live check)
