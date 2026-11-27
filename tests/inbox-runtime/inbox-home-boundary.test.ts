// Exercise SDK boundary decisions only; no model invocation or request-body inspection.
import { Agent, type AgentMessage, type AgentTurnContext } from "@earendil-works/pi-agent-core";
import { SessionManager, type AgentSession } from "@earendil-works/pi-coding-agent";
import { expect, it, vi } from "vitest";
import { InboxHomeHost } from "../../server/inbox-home-host.js";
import { installRoleMailBoundary } from "../../server/role-mail-boundary.js";
import { roleMessageText } from "../../server/role-messages.js";
import { B, useGuardWorld, who } from "../unit/role-message-guard-host-harness.js";
import { setup } from "./inbox-world.js";

useGuardWorld();
it("F1 third unanswered boundary settles; replay/restart never pumps a fourth turn; explicit action still replies", async () => {
	const h = await setup();
	const homes = () => [{ id: "beta", homeChat: B }];
	let host = new InboxHomeHost(h.runtime.ports, homes);
	await host.start();
	const provider = vi.fn(() => {
		throw new Error("No model calls in boundary tests");
	});
	const agent = new Agent({ streamFn: provider });
	const listeners: Array<Parameters<AgentSession["subscribe"]>[0]> = [];
	const sessionManager = SessionManager.inMemory();
	const session = {
		agent,
		sessionManager,
		subscribe: (listener: Parameters<AgentSession["subscribe"]>[0]) => {
			listeners.push(listener);
			return () => {};
		},
		sendCustomMessage: vi.fn(async () => {}),
	} as unknown as AgentSession;
	let dispatches = 0;
	installRoleMailBoundary(session, {
		select: (rows) => host.select(B, rows),
		landed: async (id, message) => {
			dispatches++;
			await host.landed(B, id, session, message);
		},
		ended: (outcome) => host.ended(B, outcome, session),
	});
	const started = (message: AgentMessage) => {
		listeners.forEach((listener) => listener({ type: "message_start", message }));
		listeners.forEach((listener) => listener({ type: "message_end", message }));
		sessionManager.appendMessage(message);
	};
	started({ role: "user", timestamp: 1, content: [{ type: "text", text: roleMessageText(h.w.rm.byId(h.id)!) }] });
	const turn = {
		message: { role: "assistant", content: [], stopReason: "stop" },
		toolResults: [],
		context: { messages: [], tools: [] },
		newMessages: [],
	} as AgentTurnContext;
	for (let n = 1; n <= 3; n++) {
		const decision = await agent.finishTurn!(turn);
		expect(decision?.action).toBe(n < 3 ? "continue" : undefined);
		if (n < 3) {
			const update = await agent.prepareNextTurnWithContext!(turn);
			for (const message of update?.messages ?? []) started(message);
		}
	}
	expect(dispatches).toBe(3);
	expect(provider).not.toHaveBeenCalled();
	await host.ended(B, "turn_completed", session); // repeated completion event
	host = new InboxHomeHost(h.runtime.ports, homes);
	await host.start();
	await host.start();
	expect((await agent.finishTurn!(turn))?.action).toBeUndefined();
	expect(dispatches).toBe(3);
	expect(host.runtime.audit("beta", "beta").filter((line) => line.op === "attempt")).toHaveLength(3);
	expect(host.runtime.alarm("beta", "beta").count).toBe(1);
	expect(session.sendCustomMessage).toHaveBeenCalledTimes(1);
	expect(
		await host.reply(
			who(h.w, "beta", B),
			{ kind: "reply", to: "alpha", replyTo: h.id, text: "Independent explicit answer" },
			"independent-action",
		),
	).toMatchObject({ ok: true });
	await host.ended(B, "turn_completed", session);
	expect(host.runtime.audit("beta", "beta").filter((line) => line.op === "attempt")).toHaveLength(4);
	expect(h.w.rm.rows(Infinity).filter((row) => row.replyTo === h.id)).toHaveLength(1);
	expect(host.runtime.alarm("beta", "beta").count).toBe(0);
});
