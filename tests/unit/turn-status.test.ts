// turn-status (Ops #688): a turn another role started ends with one status line from a fixed set, and text
// for another agent points to the messaging guidance's dense-text rule. The states and the code check
// (server/turn-status.ts), the incoming notes that name them (role-messages.ts, role-board.ts), and the
// pointer in the messaging tools' text descriptions (board-tool.ts, role-message-tool.ts).
import { describe, expect, it } from "vitest";
import { AI_READER_POINTER, makeBoardTool } from "../../server/board-tool.js";
import { type BoardPostRecord, boardOrderText } from "../../server/role-board.js";
import { makeMessageRoleTool } from "../../server/role-message-tool.js";
import {
	FOR_OWNER_TURN_HINT,
	POKE_HINT,
	STALL_DEAD_END_HINT,
	STALL_HINT,
	STALL_MIXED_HINT,
	STALL_OWNER_HINT,
	roleMessageHint,
} from "../../server/role-messages.js";
import {
	DETAIL_WORDS_MAX,
	STATES_FOR,
	TURN_STATES,
	type TurnStatusKind,
	statusHint,
	statusLinesOf,
} from "../../server/turn-status.js";

type Parts = Parameters<typeof roleMessageHint>[0];
const from = { role: "coo", title: "COO", chat: "home chat", file: "coo-home.jsonl" };
const base = { id: "rm-0123abcd", from, text: "x" } as const;
const words = (n: number) => Array.from({ length: n }, (_, i) => `w${i}`).join(" ");

describe("turn-status: the states", () => {
	it("are the eight the owner's states were given as, in order, with their detail forms", () => {
		expect(TURN_STATES.map((s) => s.form)).toEqual([
			"OK",
			"DONE",
			"ANSWERED",
			"QUEUED #N",
			"NOT MINE: <role id>",
			"NEEDS OWNER",
			"WAITING: <what, up to 8 words>",
			"DECLINED: <why, up to 8 words>",
		]);
		expect(DETAIL_WORDS_MAX).toBe(8);
	});

	it("each kind allows only its own states", () => {
		expect(STATES_FOR).toEqual({
			question: ["ANSWERED", "NOT MINE", "NEEDS OWNER", "WAITING", "DECLINED"],
			request: ["DONE", "QUEUED", "NOT MINE", "NEEDS OWNER", "WAITING", "DECLINED"],
			reply: ["OK", "DONE", "QUEUED", "WAITING"],
			order: ["DONE", "OK"],
			poke: ["DONE", "QUEUED", "WAITING"],
		});
	});
});

