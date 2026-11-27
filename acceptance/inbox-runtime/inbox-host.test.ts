import { appendFileSync, readFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
import { canonSha, sortNames, toolSetSha } from "../../../pi-identity-ops-task-1120/specialists/canon.ts";
import { InboxHelperHost, inboxHelperBinding, INBOX_HELPER_HOST_KEY, type InboxHelperHostPorts, type InboxHelperRegistryHost } from "../../server/inbox-helper-host.js";
import { runQueueCloseChat, type QueueCloseHostContext } from "../../server/queue-chat-lane.js";
import { A, B, chat, send, useGuardWorld } from "../../tests/unit/role-message-guard-host-harness.js";
import { setup } from "./inbox-world.js";
import { caseOf } from "./inbox-corpora.js";

useGuardWorld();
async function hostFixture() {
	const h = await setup();
	const sessions = new Map<string, string>();
	const launched: string[] = [];
	const closed: string[] = [];
	const archived: string[] = [];
	let busy = false;
	let closeFails = false;
	let serial = 0;
	let host: InboxHelperHost;
	const closeHost: QueueCloseHostContext = {
		clients: new Map([["fixture", { releaseQueueChat: file => { if (closeFails) return false; closed.push(file); return true; } }]]),
		stateStore: { removeRecent: () => {} },
		queueSessionFor: () => null,
		queueLaneRoles: { roleOfHomeChat: () => "beta" },
	};
	const tools = sortNames(["read", "message_role", "inbox_release"]);
	const seal = { tools, toolSetSha: toolSetSha(tools), ceilingPolicySha: canonSha({ allowed: tools }), rolesConfigSha: canonSha({ beta: {} }) };
	const ports: InboxHelperHostPorts = {
		runtime: h.runtime,
		allocate: () => {
			const id = `helper-${++serial}`;
			const file = chat(id);
			sessions.set(id, file);
			return { sessionId: id, sessionFile: file };
		},
		// Fixed external resolver responses exercise host delegation, never duplicate its policy.
		seal: vi.fn(async () => seal),
		decideTool: vi.fn(async () => ({ allowed: false as const, code: "E_RPI_TOOL_DENIED" })),
		append: (file, customType, data) => appendFileSync(file, `${JSON.stringify({ type: "custom", customType, data })}\n`),
		launch: async (binding, hooks) => {
			expect(host.inboxHelperBinding(binding.sessionId)?.leaseId).toBe(binding.leaseId);
			const entries = readFileSync(binding.sessionFile, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line));
			expect(entries.filter(e => e.type === "custom").map(e => e.customType).slice(0, 3)).toEqual(["identity", "inbox-helper-seal", "inbox-helper-binding"]);
			const identity = entries.find(e => e.customType === "identity").data;
			expect(Object.keys(identity).sort()).toEqual(["id", "inbox", "v", "via"]);
			expect(identity.via).toBe("inbox-helper");
			expect(identity.inbox.leaseId).toBe(binding.leaseId);
			expect(entries.find(e => e.customType === "inbox-helper-seal").data).toEqual(seal);
			expect(h.runtime.audit("beta", "beta").some(line => line.op === "claim" && line.leaseId === binding.leaseId)).toBe(true);
			launched.push(binding.sessionId);
			hooks.gate("started"); hooks.ended();
		},
		working: () => busy,
		close: id => runQueueCloseChat(closeHost, sessions.get(id)!, () => {}),
		archive: async id => { archived.push(id); },
	};
	host = new InboxHelperHost(ports);
	return { h, host, ports, launched, closed, archived, sessions, busy: (v: boolean) => { busy = v; }, failClose: (v: boolean) => { closeFails = v; } };
}
it("GREEN inert global H1 accessor provides no fabricated binding", () => {
	expect(inboxHelperBinding("unbound-session")).toBeUndefined();
});
it.each(["live", "stale", "unknown"])("H1 installed queue-host transport preserves %s binding result", state => {
	const globals = globalThis as Record<symbol, unknown>;
	const previous = globals[INBOX_HELPER_HOST_KEY];
	const binding = { role: "beta", msgId: "rm-00000001", leaseId: "L1", epoch: 1, homeChat: B };
	const host: InboxHelperRegistryHost = { inboxHelperBinding: () => {
		if (state === "live") return binding;
		throw Object.assign(new Error("Fixture host authority"), { code: state === "stale" ? "E_RPI_STALE_LEASE" : "E_RPI_UNKNOWN" });
	} };
	globals[INBOX_HELPER_HOST_KEY] = host;
	try {
		if (state === "live") expect(inboxHelperBinding("fixture")).toEqual(binding);
		else {
			let code: unknown;
			try { inboxHelperBinding("fixture"); } catch (error) { code = (error as { code?: unknown }).code; }
			expect(code).toBe(state === "stale" ? "E_RPI_STALE_LEASE" : "E_RPI_UNKNOWN");
		}
	} finally {
		if (previous === undefined) delete globals[INBOX_HELPER_HOST_KEY];
		else globals[INBOX_HELPER_HOST_KEY] = previous;
	}
});
it("H1 claim and three binding entries precede launch; same role capped at three", async () => {
	caseOf("helper", "C-HSPAWN-11");
	const f = await hostFixture();
	for (let n = 0; n < 3; n++) expect((await send(f.h.w, "alpha", A, "beta")).ok).toBe(true);
	await Promise.all([f.host.admit({ role: "beta", homeChat: B, homeWorking: true, k: 3 }), f.host.admit({ role: "beta", homeChat: B, homeWorking: true, k: 3 })]);
	expect(f.launched.length).toBe(3);
	expect(new Set(f.launched).size).toBe(3);
	expect(f.host.live("beta")).toBe(3);
	expect(f.ports.seal).toHaveBeenCalled();
});
it("C-HSPAWN-2 idle HOME and one request writes no helper entries", async () => {
	caseOf("helper", "C-HSPAWN-2"); const f = await hostFixture();
	expect(await f.host.admit({ role: "beta", homeChat: B, homeWorking: false, k: 3 })).toHaveLength(0);
	expect(f.sessions.size).toBe(0);
	expect(f.h.runtime.audit("beta", "beta")).toHaveLength(0);
});
it("C-HSPAWN-13 launch failure releases claim and records crashed/spawn_failed", async () => {
	caseOf("helper", "C-HSPAWN-13"); const f = await hostFixture();
	f.ports.launch = async () => { throw new Error("Injected creation failure"); };
	await f.host.admit({ role: "beta", homeChat: B, homeWorking: true, k: 3 });
	const lines = f.h.runtime.audit("beta", "beta");
	expect(lines.some(l => l.op === "release" && l.reason === "spawn_failed")).toBe(true);
	expect(lines.some(l => l.op === "attempt" && l.outcome === "crashed" && l.cause === "spawn_failed")).toBe(true);
	expect(f.host.live("beta")).toBe(0);
});
it.each(["bash", "queue_reply", "dynamic_late_tool"])("H2 %s denied before dispatch by canonical decision port", async name => {
	caseOf("helper", "C-HTOOL-2"); const f = await hostFixture();
	const [helper] = await f.host.admit({ role: "beta", homeChat: B, homeWorking: true, k: 3 });
	const dispatch = vi.fn(async () => undefined);
	expect(await f.host.call(helper.sessionId, name, {}, dispatch)).toEqual({ allowed: false, code: "E_RPI_TOOL_DENIED" });
	expect(dispatch).not.toHaveBeenCalled();
});
it("H2 every allowed-name call uses current canonical decision; denial is not bypassed", async () => {
	caseOf("helper", "C-HTOOL-6"); const f = await hostFixture();
	const [helper] = await f.host.admit({ role: "beta", homeChat: B, homeWorking: true, k: 3 });
	const dispatch = vi.fn(async () => undefined);
	f.ports.decideTool = vi.fn(async () => ({ allowed: true as const }));
	expect(await f.host.call(helper.sessionId, "read", { path: "/fixture" }, dispatch)).toEqual({ allowed: true });
	expect(dispatch).toHaveBeenCalledTimes(1);
	f.ports.decideTool = vi.fn(async () => ({ allowed: false as const, code: "E_RPI_TOOL_DENIED" }));
	expect(await f.host.call(helper.sessionId, "read", { path: "/fixture" }, dispatch)).toEqual({ allowed: false, code: "E_RPI_TOOL_DENIED" });
	expect(f.ports.decideTool).toHaveBeenCalledWith(helper.sessionId, "read", { path: "/fixture" });
	expect(dispatch).toHaveBeenCalledTimes(1);
});
it("H4 working chat never closes; failed close retries without re-launch", async () => {
	caseOf("helper", "C-HCLOSE-1"); const f = await hostFixture();
	const [helper] = await f.host.admit({ role: "beta", homeChat: B, homeWorking: true, k: 3 });
	f.busy(true);
	await f.host.end(helper.sessionId, "turn_ended_unanswered");
	expect(f.closed).toHaveLength(0);
	f.busy(false); f.failClose(true); await f.host.reconcile();
	expect(f.host.live("beta")).toBe(1);
	f.failClose(false); await f.host.reconcile(); await f.host.reconcile();
	expect(f.closed).toHaveLength(1);
	expect(f.archived).toEqual([helper.sessionId]);
	expect(f.launched).toHaveLength(1);
	expect(f.host.live("beta")).toBe(0);
});
it("H3 release need routes same original HOME, no semantic answer", async () => {
	caseOf("helper", "C-HREL-6"); const f = await hostFixture();
	const [helper] = await f.host.admit({ role: "beta", homeChat: B, homeWorking: true, k: 3 });
	await f.host.release(helper.sessionId, "owner_consent");
	const read = f.h.runtime.read("beta");
	if (read.status !== "ok") throw new Error("Expected whole read");
	const item = read.items.find(i => i.key === f.h.key)!;
	expect(item.route).toBe("home_only");
	expect(item.effectivePriority).toBe("P1");
	expect(item.lifecycle.receipt.semantic).toBeNull();
	expect(f.h.w.rm.byId(f.h.id)?.replyId).toBeUndefined();
});
