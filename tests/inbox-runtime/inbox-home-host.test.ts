import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { expect, it, vi } from "vitest";
import { InboxHomeHost } from "../../server/inbox-home-host.js";
import { A, B, send, useGuardWorld, who } from "../unit/role-message-guard-host-harness.js";
import { setup } from "./inbox-world.js";

useGuardWorld();
it("F2 wrong target without an active lease cannot orphan a new claim", async () => {
	const h = await setup();
	const host = new InboxHomeHost(h.runtime.ports, () => [{ id: "beta", homeChat: B }]);
	await host.start();
	const input = { kind: "reply" as const, to: "gamma", replyTo: h.id, text: "Correctable reply" };
	expect(await host.reply(who(h.w, "beta", B), input, "wrong-target")).toMatchObject({ ok: false });
	expect(host.runtime.audit("beta", "beta").filter((line) => line.op === "claim")).toHaveLength(0);
	expect(await host.reply(who(h.w, "beta", B), { ...input, to: "alpha" }, "corrected-target")).toMatchObject({
		ok: true,
	});
	await host.ended(B, "turn_completed", {
		agent: { followUp: vi.fn() },
		sendCustomMessage: vi.fn(),
	} as unknown as AgentSession);
	expect(host.runtime.audit("beta", "beta").filter((line) => line.op === "attempt")).toHaveLength(1);
});
it("F2 active A refuses reply B without acquiring a second HOME lease", async () => {
	const h = await setup();
	const second = await send(h.w, "alpha", A, "beta", { text: "Second obligation" });
	if (!second.ok) throw new Error("Second fixture request refused");
	const host = new InboxHomeHost(h.runtime.ports, () => [{ id: "beta", homeChat: B }]);
	await host.start();
	await host.landed(B, h.id);
	expect(
		await host.reply(
			who(h.w, "beta", B),
			{ kind: "reply", to: "alpha", replyTo: second.record.id, text: "Other reply" },
			"other-obligation",
		),
	).toMatchObject({ ok: false });
	expect(host.runtime.audit("beta", "beta").filter((line) => line.op === "claim")).toHaveLength(1);
	expect(h.w.rm.byId(second.record.id)?.replyId).toBeUndefined();
});
it("HOME host preserves unanswered obligations beyond the alarm and accepts a single real reply", async () => {
	const h = await setup();
	const homes = () => [
		{ id: "alpha", homeChat: A },
		{ id: "beta", homeChat: B },
	];
	const host = new InboxHomeHost(h.runtime.ports, homes);
	await host.start();
	const followUp = vi.fn(),
		sendCustomMessage = vi.fn(async () => {});
	const session = { agent: { followUp }, sendCustomMessage } as unknown as AgentSession;
	for (let n = 0; n < 4; n++) {
		await host.landed(B, h.id);
		await host.ended(B, "turn_completed", session);
	}
	expect(followUp).toHaveBeenCalledTimes(2);
	expect(sendCustomMessage).toHaveBeenCalledTimes(1);
	expect(host.runtime.audit("beta", "beta").filter((l) => l.op === "attempt")).toHaveLength(4);
	const restart = new InboxHomeHost(h.runtime.ports, homes);
	await restart.start();
	await restart.landed(B, h.id);
	const result = await restart.reply(
		who(h.w, "beta", B),
		{ kind: "reply", to: "alpha", replyTo: h.id, text: "Answer after restart" },
		"home-final",
	);
	expect(result?.ok).toBe(true);
	await restart.ended(B, "turn_completed", session);
	expect(h.w.rm.rows(Infinity).filter((r) => r.replyTo === h.id)).toHaveLength(1);
	expect(followUp).toHaveBeenCalledTimes(2);
});
it("F2 simultaneous explicit replies cannot acquire two HOME leases", async () => {
	const h = await setup();
	const second = await send(h.w, "alpha", A, "beta", { text: "Second concurrent obligation" });
	if (!second.ok) throw new Error("Second fixture request refused");
	const host = new InboxHomeHost(h.runtime.ports, () => [{ id: "beta", homeChat: B }]);
	await host.start();
	const results = await Promise.all(
		[h.id, second.record.id].map((id, index) =>
			host.reply(
				who(h.w, "beta", B),
				{ kind: "reply", to: "alpha", replyTo: id, text: "Explicit reply" },
				`parallel-${index}`,
			),
		),
	);
	expect(results.filter((result) => result?.ok)).toHaveLength(1);
	expect(host.runtime.audit("beta", "beta").filter((line) => line.op === "claim")).toHaveLength(1);
});
it("F1 unrelated outcomes do not count as unanswered failures", async () => {
	const h = await setup();
	for (const outcome of ["fenced", "released_to_home", "turn_completed"] as const) {
		const claim = await h.runtime.claim(h.key, { kind: "home", role: "beta", session: B });
		if (!("leaseId" in claim)) throw new Error("fixture claim failed");
		await h.runtime.end(claim, outcome);
	}
	expect(h.runtime.alarm("beta", "beta").count).toBe(0);
});
it("HOME shared coordination port uses the same writer and current lease fence", async () => {
	const h = await setup();
	const claim = await h.runtime.claim(h.key, { kind: "home", role: "beta", session: B });
	if (!("leaseId" in claim)) throw new Error("fixture claim failed");
	await h.runtime.coordinate(h.key, async (context) => {
		expect(context.current(claim).key).toBe(h.key);
		expect(context.lines()).toHaveLength(1);
		context.append({
			op: "attempt",
			leaseId: claim.leaseId,
			epoch: claim.epoch,
			n: 1,
			outcome: "turn_ended_unanswered",
		});
	});
	expect(h.runtime.failedAttempts(h.key)).toBe(1);
	await expect(h.runtime.coordinate(h.key, async (context) => context.current(claim))).rejects.toThrow(
		"E_RPI_STALE_LEASE",
	);
	await expect(
		h.runtime.coordinate(h.key, async (context) => context.current({ ...claim, key: "rm:rm-00000000" })),
	).rejects.toThrow("E_RPI_TARGET");
});
it("HOME host leaves non-HOME reply routing untouched", async () => {
	const h = await setup();
	const host = new InboxHomeHost(h.runtime.ports, () => [{ id: "beta", homeChat: B }]);
	await host.start();
	expect(
		await host.reply(who(h.w, "alpha", A), { kind: "reply", to: "beta", replyTo: h.id, text: "Non-HOME" }, "other"),
	).toBeUndefined();
	expect(host.runtime.audit("beta", "beta")).toHaveLength(0);
});
