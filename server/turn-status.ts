/**
 * turn-status (Ops #688): a turn another role started (its message, a work-check or Initiatives poke, a
 * Board order) ends with one status line from a fixed set instead of a summary. The owner, Oct 31 2026 in
 * COO's home chat (dr-21d97f51403a): ~12:40 PDT "i dont want output token to be wasted in general, maybe
 * you can tell it to response with a status like 'OK' 'DONE' etc..?"; ~12:45 PDT "i mean there should be
 * different states, and it should be applied in the agent messaging tools' prompt in general".
 *
 * Here: the states (TURN_STATES), the sentence an incoming note gives for its kind (statusHint, used by
 * role-messages.ts roleMessageHint and role-board.ts boardOrderText), and the code check of a turn's text
 * (statusLinesOf, which scripts/turn-status-stats.mts counts). pi-identity's roles guidance
 * (templates/roles-section.md) names the same states with their meanings, for every role chat.
 *
 * Not for turns the owner started or joined, nor a reply answering a question asked for him
 * (FOR_OWNER_TURN_HINT): he reads those in full. No Node imports.
 */

export type TurnStateName = "OK" | "DONE" | "ANSWERED" | "QUEUED" | "NOT MINE" | "NEEDS OWNER" | "WAITING" | "DECLINED";

export interface TurnState {
	name: TurnStateName;
	/** How it is written, its detail included: what the notes show. */
	form: string;
	/** What it tells the reader. */
	meaning: string;
	/** What follows the name: nothing; " #<task number>"; ": <role id>"; ": <1 to DETAIL_WORDS_MAX words>". */
	detail: "none" | "task" | "role" | "words";
}

/** The most words a WAITING or DECLINED line's detail may have. */
export const DETAIL_WORDS_MAX = 8;

export const TURN_STATES: readonly TurnState[] = [
	{ name: "OK", form: "OK", meaning: "read it; nothing for me to do", detail: "none" },
	{
		name: "DONE",
		form: "DONE",
		meaning: "did what it asked, and replied or acked where one was owed",
		detail: "none",
	},
	{ name: "ANSWERED", form: "ANSWERED", meaning: "sent the answer to the question", detail: "none" },
	{ name: "QUEUED", form: "QUEUED #N", meaning: "took it on as task #N; reply sent", detail: "task" },
	{
		name: "NOT MINE",
		form: "NOT MINE: <role id>",
		meaning: "not my area; told the sender who owns it",
		detail: "role",
	},
	{
		name: "NEEDS OWNER",
		form: "NEEDS OWNER",
		meaning: "only the owner can decide; asked him or passed it on",
		detail: "none",
	},
	{
		name: "WAITING",
		form: `WAITING: <what, up to ${DETAIL_WORDS_MAX} words>`,
		meaning: "can't finish yet; told the sender what it waits on",
		detail: "words",
	},
	{
		name: "DECLINED",
		form: `DECLINED: <why, up to ${DETAIL_WORDS_MAX} words>`,
		meaning: "won't do it; told the sender why",
		detail: "words",
	},
];

/** What started the turn, as far as its status goes: a role's question, request or reply (one that doesn't
 *  answer a question asked for the owner), a Board order, or a poke (the work check's wake about stalled
 *  work, the Initiatives page's ask for a progress update). */
export type TurnStatusKind = "question" | "request" | "reply" | "order" | "poke";

/** The states each kind allows, in the order its note names them. */
export const STATES_FOR: Readonly<Record<TurnStatusKind, readonly TurnStateName[]>> = {
	question: ["ANSWERED", "NOT MINE", "NEEDS OWNER", "WAITING", "DECLINED"],
	request: ["DONE", "QUEUED", "NOT MINE", "NEEDS OWNER", "WAITING", "DECLINED"],
	reply: ["OK", "DONE", "QUEUED", "WAITING"],
	order: ["DONE", "OK"],
	poke: ["DONE", "QUEUED", "WAITING"],
};

const STATE_BY_NAME = new Map(TURN_STATES.map((s) => [s.name, s]));

function formOf(name: TurnStateName): string {
	return STATE_BY_NAME.get(name)?.form ?? name;
}

/** The incoming note's sentences for a turn of this kind: replace "write nothing for him ... end the turn
 *  without a summary" (quiet-turns, AGENTS.md rule 18) with the status line and the states it allows.
 *  Semicolons between the states: a detail has a comma of its own. */
export function statusHint(kind: TurnStatusKind): string {
	return (
		"The owner doesn't read this turn. Do its work with tools; your only text is one status line, no narration " +
		`or summary, one of: ${STATES_FOR[kind].map(formOf).join("; ")}. Several messages in the turn: one line ` +
		'each, "<message id> <STATE>".'
	);
}

/** One parsed status line. */
export interface StatusLine {
	/** The message it is for (a role message's rm-… or a Board order's bp-…), when the line names one. */
	id?: string;
	state: TurnStateName;
	/** QUEUED: the task number; NOT MINE: the role id; WAITING, DECLINED: the words. */
	detail?: string;
}

const MESSAGE_ID = /^((?:rm|bp)-[0-9a-f]{8}) /;
const ROLE_ID = /^[a-z0-9][a-z0-9._-]*$/;
// Longest names first, so "NOT MINE" isn't read as something shorter.
const NAMES = [...TURN_STATES].sort((a, b) => b.name.length - a.name.length);

/** One line as a status line, or null. A trailing period is let through; nothing else around it is. */
export function statusLineOf(line: string): StatusLine | null {
	let rest = line.trim();
	let id: string | undefined;
	const m = MESSAGE_ID.exec(rest);
	if (m) {
		id = m[1];
		rest = rest.slice(m[0].length).trimStart();
	}
	if (rest.endsWith(".")) rest = rest.slice(0, -1).trimEnd();
	for (const s of NAMES) {
		if (!rest.startsWith(s.name)) continue;
		const tail = rest.slice(s.name.length);
		const detail = detailOf(s, tail);
		if (detail === null) return null;
		return { ...(id ? { id } : {}), state: s.name, ...(detail ? { detail } : {}) };
	}
	return null;
}

/** The detail after a state's name ("" for none), or null when it doesn't fit the state. */
function detailOf(s: TurnState, tail: string): string | null {
	switch (s.detail) {
		case "none":
			return tail === "" ? "" : null;
		case "task": {
			const m = /^ #(\d+)$/.exec(tail);
			return m ? m[1] : null;
		}
		case "role": {
			const m = /^: (\S+)$/.exec(tail);
			return m && ROLE_ID.test(m[1]) ? m[1] : null;
		}
		case "words": {
			if (!tail.startsWith(": ")) return null;
			const words = tail.slice(2).trim().split(/\s+/).filter(Boolean);
			return words.length >= 1 && words.length <= DETAIL_WORDS_MAX ? words.join(" ") : null;
		}
	}
}

/**
 * A turn's whole text as its status lines, or null when it is anything else (empty, prose, a summary, a
 * line that isn't a status). One line may name its message or not; several lines must each name a
 * different message ("<message id> <STATE>[ detail]"). Blank lines and surrounding space don't count.
 */
export function statusLinesOf(text: string): StatusLine[] | null {
	const lines = text
		.split("\n")
		.map((l) => l.trim())
		.filter((l) => l !== "");
	if (lines.length === 0) return null;
	const out: StatusLine[] = [];
	for (const l of lines) {
		const s = statusLineOf(l);
		if (!s) return null;
		out.push(s);
	}
	if (out.length > 1) {
		const ids = out.map((s) => s.id);
		if (ids.some((id) => !id) || new Set(ids).size !== ids.length) return null;
	}
	return out;
}
