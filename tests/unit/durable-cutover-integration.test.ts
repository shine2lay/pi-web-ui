import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { ClientSession } from "../../server/agent-service.js";
import { OFF_CONFIG, type MessageWindowConfig } from "../../server/message-window.js";
import type {
	ServerMessage,
	SwitchTarget,
	UiExchangeDigest,
	UiMessage,
	UiQuietRun,
	UiState,
} from "../../server/protocol.js";
import { roleMessageText } from "../../server/role-messages.js";
import {
	attachToolInspector,
	handleToolInspectorRequest,
	ToolInspectorStore,
	type ToolInspectorSession,
} from "../../server/tool-inspector.js";
import type { TranscriptScan } from "../../server/transcript-scan.js";
import { attachAfterReady, correlateIdentityReply, createHistoryTransport } from "../../server/ws-integration.js";
import {
	earlierRequest,
	EarlierPageRequests,
	mergeEarlierPage,
	normalizeHistoryState,
	type HistoryFields,
} from "../../web/src/history-paging.js";

type Frame = { type: string; [key: string]: unknown };
const config: MessageWindowConfig = { windowSize: 3, charBudget: 1_500_000, pageSize: 2 };
const message = (n: number, prefix = ""): UiMessage => ({
	id: `${prefix}${n}`,
	role: "user",
	content: [{ type: "text", text: `${prefix}${n}` }],
});
const snapshot = (id = "chat-a", base = 100, sessionId = `host-${id}`, prefix = ""): Frame => ({
	type: "snapshot",
	state: {
		conversationId: id,
		sessionId,
		messagesStart: base,
		messages: Array.from({ length: 10 }, (_, i) => message(base + i, prefix)),
	},
});
const stateOf = (frame: Frame) => normalizeHistoryState(frame.state as UiState & HistoryFields);
const digest = (start: number, end: number): UiExchangeDigest => ({
	index: start,
	end,
	head: [message(start)],
	answers: [],
	after: [],
	partial: true,
	folded: true,
	turns: 1,
	thinking: 0,
	toolCalls: 1,
	status: "done",
});

/** A fresh per-chat registry, matching the legacy SDK seams the inspector decorates. Not durable. */
function session(id: string): ToolInspectorSession {
	const registry = new Map(["read", "write"].map((name) => [name, { name }]));
	let active = [...registry.keys()];
	const sdk = {
		sessionId: id,
		sessionManager: { getCwd: () => "/fixed/workspace" },
		_toolRegistry: registry,
		_toolPromptGuidelines: new Map<string, string[]>(),
		_applyToolLoadout(names: string[]) {
			return names.map((name) => registry.get(name)!).filter(Boolean);
		},
		_getCallableTools() {
			return [...registry.values()];
		},
		getAllTools: () => [...registry.values()],
		getActiveToolNames: () => [...active],
		setActiveToolsByName(names: string[]) {
			active = this._applyToolLoadout(names).map((tool) => tool.name);
		},
	};
	return sdk;
}

