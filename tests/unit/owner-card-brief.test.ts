/**
 * owner-card-brief (Ops #682): every queue card that reaches the owner opens with a short plain brief built
 * from the records: the project, this task, why it comes to him now, what waits on it, what each answer does and
 * what is recommended. No ids or paths, at most BRIEF_MAX characters, for all seven kinds of card, for the three
 * real cards of Oct 31 (Temper #244 stopped with a task waiting on it, Temper #243 climbed, Ops #666 stopped),
 * and for a card whose kind isn't saved (inferred from the queue's fixed texts) or isn't known at all.
 */
import { afterEach, describe, expect, it } from "vitest";
import { PI_QUEUE_READERS_KEY } from "../../server/pi-queue-readers.js";
import { TASK_QUEUE_ENTRY_TYPE, taskQueueFromEntries } from "../../server/task-queue.js";
import {
	BRIEF_MAX,
	briefText,
	hasIdOrPath,
	OWNER_CARD_KINDS,
	plainTextFaults,
	ownerCardBrief,
	type OwnerCardBriefInput,
	ownerCardBriefOf,
	ownerCardKind,
	ownerCardWaiters,
} from "../../server/owner-card-brief.js";
import type { UiOwnerCardBriefLine, UiTaskQueueTask } from "../../server/protocol.js";

const SIX = ["The project", "This task", "Why you, now", "Waiting on it", "Your answers", "Recommended"];

/** pi-queue's fixed texts (queue.ts ownerDetail and its heads), as they reach the card today. */
const STOPPED_OLD = "You stopped this task's run. Reply here to carry on.";
const STOPPED_NEW = "This task's run was stopped while it was working. Carry on picks up where it stopped.";
const CLIMB_TEXT =
	"The task is stuck on a question for its lead and nobody answered. Pick one of its answers, or tell it what to do.";
const GENERIC_AUTHORIZES =
	"Only what the answer says, within the task's approved plan; it approves nothing outside the plan.";

/** A package as pi-queue's ownerDetail writes it. */
function pack(p: {
	inShort?: string;
	head: string;
	options: { choice: string; tradeoffs?: string; authorizes?: string }[];
	by?: string;
	recommends?: string;
}): string {
	return [
		...(p.inShort ? [`**In short:** ${p.inShort}`] : []),
		p.head,
		"**Goal:** Finish the work in server/roles-overview.ts (Ops #666, rm-0a1b2c3d).",
		"**Progress and what changed:** Tests written; commit 3c785b67 landed.",
		"**Decided so far:** none yet",
		"**Why only you can decide:** It needs your consent (rule 21).",
		"**All open questions on this (1):**\n1. Which way?",
		`**Your answers:**\n${p.options
			.map(
				(o) =>
					`- **${o.choice}**: ${o.tradeoffs ?? "The task's own answer."}\n  Cost: none. Time: none. Risk: none.\n  Picking it authorizes: ${o.authorizes ?? GENERIC_AUTHORIZES}`,
			)
			.join("\n")}`,
		`**${p.by ?? "Ops"} recommends:** ${p.recommends ?? "None given: the task sent no brief with its question."}`,
	].join("\n\n");
}

const NO_PROJECT = null;
const PROJECT = {
	name: "Owner cards he can answer cold",
	outcome:
		"Every card that reaches the owner opens with the context in the simplest terms, so he never picks blind. See docs/owner-card-brief.md.",
};

function input(over: Partial<OwnerCardBriefInput>): OwnerCardBriefInput {
	return {
		title: "Make the Roles page open faster",
		goal: "Make the Roles page open within two seconds on the owner's laptop. It reads server/roles-overview.ts.",
		question: STOPPED_NEW,
		choices: ["Carry on"],
		project: PROJECT,
		waiting: [],
		...over,
	};
}

const label = (lines: UiOwnerCardBriefLine[], l: string) => lines.find((x) => x.label === l)?.text;

