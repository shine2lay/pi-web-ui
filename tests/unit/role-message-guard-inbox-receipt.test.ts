import { readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { GuardStoreStateAny } from "../../server/role-message-guard-contract-v2.js";
import { RoleMessageGuardHost, type RoleMessageGuardHostOptions } from "../../server/role-message-guard-host.js";
import { guardInboxOperationReceipt, guardSendOperationId } from "../../server/role-message-guard-inbox-receipt.js";
import { guardOperationKey } from "../../server/role-message-guard-store.js";
import { A, chainTo, data, tc, useGuardWorld, who, world, type World } from "./role-message-guard-host-harness.js";

useGuardWorld();
const stateOf = async (w: World) =>
	(await (w.host as unknown as { state_(): Promise<GuardStoreStateAny | null> }).state_())!;
const rotate = (host: RoleMessageGuardHost) =>
	(host as unknown as { rotate(force: boolean): Promise<void> }).rotate(true);
const generation = () => readFileSync(join(data, "role-message-guard", "current.json"), "utf8");

/** Synthetic failure before handoff; acceptance itself still uses the real core/store. */
function refuseNextHandoff(w: World): void {
	const store = (w.host as unknown as { store: { transact(...args: unknown[]): Promise<unknown> } }).store;
	const transact = store.transact.bind(store);
	let calls = 0;
	store.transact = async (...args) => {
		if (++calls === 2) {
			store.transact = transact;
			throw new Error("synthetic handoff interruption");
		}
		return transact(...args);
	};
}

function restartHost(w: World): RoleMessageGuardHost {
	w.host.stop();
	return new RoleMessageGuardHost((w.host as unknown as { o: RoleMessageGuardHostOptions }).o);
}

describe("qualified HOME guard-operation receipts", () => {
	it("uses the exact send identity and distinguishes covered absence from missing generations", async () => {
		const w = await world();
		const call = tc();
		const ref = w.host.inboxOperationRef(A, call)!;
		expect(ref).toBe(`guard:1:${guardSendOperationId(A, call)}`);
		expect(await w.host.lookupInboxOperation(ref)).toEqual({ state: "unaccepted" });
		expect(await w.host.lookupInboxOperation(ref.replace("guard:1:", "guard:2:"))).toMatchObject({ state: "unknown" });
		expect(await w.host.lookupInboxOperation("send-unqualified")).toMatchObject({ state: "unknown" });
		await rotate(w.host);
		expect(await w.host.lookupInboxOperation(ref)).toMatchObject({ state: "unknown" });
		expect(await w.host.send(who(w, "alpha", A), { to: "beta", kind: "request", text: "synthetic" }, call, ref))
			.toMatchObject({ ok: false });
		expect(w.got).toHaveLength(0);
	});

	it("keeps accepted outbox authoritative after ok:false and across restart, without resend", async () => {
		const w = await world();
		const call = tc();
		const ref = w.host.inboxOperationRef(A, call)!;
		w.host.registerInboxIntentHold(() => true);
		refuseNextHandoff(w);
		expect(await w.host.send(who(w, "alpha", A), { to: "beta", kind: "request", text: "synthetic pending" }, call, ref))
			.toMatchObject({ ok: false, error: expect.stringContaining("Accepted but not handed off") });
		const receipt = await w.host.lookupInboxOperation(ref);
		expect(receipt).toMatchObject({ state: "accepted", resultRef: expect.any(String) });
		const restarted = restartHost(w);
		restarted.registerInboxIntentHold(() => true);
		try {
			await restarted.start();
			expect(restarted.state.status).toBe("ready");
			expect(await restarted.lookupInboxOperation(ref)).toEqual(receipt);
			await w.rm.tick();
			expect(w.got.filter((entry) => entry.text.includes("synthetic pending"))).toHaveLength(1);
		} finally {
			restarted.stop();
		}
	});

	it("looks up a committed guard refusal rather than relying on send ok:false", async () => {
		const w = await world();
		const next = await chainTo(w, 7);
		const call = tc();
		const ref = w.host.inboxOperationRef(next.file, call)!;
		expect(await w.host.send(who(w, next.from, next.file), {
			to: next.to, kind: "request", text: "synthetic refusal",
		}, call, ref)).toMatchObject({ ok: false });
		expect(await w.host.lookupInboxOperation(ref)).toMatchObject({ state: "refused" });
	});

	it("projects committed refusal, prepared and pruned evidence without guessing absence", async () => {
		const w = await world();
		const call = tc();
		const ref = w.host.inboxOperationRef(A, call)!;
		await w.host.send(who(w, "alpha", A), { to: "beta", kind: "request", text: "synthetic projection" }, call, ref);
		const state = await stateOf(w);
		const transaction = state.transactions.find((entry) => entry.identity.operationId === guardSendOperationId(A, call))!;
		const refused: GuardStoreStateAny = { ...state, outbox: [], transactions: [{
			state: "committed", transactionId: transaction.transactionId, identity: transaction.identity,
			result: { state: "blocked", reason: "identity_conflict", request: null, requiredTier: null, accepted: false },
		}] };
		expect(guardInboxOperationReceipt(ref, 1, { state: "ready", value: refused }))
			.toEqual({ state: "refused", reason: "identity_conflict" });
		// Even a later refusal must not outrank an accepted outbox entry.
		expect(guardInboxOperationReceipt(ref, 1, { state: "ready", value: { ...refused, outbox: state.outbox } }))
			.toMatchObject({ state: "accepted" });
		expect(guardInboxOperationReceipt(ref, 1, { state: "unknown", reason: "prepared publication" }))
			.toEqual({ state: "unknown", reason: "prepared publication" });
		const prepared: GuardStoreStateAny = { ...state, outbox: [], transactions: [{
			state: "prepared", identity: transaction.identity, transactionId: transaction.transactionId,
			reservation: { preparedAt: 0, origin: "alpha", destination: "beta", grantId: null,
				incidentIdentityDigest: null, requestGenerationKey: null, usage: null,
				initialIncidentSlot: false, terminalIncidentSlot: false },
		}] };
		expect(guardInboxOperationReceipt(ref, 1, { state: "ready", value: prepared })).toMatchObject({ state: "unknown" });
		const pruned: GuardStoreStateAny = { ...state, outbox: [], transactions: [], tombstones: [{
			kind: "operation", identityDigest: guardOperationKey(transaction.identity), invalidThrough: "source_horizon_unknown",
			lastTransactionId: transaction.transactionId,
		}] };
		expect(guardInboxOperationReceipt(ref, 1, { state: "ready", value: pruned })).toMatchObject({ state: "unknown" });
	});

	it("holds forced rotation for unresolved intents or unreadable ledger, then releases it", async () => {
		const w = await world();
		const before = generation();
		let pending = true;
		w.host.registerInboxIntentHold(() => pending);
		expect((w.host as unknown as { quiescent(s: GuardStoreStateAny, now: number): boolean })
			.quiescent(await stateOf(w), Date.now())).toBe(false);
		await rotate(w.host);
		expect(generation()).toBe(before);
		w.host.registerInboxIntentHold(() => { throw new Error("synthetic unreadable ledger"); });
		await rotate(w.host);
		expect(generation()).toBe(before);
		w.host.registerInboxIntentHold(() => pending);
		pending = false;
		await rotate(w.host);
		expect(generation()).not.toBe(before);
	});

	it("returns UNKNOWN for unreadable history and refuses to bootstrap over missing history on restart", async () => {
		const w = await world();
		const ref = w.host.inboxOperationRef(A, tc())!;
		w.host.registerInboxIntentHold(() => true);
		unlinkSync(join(data, "role-message-guard", "gen-1", "journal.json"));
		expect(await w.host.lookupInboxOperation(ref)).toMatchObject({ state: "unknown" });
		const restarted = restartHost(w);
		restarted.registerInboxIntentHold(() => true);
		try {
			await restarted.start();
			expect(restarted.state.status).toBe("degraded");
			expect(await restarted.lookupInboxOperation(ref)).toMatchObject({ state: "unknown" });
		} finally {
			restarted.stop();
		}
	});
});
