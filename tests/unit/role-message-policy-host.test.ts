// Ops #453: synthetic files/roles/clock only. Real native, host, adapters, core and atomic store.
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { GuardStoreStateAny } from "../../server/role-message-guard-contract-v2.js";
import { GuardFileStore } from "../../server/role-message-guard-store.js";
import { GUARD_POLICY_V1, GUARD_POLICY_V2, ROLE_MESSAGE_POLICY } from "../../server/role-message-limits.js";
import { RoleMessages, ROLE_MESSAGES_KEEP } from "../../server/role-messages.js";
import { GuardFileStore as PreviousReader } from "./role-message-guard-store-reference.js";
import {
	A,
	B,
	ask,
	chainTo,
	chat,
	clock,
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
const stateOf = (w: World) => (w.host as unknown as { state_(): Promise<GuardStoreStateAny | null> }).state_();
const addRole = (w: World, id: string) => {
	const home = chat(`${id}-home`);
	w.roles.push(role(id, home));
	return home;
};
async function degrade(w: World) {
	writeFileSync(join(data, "role-message-guard", "lock"), `${process.ppid}\n`);
	await stateOf(w);
	expect(w.host.state.status).toBe("degraded");
}
async function attempt(w: World, mode: string, id: string, file: string, n: number) {
	const sender = who(w, id, file, "");
	const input = { to: "beta", kind: "fyi", text: `${id}-${n}` };
	return mode === "native" ? w.rm.send(sender, input) : w.host.send(sender, input, tc());
}

describe("expanded policy across native, ready and unavailable dispatch", () => {
	it("the deployed default selects V2 only after compatibility-reader installation", () => {
		expect(ROLE_MESSAGE_POLICY).toBe(GUARD_POLICY_V2);
	});
	it.each(["native", "ready", "unavailable"])("40/41 and exact rolling-hour edge, mode %s", async (mode) => {
		const w = await world(undefined, { policy: GUARD_POLICY_V2 });
		const qa = addRole(w, "qa");
		const task = chat("qa-task");
		if (mode === "unavailable") await degrade(w);
		const start = now;
		for (let n = 0; n < 40; n++) expect(await attempt(w, mode, "qa", n % 2 ? qa : task, n)).toMatchObject({ ok: true });
		expect(await attempt(w, mode, "qa", qa, 41)).toMatchObject({
			ok: false,
			error:
				"Not sent: qa has sent 40 role messages in the last hour (the limit is 40). Ask the owner before sending more.",
		});
		setNow(start + 3_600_000 - 1);
		expect(await attempt(w, mode, "qa", task, 42)).toMatchObject({ ok: false });
		setNow(start + 3_600_000);
		expect(await attempt(w, mode, "qa", task, 43)).toMatchObject({ ok: true });
		expect(w.rm.hourlyCount("qa")).toBe(1);
	});
	it.each(["ops", "temper"])("%s exceeds 40 but still needs a grant at 13", async (id) => {
		const w = await world(undefined, { policy: GUARD_POLICY_V2 });
		const home = addRole(w, id);
		for (let n = 0; n < 41; n++) expect(await attempt(w, "ready", id, home, n)).toMatchObject({ ok: true });
		expect(w.rm.hourlyCount(id)).toBe(41);
		for (let h = 1; h <= 12; h++)
			expect(
				await send(w, h % 2 ? id : "beta", h % 2 ? home : B, h % 2 ? "beta" : id, {}, h === 1 ? "" : undefined),
			).toMatchObject({ ok: true });
		expect(await send(w, id, home, "beta")).toMatchObject({ ok: false, approvalRequired: { hop: 13, tier: "lower" } });
	});
	it.each(["native", "unavailable"])("without approvals the active free boundary is 12, mode %s", async (mode) => {
		const w = await world(undefined, { policy: GUARD_POLICY_V2 });
		if (mode === "unavailable") await degrade(w);
		// Native causal input is its server-derived handling stamp, not tool fields.
		const sender = { ...who(w, "alpha", A, ""), handling: 11 };
		if (mode === "native") {
			expect(w.rm.send(sender, { to: "beta", kind: "fyi", text: "at12" })).toMatchObject({
				ok: true,
				record: { chain: 12 },
			});
			expect(w.rm.send({ ...sender, handling: 12 }, { to: "beta", kind: "fyi", text: "at13" })).toMatchObject({
				ok: false,
				error: expect.stringContaining("message 13 in one chain"),
			});
		} else {
			expect(await w.host.send(sender, { to: "beta", kind: "fyi", text: "at12" }, tc())).toMatchObject({
				ok: true,
				record: { chain: 12 },
			});
			expect(
				await w.host.send({ ...sender, handling: 12 }, { to: "beta", kind: "fyi", text: "at13" }, tc()),
			).toMatchObject({ ok: false, error: expect.stringContaining("message 13 in one chain") });
		}
	});
	it.each(["ready", "unavailable"])(
		"exempt flood cannot evict two capped roles' 40 recent charges, mode %s",
		async (mode) => {
			const w = await world(undefined, { policy: GUARD_POLICY_V2 });
			const qa = addRole(w, "qa");
			const design = addRole(w, "design");
			const ops = addRole(w, "ops");
			if (mode === "unavailable") await degrade(w);
			const deliver = (id: string, file: string, n: number) => {
				const sent = w.rm.send(who(w, id, file, ""), { to: "beta", kind: "fyi", text: `${id}-${n}` });
				if (!sent.ok) throw new Error(sent.error);
				sent.record.state = "delivered";
			};
			for (let n = 0; n < 40; n++) {
				deliver("qa", qa, n);
				deliver("design", design, n);
			}
			for (let n = 0; n < 5000; n++) deliver("ops", ops, n);
			w.rm.setPaused(false);
			expect(w.rm.hourlyCount("qa")).toBe(40);
			expect(w.rm.hourlyCount("design")).toBe(40);
			const rows = JSON.parse(readFileSync(join(data, "role-messages.json"), "utf8")).messages;
			expect(rows).toHaveLength(ROLE_MESSAGES_KEEP + 80);
			if (mode === "ready") {
				const fresh = (w.host as unknown as { freshState(): GuardStoreStateAny }).freshState();
				expect(fresh.usage.filter((u) => u.origin === "qa")).toHaveLength(40);
				expect(fresh.usage.filter((u) => u.origin === "design")).toHaveLength(40);
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
				clock,
				GUARD_POLICY_V2,
			);
			try {
				expect(await attempt(w, mode, "qa", qa, 41)).toMatchObject({ ok: false });
				expect(await attempt(w, mode, "design", design, 41)).toMatchObject({ ok: false });
				setNow(now + 3_600_000);
				expect(await attempt(w, mode, "qa", qa, 42)).toMatchObject({ ok: true });
			} finally {
				w.rm.stop();
			}
		},
	);
});

describe("expanded real approval path and mixed-version journals", () => {
	it("12 free / 13 lower / 22 last lower / 23 Owner; quantity10 exact, 11 refused, no automatic send", async () => {
		const w = await world(undefined, { policy: GUARD_POLICY_V2 });
		let next = await chainTo(w, 13);
		expect(await send(w, next.from, next.file, next.to)).toMatchObject({
			ok: false,
			approvalRequired: { hop: 13, tier: "lower" },
		});
		expect(await ask(w, next.from, next.file, ["alpha", "beta"], 11)).toMatchObject({ ok: false });
		expect((await stateOf(w))!.requests).toHaveLength(0);
		expect(await ask(w, next.from, next.file, ["alpha", "beta"], 10)).toMatchObject({ ok: true });
		const r = (await stateOf(w))!.requests[0];
		expect(r.binding).toMatchObject({ version: GUARD_POLICY_V2.version, quantity: 10, upperHop: 22 });
		expect(
			await w.host.approval(
				who(w, "alpha", A),
				{
					action: "decide",
					requestId: r.binding.requestId,
					generation: "1",
					choice: "requested_quantity",
					reason: "self",
				},
				tc(),
			),
		).toMatchObject({ ok: false });
		expect(await cooDecides(w, r.binding.requestId, "requested_quantity")).toMatchObject({ ok: true });
		for (let hop = 13; hop <= 22; hop++) {
			expect(await send(w, next.from, next.file, next.to)).toMatchObject({ ok: true, record: { chain: hop } });
			next = next.from === "alpha" ? { from: "beta", file: B, to: "alpha" } : { from: "alpha", file: A, to: "beta" };
		}
		expect(await send(w, next.from, next.file, next.to)).toMatchObject({
			ok: false,
			approvalRequired: { hop: 23, tier: "owner" },
		});
		expect(await ask(w, next.from, next.file, ["alpha", "beta"], 10)).toMatchObject({ ok: true });
		const owner = (await stateOf(w))!.requests.find((v) => v.binding.tier === "owner")!;
		expect(owner.binding).toMatchObject({ quantity: 10, upperHop: 32 });
		expect((await stateOf(w))!.grants).toHaveLength(1);
		expect((await w.host.openQuestions())[0].ownerQuestion.binding.quantity).toBe(10);
	});
	it("strict previous reader rejects V2; compatibility reader with V1 active reads the same bytes and preserves exact old authority", async () => {
		let w = await world();
		const next = await chainTo(w, 7);
		expect(await ask(w, next.from, next.file, ["alpha", "beta"], 3)).toMatchObject({ ok: true });
		const old = (await stateOf(w))!.requests[0];
		expect(await cooDecides(w, old.binding.requestId, "requested_quantity")).toMatchObject({ ok: true });
		const before = (await stateOf(w))!;
		w.host.stop();
		w.rm.stop();
		w = await world(w, { policy: GUARD_POLICY_V2 });
		expect((await stateOf(w))!.grants).toEqual(before.grants);
		// A new unrelated chain uses the widened policy, with no enlargement/reissue of the old grant.
		for (let hop = 1; hop < 13; hop++)
			expect(
				await send(
					w,
					hop % 2 ? "alpha" : "beta",
					hop % 2 ? A : B,
					hop % 2 ? "beta" : "alpha",
					{},
					hop === 1 ? "" : undefined,
				),
			).toMatchObject({ ok: true });
		expect(await ask(w, "alpha", A, ["alpha", "beta"], 10)).toMatchObject({ ok: true });
		const mixed = (await stateOf(w))!;
		expect(mixed.grants).toEqual(before.grants);
		expect(mixed.requests.find((r) => r.binding.requestId === old.binding.requestId)).toEqual(before.requests[0]);
		const gen = join(data, "role-message-guard", "gen-1");
		const copy = join(data, "reader-proof");
		mkdirSync(copy);
		for (const name of ["journal.json", "accepted.json"]) copyFileSync(join(gen, name), join(copy, name));
		const options = {
			journalPath: join(copy, "journal.json"),
			legacyPath: join(copy, "accepted.json"),
			maximumBytes: 16 * 1024 * 1024,
			withExclusive: <T>(work: () => Promise<T>) => work(),
			boundary: null,
		};
		const names = ["journal.json", "accepted.json"];
		const bytes = names.map((name) => readFileSync(join(copy, name)));
		expect(await new PreviousReader(options).recover()).toMatchObject({
			state: "unknown",
			reason: "corrupt guard journal or unsupported schema",
		});
		const compatible = new GuardFileStore(options);
		expect(await compatible.recover()).toMatchObject({ state: "ready" });
		const good = await compatible.read();
		expect(good).toMatchObject({ state: "ready" });
		if (good.state === "ready") expect(good.value).toEqual(mixed);
		expect(names.map((name) => readFileSync(join(copy, name)))).toEqual(bytes);
		w.host.stop();
		w.rm.stop();
		w = await world(w, { policy: GUARD_POLICY_V1 });
		expect((await stateOf(w))!).toEqual(mixed);
	});
});
