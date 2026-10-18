import { describe, expect, it } from "vitest";
import type {
	ConversationSummary,
	ElsewhereRunning,
	UiQueueChatStatus,
	UiTaskQueue,
	UiTaskQueueTask,
} from "../../server/protocol.js";
import {
	applyQueueChatStatuses,
	cutText,
	QUEUE_STATUS_TEXT_MAX,
	queueChatStatus,
	queueChatStatuses,
	queueChatStatusesSig,
} from "../../server/queue-chat-status.js";
import { en, type Translate } from "../../web/src/i18n.js";
import { everyText, queueStatusView, shownQueueStatus } from "../../web/src/queue-chat-status.js";
import { clockOf } from "../../web/src/roles-view-model.js";

/**
 * left-task-status (Ops #213, H-LEFT-STATUS-1): a parked queued task's chat says on its row in the left panel
 * how its task stands. The server works it out from the queue state it already keeps (server/queue-chat-status.ts);
 * the page words it (web/src/queue-chat-status.ts). No server, no port, no model, no chat file.
 */

const t: Translate = (key, vars) => {
	let s: string = en[key];
	for (const [k, v] of Object.entries(vars ?? {})) s = s.replaceAll(`{${k}}`, String(v));
	return s;
};
const MIN = 60_000;
const NOW = Date.parse("2026-10-18T16:42:00Z");
const SINCE = NOW - 25 * 60 * MIN; // 25 h before
const HOME = "/sessions/2026-10-01T00-00-00-000Z_ops-lead.jsonl";
const TASK = "/sessions/2026-10-01T00-00-02-000Z_task-199.jsonl";
const TASK2 = "/sessions/2026-10-01T00-00-03-000Z_task-200.jsonl";
const WHAT = "the reminder fix's install, then a look-only day";

type Status = UiTaskQueueTask["status"];
const task = (status: Status, more: Partial<UiTaskQueueTask> = {}): UiTaskQueueTask => ({
	id: 199,
	status,
	plan: { title: "Task", goal: "-", doneWhen: "-", decided: "-", steps: "-", verify: "-", mustNot: "-" },
	addedAt: 1,
	...more,
});
const waitOf = (what = WHAT) => ({
	what,
	check: "true",
	everyMs: 10 * MIN,
	since: SINCE,
	until: SINCE + 48 * 60 * MIN,
});
const blockOf = (more: Partial<NonNullable<UiTaskQueueTask["block"]>>) => ({
	since: SINCE,
	start: SINCE,
	tries: 0,
	...more,
});
const ref = (name: string, id: number) => ({ file: name ? `/sessions/${name}.jsonl` : "", name, id });
const hold = { at: SINCE, why: "Owner: pause it until Monday" };

