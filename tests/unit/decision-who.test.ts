/**
 * decision-who (task #84, Data rm-3bbf8e94 conditions 1-3): who decided, as two facts (writer, approval
 * kind) worked out from the record's metadata; "you" only where one of the owner's own records holds
 * the point word for word. The records here are made up, in the shapes of the seven credit conflicts in
 * Data's events.csv (E01 E02 E03 E07 E20 E21 E60) and a few more cases.
 */
import { describe, expect, it } from "vitest";
import type { DecisionRecord } from "../../server/decision-records.js";
import { entryWho, quoteIn, textClaimsOwner, whoOf, wordingClaimsOwner } from "../../server/decision-who.js";

const base = { v: 1 as const, at: Date.parse("2026-10-03T22:40:00-07:00"), how: "live" as const, seen: 0 };

/** E01 / E13: the owner picks "Two tasks (recommended)"; Temper's one-at-a-time turns ride inside it. */
const slices: DecisionRecord = {
	...base,
	id: "dr-slices",
	source: "answer",
	from: "owner",
	to: "temper",
	ref: "ask:toolu_slices",
	ask: "question",
	chat: "temper",
	questions: [
		{
			id: "round",
			question: "How should a round work?",
			options: [
				{
					label: "Review rounds (recommended)",
					description: "The leader asks for a review and the others each give a view.",
				},
				{ label: "Every leader turn counts", description: "Simpler, but pauses come at odd moments." },
			],
			picked: ["Review rounds (recommended)"],
		},
		{
			id: "slice",
			question: "How should the first slice be built?",
			options: [
				{
					label: "Two tasks (recommended)",
					description:
						"A: messages and inboxes. B: the leader loop, then the live test. Members take turns one at a time at first.",
				},
				{ label: "One task", description: "Same work as a single queue task." },
			],
			picked: ["Two tasks (recommended)"],
		},
	],
};

const plan = (over: Partial<DecisionRecord> & { plan: DecisionRecord["plan"] }): DecisionRecord => ({
	...base,
	id: "dr-plan",
	source: "plan",
	from: "temper",
	ref: "chat.jsonl:10",
	chat: "temper",
	task: 37,
	op: "add",
	approval: "auto",
	...over,
});

describe("quotes word for word", () => {
	it("ignores case, spacing, curly quotes, dashes and markdown, and skips words at '...'", () => {
		expect(quoteIn("the owner\u2019s   **decisions**", "These are the Owner's decisions.")).toBe(true);
		expect(
			quoteIn(
				"tailnet-only, with appropriate access controls",
				"Keep it tailnet\u2013only, with appropriate access controls.",
			),
		).toBe(true);
		expect(quoteIn("Members take turns ... at first", "Members take turns one at a time at first.")).toBe(true);
		expect(quoteIn("at first ... Members take turns", "Members take turns one at a time at first.")).toBe(false);
		expect(quoteIn("Members take turns at first", "Members take turns one at a time at first.")).toBe(false);
	});
});