/** The bar every brief is held to: the six points, plain words without ids or paths, within BRIEF_MAX. */
function expectPlainBrief(lines: UiOwnerCardBriefLine[], inShort = false) {
	const labels = lines.map((l) => l.label);
	expect(labels).toEqual(inShort ? ["In short", ...SIX] : SIX);
	for (const l of lines) {
		expect(l.text.trim()).not.toBe("");
		expect(hasIdOrPath(l.text), `${l.label}: ${l.text}`).toBe(false);
		// Plain words: no Markdown marks left over.
		expect(l.text).not.toMatch(/\*\*|`|\[[^\]]*\]\(/);
	}
	const text = briefText(lines);
	expect(text.length).toBeLessThanOrEqual(BRIEF_MAX);
	// The "Task #N" stays in the card's title, for finding it; never in the brief.
	expect(text).not.toMatch(/#\d/);
	return text;
}

describe("hasIdOrPath: what counts as an id or a path", () => {
	it("catches task numbers, record ids, commits, rule numbers, code names and paths", () => {
		for (const s of [
			"see #244",
			"Temper #38",
			"rm-d2c1f9b2",
			"dr-cce676b3c30c",
			"bp-45861886",
			"commit 3c785b67",
			"(rule 21)",
			"under ADR-M4-18",
			"lock C1",
			"server/asks.ts",
			"asks.ts",
			"~/projects/pi-web-ui",
			"/home/shinelay/x",
			"https://pi.wai2shine.com/x",
		])
			expect(hasIdOrPath(s), s).toBe(true);
	});
	it("leaves plain words alone", () => {
		for (const s of [
			"Its run was stopped while it was working; nothing more is known about who stopped it.",
			"Owner cards he can answer cold",
			"It waits on another department that hasn't answered.",
			"a decade of accepted facts",
			"Go on without it",
		])
			expect(hasIdOrPath(s), s).toBe(false);
	});
});

// owner-question-routing (Ops #686): COO's note and recommendation reach the owner, so the same helpers check
// them, and name what isn't plain words: ids and paths as hasIdOrPath finds them, and code.
describe("plainTextFaults: what in a text isn't plain words, named", () => {
	it("names each id, path and web address hasIdOrPath catches, with its words", () => {
		expect(plainTextFaults("Design asked in #686 about it.")).toEqual([{ kind: "id", text: "#686" }]);
		expect(plainTextFaults("See rm-d2c1f9b2 and commit 3c785b67.")).toEqual([
			{ kind: "id", text: "rm-d2c1f9b2" },
			{ kind: "id", text: "3c785b67" },
		]);
		expect(plainTextFaults("It lives in server/asks.ts.")).toEqual([{ kind: "path", text: "server/asks.ts" }]);
		expect(plainTextFaults("Open https://pi.wai2shine.com/x now")).toEqual([
			{ kind: "path", text: "https://pi.wai2shine.com/x" },
		]);
		for (const s of ["under ADR-M4-18", "lock C1", "~/projects/pi-web-ui", "(rule 21)"])
			expect(plainTextFaults(s).length, s).toBeGreaterThan(0);
	});
	it("names code: backticks, names written as code, calls, operators, braces, tags, settings and flags", () => {
		for (const [s, frag] of [
			["Run `npm test` first.", "`npm test`"],
			["It calls askHub before the card.", "askHub"],
			["Then release() is called.", "release()"],
			["The ask_user_question tool asked it.", "ask_user_question"],
			["It checks a === b first.", "==="],
			["It returns {ok} today.", "{"],
			["The <details> part is folded.", "<details>"],
			["Set mode=strict for it.", "mode=strict"],
			["Land it with --no-verify.", "--no-verify"],
		])
			expect(plainTextFaults(s), s).toContainEqual({ kind: "code", text: frag });
	});
	it("finds nothing in plain words, and each fault once", () => {
		for (const s of [
			"He set the port rule on Tuesday, so pick the usual port.",
			"Design wants your yes before it spends on the new fonts; it costs about two hundred dollars.",
			"It's either this week or next, and/or after the trip.",
			"Owner cards he can answer cold",
			"",
		])
			expect(plainTextFaults(s), s).toEqual([]);
		expect(plainTextFaults("#686 then #686 again")).toEqual([{ kind: "id", text: "#686" }]);
	});
});

describe("ownerCardBrief: every kind of card opens with the six points in plain words", () => {
	it("knows the seven kinds pi-queue saves", () => {
		expect([...OWNER_CARD_KINDS]).toEqual([
			"stopped",
			"failed",
			"stalled",
			"climbed",
			"block",
			"owner-only",
			"passed-on",
		]);
	});

	it("stopped: says nothing more is known about who stopped it; Carry on picks up where it stopped", () => {
		const lines = ownerCardBrief(input({ card: "stopped", choices: ["Carry on", "Remove it"] }));
		expectPlainBrief(lines);
		expect(label(lines, "Why you, now")).toBe(
			"Its run was stopped while it was working; nothing more is known about who stopped it.",
		);
		expect(label(lines, "Your answers")).toBe(
			"\u201CCarry on\u201D: it picks up where it stopped. \u201CRemove it\u201D: it leaves the queue, and its chat and work stay.",
		);
		expect(label(lines, "The project")).toBe(
			"\u201COwner cards he can answer cold\u201D: Every card that reaches the owner opens with the context in the simplest terms, so he never picks blind.",
		);
		expect(label(lines, "This task")).toBe(
			"\u201CMake the Roles page open faster\u201D. Make the Roles page open within two seconds on the owner's laptop.",
		);
		expect(label(lines, "Waiting on it")).toBe("Nothing else waits on it.");
		expect(label(lines, "Recommended")).toBe("None given.");
	});

	it("failed: its run failed with an error", () => {
		const lines = ownerCardBrief(
			input({
				card: "failed",
				question:
					"The run failed because the model was busy (503 overloaded). Reply here to carry on.\n`503 overloaded_error`",
			}),
		);
		expectPlainBrief(lines);
		expect(label(lines, "Why you, now")).toBe("Its run failed with an error.");
	});

	it("stalled: its chat stopped twice and couldn't be woken", () => {
		const lines = ownerCardBrief(
			input({
				card: "stalled",
				question:
					"This task's chat stopped twice without finishing; waking it didn't help. Reply here to carry on, or remove the task from the queue.",
				choices: ["Carry on", "Remove it"],
			}),
		);
		expectPlainBrief(lines);
		expect(label(lines, "Why you, now")).toBe("Its chat stopped twice and couldn't be woken.");
	});

	it("climbed: no lead answered in time; the recommendation and the fixed answers in plain words", () => {
		const lines = ownerCardBrief(
			input({
				card: "climbed",
				inShort: "The task wants to know which test to fix first; its lead didn't answer.",
				question: CLIMB_TEXT,
				choices: ["Go with the task's recommendation", "Not now"],
				detail: pack({
					inShort: "The task wants to know which test to fix first; its lead didn't answer.",
					head: 'Task #12 "Fix flaky tests" in the queue of "temper" asked a question, and no lead answered it in time, so it comes to you (owner, 2026-10-17).',
					options: [{ choice: "Go with the task's recommendation" }, { choice: "Not now" }],
					by: "The queue",
					recommends: "The task recommends: Fix the slow login test first (see tests/unit/login.test.ts, #77).",
				}),
			}),
		);
		expectPlainBrief(lines, true);
		expect(label(lines, "In short")).toBe("The task wants to know which test to fix first; its lead didn't answer.");
		expect(label(lines, "Why you, now")).toBe(
			"It asked its lead a question; no lead answered in time, so it comes to you.",
		);
		expect(label(lines, "Your answers")).toBe(
			"\u201CGo with the task's recommendation\u201D: it does what the task recommends. \u201CNot now\u201D: it leaves this for now.",
		);
		expect(label(lines, "Recommended")).toBe("Fix the slow login test first.");
	});

	it("block: waits on another department; Keep waiting and Go on without it say what they do", () => {
		const lines = ownerCardBrief(
			input({
				card: "block",
				question: "Task #9 waits on design #4, and nobody answered. Keep waiting, or go on without it?",
				choices: ["Keep waiting", "Go on without it"],
				detail: pack({
					head: 'Task #9 "Ship the new badge" in the queue of "frontend" is blocked, and every lead it waited on stayed silent (rule 24), so it asks you.',
					options: [
						{ choice: "Keep waiting", authorizes: "Another round of reminders to the leads it waits on." },
						{ choice: "Go on without it", authorizes: "The task carries on without the design." },
					],
					by: "The queue",
					recommends: "None from the queue: it only counts the silence.",
				}),
			}),
		);
		expectPlainBrief(lines);
		expect(label(lines, "Why you, now")).toBe("It waits on another department that hasn't answered.");
		expect(label(lines, "Your answers")).toBe(
			"\u201CKeep waiting\u201D: it keeps waiting, and comes back to you if nothing changes. \u201CGo on without it\u201D: it carries on without what it waited for, within its plan.",
		);
		expect(label(lines, "Recommended")).toBe("None given.");
	});

	it("owner-only: says what only he can give, each answer by what it authorizes, the recommendation", () => {
		const lines = ownerCardBrief(
			input({
				card: "owner-only",
				question: "May the test run spend up to $40 on the paid model?",
				choices: ["Approve $40", "Not now"],
				detail: pack({
					head: 'Task #31 "Price check" asks you from its queue\'s own chat, with the full context (rule 21): only you can give this (spending or a spending limit).',
					options: [
						{
							choice: "Approve $40",
							authorizes: "One test run on the paid model, up to $40 (rm-77aa88bb). Nothing else.",
						},
						{ choice: "Not now", authorizes: "Nothing: the task waits." },
					],
					by: "The task",
					recommends: "Approve $40: it's the only way to measure the paid model (see docs/price.md).",
				}),
			}),
		);
		expectPlainBrief(lines);
		expect(label(lines, "Why you, now")).toBe("Only you can give this: spending or a spending limit.");
		// The queue's fixed answers keep their fixed meaning; the task's own say what they authorize.
		expect(label(lines, "Your answers")).toBe(
			"\u201CApprove $40\u201D: One test run on the paid model, up to $40. \u201CNot now\u201D: it leaves this for now.",
		);
		expect(label(lines, "Recommended")).toBe("Approve $40: it's the only way to measure the paid model.");
	});

	it("passed-on: its lead passed it to you", () => {
		const lines = ownerCardBrief(
			input({
				card: "passed-on",
				question: "Which of the two layouts should the Roles page use?",
				choices: ["The list", "The grid"],
				detail: pack({
					head: 'Task #5 "Roles layout" in the queue of "design", question 1: passed on to you by Ops with the full context (rule 21).',
					options: [
						{ choice: "The list", authorizes: "The list layout ships. The grid is kept for later." },
						{ choice: "The grid" },
					],
					recommends: "The list: it reads faster.",
				}),
			}),
		);
		expectPlainBrief(lines);
		expect(label(lines, "Why you, now")).toBe("Its lead passed it to you.");
		// A package option without its own words: the task's own answer.
		expect(label(lines, "Your answers")).toBe(
			"\u201CThe list\u201D: The list layout ships. \u201CThe grid\u201D: the task's own answer.",
		);
		expect(label(lines, "Recommended")).toBe("The list: it reads faster.");
	});

	it("an unknown card: the task asks you a question; its answers are its own", () => {
		const lines = ownerCardBrief(
			input({ question: "Which colour should the button be?", choices: ["Red", "Blue"], project: NO_PROJECT }),
		);
		expectPlainBrief(lines);
		expect(label(lines, "Why you, now")).toBe("The task asks you a question.");
		expect(label(lines, "Your answers")).toBe(
			"\u201CRed\u201D: the task's own answer. \u201CBlue\u201D: the task's own answer.",
		);
		expect(label(lines, "The project")).toBe("Not part of a project.");
	});

	it("a project whose record can't be read says so; a goal that is all ids and paths is left out", () => {
		const lines = ownerCardBrief(input({ project: undefined, goal: "See rm-d2c1f9b2 and server/asks.ts (#681)." }));
		expectPlainBrief(lines);
		expect(label(lines, "The project")).toBe("Its project's record couldn't be found.");
		expect(label(lines, "This task")).toBe("\u201CMake the Roles page open faster\u201D.");
	});

	it("waiting tasks are counted, by title and queue; two at most by name", () => {
		const lines = ownerCardBrief(
			input({
				waiting: [
					{ title: "Bootstrap test: publish acknowledgements atomically" },
					{ title: "Usage tests: the last two speed bars (#222)", queue: "Temper lead" },
					{ title: "Journal lock test", queue: "Temper lead" },
				],
			}),
		);
		expectPlainBrief(lines);
		expect(label(lines, "Waiting on it")).toBe(
			"3 tasks: \u201CBootstrap test: publish acknowledgements atomically\u201D (same queue), \u201CUsage tests: the last two speed bars\u201D (in \u201CTemper lead\u201D) and 1 more.",
		);
	});

	it("stays within BRIEF_MAX however long the records are, and keeps every answer", () => {
		const long = "word ".repeat(200).trim();
		const lines = ownerCardBrief(
			input({
				title: `A very long title ${long}`,
				goal: `${long}.`,
				inShort: long,
				choices: ["First answer here", "Second answer here", "Third answer here", "Fourth answer here"],
				detail: pack({
					inShort: long,
					head: 'Task #5 "x" in the queue of "design", question 1: passed on to you by Ops with the full context (rule 21).',
					options: ["First", "Second", "Third", "Fourth"].map((c) => ({
						choice: `${c} answer here`,
						authorizes: `${long}.`,
					})),
					recommends: long,
				}),
				waiting: [{ title: long }, { title: long, queue: long }, { title: long }],
				project: { name: long, outcome: long },
			}),
		);
		const text = expectPlainBrief(lines, true);
		expect(text.length).toBeLessThanOrEqual(BRIEF_MAX);
		for (const c of ["First", "Second", "Third", "Fourth"]) expect(label(lines, "Your answers")).toContain(c);
	});

	it("is the same for the same records (no model, nothing random)", () => {
		const a = ownerCardBrief(input({ card: "stopped" }));
		const b = ownerCardBrief(input({ card: "stopped" }));
		expect(b).toEqual(a);
	});
});

describe("ownerCardKind: the saved kind, else what the queue's fixed texts say", () => {
	it("takes the saved card field when it is one of the seven", () => {
		for (const card of OWNER_CARD_KINDS) expect(ownerCardKind({ card, question: "x" })).toBe(card);
		expect(ownerCardKind({ card: "something-new", question: "Which colour?" })).toBeUndefined();
	});

	it("infers the kind from cards saved before pi-queue wrote it", () => {
		expect(ownerCardKind({ question: STOPPED_OLD })).toBe("stopped");
		expect(ownerCardKind({ question: STOPPED_NEW })).toBe("stopped");
		expect(ownerCardKind({ question: "The run failed. Reply here to carry on." })).toBe("failed");
		expect(
			ownerCardKind({
				question:
					"This task's chat stopped twice without finishing; waking it didn't help. Reply here to carry on, or remove the task from the queue.",
			}),
		).toBe("stalled");
		expect(ownerCardKind({ question: "The agent stopped twice without finishing this task." })).toBe("stalled");
		expect(ownerCardKind({ question: CLIMB_TEXT })).toBe("climbed");
		expect(ownerCardKind({ question: "Which way?\n\n(Sent to you because no lead answered in time.)" })).toBe(
			"climbed",
		);
		const head = (h: string) => pack({ head: h, options: [{ choice: "A" }, { choice: "B" }] });
		expect(
			ownerCardKind({
				question: "Which way?",
				detail: head(
					'Task #1 "t" asked a question, and no lead answered it in time, so it comes to you (owner, 2026-10-17).',
				),
			}),
		).toBe("climbed");
		expect(
			ownerCardKind({
				question: "Keep waiting?",
				detail: head('Task #1 "t" is blocked, and every lead it waited on stayed silent (rule 24), so it asks you.'),
			}),
		).toBe("block");
		expect(ownerCardKind({ question: "Keep waiting?", choices: ["Keep waiting", "Go on without it"] })).toBe("block");
		expect(
			ownerCardKind({
				question: "May it?",
				detail: head(
					'Task #1 "t" asks you from its queue\'s own chat, with the full context (rule 21): only you can give this (approving a plan or a change to it).',
				),
			}),
		).toBe("owner-only");
		expect(
			ownerCardKind({
				question: "Which?",
				detail: head('Task #1 "t", question 2: passed on to you by Ops with the full context (rule 21).'),
			}),
		).toBe("passed-on");
		expect(ownerCardKind({ question: "Which colour should the button be?" })).toBeUndefined();
	});

	it("an inferred owner-only card still says what only he can give", () => {
		const lines = ownerCardBrief(
			input({
				question: "May it publish?",
				choices: ["Publish", "Not now"],
				detail: pack({
					head: 'Task #1 "t" asks you from its queue\'s own chat, with the full context (rule 21): only you can give this (his own observation of something (a human-observer receipt)).',
					options: [{ choice: "Publish" }, { choice: "Not now" }],
				}),
			}),
		);
		expectPlainBrief(lines);
		expect(label(lines, "Why you, now")).toBe("Only you can give this: your own observation of something.");
	});
});

/** A queued task as the queue mirror replays it. */
function task(over: Partial<UiTaskQueueTask> & { id: number; title?: string }): UiTaskQueueTask {
	const { title, ...rest } = over;
	return {
		status: "ready",
		plan: {
			title: title ?? `Task ${over.id}`,
			goal: "",
			doneWhen: "",
			decided: "",
			steps: "",
			verify: "",
			mustNot: "",
		},
		...rest,
	} as UiTaskQueueTask;
}

const TEMPER = "/sessions/temper-home.jsonl";
const OPS = "/sessions/ops-home.jsonl";

describe("ownerCardWaiters: the open tasks whose after or block names this task", () => {
	it("finds same-queue afters, blocks in any queue and outside afters; not done, dropped or working ones", () => {
		const waiters = ownerCardWaiters({ file: TEMPER, id: 244 }, [
			{
				file: TEMPER,
				name: "Temper lead",
				tasks: [
					task({ id: 244, status: "stuck" }),
					task({
						id: 230,
						title: "Bootstrap test: publish synthetic acknowledgements atomically",
						status: "blocked",
						block: { on: [{ file: TEMPER, name: "temper", id: 244 }], since: 1, start: 1, tries: 0 },
					}),
					task({ id: 250, title: "After it", after: [244] }),
					task({ id: 251, title: "Done after it", status: "done", after: [244] }),
					task({ id: 252, title: "Working after it", status: "working", after: [244] }),
					task({ id: 253, title: "After another", after: [12] }),
				],
			},
			{
				file: OPS,
				name: "Ops lead",
				tasks: [
					task({ id: 7, title: "Outside after it", outside: [{ file: TEMPER, name: "temper", id: 244 }] }),
					task({ id: 8, title: "Over", outside: [{ file: TEMPER, name: "temper", id: 244, over: { at: 1 } }] }),
					// Another queue's #244 isn't this one.
					task({ id: 9, title: "Own 244", after: [244] }),
				],
			},
		]);
		expect(waiters).toEqual([
			{ title: "Bootstrap test: publish synthetic acknowledgements atomically" },
			{ title: "After it" },
			{ title: "Outside after it", queue: "Ops lead" },
		]);
	});

	it("counts a queue once when it is known twice (an open chat and the block module's copy)", () => {
		const q = {
			file: TEMPER,
			tasks: [task({ id: 230, title: "Waiter", after: [244] })],
		};
		expect(ownerCardWaiters({ file: TEMPER, id: 244 }, [q, { ...q }])).toEqual([{ title: "Waiter" }]);
	});
});

describe("the three real cards of Oct 31, as the queue saved them (no card field yet)", () => {
	const records = (queues: Parameters<typeof ownerCardWaiters>[1]) => ({
		queues,
		project: () => null,
	});

	it("Temper #244: a stopped run, with Temper #230 blocked on it", () => {
		const t244 = task({
			id: 244,
			title: "KB fixtures: prevent background Git writes during byte-safety snapshots",
			status: "stuck",
			question: STOPPED_OLD,
			choices: ["Carry on"],
		});
		const lines = ownerCardBriefOf(
			t244,
			TEMPER,
			records([
				{
					file: TEMPER,
					name: "Temper lead",
					tasks: [
						t244,
						task({
							id: 230,
							title: "Bootstrap test: publish synthetic acknowledgements atomically",
							status: "blocked",
							block: { on: [{ file: TEMPER, name: "temper", id: 244 }], since: 1, start: 1, tries: 0 },
						}),
					],
				},
			]),
		);
		expectPlainBrief(lines);
		expect(label(lines, "Why you, now")).toBe(
			"Its run was stopped while it was working; nothing more is known about who stopped it.",
		);
		expect(label(lines, "Waiting on it")).toBe(
			"1 task: \u201CBootstrap test: publish synthetic acknowledgements atomically\u201D (same queue).",
		);
		expect(label(lines, "This task")).toBe(
			"\u201CKB fixtures: prevent background Git writes during byte-safety snapshots\u201D.",
		);
		expect(label(lines, "Your answers")).toBe("\u201CCarry on\u201D: it picks up where it stopped.");
	});

	it("Temper #243: a question that climbed to the owner, with ids in its title", () => {
		const q243 = "Please route this complete consent package to the owner; do not answer it departmentally.";
		const t243 = task({
			id: 243,
			title: "Reported #233 disclosure: obtain an explicit disposition",
			status: "stuck",
			question: q243,
			choices: ["Go with the task's recommendation", "Not now"],
			detail: pack({
				head: 'Task #243 "Reported #233 disclosure: obtain an explicit disposition" in the queue of "temper" asked a question, and no lead answered it in time, so it comes to you (owner, 2026-10-17).',
				options: [{ choice: "Go with the task's recommendation" }, { choice: "Not now" }],
				by: "The queue",
			}),
			parent: { project: "credential-incident" },
		});
		const lines = ownerCardBriefOf(t243, TEMPER, {
			queues: [{ file: TEMPER, tasks: [t243] }],
			project: (id) =>
				id === "credential-incident"
					? {
							name: "Credential incident",
							outcome: "The leaked spare password is dealt with and recorded (dr-6cecf16612fa).",
						}
					: null,
		});
		expectPlainBrief(lines);
		expect(label(lines, "This task")).toBe("\u201CReported disclosure: obtain an explicit disposition\u201D.");
		expect(label(lines, "The project")).toBe(
			"\u201CCredential incident\u201D: The leaked spare password is dealt with and recorded.",
		);
		expect(label(lines, "Why you, now")).toBe(
			"It asked its lead a question; no lead answered in time, so it comes to you.",
		);
		expect(label(lines, "Waiting on it")).toBe("Nothing else waits on it.");
		// The task named no recommendation: following it is said for what it is.
		expect(label(lines, "Recommended")).toBe("None given.");
		expect(label(lines, "Your answers")).toBe(
			"\u201CGo with the task's recommendation\u201D: it goes with what it recommends; it named nothing here. \u201CNot now\u201D: it leaves this for now.",
		);
	});

	it("Ops #666: a stopped run nothing waits on", () => {
		const t666 = task({
			id: 666,
			title: "Complete audit of retained role and worker messages",
			status: "stuck",
			question: STOPPED_OLD,
			choices: ["Carry on"],
		});
		const lines = ownerCardBriefOf(t666, OPS, records([{ file: OPS, name: "Ops lead", tasks: [t666] }]));
		expectPlainBrief(lines);
		expect(label(lines, "Why you, now")).toBe(
			"Its run was stopped while it was working; nothing more is known about who stopped it.",
		);
		expect(label(lines, "Waiting on it")).toBe("Nothing else waits on it.");
		expect(label(lines, "The project")).toBe("Not part of a project.");
	});

	it("reads the saved card and in short when pi-queue wrote them", () => {
		const t = task({
			id: 666,
			title: "Complete audit of retained role and worker messages",
			status: "stuck",
			question: STOPPED_NEW,
			choices: ["Carry on"],
			card: "stopped",
			inShort: "The audit of kept messages was stopped halfway; carrying on finishes it.",
		});
		const lines = ownerCardBriefOf(t, OPS, records([{ file: OPS, tasks: [t] }]));
		expectPlainBrief(lines, true);
		expect(label(lines, "In short")).toBe("The audit of kept messages was stopped halfway; carrying on finishes it.");
	});
});

/**
 * The card's saved kind and in-short (pi-queue #681's contract: optional `card` and `in_short` on the "stuck" op
 * and the replayed task) reach the Queue view's task, by this file's mirror and by pi-queue's own replay; only while
 * the task is stuck, and a new question without them takes them away.
 */
describe("the queue keeps a card's kind and in-short", () => {
	const plan = (title: string) => ({
		title,
		goal: "g",
		doneWhen: "d",
		decided: "x",
		steps: "s",
		verify: "v",
		mustNot: "m",
	});
	const entries = (...ops: Record<string, unknown>[]) =>
		ops.map((op, i) => ({ type: "custom", customType: TASK_QUEUE_ENTRY_TYPE, data: { v: 1, ts: 1000 + i, ...op } }));
	const slot = globalThis as unknown as Record<symbol, unknown>;
	afterEach(() => {
		delete slot[PI_QUEUE_READERS_KEY];
	});

	it("by this file's mirror of the ops", () => {
		const add = { op: "add", id: 1, plan: plan("Audit") };
		const stuck = {
			op: "stuck",
			id: 1,
			question: STOPPED_NEW,
			choices: ["Carry on", "Remove it"],
			card: "stopped",
			in_short: "The audit was stopped halfway.",
		};
		const task = (...ops: Record<string, unknown>[]) =>
			taskQueueFromEntries(entries(add, { op: "start", id: 1 }, ...ops), true).tasks[0]!;
		expect(task(stuck)).toMatchObject({ status: "stuck", card: "stopped", inShort: "The audit was stopped halfway." });
		// A new question without them takes them away; so does going back to work.
		const bare = task(stuck, { op: "stuck", id: 1, question: "Which branch?" });
		expect("card" in bare || "inShort" in bare).toBe(false);
		const back = task(stuck, { op: "resume", id: 1 });
		expect(back.status).not.toBe("stuck");
		expect("card" in back || "inShort" in back).toBe(false);
		// A shape pi-queue never writes is left out.
		const odd = task({ ...stuck, card: 7, in_short: { x: 1 } });
		expect("card" in odd || "inShort" in odd).toBe(false);
	});

	it("by pi-queue's own replay", () => {
		const replayed = (status: string) => ({
			tasks: [
				{
					id: 1,
					status,
					plan: plan("Audit"),
					addedAt: 1,
					question: STOPPED_NEW,
					choices: ["Carry on"],
					card: "stopped",
					in_short: "The audit was stopped halfway.",
				},
			],
			running: false,
		});
		let status = "stuck";
		slot[PI_QUEUE_READERS_KEY] = { version: 1, replay: () => replayed(status), readWork: () => null };
		expect(taskQueueFromEntries([], true).tasks[0]).toMatchObject({
			card: "stopped",
			inShort: "The audit was stopped halfway.",
		});
		status = "asking";
		const asking = taskQueueFromEntries([], true).tasks[0]!;
		expect("card" in asking || "inShort" in asking).toBe(false);
	});
});
