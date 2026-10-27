import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	AgentService,
	ClientSession,
	DurablePromptAdmissionCoordinator,
	isDurableEngineEnabled,
} from "../../server/agent-service.js";
import { createInMemoryDurableSessionPort } from "../../server/durable-session-port.js";
import type { ServerMessage, SessionSummary } from "../../server/protocol.js";

function latestSessions(sent: ServerMessage[]): SessionSummary[] {
	const msg = [...sent].reverse().find((m) => m.type === "sessions");
	return msg?.type === "sessions" ? msg.sessions : [];
}

function collectConversationMessages(sent: ServerMessage[]) {
	let msgs: Array<{ id?: string; role: string }> = [];
	for (const m of sent) {
		if (m.type === "snapshot" && Array.isArray(m.state?.messages)) {
			msgs = [...m.state.messages];
		} else if (m.type === "snapshot_delta" && Array.isArray(m.appended)) {
			msgs.push(...m.appended);
		}
	}
	return msgs;
}

function findJsonlFiles(dir: string): string[] {
	if (!existsSync(dir)) return [];
	const results: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) {
			results.push(...findJsonlFiles(full));
		} else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
			results.push(full);
		}
	}
	return results;
}

describe("agent-service DurableSessionPort wiring (Wave 3.4 #604)", () => {
	let tempRoot: string;
	let projectDir: string;
	let agentDir: string;
	let prevHome: string | undefined;
	let prevDurableEnv: string | undefined;

	beforeEach(() => {
		tempRoot = mkdtempSync(join(tmpdir(), "pi-w3-service-durable-"));
		projectDir = join(tempRoot, "project");
		agentDir = join(tempRoot, ".pi", "agent");
		mkdirSync(projectDir, { recursive: true });
		mkdirSync(agentDir, { recursive: true });
		prevHome = process.env.HOME;
		prevDurableEnv = process.env.PI_DURABLE_ENGINE;
		process.env.HOME = tempRoot;
		delete process.env.PI_DURABLE_ENGINE;
	});

	afterEach(() => {
		ClientSession.setDurableSessionPort(null);
		if (prevHome === undefined) delete process.env.HOME;
		else process.env.HOME = prevHome;
		if (prevDurableEnv === undefined) delete process.env.PI_DURABLE_ENGINE;
		else process.env.PI_DURABLE_ENGINE = prevDurableEnv;
		try {
			rmSync(tempRoot, { recursive: true, force: true });
		} catch {
			// ignore cleanup race
		}
	});

	it("boots cleanly in a fresh zero-JSONL environment and routes lifecycle operations through DurableSessionPort", async () => {
		const port = createInMemoryDurableSessionPort({
			defaultCwd: projectDir,
			dbDir: join(tempRoot, "durable-db"),
		});
		const svc = new AgentService(projectDir, join(tempRoot, "client-state.json"), { durablePort: port });
		const sent: ServerMessage[] = [];
		const cs = await svc.attach("client-1", (msg) => sent.push(msg));

		try {
			expect(svc.activeDurablePort()).toBe(port);
			expect(cs.activeDurablePort()).toBe(port);
			expect(findJsonlFiles(tempRoot)).toEqual([]);

			await cs.refreshSessions();
			const sessionsBefore = latestSessions(sent);
			expect(sessionsBefore.length).toBe(1);
			expect(sessionsBefore[0].path.startsWith("durable://")).toBe(true);

			// Switch model & thinking level over DurableSessionPort
			await cs.setModel("openai/gpt-5");
			cs.setThinking("high");

			const activeSummary = (await port.list({ cwd: projectDir }))[0];
			expect(activeSummary.model).toMatchObject({ provider: "openai", id: "gpt-5" });
			expect(activeSummary.thinkingLevel).toBe("high");

			// Dispatch prompt, steer, followUp, abort, and appendCustomEntry
			await cs.prompt("hello durable world", undefined, false, "msg-1");
			expect(sent.some((m) => m.type === "prompt_ack" && m.id === "msg-1" && m.ok)).toBe(true);

			const rendered = collectConversationMessages(sent);
			expect(rendered.some((m) => m.role === "user")).toBe(true);
			expect(rendered.some((m) => m.role === "assistant")).toBe(true);

			// Create second chat, fork, rename, and delete over DurableSessionPort
			await cs.newChat();
			await cs.refreshSessions();
			const afterNewChat = latestSessions(sent);
			expect(afterNewChat.length).toBe(2);

			await cs.renameSession(sessionsBefore[0].path, "Renamed Durable Session");
			await cs.refreshSessions();
			const renamedList = latestSessions(sent);
			expect(renamedList.find((s) => s.path === sessionsBefore[0].path)?.name).toBe("Renamed Durable Session");

			await cs.switchSession(sessionsBefore[0].path);
			const switchedMsgs = collectConversationMessages(sent);
			const firstMsgId = switchedMsgs[0]?.id;
			expect(firstMsgId).toBeTruthy();
			if (firstMsgId) {
				await cs.forkSession(firstMsgId);
				await cs.refreshSessions();
				const afterFork = latestSessions(sent);
				expect(afterFork.length).toBeGreaterThanOrEqual(2);
			}

			const toDelete = afterNewChat.find((s) => s.path !== sessionsBefore[0].path)!;
			await cs.deleteSession(toDelete.path);
			await cs.refreshSessions();
			const afterDelete = latestSessions(sent);
			expect(afterDelete.some((s) => s.path === toDelete.path)).toBe(false);

			// Still zero .jsonl files created on disk
			expect(findJsonlFiles(tempRoot)).toEqual([]);
		} finally {
			await svc.disposeAll();
		}
	});

	it("supports multi-tab WebSocket streaming and Wave 2 PendingRecoveryCoordinator idempotent prompt admission", async () => {
		const port = createInMemoryDurableSessionPort({
			defaultCwd: projectDir,
			dbDir: join(tempRoot, "durable-db"),
		});
		const coordinator = new DurablePromptAdmissionCoordinator();
		const svc = new AgentService(projectDir, join(tempRoot, "client-state.json"), {
			durablePort: port,
			pendingRecoveryCoordinator: coordinator,
		});
		const tab1Messages: ServerMessage[] = [];
		const tab2Messages: ServerMessage[] = [];
		const tab1 = await svc.attach("tab-1", (msg) => tab1Messages.push(msg));
		const tab2 = await svc.attach("tab-2", (msg) => tab2Messages.push(msg));

		try {
			await tab1.refreshSessions();
			const firstSessionPath = latestSessions(tab1Messages)[0].path;
			await tab2.switchSession(firstSessionPath);

			await tab1.prompt("shared multi-tab turn", undefined, false, "idem-key-1");

			// Both tabs receive live streaming updates for the shared durable session
			const tab1Rendered = collectConversationMessages(tab1Messages);
			const tab2Rendered = collectConversationMessages(tab2Messages);
			expect(tab1Rendered.some((m) => m.role === "assistant")).toBe(true);
			expect(tab2Rendered.some((m) => m.role === "assistant")).toBe(true);

			// Duplicate idempotencyKey is deduplicated by Wave 2 PendingRecoveryCoordinator
			const activeSummary = (await port.list({ cwd: projectDir }))[0];
			const msgsBeforeDup = (await port.getMessages(activeSummary.sessionKey)).length;
			await tab1.prompt("shared multi-tab turn", undefined, false, "idem-key-1");
			const msgsAfterDup = (await port.getMessages(activeSummary.sessionKey)).length;
			expect(msgsAfterDup).toBe(msgsBeforeDup);

			const recovered = coordinator.recoverOnReconnect(activeSummary.sessionId);
			expect(recovered.recoveredCount).toBe(0);
		} finally {
			await svc.disposeAll();
		}
	});

	it("resolves role homeChat and delivers role messages in a zero-JSONL durable environment", async () => {
		const identitiesDir = join(agentDir, "memory", "identities", "ops");
		mkdirSync(identitiesDir, { recursive: true });
		writeFileSync(
			join(identitiesDir, "identity.json"),
			JSON.stringify({
				id: "ops",
				title: "ops/tooling",
				folder: projectDir,
				homeChat: null,
				pastHomeChats: [],
			}),
			"utf8",
		);

		const port = createInMemoryDurableSessionPort({
			defaultCwd: projectDir,
			dbDir: join(tempRoot, "durable-db"),
		});
		const svc = new AgentService(projectDir, join(tempRoot, "client-state.json"), { durablePort: port });
		const sent: ServerMessage[] = [];
		const cs = await svc.attach("ops-client", (msg) => sent.push(msg));

		try {
			await cs.refreshSessions();
			const homeSessionPath = latestSessions(sent)[0].path;
			await cs.setChatIdentity(undefined, homeSessionPath, "ops");

			const resolved = await svc.resolveRoleHomeChat("ops");
			expect(resolved.ok).toBe(true);
			if (resolved.ok) {
				expect(resolved.file.startsWith("durable://")).toBe(true);
			}

			const delivery = await svc.sendToRole("ops", "check durable status");
			expect(delivery.ok).toBe(true);

			const activeSummary = (await port.list({ cwd: projectDir }))[0];
			const stored = await port.getMessages(activeSummary.sessionKey);
			expect(stored.some((m) => m.role === "user")).toBe(true);
			expect(findJsonlFiles(tempRoot)).toEqual([]);
		} finally {
			await svc.disposeAll();
		}
	});

	it("instantly disables DurableSessionPort routing when PI_DURABLE_ENGINE=0 rollback switch is set", async () => {
		const port = createInMemoryDurableSessionPort({
			defaultCwd: projectDir,
			dbDir: join(tempRoot, "durable-db"),
		});

		expect(isDurableEngineEnabled({})).toBe(true);
		expect(isDurableEngineEnabled({ PI_DURABLE_ENGINE: "1" })).toBe(true);
		expect(isDurableEngineEnabled({ PI_DURABLE_ENGINE: "0" })).toBe(false);
		expect(isDurableEngineEnabled({ PI_DURABLE_ENGINE: "false" })).toBe(false);
		expect(isDurableEngineEnabled({ PI_DURABLE_ENGINE: "off" })).toBe(false);

		ClientSession.setDurableSessionPort(port);
		process.env.PI_DURABLE_ENGINE = "0";
		expect(ClientSession.getDurableSessionPort()).toBeNull();

		const svc = new AgentService(projectDir, join(tempRoot, "client-state.json"), { durablePort: port });
		expect(svc.activeDurablePort()).toBeNull();

		delete process.env.PI_DURABLE_ENGINE;
		expect(svc.activeDurablePort()).toBe(port);
		await svc.disposeAll();
	});

	it("paginates older messages (loadOlder) and routes steer/followUp/abort/appendCustomEntry on migrated and clean durable sessions", async () => {
		const seedMessages = Array.from({ length: 120 }, (_, i) => ({
			id: `seed-msg-${i + 1}`,
			role: i % 2 === 0 ? ("user" as const) : ("assistant" as const),
			content: `Seed message #${i + 1}`,
			timestamp: 1_700_000_000_000 + i * 1000,
		}));
		const port = createInMemoryDurableSessionPort({
			defaultCwd: projectDir,
			dbDir: join(tempRoot, "durable-db"),
			migratedSeeds: [
				{
					sessionId: "migrated-session-1",
					cwd: projectDir,
					sourceSessionFile: join(tempRoot, "migrated-1.jsonl"),
					name: "Migrated Chat",
					messages: seedMessages,
				},
			],
		});
		const migrated = (await port.list({ cwd: projectDir }))[0]!;

		const svc = new AgentService(projectDir, join(tempRoot, "client-state.json"), { durablePort: port });
		const sent: ServerMessage[] = [];
		const cs = await svc.attach("migrated-client", (msg) => sent.push(msg));

		try {
			await cs.switchSession(migrated.sourceSessionFile!);
			const snap = [...sent].reverse().find((m) => m.type === "snapshot");
			expect(snap?.type).toBe("snapshot");
			if (snap?.type === "snapshot") {
				const start = snap.state.messagesStart ?? 0;
				expect(start).toBeGreaterThan(0);
				cs.loadOlder(start);
				const olderPage = [...sent].reverse().find((m) => m.type === "older_messages");
				expect(olderPage?.type).toBe("older_messages");
				if (olderPage?.type === "older_messages") {
					expect(olderPage.messages.length).toBeGreaterThan(0);
					expect(olderPage.start).toBe(0);
				}
			}

			await port.steer("steer-note", { sessionKey: migrated.sessionKey });
			await port.followUp("followup-note", { sessionKey: migrated.sessionKey });
			await port.appendCustomEntry(
				"custom_tag",
				{ tag: "verified" },
				{ sessionKey: migrated.sessionKey },
			);
			await cs.abort();

			const entries = port.getEntries(migrated.sessionKey);
			expect(entries.some((e) => e.customType === "custom_tag")).toBe(true);
		} finally {
			await svc.disposeAll();
		}
	});
});
