// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
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
import type { ClientMessage } from "../../web/src/types";

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
});
afterEach(() => {
	resetBoardDrafts();
	setAppSend(null);
	setAppAdmit(null);
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

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
