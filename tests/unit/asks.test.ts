/**
 * telegram-answers: server/asks.ts — the process-wide list of what chats wait on you for, and how
 * each kind (question, pop-up, permission prompt, stuck queued task) is described and answered.
 */
import { describe, expect, it, vi } from "vitest";
import {
	AskHub,
	approvalAsk,
	approvalFrom,
	checkAnswers,
	describeToolCall,
	dialogAsk,
	dialogValueFrom,
	NOT_WAITING,
	questionAnswersFrom,
	questionAsk,
	stuckAsk,
	stuckTextFrom,
	summarizeApproval,
	summarizeDialogValue,
	summarizeQuestionAnswers,
	type Ask,
	type AskEvent,
} from "../../server/asks.js";
import type { UiDialog, UiQuestion } from "../../server/protocol.js";

const meta = { conversationId: "c1", conversationTitle: "My chat", cwd: "/p", sessionFile: "/s/a.jsonl" };

const simple = (id = "a1"): Ask => ({
	id,
	kind: "question",
	createdAt: 1,
	title: "Q",
	fields: [
		{
			id: "q1",
			text: "Pick",
			options: [
				{ value: "A", label: "A" },
				{ value: "B", label: "B" },
			],
			multi: false,
			allowText: true,
		},
	],
});

describe("AskHub", () => {
	it("tells listeners when an ask appears, is answered and is gone; list shows what waits", () => {
		const hub = new AskHub();
		const events: AskEvent[] = [];
		const off = hub.on((e) => events.push(e));
		expect(hub.listening).toBe(true);
		expect(hub.add(simple("a1"), () => ({ ok: true }))).toBe(true);
		expect(hub.add(simple("a1"), () => ({ ok: true }))).toBe(false);
		hub.add(simple("a2"), () => ({ ok: true }));
		expect(hub.list().map((a) => a.id)).toEqual(["a1", "a2"]);
		hub.settle("a1", { how: "answered", summary: "A", from: "browser" });
		hub.settle("a2", { how: "gone", reason: "closed" });
		hub.settle("a2", { how: "gone", reason: "closed" });
		expect(events.map((e) => e.type)).toEqual(["appeared", "appeared", "answered", "gone"]);
		expect(events[2]).toMatchObject({ summary: "A", from: "browser", ask: { id: "a1" } });
		expect(events[3]).toMatchObject({ reason: "closed", ask: { id: "a2" } });
		expect(hub.list()).toEqual([]);
		off();
		expect(hub.listening).toBe(false);
	});

	it("passes a fitting answer to the owner, with who answered; refuses what doesn't fit or no longer waits", async () => {
		const hub = new AskHub();
		const onAnswer = vi.fn(() => ({ ok: true }));
		hub.add(simple("a1"), onAnswer);
		expect(await hub.answer("a1", [{ id: "q1", selected: ["C"] }], "telegram")).toEqual({
			ok: false,
			error: "not a choice: C",
		});
		expect(await hub.answer("a1", [{ id: "q1", selected: ["A", "B"] }], "telegram")).toMatchObject({ ok: false });
		expect(await hub.answer("a1", [{ id: "q1", selected: [] }], "telegram")).toEqual({ ok: false, error: "no answer" });
		expect(onAnswer).not.toHaveBeenCalled();
		expect(await hub.answer("a1", [{ id: "q1", selected: ["B"] }], "telegram")).toEqual({ ok: true });
		expect(onAnswer).toHaveBeenCalledWith([{ id: "q1", selected: ["B"] }], "telegram");
		expect(await hub.answer("nope", [{ id: "q1", selected: ["B"] }], "telegram")).toEqual({
			ok: false,
			error: NOT_WAITING,
		});
	});

	it("an owner that throws gives an error, not a crash; a throwing listener doesn't stop the others", async () => {
		const hub = new AskHub();
		const seen: string[] = [];
		hub.on(() => {
			throw new Error("boom");
		});
		hub.on((e) => seen.push(e.type));
		const err = vi.spyOn(console, "error").mockImplementation(() => {});
		hub.add(simple("a1"), () => {
			throw new Error("broken");
		});
		expect(await hub.answer("a1", [{ id: "q1", selected: ["A"] }], "x")).toEqual({ ok: false, error: "broken" });
		expect(seen).toEqual(["appeared"]);
		err.mockRestore();
	});

	it("checkAnswers: typed text only where it's accepted; choices from optionsMap count", () => {
		const ask: Ask = {
			...simple(),
			fields: [
				{
					id: "f",
					text: "t",
					options: [],
					multi: false,
					allowText: false,
					optionsMap: { x: [{ value: "X1", label: "X1" }] },
				},
			],
		};
		expect(checkAnswers(ask, [{ id: "f", selected: [], text: "hi" }])).toMatch(/typed/);
		expect(checkAnswers(ask, [{ id: "f", selected: ["X1"] }])).toBeNull();
		expect(checkAnswers(ask, [{ id: "zz", selected: ["X1"] }])).toMatch(/unknown field/);
	});
});

