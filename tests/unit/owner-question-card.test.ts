/**
 * owner-question-routing (Ops #686, H-OWNER-COO-CARD): the card COO gets for questions held for it.
 * Each question says who asks, its kind and why it came to COO, the question and its choices, the
 * plain brief, when it goes to the owner, the actions, and the package last; several go in one card.
 */
import { describe, expect, it } from "vitest";
import { type Ask, approvalAsk, dialogAsk, questionAsk, stuckAsk } from "../../server/asks.js";
import {
	type CardQuestion,
	cardHandleOf,
	ownerQuestionCardText,
	ownerQuestionWho,
} from "../../server/owner-question-card.js";

// 2026-11-01 09:00 UTC
const T0 = Date.UTC(2026, 10, 1, 9, 0);
const MIN = 60_000;

const held = (ask: Ask, reason: "owner-away" | "queued-work" | "not-started-by-owner" = "owner-away"): Ask => ({
	...ask,
	route: { to: "coo", reason, heldAt: ask.createdAt },
});

const portQuestion = held(
	questionAsk(
		"q-7",
		[
			{
				id: "port",
				question: "Which port should the preview use?",
				detail: "The usual port is taken by the old preview. Moving it means a restart.",
				options: [{ label: "8080", description: "the usual one" }, { label: "8090" }],
			},
		],
		{ conversationId: "c9", conversationTitle: "Fonts work" },
		T0,
	),
);

const portItem = (over: Partial<CardQuestion> = {}): CardQuestion => ({
	handle: "oq-1a2b3c4d",
	ask: portQuestion,
	asker: { role: { id: "design", title: "Design" }, chat: "home" },
	reason: "owner-away",
	lastWroteAgoMs: 45 * MIN,
	goesAt: T0 + 30 * MIN,
	...over,
});

const stuck = held(
	stuckAsk(
		"stuck-12",
		{
			taskId: 12,
			taskTitle: "New fonts",
			question: "Spend about two hundred dollars on the font licence?",
			choices: ["Yes, buy it", "No, keep the free font"],
			detail: "## Goal\nNicer type on the phone page.\n## Cost\nAbout two hundred dollars, once.",
			brief: [
				{ label: "In short", text: "Design wants your yes before it buys a font." },
				{ label: "Cost", text: "About two hundred dollars, once." },
			],
		},
		{ conversationTitle: "Design lead" },
		T0,
	),
	"queued-work",
);

const stuckItem: CardQuestion = {
	handle: "oq-9f8e7d6c",
	ask: stuck,
	asker: { role: { id: "design", title: "Design" }, chat: "task", task: { id: 12, title: "New fonts" } },
	reason: "queued-work",
	goesAt: T0 + 30 * MIN,
};

const card = (items: CardQuestion[]): string => ownerQuestionCardText(items, { tz: "UTC" });

