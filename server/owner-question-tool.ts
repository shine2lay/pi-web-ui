// ---------------------------------------------------------------------------------------------------------------
// owner-question-tool.ts — owner_question, COO's tool for owner questions held for it (Ops #686)
// ---------------------------------------------------------------------------------------------------------------
//
// Registered only in COO's home chat, and refused anywhere else. list: what is held now. release: to
// the owner with COO's plain note (and a recommendation), which he reads first. hold: keep it up to
// two hours more, renewable. return: hand a question back to the chat that asked, as its own call.
// None of them answers for the owner, and there is no action that could. The work is done by the desk
// (owner-question-coo.ts); this file checks what COO wrote and words the results.

import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { homeChatOf, type IdentityDef } from "./identities.js";
import { plainTextFaults } from "./owner-card-brief.js";
import { OWNER_QUESTION_TOOL, ownerQuestionWho } from "./owner-question-card.js";
import type { CooOwnerQuestionDesk, QuestionWhere } from "./owner-question-coo.js";
import { COO_HOLD_MAX_MS, HOLD_TEXT_MAX } from "./owner-question-holds.js";
import { COO_ROLE } from "./owner-question-route.js";
import { boardTime } from "./role-board.js";

export { OWNER_QUESTION_TOOL };

export interface OwnerQuestionToolHost {
	/** Whether the calling chat is COO's home chat (checked at every call). */
	inCooHomeChat(): boolean;
	/** The desk, or undefined before the app made one. */
	desk(): CooOwnerQuestionDesk | undefined;
	now?(): number;
	/** The owner's time zone (clock times COO gives and the times it is told). */
	tz?: string;
}

/** Whether a chat file is COO's home chat: the only chat owner_question is registered in and works in. */
export function isCooHomeChat(file: string | undefined, identities: IdentityDef[]): boolean {
	return homeChatOf(file, identities)?.id === COO_ROLE;
}

export const ONLY_IN_COO_HOME = "owner_question works only in COO's home chat.";
export const ROUTING_OFF =
	"Owner-question routing is off: nothing is held for you, and every question goes straight to the owner.";

const QUESTION_TEXT_SHOWN = 120;

function clock(ms: number, tz?: string): string {
	return boardTime(ms, tz).replace(/^\d{4}-\d{2}-\d{2} /, "");
}

/** The offset of `tz` from UTC at `ms`, in ms. */
function zoneOffset(ms: number, tz?: string): number {
	try {
		const parts = new Intl.DateTimeFormat("en-US", {
			...(tz ? { timeZone: tz } : {}),
			year: "numeric",
			month: "2-digit",
			day: "2-digit",
			hour: "2-digit",
			minute: "2-digit",
			second: "2-digit",
			hourCycle: "h23",
		}).formatToParts(new Date(ms));
		const n = (t: string): number => Number(parts.find((p) => p.type === t)?.value ?? 0);
		return (
			Date.UTC(n("year"), n("month") - 1, n("day"), n("hour"), n("minute"), n("second")) - Math.floor(ms / 1000) * 1000
		);
	} catch {
		return 0;
	}
}

const UNIT_MS: Record<string, number> = { h: 3_600_000, m: 60_000 };
const unitOf = (u: string): number => UNIT_MS[u.toLowerCase().startsWith("h") ? "h" : "m"]!;

/**
 * The time a hold runs until, from what COO wrote: "45m", "in 45 minutes", "1h30m", "2 hours",
 * a clock time "10:30" or "10:30 am" in the owner's zone (the next one to come), or a full date and
 * time. Undefined when it isn't one of those.
 */
export function parseHoldUntil(text: string, now: number, tz?: string): number | undefined {
	// Bound untrusted text before the numeric patterns and date parser.
	if (text.length > HOLD_TEXT_MAX || !Number.isFinite(now)) return undefined;
	const t = text.trim().toLowerCase();
	if (!t) return undefined;
	const rel =
		/^(?:in\s+)?(\d+(?:\.\d+)?)\s*(h|hrs?|hours?|m|mins?|minutes?)(?:\s*(?:and\s+)?(\d+)\s*(m|mins?|minutes?))?$/.exec(
			t,
		);
	if (rel) {
		const ms = Number(rel[1]) * unitOf(rel[2]!) + (rel[3] ? Number(rel[3]) * unitOf(rel[4]!) : 0);
		return Number.isFinite(ms) && ms > 0 ? now + Math.round(ms) : undefined;
	}
	const at = /^(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/.exec(t);
	if (at && (at[2] !== undefined || at[3] !== undefined)) {
		let hour = Number(at[1]);
		const minute = Number(at[2] ?? 0);
		if (at[3]) {
			if (hour < 1 || hour > 12) return undefined;
			hour = (hour % 12) + (at[3] === "pm" ? 12 : 0);
		}
		if (hour > 23 || minute > 59) return undefined;
		// Try both offsets around a clock change and round-trip them. A missing spring
		// time isn't silently moved; the second autumn occurrence can still be ahead.
		const local = new Date(now + zoneOffset(now, tz));
		const candidates: number[] = [];
		for (const day of [0, 1]) {
			const wall = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() + day, hour, minute);
			const offsets = new Set([-36, -12, 0, 12, 36].map((h) => zoneOffset(wall + h * 3_600_000, tz)));
			for (const offset of offsets) {
				const ms = wall - offset;
				if (ms > now && ms + zoneOffset(ms, tz) === wall) candidates.push(ms);
			}
		}
		return candidates.length ? Math.min(...candidates) : undefined;
	}
	if (/^\d{4}-\d{2}-\d{2}[t ]\d{1,2}:\d{2}/.test(t)) {
		const ms = Date.parse(text.trim());
		return Number.isFinite(ms) ? ms : undefined;
	}
	return undefined;
}

