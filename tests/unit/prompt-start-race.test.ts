/**
 * prompt-start-race (Ops #261, H-PROMPT-RACE-1): a second prompt start that arrives while the first
 * one is still on its way in (or while a run is going) becomes a follow-up of that run. A start that
 * is refused never clears the running flag of the run still going.
 *
 * Real SDK session, faux model, inline extension: no real chat, no network.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import {
	type AgentSession,
	createAgentSession,
	DefaultResourceLoader,
	type ExtensionAPI,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { installPromptStartGuard } from "../../server/prompt-start-guard.js";
import { HANG_GUARD_MS } from "./load-independent.js";

let root: string;
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "prompt-start-race-"));
});
afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

type Fixture = {
	session: AgentSession;
	pi: ExtensionAPI;
	/** Text of the newest user message in each model request, in order. */
	requests: string[];
	errors: string[];
	toolStarted: Promise<void>;
	release: () => void;
};

const textOf = (m: { content?: unknown }): string =>
	typeof m.content === "string"
		? m.content
		: Array.isArray(m.content)
			? (m.content as { type: string; text?: string }[])
					.filter((c) => c.type === "text")
					.map((c) => c.text ?? "")
					.join("\n")
			: "";

/** Words that make the faux model call the slow tool once, on the first request carrying them. */
const TOOL_WORD = "use-the-tool";