describe("W2 socket integration", () => {
	it("does not initialize before ready is flushed, and yields an I/O turn afterward", async () => {
		let flushed!: () => void;
		const attach = vi.fn(async () => "attached");
		const pending = attachAfterReady(
			(done) => {
				flushed = done;
			},
			attach,
			() => false,
		);
		expect(attach).not.toHaveBeenCalled();
		flushed();
		await Promise.resolve();
		expect(attach).not.toHaveBeenCalled();
		await expect(pending).resolves.toBe("attached");
		expect(attach).toHaveBeenCalledTimes(1);
	});

	it("does not create a ghost session if the socket closes before initialization", async () => {
		let flushed!: () => void;
		let closed = false;
		const attach = vi.fn(async () => "attached");
		const pending = attachAfterReady(
			(done) => {
				flushed = done;
			},
			attach,
			() => closed,
		);
		closed = true;
		flushed();
		await expect(pending).resolves.toBeUndefined();
		expect(attach).not.toHaveBeenCalled();
	});

	it("propagates attach failures to the existing socket error handler", async () => {
		await expect(
			attachAfterReady(
				(done) => done(),
				async () => {
					throw new Error("fixed failure");
				},
				() => false,
			),
		).rejects.toThrow("fixed failure");
	});

	it("preserves onSent through a cloned/windowed snapshot, without leaking it to other sends", () => {
		const raw = vi.fn();
		const { send } = createHistoryTransport<Frame>(raw, config);
		const sent = vi.fn();
		send(snapshot(), sent);
		const [frame, completion] = raw.mock.calls[0];
		expect(frame.state.messagesStart).toBe(107);
		expect(frame.state.messages).toHaveLength(3);
		expect(frame.state.historyTotal).toBe(110);
		expect(completion).toBe(sent);
		completion();
		send({ type: "pong" });
		expect(raw.mock.calls[1][1]).toBeUndefined();
		expect(sent).toHaveBeenCalledTimes(1);
	});

	it("correlates the slot and host UUID separately, then falls back for earlier absolute indices", () => {
		const raw = vi.fn();
		const transport = createHistoryTransport<Frame>(raw, config);
		const engine = vi.fn();
		transport.send(snapshot());
		transport.loadEarlier({ beforeIndex: 107, limit: 2, conversationId: "chat-a" }, engine, "host-chat-a");
		expect(raw.mock.calls[1][0]).toMatchObject({
			type: "earlier_messages",
			conversationId: "chat-a",
			sessionId: "host-chat-a",
			historyStart: 105,
			historyTotal: 110,
			messages: [{ id: "105" }, { id: "106" }],
		});
		expect(engine).not.toHaveBeenCalled();
		transport.loadEarlier({ beforeIndex: 100, limit: 2, conversationId: "chat-a" }, engine, "host-chat-a");
		expect(engine).toHaveBeenCalledWith(100, 2);
	});

	it("round-trips six consecutive pages through the real client request tracker, including engine fallbacks", () => {
		const frames: Frame[] = [];
		const transport = createHistoryTransport<Frame>((frame) => frames.push(frame), config);
		const requests = new EarlierPageRequests();
		const engine = vi.fn((before: number, count = 2) =>
			transport.send({
				type: "older_messages",
				conversationId: "chat-a",
				sessionId: "host-chat-a",
				start: before - count,
				messages: Array.from({ length: count }, (_, i) => message(before - count + i)),
			}),
		);
		transport.send(snapshot());
		let state = stateOf(frames[0]);
		const starts: number[] = [];
		for (let i = 0; i < 6; i++) {
			const before = state.messagesStart!;
			expect(requests.request(state, before, 2)).toBe(true);
			expect(requests.request(state, before, 2)).toBe(false);
			transport.loadEarlier(earlierRequest(state.conversationId, before, 2), engine, state.sessionId);
			const reply = frames.at(-1)!;
			expect(reply.type).toBe("earlier_messages");
			const page = requests.receive(reply, state);
			expect(page).not.toBeNull();
			expect(requests.receive(reply, state)).toBeNull();
			state = mergeEarlierPage(state, page!)!;
			starts.push(state.messagesStart!);
		}
		expect(starts).toEqual([105, 103, 101, 100, 98, 96]);
		expect(engine).toHaveBeenCalledTimes(2);
		expect(state.messages.map((m) => m.id)).toEqual(Array.from({ length: 14 }, (_, i) => `${96 + i}`));
	});

	it("preserves straddle/quiet metadata on fallback and clears an obsolete quiet lead on the next page", () => {
		const frames: Frame[] = [];
		const transport = createHistoryTransport<Frame>((frame) => frames.push(frame), { ...config, windowSize: 300 });
		const requests = new EarlierPageRequests();
		const initial = snapshot();
		initial.state = {
			...(initial.state as object),
			exchanges: [digest(90, 100)],
			quietLead: { kinds: ["role"], rowId: "old-lead" },
		};
		transport.send(initial);
		let state = stateOf(frames[0]);
		const quietLead = { kinds: ["role"], rowId: "new-lead" } as UiQuietRun;
		for (const before of [100, 98]) {
			expect(requests.request(state, before, 2)).toBe(true);
			transport.loadEarlier(
				earlierRequest("chat-a", before, 2),
				(end) =>
					transport.send({
						type: "older_messages",
						conversationId: "chat-a",
						sessionId: "host-chat-a",
						start: end - 2,
						messages: [message(end - 2), message(end - 1)],
						straddle: digest(90, end - 2),
						...(before === 100 ? { quietLead } : {}),
					}),
				"host-chat-a",
			);
			const page = requests.receive(frames.at(-1), state)!;
			state = mergeEarlierPage(state, page)!;
			expect(state.exchanges?.map((d) => [d.index, d.end])).toEqual([[90, before - 2]]);
			expect(state.quietLead).toEqual(before === 100 ? quietLead : undefined);
		}
	});

	it("resets cached messages on same-slot session replacement and never relabels a late engine page", () => {
		const frames: Frame[] = [];
		const transport = createHistoryTransport<Frame>((frame) => frames.push(frame), config);
		const requests = new EarlierPageRequests();
		transport.send(snapshot("chat-a", 100, "host-old"));
		let state = stateOf(frames[0]);
		expect(requests.request(state, 107, 2)).toBe(true);
		transport.loadEarlier(earlierRequest("chat-a", 107, 2), vi.fn(), "host-old");
		const oldReply = frames.at(-1)!;
		transport.send(snapshot("chat-a", 100, "host-new", "new-"));
		state = stateOf(frames.at(-1)!);
		expect(state.messagesStart).toBe(107);
		expect(requests.request(state, 107, 2)).toBe(true);
		expect(requests.receive(oldReply, state)).toBeNull();
		const sent = frames.length;
		transport.send({
			type: "older_messages",
			conversationId: "chat-a",
			sessionId: "host-old",
			start: 105,
			messages: [message(105), message(106)],
		});
		expect(frames).toHaveLength(sent);
		transport.loadEarlier(earlierRequest("chat-a", 107, 2), vi.fn(), "host-new");
		const page = requests.receive(frames.at(-1), state)!;
		expect(page.messages.map((m) => m.id)).toEqual(["new-105", "new-106"]);
		expect(page.sessionId).toBe("host-new");
	});

	it("refuses a stale UUID before a replacement snapshot and a stale slot after a switch", () => {
		const raw = vi.fn();
		const engine = vi.fn();
		const transport = createHistoryTransport<Frame>(raw, config);
		transport.send(snapshot());
		transport.loadEarlier(earlierRequest("chat-a", 107, 2), engine, "already-replaced-host");
		transport.send(snapshot("chat-b"));
		transport.loadEarlier(earlierRequest("chat-a", 107, 2), engine, "host-chat-b");
		expect(raw).toHaveBeenCalledTimes(2);
		expect(engine).not.toHaveBeenCalled();
	});

	it("keeps legacy replies unmodified when no earlier-message request owns them", () => {
		const raw = vi.fn();
		const transport = createHistoryTransport<Frame>(raw, config);
		transport.send(snapshot());
		const reply = {
			type: "older_messages",
			conversationId: "chat-a",
			sessionId: "host-chat-a",
			start: 98,
			messages: [message(98), message(99)],
		};
		transport.send(reply);
		expect(raw.mock.calls.at(-1)?.[0]).toBe(reply);
	});

	it("keeps the legacy pagination fallback and completion callback when the tap is off", () => {
		const raw = vi.fn();
		const engine = vi.fn();
		const transport = createHistoryTransport<Frame>(raw, OFF_CONFIG);
		const frame = snapshot();
		const done = vi.fn();
		transport.send(frame, done);
		expect(raw).toHaveBeenCalledWith(frame, done);
		transport.loadEarlier({ count: 2 }, engine, "host-chat-a");
		expect(engine).toHaveBeenCalledWith(100, 2);
	});

	it("does not window a switch-cache reuse tail", () => {
		const raw = vi.fn();
		const transport = createHistoryTransport<Frame>(raw, config);
		const frame = { ...snapshot(), reuse: { start: 100, count: 10 } };
		transport.send(frame);
		expect(raw.mock.calls[0][0]).toBe(frame);
	});
});