describe("dialog answers", () => {
	it("E13: the option's main choice is his pick: writer you, 'your pick in a dialog'", () => {
		const w = whoOf(slices, { quotes: ["Review rounds (recommended)"], part: "main" });
		expect(w).toMatchObject({ writer: "owner", approval: "dialog-pick", you: true, flags: [] });
		expect(w.places).toEqual(["label"]);
	});

	it("E01: a rider inside the option he picked is the asking role's choice, flagged, not you", () => {
		const w = whoOf(slices, { quotes: ["Members take turns one at a time at first"], part: "rider" });
		expect(w).toMatchObject({ writer: "temper", approval: "dialog-pick", role: "temper", you: false });
		expect(w.flags).toEqual(["rider"]);
		expect(w.places).toEqual(["description"]);
		// Without the reader's rider mark the quote sits in his pick, so the mark is what takes "you" away.
		expect(whoOf(slices, { quotes: ["Members take turns one at a time at first"] }).you).toBe(true);
	});

	it("a quote not found word for word is never you", () => {
		const w = whoOf(slices, { quotes: ["Members take turns at first"], part: "main" });
		expect(w.you).toBe(false);
		expect(w.flags).toContain("quote-not-found");
		expect(w.approval).toBe("dialog-question");
	});

	it("a point only in an option he didn't pick, or only in the question, is the role's (E90 shape)", () => {
		expect(whoOf(slices, { quotes: ["Same work as a single queue task"] })).toMatchObject({
			you: false,
			approval: "dialog-question",
			writer: "temper",
		});
		expect(whoOf(slices, { quotes: ["How should the first slice be built"] })).toMatchObject({
			you: false,
			approval: "dialog-question",
		});
	});

	it("what he typed is his", () => {
		const typed: DecisionRecord = {
			...slices,
			questions: [
				{
					id: "q",
					question: "When should the team pause?",
					options: [{ label: "Every N minutes" }],
					picked: [],
					typed: "if spend reads $100, pause; just don't start new turns",
				},
			],
		};
		expect(whoOf(typed, { quotes: ["if spend reads $100, pause"] })).toMatchObject({
			writer: "owner",
			you: true,
			places: ["typed"],
		});
	});

	it("an option's preview is his pick too", () => {
		const withPreview: DecisionRecord = {
			...slices,
			questions: [
				{
					id: "q",
					question: "Which layout?",
					options: [{ label: "Cards", preview: "Each decision is a card, newest first." }, { label: "Table" }],
					picked: ["Cards"],
				},
			],
		};
		expect(whoOf(withPreview, { quotes: ["Each decision is a card, newest first"] })).toMatchObject({
			you: true,
			places: ["preview"],
		});
	});

	it("'Go ahead' on a question that proposes a plan: '<role> proposed, you approved', which counts as you", () => {
		const ask = (picked: string): DecisionRecord => ({
			...slices,
			to: "coo",
			chat: "coo",
			questions: [
				{
					id: "go",
					question:
						"Go ahead with Temper's free-flowing plan? No rounds: a member starts work as soon as it has something to do.",
					options: [{ label: "Go ahead" }, { label: "Wait for the retro" }],
					picked: [picked],
				},
			],
		});
		expect(whoOf(ask("Go ahead"), { quotes: ["No rounds"] })).toMatchObject({
			writer: "coo",
			approval: "dialog-plan",
			role: "coo",
			you: true,
		});
		expect(whoOf(ask("Wait for the retro"), { quotes: ["No rounds"] })).toMatchObject({
			approval: "dialog-question",
			you: false,
		});
		// The reader may mark a point of the proposal a "rider"; he approved the whole proposal, so it is
		// still his (the rider mark is about a choice riding inside the option he picked).
		expect(
			whoOf(ask("Go ahead"), { quotes: ["a member starts work as soon as it has something to do"], part: "rider" }),
		).toMatchObject({
			approval: "dialog-plan",
			you: true,
			flags: [],
		});
	});
});

