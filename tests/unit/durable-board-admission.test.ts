// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { BoardForm, BoardCloseForm } from "../../web/src/components/RolesView";
import { LanguageProvider } from "../../web/src/i18n";
import { setAppSend } from "../../web/src/app-globals";
import { setAppAdmit } from "../../web/src/app-admit";
import {
	BOARD_ANSWER_MS,
	boardRequest,
	createBoardDraft,
	reviseBoardDraft,
	getBoardAdmissionSource,
	getBoardDraftRecoveries,
	restoreBoardDraft,
	receiveBoardResult,
	resetBoardDrafts,
	watchRoles,
	reloadRoles,
	resendRolesWatch,
	type BoardDraftForm,
	type BoardDraftSource,
	type BoardResult,
} from "../../web/src/roles-state";
import type { ClientMessage, UiBoardPost } from "../../web/src/types";

type Wire = Extract<ClientMessage, { type: "board_post" | "board_close" }>;
const postForm = {
	type: "board_post",
	kind: "order",
	toAll: true,
	picked: ["temper", "ops"],
	title: "  Title é 🌈  ",
	text: "  body é 🌈\nsecond line\t  ",
} as const;
const closeForm = { type: "board_close", id: "bp-fixture-A", note: "  note é 🌈\t  " } as const;
const unknown = "no answer from the server: look at the board before trying again";
const post = (id = "bp-fixture-A") =>
	({
		id,
		kind: "news",
		title: "Fixture",
		text: "Fixture",
		to: ["all"],
		at: 1,
		from: "owner",
		sent: {},
		read: {},
		done: {},
	}) as UiBoardPost;
function wire(form: BoardDraftForm) {
	return form.type === "board_post"
		? {
				type: form.type,
				kind: form.kind,
				to: form.toAll ? ("all" as const) : [...form.picked].sort(),
				title: form.title.trim(),
				text: form.text.trim(),
			}
		: { type: form.type, id: form.id, ...(form.note.trim() ? { note: form.note.trim() } : {}) };
}
function deferred() {
	let resolve!: (value: boolean) => void;
	let reject!: (reason: unknown) => void;
	const promise = new Promise<boolean>((yes, no) => {
		resolve = yes;
		reject = no;
	});
	return { promise, resolve, reject };
}
let root: Root | null = null,
	container: HTMLDivElement;