describe("turn-status: statusLinesOf, the code check of a turn's text", () => {
	it("takes one status line, with or without its message's id, details where the state has one", () => {
		expect(statusLinesOf("OK")).toEqual([{ state: "OK" }]);
		expect(statusLinesOf("DONE")).toEqual([{ state: "DONE" }]);
		expect(statusLinesOf("DONE.")).toEqual([{ state: "DONE" }]);
		expect(statusLinesOf("\n  ANSWERED  \n\n")).toEqual([{ state: "ANSWERED" }]);
		expect(statusLinesOf("QUEUED #12")).toEqual([{ state: "QUEUED", detail: "12" }]);
		expect(statusLinesOf("NOT MINE: temper")).toEqual([{ state: "NOT MINE", detail: "temper" }]);
		expect(statusLinesOf("NEEDS OWNER")).toEqual([{ state: "NEEDS OWNER" }]);
		expect(statusLinesOf("WAITING: temper #38 to land")).toEqual([{ state: "WAITING", detail: "temper #38 to land" }]);
		expect(statusLinesOf(`DECLINED: ${words(8)}`)).toEqual([{ state: "DECLINED", detail: words(8) }]);
		expect(statusLinesOf("rm-0123abcd DONE")).toEqual([{ id: "rm-0123abcd", state: "DONE" }]);
		expect(statusLinesOf("bp-00c0ffee OK")).toEqual([{ id: "bp-00c0ffee", state: "OK" }]);
	});

	it("takes several lines when each names a different message", () => {
		expect(statusLinesOf("rm-0123abcd ANSWERED\nrm-89abcdef QUEUED #7\nbp-00c0ffee DONE")).toEqual([
			{ id: "rm-0123abcd", state: "ANSWERED" },
			{ id: "rm-89abcdef", state: "QUEUED", detail: "7" },
			{ id: "bp-00c0ffee", state: "DONE" },
		]);
	});

	it("refuses missing or wrong details", () => {
		for (const t of [
			"QUEUED",
			"QUEUED #",
			"QUEUED 12",
			"QUEUED #12 and replied",
			"NOT MINE",
			"NOT MINE:",
			"NOT MINE: Temper team",
			"WAITING",
			"WAITING:",
			`WAITING: ${words(DETAIL_WORDS_MAX + 1)}`,
			"DECLINED",
			`DECLINED: ${words(DETAIL_WORDS_MAX + 1)}`,
			"OK: nothing to do",
			"ANSWERED #3",
		]) {
			expect(statusLinesOf(t), t).toBeNull();
		}
	});

	it("refuses prose, summaries and anything around the status", () => {
		for (const t of [
			"",
			"  \n ",
			"Done",
			"done",
			"**DONE**",
			"- DONE",
			"DONE. Replied to COO with the numbers.",
			"DONE\nReplied to COO with the numbers.",
			"Replied to COO with the numbers.\nDONE",
			"OK, nothing for me to do here.",
			"Summary: I answered the question about the deploy and queued the follow-up as #12.",
			"rm-0123abcd: DONE",
		]) {
			expect(statusLinesOf(t), JSON.stringify(t)).toBeNull();
		}
	});

	it("refuses several lines unless each names a different message", () => {
		expect(statusLinesOf("DONE\nOK")).toBeNull();
		expect(statusLinesOf("rm-0123abcd DONE\nOK")).toBeNull();
		expect(statusLinesOf("rm-0123abcd DONE\nrm-0123abcd OK")).toBeNull();
	});

	it("an owner-answer turn's full answer isn't a status line (he reads those in full; the check counts it as text)", () => {
		const answer =
			"Temper's answer to your question: the run finished at 14:02 and passed every check.\n\nNext: it lands tonight; nothing for you to do.";
		expect(statusLinesOf(answer)).toBeNull();
	});
});

describe("turn-status: statusHint, the incoming note's sentence for each kind", () => {
	const listed = (kind: TurnStatusKind) => {
		const m = /one of: (.*?)\. Several messages/.exec(statusHint(kind));
		return m ? m[1]!.split("; ") : [];
	};
	it("names exactly the states the kind allows, in their written form", () => {
		expect(listed("question")).toEqual([
			"ANSWERED",
			"NOT MINE: <role id>",
			"NEEDS OWNER",
			"WAITING: <what, up to 8 words>",
			"DECLINED: <why, up to 8 words>",
		]);
		expect(listed("request")).toEqual([
			"DONE",
			"QUEUED #N",
			"NOT MINE: <role id>",
			"NEEDS OWNER",
			"WAITING: <what, up to 8 words>",
			"DECLINED: <why, up to 8 words>",
		]);
		expect(listed("reply")).toEqual(["OK", "DONE", "QUEUED #N", "WAITING: <what, up to 8 words>"]);
		expect(listed("order")).toEqual(["DONE", "OK"]);
		expect(listed("poke")).toEqual(["DONE", "QUEUED #N", "WAITING: <what, up to 8 words>"]);
	});

	it("says the owner doesn't read the turn, tools do the work, the status is the only text, and the several-messages form", () => {
		for (const kind of Object.keys(STATES_FOR) as TurnStatusKind[]) {
			const h = statusHint(kind);
			expect(
				h.startsWith("The owner doesn't read this turn. Do its work with tools; your only text is one status line"),
			).toBe(true);
			expect(h).toContain("no narration or summary");
			expect(h.endsWith('Several messages in the turn: one line each, "<message id> <STATE>".')).toBe(true);
		}
	});

	it("every form a note names passes the code check once its detail is filled in", () => {
		const filled = (form: string) =>
			form
				.replace("#N", "#12")
				.replace("<role id>", "temper")
				.replace(/<(what|why), up to 8 words>/, "temper #38 to land");
		for (const kind of Object.keys(STATES_FOR) as TurnStatusKind[]) {
			for (const form of listed(kind)) {
				expect(statusLinesOf(filled(form)), `${kind}: ${form}`).not.toBeNull();
				expect(statusLinesOf(`rm-0123abcd ${filled(form)}`), `${kind}: ${form} with an id`).not.toBeNull();
			}
		}
	});
});

