/**
 * queue-fold (Ops #267): which messages fold to one line (web/src/queue-report-fold.ts).
 *
 * The texts are pi-queue's own templates (~/projects/pi-queue at 8e532de, queue.ts and index.ts; the line
 * of each is noted), filled in with sample values: every report kind folds, a task's two start messages
 * (its plan) stay open, and so do the owner's own messages and anything that only mentions [Queue].
 */
import { describe, expect, it } from "vitest";
import { isQueuePlanText, queueReportFold } from "../../web/src/queue-report-fold.js";
import type { UiMessage } from "../../web/src/types.js";

const user = (text: string): UiMessage => ({ id: "u", role: "user", content: [{ type: "text", text }] });
const note = (customType: string, text: string): UiMessage => ({
	id: "c",
	role: "custom",
	customType,
	content: [{ type: "text", text }],
});

const PLAN_MD = "**Goal:** Queue reports stop filling the chat.\n\n**Done when:**\n\n- Each one shows as one line.";
const HOW_TO_FINISH = "When it's finished and checked, call queue_done with a short summary, then give the result.";
const WORK = "Work it through to the end without stopping to ask, unless only the user can decide something.";

// queue.ts 5717 kickoffText: the task starts in the queue's own chat.
const kickoffText = (id: number, title: string, more: string) =>
	[
		`[Queue] Task #${id}: ${title}${more}`,
		`The user planned this task with you and approved the plan. ${WORK}`,
		PLAN_MD,
		HOW_TO_FINISH,
	].join("\n\n");
// queue.ts 5745 taskKickoffText: the task starts in a chat of its own (chatWords: the chat "<title>").
const taskKickoffText = (id: number, title: string, chat: string) =>
	[
		`[Queue] Task #${id}: ${title}`,
		`You're working on this task in a chat of its own, started by the queue in the chat "${chat}". The user planned it there and approved the plan. ${WORK}`,
		PLAN_MD,
		"Other queued tasks may be running at the same time in other chats, so:",
		HOW_TO_FINISH,
	].join("\n\n");

