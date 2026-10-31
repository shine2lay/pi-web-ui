/** Coupled native world: no synthetic queue author, host lock, token consumer, or command handler. */
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AgentSession, SessionManager } from "@earendil-works/pi-coding-agent";
import { vi } from "vitest";
import { queueSourcePath } from "./queue-source-path.js";
import { loadIdentities } from "../../server/identities.js";
import { loadSettings } from "../../server/identity-config.js";
import { installPromptStartGuard } from "../../server/prompt-start-guard.js";
import { installQueueHost, QUEUE_HOST_KEY, type QueueHost } from "../../server/queue-host.js";
import { nativeQuestionHost } from "../../server/queue-question-native.js";
import { QUESTION_COMMIT_KEY, questionEndpoint, type QuestionBinding } from "../../server/queue-question-port.js";
import {
	flushNativeQuestionMessages,
	nativeQuestionDispatcher,
	nativeQuestionSession,
	type NativeQuestionCommand,
} from "../fixtures/question-commit-host.js";

export const NATIVE_TASK_ID = 1;
export const NATIVE_PLAN = {
	title: "Choose the synthetic cache policy",
	goal: "Keep the synthetic list responsive",
	doneWhen: "The fixed cache cases pass",
	decided: "Reuse the existing cache within the approved scope",
	steps: "Apply the chosen existing policy",
	verify: "Check the fixed cases",
	mustNot: "Change live state, call a model, spend money, or deploy",
};
const QUESTION = "Which synthetic cache policy should we use?";
const CHOICES = ["Keep short cache", "Disable cache"];
const BRIEF = {
	progress: "Both fixed cases preserve the list.",
	recommendation: "Keep short cache within scope.",
	constraints: "No deployment or new dependency.",
};
const OWNER_QUESTION = "Should the synthetic task keep short cache?";
const OWNER_CHOICES = ["Keep it", "Not now"];
const OWNER_CONTEXT = {
	goal: NATIVE_PLAN.goal,
	progress: BRIEF.progress,
	decided: "The synthetic task plan is already approved.",
	why_owner: "The synthetic lead initially passed this ordinary technical choice to the owner.",
	questions: [OWNER_QUESTION],
	options: OWNER_CHOICES.map((choice) => ({
		choice,
		tradeoffs: "Choose the corresponding existing policy.",
		cost: "None",
		time: "No delay",
		risk: "Synthetic task only",
		authorizes: "Only the existing policy; no deployment or spending.",
	})),
	recommendation: BRIEF.recommendation,
};

type Data = Record<string, unknown>;
interface NativeTask {
	id: number;
	status: string;
	plan: unknown;
	question?: string;
	choices?: string[];
	ask?: {
		n: number;
		at: number;
		revision?: number;
		origin?: unknown;
		escalation?: { rid: string };
		retraction?: { rid: string; escalation: string };
		ownerAdmission?: { rid: string; answer: string };
	};
}
interface NativeState {
	queueId?: string;
	tasks: NativeTask[];
}
interface NativeTool {
	name: string;
	execute(id: string, params: Data, signal: undefined, update: undefined, ctx: unknown): unknown;
}
interface NativeChat {
	manager: SessionManager;
	session: AgentSession;
	file: string;
	sid: string;
	busy: boolean;
	op(data: Data): void;
	emit(event: string, payload?: Data): Promise<void>;
	tool(name: string, params: Data): Promise<Data>;
}

/** Deliberate dynamic extension boundary; validate exports, never substitute native queue policy. */
async function nativeQueueSource() {
	const source = queueSourcePath();
	const entry = await import(/* @vite-ignore */ `${source}/index.ts`);
	const queue = await import(/* @vite-ignore */ `${source}/queue.ts`);
	const tail = await import(/* @vite-ignore */ `${source}/transcript-tail.ts`);
	const readers = await import(/* @vite-ignore */ `${source}/readers.ts`);
	const exported = (value: unknown): ((...args: unknown[]) => unknown) => {
		assert.ok(typeof value === "function", "Missing production queue export");
		return (...args) => Reflect.apply(value, undefined, args);
	};
	const extension = exported(entry.default),
		replay = exported(queue.replay);
	const opsTag = exported(queue.opsTag),
		readQueue = exported(tail.readQueue),
		publish = exported(readers.publishReaders);
	const state = (value: unknown): NativeState => {
		assert.ok(
			value && typeof value === "object" && "tasks" in value && Array.isArray(value.tasks),
			"Native replay returned no task list",
		);
		return value as NativeState;
	};
	return {
		load: (api: object) => extension(api),
		publish: () => publish(),
		replay: (manager: SessionManager) => state(replay(manager.getBranch(), manager.getSessionId())),
		read: (file: string) => state(readQueue(file, true)),
		tag: (file: string, ask: NonNullable<NativeTask["ask"]>) => {
			const value = opsTag(file, NATIVE_TASK_ID, ask.n, ask.at, ask.revision);
			assert.equal(typeof value, "string");
			return value as string;
		},
	};
}