describe("turn-status: the incoming notes", () => {
	const once = (text: string, part: string) => text.split(part).length - 1;
	it("a role's question, request and reply name their kind's states once", () => {
		for (const kind of ["question", "request", "reply"] as const) {
			const hint = roleMessageHint({ ...base, kind, replyTo: "rm-89abcdef" } as Parts);
			expect(once(hint, statusHint(kind)), kind).toBe(1);
			expect(hint).not.toContain("without a summary");
		}
	});

	it("a Board order's turn names DONE and OK", () => {
		const post: BoardPostRecord = {
			id: "bp-00c0ffee",
			seq: 1,
			at: Date.parse("2026-10-31T19:40:00Z"),
			from: "owner",
			via: "coo",
			kind: "order",
			to: ["ops"],
			title: "Status lines",
			text: "One line per turn.",
		};
		expect(once(boardOrderText(post, "UTC"), statusHint("order"))).toBe(1);
		// steered into a running turn (maybe the owner's own): no status line asked
		expect(boardOrderText(post, "UTC", "steer")).not.toContain("status line");
	});

	it("work-check and Initiatives pokes name DONE, QUEUED #N and WAITING once", () => {
		for (const h of [POKE_HINT, STALL_HINT, STALL_DEAD_END_HINT, STALL_MIXED_HINT]) {
			expect(once(h, statusHint("poke")), h).toBe(1);
			expect(h).not.toContain("Write nothing for the owner in this chat");
		}
		const poke = roleMessageHint({
			...base,
			kind: "report",
			from: { role: "app", title: "the Initiatives page", chat: "Initiatives page", file: "" },
			poke: { initiative: "team-in-temper", name: "Team in Temper", why: ["button"] },
		} as Parts);
		expect(poke).toBe(POKE_HINT);
		expect(POKE_HINT).toContain("Post it with initiative_update, not message_role.");
	});

	it("leaves alone what the owner reads, the FYI note, the 6 am report and the owner's step", () => {
		const forHim = roleMessageHint({ ...base, kind: "reply", replyTo: "rm-89abcdef" } as Parts, { ownerAnswer: true });
		expect(forHim).toBe(`(The answer to your message rm-89abcdef: no need to answer it. ${FOR_OWNER_TURN_HINT})`);
		for (const h of [
			forHim,
			roleMessageHint({ ...base, kind: "fyi" } as Parts),
			roleMessageHint({ ...base, kind: "report" } as Parts),
			STALL_OWNER_HINT,
		]) {
			expect(h).not.toContain("status line");
		}
	});
});

describe("compact agent text (Ops #688 part 2): the pointer in the messaging tools' text descriptions", () => {
	type Props = Record<string, { description?: string }>;
	const propsOf = (tool: { parameters: unknown }) => (tool.parameters as { properties: Props }).properties;
	it("message_role's and the board's text end with the pointer to the messaging guidance", () => {
		expect(AI_READER_POINTER).toBe("For an AI reader: compact; see the messaging guidance.");
		const message = propsOf(makeMessageRoleTool({ sender: () => "no role", service: () => undefined }));
		expect(message.text?.description?.endsWith(` ${AI_READER_POINTER}`)).toBe(true);
		const board = propsOf(makeBoardTool({ sender: () => "no role", service: () => undefined }));
		expect(board.text?.description?.endsWith(` ${AI_READER_POINTER}`)).toBe(true);
		// only there: the owner's words on an order are quoted as he gave them
		expect(board.ownerWords?.description).not.toContain(AI_READER_POINTER);
		for (const [name, p] of [...Object.entries(message), ...Object.entries(board)]) {
			if (name !== "text") expect(p.description ?? "", name).not.toContain(AI_READER_POINTER);
		}
	});
});
