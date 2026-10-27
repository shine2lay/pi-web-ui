import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
	createNativeRecoveryClient,
	recoveryIdentityKey,
	type NativeRecoveryPort,
	type RecoveryCoordinatorFactory,
} from "../../web/src/recovery-client";
import { createRecoveryChatTransport, createReferenceVerifier } from "../../web/src/recovery-chat";
import { selectDraftToRestore } from "../../web/src/composer-draft";
import type { AdmissionContext, PublishOutcome, RecoveryAdmissionOptions } from "../../web/src/recovery-admission";
import type {
	PreparedRecoveryWork,
	PrepareRecoveryResult,
	RecoverySnapshot,
	RecoveryWork,
} from "../../web/src/pending-recovery-coordinator";
import type { PendingSend } from "../../web/src/pending-sends";
import type { ClientMessage, CommandDispositionMsg, UiState } from "../../web/src/types";

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: Error) => void;
	const promise = new Promise<T>((yes, no) => {
		resolve = yes;
		reject = no;
	});
	return { promise, resolve, reject };
}
function prompt(id = "p1"): ClientMessage {
	return {
		type: "prompt",
		id,
		text: "  original α\n",
		attachments: [
			{ path: "selected.bin", fileData: "QUJD", mimeType: "application/octet-stream", name: "exact α.bin" },
		],
	};
}
function fixture(initial?: RecoverySnapshot) {
	const transport = {};
	const lifetime = {};
	const context: AdmissionContext = {
		transport,
		lifetime,
		generation: "g1",
		conversationId: "c1",
		sessionId: "s1",
		state: {
			conversationId: "c1",
			sessionId: "s1",
			messages: [],
			queue: { steering: [], followUp: [] },
			isStreaming: false,
		} as unknown as UiState,
	};
	const entries = new Map<string, PreparedRecoveryWork>();
	for (const entry of initial?.entries ?? []) entries.set(entry.prepared.id, entry.prepared);
	let pause: Promise<void> = Promise.resolve();
	let outcome: PublishOutcome = { kind: "sent" };
	let snapshot = initial;
	const close = vi.fn();
	const coordinator: RecoveryAdmissionOptions["coordinator"] = {
		start: vi.fn(
			async (): Promise<RecoverySnapshot> => snapshot ?? { state: "ready", ownerId: "o1", entries: [], issues: [] },
		),
		restore: vi.fn(
			async (): Promise<RecoverySnapshot> =>
				snapshot ?? {
					state: "ready",
					ownerId: "o1",
					entries: [...entries.values()].map((prepared) => ({
						prepared,
						lifecycle: "unresolved",
						complete: true,
						issues: [],
					})),
					issues: [],
				},
		),
		prepare: vi.fn(async (input: RecoveryWork): Promise<PrepareRecoveryResult> => {
			const work = structuredClone(input);
			await pause;
			const p = work.kind === "prompt" ? work.pending : work;
			const duplicate = entries.has(p.id);
			const prepared: PreparedRecoveryWork = {
				ownerId: "o1",
				kind: work.kind,
				id: p.id,
				sessionId: p.sessionId!,
				contentDigest: createHash("sha256").update(JSON.stringify(work)).digest("hex"),
				work,
			};
			entries.set(p.id, prepared);
			return { ok: true, payloadCommitted: true, dispatch: duplicate ? "status-required" : "first-send", prepared };
		}),
		returnToComposer: vi.fn(async (identity) => {
			const work = entries.get(identity.id)?.work;
			if (!work) throw new Error("Synthetic original is missing");
			return work;
		}),
		discard: vi.fn(async () => ({ released: true })),
		exportArtifact: vi.fn(async () => JSON.stringify([...entries.values()])),
	};
	const published: { message: ClientMessage; prepared: PreparedRecoveryWork }[] = [];
	const problems: string[] = [];
	const port: NativeRecoveryPort = {
		captureContext: () => context,
		isCurrent: (binding) =>
			binding.transport === transport && binding.lifetime === lifetime && binding.generation === "g1",
		publish: (message, prepared) => {
			published.push({ message, prepared });
			return outcome;
		},
		problem: (message) => {
			problems.push(message);
		},
		cancelHold: vi.fn(),
		saved: vi.fn(),
		restored: vi.fn(),
	};
	let verifyReference!: Parameters<RecoveryCoordinatorFactory>[0];
	const factory = vi.fn((verify: Parameters<RecoveryCoordinatorFactory>[0]) => {
		verifyReference = verify;
		return Object.assign(coordinator, { close });
	});
	const client = createNativeRecoveryClient(factory);
	const detach = client.attach(port);
	return {
		client,
		port,
		detach,
		close,
		context,
		coordinator,
		published,
		problems,
		entries,
		get verifier() {
			return verifyReference!;
		},
		setPause(p: Promise<void>) {
			pause = p;
		},
		setOutcome(value: PublishOutcome) {
			outcome = value;
		},
		setSnapshot(value: RecoverySnapshot) {
			snapshot = value;
		},
	};
}
function disposition(f: ReturnType<typeof fixture>, status: "unprocessed" | "uncertain"): CommandDispositionMsg {
	const p = f.published[0];
	return {
		type: "command_disposition",
		recovery: p.message.recovery!,
		connectionGeneration: "g1",
		commandType: p.message.type,
		status,
		retryable: status === "unprocessed",
		reason: status === "unprocessed" ? "capacity" : "dispatch-started",
		persistence: "unknown",
		releaseClientCopy: false,
	};
}

