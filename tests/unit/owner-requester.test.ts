/**
 * owner-requester (Ops #973, rule 37): owner questions go to whoever asked, Shine or Wai.
 * Wai's work shows in the web app marked "For Wai" and never reaches Telegram; Shine's and unowned work
 * is as before; answers record who answered; old records are Shine's and parse unchanged.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type AskEvent, AskHub, askHub, dialogAsk, stuckAsk } from "../../server/asks.js";
import { answerRecord } from "../../server/decision-records.js";
import type { IdentityDef } from "../../server/identities.js";
import {
	pluginAnswer,
	pluginSeesAskEvent,
	dialogView,
	ownerQuestionRouteView,
} from "../../server/owner-question-surfaces.js";
import { ownTaskOf } from "../../server/own-task.js";
import { answerOwnerFields, chatPersonOf, isPersonName, requesterPersonOf } from "../../server/owner-requester.js";
import type { UiTaskQueue, UiTaskQueueTask, UiTaskRequester } from "../../server/protocol.js";
import {
	collectRequesterInput,
	requesterForAdmission,
	requesterOf,
	requesterOfTurn,
	type RequesterTurn,
	roleRequesterInputOf,
} from "../../server/queue-requester.js";
import { GUARD_POLICY_V1 } from "../../server/role-message-limits.js";
import { RoleMessages, type RoleMessageHost } from "../../server/role-messages.js";
import { answeredBy, asAnswerer } from "../../server/sent-by.js";
import { wantedStuckAsks } from "../../server/stuck-asks.js";
import { TASK_QUEUE_ENTRY_TYPE, type TaskQueueEntryLike } from "../../server/task-queue.js";
import { ownerQuestionRouteOf } from "../../web/src/owner-question-route.js";

const WAI = { login: "sayswai@gmail.com", name: "Wai", owner: false };
const SHINE = { login: "aungshine@gmail.com", name: "Shine", owner: true };
const waiOrigin: UiTaskRequester = {
	v: 1,
	inputs: [{ kind: "owner", channel: "browser", id: "ri-12345678", person: "Wai" }],
};
const shineOrigin: UiTaskRequester = { v: 1, inputs: [{ kind: "owner", channel: "browser", id: "ri-abcdef12" }] };

const typed = (sentBy: typeof WAI | undefined): RequesterTurn => {
	const turn: RequesterTurn = {};
	collectRequesterInput(
		turn,
		requesterForAdmission({ cause: "browser", ownerChannel: "browser", inputId: "ri-11112222", sentBy }),
	);
	return turn;
};
const planDialog = { id: 1, kind: "confirm" as const, title: "Add this task?", args: ["The plan"] };
const task = (id: number, over: Partial<UiTaskQueueTask>): UiTaskQueueTask =>
	({
		id,
		plan: { title: `Task ${id}` },
		status: "stuck",
		question: "Which?",
		choices: ["A", "B"],
		...over,
	}) as UiTaskQueueTask;
const stuckOf = (origin: UiTaskRequester | undefined) => {
	const { wanted } = wantedStuckAsks([
		{
			file: "/q.jsonl",
			queue: { tasks: [task(1, origin ? { origin } : {})] } as unknown as UiTaskQueue,
			// The queue chat's own turn is Wai's here: a stuck card follows its task, never the chat's turn.
			meta: { conversationTitle: "Queue", sessionFile: "/q.jsonl", requester: "Wai" },
		},
	]);
	const w = wanted.get("/q.jsonl#1")!;
	return stuckAsk("stuck-1", { taskId: 1, taskTitle: "Task 1", question: w.question, choices: w.choices }, w.meta, 5);
};

describe("a Wai message, then queue_add: Wai's task and a plan dialog for Wai", () => {
	it("the typed message's sender sets the turn's person; Shine's (the owner) sets none", () => {
		const wai = requesterOfTurn(typed(WAI));
		expect(wai?.inputs).toEqual([{ kind: "owner", channel: "browser", id: "ri-11112222", person: "Wai" }]);
		expect(chatPersonOf(wai, undefined)).toBe("Wai");
		expect(requesterOfTurn(typed(SHINE))?.inputs).toEqual([{ kind: "owner", channel: "browser", id: "ri-11112222" }]);
		expect(chatPersonOf(requesterOfTurn(typed(SHINE)), waiOrigin)).toBeUndefined();
	});

	it("the plan-approval dialog is labelled for Wai on every web card", () => {
		const ask = dialogAsk("dlg-1", planDialog, { conversationTitle: "Ops lead", requester: "Wai" }, 5);
		expect(ask.requester).toBe("Wai");
		expect(ownerQuestionRouteView(ask)).toEqual({ requester: "Wai" });
		expect(dialogView(planDialog, ask)?.route).toEqual({ requester: "Wai" });
		expect(ownerQuestionRouteOf({ requester: "Wai" })).toEqual({ requester: "Wai" });
	});
});

describe("owner escalations follow the task's requester", () => {
	it("a Wai task's card is for Wai and nothing goes to plugins (Telegram)", () => {
		const ask = stuckOf(waiOrigin);
		expect(ask.requester).toBe("Wai");
		expect(ownerQuestionRouteView(ask)).toEqual({ requester: "Wai" });
		for (const type of ["appeared", "gone"] as const)
			expect(pluginSeesAskEvent({ type, ask, reason: "x" } as AskEvent)).toBe(false);
	});

	it("a Shine task, or one with no requester, is Shine's: it reaches Telegram as today", () => {
		for (const origin of [shineOrigin, undefined]) {
			const ask = stuckOf(origin);
			expect(ask.requester).toBeUndefined();
			expect(ownerQuestionRouteView(ask)).toEqual({ requester: "Shine" });
			expect(pluginSeesAskEvent({ type: "appeared", ask })).toBe(true);
		}
		expect(ownerQuestionRouteOf({ requester: "Shine", line: "Came through COO" })).toEqual({
			requester: "Shine",
			line: "Came through COO",
		});
	});
});

describe("message_role carries the sending turn's person", () => {
	const dirs: string[] = [];
	afterEach(() => {
		for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
	});
	const roles = ["coo", "backend"].map(
		(id) =>
			({
				id,
				title: id,
				homeChat: `/tmp/${id}/main.jsonl`,
				pastHomeChats: [],
				raw: {},
				dir: `/tmp/${id}`,
			}) as unknown as IdentityDef,
	);

	it("a Wai turn's message gives the receiving turn a Wai role input, so its queued task is Wai's", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "owner-requester-"));
		dirs.push(dir);
		const host: RoleMessageHost = {
			roles: () => roles,
			chatState: () => "idle",
			deliver: async () => ({ ok: true }),
			note: async () => ({ ok: true }),
			log: () => {},
		};
		const store = new RoleMessages(
			path.join(dir, "role-messages.jsonl"),
			host,
			() => 1_700_000_000_000,
			GUARD_POLICY_V1,
		);
		const sender = { role: "coo", title: "coo", chat: "home chat", file: "/tmp/coo/main.jsonl", handling: 0 };
		const sent = store.send({ ...sender, requester: "Wai" }, { to: "backend", kind: "request", text: "Build it" });
		const plain = store.send(sender, { to: "backend", kind: "request", text: "Build that" });
		store.stop();
		expect(sent.ok && plain.ok).toBe(true);
		if (!sent.ok || !plain.ok) return;
		expect(sent.record.requester).toBe("Wai");
		expect("requester" in plain.record).toBe(false);
		const input = roleRequesterInputOf(sent.record);
		expect(input).toMatchObject({ kind: "role", role: "coo", person: "Wai" });
		const turn: RequesterTurn = {};
		collectRequesterInput(
			turn,
			requesterForAdmission({ source: "extension", cause: "role", requester: input, inputId: "ri-x" }),
		);
		expect(requesterPersonOf(requesterOfTurn(turn))).toBe("Wai");
		expect(roleRequesterInputOf(plain.record)).not.toHaveProperty("person");
	});
});

describe("answers record who actually answered", () => {
	it("a page answer under Wai's socket records answeredBy Wai; for Wai's ask, routed web only", () => {
		const hub = new AskHub(() => 5);
		const events: AskEvent[] = [];
		hub.on((ev) => events.push(ev));
		const ask = dialogAsk("dlg-2", planDialog, { requester: "Wai" }, 5);
		hub.add(ask, () => ({ ok: true }));
		asAnswerer("Wai", () => hub.settle("dlg-2", { how: "answered", summary: "Yes", from: "browser" }));
		const answered = events.find((e) => e.type === "answered");
		expect(answered).toMatchObject({ type: "answered", by: "Wai" });
		if (answered?.type !== "answered") return;
		const record = answerRecord(answered.ask, answered, 9, "ops");
		expect(record).toMatchObject({
			answeredBy: "Wai",
			requester: "Wai",
			routedTo: "Wai (web only)",
			answeredIn: "browser",
		});
	});

	it("an answer with no known answerer records none; Shine's ask has no requester field (old shape)", () => {
		const ask = dialogAsk("dlg-3", planDialog, {}, 5);
		const record = answerRecord(ask, { summary: "Yes", from: "telegram" }, 9);
		expect(record).not.toHaveProperty("answeredBy");
		expect(record).not.toHaveProperty("requester");
		expect(record).not.toHaveProperty("routedTo");
	});
});

// qa #183 planted faults F16-F19, F23 (ops #1006): each assertion fails with its fault planted.
describe("person names, the turn's person and the answerer, at their edges", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("an 80-character name is a person; 81 is not (sent-by's maximum)", () => {
		expect(isPersonName("a".repeat(80))).toBe(true);
		expect(isPersonName("a".repeat(81))).toBe(false);
	});

	it("the latest input of a turn decides its person, not the first", () => {
		expect(
			requesterPersonOf({
				v: 1,
				inputs: [
					{ kind: "owner", channel: "browser", id: "ri-11111111" },
					{ kind: "owner", channel: "browser", id: "ri-22222222", person: "Wai" },
				],
			}),
		).toBe("Wai");
	});

	it("a running turn with only a role input takes that input's person over the task's", () => {
		const turn: UiTaskRequester = {
			v: 1,
			inputs: [{ kind: "role", role: "ops", id: "rm-12345678", message: "request", person: "Wai" }],
		};
		expect(chatPersonOf(turn, undefined)).toBe("Wai");
		expect(chatPersonOf(turn, shineOrigin)).toBe("Wai");
	});

	it("answeredBy is who answered, not whose ask it was", () => {
		expect(answerOwnerFields("Wai", "Shine")).toEqual({
			answeredBy: "Shine",
			requester: "Wai",
			routedTo: "Wai (web only)",
		});
	});

	it("a plugin (Telegram) answer runs as Shine", async () => {
		let seen: { by?: string } | undefined;
		vi.spyOn(askHub, "answer").mockImplementation((() => {
			seen = answeredBy();
			return Promise.resolve({ ok: true });
		}) as unknown as typeof askHub.answer);
		await pluginAnswer("ask-1", [], "telegram");
		expect(seen).toEqual({ by: "Shine" });
	});
});

describe("old records with no person are Shine's and parse unchanged", () => {
	it("requester records and a task chat's own entries", () => {
		const old = {
			v: 1,
			inputs: [
				{ kind: "owner", channel: "telegram", id: "ri-abcdef12" },
				{ kind: "role", role: "ops", id: "rm-abcdef12", message: "question" },
			],
		};
		expect(requesterOf(old)).toEqual(old);
		expect(requesterPersonOf(requesterOf(old))).toBeUndefined();
		expect(
			requesterOf({ v: 1, inputs: [{ kind: "owner", channel: "browser", id: "ri-12345678", person: "[x]" }] }),
		).toBeUndefined();
		const entry = (data: Record<string, unknown>): TaskQueueEntryLike =>
			({ type: "custom", customType: TASK_QUEUE_ENTRY_TYPE, data: { v: 1, ts: 1, ...data } }) as TaskQueueEntryLike;
		const plan = { title: "T", goal: "G" };
		const from = { file: "/q.jsonl", title: "Queue" };
		expect(ownTaskOf([entry({ op: "assigned", id: 3, plan, from })])?.origin).toBeUndefined();
		expect(ownTaskOf([entry({ op: "assigned", id: 3, plan, from, origin: waiOrigin })])?.origin).toEqual(waiOrigin);
	});
});
