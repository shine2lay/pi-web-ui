/** Synthetic-only native writer + real SDK command dispatcher. No server, model, or live session. */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentSession, SessionManager } from "@earendil-works/pi-coding-agent";
import { vi } from "vitest";
import { AgentService, ClientSession } from "../../server/agent-service.js";
import { askHub } from "../../server/asks.js";
import type { PendingQuestionEntry } from "../../server/ask-delivery.js";
import type { QuestionAnswer, ServerMessage } from "../../server/protocol.js";
import { loadIdentities } from "../../server/identities.js";
import { loadSettings } from "../../server/identity-config.js";
import { installQueueHost, QUEUE_HOST_KEY, type QueueHost } from "../../server/queue-host.js";
import { nativeQuestionHost } from "../../server/queue-question-native.js";
import { installPromptStartGuard } from "../../server/prompt-start-guard.js";
import {
	QUESTION_COMMIT_KEY,
	type QuestionBinding,
	type QuestionCommit,
	type QuestionCommitEndpoint,
	type QuestionCommitResult,
} from "../../server/queue-question-port.js";

type RecordData = Record<string, unknown>;
export const queueRecords = (manager: SessionManager): RecordData[] =>
	manager
		.getBranch()
		.flatMap((entry) =>
			entry.type === "custom" && entry.customType === "queue" && entry.data && typeof entry.data === "object"
				? [entry.data as RecordData]
				: [],
		);
export function latch() {
	let open!: () => void;
	const promise = new Promise<void>((resolve) => {
		open = resolve;
	});
	return { promise, open };
}

export interface NativeQuestionCommand {
	handler(args: string, context: unknown): unknown;
}

/** Shared SDK boundary: commands/messages are native; any attempt to start a model must throw. */
export function nativeQuestionSession(
	manager: SessionManager,
	options: {
		command(name: string): NativeQuestionCommand | undefined;
		context(): unknown;
		busy(): boolean;
		errors(event: unknown): void;
		prompts(): never;
	},
): AgentSession {
	const value: AgentSession = Object.create(AgentSession.prototype);
	Object.defineProperties(value, {
		sessionManager: { value: manager, configurable: true },
		isStreaming: { get: options.busy },
		isCompacting: { get: () => false },
		_extensionRunner: {
			value: {
				getCommand: options.command,
				createCommandContext: options.context,
				emitError: options.errors,
			},
		},
		_refreshFinalizedContext: { value: vi.fn() },
		_emit: { value: vi.fn() },
		_pendingCustomMessages: { value: [], writable: true },
		_runAgentPrompt: { value: options.prompts, writable: true },
	});
	return value;
}

/** A synthetic tool turn settles without an agent loop; use the SDK's own no-turn buffer flush. */
export function flushNativeQuestionMessages(session: AgentSession): void {
	Reflect.apply(Reflect.get(AgentSession.prototype, "_flushPendingCustomMessages"), session, []);
}

/** Use the same AgentService route as the installed host, including SDK slash-command dispatch. */
export function nativeQuestionDispatcher(sessionFor: (file: string) => AgentSession | null) {
	const runCommand = Reflect.get(AgentService.prototype, "queueRunCommand") as (
		this: { queueSessionFor(file: string): AgentSession | null },
		file: string,
		line: string,
	) => Promise<boolean>;
	const dispatcher = { queueSessionFor: sessionFor };
	return (file: string, line: string) => runCommand.call(dispatcher, file, line);
}