async function fixture(guard: boolean): Promise<Fixture> {
	const faux = fauxProvider({ provider: "faux-race", models: [{ id: "m" }] });
	const modelRuntime = await ModelRuntime.create({
		authPath: join(root, "auth.json"),
		modelsPath: null,
		refreshOnCreate: false,
	});
	modelRuntime.registerNativeProvider(faux.provider);
	const requests: string[] = [];
	let toolCalled = false;
	const reply = (context: { messages: { role: string; content?: unknown }[] }) => {
		const users = context.messages.filter((m) => m.role === "user");
		const last = users.at(-1);
		requests.push(last ? textOf(last) : "");
		const lastMessage = context.messages.at(-1);
		if (!toolCalled && lastMessage?.role === "user" && textOf(lastMessage).includes(TOOL_WORD)) {
			toolCalled = true;
			return fauxAssistantMessage(fauxToolCall("slow_step", {}), { stopReason: "toolUse" });
		}
		return fauxAssistantMessage(`reply ${requests.length}`);
	};
	faux.setResponses(Array.from({ length: 12 }, () => reply));

	let toolStartedResolve!: () => void;
	const toolStarted = new Promise<void>((r) => {
		toolStartedResolve = r;
	});
	let release!: () => void;
	const released = new Promise<void>((r) => {
		release = r;
	});
	let pi!: ExtensionAPI;
	const settingsManager = SettingsManager.inMemory();
	const resourceLoader = new DefaultResourceLoader({
		cwd: root,
		agentDir: root,
		settingsManager,
		extensionFactories: [
			(api: ExtensionAPI) => {
				pi = api;
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
		tools: ["slow_step"],
		customTools: [
			{
				name: "slow_step",
				label: "Slow step",
				description: "Fixture step that waits for the test.",
				parameters: Type.Object({}),
				execute: async (_id: string, _params: unknown, signal?: AbortSignal) => {
					toolStartedResolve();
					await Promise.race([
						released,
						new Promise<void>((r) => signal?.addEventListener("abort", () => r(), { once: true })),
					]);
					return { content: [{ type: "text" as const, text: "ok" }], details: {} };
				},
			},
		],
		resourceLoader,
		sessionManager: SessionManager.inMemory(root),
		settingsManager,
	});
	const errors: string[] = [];
	await session.bindExtensions({ onError: (e) => errors.push(e.error) });
	if (guard) installPromptStartGuard(session);
	return { session, pi, requests, errors, toolStarted, release };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

/** Wait until the session has been idle for a while (or give up at the hang guard: 3 s ran out on a busy machine). */
async function settled(session: AgentSession): Promise<void> {
	const until = Date.now() + HANG_GUARD_MS;
	let quietSince = 0;
	while (Date.now() < until) {
		if (session.isStreaming) quietSince = 0;
		else if (!quietSince) quietSince = Date.now();
		else if (Date.now() - quietSince > 60) return;
		await new Promise((r) => setTimeout(r, 5));
	}
}

/** Order of session entries by kind: "user:<text>", "assistant:toolUse", "toolResult", "custom:<type>"
 *  (the SDK's own tool-loadout "system" note is left out). */
function shape(session: AgentSession): string[] {
	const out: string[] = [];
	for (const e of session.sessionManager.getEntries() as {
		type: string;
		customType?: string;
		message?: { role: string; content?: unknown; stopReason?: string };
	}[]) {
		if (e.type === "custom_message") out.push(`custom:${e.customType}`);
		else if (e.type === "message" && e.message) {
			const m = e.message;
			if (m.role === "user") out.push(`user:${textOf(m)}`);
			else if (m.role === "assistant") out.push(m.stopReason === "toolUse" ? "assistant:toolUse" : "assistant");
			else if (m.role !== "system") out.push(m.role);
		}
	}
	return out;
}

/** The #106 race: two extension sends back to back on an idle chat, then a no-turn note mid-tool. */
async function race(guard: boolean) {
	const f = await fixture(guard);
	f.pi.sendUserMessage(`first ${TOOL_WORD}`);
	f.pi.sendUserMessage("second");
	await f.toolStarted;
	await tick();
	const streamingMidRun = f.session.isStreaming;
	f.pi.sendMessage({ customType: "queue-report", content: "note", display: false }, { triggerTurn: false });
	await tick();
	f.release();
	await settled(f.session);
	const outcome = {
		streamingMidRun,
		requests: f.requests,
		alreadyProcessing: f.errors.filter((e) => /already processing/i.test(e)).length,
		shape: shape(f.session),
	};
	f.session.dispose();
	return outcome;
}

describe("prompt-start-race (H-PROMPT-RACE-1)", () => {
	it("two back-to-back starts and a mid-tool note: both delivered in order, flag held, note after the result", async () => {
		const o = await race(true);
		expect(o.alreadyProcessing).toBe(0);
		expect(o.streamingMidRun).toBe(true);
		// The note reaches the model as context after the tool result (it is the newest user-side message then).
		expect(o.requests).toEqual([`first ${TOOL_WORD}`, "note", "second"]);
		expect(o.shape).toEqual([
			`user:first ${TOOL_WORD}`,
			"assistant:toolUse",
			"toolResult",
			"custom:queue-report",
			"assistant",
			"user:second",
			"assistant",
		]);
	});

	it("canary: the SDK alone still has the race (when this fails after an SDK upgrade, the patch may go)", async () => {
		const o = await race(false);
		expect(o.alreadyProcessing).toBe(1);
		expect(o.streamingMidRun).toBe(false);
		expect(o.requests).not.toContain("second");
		expect(o.shape.indexOf("custom:queue-report")).toBeLessThan(o.shape.indexOf("toolResult"));
	});

	it("a triggerTurn message racing an extension start becomes a follow-up, not a second run", async () => {
		const f = await fixture(true);
		f.pi.sendUserMessage(`first ${TOOL_WORD}`);
		f.pi.sendMessage({ customType: "wake", content: "wake up", display: true }, { triggerTurn: true });
		await f.toolStarted;
		await tick();
		expect(f.session.isStreaming).toBe(true);
		f.release();
		await settled(f.session);
		expect(f.errors).toEqual([]);
		expect(shape(f.session)).toEqual([
			`user:first ${TOOL_WORD}`,
			"assistant:toolUse",
			"toolResult",
			"assistant",
			"custom:wake",
			"assistant",
		]);
		f.session.dispose();
	});

	it("backstop: a start that reaches the run step mid-run follows that run and leaves its flag alone", async () => {
		const f = await fixture(true);
		const run = f.session.prompt(`go ${TOOL_WORD}`);
		await f.toolStarted;
		const internal = f.session as unknown as { _runAgentPrompt: (m: unknown) => Promise<void> };
		await internal._runAgentPrompt([
			{ role: "user", content: [{ type: "text", text: "direct" }], timestamp: Date.now() },
		]);
		expect(f.session.isStreaming).toBe(true);
		f.release();
		await run;
		await settled(f.session);
		expect(shape(f.session)).toEqual([
			`user:go ${TOOL_WORD}`,
			"assistant:toolUse",
			"toolResult",
			"assistant",
			"user:direct",
			"assistant",
		]);
		f.session.dispose();
	});

	it("the SDK internals the guard leans on are still there", async () => {
		const f = await fixture(false);
		const internal = f.session as unknown as Record<string, unknown>;
		expect(typeof internal._runAgentPrompt).toBe("function");
		expect(typeof internal._isAgentRunActive).toBe("boolean");
		expect(typeof internal._isEmittingAgentSettled).toBe("boolean");
		f.session.dispose();
	});

	it("three queued sends keep their order", async () => {
		const f = await fixture(true);
		f.pi.sendUserMessage("one");
		f.pi.sendUserMessage("two");
		f.pi.sendUserMessage("three");
		await settled(f.session);
		expect(f.errors).toEqual([]);
		expect(shape(f.session).filter((s) => s.startsWith("user:"))).toEqual(["user:one", "user:two", "user:three"]);
		f.session.dispose();
	});
});

describe("prompt-start-race: kept behaviour", () => {
	it("an idle single prompt runs once and ends idle", async () => {
		const f = await fixture(true);
		await f.session.prompt("hello");
		await settled(f.session);
		expect(f.requests).toEqual(["hello"]);
		expect(f.session.isStreaming).toBe(false);
		f.session.dispose();
	});

	it("a UI prompt while streaming still steers or follows up as asked", async () => {
		for (const behavior of ["steer", "followUp"] as const) {
			const f = await fixture(true);
			const run = f.session.prompt(`go ${TOOL_WORD}`);
			await f.toolStarted;
			const dispositions: string[] = [];
			await f.session.prompt("aside", {
				streamingBehavior: behavior,
				preflightResult: (d) => dispositions.push(d),
			});
			f.release();
			await run;
			await settled(f.session);
			expect(dispositions).toEqual(["queued"]);
			const s = shape(f.session);
			if (behavior === "steer") {
				// A steer lands right after the tool result, before the model's next reply.
				expect(s).toEqual([`user:go ${TOOL_WORD}`, "assistant:toolUse", "toolResult", "user:aside", "assistant"]);
			} else {
				expect(s).toEqual([
					`user:go ${TOOL_WORD}`,
					"assistant:toolUse",
					"toolResult",
					"assistant",
					"user:aside",
					"assistant",
				]);
			}
			f.session.dispose();
		}
	});

	it("an extension send without deliverAs during a run becomes a follow-up instead of failing", async () => {
		const f = await fixture(true);
		const run = f.session.prompt(`go ${TOOL_WORD}`);
		await f.toolStarted;
		f.pi.sendUserMessage("later");
		await tick();
		expect(f.session.isStreaming).toBe(true);
		f.release();
		await run;
		await settled(f.session);
		expect(f.errors).toEqual([]);
		expect(shape(f.session).filter((s) => s.startsWith("user:"))).toEqual([`user:go ${TOOL_WORD}`, "user:later"]);
		f.session.dispose();
	});

	it("Stop mid-run keeps the flag until the run really ends", async () => {
		const f = await fixture(true);
		const run = f.session.prompt(`go ${TOOL_WORD}`);
		await f.toolStarted;
		const aborting = f.session.abort();
		expect(f.session.isStreaming).toBe(true);
		await aborting;
		await run.catch(() => undefined);
		await settled(f.session);
		expect(f.session.isStreaming).toBe(false);
		// The chat takes a new prompt afterwards.
		await f.session.prompt("again");
		await settled(f.session);
		expect(f.requests.at(-1)).toBe("again");
		f.session.dispose();
	});

	it("a nextTurn aside rides along with the next prompt", async () => {
		const f = await fixture(true);
		f.pi.sendMessage({ customType: "aside", content: "context", display: false }, { deliverAs: "nextTurn" });
		await f.session.prompt("hello");
		await settled(f.session);
		expect(shape(f.session)).toEqual(["user:hello", "custom:aside", "assistant"]);
		f.session.dispose();
	});

	it("installing twice is harmless", async () => {
		const f = await fixture(true);
		installPromptStartGuard(f.session);
		f.pi.sendUserMessage("one");
		f.pi.sendUserMessage("two");
		await settled(f.session);
		expect(f.errors).toEqual([]);
		expect(shape(f.session).filter((s) => s.startsWith("user:"))).toEqual(["user:one", "user:two"]);
		f.session.dispose();
	});
});
