// ---------------------------------------------------------------------------
// role-replies.ts — telegram-coo: a plugin talks to a role's home chat (host.roles, see plugins.ts)
// ---------------------------------------------------------------------------
// send: the text goes into the role's home chat as the owner's own message, the way a typed one
// does (a closed chat opens in the background); a busy chat gets it right after its current turn
// (the delivery is tried again until the chat is free).
// onReply: when a run in a role's home chat ends, its last assistant text and what started it go to
// the plugins that listen. The cause decides who gets the answer: the Telegram plugin passes on only
// the turns a Telegram message or a plugin (its morning brief) started, and the turns another role's
// reply started when that reply answers a question the role's chat asked for the owner (forOwner);
// the turns the owner starts in the browser stay there.
// forOwner (owner, 2026-10-06: "Yes, answers to my questions"): a question or request a role's home
// chat sends with message_role while its turn is the owner's (his Telegram message started it, or a
// reply to an earlier such question did) is marked forOwner in role-messages.json; the turn its reply
// starts is the owner's again, so chains of questions keep it.
// ---------------------------------------------------------------------------

import { existsSync } from "node:fs";
import { homeChatOf, type IdentityDef } from "./identities.js";
import { stripMarkers } from "./markers/marker.js";

/** What started a turn in a role's home chat. When several did, the first in this order wins. */
export type RoleTurnCause = "telegram" | "plugin" | "role" | "browser" | "other";
export const ROLE_TURN_CAUSES: readonly RoleTurnCause[] = ["telegram", "plugin", "role", "browser", "other"];

/** host.roles.send's `via`: whom the plugin sends for (it becomes the turn's cause). */
export type RoleSendVia = "telegram" | "plugin";

export interface RoleSendOptions {
	via?: RoleSendVia;
	/** Called once when the chat is busy: the text goes in right after its current turn. */
	onQueued?: () => void;
}

export type RoleSendResult = { ok: true; id: string } | { ok: false; error: string };

/** host.roles.onReply: a run in a role's home chat ended. */
export interface RoleReply {
	role: string;
	/** The role's home chat (its transcript), e.g. for a link that opens it. */
	file: string;
	/** The run's last assistant text, whole up to ROLE_REPLY_TEXT_MAX characters (inline markers
	 *  taken out, as the page does); "" when it wrote none. */
	text: string;
	cause: RoleTurnCause;
	/** When it ended (ms). */
	at: number;
	/** The host.roles.send ids this run took in. */
	ids: string[];
	/** The run failed or was stopped: one line saying why. */
	error?: string;
	/** The text was longer than ROLE_REPLY_TEXT_MAX and was cut there. */
	cut?: boolean;
	/** The run answers the owner's own question: another role's reply to a question or request this
	 *  chat sent for him started it (see forOwner above). cause stays "role". */
	forOwner?: boolean;
	/** forOwner: the roles whose replies started it, e.g. ["temper"]. */
	answeredBy?: string[];
	/** forOwner: the host.roles.send ids of the owner's messages behind the question (to thread under). */
	ownerIds?: string[];
}

/** The most send ids a forOwner question keeps. */
export const OWNER_IDS_MAX = 10;

/** The most of a reply's text handed over. */
export const ROLE_REPLY_TEXT_MAX = 20_000;
/** How often a send to a busy chat is tried again. */
export const ROLE_SEND_RETRY_MS = 3_000;
/** How long a send waits for a busy chat before it gives up. */
export const ROLE_SEND_WAIT_MAX_MS = 6 * 60 * 60_000;

/** What a run collects while it goes (per chat, see ClientSession's agent_start / message_end / agent_settled). */
export interface RoleTurnRecord {
	causes: Set<RoleTurnCause>;
	ids: string[];
	/** The last assistant text that has words in it. */
	text: string;
	/** The last assistant message failed or was stopped (cleared by a later one that didn't). */
	error?: string;
	/** A reply to a question asked for the owner started it (or joined it): who answered, and the owner's
	 *  send ids behind the question. */
	forOwner?: RoleOwnerAnswer;
}

/** forOwner: who answered, and the owner's send ids behind the question. */
export interface RoleOwnerAnswer {
	answeredBy: string[];
	ownerIds: string[];
}

export function newTurnRecord(): RoleTurnRecord {
	return { causes: new Set(), ids: [], text: "" };
}

/** Adds `more` to `into` (each name and id once, ownerIds at most OWNER_IDS_MAX); returns the result. */
export function mergeOwnerAnswer(
	into: RoleOwnerAnswer | undefined,
	more: { answeredBy?: readonly string[]; ownerIds?: readonly string[] },
): RoleOwnerAnswer {
	const answeredBy = [...new Set([...(into?.answeredBy ?? []), ...(more.answeredBy ?? [])])];
	const ownerIds = [...new Set([...(into?.ownerIds ?? []), ...(more.ownerIds ?? [])])].slice(0, OWNER_IDS_MAX);
	return { answeredBy, ownerIds };
}