/** Actual generic dialog presentation/resolution, with only page broadcasting replaced. */
export function nativeOwnerDialog(
	session: AgentSession,
	observer: NonNullable<typeof ClientSession.observeUnboundOwnerAnswer>,
) {
	const prior = ClientSession.observeUnboundOwnerAnswer;
	ClientSession.observeUnboundOwnerAnswer = observer;
	const statics = ClientSession as unknown as {
		emitConversationsToAll(): void;
		broadcastToAllClients(message: ServerMessage): void;
		connectedClientCount(): number;
	};
	const conversations = vi.spyOn(statics, "emitConversationsToAll").mockImplementation(() => {});
	const broadcasts = vi.spyOn(statics, "broadcastToAllClients").mockImplementation(() => {});
	const connected = vi.spyOn(statics, "connectedClientCount").mockReturnValue(1);
	const pending = new Map<string, PendingQuestionEntry>();
	const client: ClientSession = Object.create(ClientSession.prototype);
	const conv = {
		id: "synthetic-generic-dialog",
		title: "Synthetic generic dialog",
		session,
		cwd: session.sessionManager.getCwd(),
	};
	Object.defineProperties(client, {
		pendingQuestions: { value: pending },
		convs: { value: new Map([[conv.id, conv]]) },
		activeId: { value: conv.id },
		settingsSvc: { value: { current: {} } },
		disposed: { value: false },
	});
	const result = client.askUser(
		[
			{
				id: "generic-choice",
				question: "Synthetic choice without a task reference",
				options: [{ label: "Keep the choice" }, { label: "Pick another" }],
			},
		],
		{},
		conv.id,
	);
	const id = [...pending.keys()][0];
	if (!id) throw new Error("The actual native dialog was not registered");
	const entry = pending.get(id)!;
	const complete = entry.resolve;
	const resolved = vi.fn<(value: QuestionAnswer[] | null) => void>();
	entry.resolve = (value) => {
		resolved(value);
		complete(value);
	};
	return {
		client,
		id,
		pending,
		resolved,
		result,
		answer: (answers: QuestionAnswer[], cancelled = false) => client.resolveQuestion(id, answers, cancelled),
		close: () => {
			if (pending.has(id)) client.resolveQuestion(id, [], true);
			askHub.settle(id, { how: "gone", reason: "synthetic cleanup" });
			ClientSession.observeUnboundOwnerAnswer = prior;
			conversations.mockRestore();
			broadcasts.mockRestore();
			connected.mockRestore();
		},
	};
}

