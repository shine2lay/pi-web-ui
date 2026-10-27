import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createRecoveryChatTransport, type CapturedAuthoredInput } from "../../web/src/recovery-chat";
import { createNativeRecoveryClient } from "../../web/src/recovery-client";
import type { RecoveryAdmissionOptions } from "../../web/src/recovery-admission";
import type {
	PreparedRecoveryWork,
	PrepareRecoveryResult,
	RecoverySnapshot,
	RecoveryWork,
} from "../../web/src/pending-recovery-coordinator";
import type { ClientMessage, CommandDispositionMsg, ServerMessage, UiState } from "../../web/src/types";
function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((yes) => {
		resolve = yes;
	});
	return { promise, resolve };
}
function state(cid = "c1", sid = "s1", cwd = "/original") {
	return {
		conversationId: cid,
		sessionId: sid,
		cwd,
		messages: [],
		queue: { steering: [], followUp: [] },
		isStreaming: false,
	} as unknown as UiState;
}
function prompt(id = "p1"): ClientMessage {
	return {
		type: "prompt",
		id,
		text: "  exact α\n",
		attachments: [{ path: "a.bin", fileData: "QUJD", mimeType: "application/octet-stream", name: "original α.bin" }],
	};
}
function fixture() {
	let view = { state: state() as UiState | null, preview: null as UiState | null };
	const originals = new Map<string, PreparedRecoveryWork>();
	let pause: Promise<void> = Promise.resolve();
	let refuse = false;
	const snapshot = (): RecoverySnapshot => ({
		state: "ready",
		ownerId: "owner1",
		issues: [],
		entries: [...originals.values()].map((prepared) => ({
			prepared,
			complete: true,
			lifecycle: "unresolved",
			issues: [],
		})),
	});
	const coordinator: RecoveryAdmissionOptions["coordinator"] = {
		start: vi.fn(async () => snapshot()),
		restore: vi.fn(async () => snapshot()),
		prepare: vi.fn(async (input: RecoveryWork): Promise<PrepareRecoveryResult> => {
			const work = structuredClone(input);
			await pause;
			if (refuse)
				return {
					ok: false,
					payloadCommitted: true,
					error: { code: "envelope", message: "synthetic publication failure" },
					work,
				};
			const data = work.kind === "prompt" ? work.pending : work;
			const duplicate = originals.has(data.id);
			const prepared: PreparedRecoveryWork = {
				ownerId: "owner1",
				kind: work.kind,
				id: data.id,
				sessionId: data.sessionId!,
				contentDigest: createHash("sha256").update(JSON.stringify(work)).digest("hex"),
				work,
			};
			originals.set(prepared.id, prepared);
			return { ok: true, prepared, payloadCommitted: true, dispatch: duplicate ? "status-required" : "first-send" };
		}),
		returnToComposer: vi.fn(async (id) => {
			const original = originals.get(id.id);
			if (!original) throw new Error("Missing synthetic original");
			return original.work;
		}),
		discard: vi.fn(async () => ({ released: true })),
		exportArtifact: vi.fn(async () => JSON.stringify([...originals.values()])),
	};
	const client = createNativeRecoveryClient(() => coordinator);
	const frames: ClientMessage[] = [];
	const queued: ClientMessage[] = [];
	const subscribers: ((value: ClientMessage) => void)[] = [];
	let throwAfterSend = false;
	const socket = {
		readyState: 1 as const,
		send(data: string) {
			const message = JSON.parse(data) as ClientMessage;
			frames.push(message);
			const waiter = subscribers.shift();
			if (waiter) waiter(message);
			else queued.push(message);
			if (throwAfterSend) throw new Error("Synthetic uncertain write");
		},
	};
	const pending = vi.fn();
	const problems: string[] = [];
	let source: (message: ClientMessage) => CapturedAuthoredInput | null = (message) => ({ message });
	const bridge = createRecoveryChatTransport({
		client,
		view: () => view,
		captureOriginal: (message) => source(message),
		pending,
		problem: (text) => problems.push(text),
	});
	const nextFrame = () =>
		queued.length
			? Promise.resolve(queued.shift()!)
			: new Promise<ClientMessage>((resolve) => subscribers.push(resolve));
	function disposition(
		packet: ClientMessage,
		status: "uncertain" | "unprocessed" = "uncertain",
		reason = "dispatch-started",
	): CommandDispositionMsg {
		if (!packet.recovery) throw new Error("Expected owned transmission");
		return {
			type: "command_disposition",
			recovery: { ...packet.recovery },
			connectionGeneration: "g1",
			commandType: packet.type,
			status,
			retryable: status === "unprocessed",
			reason,
			persistence: "unknown",
			releaseClientCopy: false,
		};
	}
	return {
		bridge,
		client,
		coordinator,
		originals,
		frames,
		pending,
		problems,
		socket,
		nextFrame,
		disposition,
		setSource(fn: typeof source) {
			source = fn;
		},
		setPause(value: Promise<void>) {
			pause = value;
		},
		refuse() {
			refuse = true;
		},
		throwAfterSend() {
			throwAfterSend = true;
		},
		setState(value: UiState) {
			view = { ...view, state: value };
			bridge.bindSnapshot(socket, value);
		},
		setPreview(value: UiState) {
			view = { ...view, preview: value };
		},
		async boot() {
			await bridge.start();
			bridge.connect(socket);
			bridge.ready(socket, "g1");
			bridge.bindSnapshot(socket, view.state!);
			expect(bridge.initialize(socket, "g1")).toBe(true);
		},
	};
}

