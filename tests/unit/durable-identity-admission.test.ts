import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setAppAdmit, type AppAdmit } from "../../web/src/app-admit";
import { setAppSend, type AppSend } from "../../web/src/app-globals";
import {
	closeIdentityDraft,
	closeIdentityFile,
	editIdentityDraft,
	editIdentityFile,
	editIdentityOwnerForm,
	getIdentityDraft,
	getIdentityFile,
	getIdentityOperations,
	openIdentityDraft,
	openIdentityFile,
	receiveIdentityDraft,
	receiveIdentityDraftDone,
	receiveIdentityFile,
	receiveIdentitySaved,
	resetIdentityState,
	saveOpenIdentityFile,
	sendIdentityDraftAction,
	type IdentityDraftDonePayload,
	type IdentitySavedPayload,
} from "../../web/src/identity-state";
import type { ClientMessage, IdentityDraftAction, IdentityFileName } from "../../web/src/types";

// Entirely synthetic strings. Never touch the real identity folder, journal, chat, or model.
const CONFIG = '{"id":"fixture","fakeCredential":"NOT-A-REAL-SECRET","goals":[],"workMode":"request-only"}';
// Other ClientMessage variants legitimately use numeric IDs; only identity replies echo strings.
type Sent = ClientMessage & { reqId?: string | number };
const sent: Sent[] = [];
const ordinary = vi.fn<AppSend>((msg) => {
	sent.push(msg);
	return true;
});
const eligible = vi.fn<AppAdmit>(async (msg) => {
	sent.push(msg);
	return true;
});
const file = () => getIdentityFile()!;
const draft = () => getIdentityDraft()!;
const last = () => sent.at(-1)!;
function deferred() {
	let resolve!: (value: boolean) => void;
	let reject!: (error: Error) => void;
	const promise = new Promise<boolean>((yes, no) => {
		resolve = yes;
		reject = no;
	});
	return { promise, resolve, reject };
}
function openFile(name: IdentityFileName = "about", id = "fixture", text = "disk-0", hash = "h0") {
	openIdentityFile(id, name);
	receiveIdentityFile({ type: "identity_file", id, file: name, text, hash });
	return file();
}
function openDraft(id = "fixture") {
	openIdentityDraft(id);
	receiveIdentityDraft({
		type: "identity_draft",
		id,
		hash: "d0",
		about: "about-0",
		prompt: "prompt-0",
		config: CONFIG,
	});
	return draft();
}
function fileReply(request: Sent = last(), patch: Partial<IdentitySavedPayload> = {}) {
	if (request.type !== "identity_file_save") throw new Error("fixture expected a file action");
	receiveIdentitySaved({
		type: "identity_file_saved",
		id: request.id,
		file: request.file,
		reqId: typeof request.reqId === "string" ? request.reqId : undefined,
		ok: true,
		hash: "h1",
		...patch,
	});
}
function draftReply(
	action: IdentityDraftAction,
	request: Sent = last(),
	patch: Partial<IdentityDraftDonePayload> = {},
) {
	if (
		request.type !== "identity_draft_save" &&
		request.type !== "identity_draft_accept" &&
		request.type !== "identity_draft_discard"
	)
		throw new Error("fixture expected a draft action");
	receiveIdentityDraftDone({
		type: "identity_draft_done",
		id: request.id,
		action,
		reqId: typeof request.reqId === "string" ? request.reqId : undefined,
		ok: true,
		...(action === "save" ? { hash: "d1" } : {}),
		...patch,
	});
}

beforeEach(() => {
	resetIdentityState();
	sent.length = 0;
	ordinary.mockClear();
	eligible.mockClear();
	ordinary.mockImplementation((msg) => {
		sent.push(msg);
		return true;
	});
	eligible.mockImplementation(async (msg) => {
		sent.push(msg);
		return true;
	});
	setAppSend(ordinary);
	setAppAdmit(eligible);
});
afterEach(() => {
	setAppSend(null);
	setAppAdmit(null);
	resetIdentityState();
});

