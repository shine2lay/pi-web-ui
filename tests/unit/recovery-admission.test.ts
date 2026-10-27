import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	captureRecoveryMessage,
	createRecoveryAdmission,
	type AdmissionBinding,
	type AdmissionContext,
	type PublishOutcome,
	type RecoveryAdmissionOptions,
} from "../../web/src/recovery-admission";
import type {
	PreparedIdentity,
	PreparedRecoveryWork,
	PrepareRecoveryResult,
	RecoverySnapshot,
	RecoveryWork,
} from "../../web/src/pending-recovery-coordinator";
import type { ClientMessage, CommandDispositionMsg, UiState } from "../../web/src/types";

function deferred() {
	let release!: () => void;
	const promise = new Promise<void>((resolve) => {
		release = resolve;
	});
	return { promise, release };
}
function handoff() {
	let resolve!: (accepted: boolean) => void;
	let reject!: (error: Error) => void;
	const promise = new Promise<boolean>((yes, no) => {
		resolve = yes;
		reject = no;
	});
	return { promise, resolve, reject };
}
function fixture() {
	const transport = {};
	const state = {
		conversationId: "c1",
		sessionId: "s1",
		messages: [],
		queue: { steering: [], followUp: [] },
		isStreaming: false,
	} as unknown as UiState;
	const context: AdmissionContext = { transport, generation: "g1", sessionId: "s1", conversationId: "c1", state };
	let current = true;
	let pause: Promise<void> = Promise.resolve();
	let refusal: PrepareRecoveryResult | null = null;
	let outcome: PublishOutcome = { kind: "sent" };
	const entries = new Map<string, PreparedRecoveryWork>();
	const captured: RecoveryWork[] = [];
	const firstPublished = deferred();
	const published: {
		message: ClientMessage;
		prepared: PreparedRecoveryWork;
		context: AdmissionBinding;
		direct: boolean;
	}[] = [];
	const problems: string[] = [];
	const restored: RecoverySnapshot[] = [];
	const coordinator: RecoveryAdmissionOptions["coordinator"] = {
		start: vi.fn(async (): Promise<RecoverySnapshot> => ({ state: "ready", ownerId: "o1", entries: [], issues: [] })),
		restore: vi.fn(async (): Promise<RecoverySnapshot> => ({ state: "ready", ownerId: "o1", entries: [], issues: [] })),
		prepare: vi.fn(async (input: RecoveryWork): Promise<PrepareRecoveryResult> => {
			const work = structuredClone(input);
			captured.push(work);
			await pause;
			if (refusal) return refusal;
			const p = work.kind === "prompt" ? work.pending : work;
			const key = `${p.sessionId}:${p.id}`;
			const existing = entries.has(key);
			const prepared: PreparedRecoveryWork = {
				ownerId: "o1",
				kind: work.kind,
				sessionId: p.sessionId!,
				id: p.id,
				contentDigest: createHash("sha256").update(JSON.stringify(work)).digest("hex"),
				work,
			};
			entries.set(key, prepared);
			return { ok: true, payloadCommitted: true, dispatch: existing ? "status-required" : "first-send", prepared };
		}),
		returnToComposer: vi.fn(async (p: PreparedIdentity) => entries.get(`${p.sessionId}:${p.id}`)!.work),
		discard: vi.fn(async () => ({ released: true })),
		exportArtifact: vi.fn(async () => "full-original-artifact"),
	};
	const options: RecoveryAdmissionOptions = {
		coordinator,
		eligible: (m) => m.type === "prompt" || m.type === "write_file" || m.type === "edit_message",
		captureContext: () => context,
		isCurrent: () => current,
		publish: (message, prepared, origin, direct) => {
			published.push({ message, prepared, context: origin, direct });
			firstPublished.release();
			return outcome;
		},
		onRestore: (snapshot) => restored.push(snapshot),
		onProblem: (message) => problems.push(message),
	};
	const api = createRecoveryAdmission(options);
	return {
		api,
		options,
		coordinator,
		context,
		captured,
		published,
		problems,
		restored,
		firstPublished: firstPublished.promise,
		setCurrent: (v: boolean) => {
			current = v;
		},
		setPause: (v: Promise<void>) => {
			pause = v;
		},
		setRefusal: (v: PrepareRecoveryResult) => {
			refusal = v;
		},
		setOutcome: (v: PublishOutcome) => {
			outcome = v;
		},
	};
}
function disposition(f: ReturnType<typeof fixture>, patch: Partial<CommandDispositionMsg> = {}): CommandDispositionMsg {
	const sent = f.published.at(-1)!;
	return {
		type: "command_disposition",
		recovery: sent.message.recovery!,
		connectionGeneration: "g1",
		commandType: sent.message.type,
		status: "unprocessed",
		retryable: true,
		reason: "capacity",
		persistence: "unknown",
		releaseClientCopy: false,
		...patch,
	};
}
const prompt = (): ClientMessage => ({
	type: "prompt",
	id: "p1",
	text: "  exact original\n",
	forSession: "s1",
	attachments: [{ path: "", name: "α.png", mimeType: "image/png", imageData: "exact-image-bytes" }],
});
afterEach(() => vi.restoreAllMocks());