describe("ownerQuestionCardText: one held question", () => {
	const text = card([portItem()]);
	const lines = text.split("\n");

	it("starts with the plain first line: which chat asks, and its tag", () => {
		expect(lines[0]).toBe("[Owner question] from Design's home chat [oq-1a2b3c4d]");
	});

	it("says who asks: role, chat and, for a task, the task", () => {
		expect(text).toContain("Who asks: Design (design) · its home chat “Fonts work”");
		expect(card([stuckItem])).toContain("Who asks: Design (design) · a task chat · task #12 “New fonts”");
	});

	it("gives its kind and why it came to COO first, in the route rule's words", () => {
		expect(text).toContain("Kind: a question (ask_user_question)");
		expect(text).toContain("Why it came to you: the owner started this but hasn't written there for 45 minutes");
		expect(card([portItem({ lastWroteAgoMs: undefined })])).toContain(
			"Why it came to you: the owner started this but it isn't known when he last wrote there",
		);
		expect(card([stuckItem])).toContain("Kind: a queued task's card (queue_stuck)");
		expect(card([stuckItem])).toContain("Why it came to you: a queued task's card");
	});

	it("gives the question and every choice, with its description, and whether a typed answer is allowed", () => {
		expect(text).toContain("Question: Which port should the preview use?");
		expect(text).toContain("  1. 8080 (the usual one)");
		expect(text).toContain("  2. 8090");
		expect(text).toContain("Or a typed answer.");
	});

	it("says when it goes to the owner unless COO acts, at the hour and minute", () => {
		expect(text).toContain("It goes to the owner at 09:30 UTC unless you act.");
		expect(card([portItem({ goesAt: T0 + 95 * MIN })])).toContain("It goes to the owner at 10:35 UTC unless you act.");
	});

	it("lists the actions, with return only for a question", () => {
		expect(text).toContain('owner_question release id "oq-1a2b3c4d"');
		expect(text).toContain('owner_question hold id "oq-1a2b3c4d"');
		expect(text).toContain('owner_question return id "oq-1a2b3c4d"');
		const s = card([stuckItem]);
		expect(s).toContain('owner_question release id "oq-9f8e7d6c"');
		expect(s).not.toContain("owner_question return");
	});

	it("puts the package last in each question, folded as a quote", () => {
		const pkg = text.indexOf("Package:");
		expect(pkg).toBeGreaterThan(text.indexOf("It goes to the owner at"));
		expect(pkg).toBeGreaterThan(text.indexOf("owner_question release"));
		expect(text).toContain("> The usual port is taken by the old preview. Moving it means a restart.");
		const s = card([stuckItem]);
		expect(s).toContain("> ## Goal\n> Nicer type on the phone page.\n> ## Cost\n> About two hundred dollars, once.");
	});

	it("gives #682's brief whole, before the question, when the ask has one", () => {
		const s = card([stuckItem]);
		expect(s).toContain(
			"Brief:\nIn short: Design wants your yes before it buys a font.\nCost: About two hundred dollars, once.",
		);
		expect(s.indexOf("Brief:")).toBeLessThan(s.indexOf("Question:"));
		expect(text).not.toContain("Brief:");
	});

	it("ends with the guidance and the turn-end rule, and never offers COO an answer", () => {
		expect(text).toContain("never answer for him");
		expect(text).toContain("consent, spending, publishing, his pauses and his own stops");
		expect(text).toContain(
			"If this turn ends with one still held and no release, hold or return, it goes to him at once.",
		);
		expect(text).not.toMatch(/owner_question answer|answer it yourself/i);
	});
});

describe("ownerQuestionCardText: the other kinds", () => {
	it("a pop-up: its kind, its body as the package, its choices, no typed answer", () => {
		const ask = held(
			dialogAsk("d-3", { id: 3, kind: "confirm", title: "Run the plan?", args: ["Step one, then step two."] }, {}, T0),
		);
		const text = card([
			{
				handle: "oq-00000001",
				ask,
				asker: { role: { id: "ops", title: "Ops" }, chat: "home" },
				reason: "owner-away",
				goesAt: T0 + 30 * MIN,
			},
		]);
		expect(text).toContain("Kind: a pop-up the chat shows (such as a plan approval)");
		expect(text).toContain("Question: Run the plan?");
		expect(text).toContain("  1. Yes");
		expect(text).toContain("  2. No");
		expect(text).not.toContain("Or a typed answer.");
		expect(text).toContain("> Step one, then step two.");
		expect(text).not.toContain("owner_question return");
	});

	it("a tool approval: its kind and the command as the package", () => {
		const ask = held(
			approvalAsk(
				"a-4",
				{ toolName: "bash", params: { command: "rm -rf build" }, reason: "deletes the build" },
				{},
				T0,
			),
			"not-started-by-owner",
		);
		const text = card([
			{
				handle: "oq-00000002",
				ask,
				asker: { chat: "other", title: "Scratch" },
				reason: "not-started-by-owner",
				goesAt: T0 + 30 * MIN,
			},
		]);
		expect(text.split("\n")[0]).toBe("[Owner question] from the chat “Scratch” [oq-00000002]");
		expect(text).toContain("Who asks: the chat “Scratch”");
		expect(text).toContain("Kind: a tool approval");
		expect(text).toContain("Why it came to you: raised by work the owner didn't start");
		expect(text).toContain("Question: Allow bash? deletes the build");
		expect(text).toContain("> rm -rf build");
	});

	it("dependent questions retain their conditions and every branch of choices", () => {
		const ask = held(
			questionAsk(
				"q-conditional",
				[
					{ id: "host", question: "Which host?", options: [{ label: "Local" }, { label: "Cloud" }] },
					{
						id: "size",
						question: "Which size?",
						dependsOn: { questionId: "host", value: ["Local", "Cloud"] },
						optionsMap: { Local: [{ label: "Small", description: "No charge" }], Cloud: [{ label: "Large" }] },
					},
				],
				{},
				T0,
			),
		);
		const text = card([portItem({ ask })]);
		expect(text).toContain("Question 2 of 2: Which size?");
		expect(text).toContain("Shown when “Which host?” is “Local” or “Cloud”.");
		expect(text).toContain("When “Which host?” is “Local”:\n  1. Small (No charge)");
		expect(text).toContain("When “Which host?” is “Cloud”:\n  1. Large");
	});

	it("several questions in one ask: each with its choices, and whether several may be picked", () => {
		const ask = held(
			questionAsk(
				"q-8",
				[
					{ id: "a", question: "Colour?", options: [{ label: "Red" }, { label: "Blue" }], multiSelect: true },
					{ id: "b", question: "Size?", options: [{ label: "Small" }] },
				],
				{},
				T0,
			),
		);
		const text = card([portItem({ ask, handle: "oq-00000003" })]);
		expect(text).toContain("Question 1 of 2: Colour? (several may be picked)");
		expect(text).toContain("Question 2 of 2: Size?");
		expect(text).not.toContain("Package:");
	});
});