describe("queueChatStatus: a task's status, for its chat's row", () => {
	it("waiting: what it waits on, since when, how often it's checked and when it gives up", () => {
		expect(queueChatStatus(task("waiting", { wait: waitOf() }))).toEqual({
			kind: "waiting",
			text: WHAT,
			detail: WHAT,
			since: SINCE,
			everyMs: 10 * MIN,
			giveUpAt: SINCE + 48 * 60 * MIN,
		});
	});

	it("blocked on tasks: their numbers, its own queue's bare, another queue's named", () => {
		const s = queueChatStatus(task("blocked", { block: blockOf({ on: [ref("", 12), ref("temper", 38)] }) }));
		expect(s).toMatchObject({ kind: "blocked", text: "#12, temper #38", on: true, refs: "#12, temper #38" });
		expect(s?.since).toBe(SINCE);
	});

	it("blocked on a need: the need; on a lead's result only: the lead, and what it owes", () => {
		expect(queueChatStatus(task("blocked", { block: blockOf({ need: "a go-ahead from temper" }) }))).toEqual({
			kind: "blocked",
			text: "a go-ahead from temper",
			need: "a go-ahead from temper",
			since: SINCE,
		});
		const lead = queueChatStatus(task("blocked", { block: blockOf({ lead: "temper", owes: "the admission" }) }));
		expect(lead).toEqual({
			kind: "blocked",
			text: "temper",
			on: true,
			lead: "temper",
			owes: "the admission",
			since: SINCE,
		});
		// Tasks first; the need and the lead go to the tooltip.
		const all = queueChatStatus(
			task("blocked", { block: blockOf({ on: [ref("", 12)], need: "the deploy", lead: "systems", owes: "a slot" }) }),
		);
		expect(all).toMatchObject({
			text: "#12",
			on: true,
			refs: "#12",
			need: "the deploy",
			lead: "systems",
			owes: "a slot",
		});
	});

	it("stuck: needs a decision, with its question; asking: who has its question (the Queue panel's rule)", () => {
		expect(queueChatStatus(task("stuck", { question: "Use port 8080?" }))).toEqual({
			kind: "stuck",
			text: "",
			detail: "Use port 8080?",
		});
		expect(queueChatStatus(task("asking", { question: "Which?" }))).toEqual({
			kind: "asking",
			text: "",
			detail: "Which?",
		});
		expect(queueChatStatus(task("asking", { askOps: true }))?.lead).toBe("ops");
		expect(queueChatStatus(task("asking", { askOps: true, askLead: "temper" }))?.lead).toBe("temper");
		expect(queueChatStatus(task("asking", { askLead: "temper" }))?.lead).toBeUndefined();
	});

	it("the owner's pause comes first, the task's or its whole queue's", () => {
		expect(queueChatStatus(task("waiting", { wait: waitOf() }), hold)).toEqual({
			kind: "paused",
			text: "",
			detail: hold.why,
			since: SINCE,
		});
		expect(queueChatStatus(task("blocked", { block: blockOf({ need: "x" }) }), hold)?.kind).toBe("paused");
		expect(queueChatStatus(task("stuck"), { at: SINCE, why: "" })).toEqual({ kind: "paused", text: "", since: SINCE });
	});

	it("working, ready, done and dropped: nothing to say; ready, done and dropped not even paused", () => {
		for (const status of ["working", "ready", "done", "dropped"] as const) {
			expect(queueChatStatus(task(status, { wait: waitOf() }))).toBeUndefined();
		}
		for (const status of ["ready", "done", "dropped"] as const) {
			expect(queueChatStatus(task(status), hold)).toBeUndefined();
		}
		// A working task the owner paused keeps its status once its step is done: its idle chat says Paused
		// (while the chat still runs, the row shows its running dot instead: shownQueueStatus).
		expect(queueChatStatus(task("working"), hold)?.kind).toBe("paused");
	});

	it("long text is cut short with \u2026, the whole of it kept for the tooltip", () => {
		const long = `${WHAT}, ${WHAT}`;
		const s = queueChatStatus(task("waiting", { wait: waitOf(long) }));
		expect(s?.text.length).toBe(QUEUE_STATUS_TEXT_MAX);
		expect(s?.text.endsWith("\u2026")).toBe(true);
		expect(s?.detail).toBe(long);
		expect(cutText("  two\n lines  ")).toBe("two lines");
	});
});

