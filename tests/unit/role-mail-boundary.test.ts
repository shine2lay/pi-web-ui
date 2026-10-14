// Local SDK boundary hooks only: no stream function/provider/model call or model-input inspection.
import { Agent, type AgentMessage, type AgentTurnContext } from "@earendil-works/pi-agent-core";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { AgentService, ClientSession } from "../../server/agent-service.js";
import { installRoleMailBoundary, noteAtRoleMailBoundary } from "../../server/role-mail-boundary.js";
import { roleMessageIdOf } from "../../server/role-messages.js";

const text = (id: string) =>
	`[Role message ${id} from alpha (Alpha), sent from its home chat · request]\n\nfixed fixture`;
const user = (id: string): AgentMessage => ({
	role: "user",
	content: [{ type: "text", text: text(id) }],
	timestamp: 0,
});
function idOf(message: AgentMessage): string | undefined {
	if (message.role !== "user" && message.role !== "custom") return undefined;
	const content = message.content;
	return roleMessageIdOf(
		typeof content === "string"
			? content
			: content
					.filter((c) => c.type === "text")
					.map((c) => c.text)
					.join("\n"),
	);
}
function harness(prior?: "end" | "continue") {
	const agent = new Agent({
		streamFn: () => {
			throw new Error("a boundary-hook fixture must never stream a model");
		},
	});
	Object.assign(agent.state, { isStreaming: true }); // simulated lifecycle, never a real run
	agent.finishTurn = () => (prior ? { action: prior } : undefined);
	const listeners: Array<Parameters<AgentSession["subscribe"]>[0]> = [];
	const notes: Parameters<AgentSession["sendCustomMessage"]>[0][] = [];
	const landed: Array<{ id?: string; role: string }> = [];
	const session = {
		agent,
		subscribe: (listener: Parameters<AgentSession["subscribe"]>[0]) => {
			listeners.push(listener);
			return () => {};
		},
		sendCustomMessage: vi.fn(
			async (
				note: Parameters<AgentSession["sendCustomMessage"]>[0],
				options?: Parameters<AgentSession["sendCustomMessage"]>[1],
			) => {
				expect(options?.triggerTurn).toBe(false);
				notes.push(note);
			},
		),
	};
	installRoleMailBoundary(session);
	const turn = (tool = false, stopReason = "stop"): AgentTurnContext => ({
		message: {
			role: "assistant",
			content: tool ? [{ type: "toolCall", id: "fixed-tool", name: "fixed", arguments: {} }] : [],
			stopReason,
		} as AgentTurnContext["message"],
		toolResults: [],
		context: { messages: [], tools: [] },
		newMessages: [],
	});
	const messageStart = (message: AgentMessage) => {
		for (const listener of listeners) listener({ type: "message_start", message });
		landed.push({ id: idOf(message), role: message.role });
	};
	const boundary = async (context = turn()) => {
		const decision = await agent.finishTurn!(context);
		// The SDK flushes non-turn custom notes at turn_end.
		for (const note of notes.splice(0)) messageStart({ role: "custom", ...note, timestamp: 0 });
		if (decision?.action === "continue") {
			const update = await agent.prepareNextTurnWithContext!(context);
			for (const message of update?.messages ?? []) messageStart(message);
		}
		return decision;
	};
	return { agent, session, landed, turn, boundary, messageStart };
}
const note = (id: string) => ({
	customType: "role-message",
	content: [{ type: "text" as const, text: text(id) }],
	display: true,
});

