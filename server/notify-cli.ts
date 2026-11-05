// ---------------------------------------------------------------------------
// notify-cli.ts — `pi-web-ui notify telegram|role`: one command for scripts to Telegram the owner or tell a role
// ---------------------------------------------------------------------------
// Ops #783 (Systems rm-e2634da5, RollCall's continuous deployer). A script runs
//   pi-web-ui notify telegram --text <t> [--from <name>] [--url <u>] [--link-label <l>]
//   pi-web-ui notify role --to <role> --kind fyi|request --text <t> --sender-id <id> --sender-title <title> [--key <k>]
// and this reads the app token itself, sends the control socket's telegram_send or script_notice
// (server/control-socket.ts) and turns the answer into an exit code, so the caller never holds the token.
// Fields are checked with the server's own checkers (owner-telegram.ts, script-notice.ts) before anything is
// sent; the server checks them again. Nothing is guessed and nothing is retried. The token and the text are
// never printed.
// ---------------------------------------------------------------------------

import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { ControlOutcome } from "./control-client.js";
import { checkOwnerTelegram } from "./owner-telegram.js";
import { checkScriptNotice } from "./script-notice.js";

/** The exit codes (docs/script-notice.md). */
export const NOTIFY_EXIT = {
	/** Sent: Telegram took the message, or the notice is stored and on its way. */
	sent: 0,
	/** Bad input: a missing, unknown or invalid option, or a bad field; nothing was sent. */
	badInput: 2,
	/** The server refused it (wrong token, unknown role, Telegram off or refusing, ...); nothing was sent. */
	refused: 3,
	/** The server couldn't be reached (not running, no socket, no app token); nothing was sent. */
	unreachable: 4,
	/** Unknown: the request went out but no clear answer came back; it may have been sent. Check before sending
	 *  it again (a role notice with --key can be sent again safely). */
	maybeSent: 5,
} as const;

/** How long to wait for an answer: a Telegram send retries and may take several calls (plugins/telegram). */
export const NOTIFY_TIMEOUT_MS = { telegram: 150_000, role: 15_000 } as const;

export const NOTIFY_USAGE = `Usage:
  pi-web-ui notify telegram --text <text> [--from <name>] [--url <http(s) address or /path>] [--link-label <label>]
  pi-web-ui notify role --to <role id> --kind fyi|request --text <text> --sender-id <id> --sender-title <title> [--key <key>]

  telegram  sends the owner a Telegram message through the pi bot (like a chat's telegram_send).
  role      adds a notice to a role's home chat (fyi: without a turn; request: starts one); a script can't read a reply.
  --text -  reads the text from stdin (trailing line breaks dropped).
  --data-dir <dir>  pi-web-ui's data dir (default $PI_WEB_DATA_DIR, else ~/.pi-web); --port <n> only on Windows.

  Prints the Telegram message id(s), or the notice id and duplicate=true|false.
  Exit 0 sent · 2 bad input · 3 refused by the server · 4 server unreachable · 5 may have been sent (no clear answer).
  Nothing is sent on 2, 3 or 4. Details: docs/script-notice.md in the pi-web-ui repo.`;

/** What runNotify needs from the outside (the real ones in bin/pi-web-ui.mjs; fakes in tests). */
export interface NotifyIo {
	env: Record<string, string | undefined>;
	/** All of stdin, for --text -. */
	readStdin(): Promise<string>;
	/** The app token in a data dir (app-token.ts readAppToken), or undefined. */
	readToken(dataDir: string): string | undefined;
	/** The socket path for a data dir and port (control-client.ts controlPath). */
	socketPath(dataDir: string, port: string): string;
	/** One request and its answer (control-client.ts askControl). */
	ask(path: string, request: Record<string, unknown>, timeoutMs: number): Promise<ControlOutcome>;
	out(line: string): void;
	err(line: string): void;
}

type Sub = "telegram" | "role";

const OPTIONS: Record<Sub, readonly string[]> = {
	telegram: ["--text", "--from", "--url", "--link-label", "--data-dir", "--port"],
	role: ["--to", "--kind", "--text", "--sender-id", "--sender-title", "--key", "--data-dir", "--port"],
};

const REQUIRED: Record<Sub, readonly string[]> = {
	telegram: ["--text"],
	role: ["--to", "--kind", "--text", "--sender-id", "--sender-title"],
};