let messages: Wire[], sent: ClientMessage[], sources: (BoardDraftSource | undefined)[];
function admit(fn: (m: Wire) => Promise<boolean>) {
	setAppAdmit((m) => {
		messages.push(m as Wire);
		sources.push(getBoardAdmissionSource(m));
		return fn(m as Wire);
	});
}
function result(m = messages.at(-1)!, patch: Partial<BoardResult> = {}) {
	return {
		type: "board_result",
		reqId: m.reqId,
		op: m.type === "board_post" ? "post" : "close",
		ok: true,
		id: m.type === "board_close" ? m.id : "bp-created",
		direct: ["ops"],
		later: ["qa"],
		...patch,
	} as BoardResult;
}
const tick = async () => {
	await act(async () => {
		await Promise.resolve();
	});
};
beforeEach(() => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	resetBoardDrafts();
	messages = [];
	sent = [];
	sources = [];
	setAppAdmit(null);
	setAppSend((m) => {
		sent.push(m);
		return true;
	});
	container = document.createElement("div");
	document.body.append(container);
});
afterEach(() => {
	if (root) act(() => root!.unmount());
	root = null;
	resetBoardDrafts();
	setAppSend(null);
	setAppAdmit(null);
	document.body.replaceChildren();
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

function mount(kind: "post" | "close" = "post", onDone = vi.fn(), id = "bp-fixture-A") {
	root ??= createRoot(container);
	act(() =>
		root!.render(
			createElement(
				LanguageProvider,
				null,
				kind === "post"
					? createElement(BoardForm, { roleIds: ["qa", "ops", "temper"], onDone })
					: createElement(BoardCloseForm, { post: post(id), onDone }),
			),
		),
	);
	return onDone;
}
function click(selector: string) {
	const el = container.querySelector<HTMLElement>(selector);
	if (!el) throw new Error(`missing ${selector}`);
	act(() => el.click());
}
function fill(name: string, value: string) {
	const el = container.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[name="${name}"]`);
	if (!el) throw new Error(`missing ${name}`);
	const prototype = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
	act(() => {
		Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(el, value);
		el.dispatchEvent(new Event("input", { bubbles: true }));
	});
}
function submit() {
	act(() => container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
}
function authored(kind: "post" | "close" = "post") {
	if (kind === "close") {
		fill("note", closeForm.note);
		return;
	}
	click('[name="rv-bkind"][value="order"]');
	click('[name="rv-bto"]:not(:checked)');
	click('input[type="checkbox"][value="temper"]');
	click('input[type="checkbox"][value="ops"]');
	click('[name="rv-bto"]:not(:checked)');
	fill("title", postForm.title);
	fill("text", postForm.text);
}
function value(name: string) {
	return container.querySelector<HTMLInputElement>(`[name="${name}"]`)?.value;
}
function attempts() {
	return getBoardDraftRecoveries().flatMap((r) => r.attempts);
}
function original(form: BoardDraftForm) {
	expect(attempts()).toHaveLength(1);
	expect(attempts()[0].source.form).toEqual(form);
	expect(attempts()[0].reqId).toBeTruthy();
}

describe("Board source and actual operation result store", () => {
	for (const form of [postForm, closeForm]) {
		it(`${form.type}: captures independent immutable raw source and canonical wire before await`, async () => {
			const gate = deferred();
			admit(() => gate.promise);
			const mutable =
				form.type === "board_post"
					? { ...form, title: String(form.title), picked: [...form.picked] as string[] }
					: { ...form, note: String(form.note) };
			const source = createBoardDraft(mutable);
			const request = boardRequest(wire(source.form), source);
			expect(sources[0]).toEqual(source);
			expect(messages[0]).toEqual({ ...wire(form), reqId: expect.any(String) });
			original(form);
			if (mutable.type === "board_post") {
				mutable.title = "mutated";
				mutable.picked.push("qa");
			} else mutable.note = "mutated";
			expect(source.form).toEqual(form);
			expect(Object.isFrozen(source)).toBe(true);
			expect(Object.isFrozen(source.form)).toBe(true);
			expect(Object.isFrozen(messages[0])).toBe(true);
			if (source.form.type === "board_post") {
				expect(Object.isFrozen(source.form.picked)).toBe(true);
				if (messages[0].type === "board_post" && Array.isArray(messages[0].to))
					expect(Object.isFrozen(messages[0].to)).toBe(true);
			}
			expect(getBoardAdmissionSource({ ...messages[0] })).toBeUndefined();
			expect(getBoardAdmissionSource({ type: "roles_watch", full: true })).toBeUndefined();
			gate.resolve(true);
			await Promise.resolve();
			receiveBoardResult(result());
			expect((await request).ok).toBe(true);
			expect(sent).toEqual([]);
		});
		for (const mode of ["false", "unbound", "reject", "throw", "truthy", "committed"]) {
			it(`${form.type}: ${mode} never falls back or reports actual success`, async () => {
				if (mode !== "unbound")
					admit(() => {
						if (mode === "throw") throw new Error("synthetic throw");
						if (mode === "reject" || mode === "committed")
							return Promise.reject(
								Object.assign(new Error("synthetic rejection"), { payloadCommitted: mode === "committed" }),
							);
						return Promise.resolve((mode === "truthy" ? { ok: true } : false) as boolean);
					});
				const source = createBoardDraft(form);
				const res = await boardRequest(wire(form), source);
				expect(res.ok).toBe(false);
				expect(res.error).toContain("look at the board before trying again");
				original(form);
				expect(sent).toEqual([]);
			});
		}
		it(`${form.type}: local true alone remains pending until actual result`, async () => {
			admit(() => Promise.resolve(true));
			let done = false;
			const p = boardRequest(wire(form), createBoardDraft(form)).then((r) => {
				done = true;
				return r;
			});
			await tick();
			expect(done).toBe(false);
			receiveBoardResult(result());
			expect((await p).ok).toBe(true);
			original(form);
		});
		for (const accepted of [true, false])
			it(`${form.type}: early actual success cannot outrun admission ${accepted}`, async () => {
				const gate = deferred();
				admit(() => gate.promise);
				let done = false;
				const p = boardRequest(wire(form), createBoardDraft(form)).then((r) => {
					done = true;
					return r;
				});
				receiveBoardResult(result());
				await tick();
				expect(done).toBe(false);
				gate.resolve(accepted);
				expect((await p).ok).toBe(accepted);
				original(form);
			});
		it(`${form.type}: missing/wrong-op/stale/malformed/duplicate results cannot steal operation`, async () => {
			admit(() => Promise.resolve(true));
			let done = false;
			const p = boardRequest(wire(form), createBoardDraft(form)).then((r) => {
				done = true;
				return r;
			});
			await tick();
			for (const patch of [
				{ reqId: undefined },
				{ reqId: "old-id" },
				{ op: form.type === "board_post" ? ("close" as const) : ("post" as const) },
				{ id: "" },
				{ id: undefined },
				{ ok: "true" as unknown as boolean },
				{ direct: 1 as unknown as string[] },
				{ later: [1] as unknown as string[] },
			]) {
				receiveBoardResult(result(undefined, patch));
				await tick();
				expect(done).toBe(false);
			}
			if (form.type === "board_close") {
				receiveBoardResult(result(undefined, { id: "bp-wrong" }));
				await tick();
				expect(done).toBe(false);
			}
			const actual = result();
			receiveBoardResult(actual);
			receiveBoardResult(result(undefined, { ok: false, error: "duplicate" }));
			expect(await p).toEqual(actual);
		});
		it(`${form.type}: unchanged timeout is truthful, late admission/result cannot revive it`, async () => {
			vi.useFakeTimers();
			const gate = deferred();
			admit(() => gate.promise);
			const p = boardRequest(wire(form), createBoardDraft(form));
			await vi.advanceTimersByTimeAsync(BOARD_ANSWER_MS - 1);
			expect(attempts()[0].result).toBeUndefined();
			await vi.advanceTimersByTimeAsync(1);
			expect(await p).toMatchObject({ ok: false, error: unknown });
			gate.resolve(true);
			await Promise.resolve();
			receiveBoardResult(result());
			expect(attempts()[0].result).toMatchObject({ ok: false, error: unknown });
			original(form);
		});
		it(`${form.type}: early success cannot outrun rejected admission`, async () => {
			const gate = deferred();
			admit(() => gate.promise);
			const p = boardRequest(wire(form), createBoardDraft(form));
			receiveBoardResult(result());
			gate.reject(new Error("synthetic rejection after server reply"));
			expect((await p).ok).toBe(false);
			original(form);
			expect(sent).toEqual([]);
		});
		it(`${form.type}: synchronous result inside the actual registered handler is not lost`, async () => {
			admit((m) => {
				receiveBoardResult(result(m));
				return Promise.resolve(true);
			});
			const p = boardRequest(wire(form), createBoardDraft(form));
			expect((await p).ok).toBe(true);
			original(form);
		});
		it(`${form.type}: early failure wins once and actual failure does not require id`, async () => {
			const gate = deferred();
			admit(() => gate.promise);
			const p = boardRequest(wire(form), createBoardDraft(form));
			const failed = result(undefined, { ok: false, id: undefined, error: "synthetic refusal" });
			receiveBoardResult(failed);
			receiveBoardResult(result());
			gate.resolve(true);
			expect(await p).toEqual(failed);
			original(form);
		});
	}
	it("wire conversion retains inactive picks, insertion order and whitespace only in source", async () => {
		admit(() => Promise.resolve(false));
		const form = { ...postForm, toAll: false, picked: ["temper", "ops"] };
		await boardRequest(wire(form), createBoardDraft(form));
		expect(messages[0]).toMatchObject({
			to: ["ops", "temper"],
			title: postForm.title.trim(),
			text: postForm.text.trim(),
		});
		expect(sources[0]?.form).toEqual(form);
	});
	it.each(["", " \t "])("empty/whitespace close note %j remains raw although existing wire omits it", async (note) => {
		admit(() => Promise.resolve(false));
		const form = { ...closeForm, note };
		await boardRequest(wire(form), createBoardDraft(form));
		expect(messages[0]).not.toHaveProperty("note");
		original(form);
	});
	it("new attempts have distinct real correlations; prior/duplicate result cannot finish retry", async () => {
		admit(() => Promise.resolve(true));
		const source = createBoardDraft(postForm);
		const p1 = boardRequest(wire(postForm), source);
		await tick();
		const first = messages[0];
		receiveBoardResult(result(first, { ok: false, error: "no" }));
		await p1;
		let done = false;
		const p2 = boardRequest(wire(postForm), source).then((r) => {
			done = true;
			return r;
		});
		await tick();
		expect(messages[1].reqId).not.toBe(first.reqId);
		receiveBoardResult(result(first));
		await tick();
		expect(done).toBe(false);
		receiveBoardResult(result(messages[1]));
		expect((await p2).ok).toBe(true);
	});
	it("roles watchers/reload/reconnect remain transient sync sends without a journal", () => {
		const stop = watchRoles(true);
		reloadRoles();
		resendRolesWatch();
		stop();
		expect(sent.map((m) => m.type)).toEqual(["roles_watch", "roles_watch", "roles_watch", "roles_unwatch"]);
		expect(messages).toEqual([]);
		expect(getBoardDraftRecoveries()).toEqual([]);
	});
});

describe("real editable Board forms", () => {
	for (const kind of ["post", "close"] as const) {
		const form = kind === "post" ? postForm : closeForm;
		const field = kind === "post" ? "text" : "note";
		const raw = kind === "post" ? postForm.text : closeForm.note;
		for (const mode of ["false", "unbound", "reject", "throw", "committed"]) {
			it(`${kind}: ${mode} retains the full editable source`, async () => {
				if (mode !== "unbound")
					admit(() => {
						if (mode === "throw") throw new Error("synthetic throw");
						return mode === "false"
							? Promise.resolve(false)
							: Promise.reject(
									Object.assign(new Error("synthetic failure"), { payloadCommitted: mode === "committed" }),
								);
					});
				const done = mount(kind);
				authored(kind);
				submit();
				await tick();
				expect(done).not.toHaveBeenCalled();
				expect(value(field)).toBe(raw);
				expect(container.querySelector('[role="alert"]')).not.toBeNull();
				original(form);
			});
		}
		for (const change of ["B", "ABA"]) {
			it(`${kind}: ${change} edit survives actual late success`, async () => {
				const gate = deferred();
				admit(() => gate.promise);
				const done = mount(kind);
				authored(kind);
				submit();
				fill(field, "B");
				if (change === "ABA") fill(field, raw);
				gate.resolve(true);
				await tick();
				act(() => receiveBoardResult(result()));
				await tick();
				expect(done).not.toHaveBeenCalled();
				expect(value(field)).toBe(change === "B" ? "B" : raw);
				original(form);
				expect(getBoardDraftRecoveries()[0].current.revision).toBeGreaterThan(attempts()[0].source.revision);
			});
		}
		it(`${kind}: unchanged form closes only after admitted real success`, async () => {
			const gate = deferred();
			admit(() => gate.promise);
			const done = mount(kind);
			authored(kind);
			submit();
			act(() => receiveBoardResult(result()));
			await tick();
			expect(done).not.toHaveBeenCalled();
			gate.resolve(true);
			await tick();
			expect(done).toHaveBeenCalledTimes(1);
			act(() => receiveBoardResult(result()));
			await tick();
			expect(done).toHaveBeenCalledTimes(1);
			original(form);
		});
		it(`${kind}: an edit between the nested await continuations still owns its draft`, async () => {
			admit(() => Promise.resolve(true));
			const done = mount(kind);
			authored(kind);
			submit();
			await tick();
			await act(async () => {
				receiveBoardResult(result());
				queueMicrotask(() => fill(field, "edit between awaits"));
			});
			expect(done).not.toHaveBeenCalled();
			expect(value(field)).toBe("edit between awaits");
			original(form);
		});
		it(`${kind}: submit twice in the same render has one pending operation`, async () => {
			const gate = deferred();
			admit(() => gate.promise);
			mount(kind);
			authored(kind);
			act(() => {
				const f = container.querySelector("form")!;
				f.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
				f.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
			});
			expect(messages).toHaveLength(1);
			gate.resolve(false);
			await tick();
			original(form);
		});
		it(`${kind}: actual timeout retains originals/current edits and the unknown warning`, async () => {
			vi.useFakeTimers();
			admit(() => Promise.resolve(true));
			const done = mount(kind);
			authored(kind);
			submit();
			fill(field, "newer draft");
			await act(() => vi.advanceTimersByTimeAsync(BOARD_ANSWER_MS));
			expect(value(field)).toBe("newer draft");
			expect(container.textContent).toContain(unknown);
			expect(done).not.toHaveBeenCalled();
			expect(messages).toHaveLength(1);
			original(form);
		});
		it(`${kind}: unmount and fresh editor cannot be closed by prior promise`, async () => {
			const gate = deferred();
			admit(() => gate.promise);
			const oldDone = mount(kind);
			authored(kind);
			submit();
			act(() => root!.unmount());
			root = null;
			const done = mount(kind);
			fill(field, "fresh editor");
			gate.resolve(true);
			await tick();
			act(() => receiveBoardResult(result()));
			await tick();
			expect(oldDone).not.toHaveBeenCalled();
			expect(done).not.toHaveBeenCalled();
			expect(value(field)).toBe("fresh editor");
			original(form);
		});
		it(`${kind}: cancel/reopen is explicit and never sends/replays`, async () => {
			mount(kind);
			authored(kind);
			const first = getBoardDraftRecoveries()[0].current;
			click('button[type="button"]');
			expect(messages).toHaveLength(0);
			expect(sent).toHaveLength(0);
			act(() => root!.unmount());
			root = null;
			mount(kind);
			expect(getBoardDraftRecoveries().find((r) => r.current.editorId === first.editorId)?.current.form).toEqual(form);
			expect(messages).toHaveLength(0);
		});
	}
	it("post: kind, recipient mode and inactive selections are edits, including ABA", async () => {
		const gate = deferred();
		admit(() => gate.promise);
		const done = mount();
		authored();
		submit();
		click('[name="rv-bkind"][value="news"]');
		click('[name="rv-bkind"][value="order"]');
		click('[name="rv-bto"]:not(:checked)');
		click('input[type="checkbox"][value="qa"]');
		click('[name="rv-bto"]:not(:checked)');
		gate.resolve(true);
		await tick();
		act(() => receiveBoardResult(result()));
		await tick();
		expect(done).not.toHaveBeenCalled();
		original(postForm);
		expect(getBoardDraftRecoveries()[0].current.form).toEqual({ ...postForm, picked: ["temper", "ops", "qa"] });
	});
	it("close: post A-B-A changes lifetime, retains each note and blocks old success", async () => {
		const gate = deferred();
		admit(() => gate.promise);
		const done = mount("close");
		authored("close");
		submit();
		mount("close", done, "bp-B");
		fill("note", "B note");
		mount("close", done);
		fill("note", "new A note");
		gate.resolve(true);
		await tick();
		act(() => receiveBoardResult(result()));
		await tick();
		expect(done).not.toHaveBeenCalled();
		expect(value("note")).toBe("new A note");
		original(closeForm);
		expect(
			getBoardDraftRecoveries().some(
				(r) =>
					r.current.form.type === "board_close" && r.current.form.id === "bp-B" && r.current.form.note === "B note",
			),
		).toBe(true);
	});
	it("post: existing required-recipient and authored-text validation remain", async () => {
		admit(() => Promise.resolve(true));
		mount();
		click('[name="rv-bto"]:not(:checked)');
		submit();
		expect(messages).toHaveLength(0);
		expect(container.querySelector('[role="alert"]')).not.toBeNull();
		click('[name="rv-bto"]:not(:checked)');
		fill("title", " \t ");
		fill("text", " \n ");
		submit();
		expect(messages).toHaveLength(0);
		expect(container.querySelector('[name="title"]')?.getAttribute("maxlength")).toBe("100");
		expect(container.querySelector('[name="text"]')?.getAttribute("maxlength")).toBe("2000");
	});
});

describe("look-only exact authored recovery, never execution authority", () => {
	for (const form of [postForm, closeForm]) {
		it(`${form.type}: restores complete source for review without dispatch`, () => {
			const source = { editorId: "archived-editor", revision: 7, form };
			expect(restoreBoardDraft(source)).toBe(true);
			expect(restoreBoardDraft(source)).toBe(true);
			const r = getBoardDraftRecoveries()[0];
			expect(r.current).toEqual(source);
			expect(r.restoredSources).toEqual([source]);
			expect(Object.isFrozen(r)).toBe(true);
			expect(Object.isFrozen(r.restoredSources[0].form)).toBe(true);
			expect(messages).toEqual([]);
			expect(sent).toEqual([]);
		});
		it(`${form.type}: original restore never overwrites newer current edits`, () => {
			const original = createBoardDraft(form);
			const changed = reviseBoardDraft(original, {
				...form,
				...(form.type === "board_post" ? { text: "newer B" } : { note: "newer B" }),
			});
			expect(restoreBoardDraft(original)).toBe(true);
			const r = getBoardDraftRecoveries()[0];
			expect(r.current).toEqual(changed);
			expect(r.restoredSources).toEqual([original]);
			expect(messages).toEqual([]);
			expect(sent).toEqual([]);
			expect(
				restoreBoardDraft({
					...original,
					form: {
						...form,
						...(form.type === "board_post" ? { text: "conflicting bytes" } : { note: "conflicting bytes" }),
					},
				}),
			).toBe(false);
		});
		for (const key of Object.keys(form))
			it(`${form.type}: missing ${key} is refused, never normalized`, () => {
				const bad: Record<string, unknown> = { ...form };
				delete bad[key];
				expect(restoreBoardDraft({ editorId: "archive", revision: 1, form: bad })).toBe(false);
				expect(getBoardDraftRecoveries()).toEqual([]);
				expect(sent).toEqual([]);
			});
	}
	for (const patch of [
		{ editorId: "" },
		{ revision: -1 },
		{ revision: 1.2 },
		{ revision: Number.MAX_SAFE_INTEGER + 1 },
		{ ownerReceipt: true },
		{ form: { ...postForm, grant: "not allowed" } },
		{ form: { ...closeForm, config: {} } },
		{ form: { ...postForm, kind: "directive" } },
		{ form: { ...postForm, toAll: "yes" } },
		{ form: { ...postForm, picked: [1] } },
		{ form: { ...postForm, text: 5 } },
		{ form: { ...closeForm, id: "" } },
	])
		it(`refuses malformed/extra source ${JSON.stringify(patch)}`, () => {
			expect(restoreBoardDraft({ editorId: "archive", revision: 1, form: postForm, ...patch })).toBe(false);
			expect(getBoardDraftRecoveries()).toEqual([]);
			expect(sent).toEqual([]);
		});
	it("accessors/nonplain sources are refused without invoking getters", () => {
		const getter = vi.fn(() => postForm);
		const bad = { editorId: "archive", revision: 1 };
		Object.defineProperty(bad, "form", { enumerable: true, get: getter });
		expect(restoreBoardDraft(bad)).toBe(false);
		expect(getter).not.toHaveBeenCalled();
		expect(restoreBoardDraft(Object.create({ editorId: "archive", revision: 1, form: postForm }))).toBe(false);
	});
	it("only exact approved authored fields are recoverable; no executable request/grant/config", async () => {
		admit(() => Promise.resolve(false));
		await boardRequest(wire(closeForm), createBoardDraft(closeForm));
		const r = getBoardDraftRecoveries()[0];
		expect(Object.keys(r.current).sort()).toEqual(["editorId", "form", "revision"]);
		expect(Object.keys(r.current.form).sort()).toEqual(["id", "note", "type"]);
		expect(r.attempts[0]).not.toHaveProperty("message");
		expect(JSON.stringify(r)).not.toMatch(/grant|approval|config|ownerWords/);
		expect(sent).toEqual([]);
	});
});
