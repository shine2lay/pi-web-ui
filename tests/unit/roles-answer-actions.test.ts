/// <reference types="vite/client" />
// @vitest-environment jsdom
// Fixed public projection data only. No live sessions, prompts, model bodies, or answer submissions.
import { act, createElement, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LanguageProvider } from "../../web/src/i18n.js";
import { projectExactRoles, type ExactRoles } from "../../web/src/roles-exact-model.js";
import { createExactRolesView } from "../../web/src/roles-exact-view.js";
import { nativeDialogFocusMatches, questionAction, resolveQuestionAction } from "../../web/src/roles-answer-actions.js";
import { RolesUsefulContent } from "../../web/src/components/RolesUsefulView.js";
import { Dialog } from "../../web/src/components/Dialog.js";
import { projectUsefulRoles } from "../../web/src/roles-useful-model.js";
import type { SurfaceValue, SurfaceValues } from "../../web/src/roles-u0/types.js";

const send = vi.hoisted(() => vi.fn());
vi.mock("../../web/src/app-globals", () => ({ appSend: send }));
const NOW = Date.parse("2026-10-22T18:00:00Z");
const HOME = "/home/test/.pi/agent/sessions/fixture/ops-home.jsonl";
const TASK = "/home/test/.pi/agent/sessions/fixture/task-7.jsonl";
type Row = Record<string, unknown>;
const task = (extra: Row = {}) => ({ id: 7, status: "working", title: "Task", chat: { file: TASK }, ...extra });
const role = (extra: Row = {}) => ({
	id: "ops",
	title: "Ops",
	allChatsRead: true,
	homeChat: { file: HOME },
	...extra,
	queue: {
		active: [task()],
		queued: [],
		counts: { active: 1, queued: 0, done: 0 },
		...(extra.queue as Row | undefined),
	},
});
const ask = (n = 51, extra: Row = {}) => ({
	key: `ops:question:dlg-${n}`,
	role: "ops",
	kind: "question",
	text: `Native question ${n}`,
	since: NOW - n,
	chat: { file: HOME, where: "home" },
	focus: `question:dlg-${n}`,
	...extra,
});
const state = (asks: unknown[] = [ask()], roles: unknown[] = [role()], extra: Row = {}) => ({
	status: "ready",
	overview: { at: NOW, roles, asks, work: { initiatives: [], projects: [] } },
	checkedAt: NOW,
	heardAt: NOW,
	overviewReceivedAt: NOW,
	appliedAt: NOW,
	...extra,
});
const dialogs = [{ sessionFile: HOME, dialogId: 51 }];
const useful = (asks: unknown[] = [ask()], roles: unknown[] = [role()]) =>
	projectUsefulRoles(state(asks, roles), "open", NOW);