describe("queueChatStatuses: the open task chats' statuses, from the open chats' queues", () => {
	const own = (status: Status, more: Partial<UiTaskQueueTask> = {}, hold?: UiTaskQueue["hold"]): UiTaskQueue => ({
		running: true,
		available: true,
		from: { file: HOME, title: "Ops lead" },
		tasks: [task(status, more)],
		...(hold ? { hold } : {}),
	});
	const home = (tasks: UiTaskQueueTask[], hold?: UiTaskQueue["hold"]): UiTaskQueue => ({
		running: true,
		available: true,
		tasks,
		...(hold ? { hold } : {}),
	});
	const inChat = (t: UiTaskQueueTask, file: string): UiTaskQueueTask => ({ ...t, chat: { file, title: "Queue #199" } });

	it("a task's own chat speaks for its task; its queue chat's copy only when that chat isn't open", () => {
		const copy = inChat(task("working"), TASK);
		const s = queueChatStatuses([
			{ file: HOME, queue: home([copy, inChat(task("blocked", { id: 200, block: blockOf({ need: "x" }) }), TASK2)]) },
			{ file: TASK, queue: own("waiting", { wait: waitOf() }) },
		]);
		expect(s.get(TASK)?.kind).toBe("waiting");
		expect(s.get(TASK2)).toMatchObject({ kind: "blocked", text: "x" });
		expect(s.has(HOME)).toBe(false);
	});

	it("the owner's pause as its queue chat records it (the task's or the whole queue's)", () => {
		const waiting = own("waiting", { wait: waitOf() });
		expect(
			queueChatStatuses([
				{ file: HOME, queue: home([inChat(task("waiting", { hold }), TASK)]) },
				{ file: TASK, queue: waiting },
			]).get(TASK)?.kind,
		).toBe("paused");
		expect(
			queueChatStatuses([
				{ file: HOME, queue: home([inChat(task("waiting"), TASK)], hold) },
				{ file: TASK, queue: waiting },
			]).get(TASK)?.kind,
		).toBe("paused");
		// Lifted in the queue chat: the task chat's stale copy of the pause doesn't count.
		expect(
			queueChatStatuses([
				{ file: HOME, queue: home([inChat(task("waiting"), TASK)]) },
				{ file: TASK, queue: own("waiting", { wait: waitOf(), hold }) },
			]).get(TASK)?.kind,
		).toBe("waiting");
		// The queue chat isn't open: the task chat's own word.
		expect(queueChatStatuses([{ file: TASK, queue: own("waiting", { wait: waitOf() }, hold) }]).get(TASK)?.kind).toBe(
			"paused",
		);
	});

	it("no status for a task its queue chat closed, a working one, or a task worked on in the queue's own chat", () => {
		expect(
			queueChatStatuses([
				{ file: HOME, queue: home([inChat(task("done"), TASK)]) },
				{ file: TASK, queue: own("waiting", { wait: waitOf() }) },
			]).size,
		).toBe(0);
		expect(queueChatStatuses([{ file: TASK, queue: own("working") }]).size).toBe(0);
		expect(queueChatStatuses([{ file: HOME, queue: home([inChat(task("stuck"), HOME)]) }]).size).toBe(0);
		expect(queueChatStatuses([{ file: TASK, queue: undefined }]).size).toBe(0);
	});

	it("the signature changes only when a status does", () => {
		const a = queueChatStatuses([{ file: TASK, queue: own("waiting", { wait: waitOf() }) }]);
		const b = queueChatStatuses([{ file: TASK, queue: own("waiting", { wait: waitOf() }) }]);
		const c = queueChatStatuses([{ file: TASK, queue: own("stuck") }]);
		expect(queueChatStatusesSig(a)).toBe(queueChatStatusesSig(b));
		expect(queueChatStatusesSig(a)).not.toBe(queueChatStatusesSig(c));
	});
});

describe("applyQueueChatStatuses: the rows that are open task chats get theirs", () => {
	it("rows and chats running elsewhere; not other chats or subagents", () => {
		const status: UiQueueChatStatus = { kind: "waiting", text: "x" };
		const statuses = new Map([[TASK, status]]);
		const row = (id: string, sessionPath: string, isSubagent = false): ConversationSummary => ({
			id,
			title: id,
			cwd: "/",
			messageCount: 1,
			isStreaming: false,
			isSubagent,
			sessionPath,
		});
		const rows = [row("task", TASK), row("home", HOME), row("sub", TASK, true)];
		const elsewhere: ElsewhereRunning[] = [
			{ title: "task", cwd: "/", isStreaming: false, sessionFile: TASK } as ElsewhereRunning,
			{ title: "home", cwd: "/", isStreaming: false, sessionFile: HOME } as ElsewhereRunning,
		];
		applyQueueChatStatuses(rows, elsewhere, statuses);
		expect(rows.map((r) => r.queueStatus)).toEqual([status, undefined, undefined]);
		expect(elsewhere.map((w) => w.queueStatus)).toEqual([status, undefined]);
	});
});