/** Every report card kind, as pi-queue writes it, and the line its folded row shows. */
const CARDS: [kind: string, text: string, line: string][] = [
	[
		"done (queue.ts 3305)",
		'[Queue] Task #2 (Add a timing check) is done in its chat "Add a timing check": Timing check added; tests pass.',
		'Task #2 (Add a timing check) is done in its chat "Add a timing check": Timing check added; tests pass.',
	],
	[
		"done in its chat, the wake (queue.ts 5127)",
		'[Queue] Task #7 (Build the thing) is done in its chat "Build the thing": it built the thing. If it was one step of work you were asked for, tell whoever asked.',
		'Task #7 (Build the thing) is done in its chat "Build the thing": it built the thing. If it was one step of work you were asked for, tell whoever asked.',
	],
	[
		"done batch (queue.ts 5133)",
		'[Queue] 2 tasks are done in their chats:\n- Task #3 (Tidy the README) in "Tidy the README": tidied.\n- Task #4 (Fix the link) in "Fix the link": fixed.',
		"2 tasks are done in their chats:",
	],
	[
		"on hold (queue.ts 3317)",
		'[Queue] Task #5 (Ship the build) is on hold in its chat "Ship the build", waiting on "temper restart".',
		'Task #5 (Ship the build) is on hold in its chat "Ship the build", waiting on "temper restart".',
	],
	[
		"blocked (queue.ts 3324)",
		'[Queue] Task #6 (Land the fix) is blocked in its chat "Land the fix": temper #38. The queue pokes it when that\'s over.',
		'Task #6 (Land the fix) is blocked in its chat "Land the fix": temper #38. The queue pokes it when that\'s over.',
	],
	[
		"blocked for a while (queue.ts 3541)",
		"[Queue] Task #6 (Land the fix) has been blocked for 2h 10m: temper #38.",
		"Task #6 (Land the fix) has been blocked for 2h 10m: temper #38.",
	],
	[
		"poked (index.ts 2870)",
		"[Queue] Task #6 (Land the fix): the queue poked it out of its block. If you're still blocked, call queue_blocked again; otherwise carry on with the task.",
		"Task #6 (Land the fix): the queue poked it out of its block. If you're still blocked, call queue_blocked again; otherwise carry on with the task.",
	],
	[
		"lead card (queue.ts 4295)",
		'[Queue] Lead: task #8 in "Design lead" asks (question 1 of at most 3) [k1a2b3c4d]: Draw the icons\n\nThe question: which size?\n\nReply with queue_reply.',
		'Lead: task #8 in "Design lead" asks (question 1 of at most 3) [k1a2b3c4d]: Draw the icons',
	],
	[
		"Ops card (queue.ts 4544)",
		'[Queue] Ops: task #9 in "Design lead" stopped and its chat can\'t be reached [k5e6f7a8b]: Draw the icons\n\nWhat happened: …',
		'Ops: task #9 in "Design lead" stopped and its chat can\'t be reached [k5e6f7a8b]: Draw the icons',
	],
	[
		"reminder (queue.ts 4777)",
		'[Queue] Reminder 1 of 3 for temper (rule 24) [l1a2b3c4d]: task #10 (Wire the gate) in the queue of "Ops lead" has waited 1h 5m (since 19:02) for a go-ahead.',
		'Reminder 1 of 3 for temper (rule 24) [l1a2b3c4d]: task #10 (Wire the gate) in the queue of "Ops lead" has waited 1h 5m (since 19:02) for a go-ahead.',
	],
	[
		"decision (queue.ts 4394)",
		'[Queue] temper\'s lead\'s decision ("Temper engine") on task #11\'s question "Which port?":\n\nUse 8080.',
		'temper\'s lead\'s decision ("Temper engine") on task #11\'s question "Which port?":',
	],
	[
		"answer (queue.ts 3703)",
		'[Queue] Answer from your main chat ("Ops lead") to task #16\'s question "Which label?":\n\nQUEUE-ANSWER use Settings as the label',
		'Answer from your main chat ("Ops lead") to task #16\'s question "Which label?":',
	],
	[
		"passed to the owner (queue.ts 4425)",
		"[Queue] Ops passed task #12's question 1 on to the owner with the full context (rule 21). Wait for his answer; it comes here as your next message. Don't ask again meanwhile.",
		"Ops passed task #12's question 1 on to the owner with the full context (rule 21). Wait for his answer; it comes here as your next message. Don't ask again meanwhile.",
	],
	[
		"needs the user (queue.ts 3309)",
		'[Queue] Task #13 (Pick a name) needs the user in its chat "Pick a name": Which name?',
		'Task #13 (Pick a name) needs the user in its chat "Pick a name": Which name?',
	],
	[
		"asks its main chat (queue.ts 3673)",
		"[Queue] Task #19 asks (question 1 of at most 3): Fold the reports\n\nWhich label?",
		"Task #19 asks (question 1 of at most 3): Fold the reports",
	],
	[
		"was dropped (queue.ts 3212)",
		"[Queue] Task #14 was dropped by Ops: covered by #15. Stop working on it: finish the step you're on, don't start new runs, workflows or wake-ups, and cancel wake-ups you scheduled. Then end your turn with one line on where you stopped.",
		"Task #14 was dropped by Ops: covered by #15. Stop working on it: finish the step you're on, don't start new runs, workflows or wake-ups, and cancel wake-ups you scheduled. Then end your turn with one line on where you stopped.",
	],
	[
		"removed (queue.ts 5253)",
		"[Queue] The user removed task #21 (Old idea) from the queue. Don't work on it any more; reply with one short line.",
		"The user removed task #21 (Old idea) from the queue. Don't work on it any more; reply with one short line.",
	],
	[
		"back to work after a wait, plan included (queue.ts 5773)",
		`[Queue] Back to task #17: Fold the reports\n\nThe wait on "deploy" is over: its check passed at 20:41, after 12m. Pick up where you left off: check what's already done, then finish the task.\n\n${PLAN_MD}`,
		"Back to task #17: Fold the reports",
	],
	[
		"wake-up (queue.ts 5763)",
		"[Queue] Wake-up for task #18: Watch the deploy\n\nIt has waited 30m.",
		"Wake-up for task #18: Watch the deploy",
	],
	[
		"long turn (queue.ts 2828)",
		'[Queue] Long turn: task #20 (in the chat "Ops lead"): Fold the reports',
		'Long turn: task #20 (in the chat "Ops lead"): Fold the reports',
	],
	[
		"paused by the owner (queue.ts 4865)",
		"[Queue] The owner paused this task: finish the step you're on and note where you stopped. Then end your turn.",
		"The owner paused this task: finish the step you're on and note where you stopped. Then end your turn.",
	],
];

describe("queue-fold: report cards fold", () => {
	for (const [kind, text, line] of CARDS) {
		it(kind, () => {
			expect(queueReportFold(user(text))).toBe(line);
			expect(isQueuePlanText(text)).toBe(false);
		});
	}
});

