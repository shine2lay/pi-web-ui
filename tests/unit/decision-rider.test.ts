/**
 * decision-rider (Ops #98, Data's second ruling rm-8cb70820): the rider check labels the passages of the
 * options he picked "main" or "rider"; code gives each point its part from the passages its quotes cover.
 * The dialog here is made up, in the shape of Data's E01 / E13 (one dialog: his pick of "Review rounds",
 * and Temper's one-at-a-time turns riding inside the "Two tasks" option he picked).
 */
import { describe, expect, it } from "vitest";
import {
	needsRiderCheck,
	PREVIEW_MAX,
	parseRiderAnswer,
	partFromLabels,
	passagesOf,
	type RiderPart,
	riderPassagesOf,
	riderPrompt,
} from "../../server/decision-rider.js";
import type { DecisionRecord } from "../../server/decision-records.js";

const base = { v: 1 as const, at: Date.parse("2026-10-03T22:40:00-07:00"), how: "live" as const, seen: 0 };

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

const labels = (o: Record<string, RiderPart>) => new Map(Object.entries(o));
/** P1 = round's description; P2-P4 = the slice option's three sentences; P4 is the rider. */
const E01 = labels({ P1: "main", P2: "main", P3: "main", P4: "rider" });

describe("passages", () => {
	it("cuts a text at sentence ends, at '; ' and at lines, keeping where each stands", () => {
		const text = "A: one. B: two; then three.\nLast line";
		const ps = passagesOf(text).map((p) => text.slice(p.start, p.end));
		expect(ps).toEqual(["A: one.", "B: two", "then three.", "Last line"]);
		expect(passagesOf("")).toEqual([]);
		// No cut inside "e.g." style abbreviations without a following space, or inside numbers.
		expect(passagesOf("Version 1.2 is out").length).toBe(1);
	});

	it("numbers the passages of the options he picked only, description then preview", () => {
		const ps = riderPassagesOf(slices);
		expect(ps.map((p) => p.id)).toEqual(["P1", "P2", "P3", "P4"]);
		expect(ps.map((p) => [p.question, p.option, p.field])).toEqual([
			[0, "Review rounds (recommended)", "description"],
			[1, "Two tasks (recommended)", "description"],
			[1, "Two tasks (recommended)", "description"],
			[1, "Two tasks (recommended)", "description"],
		]);
		const withPreview: DecisionRecord = {
			...slices,
			questions: [
				{
					id: "q",
					question: "Which layout?",
					options: [
						{
							label: "Cards",
							description: "Newest first.",
							preview: `Each decision is a card. ${"x".repeat(PREVIEW_MAX)}`,
						},
						{ label: "Table", description: "Dense." },
					],
					picked: ["Cards"],
				},
			],
		};
		const pv = riderPassagesOf(withPreview);
		expect(pv.map((p) => p.field)).toEqual(["description", "preview", "preview"]);
		// A long preview is labelled on its first part only.
		expect(Math.max(...pv.map((p) => p.end))).toBeLessThanOrEqual(PREVIEW_MAX);
		// Not a dialog answer, or nothing picked with a text: nothing to check.
		expect(riderPassagesOf({ ...slices, source: "message", text: "x" } as DecisionRecord)).toEqual([]);
		expect(
			riderPassagesOf({
				...slices,
				questions: [{ id: "q", question: "Go?", options: [{ label: "Go" }, { label: "Wait" }], picked: ["Go"] }],
			}),
		).toEqual([]);
	});

	it("shows the check each question, every option and the picked options' numbered passages", () => {
		const p = riderPrompt(slices);
		expect(p).toContain("Question 2: How should the first slice be built?");
		expect(p).toContain('- Option "One task" (not picked): Same work as a single queue task.');
		expect(p).toContain('- Option "Two tasks (recommended)" (HE PICKED THIS)');
		expect(p).toContain("[P4] Members take turns one at a time at first.");
		expect(p).toContain("Label all 4 passages (P1, P2, P3, P4).");
	});
});