/** Run `pi-web-ui notify <argv...>` (argv = the words after "notify"); resolves to the exit code. */
export async function runNotify(argv: readonly string[], io: NotifyIo): Promise<number> {
	const bad = (why: string): number => {
		io.err(`pi-web-ui notify: ${why}`);
		io.err(NOTIFY_USAGE.split("\n").slice(0, 3).join("\n"));
		return NOTIFY_EXIT.badInput;
	};
	const sub = argv[0];
	if (sub === "--help" || sub === "-h" || sub === "help") {
		io.out(NOTIFY_USAGE);
		return NOTIFY_EXIT.sent;
	}
	if (sub !== "telegram" && sub !== "role")
		return bad(
			sub === undefined ? "say telegram or role" : `unknown kind of notice "${cut(sub, 40)}" (telegram or role)`,
		);
	const parsed = parseOptions(sub, argv.slice(1));
	if ("help" in parsed) {
		io.out(NOTIFY_USAGE);
		return NOTIFY_EXIT.sent;
	}
	if ("error" in parsed) return bad(parsed.error);
	const opts = parsed.opts;
	if (opts["--text"] === "-") {
		let text: string;
		try {
			text = await io.readStdin();
		} catch (e) {
			return bad(`couldn't read the text from stdin: ${cut(String((e as Error)?.message ?? e), 200)}`);
		}
		opts["--text"] = text.replace(/(\r?\n)+$/, "");
	}

	let fields: Record<string, unknown>;
	if (sub === "telegram") {
		const req = {
			text: opts["--text"],
			...(opts["--from"] !== undefined ? { from: opts["--from"] } : {}),
			...(opts["--url"] !== undefined ? { url: opts["--url"] } : {}),
			...(opts["--link-label"] !== undefined ? { linkLabel: opts["--link-label"] } : {}),
		};
		const checked = checkOwnerTelegram(req);
		if (!checked.ok) return bad(checked.error);
		fields = { cmd: "telegram_send", ...checked.notice };
	} else {
		const checked = checkScriptNotice({
			role: opts["--to"],
			kind: opts["--kind"],
			sender: { id: opts["--sender-id"], title: opts["--sender-title"] },
			text: opts["--text"],
			...(opts["--key"] !== undefined ? { key: opts["--key"] } : {}),
		});
		if (!checked.ok) return bad(asOptionNames(checked.error));
		fields = {
			cmd: "script_notice",
			role: opts["--to"],
			kind: opts["--kind"],
			sender: { id: opts["--sender-id"], title: opts["--sender-title"] },
			text: opts["--text"],
			...(opts["--key"] !== undefined ? { key: opts["--key"] } : {}),
		};
	}

	const dataDir = resolve(opts["--data-dir"] ?? io.env.PI_WEB_DATA_DIR ?? join(homedir(), ".pi-web"));
	const port = opts["--port"] ?? io.env.PI_WEB_PORT ?? "8787";
	const unreachable = (why: string): number => {
		io.err(`pi-web-ui notify: not sent: ${why}`);
		return NOTIFY_EXIT.unreachable;
	};
	const token = io.readToken(dataDir);
	if (!token)
		return unreachable(
			`no app token in ${join(dataDir, "app-token")}; is pi-web-ui running with this data dir? (--data-dir or PI_WEB_DATA_DIR)`,
		);
	const path = io.socketPath(dataDir, port);
	const outcome = await io.ask(path, { ...fields, token }, NOTIFY_TIMEOUT_MS[sub]);
	if (outcome.state === "unreachable")
		return unreachable(`the server isn't reachable at ${path} (${cut(outcome.why, 120)}); is pi-web-ui running?`);
	if (outcome.state === "no-answer") {
		io.err(
			`pi-web-ui notify: unknown: ${cut(outcome.why, 120)}; it may have been sent, so check before sending it again`,
		);
		return NOTIFY_EXIT.maybeSent;
	}
	const answer = outcome.answer;
	const error = typeof answer.error === "string" ? cut(answer.error, 400) : "the server refused it";
	if (answer.ok !== true) {
		if (answer.maybeSent === true) {
			io.err(`pi-web-ui notify: unknown: ${error}; it may have been sent, so check before sending it again`);
			return NOTIFY_EXIT.maybeSent;
		}
		io.err(`pi-web-ui notify: not sent: ${error}`);
		return NOTIFY_EXIT.refused;
	}
	if (sub === "telegram") {
		const ids = Array.isArray(answer.messageIds) ? answer.messageIds.filter((n) => typeof n === "number") : [];
		io.out(ids.length ? ids.join(" ") : "sent");
	} else {
		io.out(`${typeof answer.id === "string" ? answer.id : "sent"} duplicate=${answer.duplicate === true}`);
	}
	return NOTIFY_EXIT.sent;
}

type Parsed = { opts: Record<string, string> } | { error: string } | { help: true };

/** --name value or --name=value, each option once, no other words. */
function parseOptions(sub: Sub, args: readonly string[]): Parsed {
	const opts: Record<string, string> = {};
	for (let i = 0; i < args.length; i++) {
		const a = args[i];
		if (a === "--help" || a === "-h") return { help: true };
		if (!a.startsWith("--")) return { error: `unexpected "${cut(a, 40)}" (every value goes after its option)` };
		const eq = a.indexOf("=");
		const name = eq >= 0 ? a.slice(0, eq) : a;
		if (!OPTIONS[sub].includes(name))
			return { error: `${sub} takes no option ${cut(name, 40)} (it takes ${OPTIONS[sub].join(", ")})` };
		if (name in opts) return { error: `${name} is given twice` };
		let value: string;
		if (eq >= 0) value = a.slice(eq + 1);
		else if (i + 1 < args.length) value = args[++i];
		else return { error: `${name} needs a value` };
		opts[name] = value;
	}
	const missing = REQUIRED[sub].filter((n) => !(n in opts));
	if (missing.length) return { error: `${sub} needs ${missing.join(", ")}` };
	return { opts };
}

/** A script_notice refusal in the CLI's option names ("sender.id must ..." -> "--sender-id must ..."). */
const FIELD_OPTION: readonly [RegExp, string][] = [
	[/^role /, "--to "],
	[/^kind /, "--kind "],
	[/^sender\.id /, "--sender-id "],
	[/^sender\.title /, "--sender-title "],
	[/^text /, "--text "],
	[/^key /, "--key "],
];
function asOptionNames(error: string): string {
	for (const [field, option] of FIELD_OPTION) if (field.test(error)) return error.replace(field, option);
	return error;
}

function cut(s: string, n: number): string {
	const t = s.replace(/\s+/g, " ");
	return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}
