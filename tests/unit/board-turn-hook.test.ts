/**
 * board-turn-hook (Ops #857, pi 1.0.1 -> 1.5.2 acceptance): the "[Board]" note goes only on turns that start
 * with a prompt (typed, RPC, or an extension's sendUserMessage), as on pi 1.0.1.
 *
 * pi 1.2.0+ also fires before_agent_start for runs an extension starts with a custom message
 * (pi.sendMessage(..., { triggerTurn: true }), e.g. a queue report waking a lead chat). That event has
 * messageType "custom" and no prompt. The live hook (server/agent-service.ts, extension "pi-webui-board")
 * passes event.prompt on for every event, so such a turn would get a board note too.
 *
 * Seam for step 2: server/board-turn-hook.ts exports boardTurnHook(note), the before_agent_start handler
 * the "pi-webui-board" extension registers; note(prompt) is ClientSession.boardTurnNote for that chat.
 *
 * Real SDK session, faux model, inline extension: no real chat, no network.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import {
	type AgentSession,
	type BeforeAgentStartEvent,
	type BeforeAgentStartEventResult,
	createAgentSession,
	DefaultResourceLoader,
	type ExtensionAPI,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BOARD_CUSTOM_TYPE } from "../../server/role-board.js";
import { HANG_GUARD_MS } from "./load-independent.js";

type BoardTurnHook = (
	note: (prompt: string) => BeforeAgentStartEventResult | undefined,
) => (event: BeforeAgentStartEvent) => BeforeAgentStartEventResult | undefined;

/** The seam, or undefined while step 2 hasn't made it. */
async function loadHook(): Promise<BoardTurnHook | undefined> {
	try {
		return (await import("../../server/board-turn-hook.js")).boardTurnHook as BoardTurnHook;
	} catch {
		return undefined;
	}
}

let root: string;
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "board-turn-hook-"));
});
afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

const NOTE: BeforeAgentStartEventResult = {
	message: {
		customType: BOARD_CUSTOM_TYPE,
		content: [{ type: "text", text: "[Board] 1 new post" }],
		display: true,
		details: {},
	},
};

async function fixture(hook: BoardTurnHook) {
	const faux = fauxProvider({ provider: "faux-board", models: [{ id: "m" }] });
	const modelRuntime = await ModelRuntime.create({
		authPath: join(root, "auth.json"),
		modelsPath: null,
		refreshOnCreate: false,
	});
	modelRuntime.registerNativeProvider(faux.provider);
	faux.setResponses(Array.from({ length: 6 }, (_, i) => () => fauxAssistantMessage(`reply ${i + 1}`)));
	const asked: string[] = [];
	let pi!: ExtensionAPI;
	const settingsManager = SettingsManager.inMemory();
	const resourceLoader = new DefaultResourceLoader({
		cwd: root,
		agentDir: root,
		settingsManager,
		extensionFactories: [
			(api: ExtensionAPI) => {
				pi = api;
				api.on(
					"before_agent_start",
					hook((prompt) => {
						asked.push(prompt);
						return NOTE;
					}),
				);
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
		resourceLoader,
		sessionManager: SessionManager.inMemory(root),
		settingsManager,
	});
	const errors: string[] = [];
	await session.bindExtensions({ onError: (e) => errors.push(e.error) });
	return { session, pi, asked, errors };
}

/** Wait until the session has been idle for a while (or give up at the hang guard). */
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

/** Session entries in order: "user", "custom:<type>", "assistant". */
function shape(session: AgentSession): string[] {
	const out: string[] = [];
	for (const e of session.sessionManager.getEntries() as {
		type: string;
		customType?: string;
		message?: { role: string };
	}[]) {
		if (e.type === "custom_message") out.push(`custom:${e.customType}`);
		else if (e.type === "message" && e.message && e.message.role !== "system") out.push(e.message.role);
	}
	return out;
}

describe("board-turn-hook (Ops #857)", () => {
	it("canary: pi fires before_agent_start for a custom-message run, as messageType custom with no prompt", async () => {
		const seen: { messageType: string; prompt?: string }[] = [];
		const f = await fixture(() => (event) => {
			seen.push({ messageType: event.messageType, prompt: (event as { prompt?: string }).prompt });
			return undefined;
		});
		await f.session.prompt("hello");
		await settled(f.session);
		f.pi.sendMessage(
			{ customType: "queue-report", content: "task #12 finished", display: true },
			{ triggerTurn: true },
		);
		await settled(f.session);
		expect(seen).toEqual([
			{ messageType: "user", prompt: "hello" },
			{ messageType: "custom", prompt: undefined },
		]);
		f.session.dispose();
	});

	it("a turn an extension starts with a custom message gets no board note; a prompt's turn still does", async () => {
		const hook = await loadHook();
		expect(
			hook,
			"server/board-turn-hook.ts exports boardTurnHook (the board hook that skips non-user turns)",
		).toBeTypeOf("function");
		const f = await fixture(hook!);
		await f.session.prompt("hello");
		await settled(f.session);
		expect(f.asked).toEqual(["hello"]);
		expect(shape(f.session)).toEqual(["user", `custom:${BOARD_CUSTOM_TYPE}`, "assistant"]);

		// A run started by a custom message: pi 1.5.2 fires before_agent_start with messageType "custom".
		f.pi.sendMessage(
			{ customType: "queue-report", content: "task #12 finished", display: true },
			{ triggerTurn: true },
		);
		await settled(f.session);
		expect(f.errors).toEqual([]);
		expect(f.asked, "the note is not even asked for on a custom-message turn").toEqual(["hello"]);
		expect(shape(f.session)).toEqual([
			"user",
			`custom:${BOARD_CUSTOM_TYPE}`,
			"assistant",
			"custom:queue-report",
			"assistant",
		]);
		f.session.dispose();

		// The live chats' board extension uses that hook.
		const source = readFileSync(new URL("../../server/agent-service.ts", import.meta.url), "utf8");
		const board = source.slice(source.indexOf('name: "pi-webui-board"'));
		expect(board.slice(0, board.indexOf("},\n")), "pi-webui-board registers boardTurnHook").toContain(
			'pi.on("before_agent_start", boardTurnHook(',
		);
	});
});
