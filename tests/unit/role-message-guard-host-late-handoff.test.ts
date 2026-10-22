// Ops #426 H-HANDOFF-WINDOW-1: an accepted message outlives its hourly charge. Real host/core/store/native
// messages; only chats, clock and one failed prepare are fake. Nothing is sent to a real chat or model.
import { describe, expect, it } from "vitest";
import type { GuardOperationIdentity, GuardStoreState } from "../../server/role-message-guard-contract.js";
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
			const w = await world();
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

	it("3,000 real acceptances with 1,500 hour-late hand-offs stay under every unchanged store cap", async () => {
		const w = await world();
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
	}, 300_000);
});
