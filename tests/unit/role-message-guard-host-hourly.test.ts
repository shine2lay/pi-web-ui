// Ops #318 H-MSGCAP-EXEMPT-1: fixed inputs, real native + approvals writers, synthetic chats only.
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { GUARD_POLICY } from "../../server/role-message-guard-host.js";
import type { GuardStoreState } from "../../server/role-message-guard-contract.js";
import { RoleMessages } from "../../server/role-messages.js";
import { GuardFileStore as BeforeChangeStore } from "./role-message-guard-store-reference.js";
import {
	B,
	ask,
	chat,
	cooDecides,
	data,
	now,
	role,
	send,
	setNow,
	tc,
	useGuardWorld,
	who,
	world,
	type World,
} from "./role-message-guard-host-harness.js";

useGuardWorld();
const stateOf = (w: World) =>
	(w.host as unknown as { state_(): Promise<GuardStoreState | null> }).state_().then((s) => s!);

function addRole(w: World, id: string) {
	const home = chat(`${id}-home`);
	w.roles.push(role(id, home));
	return home;
}

async function nextOpsHop7(w: World, home: string) {
	for (let hop = 1; hop <= 6; hop++) {
		const fromOps = hop % 2 === 1;
		expect(await send(w, fromOps ? "ops" : "beta", fromOps ? home : B, fromOps ? "beta" : "ops")).toMatchObject({
			ok: true,
		});
	}
}

// A second live pid in the lock makes the real host fail closed and use its native fallback.
async function unavailable(w: World) {
	writeFileSync(join(data, "role-message-guard", "lock"), `${process.ppid}\n`);
	await stateOf(w);
	expect(w.host.state.status).toBe("degraded");
}