describe("plans", () => {
	it("E02: an auto-approved plan listing a role's choice under the owner's name is flagged, never you", () => {
		const rec = plan({
			plan: {
				title: "Team messages and inboxes",
				decided:
					"Owner (temper chat, 2026-10-03 ~22:50 PDT): build the team runtime as two tasks, this one first. In the first slice members take turns one at a time.\n\nFrom the brief:\n- Everything stays switched off.",
			},
		});
		const w = whoOf(rec, { quotes: ["members take turns one at a time"] });
		expect(w).toMatchObject({ writer: "temper", approval: "auto-plan", you: false });
		expect(w.flags).toEqual(["claims-owner"]);
		// A point in the same field that isn't given as his isn't flagged.
		expect(whoOf(rec, { quotes: ["Everything stays switched off"] }).flags).toEqual([]);
	});

	it("E03/E21: a point under a list head saying 'the owner's decisions' is flagged; the list's other items aren't", () => {
		const rec = plan({
			from: "architecture",
			chat: "architecture",
			op: "update",
			plan: {
				doneWhen:
					"- #37 and #38 landed switched off.\n- **The runtime rules tested are the owner's decisions with the temper chat** (2026-10-03, build plan):\n  - round: the leader calls a review.\n  - turns: members take turns one at a time.\n- The report is written.",
			},
		});
		expect(whoOf(rec, { quotes: ["members take turns one at a time"] }).flags).toEqual(["claims-owner"]);
		expect(whoOf(rec, { quotes: ["landed switched off"] }).flags).toEqual([]);
		expect(whoOf(rec, { quotes: ["The report is written"] }).flags).toEqual([]);
	});

	it("E20: a section spelling out a choice the plan credits to him is flagged; sections on other topics aren't", () => {
		const rec = plan({
			task: 38,
			plan: {
				decided:
					"Owner (temper chat) chose review rounds and done only on a reviewed version.\n\nA round:\n- The leader asks for a review. Temper pins the version: it commits the leader's copy and moves each reviewer's copy to that commit.\n\nPause:\n- After X keep-goings in a row, the same run pauses.\n\nRun view: shows messages, review requests and views.",
			},
		});
		const q = ["it commits the leader's copy and moves each reviewer's copy to that commit"];
		// "A round:" spells out "review rounds", which the plan says he chose: flagged by the code alone.
		expect(whoOf(rec, { quotes: q })).toMatchObject({ you: false, flags: ["claims-owner"], approval: "auto-plan" });
		expect(whoOf(rec, { quotes: q, claimsOwner: true })).toMatchObject({
			you: false,
			flags: ["claims-owner"],
			approval: "auto-plan",
		});
		// "Pause:" is not one of the things credited to him, and "Run view:" is a plain line, not a list under a head.
		expect(whoOf(rec, { quotes: ["the same run pauses"] }).flags).toEqual([]);
		expect(whoOf(rec, { quotes: ["shows messages, review requests and views"] }).flags).toEqual([]);
		// Without the sentence crediting him, the same section isn't flagged.
		const plain = plan({
			task: 38,
			plan: { decided: (rec.plan?.decided ?? "").replace("Owner (temper chat) chose", "Temper builds") },
		});
		expect(whoOf(plain, { quotes: q }).flags).toEqual([]);
	});

	it("a plan he approved in a dialog: '<role> proposed, you approved'", () => {
		const rec = plan({
			from: "ops",
			chat: "ops",
			approval: "dialog",
			plan: { title: "Initiatives page", decided: "Cards newest first; two who labels." },
		});
		expect(whoOf(rec, { quotes: ["two who labels"] })).toMatchObject({
			writer: "ops",
			approval: "dialog-plan",
			role: "ops",
			you: true,
		});
		expect(whoOf(rec, { quotes: ["three who labels"] })).toMatchObject({ you: false, flags: ["quote-not-found"] });
		// The same plan auto-approved is not his.
		expect(whoOf({ ...rec, approval: "auto" }, { quotes: ["two who labels"] }).you).toBe(false);
	});

	it("a queued task's done note is the role's report", () => {
		const rec = plan({ op: "done", summary: "Landed; turns stay one at a time.", plan: undefined });
		expect(whoOf(rec, { quotes: ["turns stay one at a time"] })).toMatchObject({
			writer: "temper",
			approval: "task-report",
			you: false,
		});
	});
});

describe("Board orders: his words and the relayer's text", () => {
	const order: DecisionRecord = {
		...base,
		id: "dr-order",
		source: "board",
		from: "owner",
		to: ["ops", "temper"],
		ref: "bp-order",
		kind: "order",
		title: "Make the test dashboard reachable over Tailscale",
		text: "Coordinate Ops' Standee work with Temper. Keep it tailnet-only, with appropriate access controls\u2014not public Internet exposure.",
		ownerWords:
			'Owner in COO\'s chat, 2026-10-07: "make it available over tailscale, use standee to give it a dns i can resolve to"',
		via: "coo",
	};

	it("a point in his words is his order", () => {
		expect(whoOf(order, { quotes: ["make it available over tailscale"] })).toMatchObject({
			writer: "owner",
			approval: "order",
			relayer: "coo",
			you: true,
			flags: [],
			places: ["owner-words"],
		});
	});

	it("E60: a point only in the relayer's text: written by the relayer, flagged 'a role says you decided'", () => {
		expect(whoOf(order, { quotes: ["tailnet-only, with appropriate access controls"] })).toMatchObject({
			writer: "coo",
			approval: "order",
			relayer: "coo",
			you: false,
			flags: ["claims-owner"],
			places: ["relayer-text"],
		});
	});

	it("a point quoted partly from his words and partly from the relayer's text isn't his: flagged", () => {
		expect(
			whoOf(order, { quotes: ["make it available over tailscale", "with appropriate access controls"] }),
		).toMatchObject({
			writer: "coo",
			you: false,
			flags: ["claims-owner"],
			places: ["owner-words", "relayer-text"],
		});
	});
});

