// roles-answer: complete consent forms, conditional answers, and the real service's membership checks.
// Fixed synthetic asks only. No chat, provider, or live state is read.
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentService } from "../../server/agent-service.js";
import { askHub, type Ask, type AskField, type AskFieldAnswer } from "../../server/asks.js";
import type { UiRoleAsk, UiRolesOverview } from "../../server/protocol.js";
import { answersFromPage, askViewOf, roleAnswerKindAllowed } from "../../server/roles-asks.js";
import {
	projectRoleAsk,
	roleAnswerError,
	roleAnswerForm,
	roleAnswerGone,
	roleAnswerKindKey,
} from "../../web/src/roles-answer-model.js";

const field = (over: Partial<AskField> = {}): AskField => ({
	id: "pick",
	text: "Which setting?",
	options: [
		{ value: "alpha", label: "Alpha" },
		{ value: "beta", label: "Beta" },
	],
	multi: false,
	allowText: true,
	...over,
});
const fixture = (over: Partial<Ask> = {}): Ask => ({
	id: "roles-answer-test",
	kind: "question",
	title: "Fixture question",
	body: "The full goal, cost and limits.",
	createdAt: 100,
	sessionFile: "/private/fixture.jsonl",
	conversationId: "fixture-chat",
	fields: [field()],
	...over,
});
const alpha = [{ id: "pick", selected: ["alpha"] }];
const added = new Set<string>();
afterEach(() => {
	for (const id of added) askHub.settle(id, { how: "gone", reason: "fixture cleanup" });
	added.clear();
});

function branches(): Ask {
	return fixture({
		fields: [
			field({ id: "parent" }),
			field({
				id: "child",
				dependsOn: { questionId: "parent", value: "alpha" },
				optionsMap: { alpha: [{ value: "a-only", label: "Only for alpha" }] },
				allowText: false,
			}),
			field({ id: "grandchild", dependsOn: { questionId: "child" } }),
		],
	});
}

describe("a complete bounded ask", () => {
	it("preserves all decision text but closes over fields, excluding internal metadata", () => {
		const a = fixture({
			fields: [
				field({
					detail: "Every option's cost",
					header: "Details",
					options: [{ value: "alpha", label: "Alpha", description: "Costs $2", preview: "<b>plain text</b>" }],
				}),
			],
			toolCallId: "not-for-page",
		});
		const view = askViewOf(a)!;
		expect(view.fields).toEqual(a.fields);
		expect(view.body).toBe(a.body);
		expect(JSON.stringify(view)).not.toMatch(/private|fixture-chat|not-for-page/);
		expect(projectRoleAsk(view)).toEqual(view);
	});
	it.each(["approval", "other"])("refuses %s forms", (kind) => {
		expect(askViewOf(fixture({ kind: kind as Ask["kind"] }))).toBeNull();
	});
	it.each(
		[
			{ title: "x".repeat(501) },
			{ body: "x".repeat(64001) },
			{ title: "a\u202eb" },
			{ body: "Read /private/chat.jsonl first" },
			{ fields: [] },
			{ fields: [field(), field()] },
			{ fields: [field({ detail: "x".repeat(20001) })] },
			{
				fields: [
					field({
						options: [
							{ value: "x", label: "X" },
							{ value: "x", label: "Y" },
						],
					}),
				],
			},
			{ fields: [field({ dependsOn: { questionId: "later" } }), field({ id: "later" })] },
			{ fields: [field({ optionsMap: { alpha: [] } })] },
		].map((over, index) => ({ over, index })),
	)("refuses unsafe or incomplete form $index rather than clipping it", ({ over }) => {
		expect(askViewOf(fixture(over))).toBeNull();
	});
	it("refuses an aggregate oversized form and unsafe client input", () => {
		const long = fixture({
			fields: Array.from({ length: 10 }, (_, i) =>
				field({
					id: `f${i}`,
					detail: "d".repeat(20000),
					options: Array.from({ length: 30 }, (_, n) => ({
						value: `v${n}`,
						label: "l".repeat(500),
						preview: "p".repeat(4000),
					})),
				}),
			),
		});
		expect(askViewOf(long)).toBeNull();
		const view = askViewOf(fixture())!;
		expect(projectRoleAsk({ ...view, cut: true })).toBeNull();
		expect(projectRoleAsk({ ...view, revision: "wrong" })).toBeNull();
		expect(projectRoleAsk({ ...view, fields: [{ ...view.fields[0], detail: "a\u0000b" }] })).toBeNull();
	});
	it("binds revision to all wording, full package, choices and target, not unrelated metadata", () => {
		const a = fixture();
		const revision = askViewOf(a)!.revision;
		expect(askViewOf(fixture())!.revision).toBe(revision);
		for (const over of [
			{ body: "Changed cost" },
			{ createdAt: 101 },
			{ sessionFile: "/private/other.jsonl" },
			{ fields: [field({ options: [{ value: "alpha", label: "Changed" }] })] },
		]) {
			expect(askViewOf(fixture(over))!.revision).not.toBe(revision);
		}
	});
});

