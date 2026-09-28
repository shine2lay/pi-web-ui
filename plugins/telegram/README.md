# Telegram answers (telegram)

Sends you on Telegram everything a chat is waiting on, as soon as it asks, so work doesn't
stall while you're away from the browser:

- questions a chat asks (`ask_user_question`), with their choices as buttons;
- add-on pop-ups (pick one, yes/no, type something), such as approving a plan for the queue;
- permission prompts, with the browser's choices: Approve, Allow this kind here, Allow all here, Deny;
- a queued task that is stuck and needs you, with its 2-4 choices.

You can answer on Telegram or in the browser. The first answer counts, and the other side
catches up: the browser's dialog closes, and the Telegram message shows the answer and where it
came from ("Answered on Telegram" / "Answered in the browser").

## Why no public address is needed

The plugin only makes outgoing requests: it asks Telegram for new messages (long polling) and
sends or edits its own messages. Nothing has to reach this machine from the internet.

## Set up

1. In Telegram, talk to **@BotFather**, send `/newbot`, and pick a name. Use a new bot only pi uses:
   Telegram lets only one program read a bot's messages.
2. In pi-web-ui, open ⚙ → Plugins → Telegram answers and fill in:
   - **Bot token**: the token @BotFather gave you. It's stored encrypted; the browser only sees
     whether one is set. Don't paste it anywhere else.
   - **Your Telegram id**: the number of the only person who may answer.
   - **Web app address**: where you open pi-web-ui, for the "Open the chat" link under each
     message (for example `https://my-machine.my-tailnet.ts.net:8787/`).
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
is edited to say so, and its old buttons only answer "No longer waiting."

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

## Not included

- Notices when a chat finishes or fails.
- Chatting with pi from Telegram: the bot only answers what chats ask.

## Tests

- `npx vitest run tests/unit/plugin-telegram.test.ts`: the plugin against a fake Telegram.
- `npm run build && scripts/sealed.sh node tests/telegram-answers-test.mjs`: the whole server with
  the plugin, a fake Telegram (`PI_WEB_TELEGRAM_API_BASE`) and the mock model; no real messages.
