// Real SDK mail hooks, never prompt()/stream/model invocation or payload output.
import { Agent, type AgentMessage, type AgentTurnContext } from "@earendil-works/pi-agent-core";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { expect, it } from "vitest";
import { installRoleMailBoundary, noteAtRoleMailBoundary } from "../../server/role-mail-boundary.js";
import { roleMessageIdOf } from "../../server/role-messages.js";
import { caseOf } from "./inbox-corpora.js";

function boundary() {
	const agent = new Agent({ streamFn: () => { throw new Error("No model calls"); } });
	Object.assign(agent.state, { isStreaming: true });
	const listeners: Array<Parameters<AgentSession["subscribe"]>[0]> = [];
	let notes = 0;
	const session = {
		agent,
		subscribe: (fn: Parameters<AgentSession["subscribe"]>[0]) => { listeners.push(fn); return () => {}; },
		sendCustomMessage: async () => { notes++; },
	};
	installRoleMailBoundary(session);
	const turn = { message: { role: "assistant", content: [], stopReason: "stop" }, toolResults: [], context: { messages: [], tools: [] }, newMessages: [] } as AgentTurnContext;
	const message = (id: string): AgentMessage => ({ role: "user", timestamp: 0, content: [{ type: "text", text: `[Role message ${id} from alpha (Alpha), sent from its home chat · request]\n\nfixture` }] });
	return {
		agent, session, notes: () => notes,
		add: (id: string) => agent.followUp(message(id)),
		passive: (id: string) => noteAtRoleMailBoundary(session, { customType: "role-message", content: [{ type: "text", text: `[Role message ${id} from alpha (Alpha), sent from its home chat · fyi]\n\nfixture` }], display: true }),
		async prepare() {
			const decision = await agent.finishTurn!(turn);
			if (decision?.action !== "continue") return [];
			return (await agent.prepareNextTurnWithContext!(turn))?.messages ?? [];
		},
		land(messages: AgentMessage[]) { for (const message of messages) for (const fn of listeners) fn({ type: "message_start", message }); },
	};
}
function ids(messages: AgentMessage[]) {
	return messages.map(m => {
		if (m.role !== "user" && m.role !== "custom") return undefined;
		const text = typeof m.content === "string" ? m.content : m.content.filter(c => c.type === "text").map(c => c.text).join("\n");
		return roleMessageIdOf(text);
	});
}
it("C-DSEL-1 real boundary hands off one actionable, never the current batch", async () => {
	const c = caseOf("delivery", "C-DSEL-1");
	const h = boundary();
	h.add("rm-00000001"); h.add("rm-00000002");
	const first = await h.prepare();
	expect(first.length).toBe(c.expect.actionable_count);
	h.land(first);
	expect(ids(await h.prepare())).toEqual(["rm-00000002"]);
});
it("C-DP3-2 real boundary limits passive packet to twenty and retains overflow", async () => {
	const c = caseOf("delivery", "C-DP3-2");
	const h = boundary(); h.add("rm-00000001");
	for (let i = 10; i < 33; i++) await h.passive(`rm-${String(i).padStart(8, "0")}`);
	const packet = await h.prepare();
	expect(packet.length - 1).toBe((c.expect.passive as string[]).length);
	h.land(packet); h.add("rm-00000002");
	expect((await h.prepare()).length - 1).toBe(c.expect.overflow);
});
it("U12 real boundary reattaches an unlanded packet after interrupted preparation", async () => {
	caseOf("delivery", "C-DP3-2");
	const h = boundary(); h.add("rm-00000001"); await h.passive("rm-00000010");
	const first = ids(await h.prepare());
	expect(first).toHaveLength(2);
	// No message_start: preparation was not a transport receipt.
	expect(ids(await h.prepare())).toEqual(first);
});
it("legacy no-helper ordinary follow-ups retain native SDK queue", async () => {
	const h = boundary();
	h.agent.followUp({ role: "user", timestamp: 0, content: [{ type: "text", text: "ordinary" }] });
	expect(h.agent.peekQueuedMessages()).toHaveLength(1);
	expect(await h.prepare()).toHaveLength(0);
});
it("C-DP3-1 legacy passive alone does not start a turn", async () => {
	caseOf("delivery", "C-DP3-1");
	const h = boundary(); await h.passive("rm-00000010");
	expect(await h.prepare()).toHaveLength(0);
	expect(h.notes()).toBe(1);
});