// pi-queue's plan pop-up: ctx.ui.confirm(title, "### Task #...") as dialogAsk builds it.
const plan = (title: string, over: Partial<Ask> = {}): Ask =>
	fixture({
		kind: "dialog",
		title,
		body: "### Task #12: Fixture plan\n\nGoal and limits.",
		fields: [
			field({
				id: "value",
				text: title,
				options: [
					{ value: "yes", label: "Yes" },
					{ value: "no", label: "No" },
				],
				allowText: false,
			}),
		],
		...over,
	});

describe("generic dialog policy", () => {
	it.each(["Add to the queue?", "Change task #1?", "Change task #12345?"])("keeps native plan %s", (title) => {
		const ask = plan(title);
		expect(roleAnswerKindAllowed(ask)).toBe(true);
		expect(askViewOf(ask)?.title).toBe(title);
	});
	// roles-small-fixes N1: an MCP form elicitation can build a plan title, but never pi-queue's confirm shape.
	it.each([
		["an elicitation select", { body: undefined, fields: [field({ id: "value", allowText: false })] }],
		["an elicitation input", { body: undefined, fields: [field({ id: "value", options: [], allowText: true })] }],
		["a body not from the queue", { body: "Pick a value" }],
		["no body", { body: undefined }],
		[
			"a typed answer",
			{
				fields: [
					field({
						id: "value",
						options: [
							{ value: "yes", label: "Yes" },
							{ value: "no", label: "No" },
						],
					}),
				],
			},
		],
		[
			"select-style yes/no labels",
			{
				fields: [
					field({
						id: "value",
						options: [
							{ value: "yes", label: "yes" },
							{ value: "no", label: "no" },
						],
						allowText: false,
					}),
				],
			},
		],
		["two fields", { fields: [...plan("x").fields, field({ id: "more", allowText: false })] }],
	] as [string, Partial<Ask>][])("keeps a plan title with %s in the original chat", (_, over) => {
		for (const title of ["Add to the queue?", "Change task #3?"]) {
			const ask = plan(title, over);
			expect(roleAnswerKindAllowed(ask)).toBe(false);
			expect(askViewOf(ask)).toBeNull();
		}
	});
	it.each([
		"MCP tool approval",
		"Trust project MCP servers?",
		"MCP sampling request",
		"MCP elicitation",
		"Authorize subagent spawn?",
		"Grant subagent spawn budget?",
		"Discard preserved subagent worktrees?",
		"Unrecognised dialog",
		"",
		"Add to the queue?\n",
		"Add to the queue? ",
		"Prefix Add to the queue?",
		"Change task #1?\n",
		"Change task #1?\r\n",
		"Change task #1? extra",
		"Change task #0?",
		"Change task #01?",
		"Change task #-1?",
		"Change task #١?",
	])("keeps %j in the original chat", (title) => {
		const ask = plan(title);
		expect(roleAnswerKindAllowed(ask)).toBe(false);
		expect(askViewOf(ask)).toBeNull();
	});
	it.each(["question", "stuck"] as const)("does not restrict ordinary %s titles", (kind) => {
		const ask = fixture({ kind, title: "Which option should we use?" });
		expect(roleAnswerKindAllowed(ask)).toBe(true);
		expect(askViewOf(ask)).not.toBeNull();
	});
	it("does not coerce a malformed dialog title", () => {
		expect(roleAnswerKindAllowed(fixture({ kind: "dialog", title: null as unknown as string }))).toBe(false);
	});
});

