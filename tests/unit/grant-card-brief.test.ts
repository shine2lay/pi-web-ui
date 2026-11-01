/**
 * grant-card-brief (Ops #683; owner via COO rm-d2c1f9b2): a continuation-grant card that reaches the owner opens
 * with a plain brief built from the stored request alone: who asks and to whom, what for, why it needs more
 * messages, what happens next if allowed, and what each answer does. At most BRIEF_MAX characters, no ids or paths.
 * Display only: the owner question (its id, generation, choices and choicesDigest) and the card's own fields stay
 * as they were. Hypothesis H-OWNER-CARD-GRANT (docs/owner-card-brief.md).
 */
import { describe, expect, it } from "vitest";
import { grantCardBrief, type GrantCardBriefInput } from "../../server/grant-card-brief.js";
import { BRIEF_MAX, briefText, hasIdOrPath } from "../../server/owner-card-brief.js";
import type { UiOwnerCardBriefLine } from "../../server/protocol.js";
import { ask, C, homes, send, useGuardWorld, world } from "./role-message-guard-host-harness.js";

const LABELS = ["Who asks", "What for", "Why more messages", "If you allow it", "Your answers"];
const NOT_SAID = "Not said in plain words.";

const input = (over: Partial<GrantCardBriefInput> = {}): GrantCardBriefInput => ({
	requester: "ops/tooling",
	recipients: ["qa"],
	pastMessage: 11,
	quantity: 5,
	context: {
		goal: "finish the hand-off",
		whyNeeded: "the last part needs one more exchange",
		nextStepAndOutcome: "send the result and stop",
	},
	...over,
});

/** The brief's bar: every line plain, the whole within BRIEF_MAX, its five points in order. */
function expectPlainBrief(lines: UiOwnerCardBriefLine[]) {
	expect(lines.map((l) => l.label)).toEqual(LABELS);
	expect(briefText(lines).length).toBeLessThanOrEqual(BRIEF_MAX);
	for (const l of lines) {
		expect(hasIdOrPath(l.text), l.text).toBe(false);
		expect(l.text.trim().length, l.label).toBeGreaterThan(0);
	}
	const answers = lines[4].text;
	expect(answers).toContain("\u201CDeny\u201D: no more messages in this chain.");
	expect(answers).toContain("\u201CAllow one send\u201D: one more message.");
}

const LONG = (seed: string) =>
	`${seed} ${"and then it carries on with more words about the same thing ".repeat(40)}`.trim();

describe("the grant card's plain brief", () => {
	it("says who asks whom, what for, why, what happens next and what each answer does", () => {
		const lines = grantCardBrief(input());
		expectPlainBrief(lines);
		expect(lines).toEqual([
			{ label: "Who asks", text: "ops/tooling wants to keep messaging qa, past message 11 of one chain of messages." },
			{ label: "What for", text: "finish the hand-off." },
			{ label: "Why more messages", text: "the last part needs one more exchange." },
			{ label: "If you allow it", text: "send the result and stop." },
			{
				label: "Your answers",
				text: "\u201CDeny\u201D: no more messages in this chain. \u201CAllow one send\u201D: one more message. \u201CAllow up to 5 sends\u201D: up to 5 more, for the hour the grant lasts.",
			},
		]);
	});

	it("only the first sentence of each, with ids and paths taken out", () => {
		const lines = grantCardBrief(
			input({
				recipients: ["Product management", "System engineering"],
				quantity: 3,
				context: {
					goal: "Land Ops #683 from /home/shinelay/projects/pi-web-ui-ops-task-683 so grant cards (see server/grant-card-brief.ts) open plainly. Then the rest of rm-d2c1f9b2.",
					whyNeeded:
						"Security's review of commit 5e36933a needs a second exchange to settle one finding. It also asks about docs/owner-card-brief.md.",
					nextStepAndOutcome: "QA checks it under rule 16 and the change goes live. Nothing else changes.",
				},
			}),
		);
		expectPlainBrief(lines);
		expect(lines[0].text).toBe(
			"ops/tooling wants to keep messaging Product management and System engineering, past message 11 of one chain of messages.",
		);
		expect(lines[1].text).toBe("Land Ops from so grant cards open plainly.");
		expect(lines[2].text).toBe("Security's review of commit needs a second exchange to settle one finding.");
		expect(lines[3].text).toBe("QA checks it under and the change goes live.");
		expect(lines[4].text).toContain("\u201CAllow up to 3 sends\u201D: up to 3 more, for the hour the grant lasts.");
	});

	it("a part with no plain sentence says so rather than showing ids or a word", () => {
		const lines = grantCardBrief(
			input({
				context: { goal: "rm-d2c1f9b2 #683", whyNeeded: "", nextStepAndOutcome: "/tmp/x.json" },
			}),
		);
		expectPlainBrief(lines);
		expect(lines.slice(1, 4).map((l) => l.text)).toEqual([NOT_SAID, NOT_SAID, NOT_SAID]);
	});

	it("long texts and many recipients are cut to fit, and every point stays", () => {
		const lines = grantCardBrief(
			input({
				requester: "A department with a very long name that goes on and on for the owner",
				recipients: ["alpha team", "beta team", "gamma team", "delta team", "epsilon team"],
				context: {
					goal: LONG("Make every card plain"),
					whyNeeded: LONG("The chain hit its limit"),
					nextStepAndOutcome: LONG("It sends the result"),
				},
			}),
		);
		expectPlainBrief(lines);
		expect(lines[0].text).toContain("alpha team, beta team, gamma team and 2 more");
		expect(lines[1].text.startsWith("Make every card plain")).toBe(true);
		expect(lines[2].text.startsWith("The chain hit its limit")).toBe(true);
		expect(lines[3].text.startsWith("It sends the result")).toBe(true);
		for (const l of lines.slice(1, 4)) expect(l.text.endsWith("\u2026"), l.text).toBe(true);
		expect(lines[4].text).toContain("\u201CAllow up to 5 sends\u201D: up to 5 more, for the hour the grant lasts.");
	});

	it("the same request gives the same brief (no model, nothing random)", () => {
		expect(grantCardBrief(input())).toEqual(grantCardBrief(input()));
	});
});

