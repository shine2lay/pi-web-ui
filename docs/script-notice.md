# Script notices to a role's home chat

A script or systemd unit on spark can send a short message into a role's home chat through the app's control socket, much like `message_role`. The first caller is RollCall's continuous deployer (`~/temper-ai/configs/epd/bin/rollcall_cd_notify.py`, Systems #97 for RollCall rm-ff184438, asked by Systems rm-1d941ef2). `script_notice` is a sibling of `ci_alert` (`docs/ci-alert.md`) on the same app-token check and app-report path. `ci_alert` stays as it is (fixed CI fields, its own row); `role_report` is not touched and the automatic 6 am job stays off.

## Hypothesis (H-SCRIPT-NOTICE-ROUTE, Ops #782)

- **What is wrong, and the evidence.** A script has no supported way to tell a role something. The only control-socket routes are `ci_alert` (CI fields only, the server writes the text) and `role_report` (the 6 am report job, off and staying off). So the deployer queues its lines in `~/.local/state/rollcall-cd/outbox.jsonl`, which no chat reads.
- **The one change.** A `script_notice` command beside `ci_alert`: the same app-token check, the same app-report record (kind report, chain 1, outside the role-message caps and grants), the script's own short text and sender name, and an optional key for dedupe.
- **Expected result, and how it is measured.** A valid `fyi` lands as one note in the target role's home chat and starts no turn; a valid `request` starts one turn once the chat's running turn has settled; a repeated key returns the first id with `duplicate: true` and sends nothing. Measured by `tests/unit/script-notice.test.ts` (fails on the old code) and, after the deploy, by one real `fyi` to Ops plus the same key again: one record, delivered, added without a turn, and journal lines without the token or the text.
- **What would prove it wrong.** A valid send that is not delivered; a bad request (bad token, unknown key, bad value, unknown role, role without a home chat) that sends or stores anything; a repeated key that sends twice; an `fyi` that starts a turn; the token or the text in the journal.
- **Result.** (Filled in after the deploy and the live check.)

## Contract

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

| Field | Rule |
| --- | --- |
| `cmd` | `"script_notice"` |
| `token` | the app token; missing or wrong is refused and logged (without the token) |
| `role` | a role id (`ops`, `rollcall`, ...); the role must exist and have a home chat |
| `kind` | `"fyi"`: added to the chat without a turn, read with its next message (like a `message_role` fyi). `"request"`: starts a turn of its own once the chat's running turn has settled (like `ci_alert`); the chat is told the sender is a script that can't read a reply, so none is owed. Any other kind (`question`, `reply`, `alert`, ...) is refused. |
| `sender.id` | 1-40 characters: lower-case letters, digits and dashes, starting with a letter or digit (`[a-z0-9][a-z0-9-]{0,39}`) |
| `sender.title` | 1-60 characters on one line, not blank, no control characters and no `[` or `]` (it goes into the message's header) |
| `text` | 1-1500 characters (JavaScript string length), not blank, plain text; line breaks (`\n`) allowed, every other control character (tab, `\r`, ...) refused; no line may start with `[Role message`, `[Board`, `[Queue]`, `[System` or `[Owner question]`, the app's own headers |
| `key` | optional, 1-200 characters on one line, no control characters. A repeat of the same `sender.id` + `role` + `key` returns the first notice's id with `duplicate: true` and sends nothing. Records are kept at least 9 days (like `ci_alert`). Without a key, every call sends. |

Any other key, in the request or in `sender`, is refused. Every refusal is `{"ok":false,"error":"<what is wrong and how to fix it>"}`, and nothing is stored or sent.

The answer to an accepted notice:

```json
{"ok":true,"id":"rm-12345678","duplicate":false}
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
	const req = { cmd: "script_notice", token: readFileSync(join(data, "app-token"), "utf8").trim(), role, kind, sender, text };
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

## Stability

The request and answer shapes above are the contract; Ops #783 (a CLI wrapper, so callers never handle the token) wraps them as they are. Changes are additive only.

## Undo

Before any record exists: revert the commit and deploy with `pi-web-deploy`. Once records exist: forward-disable the command (the control-socket case answers "script notices are switched off") and keep the record type, its display and delivery, so stored notices still show and deliver as sent. Never delete records; never turn on `role_report`.