describe("the check's answer", () => {
	it("needs a main or rider label for every passage", () => {
		const ids = ["P1", "P2"];
		expect(parseRiderAnswer('{"labels":{"P1":"main","P2":"Rider"}}', ids)).toEqual(
			new Map([
				["P1", "main"],
				["P2", "rider"],
			]),
		);
		expect(parseRiderAnswer('Here: {"labels":{"P1":"main","P2":"main"}} done', ids)?.get("P2")).toBe("main");
		expect(parseRiderAnswer('{"labels":{"P1":"main"}}', ids)).toBeUndefined();
		expect(parseRiderAnswer('{"labels":{"P1":"main","P2":"maybe"}}', ids)).toBeUndefined();
		expect(parseRiderAnswer("main, rider", ids)).toBeUndefined();
		expect(parseRiderAnswer("{not json}", ids)).toBeUndefined();
	});
});

describe("a point's part, from the labels", () => {
	it("E01: words in a rider passage are a rider; E13: his label is judged by no one", () => {
		expect(partFromLabels(slices, ["Members take turns one at a time at first"], E01)).toBe("rider");
		// His label alone: nothing for the check to judge.
		expect(partFromLabels(slices, ["Review rounds (recommended)"], E01)).toBeUndefined();
		// The option's main passage: main.
		expect(partFromLabels(slices, ["The leader asks for a review"], E01)).toBe("main");
		// "Label: description", as quotes often give a pick: the description's words decide.
		expect(partFromLabels(slices, ["Two tasks (recommended): A: messages and inboxes"], E01)).toBe("main");
		// Words from an option he didn't pick or from the question aren't judged here.
		expect(partFromLabels(slices, ["Same work as a single queue task"], E01)).toBeUndefined();
	});

	it("counts a quote a rider when at least half its words are in rider passages", () => {
		// 3 words in P3 (main), 9 in P4 (rider).
		expect(partFromLabels(slices, ["the live test. Members take turns one at a time at first"], E01)).toBe("rider");
		// 8 words in P3 (main) against 3 in P4: main.
		expect(partFromLabels(slices, ["B: the leader loop, then the live test. Members take turns"], E01)).toBe("main");
		// "..." skips words; each part is found in order.
		expect(partFromLabels(slices, ["Members take turns ... at first"], E01)).toBe("rider");
		// Any quote of the point that is a rider makes the point a rider.
		expect(partFromLabels(slices, ["The leader asks for a review", "one at a time at first"], E01)).toBe("rider");
	});

	it("a passage that restates his question is his choice, never a rider", () => {
		const restating: DecisionRecord = {
			...slices,
			questions: [
				{
					id: "who",
					question: "Who reviews the first slice before it lands?",
					options: [
						{
							label: "Architecture (recommended)",
							description: "Architecture reviews the first slice before it lands. Members take turns one at a time.",
						},
						{ label: "QA", description: "QA reviews it." },
					],
					picked: ["Architecture (recommended)"],
				},
			],
		};
		const all = labels({ P1: "rider", P2: "rider" });
		expect(partFromLabels(restating, ["Architecture reviews the first slice before it lands"], all)).toBeUndefined();
		expect(partFromLabels(restating, ["Members take turns one at a time"], all)).toBe("rider");
		expect(needsRiderCheck(restating, [["Architecture reviews the first slice before it lands"]])).toBe(false);
	});

	it("asks the check only for points quoting a picked option's own text", () => {
		expect(needsRiderCheck(slices, [["Review rounds (recommended)"]])).toBe(false);
		expect(needsRiderCheck(slices, [["Review rounds (recommended)"], ["Members take turns one at a time"]])).toBe(true);
		expect(needsRiderCheck(slices, [["Same work as a single queue task"]])).toBe(false);
		expect(
			needsRiderCheck({ ...slices, source: "message", text: "Members take turns" } as DecisionRecord, [
				["Members take turns"],
			]),
		).toBe(false);
	});
});