describe("messages and Board news", () => {
	it("a role's message saying he decided is flagged, never you", () => {
		const msg: DecisionRecord = {
			...base,
			id: "dr-msg",
			source: "message",
			from: "coo",
			to: "architecture",
			ref: "rm-1",
			kind: "fyi",
			text: "The owner decided to keep the subscription route for the box. Nothing else changes.",
		};
		expect(whoOf(msg, { quotes: ["keep the subscription route"] })).toMatchObject({
			writer: "coo",
			approval: "message",
			you: false,
			flags: ["claims-owner"],
		});
		expect(whoOf(msg, { quotes: ["Nothing else changes"] }).flags).toEqual([]);
	});

	it("E07: a post that says it records his decision flags every point in it, without the reader's mark", () => {
		const news: DecisionRecord = {
			...base,
			id: "dr-news",
			source: "board",
			from: "architecture",
			to: ["all"],
			ref: "bp-news",
			kind: "news",
			title: "Frozen first trial",
			text: "This is a record of his decision.\n\nOne watched team, serial turns, one scratch project.",
		};
		expect(whoOf(news, { quotes: ["serial turns"] })).toMatchObject({
			writer: "architecture",
			approval: "board-news",
			you: false,
			flags: ["claims-owner"],
		});
		// The same post without that sentence: nothing flags it unless the reader marks it.
		const plain = { ...news, text: news.text!.replace("This is a record of his decision.", "Frozen today.") };
		expect(whoOf(plain, { quotes: ["serial turns"] }).flags).toEqual([]);
		expect(whoOf(plain, { quotes: ["serial turns"], claimsOwner: true }).flags).toEqual(["claims-owner"]);
	});

	it("a role's own entry is the role's, and its claim is flagged", () => {
		expect(whoOf(undefined, { quotes: [], by: "role:temper" })).toMatchObject({
			writer: "temper",
			approval: "role-entry",
			you: false,
			flags: [],
		});
		expect(whoOf(undefined, { quotes: [], by: "role:temper", claimsOwner: true }).flags).toEqual(["claims-owner"]);
		expect(textClaimsOwner("The owner chose serial turns")).toBe(true);
		expect(textClaimsOwner("Serial turns for the first trial")).toBe(false);
	});

	it("wording checks look at the point's own sentence", () => {
		expect(wordingClaimsOwner("We ship on Friday. The owner asked for a review first.", ["ship on Friday"])).toBe(
			false,
		);
		expect(wordingClaimsOwner("We ship on Friday, as the owner asked for.", ["ship on Friday"])).toBe(true);
	});
});

describe("an entry with several sources", () => {
	const you = { writer: "owner", approval: "dialog-pick" as const, you: true, flags: [], places: [] };
	const claim = { writer: "coo", approval: "order" as const, you: false, flags: ["claims-owner" as const], places: [] };
	const rider = {
		writer: "temper",
		approval: "dialog-pick" as const,
		you: false,
		flags: ["rider" as const],
		places: [],
	};

	it("one of his own records backs it: you, and a role's claim that he decided is no longer flagged", () => {
		expect(
			entryWho([
				{ who: claim, at: 1 },
				{ who: you, at: 2 },
			]),
		).toEqual({ head: 1, you: true, flags: [] });
	});

	it("only roles' claims: flagged, not you; the head is the earliest source", () => {
		expect(
			entryWho([
				{ who: claim, at: 5 },
				{ who: rider, at: 2 },
			]),
		).toEqual({ head: 1, you: false, flags: ["rider", "claims-owner"] });
	});
});
