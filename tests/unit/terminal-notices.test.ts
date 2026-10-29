/**
 * terminal-notes (Ops #264, H-TERM-NOTE-1): pi-web-ui's two terminal notices ("a background command
 * finished", "a terminal has gone quiet") go to a busy chat as context notes (triggerTurn:false). They
 * never start a turn of their own and never land between a tool call and its result; the run's next
 * model call reads them, and a run that is ending leaves them in the chat for the next turn.
 *
 * Real SDK session, faux model. The real ClientSession.notifyTerminalBashDone / notifyTerminalIdle run
 * on Object.create(ClientSession.prototype) with only the fields they use (convs, disposed), as in
 * browser-page-tool.test.ts. No real chat, no network. What the faux model receives is checked here
 * as yes/no only and never printed (AGENTS rule 11).
 *
 * Each busy case runs with the prompt-start-race guard (as live) and without it (as after an SDK
 * upgrade drops the guard): the notes don't go through the prompt path, so both behave the same.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import {
	type AgentSession,
	createAgentSession,
	DefaultResourceLoader,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ClientSession } from "../../server/agent-service.js";
import { installPromptStartGuard } from "../../server/prompt-start-guard.js";
import { HANG_GUARD_MS } from "./load-independent.js";

let root: string;
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "terminal-notices-"));
});
afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

/** Words both notices carry (in the command and in the terminal's title), so a check can find them. */
const MARK = "fixture-mark-264";
/** Words that make the faux model call the slow tool once, on the first request carrying them. */
const TOOL_WORD = "use-the-tool";

type Notice = "terminal-bash-done" | "terminal-idle-reminder";

