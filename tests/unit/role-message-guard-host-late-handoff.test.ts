// Ops #426 H-HANDOFF-WINDOW-1: an accepted message outlives its hourly charge. Real host/core/store/native
// messages; only chats, clock and one failed prepare are fake. Nothing is sent to a real chat or model.
import { describe, expect, it } from "vitest";
import type { GuardOperationIdentity, GuardStoreState } from "../../server/role-message-guard-contract.js";
import { GUARD_POLICY_V2 } from "../../server/role-message-limits.js";
import {
	A,
	B,
	chat,
	now,
	role,
	send,
	setNow,
	useGuardWorld,
	world,
	type World,
} from "./role-message-guard-host-harness.js";
import { memoryRoleMessagePersistence } from "./role-messages-memory.js";

useGuardWorld();
const M = 60_000;
const stateOf = async (w: World) =>
	(await (w.host as unknown as { state_(): Promise<GuardStoreState | null> }).state_())!;

/** Accept durably, then fail just before E can prepare its first hand-off. */
function refuseNextHandOff(w: World): void {
	const store = (w.host as unknown as { store: { transact(...a: unknown[]): Promise<unknown> } }).store;
	const real = store.transact.bind(store);
	let calls = 0;
	store.transact = async (...a: unknown[]) => {
		if (++calls === 2) {
			store.transact = real;
			throw new Error("synthetic refusal before the hand-off");
		}
		return real(...a);
	};
}

// Required counterfactual: on mine the charge prunes, then updateOutbox refuses the restart's hand-off.
describe("ladder: accepted messages outlive the hourly charge (#426)", () => {
	it("V2: a 61-minute accepted hand-off survives 40 capped sends, pruning and two restarts without renewing charge", async () => {
		let w = await world(undefined, { policy: GUARD_POLICY_V2 });
		const start = now;
		refuseNextHandOff(w);
		expect(await send(w, "alpha", A, "beta", { text: "v2-delayed" }, "")).toMatchObject({
			ok: false,
			error: expect.stringContaining("Accepted but not handed off"),
		});
		const accepted = (await stateOf(w)).outbox.find((o) => o.state === "committed")!;
		for (let n = 1; n < 40; n++) expect(await send(w, "alpha", A, "beta", {}, "")).toMatchObject({ ok: true });
		expect(await send(w, "alpha", A, "beta", {}, "")).toMatchObject({ ok: false, reason: "ordinary_hourly" });
		setNow(start + 61 * M);
		expect(await send(w, "beta", B, "alpha", { text: "v2-prune" }, "")).toMatchObject({ ok: true });
		expect((await stateOf(w)).usage.some((u) => u.transactionId === accepted.receipt.transactionId)).toBe(false);
		for (let restart = 0; restart < 2; restart++) {
			w.rm.stop();
			w.host.stop();
			w = await world(w, { policy: GUARD_POLICY_V2 });
			await w.rm.tick();
			expect(w.rm.byId(accepted.message.id)?.state).toBe("delivered");
			expect(w.got.filter((g) => g.text.includes("v2-delayed"))).toHaveLength(1);
			expect((await stateOf(w)).usage.some((u) => u.transactionId === accepted.receipt.transactionId)).toBe(false);
		}
	});
	it.each([60, 61, 360, 23 * 60])(
		"hands off once after a %i min delay and a restart, even after another send prunes its charge",
		async (minutes) => {
			const w = await world();
			const start = now;
			refuseNextHandOff(w);
			expect(await send(w, "alpha", A, "beta", { text: "delayed acceptance" }, "")).toMatchObject({
				ok: false,
				error: "Accepted but not handed off yet; it is delivered once the app catches up.",
			});
			const accepted = (await stateOf(w)).outbox.find((o) => o.state === "committed")!;
			expect(accepted).toBeDefined();
			expect(w.rm.byId(accepted.message.id)).toBeUndefined();
			setNow(start + minutes * M);
			expect(await send(w, "beta", B, "alpha", { text: "prune trigger" }, "")).toMatchObject({ ok: true });
			expect((await stateOf(w)).usage.some((u) => u.transactionId === accepted.receipt.transactionId)).toBe(false);
			w.rm.stop();
			w.host.stop();
			const restarted = await world(w);
			await restarted.rm.tick();
			expect(restarted.rm.byId(accepted.message.id)?.state).toBe("delivered");
			expect((await stateOf(restarted)).outbox.find((o) => o.message.id === accepted.message.id)?.state).toBe(
				"handled",
			);
			expect(restarted.got.filter((g) => g.text.includes("delayed acceptance"))).toHaveLength(1);
			expect((await stateOf(restarted)).usage.some((u) => u.transactionId === accepted.receipt.transactionId)).toBe(
				false,
			);
			restarted.rm.stop();
			restarted.host.stop();
			const again = await world(restarted);
			await again.rm.tick();
			expect(again.got.filter((g) => g.text.includes("delayed acceptance"))).toHaveLength(1);
		},
	);

	it.each(["alpha", "ops", "temper"])(
		"%s has the same cap decisions and rolling counts with or without a delayed entry",
		async (sender) => {
			// M: one RoleMessages, no reload or persistence checks; the real guard store is unchanged.
			const w = await world(undefined, {}, memoryRoleMessagePersistence());
			const file = sender === "alpha" ? A : chat(`${sender}-home`);
			if (sender !== "alpha") w.roles.push(role(sender, file));
			const traces: unknown[] = [];
			for (const delayed of [false, true]) {
				const start = now;
				if (delayed) refuseNextHandOff(w);
				const first = await send(w, sender, file, "beta", { text: "initial acceptance" }, "");
				expect(first.ok).toBe(!delayed);
				const accepted = (await stateOf(w)).outbox.find((o) => o.receipt.committedAt === start)!;
				const count = async () => (await stateOf(w)).usage.filter((u) => u.origin === sender).length;
				setNow(start + 59 * M);
				for (let i = 0; i < 19; i++) expect(await send(w, sender, file, "beta", {}, "")).toMatchObject({ ok: true });
				const at59 = await send(w, sender, file, "beta", {}, "");
				expect(at59).toMatchObject(sender === "alpha" ? { ok: false, reason: "ordinary_hourly" } : { ok: true });
				const count59 = await count();
				setNow(start + 60 * M);
				const at60 = await send(w, sender, file, "beta", {}, "");
				expect(at60).toMatchObject({ ok: true });
				const count60 = await count();
				setNow(start + 61 * M);
				await (
					w.host as unknown as { core: { reconcile(id: GuardOperationIdentity): Promise<unknown> } }
				).core.reconcile(accepted.receipt.identity);
				await w.rm.tick();
				const at61 = await send(w, sender, file, "beta", {}, "");
				const count61 = await count();
				traces.push({
					at59: at59.ok,
					count59,
					at60: at60.ok,
					count60,
					at61: at61.ok,
					count61,
					native61: w.rm.hourlyCount(sender),
				});
				setNow(start + 3 * 60 * M);
			}
			expect(traces[1]).toEqual(traces[0]);
		},
	);
	// The 3,000-acceptance soak of this ladder is in role-message-guard-host-late-handoff-soak.test.ts, unchanged, in a
	// worker of its own: the hosts these cases make leave their AsyncLocalStorage on for the rest of the worker (Ops #502).
});
