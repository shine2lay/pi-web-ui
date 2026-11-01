/**
 * Owner-card freshness at the real SDK's admission boundary (Ops #686).
 * Hypothesis: cancellation before loadout preparation leaves no user entry or run and
 * restores the pending nextTurn note for exactly one later turn. A current card still runs.
 * Only fixed faux replies, lifecycle counts and session-manager entries are observed;
 * no provider request, hook arguments, system prompt or tool payload is inspected.
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
import { installPromptStartGuard, PROMPT_FRESHNESS, STALE_PROMPT_REASON } from "../../server/prompt-start-guard.js";

const NOTE_TYPE = "owner-question-freshness-note";
const NOTE_CONTENT = "Pending fixture note";
type FreshnessPromptOptions = NonNullable<Parameters<AgentSession["prompt"]>[1]> & {
	[PROMPT_FRESHNESS]: () => boolean;
};
type PreparationInternals = {
	_preparePromptAndToolLoadout: (...args: unknown[]) => unknown;
};

let root: string;
let disposeFixture: (() => void) | undefined;
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "owner-question-sdk-freshness-"));
	disposeFixture = undefined;
});
afterEach(() => {
	disposeFixture?.();
	rmSync(root, { recursive: true, force: true });
});

function gate() {
	let release!: () => void;
	const promise = new Promise<void>((resolve) => {
		release = resolve;
	});
	return { promise, release };
}

async function fixture() {
	const faux = fauxProvider({ provider: "faux-owner-question-freshness", models: [{ id: "m" }] });
	faux.setResponses([fauxAssistantMessage("Fixed fixture reply"), fauxAssistantMessage("Fixed fixture reply")]);
	const modelRuntime = await ModelRuntime.create({
		authPath: join(root, "auth.json"),
		modelsPath: null,
		refreshOnCreate: false,
	});
	modelRuntime.registerNativeProvider(faux.provider);
	const entered = gate();
	const released = gate();
	const counts = { starts: 0, preparations: 0, extensionErrors: 0 };
	const settingsManager = SettingsManager.inMemory({
		compaction: { enabled: false },
		retry: { enabled: false },
		cacheWarming: "off",
	});
	const resourceLoader = new DefaultResourceLoader({
		cwd: root,
		agentDir: root,
		settingsManager,
		extensionFactories: [
			(api: ExtensionAPI) => {
				api.on("before_agent_start", async () => {
					entered.release();
					await released.promise;
				});
				api.on("agent_start", () => {
					counts.starts++;
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
	disposeFixture = () => {
		released.release();
		session.dispose();
	};
	await session.bindExtensions({
		onError: () => {
			counts.extensionErrors++;
		},
	});
	const internal = session as unknown as PreparationInternals;
	const prepare = internal._preparePromptAndToolLoadout;
	// A count-only wrapper, not a mock that retains loadout arguments or return values.
	internal._preparePromptAndToolLoadout = (...args: unknown[]) => {
		counts.preparations++;
		return prepare.apply(session, args);
	};
	installPromptStartGuard(session);
	await session.sendCustomMessage(
		{ customType: NOTE_TYPE, content: NOTE_CONTENT, display: false },
		{ deliverAs: "nextTurn" },
	);
	return {
		session,
		counts,
		entered: entered.promise,
		release: released.release,
		responseCalls: () => faux.state.callCount,
	};
}

/** Inspect only application history, never model context; failures contain counts only. */
function sessionEntryCounts(session: AgentSession) {
	let users = 0;
	let notes = 0;
	let intactNotes = 0;
	for (const entry of session.sessionManager.getEntries()) {
		if (entry.type === "message" && entry.message.role === "user") users++;
		if (entry.type === "custom_message" && entry.customType === NOTE_TYPE) {
			notes++;
			if (entry.content === NOTE_CONTENT && entry.display === false) intactNotes++;
		}
	}
	return { users, notes, intactNotes };
}