describe("real identity store: paired asynchronous E callers", () => {
	it.each(["about", "notebook", "prompt"] as const)(
		"awaits %s admission, registers before dispatch, never falls back",
		async (name) => {
			openFile(name);
			ordinary.mockClear();
			editIdentityFile(file(), "A");
			const actionEditor = file();
			const waiting = deferred();
			eligible.mockImplementation((msg) => {
				sent.push(msg);
				expect(file().saving).toBe(true);
				return waiting.promise;
			});
			let settled = false;
			const result = saveOpenIdentityFile("A", actionEditor).then((ok) => {
				settled = true;
				return ok;
			});
			await Promise.resolve();
			expect(settled).toBe(false);
			expect(await saveOpenIdentityFile("A", actionEditor)).toBe(false); // stale same-render double click
			expect(eligible).toHaveBeenCalledTimes(1);
			expect(file().text).toBe("disk-0");
			expect(file().saved).toBeUndefined();
			const request = last();
			expect(request).toMatchObject({ id: "fixture", file: name, baseHash: "h0", text: "A" });
			expect(request.reqId).toBeTypeOf("string");
			editIdentityFile(file(), "B");
			fileReply(request); // immediate server ACK is insufficient until admission resolves
			expect(file().text).toBe("disk-0");
			waiting.resolve(true);
			expect(await result).toBe(true);
			expect(file()).toMatchObject({
				text: "A",
				editText: "B",
				hash: "h1",
				saving: false,
				saved: { ok: true, revision: 1 },
			});
			expect(file().revision).toBe(2);
			expect(ordinary).not.toHaveBeenCalled();
		},
	);

	it.each(["false", "reject", "throw", "truthy", "committed-then-failed", "unregistered"] as const)(
		"retains original/current on %s; no Promise-as-success or fallback",
		async (outcome) => {
			openFile();
			ordinary.mockClear();
			editIdentityFile(file(), "A");
			if (outcome === "unregistered") setAppAdmit(null);
			else
				eligible.mockImplementation((msg) => {
					sent.push(msg);
					editIdentityFile(file(), "B\ncomplete newer edit");
					if (outcome === "committed-then-failed") fileReply(last());
					if (outcome === "reject") return Promise.reject(new Error("synthetic rejection"));
					if (outcome === "throw" || outcome === "committed-then-failed") throw new Error("synthetic failure");
					return Promise.resolve(outcome === "truthy" ? (1 as unknown as boolean) : false);
				});
			expect(await saveOpenIdentityFile("A")).toBe(false);
			expect(file()).toMatchObject({
				text: "disk-0",
				editText: outcome === "unregistered" ? "A" : "B\ncomplete newer edit",
				hash: "h0",
				saving: false,
				uncertain: true,
				saved: { ok: false },
			});
			expect(getIdentityOperations()).toHaveLength(1);
			expect(getIdentityOperations()[0]).toMatchObject({ phase: "unknown", request: { text: "A", baseHash: "h0" } });
			expect(ordinary).not.toHaveBeenCalled();
		},
	);

	it.each(["false", "reject"] as const)("deferred %s keeps B and A's complete original", async (outcome) => {
		openFile();
		editIdentityFile(file(), "A");
		const wait = deferred();
		eligible.mockImplementation((msg) => {
			sent.push(msg);
			return wait.promise;
		});
		const result = saveOpenIdentityFile("A");
		editIdentityFile(file(), "B");
		if (outcome === "reject") wait.reject(new Error("synthetic deferred rejection"));
		else wait.resolve(false);
		expect(await result).toBe(false);
		expect(file()).toMatchObject({ text: "disk-0", editText: "B", uncertain: true, saving: false });
		expect(getIdentityOperations()[0]).toMatchObject({ request: { text: "A" }, phase: "unknown" });
	});

	it("accepts an eager matching reply only after exact true", async () => {
		openFile();
		editIdentityFile(file(), "A");
		eligible.mockImplementation(async (msg) => {
			sent.push(msg);
			fileReply(last());
			return true;
		});
		expect(await saveOpenIdentityFile("A")).toBe(true);
		expect(file()).toMatchObject({ text: "A", hash: "h1", saved: { ok: true }, saving: false });
		expect(file().editText).toBeUndefined();
	});

	it("only matching persistence changes the baseline; all no-echo/misaddressed errors and successes are inert", async () => {
		openFile();
		editIdentityFile(file(), "A");
		await saveOpenIdentityFile("A");
		const request = last();
		for (const ok of [true, false])
			for (const patch of [
				{ reqId: undefined },
				{ reqId: "old-or-unrelated" },
				{ id: "another" },
				{ file: "prompt" as const },
			]) {
				fileReply(request, { ok, ...patch });
				expect(file()).toMatchObject({ saving: true, text: "disk-0", editText: "A", hash: "h0" });
				expect(file().saved).toBeUndefined();
			}
		fileReply(request);
		const saved = file();
		fileReply(request, { ok: false });
		expect(file()).toBe(saved); // duplicate cannot turn a success into a refusal
	});

	it.each([false, "truthy-ok", "missing-hash"] as const)("a correlated %s is not persistence", async (bad) => {
		openFile();
		editIdentityFile(file(), "A");
		await saveOpenIdentityFile("A");
		fileReply(last(), {
			ok: bad === "truthy-ok" ? (1 as unknown as boolean) : bad !== false,
			...(bad === "missing-hash" ? { hash: undefined } : {}),
			code: "changed",
			problems: ["synthetic refusal"],
		});
		expect(file()).toMatchObject({ text: "disk-0", editText: "A", hash: "h0", saving: false, saved: { ok: false } });
	});

	it("A→B→A retains the newer revision, not just text equality", async () => {
		openFile();
		editIdentityFile(file(), "A");
		await saveOpenIdentityFile("A");
		const request = last();
		const savedRevision = file().revision;
		editIdentityFile(file(), "B");
		editIdentityFile(file(), "A");
		fileReply(request);
		expect(file()).toMatchObject({
			text: "A",
			editText: "A",
			revision: savedRevision + 2,
			saved: { ok: true, revision: savedRevision },
		});
	});

	it.each(["same-file", "other-file", "other-identity"] as const)(
		"a previous ACK or deferred refusal never retargets %s",
		async (target) => {
			openFile();
			editIdentityFile(file(), "A");
			const wait = deferred();
			eligible.mockImplementation((msg) => {
				sent.push(msg);
				return wait.promise;
			});
			const result = saveOpenIdentityFile("A");
			const request = last();
			editIdentityFile(file(), "B-original-resource");
			closeIdentityFile();
			openFile(
				target === "other-file" ? "notebook" : "about",
				target === "other-identity" ? "another" : "fixture",
				"fresh-disk",
				"fresh-hash",
			);
			editIdentityFile(file(), "C-reopened");
			const reopened = file();
			fileReply(request);
			wait.resolve(true);
			expect(await result).toBe(true);
			expect(file()).toBe(reopened);
			expect(file()).toMatchObject({ editText: "C-reopened", text: "fresh-disk", hash: "fresh-hash" });
			expect(getIdentityOperations()[0]).toMatchObject({ request: { id: "fixture", file: "about", text: "A" } });
		},
	);

	it("reopens authored text after unmount, retains a failed read, and ignores unsolicited status/hash pushes", () => {
		openFile();
		editIdentityFile(file(), "B");
		const current = file();
		receiveIdentityFile({
			type: "identity_file",
			id: "fixture",
			file: "about",
			text: "unsolicited",
			hash: "unrelated",
		});
		expect(file()).toBe(current);
		closeIdentityFile();
		openIdentityFile("fixture", "about");
		expect(file().editText).toBe("B");
		receiveIdentityFile({ type: "identity_file", id: "fixture", file: "about", error: "synthetic read failure" });
		expect(file()).toMatchObject({ status: "ready", editText: "B", hash: "h0" });
	});

	it("an old result cannot release newer B's in-flight guard", async () => {
		openFile();
		await saveOpenIdentityFile("A");
		const first = last();
		fileReply(first);
		editIdentityFile(file(), "B");
		await saveOpenIdentityFile("B");
		const second = last();
		fileReply(first, { ok: false });
		expect(file().saving).toBe(true);
		fileReply(second, { hash: "h2" });
		expect(file()).toMatchObject({ text: "B", hash: "h2", saving: false });
	});
});

