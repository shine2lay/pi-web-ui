import { Buffer } from "node:buffer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setAppAdmit } from "../../web/src/app-admit";
import { setAppSend } from "../../web/src/app-globals";
import {
	cancelNotebookEdit,
	cancelOpenNoteEdit,
	changeNotebookDraft,
	changeOpenNoteDraft,
	clearNotebookSaved,
	closeNote,
	deleteOpenNote,
	editNotebook,
	editOpenNote,
	getNotebook,
	getNotebookSaveAttempts,
	NOTEBOOK_TAB_REF,
	openNote,
	receiveNote,
	receiveNotebook,
	receiveNotebookSaved,
	receiveNotesFound,
	receiveNoteSaved,
	resendNotebookWatch,
	resetNotebookState,
	saveNotebook,
	saveOpenNote,
	searchNotes,
	watchNotebook,
	type NotebookSavedPayload,
	type NoteSavedPayload,
} from "../../web/src/notebook-state";
import type { ClientMessage } from "../../web/src/types";

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: Error) => void;
	const promise = new Promise<T>((yes, no) => {
		resolve = yes;
		reject = no;
	});
	return { promise, resolve, reject };
}
function current() {
	const value = getNotebook();
	if (!value) throw new Error("fixture requires notebook");
	return value;
}
function note() {
	const value = current().notes.open;
	if (!value) throw new Error("fixture requires open note");
	return value;
}
function reqId(message: ClientMessage | undefined): string {
	if (!message || !("reqId" in message) || typeof message.reqId !== "string")
		throw new Error("missing real request ID");
	return message.reqId;
}
const sent: ClientMessage[] = [];
const send = vi.fn((message: ClientMessage): boolean => {
	sent.push(message);
	return true;
});
const admitted = vi.fn(async (_message: ClientMessage): Promise<boolean> => true);
function ready(id = "ops") {
	watchNotebook(id);
	receiveNotebook({ type: "identity_notebook", id, text: "base\r\n", hash: "base-h", cap: 6_000 });
}
function readyNote(ref = "n1") {
	openNote(ref);
	const read = reqId(sent.at(-1));
	receiveNote({
		type: "identity_note",
		id: current().id,
		ref,
		reqId: read,
		text: "note-base\r\n",
		hash: "note-h",
		editable: true,
	});
	return read;
}
function notebookAck(id: string, changes: Partial<NotebookSavedPayload> = {}): NotebookSavedPayload {
	return {
		type: "identity_file_saved",
		id: "ops",
		file: "notebook",
		ref: NOTEBOOK_TAB_REF,
		reqId: id,
		ok: true,
		hash: "saved-h",
		...changes,
	};
}
function noteAck(id: string, changes: Partial<NoteSavedPayload> = {}): NoteSavedPayload {
	return { type: "identity_note_saved", id: "ops", ref: "n1", reqId: id, ok: true, hash: "saved-note-h", ...changes };
}
function latest() {
	const attempt = getNotebookSaveAttempts().at(-1);
	if (!attempt) throw new Error("fixture requires captured operation");
	return attempt;
}
function notebookA() {
	editNotebook();
	changeNotebookDraft("authored-A\r\n é 🌈\n");
}
function noteA() {
	readyNote();
	editOpenNote();
	changeOpenNoteDraft("note-A\r\n é 🌈\n");
}

beforeEach(() => {
	resetNotebookState();
	sent.length = 0;
	send.mockClear();
	send.mockImplementation((message) => {
		sent.push(message);
		return true;
	});
	admitted.mockClear();
	admitted.mockResolvedValue(true);
	setAppSend(send);
	setAppAdmit(admitted);
});
afterEach(() => {
	resetNotebookState();
	setAppSend(null);
	setAppAdmit(null);
});