describe("W2 engine window metadata", () => {
	it("budgets the real open preview before deriving its digests and quiet lead, with no runtime or chat file", async () => {
		const roleText = roleMessageText({
			id: "rm-0123abcd",
			from: { role: "ops", title: "Ops", chat: "fixture", file: "/fixture/ops.jsonl" },
			kind: "request",
			text: "Fixture request.",
		});
		const contents = ["owner question", "owner answer", roleText, "large assistant fixture", "fixture tail"];
		const entries = contents.map((text, i) => ({
			type: "message",
			id: `entry-${i}`,
			parentId: i ? `entry-${i - 1}` : null,
			timestamp: new Date(1000 + i).toISOString(),
			message: {
				role: i === 0 || i === 2 ? "user" : "assistant",
				content:
					i === 3
						? Array.from({ length: 8 }, () => ({ type: "text", text: "x".repeat(200_000) }))
						: [{ type: "text", text }],
				timestamp: 1000 + i,
				...(i === 3 ? { stopReason: "toolUse" } : { stopReason: "stop" }),
			},
		}));
		const scan: TranscriptScan = {
			file: "/fixture/offline.jsonl",
			bytes: 0,
			entries,
			sessionId: "preview-host",
			cwd: "/fixture/workspace",
			leafId: "entry-4",
			problem: null,
			ms: 0,
			stamp: null,
			sdkEquivalent: false,
		};
		const frames: ServerMessage[] = [];
		const harness = {
			cwd: scan.cwd,
			buildLightState: () => ({}),
			emitAndFlush: async (frame: ServerMessage) => {
				frames.push(frame);
			},
		};
		const proto = ClientSession.prototype as unknown as {
			emitSwitchPreview(this: typeof harness, target: SwitchTarget, scan: TranscriptScan): Promise<void>;
		};
		await proto.emitSwitchPreview.call(harness, { kind: "session", path: scan.file }, scan);
		const preview = frames[0];
		expect(preview.type).toBe("switch_preview");
		if (preview.type !== "switch_preview") throw new Error("Expected fixture preview");
		expect(preview.state.messagesStart).toBe(4);
		expect(preview.state.messages).toHaveLength(1);
		expect(preview.state.exchanges?.at(-1)).toMatchObject({ index: 2, end: 4, partial: true });
		expect(preview.state.quietLead?.kinds).toEqual(["role"]);
		expect(preview.state.quietLead?.rowId).toBe(preview.state.questionIndex?.find((q) => q.index === 2)?.id);
		const source = readFileSync(new URL("../../server/agent-service.ts", import.meta.url), "utf8");
		expect(source).toContain("resume ? resume.start : snapshotWindowStartOf(conv, idx)");
	});
});