describe("the grant card as the host shows it", () => {
	useGuardWorld();

	it("the card and the open question carry the brief; the question, its digest and the card's fields don't change", async () => {
		const w = await world();
		let from = "coo";
		let to = "beta";
		for (let h = 1; h < 7; h++) {
			expect(await send(w, from, homes()[from], to)).toMatchObject({ ok: true });
			[from, to] = [to, from];
		}
		expect(await ask(w, "coo", C, ["beta"])).toMatchObject({ ok: true, details: { tier: "owner" } });
		const [q] = await w.host.openQuestions();
		const card = w.hub.get(q.questionId)!;
		expect(card).toBeTruthy();

		// The brief: on the card (web and Telegram) and on the open question (the app's dialog), the same lines.
		expect(card.brief).toEqual(q.brief);
		expectPlainBrief(q.brief!);
		expect(q.brief![0].text).toMatch(/^COO wants to keep messaging BETA, past message \d+ of one chain of messages\.$/);
		expect(q.brief!.slice(1, 4).map((l) => l.text)).toEqual([
			"finish the hand-off.",
			"the last part needs one more exchange.",
			"send the result and stop.",
		]);

		// Display only: the owner question has exactly its contract's fields, no brief, and the card's id, field id
		// and choices are the question's.
		expect(Object.keys(q.ownerQuestion).sort()).toEqual(
			["binding", "choices", "choicesDigest", "detail", "generation", "questionId"].sort(),
		);
		expect(JSON.stringify(q.ownerQuestion)).not.toContain("brief");
		expect(JSON.stringify(q.request)).not.toContain("Who asks");
		expect(q.ownerQuestion.questionId).toBe(q.questionId);
		expect(q.ownerQuestion.generation).toBe(q.generation);
		expect(q.ownerQuestion.choices).toEqual(["deny", "one_send", "requested_quantity"]);
		expect(q.ownerQuestion.choicesDigest).toMatch(/^[0-9a-f]{64}$/);
		expect(card.id).toBe(q.questionId);
		expect(card.fields.map((f) => f.id)).toEqual([q.generation]);
		expect(card.fields[0].options?.map((o) => o.value)).toEqual(["deny", "one_send", "requested_quantity"]);
		// The brief names each answer as its button does.
		for (const o of card.fields[0].options ?? []) expect(q.brief![4].text).toContain(`\u201C${o.label}\u201D`);
		expect(card.body).toMatch(/^coo asks to continue a chain of role messages past message \d+\.$/);
		const [again] = await w.host.openQuestions();
		expect(again).toEqual(q);

		// The answer still goes through as before.
		expect(await w.host.ownerAnswer(q.questionId, q.generation, "one_send", "browser")).toEqual({ ok: true });
		expect(await w.host.openQuestions()).toEqual([]);
	});
});
