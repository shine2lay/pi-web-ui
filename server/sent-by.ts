/**
 * sent-by (Ops #972): who typed a web message, from the Tailscale login.
 *
 * `tailscale serve` (https://<spark>:8787 -> http://127.0.0.1:8787) adds `Tailscale-User-Login` and
 * `Tailscale-User-Name` to every request it proxies and drops copies a client sent. This server
 * listens on 127.0.0.1 only, so a request carrying them came through serve: that and serve's
 * overwrite are the whole trust (a process on spark could forge them, the same boundary as the rest
 * of spark). No header (local access, a tagged device) = no sender, exactly as before.
 *
 * `<data dir>/people.json` names people: `{ "<login>": { "name": "Wai", "owner"?: true } }`. A login
 * that isn't there keeps its Tailscale display name. The file is read again when it changes, so a
 * new person needs no restart. A missing file is said once; a broken one is said loudly each time
 * it changes, and until it is fixed every login keeps its display name (the server never stops for it).
 * Each distinct login is logged once per server run, so a new person's exact login shows up on
 * their first visit.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { readFileSync, statSync } from "node:fs";
import type { IncomingHttpHeaders } from "node:http";
import type { OwnerViewer } from "./owner-requester.js";

/** Longest name kept. */
export const SENT_BY_NAME_MAX = 80;

/** A name safe inside the `[From: <name>]` line: no brackets or line breaks, trimmed, at most SENT_BY_NAME_MAX. */
export function sentByName(name: string): string {
	return name
		.replace(/[[\]\r\n]+/gu, " ")
		.replace(/\s+/gu, " ")
		.trim()
		.slice(0, SENT_BY_NAME_MAX)
		.trim();
}

/** Who Tailscale says sent a request. */
export interface TailscaleSender {
	/** Login name, lower case (e.g. "sayswai@gmail.com"). */
	login: string;
	/** Display name as Tailscale gave it (falls back to the login). */
	name: string;
}

/** A sender as the chat records it (people.json applied). */
export interface SentBy {
	login: string;
	name: string;
	/** people.json marks this login as the owner. */
	owner: boolean;
}

export interface Person {
	name: string;
	owner: boolean;
}

const header = (v: string | string[] | undefined): string => (Array.isArray(v) ? (v[0] ?? "") : (v ?? "")).trim();

/** serve encodes a non-ASCII display name as an RFC 2047 word (`=?utf-8?q?...?=` or `?b?`). */
function decodeHeaderWord(value: string): string {
	return value.replace(/=\?utf-8\?([qb])\?([^?]*)\?=/giu, (_all, enc: string, body: string) => {
		const bytes =
			enc.toLowerCase() === "b"
				? Buffer.from(body, "base64")
				: Buffer.from(
						body
							.replace(/_/gu, " ")
							.replace(/=([0-9a-f]{2})/giu, (_m, hex: string) => String.fromCharCode(parseInt(hex, 16))),
						"latin1",
					);
		return bytes.toString("utf8");
	});
}

/** The one reader of the Tailscale identity headers (HTTP requests and websocket upgrades). */
export function tailscaleSenderOf(headers: IncomingHttpHeaders): TailscaleSender | undefined {
	const login = header(headers["tailscale-user-login"]).toLowerCase();
	if (!login) return undefined;
	const name = sentByName(decodeHeaderWord(header(headers["tailscale-user-name"]))) || sentByName(login);
	return { login, name };
}

/** people.json's words, checked; throws with the reason on anything else. */
export function parsePeople(json: string): Map<string, Person> {
	let data: unknown;
	try {
		data = JSON.parse(json);
	} catch (err) {
		throw new Error(`not JSON: ${(err as Error).message}`);
	}
	if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("must be an object of logins");
	const people = new Map<string, Person>();
	for (const [rawLogin, entry] of Object.entries(data)) {
		const login = rawLogin.trim().toLowerCase();
		if (!login || /\s/u.test(login)) throw new Error(`bad login ${JSON.stringify(rawLogin)}`);
		if (!entry || typeof entry !== "object" || Array.isArray(entry))
			throw new Error(`${login}: must be an object like {"name": "..."}`);
		const { name, owner, ...rest } = entry as Record<string, unknown>;
		const extra = Object.keys(rest);
		if (extra.length) throw new Error(`${login}: unknown field ${extra.join(", ")}`);
		if (typeof name !== "string" || !sentByName(name)) throw new Error(`${login}: "name" must be a non-empty string`);
		if (owner !== undefined && typeof owner !== "boolean") throw new Error(`${login}: "owner" must be true or false`);
		if (people.has(login)) throw new Error(`${login}: listed twice`);
		people.set(login, { name: sentByName(name), owner: owner === true });
	}
	return people;
}

