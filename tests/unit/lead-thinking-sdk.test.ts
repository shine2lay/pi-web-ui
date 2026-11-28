import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createAgentSession,
	DefaultResourceLoader,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { fauxProvider } from "@earendil-works/pi-ai";
import { expect, it, vi } from "vitest";
import { configureLeadThinking, leadThinkingControl } from "../../server/lead-thinking.js";

it("lead-thinking updates real SDK public state without appending history or writing shared settings", async () => {
	const root = mkdtempSync(join(tmpdir(), "lead-thinking-sdk-"));
	let dispose: (() => void) | undefined;
	try {
		const settingsPath = join(root, "settings.json");
		writeFileSync(settingsPath, JSON.stringify({ defaultThinkingLevel: "medium", theme: "dark" }));
		let settingsWrites = 0;
		const settingsManager = SettingsManager.fromStorage({
			withLock(scope, fn) {
				const next = fn(scope === "global" ? readFileSync(settingsPath, "utf8") : undefined);
				if (next !== undefined) {
					settingsWrites++;
					if (scope === "global") writeFileSync(settingsPath, next);
				}
			},
		});
		const faux = fauxProvider({ provider: "lead-thinking-sdk", models: [{ id: "fixture", reasoning: true }] });
		const modelRuntime = await ModelRuntime.create({
			authPath: join(root, "auth.json"),
			modelsPath: null,
			refreshOnCreate: false,
		});
		modelRuntime.registerNativeProvider(faux.provider);
		const model = faux.getModel("fixture");
		if (!model) throw new Error("Fixture model unavailable");
		const resourceLoader = new DefaultResourceLoader({
			cwd: root,
			agentDir: root,
			settingsManager,
			noExtensions: true,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
		});
		await resourceLoader.reload();
		const manager = SessionManager.create(root, join(root, "sessions"));
		const { session } = await createAgentSession({
			cwd: root,
			agentDir: root,
			modelRuntime,
			model,
			thinkingLevel: "medium",
			tools: [],
			resourceLoader,
			sessionManager: manager,
			settingsManager,
		});
		dispose = () => session.dispose();
		await settingsManager.flush();
		const home = manager.getSessionFile();
		if (!home) throw new Error("SDK session has no canonical file identity");
		const changed = vi.fn();
		configureLeadThinking({
			file: join(root, "lead-thinking.json"),
			homes: () => [{ id: "coo", homeChat: home }],
			session: () => session,
			changed,
		});
		const nativeSetter = vi.spyOn(session, "setThinkingLevel");
		const modelSetter = vi.spyOn(session, "setModel");
		const prompt = vi.spyOn(session, "prompt");
		const appends = [
			vi.spyOn(manager, "appendThinkingLevelChange"),
			vi.spyOn(manager, "appendModelChange"),
			vi.spyOn(manager, "appendMessage"),
			vi.spyOn(manager, "appendCustomEntry"),
		];
		// Compare digests, never render transcript entries or model request content.
		const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
		const historyBefore = digest(manager.getEntries());
		const branchBefore = digest(manager.getBranch());
		const transcriptBytes = () =>
			existsSync(home) ? createHash("sha256").update(readFileSync(home)).digest("hex") : null;
		const transcriptBefore = transcriptBytes();
		const settingsBefore = readFileSync(settingsPath);
		const writesBefore = settingsWrites;
		const modelBefore = session.model;
		expect(session.thinkingLevel).toBe("medium");
		const result = leadThinkingControl({
			type: "lead_thinking_control",
			requestId: "sdk",
			action: "set",
			role: "coo",
			sessionId: session.sessionId,
			level: "high",
		});
		await settingsManager.flush();
		expect(result.ok).toBe(true);
		expect(result.effective).toBe("high");
		expect(session.thinkingLevel).toBe("high");
		expect(session.agent.state.thinkingLevel).toBe("high");
		expect(changed).toHaveBeenCalledExactlyOnceWith(session);
		expect(session.model).toBe(modelBefore);
		expect(nativeSetter).not.toHaveBeenCalled();
		expect(modelSetter).not.toHaveBeenCalled();
		expect(prompt).not.toHaveBeenCalled();
		for (const append of appends) expect(append).not.toHaveBeenCalled();
		expect(digest(manager.getEntries())).toBe(historyBefore);
		expect(digest(manager.getBranch())).toBe(branchBefore);
		expect(transcriptBytes()).toBe(transcriptBefore);
		expect(readFileSync(settingsPath).equals(settingsBefore)).toBe(true);
		expect(settingsWrites).toBe(writesBefore);
	} finally {
		dispose?.();
		vi.restoreAllMocks();
		rmSync(root, { recursive: true, force: true });
	}
});
