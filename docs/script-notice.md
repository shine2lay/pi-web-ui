# Script notices to a role's home chat, and Telegram messages to the owner

A script or systemd unit on spark can send a short message into a role's home chat through the app's control socket, much like `message_role`, or send the owner a Telegram message through the pi bot, like a chat's `telegram_send`. The simplest way is the command `pi-web-ui notify` (Ops #783, below): it reads the app token itself, so the caller never handles it.

The first caller of both is RollCall's continuous deployer (`~/temper-ai/configs/epd/bin/rollcall_cd_notify.py`; role notices: Systems #97 for RollCall rm-ff184438, asked by Systems rm-1d941ef2; Telegram: Systems rm-e2634da5). `script_notice` is a sibling of `ci_alert` (`docs/ci-alert.md`) on the same app-token check and app-report path. `ci_alert` stays as it is (fixed CI fields, its own row); `role_report` is not touched and the automatic 6 am job stays off.

## Hypothesis (H-SCRIPT-NOTICE-ROUTE, Ops #782)

- **What is wrong, and the evidence.** A script has no supported way to tell a role something. The only control-socket routes are `ci_alert` (CI fields only, the server writes the text) and `role_report` (the 6 am report job, off and staying off). So the deployer queues its lines in `~/.local/state/rollcall-cd/outbox.jsonl`, which no chat reads.
- **The one change.** A `script_notice` command beside `ci_alert`: the same app-token check, the same app-report record (kind report, chain 1, outside the role-message caps and grants), the script's own short text and sender name, and an optional key for dedupe.
- **Expected result, and how it is measured.** A valid `fyi` lands as one note in the target role's home chat and starts no turn; a valid `request` starts one turn once the chat's running turn has settled; a repeated key returns the first id with `duplicate: true` and sends nothing. Measured by `tests/unit/script-notice.test.ts` (fails on the old code) and, after the deploy, by one real `fyi` to Ops plus the same key again: one record, delivered, added without a turn, and journal lines without the token or the text.
- **What would prove it wrong.** A valid send that is not delivered; a bad request (bad token, unknown key, bad value, unknown role, role without a home chat) that sends or stores anything; a repeated key that sends twice; an `fyi` that starts a turn; the token or the text in the journal.
- **Result: HIT.** Landed `5c8f7bb4` through land request 338-34fa01 (quick lane, 2026-11-05 11:40-11:46 PST); deployed with `pi-web-deploy` at 11:47 PST, `pi-web-deploy result 5c8f7bb4ace7dd50d17a960d70e7f8deffa06e2c` exit 0, "live, and the checks all passed". The new tests (`tests/unit/script-notice.test.ts`, 13) fail on the old code (`6bb150fe` has no `server/script-notice.ts`) and pass on the new one. Live check, 2026-11-05T19:49:33Z, the only real send (kit `~/kept-from-tmp/2026-11-05/ops-782-live/send-once.mjs`, `journal-check.mjs`): an `fyi` to Ops from `ops-live-check` with key `ops-782-live-1` -> `rm-12b365f9`, `duplicate: false`; the same key with another text -> `rm-12b365f9`, `duplicate: true`; `kind: "alert"` -> refused with the kind reason. One record (kind report, chain 1, from `{app, "Ops live check", ops-live-check}`, `script.kind` fyi), delivered 0.3 s after the send, sent once; in Ops' home chat it is the last entry (a role-message note) with no turn after it. Journal: `rm-12b365f9 ops-live-check -> ops · fyi (ops-782-live-1)`, `rm-12b365f9 ops-live-check: the same notice again (ops-782-live-1), not sent`, `rm-12b365f9 delivered to ops (home chat), added without a turn`; the token and both texts appear nowhere in the journal since the deploy. A `request` was not sent live (no live sends beyond this one `fyi` were planned); its turn is covered by the unit tests.

## Hypothesis (H-SCRIPT-NOTIFY-CLI, Ops #783)