describe("document-lifetime native recovery ports", () => {
	it("does no startup/send on construction and starts only once across detach/remount", async () => {
		const f = fixture();
		expect(f.coordinator.start).not.toHaveBeenCalled();
		expect(f.published).toEqual([]);
		await f.client.start();
		f.detach();
		const detach2 = f.client.attach({ ...f.port });
		await f.client.start();
		detach2();
		expect(f.coordinator.start).toHaveBeenCalledTimes(1);
		expect(f.close).not.toHaveBeenCalled();
		expect(f.client.getSnapshot().state).toBe("ready");
	});
	it("publishes event-driven immutable complete originals, not a coordinator snapshot per read", async () => {
		const f = fixture();
		await f.client.start();
		const listener = vi.fn();
		const unsubscribe = f.client.subscribe(listener);
		const message = prompt();
		if (message.type !== "prompt") throw new Error("fixture");
		const bytes = "QUJD".repeat(400_001);
		message.attachments![0].fileData = bytes;
		expect(await f.client.admit(message)).toBe(true);
		const view = f.client.getSnapshot();
		for (let i = 0; i < 100; i++) expect(f.client.getSnapshot()).toBe(view);
		expect(f.coordinator.restore).not.toHaveBeenCalled();
		expect(view.items).toHaveLength(1);
		expect(view.items[0].delivery).toBe("uncertain");
		const original = view.items[0].prepared.work;
		if (original.kind !== "prompt") throw new Error("fixture");
		expect(original.pending.attachments![0].fileData === bytes).toBe(true);
		expect(original.pending.text).toBe("  original α\n");
		expect(Object.isFrozen(view.items)).toBe(true);
		expect(Object.isFrozen(original.pending.attachments)).toBe(true);
		expect(listener).toHaveBeenCalled();
		unsubscribe();
		expect(f.coordinator.discard).not.toHaveBeenCalled();
	});
	it("retains the same saved record when a React port goes away", async () => {
		const f = fixture();
		await f.client.start();
		await f.client.admit(prompt());
		const key = recoveryIdentityKey(f.client.getSnapshot().items[0].prepared);
		f.detach();
		expect(await f.client.admit(prompt("p2"))).toBe(false);
		f.client.attach({ ...f.port });
		expect(recoveryIdentityKey(f.client.getSnapshot().items[0].prepared)).toBe(key);
		expect(f.client.getSnapshot().items).toHaveLength(1);
		expect(f.close).not.toHaveBeenCalled();
	});
	it("an old cleanup cannot detach the new active port", async () => {
		const f = fixture();
		await f.client.start();
		const nextPublish = vi.fn((): PublishOutcome => ({ kind: "sent" }));
		f.client.attach({ ...f.port, publish: nextPublish });
		f.detach();
		expect(await f.client.admit(prompt())).toBe(true);
		expect(nextPublish).toHaveBeenCalledTimes(1);
		expect(f.published).toEqual([]);
	});
	it("a replaced port cannot publish an old delayed checkpoint", async () => {
		const f = fixture();
		await f.client.start();
		const wait = deferred<void>();
		f.setPause(wait.promise);
		const saving = f.client.admit(prompt());
		const nextPublish = vi.fn((): PublishOutcome => ({ kind: "sent" }));
		f.client.attach({ ...f.port, isCurrent: () => false, publish: nextPublish });
		wait.resolve();
		expect(await saving).toBe(false);
		expect(f.published).toEqual([]);
		expect(nextPublish).not.toHaveBeenCalled();
		expect(f.client.getSnapshot().items).toHaveLength(1);
	});
	it("does not treat an incomplete restore as empty or allow a new publication", async () => {
		const work: RecoveryWork = {
			kind: "prompt",
			pending: {
				id: "old",
				conversationId: "c1",
				sessionId: "s1",
				text: "original reference",
				attachments: [{ path: "/selected/unresolved", mode: "reference" }],
				queue: false,
				createdAt: 1,
				status: "sending",
				sameTextBefore: [],
				queueBase: 0,
			},
		};
		const prepared: PreparedRecoveryWork = {
			ownerId: "o1",
			kind: "prompt",
			id: "old",
			sessionId: "s1",
			contentDigest: "original-digest",
			work,
		};
		const f = fixture({
			state: "incomplete",
			ownerId: "o1",
			entries: [
				{
					prepared,
					lifecycle: "unresolved",
					complete: false,
					issues: [{ code: "reference", message: "Original selected bytes need verification." }],
				},
			],
			issues: [{ code: "reference", message: "Source unresolved." }],
		});
		await f.client.start();
		expect(f.client.ready).toBe(false);
		expect(await f.client.admit(prompt())).toBe(false);
		expect(f.client.getSnapshot().items[0]).toMatchObject({ complete: false, delivery: "blocked" });
		expect(f.coordinator.prepare).not.toHaveBeenCalled();
		expect(await f.client.exportArtifact()).toContain("original reference");
		expect(f.coordinator.discard).not.toHaveBeenCalled();
	});
	it("a restore-display exception cannot authorize sends", async () => {
		const f = fixture();
		f.port.restored = () => {
			throw new Error("detached view");
		};
		await f.client.start();
		expect(f.client.ready).toBe(false);
		expect(await f.client.admit(prompt())).toBe(false);
		expect(f.client.getSnapshot().state).toBe("incomplete");
		expect(f.published).toEqual([]);
	});
	it("a throwing listener/saved renderer cannot release or lose a committed original", async () => {
		const f = fixture();
		await f.client.start();
		f.client.subscribe(() => {
			throw new Error("renderer");
		});
		f.port.saved = () => {
			throw new Error("old view");
		};
		expect(await f.client.admit(prompt())).toBe(true);
		expect(f.client.getSnapshot().items).toHaveLength(1);
		expect(f.coordinator.discard).not.toHaveBeenCalled();
	});
	it("does not pretend WS publication is an owned admission", async () => {
		const f = fixture();
		await f.client.start();
		const owned = deferred<boolean>();
		f.setOutcome({ kind: "sent", accepted: owned.promise });
		let done = false;
		const saving = f.client.admit(prompt()).then((value) => {
			done = true;
			return value;
		});
		await vi.waitFor(() => expect(f.published).toHaveLength(1));
		expect(done).toBe(false);
		expect(f.client.receiveDisposition(disposition(f, "uncertain"), f.context.transport)).toBe(true);
		owned.resolve(true);
		expect(await saving).toBe(true);
		expect(f.coordinator.discard).not.toHaveBeenCalled();
		expect(f.client.getSnapshot().items[0].delivery).toBe("uncertain");
	});
	it("typed refusal refines this exact attempt without deleting it", async () => {
		const f = fixture();
		await f.client.start();
		const owned = deferred<boolean>();
		f.setOutcome({ kind: "sent", accepted: owned.promise });
		const saving = f.client.admit(prompt());
		await vi.waitFor(() => expect(f.published).toHaveLength(1));
		const result = disposition(f, "unprocessed");
		expect(
			f.client.receiveDisposition(
				{ ...result, recovery: { ...result.recovery, attemptId: "stale" } },
				f.context.transport,
			),
		).toBe(false);
		expect(f.client.receiveDisposition(result, f.context.transport)).toBe(true);
		owned.resolve(false);
		expect(await saving).toBe(false);
		expect(f.client.getSnapshot().items[0].delivery).toBe("unprocessed");
		expect(f.coordinator.discard).not.toHaveBeenCalled();
	});
	it("socket failure remains uncertainty with the full copy", async () => {
		const f = fixture();
		await f.client.start();
		const owned = deferred<boolean>();
		f.setOutcome({ kind: "sent", accepted: owned.promise });
		const saving = f.client.admit(prompt());
		await vi.waitFor(() => expect(f.published).toHaveLength(1));
		owned.reject(new Error("socket closed"));
		expect(await saving).toBe(false);
		expect(f.client.getSnapshot().items[0].delivery).toBe("uncertain");
		expect(f.coordinator.discard).not.toHaveBeenCalled();
	});
	it("return cancels a local hold but is not discard, even if its view throws", async () => {
		const f = fixture();
		await f.client.start();
		f.setOutcome({ kind: "held" });
		await f.client.admit(prompt());
		const identity = f.client.getSnapshot().items[0].prepared;
		f.port.cancelHold = () => {
			throw new Error("unmounted renderer");
		};
		const returned = await f.client.returnToComposer(identity);
		expect(returned?.kind).toBe("prompt");
		expect(f.client.getSnapshot().items[0].delivery).toBe("unprocessed");
		expect(f.coordinator.discard).not.toHaveBeenCalled();
	});
	it("only explicit successfully committed discard removes a view item", async () => {
		const f = fixture();
		await f.client.start();
		await f.client.admit(prompt());
		const identity = f.client.getSnapshot().items[0].prepared;
		vi.mocked(f.coordinator.discard).mockResolvedValueOnce({
			released: false,
			error: { code: "transaction", message: "Not committed." },
		});
		expect((await f.client.discard(identity)).released).toBe(false);
		expect(f.client.getSnapshot().items).toHaveLength(1);
		expect((await f.client.discard(identity)).released).toBe(true);
		expect(f.client.getSnapshot().items).toEqual([]);
	});
	it("reference verification needs an actual unchanged port, never a default true", async () => {
		const f = fixture();
		const pending: PendingSend = {
			id: "p",
			conversationId: "c1",
			sessionId: "s1",
			text: "x",
			queue: false,
			createdAt: 1,
			status: "sending",
			sameTextBefore: [],
			queueBase: 0,
		};
		expect(await f.verifier({ path: "/selected" }, pending)).toBe(false);
		const wait = deferred<boolean>();
		f.port.verifyReference = () => wait.promise;
		const verifying = f.verifier({ path: "/selected" }, pending);
		f.client.attach({ ...f.port });
		wait.resolve(true);
		expect(await verifying).toBe(false);
	});
	it("explicit source recheck updates the view but never publishes/replays", async () => {
		const f = fixture();
		await f.client.start();
		await f.client.admit(prompt());
		const count = f.published.length;
		await f.client.recheck();
		expect(f.coordinator.restore).toHaveBeenCalledTimes(1);
		expect(f.published).toHaveLength(count);
		expect(f.coordinator.discard).not.toHaveBeenCalled();
	});
});