/**
 * forOwner: whether a run that is going now is the owner's, so a question or request its chat sends is
 * marked forOwner: his Telegram message started it (or joined it), or a reply to an earlier forOwner
 * question did. Returns the owner's send ids behind it (for threading), else null.
 */
export function ownerTurnOf(rec: RoleTurnRecord | undefined): { ownerIds: string[] } | null {
	if (!rec) return null;
	const telegram = rec.causes.has("telegram");
	if (!telegram && !rec.forOwner) return null;
	return mergeOwnerAnswer(rec.forOwner, { ownerIds: telegram ? rec.ids : [] });
}

/** The cause that decides where the answer goes. */
export function topCause(causes: Iterable<RoleTurnCause>): RoleTurnCause {
	const set = new Set(causes);
	return ROLE_TURN_CAUSES.find((c) => set.has(c)) ?? "other";
}

/** One line, at most max characters. */
export function oneLineOf(s: unknown, max = 300): string {
	const t = String(s ?? "")
		.replace(/\s+/g, " ")
		.trim();
	return t.length > max ? `${t.slice(0, max - 1)}\u2026` : t;
}

/** The reply for a run that ended in the chat with transcript `file`; null when that is no role's home chat. */
export function roleReplyOf(
	file: string | undefined,
	rec: RoleTurnRecord,
	identities: IdentityDef[],
	at: number,
): RoleReply | null {
	const role = homeChatOf(file, identities);
	if (!role) return null;
	let text = stripMarkers(rec.text).trim();
	const cut = text.length > ROLE_REPLY_TEXT_MAX;
	if (cut) text = text.slice(0, ROLE_REPLY_TEXT_MAX);
	return {
		role: role.id,
		file: file as string,
		text,
		cause: topCause(rec.causes),
		at,
		ids: [...rec.ids],
		...(rec.error ? { error: rec.error } : {}),
		...(cut ? { cut: true } : {}),
		...(rec.forOwner
			? { forOwner: true, answeredBy: [...rec.forOwner.answeredBy], ownerIds: [...rec.forOwner.ownerIds] }
			: {}),
	};
}

/** Where a role's messages go: its home chat's transcript, or why there is none. */
export function roleHomeChat(
	roleId: unknown,
	identities: IdentityDef[],
): { ok: true; file: string; title: string } | { ok: false; error: string } {
	const id = String(roleId ?? "").trim();
	if (!id) return { ok: false, error: "no role given" };
	const role = identities.find((i) => i.id === id);
	if (!role) return { ok: false, error: `there is no role "${oneLineOf(id, 40)}"` };
	const name = role.title || role.id;
	if (!role.homeChat) return { ok: false, error: `the ${name} role has no home chat` };
	if (!existsSync(role.homeChat)) return { ok: false, error: `the ${name} role's home chat file is gone` };
	return { ok: true, file: role.homeChat, title: name };
}

/** A delivery's answer: busy = the chat is working, try again after its turn. */
export type RoleDeliveryResult = { ok: true } | { ok: false; busy?: boolean; error: string };

/**
 * One delivery, tried again while the chat is busy: onQueued is called once, then the delivery is
 * tried every retryMs until it goes in, fails for another reason, the wait passes maxWaitMs, or
 * stopped() says the server is going away.
 */
export async function sendWhenFree(
	deliver: () => Promise<RoleDeliveryResult>,
	opts: {
		onQueued?: () => void;
		sleep?: (ms: number) => Promise<void>;
		now?: () => number;
		retryMs?: number;
		maxWaitMs?: number;
		stopped?: () => boolean;
	} = {},
): Promise<{ ok: true } | { ok: false; error: string }> {
	const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
	const now = opts.now ?? Date.now;
	const retryMs = opts.retryMs ?? ROLE_SEND_RETRY_MS;
	const until = now() + (opts.maxWaitMs ?? ROLE_SEND_WAIT_MAX_MS);
	let queued = false;
	for (;;) {
		let r: RoleDeliveryResult;
		try {
			r = await deliver();
		} catch (err) {
			r = { ok: false, error: (err as Error)?.message || String(err) };
		}
		if (r.ok) return { ok: true };
		if (!r.busy) return { ok: false, error: r.error };
		if (!queued) {
			queued = true;
			try {
				opts.onQueued?.();
			} catch {
				/* the caller's problem; the send goes on */
			}
		}
		if (now() >= until) return { ok: false, error: "the chat stayed busy too long" };
		if (opts.stopped?.()) return { ok: false, error: "the server is restarting" };
		await sleep(retryMs);
	}
}