type Fixture = {
	session: AgentSession;
	/** One per model call, in order: did a user-side message in that call's context carry a notice? */
	sawNotice: boolean[];
	/** Runs at the start of model call n (1-based), while that reply is being made. */
	onCall: { fn?: (n: number) => void };
	toolStarted: Promise<void>;
	release: () => void;
	/** Sends the notice through the real ClientSession method; returns whether the chat was busy then. */
	notify: (kind: Notice) => boolean;
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

async function fixture(guard: boolean): Promise<Fixture> {
	const faux = fauxProvider({ provider: "faux-notes", models: [{ id: "m" }] });
	const modelRuntime = await ModelRuntime.create({
		authPath: join(root, "auth.json"),
		modelsPath: null,
		refreshOnCreate: false,
	});
	modelRuntime.registerNativeProvider(faux.provider);
	const sawNotice: boolean[] = [];
	const onCall: Fixture["onCall"] = {};
	let toolCalled = false;
	const reply = (context: { messages: { role: string; content?: unknown }[] }) => {
		sawNotice.push(context.messages.some((m) => m.role === "user" && textOf(m).includes(MARK)));
		onCall.fn?.(sawNotice.length);
		const lastMessage = context.messages.at(-1);
		if (!toolCalled && lastMessage?.role === "user" && textOf(lastMessage).includes(TOOL_WORD)) {
			toolCalled = true;
			return fauxAssistantMessage(fauxToolCall("slow_step", {}), { stopReason: "toolUse" });
		}
		return fauxAssistantMessage(`reply ${sawNotice.length}`);
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
	const settingsManager = SettingsManager.inMemory();
	const resourceLoader = new DefaultResourceLoader({
		cwd: root,
		agentDir: root,
		settingsManager,
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
	await session.bindExtensions({});
	if (guard) installPromptStartGuard(session);

	// The real notice methods, on a ClientSession that has only the fields they use.
	const terminals = { endCursor: () => 0, read: () => ({ data: "fixture output" }) };
	const host = Object.create(ClientSession.prototype) as Record<string, unknown>;
	host.disposed = false;
	// convs is a getter over the static map all clients share; this host gets its own map instead.
	Object.defineProperty(host, "convs", {
		value: new Map([["c1", { id: "c1", runtime: { session }, terminals }]]),
	});
	const methods = host as unknown as {
		notifyTerminalBashDone(t: unknown, info: { terminalId: string; command: string; exitCode: number | null }): void;
		notifyTerminalIdle(
			conversationId: string,
			terminalId: string,
			idleMs: number,
			title: string,
			lastLines?: string,
		): void;
	};
	const notify = (kind: Notice): boolean => {
		const busy = session.isStreaming;
		if (kind === "terminal-bash-done") {
			methods.notifyTerminalBashDone(terminals, { terminalId: "t1", command: `make ${MARK}`, exitCode: 0 });
		} else {
			methods.notifyTerminalIdle("c1", "t1", 15_000, `build ${MARK}`, "fixture output");
		}
		return busy;
	};
	return { session, sawNotice, onCall, toolStarted, release, notify };
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

/** Session entries in order: "user:<text>" ("user:notice" for a notice), "assistant:toolUse",
 *  "assistant", "toolResult", "custom:<type>" (the SDK's own "system" note is left out). */
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
			if (m.role === "user") out.push(textOf(m).includes(MARK) ? "user:notice" : `user:${textOf(m)}`);
			else if (m.role === "assistant") out.push(m.stopReason === "toolUse" ? "assistant:toolUse" : "assistant");
			else if (m.role !== "system") out.push(m.role);
		}
	}
	return out;
}

const NOTICES: Notice[] = ["terminal-bash-done", "terminal-idle-reminder"];

describe("terminal notices to a busy chat are context notes (H-TERM-NOTE-1)", () => {
	for (const kind of NOTICES) {
		for (const guard of [true, false]) {
			const how = `${kind}, ${guard ? "with" : "without"} the prompt-start guard`;

			it(`a) sent while a tool runs: written after that tool's result, read by the run's next model call, no turn of its own (${how})`, async () => {
				const f = await fixture(guard);
				const run = f.session.prompt(`go ${TOOL_WORD}`);
				await f.toolStarted;
				const busy = f.notify(kind);
				await tick();
				f.release();
				await run;
				await settled(f.session);
				expect(busy).toBe(true);
				// Two model calls (the tool call, the reply after its result); only the second carries the notice.
				expect(f.sawNotice).toEqual([false, true]);
				expect(shape(f.session)).toEqual([
					`user:go ${TOOL_WORD}`,
					"assistant:toolUse",
					"toolResult",
					`custom:${kind}`,
					"assistant",
				]);
				f.session.dispose();
			});

			it(`b) sent during the run's last reply: in the chat after the run, no extra model call, read by the next prompt (${how})`, async () => {
				const f = await fixture(guard);
				let busy = false;
				f.onCall.fn = (n) => {
					if (n === 1) busy = f.notify(kind);
				};
				await f.session.prompt("hello");
				await settled(f.session);
				expect(busy).toBe(true);
				expect(f.sawNotice).toEqual([false]);
				expect(shape(f.session)).toEqual(["user:hello", "assistant", `custom:${kind}`]);
				f.onCall.fn = undefined;
				await f.session.prompt("next");
				await settled(f.session);
				expect(f.sawNotice).toEqual([false, true]);
				f.session.dispose();
			});
		}
	}
});

describe("terminal notices to an idle chat (kept behaviour)", () => {
	it("c) bash-done is written as a note at once, with no turn; the next prompt reads it", async () => {
		const f = await fixture(true);
		await f.session.prompt("hello");
		await settled(f.session);
		const busy = f.notify("terminal-bash-done");
		await tick();
		await settled(f.session);
		expect(busy).toBe(false);
		expect(f.sawNotice).toEqual([false]);
		expect(shape(f.session)).toEqual(["user:hello", "assistant", "custom:terminal-bash-done"]);
		await f.session.prompt("next");
		await settled(f.session);
		expect(f.sawNotice).toEqual([false, true]);
		f.session.dispose();
	});

	it("c) the idle reminder sends nothing to an idle chat", async () => {
		const f = await fixture(true);
		await f.session.prompt("hello");
		await settled(f.session);
		const before = shape(f.session);
		const busy = f.notify("terminal-idle-reminder");
		await tick();
		await settled(f.session);
		expect(busy).toBe(false);
		expect(shape(f.session)).toEqual(before);
		expect(f.sawNotice).toEqual([false]);
		f.session.dispose();
	});
});