export function questionHostFixture({ separateHome = false }: { separateHome?: boolean } = {}) {
	const root = mkdtempSync(join(tmpdir(), "question-commit-host-"));
	const globals = globalThis as Record<symbol, unknown>;
	const previousPorts = globals[QUESTION_COMMIT_KEY];
	const previousHost = globals[QUEUE_HOST_KEY];
	const registry = new Map<string, Set<QuestionCommitEndpoint>>();
	globals[QUESTION_COMMIT_KEY] = registry;
	const native = (name: string) => {
		const manager = SessionManager.create(root, join(root, name));
		manager.appendMessage({ role: "user", content: "Synthetic fixture", timestamp: 1 });
		manager.appendCustomEntry("identity", { v: 1, id: "ops", via: "fixture" });
		return manager;
	};
	let parent = native("parent");
	let worker = native("worker");
	let lead = separateHome ? native("lead") : parent;
	const binding: QuestionBinding = {
		queue: parent.getSessionFile()!,
		queueId: parent.getSessionId(),
		worker: worker.getSessionFile()!,
		workerId: worker.getSessionId(),
		id: 7,
		n: 1,
		at: 1000,
		revision: 0,
		escalation: "r000000000001",
	};
	const roleDir = join(root, "roles");
	mkdirSync(join(roleDir, "ops"), { recursive: true });
	writeFileSync(join(roleDir, "ops", "identity.json"), JSON.stringify({ id: "ops", homeChat: lead.getSessionFile()! }));
	const env = { HOME: root, PI_IDENTITY_DIR: roleDir, PI_MEMORY_DIR: join(root, "memory") };
	const roles = loadIdentities(roleDir, env, loadSettings(env)).identities;
	const errors = vi.fn();
	const prompts = vi.fn(() => {
		throw new Error("a model turn is forbidden in this fixture");
	});
	const commands: string[] = [];
	const afterCommands: string[] = [];
	const control = {
		beforeDispatch: undefined as (() => Promise<void>) | undefined,
		beforePrepare: undefined as ((file: string) => Promise<void>) | undefined,
		beforeConsume: undefined as (() => void) | undefined,
		afterFinish: undefined as (() => Promise<void>) | undefined,
		beforeAfter: undefined as (() => Promise<void>) | undefined,
		appendFailure: false,
		/** The synthetic worker writes a restore op naming another generation (a receipt the host must not accept). */
		restoreWrongGeneration: false,
		skipFinish: false,
		busy: false,
		done: false,
		sourceAllowed: true,
		wrongWorker: false,
		lastToken: "",
		revision: 0,
		escalation: binding.escalation,
		now: 500,
	};
	let host: QueueHost;
	const endpoint: QuestionCommitEndpoint = {
		version: 1,
		sessionId: binding.workerId,
		file: binding.worker,
		binding: () => ({ ...binding, revision: control.revision, escalation: control.escalation }),
		checkCard: ({ binding: b, actor, tag, card }) => {
			const records = queueRecords(worker);
			if (
				control.done ||
				!control.sourceAllowed ||
				actor.file !== roles[0].homeChat ||
				actor.department !== "ops" ||
				queueRecords(parent).some((r) => r.op === "pause") ||
				!records.some((r) => r.op === "recall") ||
				records.some((r) => r.op === "owner_admission") ||
				b.revision !== control.revision ||
				b.escalation !== control.escalation ||
				tag !== "synthetic-recall-tag" ||
				card !== "Synthetic recall card"
			)
				return { allowed: false, reason: "synthetic native occurrence/content guard refused" };
			return { allowed: true };
		},
		commit(request: QuestionCommit): QuestionCommitResult {
			const { binding: b, change: c, actor } = request;
			const refuse = (reason: string): QuestionCommitResult => ({ status: "refused", reason });
			if (control.done) return refuse("finished task");
			if (queueRecords(parent).some((r) => r.op === "pause")) return refuse("parent held");
			if (actor.department !== "ops") return refuse("wrong department");
			const records = queueRecords(worker);
			const owner = records.findLast((r) => r.op === "owner_admission");
			const recall = records.findLast((r) => r.op === "recall");
			const restored = records.findLast((r) => r.op === "restore");
			if (restored) {
				const restoration = restored.restoration as { rid: string };
				return c.kind === "restore" && restoration.rid === c.rid
					? { status: "already", rid: restoration.rid, revision: Number(restored.revision) + 1 }
					: refuse("question no longer open");
			}
			if (owner) {
				const admission = owner.admission as { rid: string; answer: string };
				return c.kind === "owner" && admission.rid === c.rid && admission.answer === c.answer
					? { status: "already", rid: admission.rid, revision: Number(owner.revision) }
					: refuse("owner already admitted");
			}
			if (c.kind === "recall" && actor.file !== roles[0].homeChat) return refuse("not current home");
			if (recall) {
				const retraction = recall.retraction as { rid: string; escalation: string };
				return c.kind === "recall" && b.revision === Number(recall.revision) && b.escalation === retraction.escalation
					? { status: "already", rid: retraction.rid, revision: Number(recall.revision) + 1 }
					: refuse("routing changed");
			}
			if (b.revision !== control.revision || b.escalation !== control.escalation) return refuse("old occurrence");
			// Rule 24 restore (Ops #674): a synthetic worker op with the receipt fields the host checks; eligibility
			// and the restored block are native pi-queue's and proven in its own suites.
			if (c.kind === "restore" && actor.file !== roles[0].homeChat) return refuse("not current home");
			const record =
				c.kind === "restore"
					? {
							v: 1,
							op: "restore",
							id: b.id,
							n: b.n,
							at: b.at,
							revision: b.revision,
							generation: control.restoreWrongGeneration ? "r0000000000ff" : b.escalation,
							ts: 2000,
							restoration: { rid: c.rid, generation: b.escalation, lead: actor.department, home: actor.home, reason: c.reason, ts: 2000 },
						}
					: c.kind === "recall"
					? {
							v: 1,
							op: "recall",
							id: b.id,
							n: b.n,
							at: b.at,
							revision: b.revision,
							ts: 2000,
							retraction: {
								rid: c.rid,
								escalation: b.escalation,
								lead: actor.department,
								home: actor.home,
								reason: c.reason,
								ts: 2000,
							},
						}
					: {
							v: 1,
							op: "owner_admission",
							id: b.id,
							n: b.n,
							at: b.at,
							revision: b.revision,
							escalation: b.escalation,
							ts: 2000,
							admission: { rid: c.rid, answer: c.answer, from: c.from, ts: 2000 },
						};
			worker.appendCustomEntry("queue", record);
			if (c.kind === "recall" || c.kind === "restore") control.revision++;
			if (control.appendFailure) throw new Error("synthetic failure after native append");
			return { status: "committed", rid: c.rid, revision: control.revision };
		},
	};
	const command = {
		handler: async (args: string) => {
			if (args.startsWith("question-after ")) {
				afterCommands.push(args);
				await control.beforeAfter?.();
				return;
			}
			commands.push(args);
			if (!args.startsWith("question-commit ")) throw new Error("unexpected synthetic command");
			const token = args.slice("question-commit ".length);
			control.lastToken = token;
			control.beforeConsume?.();
			const capability = host.consumeQuestionCommit!(token, control.wrongWorker ? binding.queueId : binding.workerId);
			if (!capability || control.skipFinish) return;
			let result: QuestionCommitResult;
			try {
				result = endpoint.commit(capability.request);
			} catch (error) {
				result = { status: "uncertain", reason: error instanceof Error ? error.message : String(error) };
			}
			capability.finish(result);
			await control.afterFinish?.();
		},
	};
	const session = (manager: SessionManager, workerSession = false) =>
		nativeQuestionSession(manager, {
			command: (name) => (name === "queue" && workerSession ? command : undefined),
			context: () => ({}),
			busy: () => control.busy,
			errors,
			prompts,
		});
	const parentSession = session(parent);
	installPromptStartGuard(parentSession); // The real host's no-turn wrapper must still qualify.
	const workerSession = session(worker, true);
	const leadSession = separateHome ? session(lead) : parentSession;
	const sessions = new Map([
		[binding.queue, parentSession],
		[binding.worker, workerSession],
		[lead.getSessionFile()!, leadSession],
	]);
	registry.set(binding.workerId, new Set([endpoint]));
	registry.set(binding.queueId, new Set([{ ...endpoint, sessionId: binding.queueId, file: binding.queue }]));
	if (separateHome)
		registry.set(
			lead.getSessionId(),
			new Set([{ ...endpoint, sessionId: lead.getSessionId(), file: lead.getSessionFile()! }]),
		);
	const dispatcher = { queueSessionFor: (file: string) => sessions.get(file) ?? null };
	const runCommand = nativeQuestionDispatcher(dispatcher.queueSessionFor);
	let integration = nativeQuestionHost(
		{
			session: dispatcher.queueSessionFor,
			roles: () => roles,
			prepare: async (file) => {
				await control.beforePrepare?.(file);
			},
			dispatch: async (file, line) => {
				await control.beforeDispatch?.();
				return runCommand(file, line);
			},
		},
		() => control.now,
	);
	let uninstall: (() => void) | undefined;
	const install = () => {
		uninstall?.();
		uninstall = installQueueHost({
			commitQuestion: integration.commits.commitQuestion,
			consumeQuestionCommit: integration.commits.consumeQuestionCommit,
			deliverQuestionCard: integration.cards.deliverQuestionCard,
			runCommand,
			startChat: async () => {
				throw new Error("fixture never starts chats");
			},
			closeChat: async () => false,
			wakeChat: async () => false,
			chatState: async () => ({ state: "idle" }),
		});
		host = globals[QUEUE_HOST_KEY] as QueueHost;
	};
	install();
	control.now = 2000;
	return {
		root,
		binding,
		parentSession,
		workerSession,
		leadSession,
		registry,
		endpoint,
		roles,
		control,
		commands,
		afterCommands,
		errors,
		prompts,
		get parent() {
			return parent;
		},
		get lead() {
			return lead;
		},
		get worker() {
			return worker;
		},
		get host() {
			return host;
		},
		get integration() {
			return integration;
		},
		recall: () =>
			host.commitQuestion!(lead.getSessionId(), binding, {
				kind: "recall",
				rid: "r000000000002",
				tag: "synthetic-tag",
				reason: "Synthetic lead correction",
			}),
		/** Rule 24 restore from the accountable home (the lead chat is the role's home here). */
		restore: () =>
			host.commitQuestion!(lead.getSessionId(), binding, {
				kind: "restore",
				rid: "r000000000003",
				tag: "synthetic-tag",
				reason: "Synthetic automatic escalation back to its block",
				checkpoint: 9000,
				refs: { question: "q", source: "s", block: "b", poke: "p", dispatch: "d" },
			}),
		restart: () => {
			parent = SessionManager.open(binding.queue);
			worker = SessionManager.open(binding.worker);
			lead = separateHome ? SessionManager.open(lead.getSessionFile()!) : parent;
			Object.defineProperty(parentSession, "sessionManager", { value: parent, configurable: true });
			Object.defineProperty(workerSession, "sessionManager", { value: worker, configurable: true });
			if (separateHome) Object.defineProperty(leadSession, "sessionManager", { value: lead, configurable: true });
			integration = nativeQuestionHost(
				{
					session: dispatcher.queueSessionFor,
					roles: () => roles,
					prepare: async (file) => {
						await control.beforePrepare?.(file);
					},
					dispatch: runCommand,
				},
				() => control.now,
			);
			install();
		},
		close: () => {
			uninstall?.();
			globals[QUESTION_COMMIT_KEY] = previousPorts;
			globals[QUEUE_HOST_KEY] = previousHost;
			rmSync(root, { recursive: true, force: true });
		},
	};
}