describe("ownerQuestionCardText: several held questions go in one card", () => {
	const text = card([portItem(), stuckItem]);

	it("one first line naming every asker and every tag", () => {
		expect(text.split("\n")[0]).toBe(
			"[Owner question] 2 questions, from Design's home chat; Design's task #12 “New fonts” [oq-1a2b3c4d, oq-9f8e7d6c]",
		);
		expect(text.match(/^\[Owner question\]/gm)).toHaveLength(1);
	});

	it("a block per question, each with its own who, choices, deadline and actions, in order", () => {
		const a = text.indexOf("— oq-1a2b3c4d (1 of 2)");
		const b = text.indexOf("— oq-9f8e7d6c (2 of 2)");
		expect(a).toBeGreaterThan(0);
		expect(b).toBeGreaterThan(a);
		expect(text.match(/^Who asks:/gm)).toHaveLength(2);
		expect(text.match(/^It goes to the owner at/gm)).toHaveLength(2);
		expect(text.match(/owner_question release/g)).toHaveLength(2);
		expect(text.match(/never answer for him/g)).toHaveLength(1);
	});

	it("names at most three askers on the first line", () => {
		const many = [0, 1, 2, 3, 4].map((i) => portItem({ handle: `oq-0000000${i}` }));
		expect(card(many).split("\n")[0]).toMatch(/^\[Owner question\] 5 questions, from .+ and 2 more \[/);
	});
});

describe("card handles and who-words", () => {
	it("a handle is oq- and eight hex characters, the same for the same hold key", () => {
		expect(cardHandleOf("stuck:abc")).toMatch(/^oq-[0-9a-f]{8}$/);
		expect(cardHandleOf("stuck:abc")).toBe(cardHandleOf("stuck:abc"));
		expect(cardHandleOf("stuck:abc")).not.toBe(cardHandleOf("stuck:abd"));
	});
	it("who-words for each kind of asker", () => {
		expect(ownerQuestionWho({ role: { id: "design", title: "Design" }, chat: "home" })).toBe("Design's home chat");
		expect(
			ownerQuestionWho({ role: { id: "design", title: "Design" }, chat: "task", task: { id: 12, title: "New fonts" } }),
		).toBe("Design's task #12 “New fonts”");
		expect(ownerQuestionWho({ role: { id: "ops", title: "Ops" }, chat: "other", title: "Side chat" })).toBe(
			"Ops's chat “Side chat”",
		);
		expect(ownerQuestionWho({ chat: "other", title: "Scratch" })).toBe("the chat “Scratch”");
		expect(ownerQuestionWho({ chat: "other" })).toBe("a chat");
	});
});
