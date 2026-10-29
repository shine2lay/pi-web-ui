// Ops #502 H-SOAK-ALS-1 (faster-landing): Ops #426's 3,000-acceptance soak, moved unchanged out of
// role-message-guard-host-late-handoff.test.ts so vitest's default forks pool runs it in a worker of its own. Each
// RoleMessageGuardHost leaves its two AsyncLocalStorage instances on for the rest of its worker, and that file's eight
// other cases make 18 hosts before this one, so every promise here paid for about 38 of them (Ops #495). Same harness,
// helpers, setup, counts, caps, assertions and timeout. Real host/core/store/native messages; only chats, clock and
// one failed prepare are fake. Nothing is sent to a real chat or model. Landed by Ops #558 (H-SOAK-ALS-2) with the
// case exactly as on mine after Ops #539 (its memory-only RoleMessages opt-in included); listed first in
// vitest.config.ts SLOWEST_FIRST so it starts at once instead of after the bigger files.
import { describe, expect, it } from "vitest";
import type { GuardOperationIdentity, GuardStoreState } from "../../server/role-message-guard-contract.js";
import { A, B, now, send, setNow, useGuardWorld, world, type World } from "./role-message-guard-host-harness.js";
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

describe("ladder: accepted messages outlive the hourly charge (#426)", () => {
	it("3,000 real acceptances with 1,500 hour-late hand-offs stay under every unchanged store cap", async () => {
		// M: one RoleMessages; logs below concern the guard store, not the omitted native disk copy.
		const w = await world(undefined, {}, memoryRoleMessagePersistence());
		const host = w.host as unknown as {
			core: { reconcile(id: GuardOperationIdentity): Promise<unknown> };
			maybeRotate(): Promise<void>;
			fills(s: GuardStoreState): Array<{ name: string; used: number; max: number }>;
		};
		const peaks = new Map<string, { used: number; max: number }>();
		const measure = async () => {
			for (const f of host.fills(await stateOf(w))) {
				expect(f.used, f.name).toBeLessThanOrEqual(f.max);
				if (!peaks.has(f.name) || f.used > peaks.get(f.name)!.used) peaks.set(f.name, { used: f.used, max: f.max });
			}
		};
		for (let i = 0; i < 1500; i++) {
			refuseNextHandOff(w);
			expect(await send(w, "alpha", A, "beta", { text: `late-${i}` }, "")).toMatchObject({
				ok: false,
				error: expect.stringContaining("not handed off yet"),
			});
			const entry = (await stateOf(w)).outbox.find((o) => o.state === "committed")!;
			expect(entry).toBeDefined();
			await measure();
			setNow(now + 61 * M);
			expect(await send(w, "beta", B, "alpha", { text: `trigger-${i}` }, "")).toMatchObject({ ok: true });
			expect((await stateOf(w)).usage.some((u) => u.transactionId === entry.receipt.transactionId)).toBe(false);
			await host.core.reconcile(entry.receipt.identity);
			await w.rm.tick();
			expect(w.rm.byId(entry.message.id)?.state).toBe("delivered");
			await measure();
			await host.maybeRotate(); // Same maintenance as startup/afterAccepted, only after this pair is settled.
		}
		expect(w.got).toHaveLength(3000);
		expect(new Set(w.got.map((g) => g.text)).size).toBe(3000);
		expect(w.host.state.status).toBe("ready");
		expect(w.logs.some((l) => /rotation failed|storage is full/.test(l))).toBe(false);
		expect(w.logs.filter((l) => /guard store generation/.test(l)).length).toBeGreaterThan(1);
		console.log("#426 3,000-entry soak peaks (metadata only):", Object.fromEntries(peaks));
		// 1,200 s, not #426's 300 s: the case is unchanged, but this machine now lands under load. Measured 2026-10-29
		// (Ops #635): 363 s at load1 ~35, over 300 s at load1 ~90 (it timed out on `mine` itself, blocking every land).
		// Vitest fails the run if the budget is hit, so a wide one costs nothing when the machine is quiet.
	}, 1_200_000);
});