describe("queueStatusView: the label and its tooltip", () => {
	it('waiting: "Waiting: \u2026"; the tooltip with the whole text, since when, the check and the give-up time', () => {
		const s = queueChatStatus(task("waiting", { wait: waitOf() })) as UiQueueChatStatus;
		const v = queueStatusView(t, s, NOW);
		expect(v.label).toBe(`Waiting: ${WHAT}`);
		expect(v.kind).toBe("waiting");
		expect(v.tip.split("\n")).toEqual([
			`Waiting on \u201c${WHAT}\u201d`,
			`Since ${clockOf(SINCE, NOW)} (1d)`,
			`Checked every 10 min; gives up ${clockOf(SINCE + 48 * 60 * MIN, NOW)}`,
		]);
	});

	it("blocked: on tasks, on a need, on a lead", () => {
		const on = queueChatStatus(task("blocked", { block: blockOf({ on: [ref("", 12), ref("temper", 38)] }) }));
		expect(queueStatusView(t, on as UiQueueChatStatus, NOW).label).toBe("Blocked on #12, temper #38");
		const need = queueChatStatus(task("blocked", { block: blockOf({ need: "a go-ahead" }) }));
		const vn = queueStatusView(t, need as UiQueueChatStatus, NOW);
		expect(vn.label).toBe("Blocked: a go-ahead");
		expect(vn.tip.split("\n")[0]).toBe("Needs: a go-ahead");
		const lead = queueChatStatus(task("blocked", { block: blockOf({ lead: "temper", owes: "the admission" }) }));
		const vl = queueStatusView(t, lead as UiQueueChatStatus, NOW);
		expect(vl.label).toBe("Blocked on temper");
		expect(vl.tip.split("\n")[0]).toBe("Waits on temper's lead for: the admission");
	});

	it('stuck: "Needs decision"; asking: the Queue panel\'s words; paused: "Paused" with the owner\'s words', () => {
		const stuck = queueStatusView(t, { kind: "stuck", text: "", detail: "Use port 8080?" }, NOW);
		expect([stuck.label, stuck.tip]).toEqual([
			"Needs decision",
			"Its question waits on your decision\nQuestion: Use port 8080?",
		]);
		expect(queueStatusView(t, { kind: "asking", text: "" }, NOW).label).toBe("Asking the main chat");
		expect(queueStatusView(t, { kind: "asking", text: "", lead: "ops" }, NOW).label).toBe("Asking Ops");
		expect(queueStatusView(t, { kind: "asking", text: "", lead: "temper" }, NOW).label).toBe("Asking temper's lead");
		const paused = queueStatusView(t, { kind: "paused", text: "", detail: hold.why, since: SINCE }, NOW);
		expect(paused.label).toBe("Paused");
		expect(paused.tip.split("\n")).toEqual([
			"Paused by you",
			`Your words: ${hold.why}`,
			`Since ${clockOf(SINCE, NOW)} (1d)`,
		]);
	});

	it('shown only while the chat isn\'t working, and no question label next to the "?" badge', () => {
		const waiting: UiQueueChatStatus = { kind: "waiting", text: "x" };
		const stuck: UiQueueChatStatus = { kind: "stuck", text: "" };
		expect(shownQueueStatus({ queueStatus: waiting, isStreaming: false })).toBe(waiting);
		expect(shownQueueStatus({ queueStatus: waiting, isStreaming: true })).toBeUndefined();
		expect(shownQueueStatus({ isStreaming: false })).toBeUndefined();
		expect(shownQueueStatus({ queueStatus: stuck, isStreaming: false, hasQuestion: true })).toBeUndefined();
		expect(shownQueueStatus({ queueStatus: stuck, isStreaming: false, dialogId: 1 })).toBeUndefined();
		expect(shownQueueStatus({ queueStatus: waiting, isStreaming: false, hasQuestion: true })).toBe(waiting);
	});

	it("check intervals in plain words", () => {
		expect([everyText(30_000), everyText(2 * MIN), everyText(60 * MIN), everyText(90 * MIN)]).toEqual([
			"30 s",
			"2 min",
			"1 h",
			"1 h 30 min",
		]);
	});
});
