// ---------------------------------------------------------------------------
// role-replies.ts — telegram-coo: a plugin talks to a role's home chat (host.roles, see plugins.ts)
// ---------------------------------------------------------------------------
// send: the text goes into the role's home chat as the owner's own message, the way a typed one
// does (a closed chat opens in the background); a busy chat gets it right after its current turn
// (the delivery is tried again until the chat is free).
// onReply: when a run in a role's home chat ends, its last assistant text and what started it go to
// the plugins that listen. The cause decides who gets the answer: the Telegram plugin passes on only
// the turns a Telegram message, a plugin (its morning brief) or another role's message started;
// the turns the owner starts in the browser stay there.
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
}

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
}

export function newTurnRecord(): RoleTurnRecord {
	return { causes: new Set(), ids: [], text: "" };
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
