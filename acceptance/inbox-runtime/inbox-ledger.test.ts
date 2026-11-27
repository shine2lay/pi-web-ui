import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, statSync } from "node:fs";
import { expect, it, vi } from "vitest";
import type { GuardStoreState } from "../../server/role-message-guard-contract.js";
import { B, clock, send, useGuardWorld, who, world } from "../../tests/unit/role-message-guard-host-harness.js";
import { caseOf } from "./inbox-corpora.js";

import { claimOf, setup } from "./inbox-world.js";

useGuardWorld();
it("C-DDONE-2 delivered plus ended turn leaves reply obligation open", async () => {
	const c = caseOf("delivery", "C-DDONE-2");
	const h = await setup();
	expect(h.w.rm.byId(h.id)?.state).toBe("delivered");
	expect(h.w.rm.byId(h.id)?.replyId).toBeUndefined();
	const lease = claimOf(await h.runtime.claim(h.key, { kind: "home", role: "beta", session: B }));
	await h.runtime.end(lease, "turn_ended_unanswered");
	const read = h.runtime.read("beta");
	expect(read.status).toBe("ok");
	if (read.status !== "ok") throw new Error("Whole read required");
	expect(read.items.find(i => i.key === h.key)?.lifecycle.state).toBe(c.expect.state);
	expect(read.items.find(i => i.key === h.key)?.lifecycle.receipt.semantic).toBeNull();
});
it("C-READ-2 torn real ledger refuses new claims, never reports empty", async () => {
	const c = caseOf("core", "C-READ-2");
	const h = await setup(); writeFileSync(h.ledgerFile, '{"v":"rpi/1",');
	expect(h.runtime.read("beta")).toMatchObject({ status: c.expect.status, source: c.expect.source });
	expect(await h.runtime.claim(h.key, { kind: "home", role: "beta", session: B })).toMatchObject({ code: c.expect.code });
});
const boundary607 = readFileSync("/home/shinelay/architecture-dept-inbox-boundary-607/tests/role-priority-inbox/unified/boundary607.cases.json");
if (createHash("sha256").update(boundary607).digest("hex") !== "f9e68ff62ee5189055c865779fe0ee6dd63ab842b8714835dbcdbd30e19df0a1") throw new Error("Boundary607 corpus drift");
const opValues = (JSON.parse(boundary607.toString()).cases as Array<{ id: string; values: unknown[] }>).find(c => c.id === "line-op")!.values;
it.each(opValues.map((op, index) => ({ op, index })))("#607 line-op/$index schema failure is UNKNOWN, no claim or guard effect", async ({ op }) => {
	const h = await setup();
	// Same malformed-op values at the real file reader, using a claim envelope.
	writeFileSync(h.ledgerFile, JSON.stringify({ v: "rpi/1", seq: 1, at: clock(), key: h.key,
		contentHash: `sha256:${"a".repeat(64)}`, op, leaseId: "L1", epoch: 1,
		holder: { kind: "home", role: "beta", session: B } }) + "\n");
	const guardSend = vi.spyOn(h.w.host, "send");
	const before = readFileSync(h.ledgerFile, "utf8");
	expect(h.runtime.read("beta")).toMatchObject({ status: "unknown", source: "ledger" });
	expect(await h.runtime.claim(h.key, { kind: "home", role: "beta", session: B })).toMatchObject({ code: "E_RPI_UNKNOWN" });
	expect(await h.runtime.reply({ key: h.key, session: B, leaseId: "L1", epoch: 1 }, who(h.w, "beta", B),
		{ kind: "reply", to: "alpha", replyTo: h.id, text: "fixture answer" }, "schema-refusal")).toMatchObject({ code: "E_RPI_UNKNOWN" });
	expect(guardSend).not.toHaveBeenCalled();
	expect(h.w.rm.byId(h.id)?.replyId).toBeUndefined();
	expect(readFileSync(h.ledgerFile, "utf8") === before).toBe(true);
});
it("U11 HOME try-lock skips while real local acceptance owns the key", async () => {
	caseOf("delivery", "C-DEFF-16");
	const h = await setup();
	let unlock!: () => void;
	let entered!: () => void;
	const started = new Promise<void>(resolve => { entered = resolve; });
	const held = new Promise<void>(resolve => { unlock = resolve; });
	const acceptance = h.runtime.run(h.key, async () => { entered(); await held; });
	await started;
	try { expect(await h.runtime.claim(h.key, { kind: "home", role: "beta", session: B })).toEqual({ skipped: true }); }
	finally { unlock(); await acceptance; }
});
it("HOME supersede fences helper before any real guard write", async () => {
	caseOf("helper", "C-HRACE-1");
	const h = await setup();
	const helper = claimOf(await h.runtime.claim(h.key, { kind: "helper", role: "beta", session: B }));
	claimOf(await h.runtime.claim(h.key, { kind: "home", role: "beta", session: B }));
	const result = await h.runtime.reply(helper, who(h.w, "beta", B), { kind: "reply", replyTo: h.id, to: "alpha", text: "fixture answer" }, "stale-call");
	expect(result.code).toBe("E_RPI_STALE_LEASE");
	expect(h.w.rm.byId(h.id)?.replyId).toBeUndefined();
});
it("C-DALM-1 three unanswered attempts append one private metadata alarm, no retry ban", async () => {
	const c = caseOf("delivery", "C-DALM-1");
	const h = await setup();
	for (let n = 0; n < 3; n++) {
		const claim = claimOf(await h.runtime.claim(h.key, { kind: "home", role: "beta", session: B }));
		await h.runtime.end(claim, "turn_ended_unanswered");
	}
	expect(h.runtime.audit("beta", "beta").filter(l => l.op === "alarm").length).toBe(c.expect.lines);
	expect(readFileSync(h.ledgerFile, "utf8").includes("hello from alpha")).toBe(c.expect.leaked_text);
	expect("leaseId" in await h.runtime.claim(h.key, { kind: "home", role: "beta", session: B })).toBe(true);
});
it("ledger audit is metadata-only, private, mode 0600, with contiguous seq", async () => {
	const h = await setup();
	await h.runtime.claim(h.key, { kind: "helper", role: "beta", session: B });
	const lines = h.runtime.audit("beta", "beta");
	expect(lines.length).toBeGreaterThan(0);
	expect(lines.map(l => l.seq)).toEqual(lines.map((_, i) => i + 1));
	expect(readFileSync(h.ledgerFile, "utf8").includes("hello from alpha")).toBe(false);
	expect(statSync(h.ledgerFile).mode & 0o777).toBe(0o600);
	expect(() => h.runtime.audit("beta", "gamma")).toThrow();
});
it("C-DEFF-16 real guard acceptance survives failed handoff and restart exactly once (ledger pending)", async () => {
	caseOf("delivery", "C-DEFF-16");
	const h = await setup();
	const store = (h.w.host as unknown as { store: { transact(...args: unknown[]): Promise<unknown> } }).store;
	const real = store.transact.bind(store);
	let calls = 0;
	store.transact = async (...args) => {
		if (++calls === 2) { store.transact = real; throw new Error("Injected before handoff"); }
		return real(...args);
	};
	const result = await send(h.w, "beta", B, "alpha", { kind: "reply", replyTo: h.id });
	expect(result.ok).toBe(false);
	expect(h.w.rm.byId(h.id)?.replyId).toBeUndefined();
	const state = await (h.w.host as unknown as { state_(): Promise<GuardStoreState> }).state_();
	const accepted = state.outbox.filter(o => o.message.replyTo === h.id);
	expect(accepted.length).toBe(1);
	const replyId = accepted[0].message.id;
	h.w.rm.stop(); h.w.host.stop();
	const restarted = await world(h.w);
	await restarted.rm.tick();
	expect(restarted.rm.byId(h.id)?.replyId).toBe(replyId);
	expect(restarted.rm.byId(replyId)?.replyTo).toBe(h.id);
	restarted.rm.stop(); restarted.host.stop();
	const again = await world(restarted); await again.rm.tick();
	expect(again.rm.byId(h.id)?.replyId).toBe(replyId);
	const finalState = await (again.host as unknown as { state_(): Promise<GuardStoreState> }).state_();
	expect(finalState.outbox.filter(o => o.message.replyTo === h.id).length).toBe(1);
});
it("legacy no-helper actual guard and RoleMessages accept one reply only", async () => {
	const h = await setup();
	const first = await send(h.w, "beta", B, "alpha", { kind: "reply", replyTo: h.id });
	expect(first.ok).toBe(true);
	const replyId = h.w.rm.byId(h.id)?.replyId;
	expect(typeof replyId).toBe("string");
	const second = await send(h.w, "beta", B, "alpha", { kind: "reply", replyTo: h.id });
	expect(second.ok).toBe(false);
	expect(h.w.rm.byId(h.id)?.replyId).toBe(replyId);
});