describe("queue-fold: the queue's notes fold", () => {
	it("queue-report (index.ts 894 note): its first line", () => {
		const text =
			'[Queue] Task #2 (Add a timing check) is done in its chat "Add a timing check": Timing check added.\n\nMore below.';
		expect(queueReportFold(note("queue-report", text))).toBe(
			'Task #2 (Add a timing check) is done in its chat "Add a timing check": Timing check added.',
		);
	});
	it("queue-report without the [Queue] head, blank first line", () => {
		expect(queueReportFold(note("queue-report", '\n  Task #3   started in its chat "Tidy".\nsecond'))).toBe(
			'Task #3 started in its chat "Tidy".',
		);
	});
	it("queue-wait (index.ts 986)", () => {
		expect(queueReportFold(note("queue-wait", "[Queue] Task #22 (Pick a port) needs the user: Which port?"))).toBe(
			"Task #22 (Pick a port) needs the user: Which port?",
		);
	});
	it("queue-wait, went to the owner (index.ts 2893)", () => {
		const text =
			"[Queue] Task #23: no lead answered its block, so its question went to the owner with the whole record (owner, 2026-10-16): Go ahead?\n\nWait for his answer; it comes here as your next message.";
		expect(queueReportFold(note("queue-wait", text))).toBe(
			"Task #23: no lead answered its block, so its question went to the owner with the whole record (owner, 2026-10-16): Go ahead?",
		);
	});
	it("queue-paused (pi-web-ui server/role-messages.ts 134): what reached a paused task's chat", () => {
		const text =
			"[Role message rm-0000a001 from temper (Temper engine), sent from its home chat · question]\n\nCan you check?\n\n(This came while the owner had this task paused, so it started no turn.)";
		expect(queueReportFold(note("queue-paused", text))).toBe(
			"[Role message rm-0000a001 from temper (Temper engine), sent from its home chat · question]",
		);
	});
	it("a note with no text still folds (an empty line)", () => {
		expect(queueReportFold({ role: "custom", customType: "queue-report", content: [] })).toBe("");
	});
});

describe("queue-fold: a task's plan stays open", () => {
	const inQueueChat = kickoffText(8, "Fold the queue reports", " (the last one in the queue)");
	const withMore = kickoffText(9, "Draw the icons", " (2 more queued after this one)");
	const ownChat = taskKickoffText(267, "Chats: queue reports folded to one line by default", "Ops lead");
	it("kickoffText (queue's own chat)", () => {
		expect(isQueuePlanText(inQueueChat)).toBe(true);
		expect(isQueuePlanText(withMore)).toBe(true);
		expect(queueReportFold(user(inQueueChat))).toBeNull();
		expect(queueReportFold(user(withMore))).toBeNull();
	});
	it("taskKickoffText (a chat of its own)", () => {
		expect(isQueuePlanText(ownChat)).toBe(true);
		expect(queueReportFold(user(ownChat))).toBeNull();
	});
	it("the exact fixed lines: these two second paragraphs and nothing else", () => {
		expect(inQueueChat.split("\n\n")[1]).toBe(
			"The user planned this task with you and approved the plan. Work it through to the end without stopping to ask, unless only the user can decide something.",
		);
		expect(ownChat.split("\n\n")[1]).toBe(
			'You\'re working on this task in a chat of its own, started by the queue in the chat "Ops lead". The user planned it there and approved the plan. Work it through to the end without stopping to ask, unless only the user can decide something.',
		);
		// A start line with some other second paragraph is a report, not pi-queue's plan.
		expect(queueReportFold(user("[Queue] Task #4: Build the thing\n\nThe plan as approved."))).toBe(
			"Task #4: Build the thing",
		);
		// The fixed line in another place doesn't keep a report open.
		expect(queueReportFold(user(`[Queue] Task #4 (Build) is done: ok\n\n${inQueueChat.split("\n\n")[1]}`))).toBe(
			"Task #4 (Build) is done: ok",
		);
	});
});

describe("queue-fold: everything else stays as it is", () => {
	it("the owner's message that mentions [Queue] later stays open", () => {
		expect(queueReportFold(user("Owner here: look at the [Queue] Task #5 card, it says on hold."))).toBeNull();
		expect(queueReportFold(user("Queue reports are too long."))).toBeNull();
		expect(queueReportFold(user(" [Queue] Task #5 (x) is done: leading space, typed by hand"))).toBeNull();
	});
	it("assistant replies, tool results and other notes don't fold", () => {
		const reply: UiMessage = {
			id: "a",
			role: "assistant",
			content: [{ type: "text", text: "[Queue] Task #5 (x) is done: ok" }],
		};
		expect(queueReportFold(reply)).toBeNull();
		expect(queueReportFold(note("role-message", "[Queue] Task #5 (x) is done: ok"))).toBeNull();
		expect(queueReportFold(note("queue", "[Queue] Task #5 (x) is done: ok"))).toBeNull();
		expect(queueReportFold(note("file", "notes.txt"))).toBeNull();
	});
	it("a role message isn't a queue report", () => {
		expect(
			queueReportFold(
				user("[Role message rm-0000a001 from temper (Temper engine), sent from its home chat · question]\n\nHi"),
			),
		).toBeNull();
	});
});