describe("actual notebook/note store admission", () => {
	for (const kind of ["notebook", "note"] as const) {
		const setup = () => {
			ready();
			if (kind === "notebook") notebookA();
			else noteA();
		};
		const snapshot = () => (kind === "notebook" ? current().draft : note().draft);
		const change = (text: string) => (kind === "notebook" ? changeNotebookDraft(text) : changeOpenNoteDraft(text));
		const start = () =>
			kind === "notebook"
				? saveNotebook(current().draft!.text, current().draft!.base, current().draft!.generation)
				: saveOpenNote(note().draft!.text, note().draft!.generation);
		const ack = (id: string, ok = true) =>
			kind === "notebook"
				? receiveNotebookSaved(notebookAck(id, ok ? {} : { ok: false, code: "changed" }))
				: receiveNoteSaved(noteAck(id, ok ? {} : { ok: false, code: "changed", problems: ["conflict"] }));
		const saving = () => (kind === "notebook" ? current().saving : note().busy === "save");
		const result = () => (kind === "notebook" ? current().saved : note().done);
		const baseline = () => (kind === "notebook" ? current().text : note().text);

		it(`${kind}: defers literal admission, captures original target/base/generation, suppresses same-turn double action`, async () => {
			setup();
			const d = deferred<boolean>();
			admitted.mockReturnValue(d.promise);
			const original = snapshot()!;
			const promise = start();
			const op = latest();
			expect(saving()).toBe(true);
			expect(result()).toBeUndefined();
			expect(baseline()).not.toBe(original.text);
			expect(op.message).toMatchObject({
				type: kind === "notebook" ? "identity_file_save" : "identity_note_save",
				id: "ops",
				text: original.text,
				baseHash: original.base,
			});
			expect(op.editGeneration).toBe(original.generation);
			expect(Object.isFrozen(op.message)).toBe(true);
			expect(await start()).toBe(false);
			expect(admitted).toHaveBeenCalledTimes(1);
			expect(sent.filter((m) => m.type === "identity_file_save" || m.type === "identity_note_save")).toEqual([]);
			d.resolve(true);
			expect(await promise).toBe(true);
			expect(saving()).toBe(true);
			expect(result()).toBeUndefined();
			expect(snapshot()).toEqual(original);
			ack(op.message.reqId);
			expect(result()).toMatchObject({ ok: true, reqId: op.message.reqId });
			expect(snapshot()).toBeUndefined();
			expect(baseline()).toBe(original.text);
		});

		for (const outcome of ["false", "reject", "committed-false", "truthy-not-true"] as const) {
			it(`${kind}: ${outcome} retains complete A and newer B with truthful unknown, no fallback`, async () => {
				setup();
				const d = deferred<boolean>();
				const checkpointed: ClientMessage[] = [];
				setAppAdmit((message) => {
					if (outcome === "committed-false") checkpointed.push(structuredClone(message));
					return d.promise;
				});
				const original = snapshot()!;
				const promise = start();
				const op = latest();
				change("newer-B\r\n\0 é 🌈\n");
				if (outcome === "reject") d.reject(new Error("uncertain dispatch"));
				else if (outcome === "truthy-not-true") d.resolve(JSON.parse('{"ok":true}'));
				else d.resolve(false);
				expect(await promise).toBe(false);
				expect(saving()).toBe(false);
				expect(result()).not.toMatchObject({ ok: true });
				expect(snapshot()?.text).toBe("newer-B\r\n\0 é 🌈\n");
				expect(latest()).toMatchObject({ phase: "unknown", message: { text: original.text, baseHash: original.base } });
				if (outcome === "committed-false") expect(checkpointed).toEqual([op.message]);
				ack(op.message.reqId); // a late result after failed/uncertain admission cannot upgrade/clear B
				expect(snapshot()?.text).toBe("newer-B\r\n\0 é 🌈\n");
				expect(latest().phase).toBe("unknown");
				expect(sent.filter((m) => m.type === "identity_file_save" || m.type === "identity_note_save")).toEqual([]);
			});
		}

		for (const returnToA of [false, true]) {
			it(`${kind}: matched real ACK updates A baseline but preserves ${returnToA ? "A→B→A edit generation" : "newer B"}`, async () => {
				setup();
				const d = deferred<boolean>();
				admitted.mockReturnValue(d.promise);
				const original = snapshot()!;
				const promise = start();
				const id = latest().message.reqId;
				change("newer-B");
				if (returnToA) change(original.text);
				const newer = snapshot()!;
				expect(newer.generation).not.toBe(original.generation);
				d.resolve(true);
				await promise;
				ack(id);
				expect(snapshot()).toEqual({ ...newer, base: kind === "notebook" ? "saved-h" : "saved-note-h" });
				expect(baseline()).toBe(original.text);
				expect(latest().message.text).toBe(original.text);
				ack(id);
				expect(snapshot()?.generation).toBe(newer.generation); // duplicate terminal ACK
			});
		}

		it(`${kind}: early matching receipt buffers until true; first receipt wins and B stays editable`, async () => {
			setup();
			const d = deferred<boolean>();
			admitted.mockReturnValue(d.promise);
			const original = snapshot()!;
			const promise = start();
			const id = latest().message.reqId;
			ack(id);
			ack(id, false);
			expect(saving()).toBe(true);
			expect(result()).toBeUndefined();
			expect(baseline()).not.toBe(original.text);
			change("B after early receipt");
			d.resolve(true);
			await promise;
			expect(result()).toMatchObject({ ok: true });
			expect(snapshot()?.text).toBe("B after early receipt");
			expect(baseline()).toBe(original.text);
		});

		it(`${kind}: early ok followed by failed admission does not claim Saved`, async () => {
			setup();
			const d = deferred<boolean>();
			admitted.mockReturnValue(d.promise);
			const original = snapshot()!;
			const promise = start();
			ack(latest().message.reqId);
			d.resolve(false);
			expect(await promise).toBe(false);
			expect(result()).toMatchObject({ ok: false });
			expect(snapshot()).toEqual(original);
			expect(latest().phase).toBe("unknown");
		});

		it(`${kind}: matching refusal preserves draft and conflict/base semantics`, async () => {
			setup();
			const original = snapshot()!;
			await start();
			ack(latest().message.reqId, false);
			expect(result()).toMatchObject({ ok: false, code: "changed" });
			expect(snapshot()).toEqual(original);
			expect(latest().phase).toBe("refused");
			expect(saving()).toBe(false);
		});

		it(`${kind}: stale success/error/missing echo never completes a later same-resource save`, async () => {
			setup();
			admitted.mockResolvedValueOnce(false);
			await start();
			const old = latest().message.reqId;
			change("operation-B");
			await start();
			const active = latest().message.reqId;
			expect(active).not.toBe(old);
			ack(old);
			ack(old, false);
			ack("unrelated");
			if (kind === "notebook") receiveNotebookSaved(notebookAck(active, { reqId: undefined }));
			else receiveNoteSaved(noteAck(active, { reqId: undefined }));
			expect(saving()).toBe(true);
			expect(snapshot()?.text).toBe("operation-B");
			ack(active);
			expect(result()).toMatchObject({ ok: true, reqId: active });
		});

		it(`${kind}: identity switch and same-resource reopen retain edits; old continuation/ACK cannot retarget B`, async () => {
			setup();
			const d = deferred<boolean>();
			admitted.mockReturnValueOnce(d.promise);
			const promise = start();
			const old = latest();
			change("kept-B");
			watchNotebook(null);
			ready("other");
			editNotebook("other-draft", "base-h");
			d.resolve(false);
			await promise;
			ack(old.message.reqId);
			expect(current()).toMatchObject({ id: "other", saving: false, draft: { text: "other-draft" } });
			ready();
			if (kind === "note") readyNote();
			expect(snapshot()?.text).toBe("kept-B");
			await start();
			const now = latest();
			ack(old.message.reqId);
			ack(old.message.reqId, false);
			expect(saving()).toBe(true);
			expect(snapshot()?.text).toBe("kept-B");
			ack(now.message.reqId);
			expect(result()).toMatchObject({ ok: true });
			expect(getNotebookSaveAttempts().find((x) => x.message.reqId === old.message.reqId)?.message).toEqual(
				old.message,
			);
		});

		it(`${kind}: disconnect during admission or after admission is unknown and never replays`, async () => {
			setup();
			const d = deferred<boolean>();
			admitted.mockReturnValueOnce(d.promise);
			const promise = start();
			const original = latest();
			change("B survives reconnect");
			resendNotebookWatch();
			d.resolve(true);
			await promise;
			ack(original.message.reqId);
			expect(snapshot()?.text).toBe("B survives reconnect");
			expect(latest().phase).toBe("unknown");
			expect(saving()).toBe(false);
			expect(admitted).toHaveBeenCalledTimes(1);
			await start();
			const second = latest();
			resendNotebookWatch();
			ack(second.message.reqId);
			expect(latest().phase).toBe("unknown");
			expect(snapshot()?.text).toBe("B survives reconnect");
			expect(admitted).toHaveBeenCalledTimes(2);
			expect(sent.filter((m) => m.type === "identity_file_save" || m.type === "identity_note_save")).toEqual([]);
		});
	}

	it("failed live watches and canonical-read dispatch keep an already-loaded newer draft editable", async () => {
		ready();
		notebookA();
		send.mockReturnValueOnce(false);
		resendNotebookWatch();
		changeNotebookDraft("B after offline watch");
		expect(current()).toMatchObject({ status: "ready", error: "offline", draft: { text: "B after offline watch" } });
		receiveNotebook({ type: "identity_notebook", id: "ops", error: "unavailable" });
		changeNotebookDraft("B after read error");
		expect(current().draft?.text).toBe("B after read error");
		noteA();
		await saveOpenNote(note().draft!.text);
		changeOpenNoteDraft("note-B");
		send.mockReturnValueOnce(false);
		receiveNoteSaved(noteAck(latest().message.reqId));
		changeOpenNoteDraft("note-B after offline canonical read");
		expect(note()).toMatchObject({
			status: "ready",
			error: "offline",
			draft: { text: "note-B after offline canonical read" },
		});
	});

	it("an unregistered host refuses admission without sending through the old boolean transport", async () => {
		ready();
		notebookA();
		setAppAdmit(null);
		expect(await saveNotebook(current().draft!.text, "base-h")).toBe(false);
		expect(current()).toMatchObject({
			saving: false,
			draft: { text: latest().message.text },
			save: { phase: "unknown" },
		});
		expect(sent.filter((m) => m.type === "identity_file_save")).toEqual([]);
	});

	it("a failed canonical read after A's real ACK keeps B editable and does not erase the confirmed baseline", async () => {
		ready();
		noteA();
		await saveOpenNote(note().draft!.text);
		const original = latest();
		changeOpenNoteDraft("B");
		receiveNoteSaved(noteAck(original.message.reqId));
		const read = reqId(sent.at(-2));
		receiveNote({ type: "identity_note", id: "ops", ref: "n1", reqId: read, error: "read failed" });
		expect(note()).toMatchObject({
			status: "ready",
			text: original.message.text,
			error: "read failed",
			draft: { text: "B" },
		});
		changeOpenNoteDraft("B still editable");
		expect(note().draft?.text).toBe("B still editable");
	});

	it("full attachment-independent text is captured byte-for-byte, not abbreviated by a preview or cap", async () => {
		ready();
		const text = "完整\r\n é 🌈\0" + "long authored line\n".repeat(80_000) + " \n";
		editNotebook(text, "base-h");
		admitted.mockResolvedValue(false);
		expect(await saveNotebook(text, "base-h")).toBe(false);
		expect(latest().message.text).toBe(text);
		expect(Buffer.compare(Buffer.from(latest().message.text, "utf8"), Buffer.from(text, "utf8"))).toBe(0);
		expect(current().draft?.text).toBe(text);
	});

	it("force/conflict save uses the selected newest base, not a later watch or identity", async () => {
		ready();
		notebookA();
		const d = deferred<boolean>();
		admitted.mockReturnValue(d.promise);
		receiveNotebook({ type: "identity_notebook", id: "ops", text: "external", hash: "external-h" });
		const pending = saveNotebook(current().draft!.text, "external-h", current().draft!.generation);
		receiveNotebook({ type: "identity_notebook", id: "ops", text: "later", hash: "later-h" });
		d.resolve(false);
		await pending;
		expect(latest().message.baseHash).toBe("external-h");
		expect(current().draft?.base).toBe("base-h");
	});

	it("notebook receipts require file, discriminator, identity and request; malformed success stays unknown", async () => {
		ready();
		notebookA();
		await saveNotebook(current().draft!.text, "base-h");
		const id = latest().message.reqId;
		for (const changes of [{ id: "other" }, { file: "about" as const }, { ref: "settings" }, { ref: undefined }])
			receiveNotebookSaved(notebookAck(id, changes));
		expect(current().saving).toBe(true);
		expect(current().saved).toBeUndefined();
		receiveNotebookSaved(notebookAck(id, { hash: undefined }));
		expect(current().saving).toBe(false);
		expect(current().draft).toBeDefined();
		expect(current().save?.phase).toBe("unknown");
	});

	it("stale action generations cannot label newer inputs as the submitted revision", async () => {
		ready();
		notebookA();
		const old = current().draft!;
		changeNotebookDraft("B");
		expect(await saveNotebook(old.text, old.base, old.generation)).toBe(false);
		expect(await saveNotebook("different", old.base)).toBe(false);
		expect(admitted).not.toHaveBeenCalled();
		noteA();
		const prior = note().draft!;
		changeOpenNoteDraft("note-B");
		expect(await saveOpenNote(prior.text, prior.generation)).toBe(false);
		expect(admitted).not.toHaveBeenCalled();
	});

	it("closing/reopening the SAME note protects newer read, pending save and draft from old success/error", async () => {
		ready();
		noteA();
		const d = deferred<boolean>();
		admitted.mockReturnValueOnce(d.promise);
		const oldRead = note().readReqId;
		const oldGeneration = note().generation;
		const pending = saveOpenNote(note().draft!.text);
		const old = latest();
		changeOpenNoteDraft("B");
		closeNote();
		readyNote();
		expect(note().generation).not.toBe(oldGeneration);
		expect(note().draft?.text).toBe("B");
		await saveOpenNote("B");
		const active = latest();
		d.resolve(false);
		await pending;
		receiveNoteSaved(noteAck(old.message.reqId));
		receiveNoteSaved(noteAck(old.message.reqId, { ok: false, code: "io" }));
		receiveNote({
			type: "identity_note",
			id: "ops",
			ref: "n1",
			reqId: oldRead,
			text: "stale",
			hash: "stale-h",
			editable: true,
		});
		expect(note()).toMatchObject({
			busy: "save",
			draft: { text: "B" },
			save: { message: { reqId: active.message.reqId } },
		});
	});

	it("a late admission/error for n1 cannot release n2's save or retarget its original base/ref", async () => {
		ready();
		noteA();
		const d = deferred<boolean>();
		admitted.mockReturnValueOnce(d.promise);
		const first = saveOpenNote(note().draft!.text);
		const old = latest();
		readyNote("n2");
		editOpenNote();
		changeOpenNoteDraft("n2-B");
		await saveOpenNote("n2-B");
		const active = latest();
		d.reject(new Error("late uncertain n1"));
		await first;
		receiveNoteSaved(noteAck(old.message.reqId));
		receiveNoteSaved(noteAck(old.message.reqId, { ok: false, code: "io" }));
		expect(note()).toMatchObject({ ref: "n2", busy: "save", draft: { text: "n2-B" } });
		expect(old.message).toMatchObject({ ref: "n1", baseHash: "note-h" });
		receiveNoteSaved(noteAck(active.message.reqId, { ref: "n2" }));
		expect(note().busy).toBeNull();
	});

	it("same-ref read replies and canonical reloads need exact echo and never replace an authored draft", async () => {
		ready();
		const first = readyNote();
		editOpenNote();
		changeOpenNoteDraft("A");
		await saveOpenNote("A");
		changeOpenNoteDraft("B");
		const id = latest().message.reqId;
		receiveNoteSaved(noteAck(id));
		const reload = reqId(sent.at(-2));
		const payload = {
			type: "identity_note" as const,
			id: "ops",
			ref: "n1",
			text: "canonical-A",
			hash: "saved-note-h",
			editable: true,
		};
		receiveNote({ ...payload, reqId: first });
		receiveNote(payload);
		expect(note().text).toBe("A");
		receiveNote({ ...payload, reqId: reload });
		expect(note()).toMatchObject({ text: "canonical-A", draft: { text: "B", base: "saved-note-h" } });
		openNote("n1");
		const currentRead = reqId(sent.at(-1));
		receiveNote({ ...payload, reqId: reload });
		expect(note().status).toBe("loading");
		receiveNote({ ...payload, reqId: currentRead });
		expect(note().draft?.text).toBe("B");
	});

	it("read/watch/search/delete use zero admission calls; false/throw is visible and true never fabricates delete success", () => {
		ready();
		const first = readyNote();
		searchNotes("  needle  ");
		receiveNotesFound({ type: "identity_notes_found", id: "ops", query: "needle", hits: [], total: 0 });
		resendNotebookWatch();
		closeNote();
		readyNote();
		expect(reqId(sent.find((m) => m.type === "identity_note_get"))).toBe(first);
		send.mockReturnValueOnce(false);
		expect(deleteOpenNote()).toBe(false);
		expect(note()).toMatchObject({ busy: null, deleteUnknown: true });
		send.mockImplementationOnce(() => {
			throw new Error("possibly deleted");
		});
		expect(deleteOpenNote()).toBe(false);
		expect(note().deleteUnknown).toBe(true);
		expect(deleteOpenNote()).toBe(true);
		const deleting = reqId(sent.at(-1));
		expect(note().busy).toBe("delete");
		expect(current().notes.deleted).toBeUndefined();
		receiveNoteSaved(noteAck(deleting, { reqId: undefined, deleted: true }));
		receiveNoteSaved(noteAck("old", { deleted: true }));
		receiveNoteSaved(noteAck(deleting));
		expect(note().busy).toBe("delete");
		receiveNoteSaved(noteAck(deleting, { deleted: true }));
		expect(current().notes).toMatchObject({ open: null, deleted: "n1" });
		expect(admitted).not.toHaveBeenCalled();
		expect(getNotebookSaveAttempts()).toEqual([]);
	});

	it("an old save result cannot complete a pending delete (and a delete result cannot save a new draft)", async () => {
		ready();
		noteA();
		await saveOpenNote(note().draft!.text);
		const save = latest().message.reqId;
		receiveNoteSaved(noteAck(save, { ok: false, code: "invalid", problems: ["fixture"] }));
		cancelOpenNoteEdit();
		deleteOpenNote();
		const del = reqId(sent.at(-1));
		receiveNoteSaved(noteAck(save, { deleted: true }));
		expect(note().busy).toBe("delete");
		receiveNoteSaved(noteAck(del, { ok: false, code: "changed" }));
		editOpenNote();
		changeOpenNoteDraft("B");
		await saveOpenNote("B");
		receiveNoteSaved(noteAck(del, { deleted: true }));
		expect(note()).toMatchObject({ busy: "save", draft: { text: "B" } });
	});

	it("excluded read transport failures are truthful, never journalled; archived notes remain read-only", async () => {
		send.mockReturnValueOnce(false);
		watchNotebook("ops");
		expect(current()).toMatchObject({ status: "error", error: "offline" });
		receiveNotebook({ type: "identity_notebook", id: "ops", text: "base", hash: "base-h" });
		send.mockImplementationOnce(() => {
			throw new Error("offline");
		});
		expect(searchNotes("needle")).toBe(false);
		expect(current().notes.status).toBe("error");
		send.mockReturnValueOnce(false);
		expect(openNote("n1")).toBe(false);
		expect(note().status).toBe("error");
		openNote("archive/old.md:1");
		const id = reqId(sent.at(-1));
		receiveNote({
			type: "identity_note",
			id: "ops",
			ref: "archive/old.md:1",
			reqId: id,
			text: "old",
			hash: "h",
			editable: false,
		});
		editOpenNote();
		expect(note().draft).toBeUndefined();
		expect(await saveOpenNote("x")).toBe(false);
		expect(deleteOpenNote()).toBe(false);
		expect(admitted).not.toHaveBeenCalled();
	});

	it("a watch push or explicit cancel/load-new never discards the independent original attempt", async () => {
		ready();
		notebookA();
		admitted.mockResolvedValue(false);
		await saveNotebook(current().draft!.text, "base-h");
		const original = latest();
		receiveNotebook({ type: "identity_notebook", id: "ops", text: "external", hash: "new-h" });
		expect(current().draft?.text).toBe(original.message.text);
		editNotebook();
		expect(current().draft?.text).toBe("external");
		cancelNotebookEdit();
		expect(current().draft).toBeUndefined();
		watchNotebook(null);
		expect(getNotebookSaveAttempts()).toContainEqual(original);
	});

	it("the Saved timer clears only its own operation result, not the next result", async () => {
		ready();
		notebookA();
		await saveNotebook(current().draft!.text, "base-h");
		const first = latest().message.reqId;
		receiveNotebookSaved(notebookAck(first));
		editNotebook("B", "saved-h");
		await saveNotebook("B", "saved-h");
		const second = latest().message.reqId;
		receiveNotebookSaved(notebookAck(second));
		clearNotebookSaved(first);
		expect(current().saved).toMatchObject({ reqId: second, ok: true });
	});
});
