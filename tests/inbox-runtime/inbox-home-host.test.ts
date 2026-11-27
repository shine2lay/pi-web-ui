import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { expect, it, vi } from "vitest";
import { InboxHomeHost } from "../../server/inbox-home-host.js";
import { A, B, useGuardWorld, who } from "../unit/role-message-guard-host-harness.js";
import { setup } from "./inbox-world.js";

useGuardWorld();
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
	expect(followUp).toHaveBeenCalledTimes(4);
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
	expect(followUp).toHaveBeenCalledTimes(4);
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