const FAULT_WORDS = { id: "an id", path: "a path", code: "code" } as const;

/** Why a text for the owner can't go as it is (too long, not plain words), or null. */
export function ownerTextProblem(text: string, what: string): string | null {
	if (text.length > HOLD_TEXT_MAX) return `The ${what} is ${text.length} characters; at most ${HOLD_TEXT_MAX}.`;
	const faults = plainTextFaults(text);
	if (!faults.length) return null;
	const named = faults.slice(0, 4).map((f) => `${FAULT_WORDS[f.kind]} (${f.text})`);
	return `The ${what} isn't plain words: it holds ${named.join(", ")}. The owner reads it cold: say it in words he knows.`;
}

/** Why a question can't be acted on, in COO's terms. */
export function whereWords(w: QuestionWhere): string {
	switch (w.at) {
		case "held":
			return `${w.handle} is held for you.`;
		case "owner":
			return w.by === "coo"
				? `${w.handle} is already with the owner: you let it through.`
				: w.by === "owner-answered"
					? `${w.handle} is already answered by the owner.`
					: `${w.handle} is already with the owner: the safety net let it through.`;
		case "answered":
			return `${w.handle} is already answered: nothing to do.`;
		case "returned":
			return `${w.handle} was already handed back to the chat that asked.`;
		case "gone":
			return `${w.handle} is gone: the chat stopped asking (answered, cancelled or closed). Nothing to do.`;
		default:
			return `Nothing held is called ${w.handle}. List shows what is held for you now.`;
	}
}

const KIND_SHORT = {
	question: "question",
	dialog: "pop-up",
	approval: "tool approval",
	stuck: "queued task's card",
} as const;
const NOT_RETURNABLE =
	"Only a question asked with ask_user_question can go back to the chat that asked. A queued task's card, a pop-up or a tool approval goes to the owner: release it.";

type Params = {
	action: "list" | "release" | "hold" | "return";
	id?: string;
	note?: string;
	recommendation?: string;
	until?: string;
	why?: string;
};

const DESCRIPTION =
	"Owner questions held for you (COO) before the owner sees them, each with a card in this chat. " +
	"list: what is held now. release: send it to the owner now with a plain note he reads first (and a recommendation). " +
	"hold: keep it while you gather context, up to 2 hours each time, renewable. " +
	"return: hand an ask_user_question question back to the chat that asked, when it is clearly that chat's own call. " +
	"You never answer for the owner. One still held when your turn ends with no action goes to him at once.";

const GUIDELINES = [
	"owner_question: gather the context a held question needs, and never answer it for the owner.",
	"owner_question: always release what only the owner can give: consent, spending, publishing, his pauses and his own stops.",
	"owner_question: prefer release with a plain note (no ids, paths or code, at most 600 characters) and a recommendation.",
	"owner_question: return only when the question is clearly the asking role's own call; hold only while you gather context.",
];