describe("createReferenceVerifier & AskHub #592 occurrence transport & draft reload protection", () => {
	const basePending: PendingSend = {
		id: "p-ref",
		conversationId: "c1",
		sessionId: "s1",
		text: "check references",
		queue: false,
		createdAt: 100,
		status: "sending",
		sameTextBefore: [],
		queueBase: 0,
	};

	it("verifies inline bytes, relative imageUrl, uploadPath, file/lines, conversation, and page references", async () => {
		const files = new Map<string, Uint8Array>([
			["/api/attachment/abcd1234?token=t", new TextEncoder().encode("PNG-BYTES")],
			["/api/file?download=1&clientId=cli-1&path=%2Ftmp%2Fup.bin&token=t", new TextEncoder().encode("UPLOADED-12B")],
			[
				"/api/file?download=1&clientId=cli-1&path=src%2Findex.ts&token=t",
				new TextEncoder().encode("line1\nline2\nline3\n"),
			],
			[
				"/api/file?download=1&clientId=cli-1&path=%2Fsessions%2Fpeer.jsonl&token=t",
				new TextEncoder().encode('{"id":"m1"}\n'),
			],
		]);
		let activeSid = "s1";
		const grantedPages = new Set<string>(["https://example.com/doc::s1"]);
		const verify = createReferenceVerifier({
			clientId: () => "cli-1",
			conversations: () => [{ id: "c1" }, { id: "c-peer" }],
			activeSessionId: () => activeSid,
			withToken: (u) => `${u}${u.includes("?") ? "&" : "?"}token=t`,
			isPageGranted: (url, sid) => grantedPages.has(`${url}::${sid}`),
			fetchUrl: async (url) => {
				const body = files.get(url);
				if (!body) {
					return { ok: false, arrayBuffer: async () => new ArrayBuffer(0) };
				}
				return {
					ok: true,
					arrayBuffer: async () => new Uint8Array(body).buffer,
				};
			},
		});

		// 1. Inline bytes pass immediately
		expect(await verify({ path: "a.txt", fileData: "QUJD" }, basePending)).toBe(true);
		// 2. Relative imageUrl checks bytes + exact size
		expect(await verify({ path: "img.png", imageUrl: "/api/attachment/abcd1234", size: 9 }, basePending)).toBe(true);
		expect(await verify({ path: "img.png", imageUrl: "/api/attachment/abcd1234", size: 10 }, basePending)).toBe(false);
		expect(await verify({ path: "img.png", imageUrl: "/api/attachment/missing" }, basePending)).toBe(false);
		expect(await verify({ path: "img.png", imageUrl: "https://evil.example/img.png" }, basePending)).toBe(false);
		// 3. uploadPath checks bytes + rejects traversal or blob:
		expect(await verify({ path: "", uploadPath: "/tmp/up.bin", size: 12 }, basePending)).toBe(true);
		expect(await verify({ path: "", uploadPath: "/tmp/up.bin", size: 99 }, basePending)).toBe(false);
		expect(await verify({ path: "", uploadPath: "../secret.bin" }, basePending)).toBe(false);
		expect(await verify({ path: "blob:https://localhost/123" }, basePending)).toBe(false);
		// 4. File reference and lines range check
		expect(await verify({ path: "src/index.ts", mode: "reference", size: 18 }, basePending)).toBe(true);
		expect(
			await verify({ path: "src/index.ts", mode: "lines", lines: { start: 2, end: 3 }, size: 18 }, basePending),
		).toBe(true);
		expect(
			await verify({ path: "src/index.ts", mode: "lines", lines: { start: 5, end: 6 }, size: 18 }, basePending),
		).toBe(false);
		// 5. Conversation mode checks active session + live conversation or sessionPath
		expect(await verify({ path: "c-peer", mode: "conversation", conversationId: "c-peer" }, basePending)).toBe(true);
		expect(await verify({ path: "c-gone", mode: "conversation", conversationId: "c-gone" }, basePending)).toBe(false);
		expect(
			await verify(
				{ path: "/sessions/peer.jsonl", mode: "conversation", sessionPath: "/sessions/peer.jsonl" },
				basePending,
			),
		).toBe(true);
		// 6. Page mode fails closed unless active session + explicit page grant match
		expect(await verify({ path: "https://example.com/doc", mode: "page" }, basePending)).toBe(true);
		expect(await verify({ path: "https://example.com/other", mode: "page" }, basePending)).toBe(false);
		activeSid = "s-other";
		expect(await verify({ path: "https://example.com/doc", mode: "page" }, basePending)).toBe(false);
		expect(await verify({ path: "c-peer", mode: "conversation", conversationId: "c-peer" }, basePending)).toBe(false);
	});

	it("correlates AskHub #592 task_queue_answer with occurrence identity and preserves draft on mismatch or disconnect", async () => {
		const sent: ClientMessage[] = [];
		const socket = {
			readyState: 1 as const,
			send: (raw: string) => {
				sent.push(JSON.parse(raw) as ClientMessage);
			},
		};
		const state: UiState = {
			conversationId: "c-ops",
			sessionId: "s-ops",
			model: null,
			thinkingLevel: "off",
			isStreaming: false,
			isCompacting: false,
			autoCompactionEnabled: true,
			messageCount: 0,
			messages: [],
			pendingModelSwitch: null,
			notices: [],
			taskQueue: {
				running: false,
				available: true,
				lanes: [],
				queueId: "q-ops",
				tasks: [
					{
						id: 570,
						status: "stuck",
						plan: {
							title: "Durable W2",
							goal: "g",
							doneWhen: "d",
							decided: "dec",
							steps: "s",
							verify: "v",
							mustNot: "m",
						},
						question: "Which rollout?",
						choices: ["Staged rollout", "All at once"],
						detail: "Choose one",
						createdAt: 1,
					},
				],
				answerBindings: [
					{
						conversationId: "c-ops",
						queueId: "q-ops",
						taskId: 570,
						questionId: "q-occ-1",
						question: "Which rollout?",
						choices: ["Staged rollout", "All at once"],
						detail: "Choose one",
					},
				],
			},
		} as unknown as UiState;
		const transport = createRecoveryChatTransport({
			view: () => ({ state, preview: null }),
			captureOriginal: (message) => ({ message }),
			pending: () => {},
			problem: () => {},
		});
		transport.connect(socket);
		transport.ready(socket, "gen-1");
		transport.initialize(socket, "gen-1");
		transport.bindSnapshot(socket, state);

		// Mismatched questionId is refused locally before transmitting
		const badOccurrence = await transport.answerQueueTask({
			binding: {
				conversationId: "c-ops",
				queueId: "q-ops",
				taskId: 570,
				questionId: "q-occ-stale",
				question: "Which rollout?",
				choices: ["Staged rollout", "All at once"],
				detail: "Choose one",
			},
			text: "Staged rollout",
		});
		expect(badOccurrence).toBe(false);
		expect(sent).toHaveLength(0);

		// Valid bound occurrence transmits with generated reqId and resolves true only on matching result
		const pendingAnswer = transport.answerQueueTask({
			binding: {
				conversationId: "c-ops",
				queueId: "q-ops",
				taskId: 570,
				questionId: "q-occ-1",
				question: "Which rollout?",
				choices: ["Staged rollout", "All at once"],
				detail: "Choose one",
			},
			text: "Staged rollout",
		});
		expect(sent).toHaveLength(1);
		const wire = sent[0] as Extract<ClientMessage, { type: "task_queue_answer" }>;
		expect(wire).toMatchObject({
			type: "task_queue_answer",
			conversationId: "c-ops",
			queueId: "q-ops",
			taskId: 570,
			questionId: "q-occ-1",
			text: "Staged rollout",
		});
		expect(typeof wire.reqId).toBe("string");

		// Unrelated reqId is ignored
		transport.receiveTaskQueueAnswerResult(socket, {
			type: "task_queue_answer_result",
			reqId: "qa-other",
			conversationId: "c-ops",
			queueId: "q-ops",
			taskId: 570,
			questionId: "q-occ-1",
			applied: true,
		});
		transport.receiveTaskQueueAnswerResult(socket, {
			type: "task_queue_answer_result",
			reqId: wire.reqId!,
			conversationId: "c-ops",
			queueId: "q-ops",
			taskId: 570,
			questionId: "q-occ-1",
			applied: true,
		});
		expect(await pendingAnswer).toBe(true);

		// Disconnect before confirmation resolves false so caller retains typed text
		const interrupted = transport.answerQueueTask({
			binding: {
				conversationId: "c-ops",
				queueId: "q-ops",
				taskId: 570,
				questionId: "q-occ-1",
				question: "Which rollout?",
				choices: ["Staged rollout", "All at once"],
				detail: "Choose one",
			},
			text: "Keep my typed answer",
		});
		transport.disconnect(socket);
		expect(await interrupted).toBe(false);
	});

	it("protects unsaved composer drafts across reload/restart via L1/server newer-timestamp selection and watermark fencing", () => {
		// Newer local L1 draft wins over older server draft on reload
		expect(
			selectDraftToRestore({ text: "older server text", ts: 1000 }, { text: "unsaved reload text α", ts: 2000 }, 0),
		).toEqual({ text: "unsaved reload text α", ts: 2000 });
		// Immediate server draft_update fallback wins when L1 was unavailable/empty
		expect(selectDraftToRestore({ text: "immediate server fallback β", ts: 1500 }, null, 0)).toEqual({
			text: "immediate server fallback β",
			ts: 1500,
		});
		// Submitted watermark prevents restoring already-sent draft while allowing newer post-submit edits
		expect(
			selectDraftToRestore({ text: "already submitted", ts: 2000 }, { text: "already submitted", ts: 2000 }, 2000),
		).toBeNull();
		expect(
			selectDraftToRestore({ text: "already submitted", ts: 2000 }, { text: "typed after submit", ts: 2005 }, 2000),
		).toEqual({ text: "typed after submit", ts: 2005 });
	});
});
