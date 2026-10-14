// H-MAIL-2: fixed fake host/clock and local SDK hooks only. No provider/model call.
// On the unchanged base, -t 'interrupted' fails; ROLE_MAIL_RESTART_OLD=1 proves why.
import { Agent, type AgentMessage, type AgentTurnContext } from "@earendil-works/pi-agent-core";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentService, ClientSession } from "../../server/agent-service.js";
import type { IdentityDef } from "../../server/identities.js";
import { installRoleMailBoundary } from "../../server/role-mail-boundary.js";
import { RoleMessages, roleMessageIdOf, type RoleMessageHost } from "../../server/role-messages.js";

const dirs: string[] = [];
const services: RoleMessages[] = [];
afterEach(() => {
	for (const service of services.splice(0)) service.stop();
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const idOf = (message: AgentMessage): string | undefined => {
	if (message.role !== "user" && message.role !== "custom") return undefined;
	const content = message.content;
	return roleMessageIdOf(
		typeof content === "string"
			? content
			: content
					.filter((part) => part.type === "text")
					.map((part) => part.text)
					.join("\n"),
	);
};
const user = (text: string): AgentMessage => ({ role: "user", content: [{ type: "text", text }], timestamp: 0 });
const turnMessage = (tool = false): AgentTurnContext["message"] => ({
	role: "assistant",
	content: tool ? [{ type: "toolCall", id: "fixed", name: "fixed", arguments: {} }] : [],
	api: "fixture",
	provider: "fixture",
	model: "fixture",
	timestamp: 0,
	stopReason: tool ? "toolUse" : "stop",
	usage: {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	},
});
const queueEntry = (file: string, data: object) =>
	appendFileSync(file, `${JSON.stringify({ type: "custom", customType: "queue", data: { v: 1, ts: 0, ...data } })}\n`);

function fixture(kinds: Array<"question" | "request" | "fyi"> = []) {
	const dir = mkdtempSync(join(tmpdir(), "role-mail-restart-stage-"));
	dirs.push(dir);
	const file = join(dir, "target.jsonl");
	const other = join(dir, "other.jsonl");
	const fromFile = join(dir, "sender.jsonl");
	const store = join(dir, "mail.json");
	for (const path of [file, other, fromFile])
		writeFileSync(path, `${JSON.stringify({ type: "session", version: 3, id: path, cwd: dir })}\n`);
	let now = Date.parse("2026-10-14T04:12:00-07:00");
	let phase = "startup";
	const landed: Array<{ id: string; at: number; phase: string; role: string }> = [];
	const listeners: Array<Parameters<AgentSession["subscribe"]>[0]> = [];
	const agent = new Agent({
		streamFn: () => {
			throw new Error("restart fixture must never call a model");
		},
	});
	const emit = async (message: AgentMessage) => {
		for (const listener of listeners) await listener({ type: "message_start", message });
		const id = idOf(message);
		if (id) landed.push({ id, at: now, phase, role: message.role });
		const row =
			message.role === "custom"
				? { type: "custom_message", customType: message.customType, content: message.content, display: true }
				: { type: "message", message };
		appendFileSync(file, `${JSON.stringify(row)}\n`);
		agent.state.messages = [...agent.state.messages, message];
	};
	// Native prompt lifecycle stand-in, not a streamFn mock or provider request.
	const nativePrompt = vi.fn(async (input: AgentMessage | AgentMessage[] | string) => {
		phase = "resume-input";
		for (const message of typeof input === "string" ? [user(input)] : Array.isArray(input) ? input : [input])
			await emit(message);
		Object.assign(agent.state, { isStreaming: true });
		phase = "carry-on-running";
	});
	agent.prompt = nativePrompt as Agent["prompt"];
	const session = {
		agent,
		get messages() {
			return agent.state.messages;
		},
		get isStreaming() {
			return agent.state.isStreaming;
		},
		subscribe: (listener: Parameters<AgentSession["subscribe"]>[0]) => {
			listeners.push(listener);
			return () => {};
		},
		followUp: vi.fn(async (text: string, _images: unknown, options: { source?: string }) => {
			expect(options.source).toBe("extension");
			agent.followUp(user(text));
		}),
		sendCustomMessage: vi.fn(async (note: Parameters<AgentSession["sendCustomMessage"]>[0]) => {
			await emit({ role: "custom", ...note, timestamp: now });
		}),
	} as unknown as AgentSession;
	installRoleMailBoundary(session);
	const conv = { session, listed: false, turnPending: undefined as unknown };
	let opened = false;
	const client = {
		carryOn: ClientSession.prototype.carryOn,
		noteRoleMessage: ClientSession.prototype.noteRoleMessage,
		queueRoleMailForResume: (
			ClientSession.prototype as unknown as {
				queueRoleMailForResume?: (file: string, text: string, how: object) => Promise<{ ok: boolean }>;
			}
		).queueRoleMailForResume,
		convs: new Map([["fixture", conv]]),
		activeId: "fixture",
		switchSession: vi.fn(async () => {
			if (!opened) now += 180_000; // fixed three-minute reopen, not another reopen for each note
			opened = true;
		}),
		conversationIdBySessionFile: (path: string) => (path === file ? "fixture" : undefined),
		promptResumedConversation: vi.fn(async (_path: string, note: string) => {
			await session.agent.prompt([user(note)]);
		}),
	};
	const normalDelivery = vi.fn(async (target: string, text: string) => {
		if (target === file) await session.followUp(text, undefined, { source: "extension" });
		else appendFileSync(target, `${JSON.stringify({ type: "message", message: user(text) })}\n`);
		return { ok: true as const };
	});
	const normalNote = vi.fn(async (target: string, text: string) => {
		if (target === file) await client.noteRoleMessage(target, text);
		else
			appendFileSync(
				target,
				`${JSON.stringify({ type: "custom_message", customType: "role-message", content: [{ type: "text", text }] })}\n`,
			);
		return { ok: true as const };
	});
	const host: RoleMessageHost = {
		roles: () => [
			{ id: "alpha", title: "Alpha", homeChat: fromFile } as IdentityDef,
			{ id: "beta", title: "Beta", homeChat: file } as IdentityDef,
			{ id: "gamma", title: "Gamma", homeChat: other } as IdentityDef,
		],
		chatState: (path) => (path === file ? "working" : "idle"),
		deliver: normalDelivery,
		note: normalNote,
		log: () => {},
	};
	const sender = { role: "alpha", title: "Alpha", file: fromFile, chat: "home chat", handling: 0 };
	const seed = new RoleMessages(store, host, () => now);
	const ids = kinds.map((kind) => {
		const sent = seed.send(sender, { to: "beta", kind, text: `fixed ${kind}` });
		if (!sent.ok) throw new Error(sent.error);
		now++;
		return sent.record.id;
	});
	seed.stop();
	const createService = () => {
		const mail = new RoleMessages(store, host, () => now);
		// Optional only for the unchanged-base negative control.
		(mail as RoleMessages & { deferUntilStart?: () => void }).deferUntilStart?.();
		services.push(mail);
		return mail;
	};
	let mail = createService();
	const owner = { answeredBy: ["alpha"], ownerIds: [], ownerChannel: "browser" as const };
	const startup = async (startDelivery = true) => {
		const service = {
			carryOnPlan: {
				reason: "fixed restart",
				carry: [{ chat: { sessionFile: file, title: "fixture" }, note: "fixed carry-on" }],
			},
			roleMessages: mail,
			roleMessageHow: () => ({ cause: "role", forOwner: owner }),
			attach: async () => client,
			detach: () => {},
			openCarryOnGate: () => {},
			startupNotices: [],
		};
		await AgentService.prototype.carryOnAfterRestart.call(service as unknown as AgentService);
		if (startDelivery) {
			mail.start();
			await mail.tick();
		}
	};
	const boundary = async () => {
		now += 20 * 60_000;
		phase = "carry-on-ended";
		Object.assign(agent.state, { isStreaming: false });
		const context: AgentTurnContext = {
			message: turnMessage(),
			toolResults: [],
			context: { messages: [], tools: [] },
			newMessages: [],
		};
		const decision = await agent.finishTurn!(context);
		if (decision?.action === "continue") {
			const update = await agent.prepareNextTurnWithContext!(context);
			for (const message of update?.messages ?? []) await emit(message);
		}
		await mail.tick();
	};
	return {
		file,
		other,
		fromFile,
		store,
		sender,
		ids,
		agent,
		session,
		conv,
		client,
		nativePrompt,
		landed,
		normalDelivery,
		normalNote,
		startup,
		boundary,
		get mail() {
			return mail;
		},
		get now() {
			return now;
		},
		advance: (ms: number) => {
			now += ms;
		},
		reload: () => {
			mail.stop();
			mail = createService();
			opened = false;
		},
	};
}

describe("H-MAIL-2 restart stages", () => {
	it.each([1, 2, 3])(
		"interrupted chat with %i waiting messages: batch reaches native resume before the run",
		async (count) => {
			const f = fixture((["question", "request", "fyi"] as const).slice(0, count));
			const up = f.now;
			await f.startup();
			const old = process.env.ROLE_MAIL_RESTART_OLD === "1";
			expect(f.landed.map((row) => row.id)).toEqual(old ? [] : f.ids);
			if (!old) {
				expect(f.landed.every((row) => row.phase === "resume-input" && row.at - up < 300_000)).toBe(true);
				expect(f.normalDelivery).not.toHaveBeenCalled();
				expect(f.conv.turnPending).toMatchObject({ causes: new Set(["role"]), forOwner: { ownerChannel: "browser" } });
			}
			await f.boundary();
			expect(f.landed.map((row) => row.id)).toEqual(f.ids);
			expect(f.landed.every((row) => row.phase === (old ? "carry-on-ended" : "resume-input"))).toBe(true);
			for (const id of f.ids) {
				expect(f.mail.byId(id)?.state).toBe("delivered");
				expect(readFileSync(f.file, "utf8").split(`[Role message ${id} `)).toHaveLength(2);
			}
		},
	);

	it("no waiting mail: carry-on prompt and behaviour are unchanged", async () => {
		const f = fixture();
		await f.startup();
		expect(f.nativePrompt).toHaveBeenCalledTimes(1);
		expect(f.client.promptResumedConversation).toHaveBeenCalledWith(f.file, "fixed carry-on");
		expect(f.session.messages).toHaveLength(1);
		expect(f.landed).toEqual([]);
		expect(f.conv.listed).toBe(true);
	});

	it("mail for a chat not resumed stays on the normal delivery path", async () => {
		const f = fixture();
		const sent = f.mail.send(f.sender, { to: "gamma", kind: "question", text: "fixed other" });
		if (!sent.ok) throw new Error(sent.error);
		await f.startup();
		expect(f.normalDelivery).toHaveBeenCalledTimes(1);
		expect(f.normalDelivery.mock.calls[0]?.[0]).toBe(f.other);
		expect(f.landed).toEqual([]);
	});

	it("Owner-held messages remain held, even past a day and across restart", async () => {
		const f = fixture(["question", "request", "fyi"]);
		f.mail.setPaused(true);
		f.reload();
		f.advance(30 * 60 * 60_000);
		await f.startup();
		expect(f.landed).toEqual([]);
		expect(f.ids.map((id) => f.mail.byId(id)?.sends)).toEqual([0, 0, 0]);
		expect(f.ids.map((id) => f.mail.byId(id)?.state)).toEqual(["waiting", "waiting", "waiting"]);
	});

	it("paused task is not carried on; its waiting mail still goes in as a no-turn note", async () => {
		const f = fixture(["request"]);
		queueEntry(f.file, {
			op: "assigned",
			id: 7,
			plan: { title: "fixed task" },
			from: { file: f.other, title: "queue" },
		});
		queueEntry(f.other, { op: "add", id: 7, plan: { title: "fixed task" } });
		queueEntry(f.other, { op: "run" });
		queueEntry(f.other, { op: "start", id: 7, lane: true });
		queueEntry(f.other, { op: "chat", id: 7, file: f.file, title: "Queue #7" });
		queueEntry(f.other, { op: "hold", id: 7, why: "fixed Owner hold", by: "panel" });
		await f.startup();
		expect(f.client.promptResumedConversation).not.toHaveBeenCalled();
		expect(f.normalDelivery).not.toHaveBeenCalled();
		expect(f.normalNote).toHaveBeenCalledTimes(1);
		expect(f.landed).toMatchObject([{ id: f.ids[0], role: "custom" }]);
		expect(f.agent.state.isStreaming).toBe(false);
	});

	it("give-up remains 24 hours: stale mail fails, not injected into resume", async () => {
		const f = fixture(["question"]);
		f.advance(25 * 60 * 60_000);
		await f.startup();
		expect(f.landed).toEqual([]);
		expect(f.mail.byId(f.ids[0])?.state).toBe("failed");
		expect(f.mail.byId(f.ids[0])?.sends).toBe(0);
	});

	it("second restart after commit but before acknowledgement does not repeat any id", async () => {
		const f = fixture(["question", "request", "fyi"]);
		await f.startup(false);
		expect(f.ids.map((id) => f.mail.byId(id)?.state)).toEqual(["waiting", "waiting", "waiting"]);
		expect(f.landed.map((row) => row.id)).toEqual(f.ids);
		Object.assign(f.agent.state, { isStreaming: false });
		f.reload();
		await f.startup();
		expect(f.landed.map((row) => row.id)).toEqual(f.ids);
		await f.boundary();
		for (const id of f.ids) expect(readFileSync(f.file, "utf8").split(`[Role message ${id} `)).toHaveLength(2);
	});

	it("once a run starts, new mail stays buffered until it ends, never between tool calls", async () => {
		const f = fixture(["request"]);
		await f.startup();
		const sent = f.mail.send(f.sender, { to: "beta", kind: "question", text: "fixed later" });
		if (!sent.ok) throw new Error(sent.error);
		f.advance(3_000);
		await f.mail.tick();
		expect(f.landed.map((row) => row.id)).toEqual(f.ids);
		const tool: AgentTurnContext = {
			message: turnMessage(true),
			toolResults: [],
			context: { messages: [], tools: [] },
			newMessages: [],
		};
		expect(await f.agent.finishTurn!(tool)).toBeUndefined();
		expect(f.landed.map((row) => row.id)).toEqual(f.ids);
		await f.boundary();
		expect(f.landed.map((row) => row.id)).toEqual([...f.ids, sent.record.id]);
		expect(f.landed.at(-1)?.phase).toBe("carry-on-ended");
	});

	it("send and kick while startup is reopening cannot race its ordered handoff", async () => {
		const f = fixture(["question"]);
		const sent = f.mail.send(f.sender, { to: "beta", kind: "request", text: "fixed startup arrival" });
		if (!sent.ok) throw new Error(sent.error);
		await f.mail.tick();
		expect(f.normalDelivery).not.toHaveBeenCalled();
		expect(f.landed).toEqual([]);
		await f.startup();
		expect(f.landed.map((row) => row.id)).toEqual([...f.ids, sent.record.id]);
		expect(f.landed.every((row) => row.phase === "resume-input")).toBe(true);
	});

	it("an already-running runtime is never given a startup batch", async () => {
		const f = fixture(["question", "request", "fyi"]);
		Object.assign(f.agent.state, { isStreaming: true });
		await f.startup();
		expect(f.landed).toEqual([]);
		await f.boundary();
		expect(f.landed.map((row) => row.id)).toEqual(f.ids);
		expect(f.landed.every((row) => row.phase === "carry-on-ended")).toBe(true);
	});

	it("failed startup admission restores the ordinary native prompt", async () => {
		const f = fixture();
		const fail = async () => {
			throw new Error("fixed admission failure");
		};
		await expect(f.client.carryOn(f.file, "fixed carry-on", fail)).rejects.toThrow("fixed admission failure");
		expect(f.agent.prompt).toBe(f.nativePrompt);
		expect(f.nativePrompt).not.toHaveBeenCalled();
	});
});
