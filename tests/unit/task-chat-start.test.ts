/**
 * task-chat-start (Ops #629, H-LAUNCH-ONCE-1): a queued task's chat counts as started once pi has
 * taken its first prompt, however long the add-ons' "before the AI starts" step takes (pi-worktree
 * makes the task's worktree there: over a minute under load). A start reported as failed never
 * runs a turn afterwards, so the queue's retry can't give the task a second chat.
 *
 * Real SDK session, faux model, inline extension: no real chat, no network. `send` stands in for
 * ClientSession.prompt: it hands pi the hooks the way promptInLine does (the gate first in
 * preflightResult) and reports the end the way prompt()'s finally does.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import {
	type AgentSession,
	createAgentSession,
	DefaultResourceLoader,
	type ExtensionAPI,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startTaskChat, type TaskStartHooks } from "../../server/task-chat-start.js";
import { HANG_GUARD_MS } from "./load-independent.js";

/** Longer than the old check's window (20 s, scaled to 1 s for the before-run on the old code). */
const SLOW_HOOK_MS = 1_500;

let root: string;
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "task-chat-start-"));
});
afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

type Fixture = {
	session: AgentSession;
	/** Model calls made (one per turn here). */
	requests: () => number;
	/** session.prompt calls made by `send`. */
	prompts: () => number;
	send: (hooks: TaskStartHooks) => Promise<void>;
	ranTurn: () => boolean;
};

interface Internals {
	_isEmittingAgentSettled: boolean;
	_deferredSettledActions: (() => Promise<void>)[];
	_compactionAbortController: AbortController | undefined;
}

async function fixture(slowHookMs = 0): Promise<Fixture> {
	const faux = fauxProvider({ provider: "faux-start", models: [{ id: "m" }] });
	const modelRuntime = await ModelRuntime.create({
		authPath: join(root, "auth.json"),
		modelsPath: null,
		refreshOnCreate: false,
	});
	modelRuntime.registerNativeProvider(faux.provider);
	let requests = 0;
	faux.setResponses(
		Array.from({ length: 6 }, () => () => {
			requests++;
			return fauxAssistantMessage(`reply ${requests}`);
		}),
	);
	const settingsManager = SettingsManager.inMemory();
	const resourceLoader = new DefaultResourceLoader({
		cwd: root,
		agentDir: root,
		settingsManager,
		extensionFactories: [
			(api: ExtensionAPI) => {
				// pi-worktree's `wt new` stand-in: the add-ons' step before the run.
				api.on("before_agent_start", async () => {
					if (slowHookMs) await new Promise((r) => setTimeout(r, slowHookMs));
					return undefined;
				});
			},
		],
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
	});
	await resourceLoader.reload();
	const { session } = await createAgentSession({
		cwd: root,
		agentDir: root,
		modelRuntime,
		model: faux.getModel("m"),
		tools: [],
		resourceLoader,
		sessionManager: SessionManager.inMemory(root),
		settingsManager,
	});
	await session.bindExtensions({});
	let prompts = 0;
	const before = session.messages.length;
	const send = async (hooks: TaskStartHooks): Promise<void> => {
		prompts++;
		let handedOver = false;
		try {
			await session.prompt("kickoff", {
				preflightResult: (d) => {
					hooks.gate(d);
					handedOver = true;
				},
			});
		} catch (err) {
			hooks.ended((err as Error).message);
			return;
		}
		// prompt()'s finally: a text pi put off is answered later, when pi takes it or refuses it.
		if (handedOver) hooks.ended();
	};
	return {
		session,
		requests: () => requests,
		prompts: () => prompts,
		send,
		ranTurn: () => session.isStreaming || session.messages.length > before,
	};
}

async function settled(session: AgentSession): Promise<void> {
	const until = Date.now() + HANG_GUARD_MS; // Ops #639: a hang guard; 5 s gave up early on a busy machine
	while (Date.now() < until && (session.isStreaming || !session.isIdle)) await new Promise((r) => setTimeout(r, 10));
	await new Promise((r) => setTimeout(r, 50));
}

const userMessages = (s: AgentSession) => s.messages.filter((m) => m.role === "user").length;

describe("task-chat-start (H-LAUNCH-ONCE-1)", () => {
	it("(a) a before_agent_start step longer than the old window: started, one prompt, one turn", async () => {
		const f = await fixture(SLOW_HOOK_MS);
		const t0 = Date.now();
		await expect(startTaskChat({ send: f.send, ranTurn: f.ranTurn })).resolves.toBeUndefined();
		// It waited for the slow step instead of giving up before it.
		expect(Date.now() - t0).toBeGreaterThanOrEqual(SLOW_HOOK_MS - 50);
		await settled(f.session);
		expect(f.prompts()).toBe(1);
		expect(f.requests()).toBe(1);
		expect(userMessages(f.session)).toBe(1);
		f.session.dispose();
	});

	it("(b) a prompt pi refuses: the start is reported failed, and no turn runs", async () => {
		const f = await fixture();
		(f.session as unknown as Internals)._compactionAbortController = new AbortController();
		await expect(startTaskChat({ send: f.send, ranTurn: f.ranTurn })).rejects.toThrow();
		(f.session as unknown as Internals)._compactionAbortController = undefined;
		await settled(f.session);
		expect(f.requests()).toBe(0);
		expect(userMessages(f.session)).toBe(0);
		f.session.dispose();
	});

	it("(b2) the refusal carries pi's reason, at once", async () => {
		const f = await fixture();
		(f.session as unknown as Internals)._compactionAbortController = new AbortController();
		// Ops #639: "at once" is an order of events, not a wall-clock budget (500 ms failed on a busy machine): the
		// start has already failed when pi's prompt call is over and one more turn of the event loop has passed. A
		// start that waited for a timer or a window before giving up hasn't failed by then.
		let failed = false;
		let promptOver!: Promise<boolean>;
		const start = startTaskChat({
			send: (hooks) => {
				promptOver = f.send(hooks).then(() => new Promise((r) => setImmediate(() => r(failed))));
				return promptOver.then(() => undefined);
			},
			ranTurn: f.ranTurn,
		}).catch((err: unknown) => {
			failed = true;
			throw err;
		});
		const refused = expect(start).rejects.toThrow(/compaction is in progress/);
		const failedWhenPromptOver = await promptOver;
		await refused;
		expect(failedWhenPromptOver).toBe(true);
		(f.session as unknown as Internals)._compactionAbortController = undefined;
		await settled(f.session);
		expect(f.requests()).toBe(0);
		expect(userMessages(f.session)).toBe(0);
		f.session.dispose();
	});

	it("(c) a start reported failed never runs a turn afterwards (a prompt pi put off, taken later)", async () => {
		const f = await fixture();
		const inner = f.session as unknown as Internals;
		// pi is telling the add-ons a run settled: it puts the prompt off and returns without taking it.
		inner._isEmittingAgentSettled = true;
		await expect(startTaskChat({ send: f.send, ranTurn: f.ranTurn })).rejects.toThrow();
		// The settle step ends after the failure was reported: pi now runs the put-off prompt.
		await new Promise((r) => setTimeout(r, SLOW_HOOK_MS));
		inner._isEmittingAgentSettled = false;
		for (const action of inner._deferredSettledActions.splice(0)) await action().catch(() => {});
		await settled(f.session);
		expect(f.requests()).toBe(0);
		expect(userMessages(f.session)).toBe(0);
		f.session.dispose();
	});
});