function object(value: SurfaceValue): SurfaceValues {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("expected object");
	return value;
}
function list(value: SurfaceValue): SurfaceValue[] {
	if (!Array.isArray(value)) throw new Error("expected list");
	return value;
}
function invoke(value: SurfaceValue) {
	if (typeof value !== "function") throw new Error("expected callback");
	value(document.body);
}
const language = (child: ReactNode) => createElement(LanguageProvider, null, child);
const cleanups: (() => void)[] = [];
beforeEach(() => vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true));
afterEach(() => {
	for (const clean of cleanups.splice(0)) clean();
	send.mockClear();
	document.body.replaceChildren();
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

describe("Roles answer actions: capability is separate from native navigation", () => {
	it.each(["Permission", "Trust", "Sampling", "Budget", "Deletion"])(
		"%s stays chat-only with the exact shown native id",
		(text) => {
			const model = useful([ask(51, { text })]);
			const item = model.needsYou.items[0];
			expect(item.answer).toBeUndefined();
			expect(item.chatAnswer).toEqual({ key: "ops:question:dlg-51" });
			expect(questionAction(model.needsYou, item, dialogs)).toEqual({ kind: "chat", target: item.link });
		},
	);
	it.each([
		ask(1, { key: "ops:question:q1", focus: "question:q1", askId: "q1" }),
		ask(1, { key: "ops:question:plan-1", focus: "question:plan-1", askId: "plan-1" }),
		ask(1, { key: "ops:task:7", kind: "task", focus: "task:7", askId: "stuck-7" }),
	])("retains the existing supported inline target ($key)", (raw) => {
		const needs = useful([raw]).needsYou;
		expect(needs.items[0].answer).toBeDefined();
		expect(needs.items[0].answer?.key).toBe(raw.key);
		expect(questionAction(needs, needs.items[0])).toEqual({ kind: "inline" });
	});
	it("supports exact recorded task and TL;DR handoffs, without guessing a question id", () => {
		for (const kind of ["task", "tldr"]) {
			const needs = useful(
				[ask(1, { kind, key: `ops:${kind}:7`, focus: `${kind}:7` })],
				[role({ queue: { active: [task({ status: kind === "task" ? "stuck" : "working" })] } })],
			).needsYou;
			expect(questionAction(needs, needs.items[0])).toEqual({ kind: "chat", target: needs.items[0].link });
		}
	});
	it("multiple native questions in one chat: only the actual shown oldest dialog gets an answer action", () => {
		const needs = useful([ask(51), ask(52)]).needsYou;
		expect(questionAction(needs, needs.items[0], dialogs).kind).toBe("chat");
		expect(questionAction(needs, needs.items[1], dialogs)).toEqual({ kind: "unavailable", reason: "native" });
		expect(questionAction(needs, needs.items[1], [{ sessionFile: HOME, dialogId: 52 }]).kind).toBe("chat");
	});
	it.each([
		{ summaries: [] },
		{ summaries: [dialogs[0], dialogs[0]] },
		{ summaries: [{ sessionFile: HOME, dialogId: 52 }] },
		{ summaries: [{ sessionFile: HOME, dialogId: NaN }] },
	])("unknown/duplicate/different dialog summary never claims an exact route (%j)", ({ summaries }) => {
		const needs = useful().needsYou;
		expect(questionAction(needs, needs.items[0], summaries)).toEqual({ kind: "unavailable", reason: "native" });
	});
	it.each([
		{ focus: undefined },
		{ focus: "question:dlg-99" },
		{ key: "ops:question:other" },
		{ chat: { file: HOME + "/../other.jsonl", where: "home" } },
		{ chat: { file: TASK, where: "home" } },
		{ role: "missing" },
		{ chat: null },
	])("rejects missing, mismatched or unsafe metadata (%j), preserving only safe Open chat navigation", (extra) => {
		const needs = useful([ask(51, extra)]).needsYou;
		expect(questionAction(needs, needs.items[0], dialogs).kind).toBe("unavailable");
	});
	it("duplicate canonical keys and duplicate exact destinations have no chat submission claim", () => {
		for (const rows of [
			[ask(), ask()],
			[ask(), ask(51, { role: "design", key: "design:question:dlg-51" })],
		]) {
			const needs = useful(rows, [role(), role({ id: "design", title: "Design" })]).needsYou;
			for (const item of needs.items) expect(questionAction(needs, item, dialogs).kind).toBe("unavailable");
		}
	});
	it.each([{ paused: true }, { withLead: "ops" }, { status: "done" }, { status: "dropped" }])(
		"does not offer native task answers for a held/closed/lead-only task (%j)",
		(extra) => {
			const needs = useful(
				[ask(1, { kind: "task", key: "ops:task:7", focus: "task:7" })],
				[role({ queue: { active: [task(extra)] } })],
			).needsYou;
			expect(questionAction(needs, needs.items[0], dialogs).kind).toBe("unavailable");
		},
	);
	it("checks a task-chat native question against the exact started task and pause state", () => {
		const raw = ask(51, { chat: { file: TASK, where: 7 } });
		const summaries = [{ sessionFile: TASK, dialogId: 51 }];
		const needs = useful([raw]).needsYou;
		expect(questionAction(needs, needs.items[0], summaries).kind).toBe("chat");
		const held = useful([raw], [role({ queue: { hold: "owner pause", active: [task()] } })]).needsYou;
		expect(questionAction(held, held.items[0], summaries).kind).toBe("unavailable");
	});
	it("offline, incomplete, unavailable or stale feeds are navigation-only", () => {
		for (const model of [
			projectUsefulRoles(state(), "closed", NOW),
			useful([ask()], [role({ allChatsRead: false })]),
			projectUsefulRoles(state([ask()], [role()], { appliedAt: null }), "open", NOW),
			projectUsefulRoles(state(), "open", NOW + 86_400_000),
		])
			expect(questionAction(model.needsYou, model.needsYou.items[0], dialogs).kind).toBe("unavailable");
	});
	it("retained actions resolve by identity through reorder, but not disappearance, reuse or a changed native head", () => {
		const original = useful([ask(51), ask(52)]).needsYou.items[0];
		const reordered = useful([ask(52), ask(51)]).needsYou;
		expect(resolveQuestionAction(reordered, original, dialogs, "chat")?.item.text).toBe("Native question 51");
		for (const next of [
			useful([]).needsYou,
			useful([ask(51, { since: NOW })]).needsYou,
			useful([ask(), ask()]).needsYou,
		])
			expect(resolveQuestionAction(next, original, dialogs, "chat")).toBeNull();
		expect(resolveQuestionAction(reordered, original, [{ sessionFile: HOME, dialogId: 52 }], "chat")).toBeNull();
		expect(
			resolveQuestionAction(projectUsefulRoles(state(), "closed", NOW).needsYou, original, dialogs, "chat"),
		).toBeNull();
	});
	it("arrival matches file AND native dialog id; there is no prefix, index, unsafe-number or ordinary-question fallback", () => {
		const focus = { file: HOME, kind: "question" as const, id: "dlg-51", seq: 1, at: NOW };
		expect(nativeDialogFocusMatches(focus, HOME, 51)).toBe(true);
		for (const [file, id] of [
			[TASK, 51],
			[HOME, 52],
			[HOME, undefined],
			[HOME, NaN],
		] as const)
			expect(nativeDialogFocusMatches(focus, file, id)).toBe(false);
		expect(nativeDialogFocusMatches({ ...focus, id: "q1" }, HOME, 51)).toBe(false);
	});
});

describe("both Roles surfaces use the same current-action policy", () => {
	it("exact inbox and department detail expose the chat action; retained callbacks re-resolve before navigation", () => {
		let model: ExactRoles = projectExactRoles(state([ask(51), ask(52)]), "open", NOW);
		let summaries = dialogs;
		const open = vi.fn();
		vi.useFakeTimers();
		const view = createExactRolesView(
			() => model,
			{ open, about: vi.fn(), answer: vi.fn(), dialogs: () => summaries, reload: vi.fn() },
			{
				raf: (fn) => setTimeout(fn, 0),
				cancelRaf: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
				setTimeout: (fn, ms) => setTimeout(fn, ms),
				clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
			},
			vi.fn(),
		);
		cleanups.push(() => view.dispose());
		const inbox = list(view.values(1400, 780).inbox);
		const buttons = list(object(inbox[0]).choices).map(object);
		expect(buttons.map((button) => button.label)).toEqual(["Answer in chat", "Open chat"]);
		expect(list(object(inbox[1]).choices).map((button) => object(button).label)).toEqual(["Open chat"]);
		view.openRole("ops");
		const detail = list(object(view.values(1400, 780).ex).decisions).map(object);
		expect(list(detail[0].choices).map((button) => object(button).label)).toContain("Answer in chat");
		model = projectExactRoles(state([ask(52), ask(51)]), "open", NOW);
		invoke(buttons[0].pick);
		expect(open).toHaveBeenCalledExactlyOnceWith({ file: HOME, focus: { kind: "question", id: "dlg-51" } });
		summaries = [{ sessionFile: HOME, dialogId: 52 }];
		invoke(buttons[0].pick);
		expect(open).toHaveBeenCalledTimes(1);
		model = projectExactRoles(state([]), "open", NOW);
		invoke(buttons[0].pick);
		expect(open).toHaveBeenCalledTimes(1);
	});
	it("shared phone/department question rows have explicit actions, and disconnect removes them", async () => {
		const host = document.createElement("div");
		document.body.append(host);
		const root = createRoot(host);
		cleanups.push(() => act(() => root.unmount()));
		const open = vi.fn();
		const answer = vi.fn();
		const render = (connection: "open" | "closed") =>
			act(() =>
				root.render(
					language(
						createElement(RolesUsefulContent, {
							model: projectUsefulRoles(state(), connection, NOW),
							dialogs,
							phone: true,
							now: NOW,
							onOpen: open,
							onAnswer: answer,
						}),
					),
				),
			);
		await render("open");
		const button = Array.from(host.querySelectorAll("button")).find((el) =>
			el.textContent?.startsWith("Answer in chat"),
		)!;
		expect(button).toBeTruthy();
		await act(() => button.click());
		expect(open).toHaveBeenCalledExactlyOnceWith({ file: HOME, focus: { kind: "question", id: "dlg-51" } });
		expect(answer).not.toHaveBeenCalled();
		expect(send).not.toHaveBeenCalled();
		await render("closed");
		expect(host.textContent).not.toContain("Answer in chat");
		expect(host.textContent).toContain("Current questions are not confirmed");
	});
	it("native arrival focuses a non-submitting container, preserves full context, and leaves keyboard/escape native", async () => {
		const host = document.createElement("div");
		document.body.append(host);
		const root = createRoot(host);
		cleanups.push(() => act(() => root.unmount()));
		const full = `Permission context ${"complete detail ".repeat(600)} END-OF-CONTEXT`;
		await act(() =>
			root.render(
				language(
					createElement(Dialog, {
						dialog: { id: 51, kind: "confirm", title: "Permission", args: [full] },
						focusRequest: 1,
					}),
				),
			),
		);
		expect(document.activeElement).toBe(host.querySelector(".dialog-inline"));
		expect(host.textContent).toContain("END-OF-CONTEXT");
		expect(send).not.toHaveBeenCalled();
		await act(() =>
			document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })),
		);
		expect(send).not.toHaveBeenCalled();
		await act(() => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
		expect(send).toHaveBeenCalledExactlyOnceWith({ type: "dialog_response", id: 51, value: null });
	});
});
