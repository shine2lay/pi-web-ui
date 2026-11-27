import { readFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
import { InboxRuntime } from "../../server/inbox-runtime.js";
import { B, useGuardWorld, who, world } from "../unit/role-message-guard-host-harness.js";
import { claimOf, setup } from "./inbox-world.js";

useGuardWorld();
const answer = (id: string) => ({ kind: "reply" as const, to: "alpha", replyTo: id, text: "HOME answer" });
it("HOME qualified nonacceptance records one attempt and remains answerable after restart", async () => {
	const h = await setup();
	const lease = claimOf(await h.runtime.claim(h.key, { kind: "home", role: "beta", session: B }));
	const send = vi.spyOn(h.w.host, "send").mockResolvedValueOnce({ ok: false, error: "Not submitted" });
	expect((await h.runtime.reply(lease, who(h.w, "beta", B), answer(h.id), "unaccepted")).code).toBe("E_RPI_NOT_OPEN");
	await h.runtime.end(lease, "turn_ended_unanswered");
	expect(h.runtime.audit("beta", "beta").filter((l) => l.op === "attempt")).toHaveLength(1);
	send.mockRestore();
	const restart = new InboxRuntime(h.runtime.ports);
	await restart.recover();
	const next = claimOf(await restart.claim(h.key, { kind: "home", role: "beta", session: B }));
	expect((await restart.reply(next, who(h.w, "beta", B), answer(h.id), "after-restart")).resultRef).toBe(
		h.w.rm.byId(h.id)?.replyId,
	);
	expect(h.w.rm.rows(Infinity).filter((r) => r.replyTo === h.id)).toHaveLength(1);
});
it("HOME definitive invalid reply has no accepted effect and no retry ban", async () => {
	const h = await setup();
	const lease = claimOf(await h.runtime.claim(h.key, { kind: "home", role: "beta", session: B }));
	await h.runtime.reply(lease, who(h.w, "beta", B), { ...answer(h.id), text: "" }, "invalid");
	await h.runtime.end(lease, "turn_ended_unanswered");
	expect(h.w.rm.byId(h.id)?.replyId).toBeUndefined();
	expect("leaseId" in (await h.runtime.claim(h.key, { kind: "home", role: "beta", session: B }))).toBe(true);
});
it("HOME unknown guard history holds the intent and exposes a private alarm across restart", async () => {
	const h = await setup();
	const lease = claimOf(await h.runtime.claim(h.key, { kind: "home", role: "beta", session: B }));
	const send = vi.spyOn(h.w.host, "send").mockResolvedValue({ ok: false, error: "Unknown" });
	vi.spyOn(h.w.host, "lookupInboxOperation").mockResolvedValue({ state: "unknown", reason: "history missing" });
	expect((await h.runtime.reply(lease, who(h.w, "beta", B), answer(h.id), "unknown")).code).toBe("E_RPI_UNKNOWN");
	await h.runtime.end(lease, "aborted");
	const restart = new InboxRuntime(h.runtime.ports);
	await restart.recover();
	expect(await restart.claim(h.key, { kind: "home", role: "beta", session: B })).not.toHaveProperty("leaseId");
	expect(restart.alarm("beta", "beta").items.some((i) => i.cause === "unknown")).toBe(true);
	expect(send).toHaveBeenCalledTimes(1);
	expect(readFileSync(h.ledgerFile, "utf8")).not.toContain("HOME answer");
});
it("HOME accepted outbox with failed handoff recovers without a second send", async () => {
	const h = await setup();
	const lease = claimOf(await h.runtime.claim(h.key, { kind: "home", role: "beta", session: B }));
	const store = (h.w.host as unknown as { store: { transact(...args: unknown[]): Promise<unknown> } }).store;
	const transact = store.transact.bind(store);
	let calls = 0;
	store.transact = async (...args) => {
		if (++calls === 2) {
			store.transact = transact;
			throw new Error("Injected handoff failure");
		}
		return transact(...args);
	};
	expect((await h.runtime.reply(lease, who(h.w, "beta", B), answer(h.id), "accepted-outbox")).code).toBe(
		"E_RPI_EFFECT_PENDING",
	);
	expect(h.w.rm.byId(h.id)?.replyId).toBeUndefined();
	const pending = h.runtime.read("beta");
	expect(pending.status === "ok" && pending.items.find((i) => i.key === h.key)?.lifecycle.effect?.status).toBe(
		"accepted",
	);
	h.w.rm.stop();
	h.w.host.stop();
	const w = await world(h.w);
	const restart = new InboxRuntime({ ...h.runtime.ports, messages: w.rm, guard: w.host });
	await w.rm.tick();
	await restart.recover();
	const read = restart.read("beta");
	expect(read.status === "ok" && read.items.find((i) => i.key === h.key)?.lifecycle.state).toBe("replied");
	expect(w.rm.rows(Infinity).filter((r) => r.replyTo === h.id)).toHaveLength(1);
	await restart.recover();
	expect(w.rm.rows(Infinity).filter((r) => r.replyTo === h.id)).toHaveLength(1);
});