type Log = Pick<Console, "log" | "warn" | "error">;

/** people.json, read again when it changes, and the logins seen this run. */
export class PeopleBook {
	private people = new Map<string, Person>();
	private version: string | undefined;
	private readonly seenLogins = new Set<string>();

	constructor(
		private readonly file: string,
		private readonly log: Log = console,
	) {}

	private refresh(): void {
		let version: string;
		try {
			const st = statSync(this.file);
			version = `${st.mtimeMs}:${st.size}`;
		} catch {
			version = "missing";
		}
		if (version === this.version) return;
		this.version = version;
		this.people = new Map();
		if (version === "missing") {
			this.log.warn(`[sent-by] ${this.file} not found: every Tailscale login keeps its display name`);
			return;
		}
		try {
			this.people = parsePeople(readFileSync(this.file, "utf8"));
		} catch (err) {
			this.log.error(
				`[sent-by] ERROR ${this.file} is broken (${(err as Error).message}); until it is fixed every Tailscale login keeps its display name`,
			);
		}
	}

	/** The sender as the chat records it; undefined = no Tailscale identity (as before). */
	resolve(sender: TailscaleSender | undefined): SentBy | undefined {
		if (!sender) return undefined;
		this.refresh();
		const person = this.people.get(sender.login);
		return person
			? { login: sender.login, name: person.name, owner: person.owner }
			: { login: sender.login, name: sender.name, owner: false };
	}

	/** owner-requester (Ops #1051): who a browser connection is, for what its windows are shown. A login people.json
	 *  lists as a person other than the default owner is that person; anything else (no login, his login, an unlisted
	 *  login, people.json missing or broken) is the default owner. */
	viewerOf(sender: TailscaleSender | undefined): OwnerViewer {
		this.refresh();
		const listed = new Set<string>();
		for (const p of this.people.values()) if (!p.owner) listed.add(p.name);
		const person = sender ? this.people.get(sender.login) : undefined;
		return person && !person.owner ? { person: person.name, listed } : { listed };
	}

	/** Express middleware: logs a request's login (seen). */
	readonly noteRequest = (req: { headers: IncomingHttpHeaders }, _res: unknown, next: () => void): void => {
		this.seen(tailscaleSenderOf(req.headers));
		next();
	};

	/** A websocket upgrade's sender, logged (seen); undefined = none. */
	noteSocket(headers: IncomingHttpHeaders): TailscaleSender | undefined {
		const sender = tailscaleSenderOf(headers);
		this.seen(sender);
		return sender;
	}

	/** Log a login the first time this run sees it (an HTTP request or a websocket). */
	seen(sender: TailscaleSender | undefined): void {
		if (!sender || this.seenLogins.has(sender.login)) return;
		this.seenLogins.add(sender.login);
		const who = this.resolve(sender)!;
		const known = this.people.has(sender.login);
		this.log.log(
			`[sent-by] login seen: ${sender.login} (Tailscale name ${JSON.stringify(sender.name)}) -> ${
				known ? `${JSON.stringify(who.name)}${who.owner ? ", owner" : ""}` : "not in people.json"
			}`,
		);
	}
}

const answerer = new AsyncLocalStorage<string | undefined>();

/** owner-requester (Ops #973): run a page socket's message (or a plugin's answer) as this person, so an owner
 *  answer it gives records who gave it (asks.ts settle -> decision-records answeredBy). */
export function asAnswerer<T>(name: string | undefined, fn: () => T): T {
	return answerer.run(name, fn);
}

/** `{ by }` with who is answering now (a sent-by name, the default owner for his own channels), else `{}`. */
export function answeredBy(): { by?: string } {
	const by = answerer.getStore();
	return by ? { by } : {};
}