describe("X/M boundary: complete config/form stays on the distinct transient path", () => {
	it.each(["true", "false", "throw", "promise", "truthy", "committed-then-failed"] as const)(
		"raw config send %s never enters generic admission",
		async (outcome) => {
			openFile("config", "fixture", CONFIG);
			ordinary.mockClear();
			const original = `${CONFIG}\n `;
			editIdentityFile(file(), original);
			ordinary.mockImplementation((msg) => {
				sent.push(msg);
				if (outcome === "committed-then-failed") fileReply(last());
				if (outcome === "throw" || outcome === "committed-then-failed") throw new Error("synthetic send failure");
				return outcome === "promise"
					? (Promise.resolve(true) as unknown as boolean)
					: outcome === "truthy"
						? (1 as unknown as boolean)
						: outcome === "true";
			});
			expect(await saveOpenIdentityFile(original)).toBe(outcome === "true");
			expect(eligible).not.toHaveBeenCalled();
			expect(ordinary).toHaveBeenCalledTimes(1);
			expect(last()).toMatchObject({ type: "identity_file_save", file: "config", text: original, baseHash: "h0" });
			if (outcome === "true") fileReply(last(), { ok: false, code: "invalid" });
			expect(file()).toMatchObject({ text: CONFIG, editText: original, saved: { ok: false } });
		},
	);

	it("saving one config view never clears the other view's separate unsent draft", async () => {
		openFile("config", "fixture", CONFIG);
		const raw = `${CONFIG}\nraw-view-original`;
		editIdentityFile(file(), raw);
		const form = { mode: "self-start" as const, ownGoals: false, goals: [] };
		editIdentityOwnerForm(file(), form);
		await saveOpenIdentityFile(CONFIG.replace("request-only", "self-start"), file(), "owner-form");
		fileReply(last());
		expect(file().editText).toBe(raw);
		expect(file().ownerForm).toBeUndefined();
		editIdentityOwnerForm(file(), { ...form, mode: "request-only" });
		await saveOpenIdentityFile(raw, file(), "text");
		fileReply(last(), { hash: "h2" });
		expect(file().editText).toBeUndefined();
		expect(file().ownerForm?.mode).toBe("request-only");
		expect(eligible).not.toHaveBeenCalled();
	});

	it("captures all structured options and inactive invalid goals without partial-save authority", async () => {
		openFile("config", "fixture", CONFIG);
		const form = {
			mode: "self-start" as const,
			ownGoals: false,
			goals: [{ name: "synthetic goal", scope: "full scope", approvedAt: "unfinished date", endsAt: "not yet" }],
		};
		editIdentityOwnerForm(file(), form);
		ordinary.mockReturnValue(false);
		expect(await saveOpenIdentityFile(CONFIG, file(), "owner-form")).toBe(false);
		form.goals[0].name = "external mutation";
		expect(file().ownerForm).toMatchObject({
			mode: "self-start",
			ownGoals: false,
			goals: [{ name: "synthetic goal", approvedAt: "unfinished date", endsAt: "not yet" }],
		});
		expect(getIdentityOperations()[0]).toMatchObject({
			ownerForm: file().ownerForm,
			request: { text: CONFIG, file: "config" },
		});
		closeIdentityFile();
		openFile("config", "fixture", CONFIG);
		expect(file().ownerForm?.goals[0].scope).toBe("full scope");
		expect(eligible).not.toHaveBeenCalled();
	});
});