/** Map unexpected errors to a boolean so assertion failures never dump payload values. */
function promptSucceeded(prompt: Promise<void>): Promise<boolean> {
	return prompt.then(
		() => true,
		() => false,
	);
}

describe("owner-question SDK freshness", () => {
	it("rejects a card invalidated during before_agent_start and preserves its nextTurn note exactly once", async () => {
		const f = await fixture();
		let current = true;
		const options: FreshnessPromptOptions = { source: "extension", [PROMPT_FRESHNESS]: () => current };
		const rejectedAsStale = f.session.prompt("Fixture owner card", options).then(
			() => false,
			(error: unknown) => error instanceof Error && error.message === STALE_PROMPT_REASON,
		);
		try {
			// Fail promptly if the prompt ends before the hook, rather than wait on an unreachable gate.
			expect(await Promise.race([f.entered.then(() => true), rejectedAsStale.then(() => false)])).toBe(true);
			expect(f.responseCalls()).toBe(0);
			expect(f.counts.preparations).toBe(0);
			expect(sessionEntryCounts(f.session)).toEqual({ users: 0, notes: 0, intactNotes: 0 });
			current = false;
			f.release();
			expect(await rejectedAsStale).toBe(true);
			expect(f.responseCalls()).toBe(0);
			expect(f.counts.starts).toBe(0);
			expect(f.counts.preparations).toBe(0);
			expect(f.session.isStreaming).toBe(false);
			expect(sessionEntryCounts(f.session)).toEqual({ users: 0, notes: 0, intactNotes: 0 });

			expect(await promptSucceeded(f.session.prompt("First normal fixture turn"))).toBe(true);
			expect(f.responseCalls()).toBe(1);
			expect(f.counts.starts).toBe(1);
			expect(f.counts.preparations).toBeGreaterThan(0);
			expect(sessionEntryCounts(f.session)).toEqual({ users: 1, notes: 1, intactNotes: 1 });

			expect(await promptSucceeded(f.session.prompt("Second normal fixture turn"))).toBe(true);
			expect(f.responseCalls()).toBe(2);
			expect(f.counts.starts).toBe(2);
			expect(sessionEntryCounts(f.session)).toEqual({ users: 2, notes: 1, intactNotes: 1 });
			expect(f.counts.extensionErrors).toBe(0);
			expect(f.session.isStreaming).toBe(false);
		} finally {
			f.release();
			await rejectedAsStale;
		}
	});

	it("admits a still-current card and consumes its nextTurn note only once", async () => {
		const f = await fixture();
		const current = true;
		const options: FreshnessPromptOptions = { source: "extension", [PROMPT_FRESHNESS]: () => current };
		const completed = promptSucceeded(f.session.prompt("Current fixture owner card", options));
		try {
			expect(await Promise.race([f.entered.then(() => true), completed.then(() => false)])).toBe(true);
			expect(f.responseCalls()).toBe(0);
			expect(f.counts.preparations).toBe(0);
			expect(sessionEntryCounts(f.session)).toEqual({ users: 0, notes: 0, intactNotes: 0 });
			f.release();
			expect(await completed).toBe(true);
			expect(f.responseCalls()).toBe(1);
			expect(f.counts.starts).toBe(1);
			expect(f.counts.preparations).toBeGreaterThan(0);
			expect(sessionEntryCounts(f.session)).toEqual({ users: 1, notes: 1, intactNotes: 1 });

			expect(await promptSucceeded(f.session.prompt("Later normal fixture turn"))).toBe(true);
			expect(f.responseCalls()).toBe(2);
			expect(f.counts.starts).toBe(2);
			expect(sessionEntryCounts(f.session)).toEqual({ users: 2, notes: 1, intactNotes: 1 });
			expect(f.counts.extensionErrors).toBe(0);
			expect(f.session.isStreaming).toBe(false);
		} finally {
			f.release();
			await completed;
		}
	});
});