describe("owner's hourly exemptions (approval host)", () => {
	it.each([
		["temper", "ready"],
		["ops", "ready"],
		["temper", "unavailable"],
		["ops", "unavailable"],
	])("%s accepts its 21st and 40th across home/task chats, approvals %s", async (id, mode) => {
		const w = await world();
		const home = addRole(w, id);
		const task = chat(`${id}-task`);
		if (mode === "unavailable") await unavailable(w);
		for (let n = 1; n <= 40; n++) {
			const file = n % 2 ? home : task;
			const sender = who(w, id, file, "");
			if (sender.guard && file === task) sender.guard.task = { queueId: "synthetic-queue", taskId: 318 };
			expect(
				await w.host.send(sender, { to: "beta", kind: "request", text: `send ${n}` }, tc()),
				`send ${n}`,
			).toMatchObject({ ok: true });
			await w.rm.tick();
		}
		expect(w.rm.hourlyCount(id)).toBe(40);
		if (mode === "ready") expect((await stateOf(w)).usage.filter((u) => u.origin === id)).toHaveLength(40);
	});

	it.each(["ready", "unavailable"])("qa's 21st keeps its exact text and rolling window, approvals %s", async (mode) => {
		const w = await world();
		const home = addRole(w, "qa");
		const task = chat("qa-task");
		if (mode === "unavailable") await unavailable(w);
		for (let n = 1; n <= 20; n++)
			expect(await send(w, "qa", n % 2 ? home : task, "beta", {}, "")).toMatchObject({ ok: true });
		const refusal = {
			ok: false,
			error:
				"Not sent: qa has sent 20 role messages in the last hour (the limit is 20). Ask the owner before sending more.",
			...(mode === "ready" ? { reason: "ordinary_hourly" } : {}),
		};
		const forge = { role: "ops", from: "temper" };
		expect(await send(w, "qa", home, "beta", forge, "")).toEqual(refusal);
		setNow(now + 3_600_000 - 1);
		expect(await send(w, "qa", task, "beta", forge, "")).toEqual(refusal);
		setNow(now + 1);
		expect(await send(w, "qa", task, "beta", forge, "")).toMatchObject({ ok: true });
	});

	it.each([
		[981, "ready"],
		[5000, "ready"],
		[981, "unavailable"],
		[5000, "unavailable"],
	])(
		"history rotation after %s Ops sends keeps qa capped, approvals %s",
		async (count, mode) => {
			const w = await world();
			const home = addRole(w, "qa");
			const ops = addRole(w, "ops");
			if (mode === "unavailable") await unavailable(w);
			// Exercise the native fallback writer without 5,000 transport/approval transactions.
			// Only delivery completion is synthetic; every acceptance and save is real.
			const deliver = (id: string, file: string, text: string) => {
				const sent = w.rm.send(who(w, id, file, ""), { to: "beta", kind: "fyi", text });
				expect(sent.ok).toBe(true);
				if (!sent.ok) throw new Error(sent.error);
				sent.record.state = "delivered";
			};
			for (let n = 0; n < 20; n++) deliver("qa", home, `qa-${n}`);
			for (let n = 0; n < Number(count); n++) deliver("ops", ops, `ops-${n}`);
			w.rm.setPaused(false);
			const refusal = {
				ok: false,
				error:
					"Not sent: qa has sent 20 role messages in the last hour (the limit is 20). Ask the owner before sending more.",
				...(mode === "ready" ? { reason: "ordinary_hourly" } : {}),
			};
			expect(await send(w, "qa", home, "beta", {}, "")).toEqual(refusal);
			if (mode === "ready") {
				// Every new generation uses freshState(): carry-over is time-based, not count-trimmed.
				const fresh = (w.host as unknown as { freshState(): GuardStoreState }).freshState();
				expect(fresh.usage.filter((u) => u.origin === "qa")).toHaveLength(20);
			}
			w.rm.stop();
			w.rm = new RoleMessages(
				join(data, "role-messages.json"),
				{
					roles: () => w.roles,
					chatState: () => "working",
					deliver: async () => ({ ok: true }),
					note: async () => ({ ok: true }),
					log: () => {},
				},
				() => now,
			);
			try {
				expect(await send(w, "qa", home, "beta", {}, "")).toEqual(refusal);
			} finally {
				w.rm.stop();
			}
		},
		30_000,
	); // Real native save/rename for every send; no elapsed-time assertion.

	it("ops still needs a grant at hop 7", async () => {
		const w = await world();
		const home = addRole(w, "ops");
		await nextOpsHop7(w, home);
		expect(await send(w, "ops", home, "beta")).toMatchObject({
			ok: false,
			reason: "approval_required",
			approvalRequired: { hop: 7, tier: "lower", approver: "the COO" },
		});
	});

	it("a journal written by the pre-change store reloads its live grant and usage, then permits ops's 21st", async () => {
		let w = await world();
		const home = addRole(w, "ops");
		await nextOpsHop7(w, home);
		const asked = await ask(w, "ops", home, ["beta"]);
		expect(asked.ok).toBe(true);
		const request = (await stateOf(w)).requests[0];
		expect(await cooDecides(w, request.binding.requestId, "one_send")).toMatchObject({ ok: true });
		while (w.rm.hourlyCount("ops") < 20) expect(await send(w, "ops", home, "beta", {}, "")).toMatchObject({ ok: true });
		const before = await stateOf(w);
		const grantId = before.requests[0].grantId;
		expect(before.grants.find((g) => g.id === grantId)?.acceptedUses).toBe(0);
		const gen = join(data, "role-message-guard", "gen-1");
		const legacy = JSON.parse(readFileSync(join(gen, "accepted.json"), "utf8"));
		w.host.stop();
		w.rm.stop();
		// Immutable original writer from 2efa5834: no exemption or candidate serializer involved.
		const oldDir = join(data, "before-change");
		mkdirSync(oldDir);
		const old = new BeforeChangeStore({
			journalPath: join(oldDir, "journal.json"),
			legacyPath: join(oldDir, "accepted.json"),
			maximumBytes: 16 * 1024 * 1024,
			withExclusive: (work) => work(),
			boundary: null,
		});
		expect((await old.initialize(before, legacy)).state).toBe("ready");
		copyFileSync(join(oldDir, "journal.json"), join(gen, "journal.json"));
		copyFileSync(join(oldDir, "accepted.json"), join(gen, "accepted.json"));
		w = await world(w);
		expect(await stateOf(w)).toEqual(before);
		expect(GUARD_POLICY.ordinary).toEqual({ acceptedPerOrigin: 20, rollingWindowMs: 3600000 });
		expect(w.rm.hourlyCount("ops")).toBe(20);
		expect(await send(w, "ops", home, "beta")).toMatchObject({ ok: true, record: { chain: 7 } });
		expect(w.rm.hourlyCount("ops")).toBe(21);
		expect((await stateOf(w)).grants.find((g) => g.id === grantId)?.acceptedUses).toBe(1);
		expect(await send(w, "ops", home, "beta", { grant: grantId })).toMatchObject({
			ok: false,
			reason: "grant_exhausted",
		});
	});
});
