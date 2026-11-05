// ---------------------------------------------------------------------------
// owner-telegram.ts — a script's Telegram message to the owner (control socket telegram_send, Ops #783)
// ---------------------------------------------------------------------------
// A script on this machine (RollCall's continuous deployer first, Systems rm-e2634da5) sends the owner a
// Telegram message through the pi bot, the way a chat's telegram_send call does: the server runs the
// Telegram plugin's own telegram_send tool (plugins/telegram/index.mjs, Ops #627), so the text, link and
// sender rules, the bot and the owner id are the tool's, and the bot token stays inside the plugin. The
// plugin-bus topic "telegram:send" can't be used for this: it is fire-and-forget (no answer), and a script
// must know whether its message went out.
//
// checkOwnerTelegram checks the request's fields; sendOwnerTelegram runs the tool and reads its answer. A
// result is ok only when the tool says it sent the message; maybeSent marks an answer that can't rule out a
// message having gone out (a part sent, the tool threw, an answer it can't read), so a caller doesn't send
// it again blindly. Pure apart from the tool call; never logs.
// ---------------------------------------------------------------------------

/** The plugin and tool that send the owner's Telegram messages. */
export const OWNER_TELEGRAM_PLUGIN = "telegram";
export const OWNER_TELEGRAM_TOOL = "telegram_send";

/** The keys telegram_send takes (any other is refused). */
export const OWNER_TELEGRAM_KEYS: readonly string[] = ["cmd", "token", "text", "from", "url", "linkLabel"];

/** A checked message: the telegram_send tool's parameters. */
export interface OwnerTelegramNotice {
	text: string;
	from?: string;
	url?: string;
	linkLabel?: string;
}

export type OwnerTelegramCheck = { ok: true; notice: OwnerTelegramNotice } | { ok: false; error: string };

/** What came of a send: the Telegram message ids, or why not (maybeSent: it may have gone out anyway). */
export type OwnerTelegramResult = { ok: true; messageIds: number[] } | { ok: false; error: string; maybeSent?: true };

/** The part of a plugin's agent tool this needs (server/plugins.ts PluginAgentTool). */
export interface OwnerTelegramTool {
	execute(toolCallId: string, params: Record<string, unknown>): Promise<unknown>;
}

const OPTIONAL_FIELDS = ["from", "url", "linkLabel"] as const;

/** The request's fields as the telegram_send tool takes them, or what is wrong. */
export function checkOwnerTelegram(req: Record<string, unknown>): OwnerTelegramCheck {
	if (!req || typeof req !== "object" || Array.isArray(req))
		return { ok: false, error: "the request must be an object" };
	const extra = Object.keys(req).filter((k) => !OWNER_TELEGRAM_KEYS.includes(k));
	if (extra.length)
		return {
			ok: false,
			error: `telegram_send takes only cmd, token, text, from, url and linkLabel (not ${extra.slice(0, 5).join(", ")})`,
		};
	const { text } = req;
	if (typeof text !== "string" || !text.trim())
		return { ok: false, error: "text is required (the message for the owner)" };
	const notice: OwnerTelegramNotice = { text };
	for (const field of OPTIONAL_FIELDS) {
		const value = req[field];
		if (value === undefined) continue;
		if (typeof value !== "string") return { ok: false, error: `${field} must be a string` };
		notice[field] = value;
	}
	return { ok: true, notice };
}

/** Run the Telegram plugin's telegram_send tool (undefined: not loaded) for one checked message. */
export async function sendOwnerTelegram(
	tool: OwnerTelegramTool | undefined,
	notice: OwnerTelegramNotice,
	callId: string,
): Promise<OwnerTelegramResult> {
	if (!tool)
		return { ok: false, error: "the Telegram plugin isn't loaded here (no telegram_send tool); nothing was sent" };
	let answer: unknown;
	try {
		answer = await tool.execute(callId, { ...notice });
	} catch (err) {
		return {
			ok: false,
			error: `the telegram_send tool failed: ${oneLine(err instanceof Error ? err.message : String(err))}`,
			maybeSent: true,
		};
	}
	const details = (answer as { details?: unknown } | null)?.details as
		{ ok?: unknown; error?: unknown; messageIds?: unknown } | undefined;
	const ids = Array.isArray(details?.messageIds) ? details.messageIds.filter((n) => typeof n === "number") : [];
	if (details?.ok === true && ids.length) return { ok: true, messageIds: ids };
	if (details?.ok === false && typeof details.error === "string") {
		const error = `not sent: ${oneLine(details.error)}`;
		return Array.isArray(details.messageIds)
			? { ok: false, error: `${error} (part of it went out before that)`, maybeSent: true }
			: { ok: false, error };
	}
	return {
		ok: false,
		error: "the telegram_send tool gave an answer this can't read; it may have been sent",
		maybeSent: true,
	};
}

function oneLine(s: string): string {
	const t = s.replace(/\s+/g, " ").trim();
	return t.length > 300 ? `${t.slice(0, 299)}…` : t;
}
