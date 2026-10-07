# The roles' board

One place for news and the owner's orders that several roles need, instead of the same message to
each role. Patch: `role-board` in [PATCHES.md](../PATCHES.md); queue task #76.

The owner (Telegram, 2026-10-06 ~12:25 PDT, via COO): "Lets create a message board that everyone can
check, instead of poking the same message to all roles that needs to read it. Have one place where
the roles can read it. Unless its a direct requests. Those should go directly." His routing rule
(~12:35): "If the role has something waiting then the message should go directly to them. Because
something needs to poke it to wake its session otherwise general info should be put in the message
board". AGENTS.md rule 13 has the Board's exception line and this routing line.

## What goes where

| Message                                         | Where it goes                                            |
| ----------------------------------------------- | -------------------------------------------------------- |
| A request, question or reply to one role        | `message_role` (starts a turn there), as before          |
| An fyi to one role                              | `message_role` fyi (no turn), as before                  |
| General info several roles need                 | a **news** post on the board: it wakes nobody            |
| The owner's order to several roles              | an **order** post: sent directly only to the roles that have something waiting |

Nothing new on Telegram: the owner tells COO, and COO posts with his words.

## Posts

Kept in `~/.pi-web-ui/role-board.json` (`server/role-board.ts`), written atomically like
`role-messages.json`; `pi-backup` covers the whole folder. A post has:

- `id` (`bp-<8 hex>`) and `at`;
- `from`: "owner" or a role id, with `via` when another role relays the owner (COO);
- `kind`: `order` or `news`; `to`: "all" or a list of role ids;
- `title` (at most 100 characters) and `text` (Markdown, at most 2,000);
- `ownerWords`: required on an order a role posts: the owner's words and where they came from;
- `sent {role: {at, how}}`: the roles an order reached directly (`steer` or `turn`);
- `closed {at, by, note}`, `reads {role: at}`, `done {role: {at, note}}`.

Who posts: the owner on the Board view (either kind); roles with the `board` tool (news for several
roles; orders only on the owner's word, with `ownerWords`). A role may post 10 an hour. No department
directives; a request-only role posts only about requested work or changes that affect others
(rule 14). Closed posts are kept (the store keeps 1,000, oldest closed first; the page shows the newest
200).

## Routing an order

Posting wakes nobody by itself, and news never pokes anyone. When an order is posted, each listed role
is checked from the Roles page's own data. It **has something waiting** when:

- (a) one of its chats is mid-turn;
- (b) its queue has a task that is not done or removed (ready, working, asking, stuck, waiting,
  blocked, or paused by the owner);
- (c) a request or question to it has no reply yet.

Such a role gets the order directly:

- (a): one steer into each of its mid-turn chats (only while that turn still runs, so a steer never
  starts a turn);
- (b) or (c), with its home chat not mid-turn: one message to its home chat that starts a turn,
  headed `[Board order <id> from <poster> (via <relay>) · <time>]`, through the path role requests use
  (opened in the background, tried again every 3 seconds while busy, sent exactly once, given up after
  24 hours). Its turn counts as role-started, so Telegram leaves it out. It is not a role request,
  asks for no reply, and ends with the ack line.

The others get no poke and see the order at their next turn. The post's `sent` says who got it how.

## What a role sees

At the start of each turn in a chat with a role, the posts that chat hasn't seen are added before the
turn as one note, saved in the transcript (the system prompt stays the same, so the prompt cache
stays):

```
[Board] 2 new posts

Order bp-1a2b3c4d · from owner (via coo) · 2026-10-06 12:40 PDT · to backend, frontend, systems
**Pause new work**
Finish what you have; start nothing new.
Owner's words: Telegram 12:35: "pause new work until I say"
When you have acted on it: board ack bp-1a2b3c4d "<what you did>"

News bp-5e6f7a8b · from systems · 2026-10-06 13:05 PDT · to all roles
**Deploy at 15:00**
The app restarts at 15:00 for a few seconds.
```

A post closed after the chat saw it adds one line, once:
`Ended: order bp-1a2b3c4d "Pause new work", closed by owner 2026-10-06 16:56 PDT: pause lifted`.

- Orders show in every chat of the listed roles, in full. News shows only in the role's home chat (in
  all its chats if it has none), cut at about 600 characters with `board read <id>` for the rest.
- At most 20 posts in one note; the rest: `board read`.
- A chat's first turn sees only open orders, plus, in a home chat, news from the last 3 days.
- An order a chat got directly (steer or the direct turn) counts as seen there.
- A post closed after a chat saw it shows there once as ended.
- A role's read time is set the first time any of its chats sees the post.
- Each chat keeps its own "seen up to" mark in the note's details, so it survives reloads.
- A task the owner paused sees the posts when it resumes.

In the chat view, "[Board]" notes and "[Board order]" messages fold to one row like role messages
("From the board · 2 new posts", "From owner · Board order · Title: first words"); a click opens them.

## The board tool

`board` (`server/board-tool.ts`), in every chat with a role (always allowed, like `notebook`):

- `read`: no id, the open posts for the role (newest first, 20); with `id`, one post in full.
- `post`: `kind`, `to`, `title`, `text`; `ownerWords` for an order.
- `ack`: `id`, `note` (what you did). Orders only, once per role (a second ack replaces the note).
  Nothing is sent to the poster.
- `close`: `id`, `note` (why it ends, for example "pause lifted"). The post's author or the owner.

Its description gives the owner's routing rule. `message_role`'s description gives it too, and says to
post general info for several roles on the board; when the same text went to 3 or more roles within
10 minutes, its result adds a one-line hint (the message is still sent).

## The Board view

Roles page -> **Board** (beside Now and 6 am reports; `?view=roles` then the switch). Each post shows
a kind chip, title, from/via, time and to, and its text as Markdown (folded after about 6 lines).

- An order: "Done n/m" and per role a tick with its note, or "not done yet", and whether it got the
  order directly (a turn in its home chat, or its running turn) or on the board (read or not yet).
- News: "Read by n/m" and per role when it read it.
- Close (with a note) on open posts; closed posts in a fold below.
- **New post**: kind, to (All roles or picked roles), title, text (Markdown). It posts from "owner",
  through the page's own connection (`board_post` / `board_close`, protocol 45).
- A role's panel on the Now view lists its open orders not yet done; a click opens the Board at the
  post. Tiles stay as they are.

`roles_overview` adds a "Board:" line with the open orders and who hasn't done each, and per role the
open orders it hasn't marked done (COO's brief reads it).

## Tests

- `tests/unit/role-board.test.ts`: routing for (a), (b), (c) and none; the steer and the direct turn
  (busy retries, exactly once, give-up); who posts what; what a chat sees (visibility, first-turn
  window, cuts, ended once, read times); acks and close; the store; the tool.
- `tests/board-test.mjs`: sealed, with the real pi-identity, a scripted model and headless Chrome:
  the owner posts an order to three roles (an open queue task and an idle home chat; only a running
  turn; nothing waiting), news to the same roles, an ack, roles_overview, close, the chat view's
  folded rows, axe and screenshots (dark and white, desktop and phone; `BOARD_SHOT=<dir>`).