describe("questions (ask_user_question)", () => {
	const questions: UiQuestion[] = [
		{
			id: "lang",
			header: "Language",
			question: "Which?",
			options: [{ label: "TS", description: "typed" }, { label: "Go" }],
		},
		{
			id: "extra",
			question: "Extras?",
			multiSelect: true,
			options: [{ label: "lint" }, { label: "tests" }],
			dependsOn: { questionId: "lang", value: "TS" },
			optionsMap: { TS: [{ label: "tsc" }] },
		},
	];

	it("each question becomes a field; labels are the values; typed answers allowed", () => {
		const ask = questionAsk("q-1", questions, meta, 5);
		expect(ask).toMatchObject({
			id: "q-1",
			kind: "question",
			createdAt: 5,
			title: "2 questions",
			conversationTitle: "My chat",
		});
		expect(ask.fields[0]).toEqual({
			id: "lang",
			header: "Language",
			text: "Which?",
			options: [
				{ value: "TS", label: "TS", description: "typed" },
				{ value: "Go", label: "Go" },
			],
			multi: false,
			allowText: true,
		});
		expect(ask.fields[1]).toMatchObject({ multi: true, dependsOn: { questionId: "lang", value: "TS" } });
		expect(ask.fields[1]?.optionsMap).toEqual({ TS: [{ value: "tsc", label: "tsc" }] });
		expect(questionAsk("q-2", [questions[0]!], meta).title).toBe("Language");
	});

	it("answers come back in the page's shape, every question listed; the summary reads well", () => {
		const answers = questionAnswersFrom(questions, [
			{ id: "lang", selected: ["TS"] },
			{ id: "extra", selected: ["tsc"], text: " more " },
		]);
		expect(answers).toEqual([
			{ id: "lang", selected: ["TS"] },
			{ id: "extra", selected: ["tsc"], custom: "more" },
		]);
		expect(questionAnswersFrom(questions, [{ id: "lang", selected: ["Go"] }])[1]).toEqual({
			id: "extra",
			selected: [],
		});
		expect(summarizeQuestionAnswers(questions, answers)).toBe("Language: TS; Extras?: tsc, more");
		expect(summarizeQuestionAnswers([questions[0]!], [{ id: "lang", selected: [], custom: "Rust" }])).toBe("Rust");
	});
});