/**
 * role: the queue's department; homeAt: which chat is its registered home (the separate lead chat, or the queue's own
 * chat); others: further departments, each with its own home chat (Ops #676's source of a relayed owner answer).
 */
export interface NativeWorldShape {
	role?: string;
	homeAt?: "lead" | "parent";
	others?: string[];
}

export async function nativeQueueWorld({ role = "frontend", homeAt = "lead", others = [] }: NativeWorldShape = {}) {
	const agentDir = process.env.PI_CODING_AGENT_DIR;
	assert.ok(
		agentDir && agentDir.includes("question-coupled-"),
		"Coupled setup must isolate all data before application imports",
	);
	const root = mkdtempSync(join(agentDir, "world-"));
	const globals = globalThis as Record<symbol, unknown>;
	const keys = [
		QUEUE_HOST_KEY,
		QUESTION_COMMIT_KEY,
		Symbol.for("pi-queue.source-endpoints.v1"),
		Symbol.for("pi-queue.readers"),
		Symbol.for("pi-queue.readers.v1"),
	];
	const previous = new Map(keys.map((key) => [key, globals[key]]));
	globals[QUESTION_COMMIT_KEY] = new Map();
	globals[Symbol.for("pi-queue.source-endpoints.v1")] = new Map();
	const native = await nativeQueueSource();
	native.publish();
	const pending = new Set<Promise<unknown>>();
	const track = <T>(promise: Promise<T>): Promise<T> => {
		pending.add(promise);
		void promise.then(
			() => pending.delete(promise),
			() => pending.delete(promise),
		);
		return promise;
	};
	const drain = async () => {
		while (pending.size) await Promise.all([...pending]);
	};
	const model = vi.fn(() => {
		throw new Error("A model turn is forbidden in this coupled proof");
	});
	const errors = vi.fn();
	const sends = new Map<string, number>();
	const sessions = new Map<string, AgentSession>();
	const commands: Array<{ file: string; action: string }> = [];
	const cardResults: Array<{ tag: string; status: string }> = [];
	const control: { beforeCommit?: () => Promise<void> } = {};
	let serial = 0;

	const createChat = (name: string, reopen?: string, chatRole = role): NativeChat => {
		const manager = reopen ? SessionManager.open(reopen) : SessionManager.create(root, join(root, name));
		if (!reopen) {
			manager.appendMessage({ role: "user", content: "Synthetic coupled fixture", timestamp: Date.now() });
			manager.appendCustomEntry("identity", { v: 1, id: chatRole, via: "fixture" });
		}
		const file = manager.getSessionFile();
		assert.ok(file);
		const tools = new Map<string, NativeTool>();
		const registered = new Map<string, NativeQuestionCommand>();
		const events = new Map<string, Array<(event: unknown, context: unknown) => unknown>>();
		let active: string[] | undefined;
		const ctx = {
			sessionManager: manager,
			cwd: root,
			hasUI: true,
			isIdle: () => !chat.busy,
			ui: {
				notify: vi.fn(),
				confirm: async () => {
					throw new Error("No approval dialog belongs in this proof");
				},
			},
		};
		const session = nativeQuestionSession(manager, {
			command: (key) => registered.get(key),
			context: () => ctx,
			busy: () => chat.busy,
			errors,
			prompts: model,
		});
		installPromptStartGuard(session);
		const chat: NativeChat = {
			manager,
			session,
			file,
			sid: manager.getSessionId(),
			busy: false,
			op: (data) => manager.appendCustomEntry("queue", { v: 1, ts: Date.now(), ...data }),
			async emit(event, payload = {}) {
				for (const handler of events.get(event) ?? []) await handler(payload, ctx);
			},
			async tool(name, params) {
				const tool = tools.get(name);
				assert.ok(tool, `Missing production tool ${name}`);
				const wasBusy = chat.busy;
				chat.busy = true;
				try {
					const result: unknown = await tool.execute(`coupled-${++serial}`, params, undefined, undefined, ctx);
					assert.ok(
						result && typeof result === "object" && "details" in result,
						"Native tool returned no result details",
					);
					return result.details as Data;
				} finally {
					chat.busy = wasBusy;
					if (!chat.busy) flushNativeQuestionMessages(session);
				}
			},
		};
		native.load({
			registerTool: (tool: NativeTool) => tools.set(tool.name, tool),
			registerCommand: (key: string, command: NativeQuestionCommand) => registered.set(key, command),
			on: (key: string, handler: (event: unknown, context: unknown) => unknown) =>
				events.set(key, [...(events.get(key) ?? []), handler]),
			getActiveTools: () => active ?? [...tools.keys()],
			setActiveTools: (names: string[]) => {
				active = names;
			},
			getThinkingLevel: () => "medium",
			appendEntry: (kind: string, data: unknown) => manager.appendCustomEntry(kind, data),
			// Ordinary initial consult requests are counted only; this proof never creates an agent turn.
			sendUserMessage: () => {
				sends.set(file, (sends.get(file) ?? 0) + 1);
			},
			sendMessage: (...args: Parameters<AgentSession["sendCustomMessage"]>) => {
				if (args[1]?.triggerTurn) model();
				return track(session.sendCustomMessage(...args));
			},
		});
		sessions.set(file, session);
		return chat;
	};
	let parent = createChat("parent"),
		worker = createChat("worker"),
		lead = createChat("lead");
	let homes = new Map(others.map((other) => [other, createChat(`${other}-home`, undefined, other)]));
	const all = () => [lead, parent, worker, ...homes.values()];
	const roleDir = join(root, "roles");
	const homeFiles = new Map([[role, (homeAt === "parent" ? parent : lead).file], ...[...homes].map(([id, chat]) => [id, chat.file] as const)]);
	for (const [id, homeChat] of homeFiles) {
		mkdirSync(join(roleDir, id), { recursive: true });
		writeFileSync(join(roleDir, id, "identity.json"), JSON.stringify({ id, homeChat }));
	}
	const env = { HOME: root, PI_IDENTITY_DIR: roleDir, PI_MEMORY_DIR: join(root, "memory") };
	const roles = loadIdentities(roleDir, env, loadSettings(env)).identities;
	for (const [id, homeChat] of homeFiles)
		assert.equal(roles.find((r) => r.id === id)?.homeChat, homeChat, "Native role loader must recognize the synthetic home");
	const sessionFor = (file: string) => sessions.get(file) ?? null;
	const sdkDispatch = nativeQuestionDispatcher(sessionFor);
	const dispatch = (file: string, line: string) =>
		track(
			(async () => {
				commands.push({ file, action: line.split(" ")[1] });
				if (line.startsWith("/queue question-commit ")) {
					const before = control.beforeCommit;
					control.beforeCommit = undefined;
					await before?.();
				}
				return sdkDispatch(file, line);
			})(),
		);
	const makeIntegration = () =>
		nativeQuestionHost({
			session: sessionFor,
			roles: () => roles,
			prepare: async (file) => {
				assert.ok(sessions.has(file), "Only an already invented session can be opened");
			},
			dispatch,
		});
	let integration = makeIntegration();
	let host: QueueHost;
	let uninstall: (() => void) | undefined;
	const install = () => {
		uninstall?.();
		uninstall = installQueueHost({
			commitQuestion: (...args) => integration.commits.commitQuestion(...args),
			consumeQuestionCommit: integration.commits.consumeQuestionCommit,
			deliverQuestionCard: (...args) =>
				track(
					integration.cards.deliverQuestionCard(...args).then((result) => {
						cardResults.push({ tag: args[1], status: result.status });
						return result;
					}),
				),
			relayOwnerAnswer: (...args) => integration.relays.relayOwnerAnswer(...args),
			consumeOwnerRelay: (...args) => integration.relays.consumeOwnerRelay(...args),
			runCommand: dispatch,
			coordinator: () => undefined,
			leadChat: (id) => {
				const file = roles.find((r) => r.id === id)?.homeChat;
				return file ? { id, file } : undefined;
			},
			startChat: async () => {
				throw new Error("The coupled proof never starts a chat");
			},
			closeChat: async () => {
				throw new Error("The coupled proof never closes a task chat");
			},
			wakeChat: async () => {
				throw new Error("The coupled proof never wakes a chat");
			},
			chatState: async (file) => ({ state: sessions.has(file) ? "idle" : "closed" }),
		});
		host = globals[QUEUE_HOST_KEY] as QueueHost;
	};
	install();
	parent.op({ op: "add", id: NATIVE_TASK_ID, plan: NATIVE_PLAN, touches: ["fixture repo"], standalone: true });
	parent.op({ op: "run", queueId: parent.sid });
	parent.op({ op: "start", id: NATIVE_TASK_ID, lane: true });
	parent.op({ op: "chat", id: NATIVE_TASK_ID, file: worker.file, title: "Synthetic worker" });
	worker.op({
		op: "assigned",
		id: NATIVE_TASK_ID,
		plan: NATIVE_PLAN,
		touches: ["fixture repo"],
		standalone: true,
		from: { file: parent.file, title: "Synthetic parent" },
	});
	for (const chat of all()) await chat.emit("session_start");
	await drain();
	const task = (chat: NativeChat) => {
		const found = native.replay(chat.manager).tasks.find((candidate) => candidate.id === NATIVE_TASK_ID);
		assert.ok(found, "Native replay must retain the synthetic task");
		return found;
	};
	const binding = (): QuestionBinding => {
		const value = questionEndpoint(worker.sid)?.binding(NATIVE_TASK_ID);
		assert.ok(value, "The production lifecycle must register a supported question binding");
		return value;
	};
	const world = {
		root,
		model,
		errors,
		sends,
		commands,
		cardResults,
		control,
		drain,
		task,
		binding,
		get parent() {
			return parent;
		},
		get worker() {
			return worker;
		},
		get lead() {
			return lead;
		},
		/** Another department's home chat (shape.others). */
		home(id: string) {
			const chat = homes.get(id);
			assert.ok(chat, `No synthetic home chat for ${id}`);
			return chat;
		},
		/** The owner stops the worker's run: its last reply ends aborted, and the native queue asks him to carry on. */
		async stopRun() {
			vi.setSystemTime(Date.now() + 1);
			worker.manager.appendMessage({
				role: "assistant",
				content: [{ type: "text", text: "Synthetic partial reply" }],
				api: "anthropic-messages",
				provider: "synthetic",
				model: "none",
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
				stopReason: "aborted",
				timestamp: Date.now(),
			});
			await worker.emit("agent_settled");
			await drain();
		},
		get host() {
			return host;
		},
		get integration() {
			return integration;
		},
		freshTag: () => {
			const ask = task(worker).ask;
			assert.ok(ask);
			return native.tag(worker.file, ask);
		},
		replay: (chat: NativeChat) => native.replay(SessionManager.open(chat.file)),
		diskState: (chat: NativeChat) => native.read(chat.file),
		async escalate() {
			// Native coverage is millisecond metadata: a new question must be strictly after host start.
			vi.setSystemTime(Date.now() + 1);
			await worker.tool("queue_stuck", { question: QUESTION, choices: CHOICES, ...BRIEF });
			await drain();
			const original = { question: task(worker).question, choices: task(worker).choices, plan: task(worker).plan };
			const ask = task(worker).ask;
			assert.ok(ask?.origin);
			const tag = native.tag(worker.file, ask);
			const result = await (homeAt === "parent" ? parent : lead).tool("queue_reply", {
				id: NATIVE_TASK_ID,
				ask: tag,
				question: OWNER_QUESTION,
				choices: OWNER_CHOICES,
				owner_context: OWNER_CONTEXT,
			});
			assert.equal(result.passed, true);
			await drain();
			assert.equal(task(worker).status, "stuck");
			assert.ok(task(worker).ask?.escalation);
			return { tag, binding: binding(), original };
		},
		recall: (tag: string) =>
			(homeAt === "parent" ? parent : lead).tool("queue_reply", {
				id: NATIVE_TASK_ID,
				ask: tag,
				action: "recall",
				reason: "An ordinary technical choice remains within the approved synthetic plan.",
			}),
		async settleLead() {
			lead.busy = false;
			flushNativeQuestionMessages(lead.session);
			await lead.emit("agent_settled");
			await drain();
		},
		async restart() {
			await drain();
			for (const chat of all()) await chat.emit("session_shutdown");
			assert.equal(questionEndpoint(worker.sid), undefined, "The old production endpoint must unregister");
			uninstall?.();
			uninstall = undefined;
			globals[QUESTION_COMMIT_KEY] = new Map();
			globals[Symbol.for("pi-queue.source-endpoints.v1")] = new Map();
			sessions.clear();
			parent = createChat("parent", parent.file);
			worker = createChat("worker", worker.file);
			lead = createChat("lead", lead.file);
			homes = new Map([...homes].map(([id, chat]) => [id, createChat(`${id}-home`, chat.file, id)]));
			integration = makeIntegration();
			install();
			native.publish();
			for (const chat of all()) await chat.emit("session_start");
			await drain();
		},
		async close() {
			await drain();
			for (const chat of all()) await chat.emit("session_shutdown");
			uninstall?.();
			for (const [key, value] of previous) {
				if (value === undefined) delete globals[key];
				else globals[key] = value;
			}
			rmSync(root, { recursive: true, force: true });
		},
	};
	return world;
}