describe("real draft store: mixed save/accept/discard are correlated, never generic", () => {
	it.each(["save", "accept", "discard"] as const)(
		"%s captures all fields and refuses duplicate/old/no-echo results",
		async (action) => {
			openDraft();
			editIdentityDraft(draft(), { about: "about-A", prompt: "prompt-A", config: `${CONFIG} ` });
			const expected = draft();
			ordinary.mockClear();
			expect(await sendIdentityDraftAction(action, "prompt-A", `${CONFIG} `, "about-A", expected)).toBe(true);
			const request = last();
			expect(await sendIdentityDraftAction(action, "prompt-A", `${CONFIG} `, "about-A", expected)).toBe(false);
			expect(ordinary).toHaveBeenCalledTimes(1);
			expect(eligible).not.toHaveBeenCalled();
			expect(getIdentityOperations()[0]).toMatchObject({
				baseHash: "d0",
				action,
				values: { about: "about-A", prompt: "prompt-A", config: `${CONFIG} ` },
			});
			for (const ok of [true, false])
				for (const patch of [
					{ reqId: undefined },
					{ reqId: "unknown" },
					{ id: "another" },
					{ action: action === "save" ? ("accept" as const) : ("save" as const) },
				]) {
					draftReply(action, request, { ok, ...patch });
					expect(draft().busy).toBe(action);
					expect(draft().done).toBeUndefined();
				}
			editIdentityDraft(draft(), { about: "about-B", prompt: "prompt-B", config: `${CONFIG}\nB` });
			draftReply(action, request);
			expect(draft()).toMatchObject({
				busy: undefined,
				edits: { about: "about-B", prompt: "prompt-B", config: `${CONFIG}\nB` },
				done: { action, ok: true, revision: 1 },
			});
			if (action === "save")
				expect(draft()).toMatchObject({ about: "about-A", prompt: "prompt-A", config: `${CONFIG} `, hash: "d1" });
			else expect(draft()).toMatchObject({ about: "about-0", prompt: "prompt-0", hash: "d0" });
			const saved = draft();
			draftReply(action, request, { ok: false });
			expect(draft()).toBe(saved);
		},
	);

	for (const action of ["save", "accept", "discard"] as const)
		it.each(["false", "throw", "promise", "truthy", "committed-then-failed", "refusal"] as const)(
			`${action} retains all X/M fields on %s`,
			async (outcome) => {
				openDraft();
				editIdentityDraft(draft(), { about: "about-A", prompt: "prompt-A", config: `${CONFIG} ` });
				ordinary.mockImplementation((msg) => {
					sent.push(msg);
					if (outcome === "committed-then-failed") draftReply(action, last());
					if (outcome === "throw" || outcome === "committed-then-failed") throw new Error("synthetic failure");
					return outcome === "promise"
						? (Promise.resolve(true) as unknown as boolean)
						: outcome === "truthy"
							? (1 as unknown as boolean)
							: outcome === "refusal";
				});
				expect(await sendIdentityDraftAction(action, "prompt-A", `${CONFIG} `, "about-A")).toBe(outcome === "refusal");
				if (outcome === "refusal")
					draftReply(action, last(), { ok: false, code: "invalid", problems: ["synthetic problem"] });
				expect(draft()).toMatchObject({
					about: "about-0",
					prompt: "prompt-0",
					config: CONFIG,
					hash: "d0",
					busy: undefined,
					edits: { about: "about-A", prompt: "prompt-A", config: `${CONFIG} ` },
					done: { action, ok: false },
				});
				expect(getIdentityOperations()[0]).toMatchObject({
					values: { about: "about-A", prompt: "prompt-A", config: `${CONFIG} ` },
				});
				expect(eligible).not.toHaveBeenCalled();
			},
		);

	it.each(["save", "accept", "discard"] as const)(
		"%s handles eager result; close/reopen protects the new generation",
		async (action) => {
			openDraft();
			ordinary.mockImplementation((msg) => {
				sent.push(msg);
				if (msg.type === `identity_draft_${action}`) draftReply(action, last());
				return true;
			});
			expect(await sendIdentityDraftAction(action, "prompt-A", CONFIG, "about-A")).toBe(true);
			expect(draft().done?.ok).toBe(true);
			const previous = last();
			closeIdentityDraft();
			openDraft();
			editIdentityDraft(draft(), { about: "new-open", prompt: "newer", config: CONFIG });
			const reopened = draft();
			draftReply(action, previous, { ok: false });
			expect(draft()).toBe(reopened);
		},
	);

	it("draft save requires an exact-ok hash-bearing result, not a truthy/no-hash reply", async () => {
		openDraft();
		await sendIdentityDraftAction("save", "A", CONFIG, "about-A");
		draftReply("save", last(), { ok: 1 as unknown as boolean });
		expect(draft()).toMatchObject({ hash: "d0", prompt: "prompt-0", done: { ok: false }, edits: { prompt: "A" } });
		await sendIdentityDraftAction("save", "B", CONFIG, "about-B");
		draftReply("save", last(), { hash: undefined });
		expect(draft()).toMatchObject({ hash: "d0", prompt: "prompt-0", done: { ok: false }, edits: { prompt: "B" } });
	});

	it("keeps unsent mixed edits across view teardown and save A→B→A revisions", async () => {
		openDraft();
		const A = { about: "about-A", prompt: "prompt-A", config: CONFIG };
		editIdentityDraft(draft(), A);
		await sendIdentityDraftAction("save", A.prompt, A.config, A.about);
		const request = last();
		editIdentityDraft(draft(), { ...A, about: "B" });
		editIdentityDraft(draft(), A);
		draftReply("save", request);
		expect(draft()).toMatchObject({ edits: A, revision: 3, done: { revision: 1 } });
		closeIdentityDraft();
		openDraft();
		expect(draft().edits).toEqual(A);
		expect(eligible).not.toHaveBeenCalled();
	});

	it("an old generation draft ACK cannot close a same-resource reopened action", async () => {
		openDraft();
		await sendIdentityDraftAction("accept", "A", CONFIG, "about-A");
		const old = last();
		closeIdentityDraft();
		openDraft();
		await sendIdentityDraftAction("accept", "B", CONFIG, "about-B");
		const current = last();
		draftReply("accept", old);
		expect(draft().busy).toBe("accept");
		expect(draft().done).toBeUndefined();
		draftReply("accept", current);
		expect(draft().done?.ok).toBe(true);
	});
});