describe("role-mail-busy native host adapter", () => {
	it("working service/client admits three messages, then the first completed-run boundary lands them oldest-first exactly once", async () => {
		const h = harness();
		const file = import.meta.filename; // existence guard, not a real chat
		const conv = { session: h.session, listed: false };
		let sink: (message: unknown) => void = () => {};
		const prompt = vi.fn(
			async (_text: string, _images: unknown, queue: boolean, ackId: string, _how: Record<string, unknown>) => {
				expect(queue).toBe(true);
				h.agent.followUp({ role: "user", content: [{ type: "text", text: _text }], timestamp: 0 });
				sink({ type: "prompt_ack", id: ackId, ok: true });
			},
		);
		const cs = {
			switchSession: async () => {},
			conversationIdBySessionFile: () => "fixture",
			convs: new Map([["fixture", conv]]),
			activeId: "fixture",
			prompt,
			deliverRoleMessage: ClientSession.prototype.deliverRoleMessage,
			noteRoleMessage: ClientSession.prototype.noteRoleMessage,
		};
		const service = {
			roleMessagesChain: (f: () => Promise<unknown>) => f(),
			carryOnGate: undefined,
			quiesced: false,
			queueChatState: () => ({ state: "working" }),
			attach: async (_client: string, nextSink: typeof sink) => {
				sink = nextSink;
				return cs;
			},
			detach: () => {},
			pokeExternalRunning: () => {},
		} as unknown as {
			sendRoleMessage: (file: string, text: string, how?: object) => Promise<{ ok: boolean }>;
			noteRoleMessage: (file: string, text: string) => Promise<{ ok: boolean }>;
		};
		const send = (AgentService.prototype as unknown as typeof service).sendRoleMessage.bind(service);
		const sendNote = (AgentService.prototype as unknown as typeof service).noteRoleMessage.bind(service);
		const ids = ["rm-00000001", "rm-00000002", "rm-00000003"];
		const how = { cause: "role", forOwner: { role: "coo", channel: "telegram" }, ownerChannel: "telegram" };
		expect(await send(file, text(ids[0]), how)).toEqual({ ok: true });
		expect(await send(file, text(ids[1]))).toEqual({ ok: true });
		expect(await sendNote(file, text(ids[2]))).toEqual({ ok: true });
		expect(prompt.mock.calls[0]?.[4]).toMatchObject({
			source: "extension",
			cause: "role",
			forOwner: how.forOwner,
			ownerChannel: "telegram",
		});
		expect(h.landed).toEqual([]);
		// A tool continuation is not the end of the owner's running turn.
		await h.boundary(h.turn(true));
		expect(h.landed).toEqual([]);
		for (let boundary = 0; boundary < 5; boundary++) {
			await h.boundary();
			expect(h.landed.map((m) => m.id)).toEqual(ids);
		}
		expect(h.landed.map((m) => m.role)).toEqual(["user", "user", "custom"]);
		expect(h.agent.followUpMode).toBe("one-at-a-time");
	});

	it("FYIs and paused-task notes alone never continue a run; idle notes use the existing SDK path", async () => {
		const h = harness();
		await noteAtRoleMailBoundary(h.session, note("rm-00000011"));
		await noteAtRoleMailBoundary(h.session, { ...note("rm-00000012"), customType: "queue-paused" });
		expect(h.landed).toEqual([]);
		expect(await h.boundary()).toBeUndefined();
		expect(h.landed.map((m) => m.id)).toEqual(["rm-00000011", "rm-00000012"]);
		Object.assign(h.agent.state, { isStreaming: false });
		await noteAtRoleMailBoundary(h.session, note("rm-00000013"));
		expect(h.session.sendCustomMessage).toHaveBeenCalledTimes(3);
		const aborted = harness();
		await noteAtRoleMailBoundary(aborted.session, note("rm-00000014"));
		await aborted.boundary(aborted.turn(false, "aborted"));
		Object.assign(aborted.agent.state, { isStreaming: false });
		await noteAtRoleMailBoundary(aborted.session, note("rm-00000014"));
		await aborted.boundary();
		expect(aborted.landed.map((m) => m.id)).toEqual(["rm-00000014"]);
	});

	it("ordinary follow-ups retain their native queue and repeated installation is inert", async () => {
		const h = harness();
		const hook = h.agent.finishTurn;
		installRoleMailBoundary(h.session);
		expect(h.agent.finishTurn).toBe(hook);
		h.agent.followUp({ role: "user", content: [{ type: "text", text: "ordinary" }], timestamp: 0 });
		expect(h.agent.peekQueuedMessages()).toHaveLength(1);
		expect(await h.boundary()).toBeUndefined();
	});

	it("error/abort/end decisions are not overridden, an idle retry consumes its old copy, and clear cancels pending mail", async () => {
		const h = harness();
		h.agent.followUp(user("rm-00000021"));
		h.agent.followUp(user("rm-00000022"));
		await h.boundary(h.turn(false, "error"));
		await h.boundary(h.turn(false, "aborted"));
		expect(h.landed).toEqual([]);
		h.messageStart(user("rm-00000021")); // the service's native idle retry lands it
		await h.boundary();
		expect(h.landed.map((m) => m.id)).toEqual(["rm-00000021", "rm-00000022"]);
		h.agent.followUp(user("rm-00000023"));
		h.agent.clearFollowUpQueue();
		await h.boundary();
		expect(h.landed).toHaveLength(2);
		const ended = harness("end");
		ended.agent.followUp(user("rm-00000024"));
		expect(await ended.boundary()).toEqual({ action: "end" });
		expect(ended.landed).toEqual([]);
		const continued = harness("continue");
		expect(await continued.boundary()).toEqual({ action: "continue" });
	});
});