describe("W2 Tool Inspector integration", () => {
	it("edits exactly the requested open chat and applies the saved policy to the next loadout", async () => {
		const store = new ToolInspectorStore();
		const a = session("a");
		const b = session("b");
		attachToolInspector(a, store);
		attachToolInspector(b, store);
		const deps = {
			store,
			resolveSession: (client: string, conv: string) => (client === "window-a" && conv === "conv-a" ? a : undefined),
		};
		const reply = await handleToolInspectorRequest(deps, {
			method: "POST",
			clientId: "window-a",
			convId: "conv-a",
			update: { toolName: "write", enabled: false },
		});
		expect(reply.status).toBe(200);
		a.setActiveToolsByName(["read", "write"]);
		expect(a.getActiveToolNames()).toEqual(["read"]);
		expect(b.getActiveToolNames()).toEqual(["read", "write"]);
		const missing = await handleToolInspectorRequest(deps, {
			method: "POST",
			clientId: "wrong-window",
			convId: "conv-a",
			update: { toolName: "read", enabled: false },
		});
		expect(missing.status).toBe(404);
		expect(a.getActiveToolNames()).toEqual(["read"]);
	});

	it("mounts behind host auth and attaches policy in the common runtime factory", () => {
		const index = readFileSync(new URL("../../server/index.ts", import.meta.url), "utf8");
		const agent = readFileSync(new URL("../../server/agent-service.ts", import.meta.url), "utf8");
		const html = readFileSync(new URL("../../web/index.html", import.meta.url), "utf8");
		expect(index.indexOf("registerToolInspectorRoutes(app, inspectorDependencies)")).toBeGreaterThan(
			index.indexOf("const service: EngineService"),
		);
		expect(index).toContain("toolInspectorDependencies?(): ToolInspectorDependencies");
		expect(index).toContain("const historyTransport = createHistoryTransport(sendRaw)");
		expect(index).toContain("historyTransport.loadEarlier(msg");
		expect(index).toContain("() => service.attach(cid, send)");
		expect(agent).toContain("attachToolInspector(created.session, toolInspectorStoreFor(this.stateStore.dataDir))");
		expect(agent).toContain("this.clients.get(clientId)?.toolInspectorSession(convId)");
		expect(agent).toContain("this.convs.get(conversationId)?.session");
		expect(html).toContain('src="./tool-inspector.js"');
	});
});

