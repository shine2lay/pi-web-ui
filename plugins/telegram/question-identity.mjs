/**
 * Stable question identity and repeat-matching helpers for the Telegram plugin (Ops #763, H-TG-ONCE-1).
 *
 * A question's identity is built only from what does not change when pi-web-ui rebuilds an ask
 * across a server restart or chat reopen:
 *   - kind ("question", "dialog", "approval", "stuck")
 *   - the chat or queue file it belongs to (queueFile / sessionFile, falling back to cwd / chat title)
 *   - the task id for stuck asks
 *   - the question's own text, body, and options
 * Never createdAt, conversationId, or the host's stuck-N counter.
 */

import { createHash } from "node:crypto";

/** Keep gone-unanswered identities for 7 days for repeat matching only. */
export const GONE_IDENTITY_TTL_MS = 7 * 24 * 60 * 60_000;

/** Telegram allows bots to delete messages within 48 hours of sending. */
export const TELEGRAM_DELETE_MAX_AGE_MS = 48 * 60 * 60_000;

/** Which queued task a "stuck" ask is about: { id, title } (id 0 when it doesn't say). */
export function stuckTask(ask) {
	const t = ask?.task;
	if (t && Number(t.id) > 0) return { id: Number(t.id), title: String(t.title ?? "") };
	const m = /^Task #(\d+) needs you(?::\s*([\s\S]*))?$/.exec(String(ask?.title ?? ""));
	return m ? { id: Number(m[1]), title: m[2] ?? "" } : { id: 0, title: "" };
}

/** The stable chat or queue file an ask belongs to. */
export function askScope(ask) {
	const qf = typeof ask?.queueFile === "string" ? ask.queueFile.trim() : "";
	if (qf) return qf;
	const sf = typeof ask?.sessionFile === "string" ? ask.sessionFile.trim() : "";
	if (sf) return sf;
	if (ask?.kind === "stuck" && typeof ask?.id === "string") {
		const m = /^stuck:([^:]+):\d+:/.exec(ask.id);
		if (m) {
			try {
				const decoded = decodeURIComponent(m[1]).trim();
				if (decoded) return decoded;
			} catch {
				// ignore malformed URI encoding
			}
		}
	}
	return String(ask?.cwd || ask?.conversationTitle || "").trim();
}

function canonicalOption(o) {
	return {
		value: String(o?.value ?? "").trim(),
		label: String(o?.label ?? "").trim(),
		description: String(o?.description ?? "").trim(),
	};
}

function canonicalOptionsMap(map) {
	if (!map || typeof map !== "object") return null;
	const keys = Object.keys(map).sort();
	if (!keys.length) return null;
	const out = {};
	for (const k of keys) {
		const list = Array.isArray(map[k]) ? map[k] : [];
		out[k] = list.map(canonicalOption);
	}
	return out;
}

function canonicalField(ask, f, taskId) {
	const dep = f?.dependsOn;
	return {
		id: String(f?.id ?? "").trim(),
		header: ask?.kind === "stuck" && taskId > 0 ? "" : String(f?.header ?? "").trim(),
		text: String(f?.text ?? "").trim(),
		detail: String(f?.detail ?? "").trim(),
		multi: Boolean(f?.multi),
		allowText: Boolean(f?.allowText),
		dependsOn: dep?.questionId
			? {
					questionId: String(dep.questionId),
					value: Array.isArray(dep.value)
						? dep.value.map(String)
						: dep.value === undefined || dep.value === null
							? null
							: String(dep.value),
				}
			: null,
		options: (Array.isArray(f?.options) ? f.options : []).map(canonicalOption),
		optionsMap: canonicalOptionsMap(f?.optionsMap),
	};
}

/**
 * Stable SHA-256 hex identity of an ask from its kind, scope, task id, and question text/options.
 * Throws TypeError when given a non-object ask.
 */
export function questionIdentity(ask) {
	if (!ask || typeof ask !== "object") {
		throw new TypeError("questionIdentity: ask must be an object");
	}
	const kind = String(ask.kind ?? "question").trim() || "question";
	const task = kind === "stuck" ? stuckTask(ask) : { id: 0, title: "" };
	const payload = {
		v: 1,
		kind,
		scope: askScope(ask),
		taskId: task.id,
		title: kind === "stuck" && task.id > 0 ? "" : String(ask.title ?? "").trim(),
		body: String(ask.body ?? "").trim(),
		fields: (Array.isArray(ask.fields) ? ask.fields : []).map((f) => canonicalField(ask, f, task.id)),
	};
	return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

/** Short 12-character hex digest for log lines (never contains question text). */
export function questionIdentityHash(askOrIdentity) {
	const hex = typeof askOrIdentity === "string" ? askOrIdentity : questionIdentity(askOrIdentity);
	return hex.slice(0, 12);
}

/** Hash of a rendered Telegram message ({ text, reply_markup }) to detect whether its words changed. */
export function renderSignature(rendered) {
	if (!rendered || typeof rendered !== "object") return "";
	return createHash("sha256")
		.update(JSON.stringify({ text: String(rendered.text ?? ""), reply_markup: rendered.reply_markup ?? null }))
		.digest("hex")
		.slice(0, 16);
}

/**
 * Stuck asks exist in host.asks only while their chat is open in memory. When that chat closes,
 * host.asks emits "gone" ("the chat was closed") even though the queued task on disk is still waiting.
 */
export function isChatCloseGone(ask, reason) {
	if (ask?.kind !== "stuck") return false;
	return /chat.*closed|restarted/i.test(String(reason ?? ""));
}