describe("native recovery admission", () => {
	it("refuses before startup without touching storage or transport", async () => {
		const f = fixture();
		expect(await f.api.admit(prompt())).toBe(false);
		expect(f.coordinator.prepare).not.toHaveBeenCalled();
		expect(f.published).toEqual([]);
	});
	it("starts/restores once, not once per render", async () => {
		const f = fixture();
		await Promise.all([f.api.start(), f.api.start()]);
		expect(f.coordinator.start).toHaveBeenCalledTimes(1);
		expect(f.restored).toHaveLength(1);
	});
	it("waits for complete commit and snapshots exact input before awaits", async () => {
		const f = fixture();
		await f.api.start();
		const wait = deferred();
		f.setPause(wait.promise);
		const input = prompt();
		const result = f.api.admit(input);
		if (input.type !== "prompt") throw new Error("fixture");
		input.text = "caller mutation";
		input.attachments![0].imageData = "mutated";
		expect(f.published).toHaveLength(0);
		wait.release();
		expect(await result).toBe(true);
		expect(f.published[0].message).toMatchObject({
			text: "  exact original\n",
			attachments: [{ imageData: "exact-image-bytes", name: "α.png" }],
			forSession: "s1",
			id: "p1",
		});
		expect(f.published[0].message.recovery?.contentDigest).toMatch(/^[a-f0-9]{64}$/);
	});
	it.each([false, true])("ANY storage refusal prevents publication, payloadCommitted=%s", async (payloadCommitted) => {
		const f = fixture();
		await f.api.start();
		f.setRefusal({
			ok: false,
			payloadCommitted,
			error: { code: "transaction", message: "synthetic storage failure" },
			work: null,
		});
		expect(await f.api.admit(prompt())).toBe(false);
		expect(f.published).toHaveLength(0);
		expect(f.coordinator.discard).not.toHaveBeenCalled();
	});
	it("storage throws also refuse, never fall back to synchronous send", async () => {
		const f = fixture();
		await f.api.start();
		vi.mocked(f.coordinator.prepare).mockRejectedValueOnce(new Error("quota"));
		expect(await f.api.admit(prompt())).toBe(false);
		expect(f.published).toHaveLength(0);
	});
	it("target/socket change during commit keeps original and prevents wire", async () => {
		const f = fixture();
		await f.api.start();
		const wait = deferred();
		f.setPause(wait.promise);
		const promise = f.api.admit(prompt());
		f.setCurrent(false);
		wait.release();
		expect(await promise).toBe(false);
		expect(f.captured[0]).toMatchObject({ kind: "prompt", pending: { sessionId: "s1", text: "  exact original\n" } });
		expect(f.published).toHaveLength(0);
	});
	it("never relabels a foreign forSession", async () => {
		const f = fixture();
		await f.api.start();
		expect(await f.api.admit({ type: "prompt", text: "old target", forSession: "other" })).toBe(false);
		expect(f.coordinator.prepare).not.toHaveBeenCalled();
	});
	it("does not journal unknown/sensitive transport", async () => {
		const f = fixture();
		await f.api.start();
		expect(await f.api.admit({ type: "set_provider_api_key", provider: "synthetic", apiKey: "test-only" })).toBe(false);
		expect(f.coordinator.prepare).not.toHaveBeenCalled();
		expect(f.published).toHaveLength(0);
	});
	it("keeps a deliberate command opaque, with exact body, not a prompt carrier", async () => {
		const f = fixture();
		await f.api.start();
		const input: ClientMessage = { type: "write_file", path: "notes.txt", text: "  α\n\u0000 exact" };
		expect(await f.api.admit(input)).toBe(true);
		expect(f.captured[0]).toMatchObject({ kind: "command", payload: JSON.stringify(input), sessionId: "s1" });
		expect(f.published[0].message.type).toBe("write_file");
	});
	it("does not retain an entire old view in the published/attempt binding", async () => {
		const f = fixture();
		await f.api.start();
		expect(await f.api.admit(prompt())).toBe(true);
		const binding = f.published[0].context;
		expect(binding).not.toHaveProperty("state");
		expect(binding).not.toHaveProperty("messages");
		expect(binding).toMatchObject({ generation: "g1", sessionId: "s1", conversationId: "c1" });
		expect(f.captured[0]).toMatchObject({ kind: "prompt", pending: { text: "  exact original\n", sessionId: "s1" } });
	});
	it("awaits exact host-owned admission rather than clearing on ws.send", async () => {
		const f = fixture();
		await f.api.start();
		const accepted = handoff();
		f.setOutcome({ kind: "sent", accepted: accepted.promise });
		let settled = false;
		const admitting = f.api.admit(prompt()).then((result) => {
			settled = true;
			return result;
		});
		await f.firstPublished;
		expect(settled).toBe(false);
		expect(f.captured).toHaveLength(1);
		accepted.resolve(true);
		expect(await admitting).toBe(true);
		expect(f.coordinator.discard).not.toHaveBeenCalled();
	});
	it.each(["refuse", "throw", "target-change"] as const)("retains the full checkpoint on host %s", async (failure) => {
		const f = fixture();
		await f.api.start();
		const accepted = handoff();
		f.setOutcome({ kind: "sent", accepted: accepted.promise });
		const admitting = f.api.admit(prompt());
		await f.firstPublished;
		if (failure === "target-change") f.setCurrent(false);
		if (failure === "throw") accepted.reject(new Error("fixture transport failed"));
		else accepted.resolve(failure !== "refuse");
		expect(await admitting).toBe(false);
		expect(f.published).toHaveLength(1);
		expect(f.captured[0]).toMatchObject({
			kind: "prompt",
			pending: { text: "  exact original\n", attachments: [{ imageData: "exact-image-bytes" }] },
		});
		expect(f.coordinator.discard).not.toHaveBeenCalled();
	});
	it("keeps a caller's exact operation reqId as command identity, without a new target", async () => {
		const f = fixture();
		await f.api.start();
		f.options.eligible = (msg) => msg.type === "identity_file_save";
		const input: ClientMessage = {
			type: "identity_file_save",
			id: "ops",
			file: "about",
			text: "  draft\n",
			baseHash: "h1",
			ref: "editor",
			reqId: "original-r1",
		};
		expect(await f.api.admit(input)).toBe(true);
		expect(f.published[0].prepared).toMatchObject({
			id: "original-r1",
			sessionId: "s1",
			work: { kind: "command", payload: JSON.stringify(input) },
		});
		expect(f.published[0].message).toMatchObject({
			id: "ops",
			reqId: "original-r1",
			recovery: { id: "original-r1", sessionId: "s1" },
		});
	});
	it("restored/duplicate identity requires status; it is not automatically replayed", async () => {
		const f = fixture();
		await f.api.start();
		await f.api.admit(prompt());
		expect(await f.api.admit(prompt())).toBe(false);
		expect(f.published).toHaveLength(1);
	});
	it("held work is committed again before its FIRST actual transmission", async () => {
		const f = fixture();
		await f.api.start();
		f.setOutcome({ kind: "held" });
		expect(await f.api.admit(prompt())).toBe(true);
		const first = f.published[0];
		const wait = deferred();
		f.setPause(wait.promise);
		f.setOutcome({ kind: "sent" });
		const flush = f.api.flushHeld(first.prepared);
		expect(f.published).toHaveLength(1);
		wait.release();
		expect(await flush).toBe(true);
		expect(f.published[1].direct).toBe(true);
		expect(f.published[1].message.recovery?.attemptId).not.toBe(first.message.recovery?.attemptId);
		expect(f.published[1].message).toMatchObject({ id: "p1", text: "  exact original\n" });
	});
	it("duplicate held flush cannot send twice", async () => {
		const f = fixture();
		await f.api.start();
		f.setOutcome({ kind: "held" });
		await f.api.admit(prompt());
		const p = f.published[0].prepared;
		f.setOutcome({ kind: "sent" });
		const [a, b] = await Promise.all([f.api.flushHeld(p), f.api.flushHeld(p)]);
		expect([a, b].filter(Boolean)).toHaveLength(1);
		expect(f.published).toHaveLength(2);
	});
	it("throw after possible socket handoff remains uncertain; a negative lookup alone cannot replay", async () => {
		const f = fixture();
		await f.api.start();
		f.options.publish = (message, prepared, context, direct) => {
			f.published.push({ message, prepared, context, direct });
			throw new Error("send failed");
		};
		expect(await f.api.admit(prompt())).toBe(false);
		expect(await f.api.retry(f.published[0].prepared, async () => "negative")).toBe(false);
		expect(f.published).toHaveLength(1);
	});
	it("matches every generation/identity/attempt field and never treats disposition as deletion", async () => {
		const f = fixture();
		await f.api.start();
		await f.api.admit(prompt());
		const good = disposition(f);
		for (const bad of [
			{ ...good, connectionGeneration: "old" },
			{ ...good, recovery: { ...good.recovery, attemptId: "old" } },
			{ ...good, recovery: { ...good.recovery, sessionId: "other" } },
			{ ...good, recovery: { ...good.recovery, contentDigest: "wrong" } },
		])
			expect(f.api.receiveDisposition(bad, f.context.transport)).toBe(false);
		expect(f.api.receiveDisposition(good, {})).toBe(false);
		expect(f.api.receiveDisposition(good, f.context.transport)).toBe(true);
		expect(f.coordinator.discard).not.toHaveBeenCalled();
	});
	it("known unprocessed plus fresh exact status permits one explicit immutable retry", async () => {
		const f = fixture();
		await f.api.start();
		await f.api.admit(prompt());
		const first = f.published[0];
		f.api.receiveDisposition(disposition(f), f.context.transport);
		const probe = vi.fn(async () => "negative" as const);
		expect(await f.api.retry(first.prepared, probe)).toBe(true);
		expect(probe).toHaveBeenCalledTimes(1);
		expect(f.published[1].message).toMatchObject({
			id: "p1",
			text: "  exact original\n",
			attachments: [{ imageData: "exact-image-bytes" }],
		});
		expect(f.published[1].message.recovery?.attemptId).not.toBe(first.message.recovery?.attemptId);
		expect(await f.api.retry(first.prepared, probe)).toBe(false);
	});
	it("dispatch-started uncertainty cannot be erased by a later contradictory refusal", async () => {
		const f = fixture();
		await f.api.start();
		await f.api.admit(prompt());
		expect(
			f.api.receiveDisposition(
				disposition(f, { status: "uncertain", retryable: false, reason: "dispatch-started" }),
				f.context.transport,
			),
		).toBe(true);
		expect(f.api.receiveDisposition(disposition(f), f.context.transport)).toBe(false);
		expect(await f.api.retry(f.published[0].prepared, async () => "negative")).toBe(false);
		expect(f.published).toHaveLength(1);
	});
	it("known unprocessed work can retry after reconnect on the same exact session with fresh status", async () => {
		const f = fixture();
		await f.api.start();
		f.options.isCurrent = (origin) =>
			origin.transport === f.context.transport &&
			origin.generation === f.context.generation &&
			origin.sessionId === f.context.sessionId;
		await f.api.admit(prompt());
		const first = f.published[0];
		f.api.receiveDisposition(disposition(f), f.context.transport);
		f.context.transport = {};
		f.context.generation = "g2";
		expect(await f.api.retry(first.prepared, async () => "negative")).toBe(true);
		expect(f.published[1].context).toMatchObject({ generation: "g2", sessionId: "s1" });
		expect(f.published[1].context.transport).toBe(f.context.transport);
		expect(f.published[1].message).toMatchObject({ id: "p1", forSession: "s1", text: "  exact original\n" });
	});
	it.each(["handled", "unknown"] as const)(
		"%s status never authorizes retry even after an earlier refusal",
		async (status) => {
			const f = fixture();
			await f.api.start();
			await f.api.admit(prompt());
			f.api.receiveDisposition(disposition(f), f.context.transport);
			expect(await f.api.retry(f.published[0].prepared, async () => status)).toBe(false);
			expect(f.published).toHaveLength(1);
		},
	);
	it.each(["return", "discard"] as const)(
		"%s cancels a held first transmission even while its checkpoint is awaiting",
		async (action) => {
			const f = fixture();
			await f.api.start();
			f.setOutcome({ kind: "held" });
			await f.api.admit(prompt());
			const identity = f.published[0].prepared;
			const wait = deferred();
			f.setPause(wait.promise);
			f.setOutcome({ kind: "sent" });
			const flushing = f.api.flushHeld(identity);
			if (action === "return") await f.api.returnToComposer(identity);
			else await f.api.discard(identity);
			wait.release();
			expect(await flushing).toBe(false);
			expect(f.published).toHaveLength(1);
		},
	);
	it("recheck is explicit read-only restoration, not save/replay/cleanup", async () => {
		const f = fixture();
		await f.api.start();
		expect(f.api.ready).toBe(true);
		await f.api.recheck();
		expect(f.coordinator.restore).toHaveBeenCalledTimes(1);
		expect(f.coordinator.prepare).not.toHaveBeenCalled();
		expect(f.coordinator.discard).not.toHaveBeenCalled();
		expect(f.published).toEqual([]);
	});
	it("return retains original; only separate explicit discard calls release", async () => {
		const f = fixture();
		await f.api.start();
		await f.api.admit(prompt());
		const identity = f.published[0].prepared;
		expect(await f.api.returnToComposer(identity)).toMatchObject({
			kind: "prompt",
			pending: { text: "  exact original\n" },
		});
		expect(f.coordinator.discard).not.toHaveBeenCalled();
		await f.api.discard(identity);
		expect(f.coordinator.discard).toHaveBeenCalledWith({ intent: "discard", identity });
	});
	it("does not invoke accessors or custom JSON conversion while capturing an original", () => {
		let reads = 0;
		const getter = { type: "prompt" };
		Object.defineProperty(getter, "text", {
			enumerable: true,
			get: () => {
				reads++;
				return "changed";
			},
		});
		expect(() => captureRecoveryMessage(getter as ClientMessage)).toThrow();
		expect(reads).toBe(0);
		const custom = { type: "prompt", text: "original" };
		Object.defineProperty(custom, "toJSON", { value: () => ({ type: "prompt", text: "not original" }) });
		expect(() => captureRecoveryMessage(custom as ClientMessage)).toThrow();
	});
	it("refuses sparse originals but preserves undefined optional object fields by normal wire omission", () => {
		const attachments = new Array(1);
		expect(() => captureRecoveryMessage({ type: "prompt", text: "x", attachments })).toThrow();
		expect(captureRecoveryMessage({ type: "prompt", text: "  original\n", id: undefined })).toEqual({
			type: "prompt",
			text: "  original\n",
		});
	});
	it.each([NaN, Infinity, () => true, Symbol("unsupported")])(
		"rejects non-JSON original data without silent coercion",
		(text) => {
			expect(() => captureRecoveryMessage({ type: "prompt", text } as unknown as ClientMessage)).toThrow();
		},
	);
});