describe("identity operation correlation, never a persistence receipt", () => {
	it.each([
		{ type: "identity_file", id: "fixed", file: "about", text: "exact" },
		{ type: "identity_file_saved", id: "fixed", file: "about", ok: false, code: "changed" },
		{ type: "identity_draft", id: "fixed", error: "synthetic missing" },
		{ type: "identity_draft_done", id: "fixed", action: "save", ok: true, hash: "fixed-hash" },
		{ type: "identity_note", id: "fixed", ref: "n1", text: "note" },
		{ type: "identity_note_saved", id: "fixed", ref: "n1", ok: false, code: "unknown" },
	])("echoes exact request identity on $type including refusal/error without changing the result", (input) => {
		const reply = Object.freeze(input);
		const request = Object.freeze({ reqId: " original opaque ID " });
		expect(correlateIdentityReply(request, reply)).toEqual({ ...reply, reqId: request.reqId });
		expect(reply).not.toHaveProperty("reqId");
	});

	it("keeps legacy/invalid requests and unrelated replies unchanged", () => {
		const reply = { type: "identity_note_saved", id: "fixed", ref: "n1", ok: false };
		for (const request of [{}, { reqId: undefined }, { reqId: null }, { reqId: 17 }]) {
			expect(correlateIdentityReply(request, reply)).toBe(reply);
		}
		const unrelated = { type: "delta", conversationId: "fixed", appended: [] };
		expect(correlateIdentityReply({ reqId: "op-a" }, unrelated)).toBe(unrelated);
	});

	it("does not invoke getters or borrow inherited/current operation IDs", () => {
		const reply = { type: "identity_file_saved", id: "fixed", file: "about", ok: true };
		const getter = vi.fn(() => "must-not-run");
		const accessor = Object.defineProperty({}, "reqId", { get: getter });
		expect(correlateIdentityReply(accessor, reply)).toBe(reply);
		expect(getter).not.toHaveBeenCalled();
		expect(correlateIdentityReply(Object.create({ reqId: "inherited" }), reply)).toBe(reply);
	});

	it("keeps same-resource operations separate without claiming execution/deduplication", () => {
		const reply = { type: "identity_draft_done", id: "fixed", action: "accept", ok: true };
		const a = correlateIdentityReply({ reqId: "operation-a" }, reply);
		const b = correlateIdentityReply({ reqId: "operation-b" }, reply);
		expect(a.reqId).toBe("operation-a");
		expect(b.reqId).toBe("operation-b");
		expect(a).not.toHaveProperty("persistence");
		expect(a).not.toHaveProperty("releaseClientCopy");
	});
});

