// owner-contacts (Roles D3): the owner's own messages to a role's home chat, and how far each got:
//   asked       the app admitted it (browser prompt, or a Telegram send through host.roles.send);
//   in its chat pi took it into a turn of that chat (noteTurnCause);
//   replied     that turn settled: with text, with no text, or failed;
//   sent        Telegram only: the plugin's result of sending the reply back to his Telegram.
// Display only. Same-UID files can be forged, so nothing here grants, routes or counts anything.
// A stage without a record shows as "not recorded", never as "didn't happen".
// Store: <dataDir>/owner-contacts.jsonl, append-only, 0600, one event per line. Events of contacts
// older than OWNER_CONTACTS_WINDOW_MS are dropped when read, and when the file is compacted.
// Text: short excerpts of his own message and of the role's reply, for his own Roles page.

import { appendFileSync, chmodSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import type { UiOwnerContact, UiTaskRequesterInput } from "./protocol.js";
import type { RequesterTurn } from "./queue-requester.js";

export const OWNER_CONTACTS_WINDOW_MS = 90 * 24 * 60 * 60_000;
/** The newest contacts the page gets. */
export const OWNER_CONTACTS_MAX = 200;
export const OWNER_CONTACT_TEXT_MAX = 280;
export const OWNER_CONTACT_REPLY_MAX = 1_200;
/** Past this size the file is rewritten with only the window's contacts. */
export const OWNER_CONTACTS_FILE_MAX = 4 << 20;
/** A file bigger than this isn't read at all (something else wrote it). */
export const OWNER_CONTACTS_READ_MAX = 32 << 20;
/** The cached list is rebuilt at least this often (the window's edge moves). */
const LIST_TTL_MS = 60_000;

const ID = /^(?:ri|rs)-[a-f0-9-]{8,64}$/u;
const ROLE = /^[a-z0-9][a-z0-9-]{0,39}$/u;

export type OwnerContactOutcome = "text" | "noText" | "error";

export type OwnerContactEvent =
	| { e: "contact"; id: string; at: number; role: string; channel: "browser" | "telegram"; text?: string }
	| { e: "taken"; id: string; at: number }
	| { e: "settled"; id: string; at: number; outcome: OwnerContactOutcome; reply?: string }
	| { e: "transport"; id: string; at: number; ok: boolean };

/** One line, at most max characters (whole code points), "…" when cut; empty → undefined. */
export function excerptOf(s: unknown, max: number): string | undefined {
	if (typeof s !== "string") return undefined;
	const t = s.replace(/\s+/gu, " ").trim();
	if (!t) return undefined;
	const cs = Array.from(t);
	return cs.length > max ? `${cs.slice(0, max - 1).join("")}…` : t;
}

/** A stored or noted event, checked field by field (anything else is dropped). */
export function ownerContactEventOf(raw: unknown): OwnerContactEvent | undefined {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
	const r = raw as Record<string, unknown>;
	if (typeof r.id !== "string" || !ID.test(r.id)) return undefined;
	if (typeof r.at !== "number" || !Number.isFinite(r.at) || r.at <= 0) return undefined;
	switch (r.e) {
		case "contact": {
			if (typeof r.role !== "string" || !ROLE.test(r.role)) return undefined;
			if (r.channel !== "browser" && r.channel !== "telegram") return undefined;
			const text = excerptOf(r.text, OWNER_CONTACT_TEXT_MAX);
			return { e: "contact", id: r.id, at: r.at, role: r.role, channel: r.channel, ...(text ? { text } : {}) };
		}
		case "taken":
			return { e: "taken", id: r.id, at: r.at };
		case "settled": {
			if (r.outcome !== "text" && r.outcome !== "noText" && r.outcome !== "error") return undefined;
			const reply = r.outcome === "text" ? excerptOf(r.reply, OWNER_CONTACT_REPLY_MAX) : undefined;
			return { e: "settled", id: r.id, at: r.at, outcome: r.outcome, ...(reply ? { reply } : {}) };
		}
		case "transport":
			return typeof r.ok === "boolean" ? { e: "transport", id: r.id, at: r.at, ok: r.ok } : undefined;
	}
	return undefined;
}

/** The contacts in the window, newest first. A stage's first record wins; a later good send clears a failed one. */
export function foldOwnerContacts(events: Iterable<OwnerContactEvent>, now: number): UiOwnerContact[] {
	const from = now - OWNER_CONTACTS_WINDOW_MS;
	const byId = new Map<string, UiOwnerContact>();
	for (const ev of events) {
		if (ev.e === "contact") {
			if (ev.at < from || byId.has(ev.id)) continue;
			byId.set(ev.id, {
				id: ev.id,
				role: ev.role,
				channel: ev.channel,
				askedAt: ev.at,
				...(ev.text ? { text: ev.text } : {}),
			});
			continue;
		}
		const c = byId.get(ev.id);
		if (!c) continue;
		if (ev.e === "taken") c.takenAt ??= ev.at;
		else if (ev.e === "settled") {
			if (c.settledAt !== undefined) continue;
			c.settledAt = ev.at;
			c.outcome = ev.outcome;
			if (ev.reply) c.reply = ev.reply;
		} else if (c.channel === "telegram") {
			if (ev.ok) {
				c.sentAt ??= ev.at;
				delete c.sendFailedAt;
			} else if (c.sentAt === undefined) c.sendFailedAt = ev.at;
		}
	}
	return [...byId.values()].sort((a, b) => b.askedAt - a.askedAt).slice(0, OWNER_CONTACTS_MAX);
}

/** The owner's input among a turn's inputs (D2's requester inputs), browser or Telegram. */
export function ownerInputIds(turn: RequesterTurn | undefined): string[] {
	return (turn?.requesterInputs ?? []).flatMap((i: UiTaskRequesterInput) => (i.kind === "owner" ? [i.id] : []));
}

/** The append-only store. Every error is swallowed: a failed note costs a stage, never a turn. */
export class OwnerContacts {
	/** Contact ids in the window (stage events for any other id aren't written). */
	private known: Set<string> | null = null;
	private cache: { mtimeMs: number; size: number; at: number; list: UiOwnerContact[] } | null = null;

	constructor(
		private readonly file: string,
		private readonly now: () => number = Date.now,
	) {}

	private readEvents(): OwnerContactEvent[] {
		let text: string;
		try {
			if (statSync(this.file).size > OWNER_CONTACTS_READ_MAX) return [];
			text = readFileSync(this.file, "utf8");
		} catch {
			return [];
		}
		const out: OwnerContactEvent[] = [];
		for (const line of text.split("\n")) {
			if (!line.trim()) continue;
			try {
				const ev = ownerContactEventOf(JSON.parse(line));
				if (ev) out.push(ev);
			} catch {
				// a torn or foreign line: skipped
			}
		}
		return out;
	}

	private knownIds(): Set<string> {
		if (!this.known) {
			const from = this.now() - OWNER_CONTACTS_WINDOW_MS;
			this.known = new Set(this.readEvents().flatMap((ev) => (ev.e === "contact" && ev.at >= from ? [ev.id] : [])));
		}
		return this.known;
	}

	/** Records one event (checked; stage events only for a known contact). */
	note(raw: unknown): void {
		const ev = ownerContactEventOf(raw);
		if (!ev) return;
		try {
			const known = this.knownIds();
			if (ev.e === "contact") {
				if (known.has(ev.id)) return;
				known.add(ev.id);
			} else if (!known.has(ev.id)) return;
			appendFileSync(this.file, `${JSON.stringify(ev)}\n`, { mode: 0o600 });
			if (statSync(this.file).size > OWNER_CONTACTS_FILE_MAX) this.compact();
		} catch (err) {
			console.error("[owner-contacts] couldn't record:", (err as Error)?.message ?? err);
		}
	}

	/** Rewrites the file with only the window's contacts and their stage events. */
	private compact(): void {
		const from = this.now() - OWNER_CONTACTS_WINDOW_MS;
		const events = this.readEvents();
		const keep = new Set(events.flatMap((ev) => (ev.e === "contact" && ev.at >= from ? [ev.id] : [])));
		const tmp = `${this.file}.${process.pid}.tmp`;
		writeFileSync(
			tmp,
			events
				.filter((ev) => keep.has(ev.id))
				.map((ev) => `${JSON.stringify(ev)}\n`)
				.join(""),
			{
				mode: 0o600,
			},
		);
		chmodSync(tmp, 0o600);
		renameSync(tmp, this.file);
		this.known = keep;
		this.cache = null;
	}

	/** The contacts in the window, newest first (cached while the file is unchanged). */
	list(): UiOwnerContact[] {
		const at = this.now();
		let st: { mtimeMs: number; size: number };
		try {
			st = statSync(this.file);
		} catch {
			return [];
		}
		const c = this.cache;
		if (c && c.mtimeMs === st.mtimeMs && c.size === st.size && at - c.at < LIST_TTL_MS) return c.list;
		const list = foldOwnerContacts(this.readEvents(), at);
		this.cache = { mtimeMs: st.mtimeMs, size: st.size, at, list };
		return list;
	}
}