export function makeOwnerQuestionTool(host: OwnerQuestionToolHost): ToolDefinition {
	return defineTool({
		name: OWNER_QUESTION_TOOL,
		label: "Owner question",
		description: DESCRIPTION,
		promptSnippet: "owner_question: release, hold or return owner questions held for COO",
		promptGuidelines: GUIDELINES,
		parameters: Type.Object({
			action: Type.Union(
				[Type.Literal("list"), Type.Literal("release"), Type.Literal("hold"), Type.Literal("return")],
				{
					description: "list, release, hold or return",
				},
			),
			id: Type.Optional(Type.String({ description: 'The question\'s tag from its card or list, like "oq-1a2b3c4d".' })),
			note: Type.Optional(
				Type.String({
					description: `release: plain words the owner reads first (at most ${HOLD_TEXT_MAX} characters, no ids, paths or code). return: what the asking chat should do instead.`,
				}),
			),
			recommendation: Type.Optional(
				Type.String({ description: "release: what you recommend he picks, in plain words." }),
			),
			until: Type.Optional(
				Type.String({ description: 'hold: until when, at most 2 hours ahead: "45m", "1h30m", "10:30" (his time).' }),
			),
			why: Type.Optional(Type.String({ description: "hold: what you are waiting for." })),
		}),
		execute: async (_id, raw) => {
			const p = raw as Params;
			const reply = (text: string, ok: boolean, extra: Record<string, unknown> = {}) => ({
				content: [{ type: "text" as const, text }],
				details: { action: p.action, ok, ...extra },
			});
			if (!host.inCooHomeChat()) return reply(ONLY_IN_COO_HOME, false);
			const desk = host.desk();
			if (!desk || !desk.routingOn()) return reply(ROUTING_OFF, false, { routing: "off" });
			const now = host.now?.() ?? Date.now();
			const tz = host.tz;

			if (p.action === "list") {
				const held = desk.list();
				if (!held.length) return reply("Nothing is held for you now.", true, { held: [] });
				const lines = held.map((h) => {
					const text = h.ask.fields[0]?.text ?? h.ask.title;
					const shown = text.length > QUESTION_TEXT_SHOWN ? `${text.slice(0, QUESTION_TEXT_SHOWN - 1)}…` : text;
					const bits = [h.handle, ownerQuestionWho(h.asker), KIND_SHORT[h.ask.kind], `“${shown}”`];
					bits.push(
						h.holdUntil !== undefined
							? `you hold it until ${clock(h.holdUntil, tz)}${h.holdWhy ? ` (${h.holdWhy})` : ""}`
							: `goes to the owner at ${clock(h.goesAt, tz)}`,
					);
					if (h.cardAt === undefined) bits.push("card not delivered yet");
					return `- ${bits.join(" · ")}`;
				});
				return reply(`Held for you now (${held.length}):\n${lines.join("\n")}`, true, {
					held: held.map((h) => h.handle),
				});
			}

			const handle = (p.id ?? "").trim();
			if (!handle) return reply('Say which question: id "oq-…" from its card, or list.', false);
			const note = (p.note ?? "").trim();

			if (p.action === "release") {
				if (!note)
					return reply("A release needs a note for the owner, in plain words: what this is and why it's his.", false);
				const noteProblem = ownerTextProblem(note, "note");
				if (noteProblem) return reply(noteProblem, false);
				const rec = (p.recommendation ?? "").trim();
				const recProblem = rec ? ownerTextProblem(rec, "recommendation") : null;
				if (recProblem) return reply(recProblem, false);
				const r = desk.release(handle, note, rec || undefined);
				if (!r.ok) return reply(r.where ? whereWords(r.where) : `Not let through: ${r.error}.`, false);
				return reply(`${handle} went to the owner with your note first${rec ? " and your recommendation" : ""}.`, true);
			}

			if (p.action === "hold") {
				const until = parseHoldUntil(p.until ?? "", now, tz);
				if (until === undefined)
					return reply('Say until when, at most 2 hours ahead: "45m", "1h30m", or a clock time like "10:30".', false);
				if (until <= now) return reply("That time has passed; give one ahead, at most 2 hours.", false);
				if (until - now > COO_HOLD_MAX_MS)
					return reply(
						`That's more than 2 hours ahead (${clock(until, tz)}). Hold at most 2 hours; hold again before then to renew.`,
						false,
					);
				const why = (p.why ?? "").trim();
				if (!why) return reply("Say why you hold it: what you are waiting for.", false);
				if (why.length > HOLD_TEXT_MAX)
					return reply(`The reason is ${why.length} characters; at most ${HOLD_TEXT_MAX}.`, false);
				const r = desk.hold(handle, until, why);
				if (!r.ok)
					return reply(r.where && r.where.at !== "held" ? whereWords(r.where) : `Not held: ${r.error}.`, false);
				return reply(
					`${handle} is held until ${clock(r.until, tz)}. Then it goes to the owner, unless you release, return or hold it again.`,
					true,
					{ until: r.until },
				);
			}

			if (p.action === "return") {
				if (!note) return reply("Say what the chat that asked should do instead.", false);
				if (note.length > HOLD_TEXT_MAX)
					return reply(`The note is ${note.length} characters; at most ${HOLD_TEXT_MAX}.`, false);
				const where = desk.where(handle);
				if (where.at !== "held") return reply(whereWords(where), false);
				if (where.ask.kind !== "question") return reply(NOT_RETURNABLE, false);
				const r = desk.returnToAsker(handle, note);
				if (!r.ok)
					return reply(r.where && r.where.at !== "held" ? whereWords(r.where) : `Not handed back: ${r.error}.`, false);
				return reply(
					`${handle} went back to the chat that asked, as its own call (not the owner's answer). If it asks again, it goes straight to him.`,
					true,
				);
			}

			return reply("Unknown action: list, release, hold or return.", false);
		},
	});
}