// roles-small-fixes N3: the dialog names the ask's kind and closes once its item leaves the list.
describe("answer dialog kind and departure", () => {
	const target = { answer: { key: "ops:question:a", id: "a" } };
	const listed = (over: Partial<{ tell: string; more: number; items: { answer?: { key: string; id: string } }[] }>) =>
		({ tell: "can-tell", more: 0, items: [target], ...over }) as Parameters<typeof roleAnswerGone>[0];
	it("names each kind the page can answer", () => {
		expect(roleAnswerKindKey("dialog")).toBe("raKindPlan");
		expect(roleAnswerKindKey("question")).toBe("raKindQuestion");
		expect(roleAnswerKindKey("stuck")).toBe("raKindStuck");
		const dialog = readFileSync(new URL("../../web/src/components/RoleAnswerDialog.tsx", import.meta.url), "utf8");
		expect(dialog).toContain("t(roleAnswerKindKey(view.kind))");
	});
	it("closes when the ask leaves a live, whole list", () => {
		expect(roleAnswerGone(listed({}), target, "ready")).toBe(false);
		for (const stage of ["loading", "ready", "error"] as const) {
			expect(roleAnswerGone(listed({ items: [] }), target, stage)).toBe(true);
			expect(roleAnswerGone(listed({ tell: "decision", items: [] }), target, stage)).toBe(true);
		}
		// Same key, another ask: the one opened is gone.
		expect(roleAnswerGone(listed({ items: [{ answer: { key: "ops:question:a", id: "b" } }] }), target, "ready")).toBe(
			true,
		);
	});
	it("stays open while sending, after sending, and when the list can't say", () => {
		expect(roleAnswerGone(listed({ items: [] }), target, "sending")).toBe(false);
		expect(roleAnswerGone(listed({ items: [] }), target, "sent")).toBe(false);
		for (const tell of ["not-live", "feed-error", "awaiting", "partial", "unknown"])
			expect(roleAnswerGone(listed({ tell, items: [] }), target, "ready")).toBe(false);
		expect(roleAnswerGone(listed({ more: 3, items: [] }), target, "ready")).toBe(false);
		expect(roleAnswerGone(listed({ items: [] }), {}, "ready")).toBe(false);
	});
});

describe("complete conditional answers, never defaults", () => {
	it("has no initial selection and accepts a picked or typed answer", () => {
		const view = askViewOf(fixture())!;
		expect(roleAnswerForm(view, new Map()).complete).toBe(false);
		expect(answersFromPage(alpha, view)).toEqual({ answers: alpha });
		expect(answersFromPage([{ id: "pick", selected: [], text: "My own answer" }], view)).toEqual({
			answers: [{ id: "pick", selected: [], text: "My own answer" }],
		});
	});
	it.each(
		[
			[],
			[{ id: "other", selected: ["alpha"] }],
			[{ id: "pick", selected: [] }],
			[{ id: "pick", selected: ["alpha", "beta"] }],
			[{ id: "pick", selected: ["alpha"], text: "also this" }],
			[{ id: "pick", selected: ["unknown"] }],
			[...alpha, ...alpha],
			[{ id: "pick", selected: [], text: "x".repeat(20001) }],
		].map((answers, index) => ({ answers, index })),
	)("rejects invalid answer $index", ({ answers }) => {
		expect(answersFromPage(answers, askViewOf(fixture())!)).toHaveProperty("error");
	});
	it("accepts only the visible branch; clears hidden descendants and changed options", () => {
		const view = askViewOf(branches())!;
		const valid = [
			{ id: "parent", selected: ["alpha"] },
			{ id: "child", selected: ["a-only"] },
			{ id: "grandchild", selected: [], text: "Final" },
		];
		expect(answersFromPage(valid, view)).toEqual({ answers: valid });
		expect(answersFromPage([{ id: "parent", selected: ["alpha"] }], view)).toHaveProperty("error");
		expect(answersFromPage([{ id: "parent", selected: ["beta"] }, ...valid.slice(1)], view)).toHaveProperty("error");
		const form = roleAnswerForm(
			view,
			new Map(valid.map((a) => [a.id, { selected: a.id === "parent" ? ["beta"] : a.selected, text: a.text ?? "" }])),
		);
		expect(form.complete).toBe(true);
		expect(form.shown).toHaveLength(1);
		expect(form.answers.slice(1)).toEqual([
			{ id: "child", selected: [] },
			{ id: "grandchild", selected: [] },
		]);
		expect(answersFromPage(form.answers, view)).toEqual({ answers: form.answers });
	});
	it("shows fixed failure messages, never server paths or hostile markup", () => {
		expect(roleAnswerError("read /private/a.jsonl <img> failed")).toBe("raUnavailable");
		expect(roleAnswerError("uncertain")).toBe("raUncertain");
	});
});