- **What is wrong, and the evidence.** A script can reach a role only by reading the app token and speaking the socket protocol itself (`script_notice` above), and it can't reach the owner's Telegram through the pi bot at all: the bot's `telegram_send` is a chat tool and the plugin-bus topic `telegram:send` is for plugins inside the app. So RollCall's deployer (Systems rm-e2634da5, for the owner's "When each deploy happens give me a ping on telegram", via RollCall rm-5e283c7b) would have to use temper's own bot (agent-tools `lib/pi-backup.mjs` `sendTelegram`).
- **The one change.** A command `pi-web-ui notify telegram|role` that reads the token, sends one control-socket request and turns the answer into an exit code; for Telegram, a control-socket command `telegram_send` that runs the Telegram plugin's own `telegram_send` tool and answers only once it has sent or refused.
- **Expected result, and how it is measured.** One call sends exactly one Telegram message or role notice and exits 0; every failure exits non-zero with a one-line reason, and nothing is sent on bad input, a refusal or a server that is down. Measured by `tests/unit/notify-cli.test.ts`, `tests/unit/owner-telegram.test.ts` and the seam test in `tests/unit/plugin-telegram.test.ts` (all fail on the old code: no `server/notify-cli.ts`, no `server/owner-telegram.ts`, `telegram_send` is an unknown socket command), and after the deploy by one live Telegram message to the owner, one live `fyi` to Ops and one bad call.
- **What would prove it wrong.** A failed send that exits 0; a call that sends twice; a bad call that sends anything; the token or the text printed or in the journal.
- **Result:** pending.

## The command: `pi-web-ui notify`

```text
pi-web-ui notify telegram --text <text> [--from <name>] [--url <http(s) address or /path>] [--link-label <label>]
pi-web-ui notify role --to <role id> --kind fyi|request --text <text> --sender-id <id> --sender-title <title> [--key <key>]
```

- `telegram` sends the owner one Telegram message through the pi bot, exactly as a chat's `telegram_send` does (same sender line, text, link and splitting rules; only to the owner). `--from` is the name shown in italics above the text; `--url` is an http(s) address or a path on the web app (`/showtell/...`); `--link-label` names the link (default "Open").
- `role` adds a notice to a role's home chat: `script_notice` below, field for field (`--to` = `role`, `--sender-id`/`--sender-title` = `sender.id`/`sender.title`); `fyi` without a turn, `request` with one; `--key` makes a resend safe.
- `--text -` reads the text from stdin (trailing line breaks dropped), for long or multi-line text.
- Options as `--name value` or `--name=value`, each once. `--data-dir <dir>` is pi-web-ui's data dir: default `$PI_WEB_DATA_DIR`, else `~/.pi-web`, as for the server and the other `pi-web-ui` commands. Login shells on spark set `PI_WEB_DATA_DIR=/home/shinelay/.pi-web-ui`; a systemd unit or cron job must set it (or pass `--data-dir ~/.pi-web-ui`), or the command exits 4 with "no app token in ...".
- It reads `<data dir>/app-token` itself and never prints it. It prints nothing of the text either.

| Exit | Meaning                                                                                                                                                                               | Printed                                                                                                                                                                           |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0    | sent: Telegram took the message / the notice is stored and on its way                                                                                                                 | stdout: the Telegram message id(s) (`901`, or `901 902` when split); for `role`: `rm-12345678 duplicate=false` (`duplicate=true`: the same key was sent before, nothing new sent) |
| 2    | bad input: an unknown, missing or repeated option, or a field the server would refuse; nothing sent                                                                                   | stderr: `pi-web-ui notify: <what is wrong>` and the usage                                                                                                                         |
| 3    | the server refused it (Telegram off or not set up, a bad link, an unknown role, ...); nothing sent                                                                                    | stderr: `pi-web-ui notify: not sent: <the server's reason>`                                                                                                                       |
| 4    | the server is unreachable (not running, no socket, no app token in the data dir); nothing sent                                                                                        | stderr: `pi-web-ui notify: not sent: <why>`                                                                                                                                       |
| 5    | unknown: the request went out but no clear answer came back (no answer within the wait, part of a long Telegram message sent before Telegram refused the rest); it may have been sent | stderr: `pi-web-ui notify: unknown: <why>; it may have been sent, so check before sending it again`                                                                               |

Nothing is retried and nothing is guessed. A Telegram send waits up to 150 s for the answer (the plugin itself retries Telegram's rate limits); a role notice 15 s. After 4 the same call may simply be run again later; after 5 a role notice with `--key` may be run again safely (a repeat is a duplicate), a Telegram message would arrive twice if it did go out. `pi-web-ui notify --help` prints the usage.

### From Python (the deployer)

```python
import os, subprocess

ENV = {**os.environ, "PI_WEB_DATA_DIR": os.path.expanduser("~/.pi-web-ui")}

def ping_owner(text, url=None):
    """One Telegram message to the owner; returns the message id(s) or raises with the reason."""
    cmd = ["pi-web-ui", "notify", "telegram", "--from", "RollCall deployer", "--text", "-"]
    if url:
        cmd += ["--url", url]
    r = subprocess.run(cmd, input=text, text=True, capture_output=True, env=ENV, timeout=180)
    if r.returncode != 0:
        # 2 bad input, 3 refused, 4 server down: not sent. 5: may have been sent; don't resend blindly.
        raise RuntimeError(f"notify exit {r.returncode}: {r.stderr.strip()}")
    return r.stdout.strip()

def tell_role(role, kind, text, key=None):
    cmd = ["pi-web-ui", "notify", "role", "--to", role, "--kind", kind, "--text", "-",
           "--sender-id", "rollcall-cd", "--sender-title", "RollCall deployer"]
    if key:
        cmd += ["--key", key]
    r = subprocess.run(cmd, input=text, text=True, capture_output=True, env=ENV, timeout=30)
    if r.returncode != 0:
        raise RuntimeError(f"notify exit {r.returncode}: {r.stderr.strip()}")
    rid, dup = r.stdout.split()  # "rm-12345678", "duplicate=false"
    return rid, dup == "duplicate=true"
```

`pi-web-ui` is on the login PATH (`~/.nvm/versions/node/v22.22.0/bin`). Its first line is `#!/usr/bin/env node` and spark has no system `node`, so a unit with a bare PATH runs `/home/shinelay/.nvm/versions/node/v22.22.0/bin/node /home/shinelay/.nvm/versions/node/v22.22.0/bin/pi-web-ui notify ...`, or puts that directory on its PATH (as pi-web-ui's own unit does).

## Telegram contract: `telegram_send` (control socket)

```json
{
	"cmd": "telegram_send",
	"token": "<app token>",
	"text": "Deployed rollcall 1a2b3c4.",
	"from": "RollCall deployer",
	"url": "/showtell/",
	"linkLabel": "Open"
}
```

- `token` as for `script_notice` (missing or wrong: refused, and logged without the token); `text` required, not blank; `from`, `url`, `linkLabel` optional strings. Any other key is refused. These are the `telegram_send` tool's parameters, and the tool's own rules apply after that: the text is markdown, split into as many messages as it needs (cut past the tool's limit, marked so); the link must be http(s) or a path starting with `/` (needs the web app address in the Telegram settings); it goes only to the owner.
- The server runs the Telegram plugin's own `telegram_send` tool (`plugins/telegram/index.mjs`, Ops #627) and answers once it has finished. The plugin-bus topic `telegram:send` isn't used: it is fire-and-forget, and a script must know whether its message went out. The bot token stays inside the plugin.
- Answers: `{"ok":true,"messageIds":[901]}` when the tool says it sent; `{"ok":false,"error":"..."}` when nothing went out (the plugin isn't loaded, Telegram is off or not set up, a bad link, Telegram refused the first message); `{"ok":false,"error":"...","maybeSent":true}` when something may have gone out (Telegram refused a later part, the tool threw, an answer that can't be read).
- A connection waiting for this answer stays open past the socket's 5 s idle limit; answers on one connection come in the order of their requests.
- Journal lines (prefix `[control]`), never the token or the text: `telegram_send: sent to the owner as message 901`, `telegram_send: not sent: Telegram is off in its settings`, `refused telegram_send: a wrong app token`. The plugin logs its own line as for any notice (`telegram: sent notice from RollCall deployer (42 characters) as message 901`).

## Contract: `script_notice`

Send one JSON line to the control socket and read one JSON line back. On spark the socket is `~/.pi-web-ui/pi-web-ui.sock` (`controlPath(dataDir, port)` in `server/control-socket.ts`; mode 0600, same user only). The token is the content of `~/.pi-web-ui/app-token`. Read it inside the script; never put it in command arguments, logs, saved examples or the notice text.

```json
{
	"cmd": "script_notice",
	"token": "<app token>",
	"role": "rollcall",
	"kind": "fyi",
	"sender": { "id": "rollcall-cd", "title": "RollCall deployer" },
	"text": "Deployed rollcall 1a2b3c4 to production at 14:02.\nHealth check passed.",
	"key": "deploy-1a2b3c4"
}
```

| Field          | Rule                                                                                                                                                                                                                                                                                                                                                  |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cmd`          | `"script_notice"`                                                                                                                                                                                                                                                                                                                                     |
| `token`        | the app token; missing or wrong is refused and logged (without the token)                                                                                                                                                                                                                                                                             |
| `role`         | a role id (`ops`, `rollcall`, ...); the role must exist and have a home chat                                                                                                                                                                                                                                                                          |
| `kind`         | `"fyi"`: added to the chat without a turn, read with its next message (like a `message_role` fyi). `"request"`: starts a turn of its own once the chat's running turn has settled (like `ci_alert`); the chat is told the sender is a script that can't read a reply, so none is owed. Any other kind (`question`, `reply`, `alert`, ...) is refused. |
| `sender.id`    | 1-40 characters: lower-case letters, digits and dashes, starting with a letter or digit (`[a-z0-9][a-z0-9-]{0,39}`)                                                                                                                                                                                                                                   |
| `sender.title` | 1-60 characters on one line, not blank, no control characters and no `[` or `]` (it goes into the message's header)                                                                                                                                                                                                                                   |
| `text`         | 1-1500 characters (JavaScript string length), not blank, plain text; line breaks (`\n`) allowed, every other control character (tab, `\r`, ...) refused; no line may start with `[Role message`, `[Board`, `[Queue]`, `[System` or `[Owner question]`, the app's own headers                                                                          |
| `key`          | optional, 1-200 characters on one line, no control characters. A repeat of the same `sender.id` + `role` + `key` returns the first notice's id with `duplicate: true` and sends nothing. Records are kept at least 9 days (like `ci_alert`). Without a key, every call sends.                                                                         |

Any other key, in the request or in `sender`, is refused. Every refusal is `{"ok":false,"error":"<what is wrong and how to fix it>"}`, and nothing is stored or sent.

The answer to an accepted notice:

```json
{ "ok": true, "id": "rm-12345678", "duplicate": false }
```

`ok: true` means the notice is stored and on its way (the role-message outbox delivers it, retrying for up to a day, like any role message); it does not mean the chat has read it.

## What the receiving chat sees

```text
[Role message rm-12345678 from the script rollcall-cd · RollCall deployer · notice]

Deployed rollcall 1a2b3c4 to production at 14:02.
Health check passed.

(A notice from a script on this machine (its sender is in the header), added without a turn of its own: ...)
```

A request ends `· request]`, and its hint says a script on this machine sent it and can't read a reply, so none is owed; the chat acts on it with its tools and ends its turn with one status line, like the CI watch's alert. The sender is the server's: the record's `from` is `{ role: "app", title: sender.title, chat: sender.id }`, so the app token authenticates the machine-local caller and the script only names itself. In the chat the message folds into one row, "From RollCall deployer" with the chip "script notice" (or "script request"); the request's turn folds like a role's. Its card says "From the script rollcall-cd (rm-...) on this machine ... a script can't read a reply, so none is owed." A `message_role` reply to it is refused ("a script can't read a reply"). Never Telegram: it is not the owner's.

Journal lines (`journalctl --user -u pi-web-ui`, prefix `[role-messages]`), never the token or the text:

```text
rm-12345678 rollcall-cd -> rollcall · fyi (deploy-1a2b3c4)
rm-12345678 rollcall-cd: the same notice again (deploy-1a2b3c4), not sent
rm-12345678 delivered to rollcall (home chat), added without a turn
refused a script notice for rollcall: a wrong app token
```

Only token refusals are logged; a bad field is refused in the answer alone, like `ci_alert`.

## Python example (stdlib only)

```python
import json, pathlib, socket

DATA = pathlib.Path.home() / ".pi-web-ui"

def script_notice(role, kind, text, key=None, sender_id="rollcall-cd", title="RollCall deployer"):
    """Send one notice; returns the receipt dict or raises with the server's reason."""
    req = {
        "cmd": "script_notice",
        "token": (DATA / "app-token").read_text().strip(),
        "role": role,
        "kind": kind,
        "sender": {"id": sender_id, "title": title},
        "text": text,
    }
    if key is not None:
        req["key"] = key
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as s:
        s.settimeout(10)
        s.connect(str(DATA / "pi-web-ui.sock"))
        s.sendall((json.dumps(req) + "\n").encode())
        buf = b""
        while b"\n" not in buf:
            chunk = s.recv(4096)
            if not chunk:
                break
            buf += chunk
    answer = json.loads(buf.split(b"\n", 1)[0])
    if not answer.get("ok"):
        raise RuntimeError(f"script_notice refused: {answer.get('error')}")
    return answer  # {"ok": True, "id": "rm-...", "duplicate": False}
```

The socket is there only while pi-web-ui runs. A caller that must not lose a line keeps it in its own outbox until it gets `ok: true` (a key makes the resend safe: a repeat is a duplicate, not a second message).

## Node example

```js
import { readFileSync } from "node:fs";
import { createConnection } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";

const data = join(homedir(), ".pi-web-ui");
export function scriptNotice({ role, kind, text, key, sender }) {
	const req = {
		cmd: "script_notice",
		token: readFileSync(join(data, "app-token"), "utf8").trim(),
		role,
		kind,
		sender,
		text,
	};
	if (key !== undefined) req.key = key;
	return new Promise((resolve, reject) => {
		const c = createConnection(join(data, "pi-web-ui.sock"));
		let buf = "";
		c.setTimeout(10_000, () => c.destroy(new Error("script_notice: no answer in 10 s")));
		c.on("connect", () => c.write(`${JSON.stringify(req)}\n`));
		c.on("data", (d) => {
			buf += d;
			if (!buf.includes("\n")) return;
			c.end();
			const answer = JSON.parse(buf.slice(0, buf.indexOf("\n")));
			answer.ok ? resolve(answer) : reject(new Error(`script_notice refused: ${answer.error}`));
		});
		c.on("error", reject);
	});
}
```

## Code

- `server/script-notice.ts`: `checkScriptNotice` (every field and refusal reason), `scriptNoticeKey` (the dedupe key), `scriptNoticeHeader` and `scriptNoticeHint` (header words and hint). Pure.
- `server/role-messages.ts`: `requestScriptNotice` on the shared app-report helper (`addAppReport`, beside `requestPoke`, `requestStall`, `requestCiAlert`); record field `script`; `noTurn` (an fyi notice goes as a note) and `needsOwnTurn` (a request waits for the running turn, like CI); header, hint, stamp and reply refusal.
- `server/control-socket.ts`: `case "script_notice"` behind `appTokenRefusal`; `server/agent-service.ts` and `server/index.ts` wiring; `server/quiet-turns.ts` folds a request's turn.
- Web: `web/src/role-message-text.ts` (header parse), `RoleMessageRow.tsx` (row and chip), `Message.tsx` (card), `i18n.tsx` and all 8 language packs.
- Ops #783: `server/notify-cli.ts` (`runNotify`, `NOTIFY_EXIT`, option checks with the server's own checkers, exit codes; I/O passed in), `server/control-client.ts` (`controlPath`, `askControl`: answered / unreachable / no-answer; `sendControlCommand` in `server/control-socket.ts` runs on it), `server/owner-telegram.ts` (`checkOwnerTelegram`, `sendOwnerTelegram`: reads the tool's answer), `server/app-token.ts` `readAppToken` (reads, never makes one), `server/plugins.ts` `PluginManager.agentToolOf`, `server/control-socket.ts` `case "telegram_send"` (async answer, ordered per connection), `server/index.ts` wiring, `bin/pi-web-ui.mjs` `notify`.

## Stability

The request and answer shapes above, the command's options, its output and its exit codes are the contract. Changes are additive only.

## Undo

`script_notice`: before any record exists, revert the commit and deploy with `pi-web-deploy`. Once records exist: forward-disable the command (the control-socket case answers "script notices are switched off") and keep the record type, its display and delivery, so stored notices still show and deliver as sent. Never delete records; never turn on `role_report`.

`pi-web-ui notify` and `telegram_send` store nothing of their own: revert their commit and deploy with `pi-web-deploy` (callers then get exit 3, "unknown cmd: telegram_send", or the CLI's "unknown command"). To stop only the Telegram part, remove the `ownerTelegram` option in `server/index.ts` (the socket then answers "Telegram messages aren't supported here", exit 3).
