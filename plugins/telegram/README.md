# Telegram answers (telegram)

Sends you on Telegram everything a chat is waiting on, as soon as it asks, so work doesn't
stall while you're away from the browser:

- questions a chat asks (`ask_user_question`), with their choices as buttons;
- add-on pop-ups (pick one, yes/no, type something), such as approving a plan for the queue;
- permission prompts, with the browser's choices: Approve, Allow this kind here, Allow all here, Deny;
- a queued task that is stuck and needs you, with its 2-4 choices.

Everything else you write to the bot goes to a role, the COO by default, and its answer comes
back here; each morning it also sends you a short brief (see [Chatting](#chatting)).

You can answer on Telegram or in the browser. The first answer counts, and the other side
catches up: the browser's dialog closes, and the Telegram message shrinks to one line with the
answer and where it came from ("✅ Deploy · tooling: Now (on Telegram)").

## How a message looks

```
❓ Deploy · from tooling              ← what it is, and the chat it's from (the chat goes on
                                        a line of its own when both don't fit a phone's line)

Deploy now with pi-web-deploy?        ← the question in bold: the part you must read
It restarts the server.                 (a single question's header is the title)

Busy chats carry on after it.         ← its detail, in italics

── CHOICES ────────                   ← the choices, numbered like their buttons: each in
1 · Now                                 bold, its description under it
Restart right away.

2 · Later
Don't deploy yet.
──────────────────                    ← a line over the footer
📁 ~/projects/pi-web-ui · Open the chat

[ 1 · Now ]                           ← the buttons, one per row
[ 2 · Later ]
[ ✏️ Type an answer ]
```

- The part in bold is the question up to its question mark, else its first sentence, else its
  first line. The rest of it follows on the next line. A question that starts with a list, a quote,
  a heading or code, or is too long, has no part in bold.
- The choices are listed when one of them has a description to read; then they're all listed, so
  the numbers match the buttons. Choices that are only a name (Yes / No) show on their buttons
  alone, without numbers. The text lists 12 at most; the buttons hold them all.
- Several questions in one ask show which one this is above it: *Colour (1/3)*.
- "Type an answer" asks for your reply under the question in bold.
- A stuck queued task opens with "📌 Task #26 needs you", with the task's title under it.
- A chat's markdown and HTML show as Telegram's own formatting: bold, italics, `code`, code blocks,
  links, lists (• and ◦), headings (bold), tables (lined up in a code block) and quotes. Other HTML
  tags are dropped and their text kept.
- Long technical text (code over 80 characters, JSON, long commands, big code blocks) goes in a
  collapsed quote: tap it to open it.
- If Telegram still can't read a message's formatting, it's sent again as plain text, so nothing is lost.

When it's done, a message becomes one line and loses its buttons:

```
✅ Deploy · tooling: Now (on Telegram)
⏹ Deploy · tooling: no longer waiting (the chat was closed)
✅ Task #26 · Make it nice: Carry on (on Telegram)
```

The title in it links to the chat.

## Why no public address is needed

The plugin only makes outgoing requests: it asks Telegram for new messages (long polling) and
sends or edits its own messages. Nothing has to reach this machine from the internet.

## Install and update

Copy `manifest.json`, `index.mjs`, `question-identity.mjs` and `README.md` into
`~/.pi-web-ui/plugins/telegram/`, then restart pi-web-ui. Update the same way: copy the four
files over, then restart.
Don't reinstall with `pi-web-ui install --force`: it keeps only `config.json`, so the stored token
and the plugin's memory of its messages are lost.

## Set up

1. In Telegram, talk to **@BotFather**, send `/newbot`, and pick a name. Use a new bot only pi uses:
   Telegram lets only one program read a bot's messages.
2. In pi-web-ui, open ⚙ → Plugins → Telegram answers and fill in:
   - **Bot token**: the token @BotFather gave you. It's stored encrypted; the browser only sees
     whether one is set. Don't paste it anywhere else.
   - **Your Telegram id**: the number of the only person who may answer.
   - **Web app address**: where you open pi-web-ui, for the "Open the chat" link under each
     message (for example `https://my-machine.my-tailnet.ts.net:8787/`).
   - **Messages go to**: the role your other messages go to (default `coo`); empty turns chatting off.
   - **Morning brief at**: when that role sends you its brief, HH:MM Pacific time (default `06:30`);
     empty turns the brief off.
3. Open the new bot's chat in Telegram and press **Start**. It replies with how many things are
   waiting and sends them.

The plugin's status shows in the background list (📨 Telegram): polling, not set up, or what went wrong.

## Answering

- **One choice**: tap it.
- **Several choices**: tap to tick (☑), then **Done**.
- **Your own words**: tap **✏️ Type an answer** and reply, or reply to the question's message.
- **Several questions in one ask**: they come one after another in the same message.

Long texts (plans, big commands) are cut to fit Telegram's limit; the link opens the chat for the rest.

When something stops waiting (answered elsewhere, the chat was closed, pi restarted), its message
shrinks to one line that says so, and its old buttons only answer "No longer waiting."

## When Telegram has a hiccup

- A request that fails (Telegram answers with an error in the 500s, the connection drops, or no
  answer comes within 10 seconds) is tried again after 1, 2 and 4 seconds. A message that still
  couldn't be sent is tried again every minute.
- Sometimes Telegram gets a message but its answer is lost, so the retry sends it twice. Both
  copies work: a tap or a reply on either one counts, and both show the final answer.
- Waiting for new messages restarts every 25 seconds, so a connection that died quietly is
  noticed within half a minute.

## Chatting

When **Messages go to** names a role (the COO by default), what you write to the bot goes to that
role's home chat, and its answer comes back here:

- Your message arrives there as your own, with "📱 " in front, the way a typed one does: a
  closed chat opens in the background. If the role is in the middle of a turn, the bot says so and
  your message goes in right after that turn.
- Telegram shows "typing…" while the role works. Its last message of the turn comes back under
  yours, in Telegram's own formatting, in at most 3 messages; a longer one ends with "The rest is
  in the chat" and a link. A turn that fails gets one line saying why.
- Reply to one of its messages to go on with it; that goes to the role too.
- Only text for now: a photo, voice note or file gets "Only text messages for now."
- What comes back: the role's turns started from Telegram or by the morning brief, and its answers
  to what you asked it. When the role asks another role something to answer your message, that
  role's reply starts a turn in the role's chat; that turn comes back in full, under your message,
  with a notification and one line in front such as "The COO, after the temper role answered:".
  That also works when it asks a third role along the way. Any other turn another role's message
  started stays in the role's chat and never comes here. The owner, 2026-10-06: "No I dont want to
  read agent to agent messages at all", then, asked whether the COO's answers to his own questions
  should still come: "Yes, answers to my questions" ("Only COO's answer to something you asked it
  comes through. Everything else between roles stays off your Telegram."). Turns you start in the
  browser stay there too, including their delegated answers and nested callbacks. Visibility is
  separate from transport: the server derives internal `ownerChannel` metadata from accepted browser
  or Telegram input, never from message wording or tool arguments. Only the Telegram plugin can
  label its accepted inputs Telegram. A known Telegram input receipt is required before sending;
  unknown, malformed or mixed transport stays in chat. Legacy owner answers require a retained
  trusted Telegram receipt; missing provenance never permits broadcasting.
- Answers still work as before: tap a button, reply to a question's message, or send your answer
  right after tapping **Type an answer**. `/start` says what the bot does. (With two questions
  waiting for a typed answer at once, reply to the question's message.)
- If pi restarts while your message waits for a busy role, the bot asks you to send it again; if
  the role was in the middle of answering it, its answer is in the chat.

**Morning brief**: at **Morning brief at** (06:30 Pacific by default) the plugin asks the role for
a short brief: the overall direction in a sentence or two, what needs you first, one line per role
that did something, the quiet ones together, under about 300 words. If pi was down then, it asks
as soon as it's back, until noon. With no answer 45 minutes after asking, you get one line:
"No morning brief today: <why>".

The bot never logs what you or the role wrote: its log only says that a message came or went.

## Who can answer

Only the Telegram id in the settings, and only in a private chat with the bot. Everyone else's
messages and taps are ignored without a reply, and so are group chats.

## While Telegram is set up

- A question in a chat with no browser open keeps waiting (normally it gives up after 30 seconds),
  because you can answer it on Telegram.
- A permission prompt in a chat with no browser open waits for your answer; every open browser
  shows it too.

If the token is refused, the plugin stops and says so in its status, and chats go back to the
normal behaviour.

## Reconnect notices

Reconnect notices are now silent by default (Owner rm-2917f21e, Ops task #157): keep tracking,
stop notices. Only a new explicit Owner request may resume them. If opted in, the server records
each episode in its connection log and hands the plugin a fixed set of facts: when, for how long,
the cause (no frames from the server, the connection closed, no answer after coming back, catching
up), the close code, and the longest stall the server measured meanwhile. The plugin sends you one
line, for example:

    🔌 Reconnecting at 19:42:10 for 7.2 s · no frames from the server · server stalled up to 6.4 s

At most one line every 10 minutes; what happens meanwhile is summed up in the next line
("+2 more since 19:37:10 …"). Each line goes once, also across a restart, and only to the
Telegram id in the settings. The line is built here from those facts alone: no chat text and
nothing a page wrote. In `~/.pi-web-ui/conn-trace.json`, `{"enabled": true,"notices": false}`
keeps tracking silently. `{"enabled": false}` is master-off. Missing `notices` is silent; only
explicit `true` allows notice submissions. Muting discards pending summaries/retries and old
inflight backlog across restarts and later enabling; already-submitted delivery cannot be unsent.
Rollback to old code must keep master-off: the old recorder ignores `notices:false`.

## Sending the owner a notice (Ops #627)

Agents and other plugins can send you a message through this bot without ever seeing its token.
It only ever goes to the Telegram id in the settings.

- Agents: the `telegram_send` tool, `{ text, url?, linkLabel?, from? }`. It answers
  `{ ok: true, messageId, messageIds }`, or `{ ok: false, error }` when Telegram is off, not set
  up, or refused the message.
- Plugins: `host.events.emit("telegram:send", { text, url?, linkLabel?, from? })`. Without
  `from`, the sending plugin's id is shown. A failure goes to this plugin's log.

`text` is markdown or plain text (a long one goes in up to 3 messages). `from` shows in italics
above it. `url` is an `http(s)://` address or a path starting with `/`, which goes on the
"Web app address" setting; it shows at the end as a link named `linkLabel` (default "Open").

## Sending each owner question once (Ops #763, H-TG-ONCE-1)

Each owner question has a stable identity (`plugins/telegram/question-identity.mjs`,
`questionIdentity` / `questionIdentityHash`) built only from what does not change across server
restarts or chat reopens:

- `kind` (`question`, `custom_ui`, `permission`, `stuck`);
- the chat or queue file it belongs to (`queueFile` for `stuck` asks, else `sessionFile` or
  `conversationId` + `cwd`);
- the task number (`taskId`) for `stuck` asks;
- the question's own fields (`id`, `header`, `text`, `multi`, `allowText`, and each option's
  `value`, `label`, `description`).

It never uses `createdAt` or the host's `stuck-N` counter. Two different questions never share an
identity.

### How restarts, chat reopens and repeats behave

- **Restart or rebuild (`resync` and `appeared`)**: live asks are matched to stored waiting entries
  by identity first (and for legacy stored entries without an `identity` field, by task header or
  rendered question line). The matching entry is adopted in place: `key`, `askId` and `createdAt`
  are updated, and the existing Telegram message is edited only if its rendered words changed. No
  new message is sent and no `"no longer waiting (pi restarted)"` edit is made.
- **Chat close then reopen (`stuck` asks)**: `stuck` asks exist in the host only while their chat is
  open. When a chat closes (`gone` with `"the chat was closed"`, or `resync("it went away")`), a
  waiting `stuck` entry stays in `entries` so reopening the chat adopts the existing Telegram
  message without buzzing or editing it. If the task's question changed while closed, the old entry
  is closed with `"the question changed"` and the new question is sent normally with sound.
- **Re-raise after gone, unanswered**: when an unanswered question stops waiting for another reason
  (such as a timeout or cancellation), its identity and old message id are kept in `goneIdentities`
  for 7 days (`GONE_IDENTITY_TTL_MS`). If the same question is asked again within 7 days, it is
  sent with `disable_notification: true` (silent repeat, no buzz), and its old Telegram message is
  deleted when less than 48 hours old (`TELEGRAM_DELETE_MAX_AGE_MS`), or edited to point to the new
  message (`"asked again in message #<id>"`) when Telegram no longer allows deletion. That leaves
  one live message per question.
- **Answered questions**: when a question is answered (on Telegram or in the browser), its stored
  entry and any `goneIdentities` record for its identity are cleared. Asking the same question
  again later sends normally with sound.
- **Logging (no text)**: each question send or adoption logs the question `ask.id`, the 16-hex
  identity hash, and whether it was `new`, `kept`, or `silent repeat`. Each `telegram:send` /
  `sendOwnerNotice` call logs the sender role and character length, never the text.

### Hypothesis H-TG-ONCE-1

- **What was wrong (2026-10-27 to 2026-11-02 PDT, `pi-web-ui` journal)**: 441 question messages went
  to Telegram (~63/day; 85–120 total Telegram messages/day, 85–95% questions). `pi-web-ui`
  restarted 69 times; 163 question sends (37%) came within 3 minutes of a restart. 10 task
  questions with stable ids were sent 87 times (38 repeats not near a restart).
- **Cause**: `plugins/telegram/index.mjs` keyed questions solely as `${ask.id}@${ask.createdAt}`,
  while `server/asks.ts` rebuilt every stuck ask with `createdAt = now` (and `server/stuck-asks.ts`
  assigned a fresh `stuck-${sequence}` id to unbound ones), and stuck asks disappeared and
  reappeared whenever their chat closed and reopened.
- **The one change**: match questions by content-based identity (`plugins/telegram/question-identity.mjs`)
  across `resync`, `onAskEvent` and `sendAsk`, keep waiting `stuck` entries across chat close/reopen,
  and send unanswered re-raises within 7 days silently while deleting (or linking) the old message.
- **Expected**:
  - After deploy, sends within 3 minutes of a restart for questions already sent = 0.
  - Every repeat of a question is silent.
  - Question messages per day drop by at least 40% compared with 63/day at similar question load.
- **Wrong if (MISS)**:
  - Any restart or reopen re-sends, with sound, a question that was already sent and is still waiting; or
  - Notifying sends stay above 1.1 messages per question identity.
- **Undo**: revert the plugin commit, copy the reverted `manifest.json`, `index.mjs` and `README.md`
  into `~/.pi-web-ui/plugins/telegram/` (removing `question-identity.mjs`), and redeploy with
  `pi-web-deploy`. Stored entries in `storage.json` keep the original `key` field and `sent` map
  structure (`identity`, `identityHash`, `sentAt`, and top-level `goneIdentities` are additive only),
  so the old plugin reads them without migration or loss.
- **72 h live receipt (HIT)**: window 2026-11-03 00:58:41 PST → 2026-11-06 00:58:41 PST, with
  `v0.2.6` live throughout (`[plugin:telegram] activated (v0.2.6)` x14, no other version). Counted
  look-only from the `pi-web-ui.service` journal with
  `/home/shinelay/.cache/pi/ops763/tg-counts.py "2026-11-03 00:58:41" "2026-11-06 00:58:41"`.
  - Restarts: 14. Sends within 3 min of a restart: 1 total, of which **0** were questions already
    sent, and **0** were already-sent questions re-sent with sound (expected 0 — met).
  - Question sends: 36, over 36 distinct identities. Notifying sends per identity: mean 1.00,
    max 1, identities with more than one notifying send: 0 (MISS bar was > 1.1 — not reached).
  - Silent repeats (`disable_notification`): 0 — no unanswered question came back within 7 days.
  - Adoptions (`kept`): 130 — restarts and chat reopens that kept the existing message instead of
    sending a new one. Old-format (pre-fix) send lines: 0.
  - Question messages per day (PST): 11 (Nov 3), 10 (Nov 4), 15 (Nov 5); mean 12.0/day against
    ~63/day before the change — **−81%** (expected at least −40% — met).
  - Questions by kind: 31 `q-N` (chat `ask_user_question`), 4 `stuck-*` (queued-task lead cards),
    1 `dlg-1`. The sender role of a question is not recorded in the journal, so questions cannot be
    split by role without adding a log field; notices can.
  - Notices by sender role: Show&Tell 18, `rollcall deployer` 16, RollCall 10, Design 5, Ops 1;
    total 50 (4 on Nov 3, 12 on Nov 4, 34 on Nov 5).
  - Also logged: 33 `coo answered another role's message (not sent, N characters)` — questions that
    COO answered and that therefore never reached Telegram.
  - Verdict: **H-TG-ONCE-1 HIT** — no restart or reopen re-sent an already-waiting question with
    sound, notifying sends stayed at 1.00 per identity, and question volume fell 81%.

## Not included

- Notices when a chat finishes or fails.
- Photos, voice notes and files in a chat with the role.

## Tests

- `npx vitest run tests/unit/plugin-telegram.test.ts`: the plugin against a fake Telegram, how each
  kind of message looks, and the formatting (thousands of random texts, checked to give only tags
  Telegram takes, balanced).
- `npm run build && scripts/sealed.sh node tests/telegram-answers-test.mjs`: the whole server with
  the plugin, a fake Telegram (`PI_WEB_TELEGRAM_API_BASE`) and the mock model; no real messages.
- `npm run build && scripts/sealed.sh node tests/telegram-coo-test.mjs`: chatting with a role the
  same way, with a made-up role and its home chat; `PI_WEB_TELEGRAM_NOW` sets the clock for the
  morning brief.