function service(ask: Ask = fixture()) {
	const item: UiRoleAsk = {
		key: "ops:question:fixture",
		role: "ops",
		kind: "question",
		text: "Question",
		chat: { file: ask.sessionFile!, where: "home" },
		focus: "question:fixture",
		askId: ask.id,
	};
	let items = [item];
	const svc = Object.create(AgentService.prototype) as AgentService;
	const read = vi.fn(async () => ({ asks: items }) as UiRolesOverview);
	svc.readRolesOverview = read;
	const deliver = vi.fn((answers: AskFieldAnswer[], from: string) => {
		askHub.settle(ask.id, { how: "answered", summary: "Fixture answer", from, answers });
		return { ok: true };
	});
	askHub.add(ask, deliver);
	added.add(ask.id);
	return {
		svc,
		item,
		deliver,
		read,
		setItems: (v: UiRoleAsk[]) => {
			items = v;
		},
	};
}
describe("real service lookup and delivery", () => {
	it("refuses a forbidden dialog even with a forged current overview target", async () => {
		const ask = fixture({ kind: "dialog", title: "Grant subagent spawn budget?" });
		const { svc, item, deliver } = service(ask);
		expect((await svc.rolesAskOpen(item.key)).ok).toBe(false);
		expect((await svc.rolesAskAnswer(item.key, ask.id, "0".repeat(64), alpha)).ok).toBe(false);
		expect(deliver).not.toHaveBeenCalled();
	});
	it("refuses an already-open plan after it becomes a forbidden dialog", async () => {
		const ask = plan("Add to the queue?");
		const { svc, item, deliver } = service(ask);
		const opened = await svc.rolesAskOpen(item.key);
		expect(opened.ok).toBe(true);
		if (!opened.ok) throw new Error("fixture did not open");
		ask.title = "Discard preserved subagent worktrees?";
		expect((await svc.rolesAskOpen(item.key)).ok).toBe(false);
		expect((await svc.rolesAskAnswer(item.key, opened.ask.id, opened.ask.revision, alpha)).ok).toBe(false);
		expect(deliver).not.toHaveBeenCalled();
	});
	it("opens without answering, delivers via the existing hub as browser exactly once", async () => {
		const { svc, item, deliver } = service();
		const opened = await svc.rolesAskOpen(item.key);
		expect(opened.ok).toBe(true);
		if (!opened.ok) throw new Error("fixture did not open");
		expect(deliver).not.toHaveBeenCalled();
		expect(await svc.rolesAskAnswer(item.key, opened.ask.id, opened.ask.revision, alpha)).toEqual({ ok: true });
		expect(deliver).toHaveBeenCalledExactlyOnceWith(alpha, "browser");
		expect((await svc.rolesAskAnswer(item.key, opened.ask.id, opened.ask.revision, alpha)).ok).toBe(false);
	});
	it("refuses duplicate items, absent membership and mismatched ask ids", async () => {
		const { svc, item, deliver, setItems } = service();
		const view = askViewOf(fixture())!;
		expect((await svc.rolesAskOpen("outside-the-roster")).ok).toBe(false);
		expect((await svc.rolesAskAnswer(item.key, "another-ask", view.revision, alpha)).ok).toBe(false);
		setItems([item, item]);
		expect((await svc.rolesAskOpen(item.key)).ok).toBe(false);
		setItems([]);
		expect((await svc.rolesAskAnswer(item.key, view.id, view.revision, alpha)).ok).toBe(false);
		expect(deliver).not.toHaveBeenCalled();
	});
	it("refuses a changed package or incomplete answer without delivering", async () => {
		const ask = fixture();
		const { svc, item, deliver } = service(ask);
		const old = askViewOf(ask)!;
		ask.body = "New cost, not what was read";
		expect((await svc.rolesAskAnswer(item.key, old.id, old.revision, alpha)).ok).toBe(false);
		const next = askViewOf(ask)!;
		expect((await svc.rolesAskAnswer(item.key, next.id, next.revision, [])).ok).toBe(false);
		expect(deliver).not.toHaveBeenCalled();
	});
});
