import { Agent, type AgentMessage } from "@earendil-works/pi-agent-core";
import { SessionManager, type AgentSession } from "@earendil-works/pi-coding-agent";
import { expect, it, vi } from "vitest";
import { InboxHomeHost } from "../../server/inbox-home-host.js";
import { markOwnerEntry } from "../../server/owner-input-mark.js";
import { roleMessageText } from "../../server/role-messages.js";
import { B, data, useGuardWorld } from "../unit/role-message-guard-host-harness.js";
import { setup } from "./inbox-world.js";

useGuardWorld();
async function fixture() {
	const h = await setup();
	const sm = SessionManager.create(data, data);
	const agent = new Agent({
		streamFn: vi.fn(() => {
			throw new Error("No provider allowed");
		}),
	});
	const session = { agent, sessionManager: sm, sendCustomMessage: vi.fn(async () => {}) } as unknown as AgentSession;
	const host = new InboxHomeHost(h.runtime.ports, () => [{ id: "beta", homeChat: B }]);
	await host.start();
	const message = (text: string): AgentMessage => ({ role: "user", timestamp: 1, content: [{ type: "text", text }] });
	const land = async (m: AgentMessage, owner = false) => {
		sm.appendMessage(m);
		if (owner)
			markOwnerEntry(sm, m, { text: (m.content as Array<{ text: string }>)[0].text, channel: "browser", at: 1 });
		await host.landed(B, h.id, session, m);
	};
	return { ...h, host, session, sm, message, land };
}
it("F1 native replay does not allocate a second lease, including host restart", async () => {
	const h = await fixture();
	const m = h.message(roleMessageText(h.w.rm.byId(h.id)!));
	await h.land(m);
	await h.host.ended(B, "turn_completed", h.session);
	await h.host.landed(B, h.id, h.session, m);
	const restarted = new InboxHomeHost(h.runtime.ports, () => [{ id: "beta", homeChat: B }]);
	await restarted.start();
	const reopened = SessionManager.open(h.sm.getSessionFile()!);
	const entry = reopened.getEntries().find((e) => e.type === "message");
	if (!entry || entry.type !== "message") throw new Error("Missing native entry");
	const reopenedSession = { ...h.session, sessionManager: reopened } as AgentSession;
	await restarted.landed(B, h.id, reopenedSession, entry.message);
	expect(restarted.runtime.audit("beta", "beta").filter((l) => l.op === "claim")).toHaveLength(1);
});
it("F1 missing provenance holds after three failures; distinct same-time owner IDs get fresh leases", async () => {
	const h = await fixture();
	for (let i = 0; i < 3; i++) {
		await h.host.landed(B, h.id);
		await h.host.ended(B, "turn_completed", h.session);
	}
	await h.host.landed(B, h.id);
	await h.land(h.message(roleMessageText(h.w.rm.byId(h.id)!)));
	expect(h.host.runtime.audit("beta", "beta").filter((l) => l.op === "claim")).toHaveLength(3);
	await h.land(h.message("Please answer now"), true);
	await h.host.ended(B, "turn_completed", h.session);
	await h.land(h.message("Please answer now"), true);
	const claims = h.host.runtime.audit("beta", "beta").filter((l) => l.op === "claim");
	expect(claims).toHaveLength(5);
	expect(new Set(claims.map((l) => l.leaseId)).size).toBe(5);
	expect(claims.map((l) => l.epoch)).toEqual([1, 2, 3, 4, 5]);
	expect(h.host.runtime.alarm("beta", "beta").count).toBe(1);
});
it("F1 role replay with a new SDK timestamp is not an independent root after alarm", async () => {
	const h = await fixture();
	for (let i = 0; i < 3; i++) {
		const m = h.message(roleMessageText(h.w.rm.byId(h.id)!));
		m.timestamp = i + 1;
		await h.land(m);
		await h.host.ended(B, "turn_completed", h.session);
	}
	await h.land(h.message(roleMessageText(h.w.rm.byId(h.id)!)));
	expect(h.host.runtime.audit("beta", "beta").filter((l) => l.op === "claim")).toHaveLength(3);
});
it("F1 intent without ledger resumes the preallocated random nonce; receipt failure reconciles exact claim", async () => {
	const h = await fixture();
	const m = h.message(roleMessageText(h.w.rm.byId(h.id)!));
	const append = h.sm.appendCustomEntry.bind(h.sm);
	let fault = true;
	const spy = vi.spyOn(h.sm, "appendCustomEntry").mockImplementation((type, value) => {
		const mark = value as { phase?: string };
		const id = append(type, value);
		if (type === "pi-web-ui/inbox-dispatch" && mark.phase === "intent" && fault) {
			fault = false;
			throw new Error("Injected crash after durable intent");
		}
		return id;
	});
	await h.land(m);
	expect(h.host.runtime.audit("beta", "beta").filter((l) => l.op === "claim")).toHaveLength(0);
	const intent = h.sm.getEntries().find((e) => e.type === "custom" && e.customType === "pi-web-ui/inbox-dispatch");
	if (!intent || intent.type !== "custom") throw new Error("No durable intent");
	spy.mockRestore();
	let receiptFault = true;
	const receiptSpy = vi.spyOn(h.sm, "appendCustomEntry").mockImplementation((type, value) => {
		if (type === "pi-web-ui/inbox-dispatch" && (value as { phase?: string }).phase === "receipt" && receiptFault) {
			receiptFault = false;
			throw new Error("Injected crash before receipt");
		}
		return append(type, value);
	});
	await h.host.landed(B, h.id, h.session, m);
	await h.host.landed(B, h.id, h.session, m);
	receiptSpy.mockRestore();
	const claims = h.host.runtime.audit("beta", "beta").filter((l) => l.op === "claim");
	expect(claims).toHaveLength(1);
	expect(claims[0].leaseId).toBe((intent.data as { leaseId: string }).leaseId);
	await h.host.ended(B, "turn_completed", h.session);
	expect(h.host.runtime.audit("beta", "beta").filter((l) => l.op === "attempt")).toHaveLength(1);
});