describe("AskHub #592 occurrence-bound server taskQueueAnswer & queueAnswerBindings", () => {
	it("verifies queueId, questionId, question, choices, and detail before applying an answer", async () => {
		const answered: { target: string; text: string }[] = [];
		const q = {
			running: false,
			available: true,
			paused: false,
			lanes: 1,
			queueId: "q-server-1",
			tasks: [
				{
					id: 570,
					text: "Durable W2",
					status: "stuck" as const,
					lane: true,
					chat: { file: "/tmp/task-570.jsonl", title: "Task 570" },
					plan: { title: "Durable W2" } as never,
					question: "Approve rollout?",
					choices: ["Staged rollout", "Hold"],
					detail: "Detail text",
					createdAt: 1,
				},
			],
		};
		const conv = {
			id: "conv-1",
			title: "Ops lead",
			cwd: "/tmp",
			isSubagent: false,
			session: {
				sessionFile: "/tmp/main-ops.jsonl",
				sessionManager: {
					getSessionFile: () => "/tmp/main-ops.jsonl",
					getSessionId: () => "sess-ops-1",
				},
			},
		};
		const csStatic = ClientSession as unknown as {
			sharedConvs: Map<string, unknown>;
			stuckAnswerSender?: (target: string, text: string) => Promise<{ ok: boolean; error?: string }>;
			taskQueueOfConv: (c: unknown) => typeof q;
		};
		const origTaskQueueOfConv = csStatic.taskQueueOfConv;
		const origSender = csStatic.stuckAnswerSender;
		csStatic.sharedConvs.set("conv-1", conv);
		csStatic.taskQueueOfConv = () => q;
		csStatic.stuckAnswerSender = async (target, text) => {
			answered.push({ target, text });
			return { ok: true };
		};
		try {
			const emitted: ServerMessage[] = [];
			const harness = {
				convs: new Map([["conv-1", conv]]),
				emit: (msg: ServerMessage) => {
					emitted.push(msg);
				},
			};
			const proto = ClientSession.prototype as unknown as {
				queueAnswerBindings(
					this: typeof harness,
					c: unknown,
					queue: typeof q,
				):
					| {
							conversationId: string;
							queueId: string;
							taskId: number;
							questionId: string;
							question: string;
							choices: string[];
							detail?: string;
					  }[]
					| undefined;
				taskQueueAnswer(
					this: typeof harness,
					conversationId: string,
					taskId: number,
					text: string,
					binding?: {
						reqId?: unknown;
						queueId?: unknown;
						questionId?: unknown;
						question?: unknown;
						choices?: unknown;
						detail?: unknown;
					},
				): Promise<{
					reqId?: string;
					conversationId: string;
					queueId?: string;
					taskId: number;
					questionId?: string;
					applied: boolean;
					reason?: string;
				}>;
			};

			const bindings = proto.queueAnswerBindings.call(harness, conv, q);
			expect(bindings).toHaveLength(1);
			const occ = bindings![0];
			expect(occ).toMatchObject({
				conversationId: "conv-1",
				queueId: "q-server-1",
				taskId: 570,
				question: "Approve rollout?",
				choices: ["Staged rollout", "Hold"],
				detail: "Detail text",
			});
			expect(occ.questionId).toMatch(/^stuck-/);

			// Refuses stale questionId without calling stuckAnswerSender
			const staleOcc = await proto.taskQueueAnswer.call(harness, "conv-1", 570, "Staged rollout", {
				reqId: "qa-1",
				queueId: "q-server-1",
				questionId: "stuck-stale",
				question: "Approve rollout?",
				choices: ["Staged rollout", "Hold"],
				detail: "Detail text",
			});
			expect(staleOcc.applied).toBe(false);
			expect(answered).toHaveLength(0);

			// Refuses mismatched choices without calling stuckAnswerSender
			const badChoices = await proto.taskQueueAnswer.call(harness, "conv-1", 570, "Staged rollout", {
				reqId: "qa-2",
				queueId: "q-server-1",
				questionId: occ.questionId,
				question: "Approve rollout?",
				choices: ["Changed choice"],
				detail: "Detail text",
			});
			expect(badChoices.applied).toBe(false);
			expect(answered).toHaveLength(0);

			// Applies when occurrence identity and prompt snapshot match
			const ok = await proto.taskQueueAnswer.call(harness, "conv-1", 570, "Staged rollout", {
				reqId: "qa-3",
				queueId: "q-server-1",
				questionId: occ.questionId,
				question: "Approve rollout?",
				choices: ["Staged rollout", "Hold"],
				detail: "Detail text",
			});
			expect(ok).toEqual({
				reqId: "qa-3",
				conversationId: "conv-1",
				queueId: "q-server-1",
				taskId: 570,
				questionId: occ.questionId,
				applied: true,
			});
			expect(answered).toEqual([{ target: "/tmp/task-570.jsonl", text: "Staged rollout" }]);
			expect(emitted.at(-1)).toEqual({
				type: "task_queue_answer_result",
				reqId: "qa-3",
				conversationId: "conv-1",
				queueId: "q-server-1",
				taskId: 570,
				questionId: occ.questionId,
				applied: true,
			});
		} finally {
			csStatic.sharedConvs.delete("conv-1");
			csStatic.taskQueueOfConv = origTaskQueueOfConv;
			csStatic.stuckAnswerSender = origSender;
		}
	});
});