describe("native recovery/socket/target bridge — fixed synthetic ports, not browser-storage proof", () => {
	it("refuses before owner/session initialization without storage publication or wire", async () => {
		const f = fixture();
		await f.bridge.start();
		f.bridge.connect(f.socket);
		f.bridge.ready(f.socket, "g1");
		f.bridge.bindSnapshot(f.socket, state());
		expect(f.bridge.initialize(f.socket, "stale")).toBe(false);
		expect(await f.bridge.admit(prompt())).toBe(false);
		expect(f.coordinator.prepare).not.toHaveBeenCalled();
		expect(f.frames).toEqual([]);
		expect(f.bridge.initialize(f.socket, "g1")).toBe(true);
		expect(f.bridge.initialize(f.socket, "g1")).toBe(false);
	});
	it("awaits full original checkpoint and exact owned handoff, not mere send", async () => {
		const f = fixture();
		await f.boot();
		const gate = deferred<void>();
		f.setPause(gate.promise);
		const original = prompt();
		let settled = false;
		const result = f.bridge.admit(original).then((ok) => {
			settled = true;
			return ok;
		});
		(original as Extract<ClientMessage, { type: "prompt" }>).text = "changed by caller";
		expect(f.frames).toEqual([]);
		expect(settled).toBe(false);
		gate.resolve();
		const sent = await f.nextFrame();
		expect(f.originals.get("p1")?.work).toMatchObject({
			pending: { text: "  exact α\n", attachments: [{ fileData: "QUJD", name: "original α.bin" }] },
		});
		expect(sent).toMatchObject({ text: "  exact α\n", forSession: "s1" });
		expect(settled).toBe(false);
		expect(f.bridge.receiveDisposition(f.socket, f.disposition(sent))).toBe(true);
		expect(await result).toBe(true);
		expect(f.originals.size).toBe(1);
		expect(f.coordinator.discard).not.toHaveBeenCalled();
	});
	it("committed-but-failed publication still refuses with no wire", async () => {
		const f = fixture();
		await f.boot();
		f.refuse();
		expect(await f.bridge.admit(prompt())).toBe(false);
		expect(f.frames).toEqual([]);
		expect(f.problems.join(" ")).toContain("full editable original");
	});
	it("reads the original accessor before cloning and requires its complete typed source", async () => {
		const f = fixture();
		await f.boot();
		const original = prompt();
		f.setSource((message) => {
			expect(message).toBe(original);
			return null;
		});
		expect(await f.bridge.admit(original)).toBe(false);
		expect(f.coordinator.prepare).not.toHaveBeenCalled();
	});
	it("captures source prerequisite before async work and refuses its failure before coordinator/wire", async () => {
		const f = fixture();
		await f.boot();
		const gate = deferred<boolean>();
		const original = prompt();
		const pristine = structuredClone(original);
		f.setSource((message) => ({ message, beforeCheckpoint: () => gate.promise }));
		const result = f.bridge.admit(original);
		(original as Extract<ClientMessage, { type: "prompt" }>).text = "later mutation";
		expect(f.coordinator.prepare).not.toHaveBeenCalled();
		gate.resolve(false);
		expect(await result).toBe(false);
		expect(f.frames).toEqual([]);
		expect(pristine).toMatchObject({ text: "  exact α\n" });
	});
	it("a global resource keeps the ORIGINAL archive source across same-workspace chat changes", async () => {
		const f = fixture();
		await f.boot();
		const gate = deferred<boolean>();
		f.setSource((message) => ({ message, beforeCheckpoint: () => gate.promise }));
		const result = f.bridge.admit({
			type: "identity_file_save",
			id: "ops",
			file: "about",
			text: "  original about\n",
			baseHash: "h1",
			reqId: "r1",
		});
		f.setState(state("c2", "s2"));
		gate.resolve(true);
		const sent = await f.nextFrame();
		expect(f.originals.get("r1")?.work).toMatchObject({
			sessionId: "s1",
			conversationId: "c1",
			payload: JSON.stringify({
				type: "identity_file_save",
				id: "ops",
				file: "about",
				text: "  original about\n",
				baseHash: "h1",
				reqId: "r1",
			}),
		});
		f.bridge.receiveDisposition(f.socket, f.disposition(sent));
		expect(await result).toBe(true);
	});
	it("a workspace ABA during source checkpoint cannot publish into a later workspace", async () => {
		const f = fixture();
		await f.boot();
		const gate = deferred<boolean>();
		f.setSource((message) => ({ message, beforeCheckpoint: () => gate.promise }));
		const result = f.bridge.admit({
			type: "identity_note_save",
			id: "ops",
			ref: "n1",
			text: " original ",
			baseHash: "h1",
			reqId: "r1",
		});
		f.setState(state("c2", "s2", "/other"));
		f.setState(state());
		gate.resolve(true);
		expect(await result).toBe(false);
		expect(f.frames).toEqual([]);
		expect(f.coordinator.prepare).not.toHaveBeenCalled();
	});
	it("refuses late checkpoint completion on target ABA, retaining original bytes", async () => {
		const f = fixture();
		await f.boot();
		const gate = deferred<void>();
		f.setPause(gate.promise);
		const result = f.bridge.admit(prompt());
		f.setState(state("c2", "s2"));
		f.setState(state());
		gate.resolve();
		expect(await result).toBe(false);
		expect(f.frames).toEqual([]);
		expect(f.originals.get("p1")?.work).toMatchObject({ pending: { sessionId: "s1", text: "  exact α\n" } });
	});
	it("parent-bound editor lifetime cannot be substituted after ABA", async () => {
		const f = fixture();
		await f.boot();
		const original = f.bridge.captureBinding()!;
		const first = f.bridge.bindingKey();
		expect(first).not.toBe("");
		expect(f.bridge.bindingKey()).toBe(first);
		f.setState(state("c2", "s2"));
		f.setState(state());
		expect(f.bridge.bindingKey()).not.toBe(first);
		expect(await f.bridge.admit({ type: "edit_message", messageId: "m1", text: " exact edit " }, original)).toBe(false);
		expect(f.coordinator.prepare).not.toHaveBeenCalled();
	});
	it("same-target metadata snapshots do not invalidate a real editor", async () => {
		const f = fixture();
		await f.boot();
		const first = f.bridge.bindingKey();
		f.setState({ ...state(), rev: 50 });
		expect(f.bridge.bindingKey()).toBe(first);
	});
	it.each(["generation", "attempt", "session", "digest", "command", "release", "persistence"])(
		"rejects mismatched %s outcome without settling handoff",
		async (field) => {
			const f = fixture();
			await f.boot();
			let settled = false;
			const result = f.bridge.admit(prompt()).then((ok) => {
				settled = true;
				return ok;
			});
			const sent = await f.nextFrame();
			const outcome = f.disposition(sent);
			if (field === "generation") outcome.connectionGeneration = "old";
			if (field === "attempt") outcome.recovery.attemptId = "other";
			if (field === "session") outcome.recovery.sessionId = "other";
			if (field === "digest") outcome.recovery.contentDigest = "other";
			if (field === "command") outcome.commandType = "edit_message";
			if (field === "release") (outcome as unknown as { releaseClientCopy: boolean }).releaseClientCopy = true;
			if (field === "persistence") (outcome as unknown as { persistence: string }).persistence = "persisted";
			expect(f.bridge.receiveDisposition(f.socket, outcome)).toBe(false);
			expect(settled).toBe(false);
			f.bridge.disconnect(f.socket);
			expect(await result).toBe(false);
			expect(f.originals.size).toBe(1);
		},
	);
	it("host unprocessed refusal settles false, never discards or retries", async () => {
		const f = fixture();
		await f.boot();
		const result = f.bridge.admit(prompt());
		const sent = await f.nextFrame();
		f.bridge.receiveDisposition(f.socket, f.disposition(sent, "unprocessed", "capacity"));
		expect(await result).toBe(false);
		expect(f.frames).toHaveLength(1);
		expect(f.coordinator.discard).not.toHaveBeenCalled();
	});
	it("closed socket settles unknown and keeps original, late old callback cannot settle new work", async () => {
		const f = fixture();
		await f.boot();
		const result = f.bridge.admit(prompt());
		const sent = await f.nextFrame();
		f.bridge.disconnect(f.socket);
		expect(await result).toBe(false);
		const replacement = { readyState: 1 as const, send: vi.fn() };
		f.bridge.connect(replacement);
		expect(f.bridge.receiveDisposition(f.socket, f.disposition(sent))).toBe(false);
		expect(f.bridge.ownsTransport(f.socket)).toBe(false);
		expect(f.originals.size).toBe(1);
	});
	it("uncertain send exception preserves bytes and cannot become an automatic retry", async () => {
		const f = fixture();
		await f.boot();
		f.throwAfterSend();
		expect(await f.bridge.admit(prompt())).toBe(false);
		expect(f.originals.size).toBe(1);
		const item = f.client.getSnapshot().items[0];
		const status = vi.fn(async () => "negative" as const);
		expect(await f.client.retry(item.prepared, status)).toBe(false);
		expect(status).not.toHaveBeenCalled();
		expect(f.frames).toHaveLength(1);
	});
	it("locally holds the exact cross-workspace target until its actual switch completion", async () => {
		const f = fixture();
		await f.boot();
		const target = { kind: "conversation", id: "c2" } as const;
		const next = state("c2", "s2", "/other");
		f.bridge.beginSwitch(target);
		f.setPreview(next);
		f.bridge.preview(f.socket, target, next);
		expect(await f.bridge.admit(prompt())).toBe(true);
		expect(f.frames).toEqual([]);
		expect(f.originals.get("p1")?.work).toMatchObject({ pending: { sessionId: "s2", conversationId: "c2" } });
		f.setState(next);
		const finished = f.bridge.completeSwitch(target);
		const sent = await f.nextFrame();
		expect(sent).toMatchObject({ id: "p1", forSession: "s2", text: "  exact α\n" });
		f.bridge.receiveDisposition(f.socket, f.disposition(sent));
		await finished;
		expect(f.frames).toHaveLength(1);
	});
	it("cancels a never-wire hold without deleting data or allowing late switch replay", async () => {
		const f = fixture();
		await f.boot();
		const target = { kind: "conversation", id: "c2" } as const;
		const next = state("c2", "s2");
		f.bridge.beginSwitch(target);
		f.setPreview(next);
		f.bridge.preview(f.socket, target, next);
		expect(await f.bridge.admit(prompt())).toBe(true);
		f.bridge.cancelSwitch("explicitly left", target);
		f.setState(next);
		await f.bridge.completeSwitch(target);
		expect(f.frames).toEqual([]);
		expect(f.originals.size).toBe(1);
		expect(f.coordinator.discard).not.toHaveBeenCalled();
	});
	it("a closed/detached view cancels waits but never closes/deletes the document owner", async () => {
		const f = fixture();
		await f.boot();
		const result = f.bridge.admit(prompt());
		await f.nextFrame();
		f.bridge.stop();
		expect(await result).toBe(false);
		expect(f.originals.size).toBe(1);
		expect(f.coordinator.discard).not.toHaveBeenCalled();
	});
	it("fresh status lookup requires exact nonce/session/current target and grants no replay", async () => {
		const f = fixture();
		await f.boot();
		const result = f.bridge.admit(prompt());
		const sent = await f.nextFrame();
		f.bridge.receiveDisposition(f.socket, f.disposition(sent));
		expect(await result).toBe(true);
		const item = f.client.getSnapshot().items[0];
		const checking = f.bridge.checkPromptStatus(item.prepared);
		const query = await f.nextFrame();
		if (query.type !== "prompt_status") throw new Error("Expected status probe");
		const ack: Extract<ServerMessage, { type: "prompt_ack" }> = {
			type: "prompt_ack",
			id: "p1",
			conversationId: "c1",
			ok: false,
			statusReqId: query.reqId,
			statusSessionId: "s1",
			statusScopeValid: true,
		};
		f.bridge.receivePromptStatus(f.socket, { ...ack, statusReqId: "different" });
		f.bridge.receivePromptStatus(f.socket, ack);
		expect(await checking).toBe("negative");
		expect(f.frames).toHaveLength(2);
		expect(f.coordinator.discard).not.toHaveBeenCalled();
		expect(await f.client.retry(item.prepared, async () => "negative")).toBe(false);
	});
	it.each(["scope", "session", "target"])("invalid %s status binding is unknown, not permission", async (wrong) => {
		const f = fixture();
		await f.boot();
		const result = f.bridge.admit(prompt());
		const sent = await f.nextFrame();
		f.bridge.receiveDisposition(f.socket, f.disposition(sent));
		await result;
		const checking = f.bridge.checkPromptStatus(f.client.getSnapshot().items[0].prepared);
		const query = await f.nextFrame();
		if (query.type !== "prompt_status") throw new Error("Expected probe");
		if (wrong === "target") f.setState(state("c2", "s2"));
		f.bridge.receivePromptStatus(f.socket, {
			type: "prompt_ack",
			id: "p1",
			conversationId: "c1",
			ok: false,
			statusReqId: query.reqId,
			statusSessionId: wrong === "session" ? "other" : "s1",
			statusScopeValid: wrong !== "scope",
		});
		expect(await checking).toBe("unknown");
		expect(f.frames).toHaveLength(2);
	});
});
