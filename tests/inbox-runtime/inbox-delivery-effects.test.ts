import { expect, it } from "vitest";
import type { GuardStoreState } from "../../server/role-message-guard-contract.js";
import { B, chat, useGuardWorld, who } from "../unit/role-message-guard-host-harness.js";
import { caseOf } from "./inbox-corpora.js";
import { claimOf, setup } from "./inbox-world.js";

useGuardWorld();
type Harness = Awaited<ReturnType<typeof setup>>;
async function sends(h: Harness) {
	const state = await (h.w.host as unknown as { state_(): Promise<GuardStoreState> }).state_();
	return state.outbox.filter((row) => row.message.replyTo === h.id).length;
}
function state(h: Harness) {
	const read = h.runtime.read("beta");
	if (read.status !== "ok") throw new Error("Expected whole canonical read");
	const item = read.items.find((item) => item.key === h.key);
	if (!item) throw new Error("Missing original item");
	return item.lifecycle.state;
}
function reply(h: Harness, lease: ReturnType<typeof claimOf>, call: string) {
	return h.runtime.reply(
		lease,
		who(h.w, "beta", lease.session),
		{
			kind: "reply",
			to: "alpha",
			replyTo: h.id,
			text: "fixture reply",
		},
		call,
	);
}

it("C-DEFF-1 helper reply commits one canonical receipt", async () => {
	const c = caseOf("delivery", "C-DEFF-1");
	const h = await setup();
	const lease = claimOf(await h.runtime.claim(h.key, { kind: "helper", role: "beta", session: chat("helper") }));
	const result = await reply(h, lease, "k1");
	expect(result.code).toBeUndefined();
	expect(await sends(h)).toBe(c.expect.sends);
	expect(state(h)).toBe(c.expect.state);
	// Corpus reply-1 denotes the first actual accepted record, not a fabricated ID.
	expect(result.resultRef).toBe(h.w.rm.byId(h.id)?.replyId);
	expect(h.w.rm.byId(result.resultRef!)?.replyTo).toBe(h.id);
});

it("C-DEFF-2 HOME skips the key during real guard acceptance", async () => {
	const c = caseOf("delivery", "C-DEFF-2");
	const h = await setup();
	const lease = claimOf(await h.runtime.claim(h.key, { kind: "helper", role: "beta", session: chat("helper") }));
	const send = h.w.host.send.bind(h.w.host);
	let overlap: Awaited<ReturnType<typeof h.runtime.claim>> | undefined;
	// The wrapper injects the schedule only; the real guard remains the writer.
	h.w.host.send = async (...args) => {
		overlap = await h.runtime.claim(h.key, { kind: "home", role: "beta", session: B });
		return send(...args);
	};
	await reply(h, lease, "k1");
	expect(overlap).toEqual({ skipped: true });
	expect(await h.runtime.claim(h.key, { kind: "home", role: "beta", session: B })).toEqual({ code: "E_RPI_NOT_OPEN" });
	expect(lease.epoch).toBe(c.expect.epoch);
	expect(await sends(h)).toBe(c.expect.sends);
	expect(state(h)).toBe(c.expect.state);
});

it("C-DEFF-10 superseded helper is fenced before HOME replies", async () => {
	const c = caseOf("delivery", "C-DEFF-10");
	const h = await setup();
	const helper = claimOf(await h.runtime.claim(h.key, { kind: "helper", role: "beta", session: chat("helper") }));
	const home = claimOf(await h.runtime.claim(h.key, { kind: "home", role: "beta", session: B }));
	expect((await reply(h, helper, "k1")).code).toBe("E_RPI_STALE_LEASE");
	expect(await sends(h)).toBe(0);
	expect((await reply(h, home, "k2")).code).toBeUndefined();
	expect(home.epoch).toBe(c.expect.epoch);
	expect(await sends(h)).toBe(c.expect.sends);
	expect(state(h)).toBe(c.expect.state);
});

it("C-DEFF-11 second reply returns the original receipt without sending", async () => {
	const c = caseOf("delivery", "C-DEFF-11");
	const h = await setup();
	const lease = claimOf(await h.runtime.claim(h.key, { kind: "home", role: "beta", session: B }));
	const first = await reply(h, lease, "k1");
	const second = await reply(h, lease, "k2");
	expect(second).toMatchObject({ code: "E_RPI_ALREADY_REPLIED", resultRef: first.resultRef });
	expect(first.resultRef).toBe(h.w.rm.byId(h.id)?.replyId);
	expect(await sends(h)).toBe(c.expect.sends);
});

it("C-DEFF-12 text without replyTo cannot settle the held item", async () => {
	const c = caseOf("delivery", "C-DEFF-12");
	const h = await setup();
	const lease = claimOf(await h.runtime.claim(h.key, { kind: "home", role: "beta", session: B }));
	await h.runtime.reply(lease, who(h.w, "beta", B), { kind: "reply", to: "alpha", text: "text only" }, "k1");
	expect(await sends(h)).toBe(c.expect.sends);
	expect(state(h)).toBe(c.expect.state);
	expect(h.w.rm.byId(h.id)?.replyId).toBeUndefined();
});

it("C-DEFF-14 second helper cannot acquire the live lease", async () => {
	const c = caseOf("delivery", "C-DEFF-14");
	const h = await setup();
	const lease = claimOf(await h.runtime.claim(h.key, { kind: "helper", role: "beta", session: chat("helper-one") }));
	expect(await h.runtime.claim(h.key, { kind: "helper", role: "beta", session: chat("helper-two") })).toEqual({
		code: "E_RPI_CLAIMED",
	});
	expect(lease.epoch).toBe(c.expect.epoch);
});