describe("pop-ups (ctx.ui select / confirm / input)", () => {
	it("select: its options, no typed answer", () => {
		const ui: UiDialog = { id: 7, kind: "select", title: "Pick one", args: [["red", "green"]] };
		const ask = dialogAsk("dlg-7", ui, meta);
		expect(ask.fields[0]).toMatchObject({ options: [{ value: "red" }, { value: "green" }], allowText: false });
		expect(dialogValueFrom(ui, [{ id: "value", selected: ["green"] }])).toBe("green");
		expect(summarizeDialogValue(ui, "green")).toBe("green");
	});

	it("confirm: the message is the body; Yes / No give true / false", () => {
		const ui: UiDialog = { id: 8, kind: "confirm", title: "Approve plan?", args: ["# Plan\nsteps"] };
		const ask = dialogAsk("dlg-8", ui, meta);
		expect(ask.body).toBe("# Plan\nsteps");
		expect(ask.fields[0]?.options.map((o) => o.label)).toEqual(["Yes", "No"]);
		expect(dialogValueFrom(ui, [{ id: "value", selected: ["yes"] }])).toBe(true);
		expect(dialogValueFrom(ui, [{ id: "value", selected: ["no"] }])).toBe(false);
		expect(summarizeDialogValue(ui, false)).toBe("No");
	});

	it("input: a typed answer only", () => {
		const ui: UiDialog = { id: 9, kind: "input", title: "Name?", args: ["e.g. Bob"] };
		const ask = dialogAsk("dlg-9", ui, meta);
		expect(ask.fields[0]).toMatchObject({ options: [], allowText: true, detail: "e.g. Bob" });
		expect(dialogValueFrom(ui, [{ id: "value", selected: [], text: "Ann" }])).toBe("Ann");
	});
});

describe("permission prompts", () => {
	it("the page's choices; 'this kind' only with a category; the command is the body", () => {
		const ask = approvalAsk(
			"appr-1",
			{
				toolName: "bash",
				params: { command: "rm -rf build" },
				reasonEn: "Deletes files",
				category: { id: "rm", label: "删除", labelEn: "Delete files" },
			},
			meta,
		);
		expect(ask.title).toBe("Allow bash?");
		expect(ask.body).toBe("rm -rf build");
		expect(ask.fields[0]?.options.map((o) => o.value)).toEqual(["approve", "category", "all", "deny"]);
		expect(ask.fields[0]?.options[1]?.description).toBe("Delete files");
		const plain = approvalAsk("appr-2", { toolName: "write", params: { path: "/etc/x" } }, meta);
		expect(plain.fields[0]?.options.map((o) => o.value)).toEqual(["approve", "all", "deny"]);
		expect(plain.body).toBe("/etc/x");
	});

	it("answers map to decision and scope", () => {
		expect(approvalFrom([{ id: "decision", selected: ["approve"] }])).toEqual({ decision: "approve", scope: "once" });
		expect(approvalFrom([{ id: "decision", selected: ["category"] }])).toEqual({
			decision: "approve",
			scope: "category",
		});
		expect(approvalFrom([{ id: "decision", selected: ["all"] }])).toEqual({ decision: "approve", scope: "all" });
		expect(approvalFrom([{ id: "decision", selected: ["deny"] }])).toEqual({ decision: "deny" });
		expect(approvalFrom([{ id: "decision", selected: ["x"] }])).toBeUndefined();
		expect(summarizeApproval("deny")).toBe("Denied");
		expect(summarizeApproval("approve", "once")).toBe("Approved");
		expect(summarizeApproval("approve", "all")).toMatch(/everything/);
	});

	it("describeToolCall: command, path, else the parameters", () => {
		expect(describeToolCall("bash", { command: "ls" })).toBe("ls");
		expect(describeToolCall("edit", { file_path: "/a" })).toBe("/a");
		expect(describeToolCall("x", { a: 1 })).toContain('"a": 1');
	});
});

describe("stuck queued tasks", () => {
	it("the question with its choices, and a typed answer; the answer text is what goes into the chat", () => {
		const ask = stuckAsk(
			"stuck:/s/t.jsonl#3",
			{ taskId: 3, taskTitle: "Ship it", question: "Which branch?", choices: ["main", "dev", " "] },
			meta,
		);
		expect(ask.title).toBe("Task #3 needs you: Ship it");
		// The task's number and title, for a messenger that shows them apart (the Telegram plugin).
		expect(ask.task).toEqual({ id: 3, title: "Ship it" });
		expect(ask.fields[0]).toMatchObject({ text: "Which branch?", allowText: true, multi: false });
		expect(ask.fields[0]?.options.map((o) => o.value)).toEqual(["main", "dev"]);
		expect(stuckTextFrom([{ id: "answer", selected: ["dev"] }])).toBe("dev");
		expect(stuckTextFrom([{ id: "answer", selected: [], text: " my own " }])).toBe("my own");
	});
});
