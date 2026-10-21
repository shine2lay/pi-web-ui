// role-message-ladder (#122): the approval ladder wired over the native role messages, stage by stage on fixed
// cases (rule 16): storage caps (b)-(f) and the approval history. Case (a), the worst-window replay, is in
// role-message-guard-host-worst-window.test.ts. Shared world: role-message-guard-host-harness.ts (Ops #230 split the
// one host test file so vitest runs its parts side by side; docs/test-speed.md).
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { GUARD_FILE_MAX_BYTES, GUARD_RETENTION, type GuardHistoryLine } from "../../server/role-message-guard-host.js";
import type { GuardStoreState } from "../../server/role-message-guard-contract.js";
import {
	A,
	ask,
	B,
	chainTo,
	context,
	cooDecides,
	data,
	G,
	homes,
	lastIn,
	now,
	send,
	setNow,
	tc,
	useGuardWorld,
	who,
	world,
	type World,
} from "./role-message-guard-host-harness.js";

useGuardWorld();

// Ops cap decision rm-efd6df89, fixed cases (a)-(f) (hypothesis H-ROLE-LADDER-CAPS-1).
describe("ladder: storage caps", () => {
	const stateOf = (w: World) =>
		(w.host as unknown as { state_(): Promise<GuardStoreState | null> }).state_().then((s) => s!);

	it("(b) 15 roles with 20 open requests each fit the open-request cap at half", () => {
		// E refuses a 21st open request per role (request_capacity); the store cap counts only open ones.
		expect(15 * 20).toBeLessThanOrEqual(GUARD_RETENTION.maximumRequests / 2);
		expect(15 * 20).toBeLessThanOrEqual(GUARD_RETENTION.maximumGrants / 2);
		expect(GUARD_FILE_MAX_BYTES).toBe(16 * 1024 * 1024);
	});

	it("(c) usage older than an hour is pruned (never kept past 65 minutes)", async () => {
		const w = await world();
		for (let i = 0; i < 3; i++) expect(await send(w, "alpha", A, "beta", {}, "")).toMatchObject({ ok: true });
		expect((await stateOf(w)).usage.length).toBeGreaterThanOrEqual(3);
		setNow(now + 65 * 60_000);
		expect(await send(w, "beta", B, "alpha", {}, "")).toMatchObject({ ok: true });
		const usage = (await stateOf(w)).usage;
		expect(usage.every((u) => now - u.committedAt < 65 * 60_000)).toBe(true);
		expect(usage.length).toBeLessThan(3);
	});

	it("(d) a full store refuses with the store's name, counts nothing, and warns once at 80%", async () => {
		// An open approval request stops rotation (it waits for quiescence), so the store can fill.
		const w = await world(undefined, { retention: { ...GUARD_RETENTION, maximumTransactions: 60 } });
		const at = await chainTo(w, 7);
		expect(await ask(w, at.from, at.file, [at.to])).toMatchObject({ ok: true });
		let full: Awaited<ReturnType<typeof send>> | null = null;
		let before = { records: 0, hour: 0 };
		let from = "";
		for (let i = 0; i < 30 && !full; i++) {
			from = i % 2 ? "gamma" : "beta";
			before = { records: w.rm.recent(0).length, hour: w.rm.hourlyCount(from) };
			const r = await send(w, from, homes()[from], "coo", {}, "");
			if (!r.ok) full = r;
		}
		expect(full).toMatchObject({ ok: false, reason: "retention_capacity" });
		const error = (full as { error: string }).error;
		expect(error).toMatch(/storage is full \(transactions: \d+ of 60\)/);
		expect(error).toContain("Tell Ops");
		expect({ records: w.rm.recent(0).length, hour: w.rm.hourlyCount(from) }).toEqual(before);
		const warnings = w.logs.filter((l) => l.includes("WARNING: transactions"));
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toMatch(/at (8\d|9\d|100)% \(\d+ of 60\)/);
	});

	it("(e) a context over 16 KB is refused whole with its size; 16 KB passes the size check", async () => {
		const w = await world();
		const at = await chainTo(w, 7);
		const sized = (bytes: number) => {
			const c = { ...context, goal: "" };
			c.goal = "g".repeat(bytes - Buffer.byteLength(JSON.stringify(c)));
			expect(Buffer.byteLength(JSON.stringify(c))).toBe(bytes);
			return c;
		};
		const over = await w.host.approval(
			who(w, at.from, at.file),
			{ action: "request", recipients: [at.to], context: sized(16385) },
			tc(),
		);
		expect(over).toMatchObject({ ok: false, details: { reason: "context_too_large", bytes: 16385 } });
		expect(over.text).toContain("16385 bytes; at most 16384");
		expect((await stateOf(w)).requests).toHaveLength(0);
		const edge = await w.host.approval(
			who(w, at.from, at.file),
			{ action: "request", recipients: [at.to], context: sized(16384) },
			tc(),
		);
		expect(edge.details?.reason).not.toBe("context_too_large");
	});

	it("(f) a reply to a message the store has pruned keeps its hop (and a restart keeps it)", async () => {
		const w = await world();
		await chainTo(w, 4); // alpha 1 -> beta 2 -> alpha 3 -> beta; beta's next is hop 4
		const real = w.rm.recent(0).map((m) => m.id);
		expect(real).toHaveLength(3);
		const betaLast = lastIn(w, B);
		// Ops #318: recent capped-role rows are hourly proof; only age-expired chain rows may rotate.
		setNow(now + 3_600_000);
		w.rm.stop();
		const file = join(data, "role-messages.json");
		const stored = JSON.parse(readFileSync(file, "utf8")) as { messages: Array<Record<string, unknown>> };
		const m0 = stored.messages[0];
		for (let i = 0; i < 1000; i++)
			stored.messages.push({
				...m0,
				id: `rm-f${i.toString(16).padStart(7, "0")}`,
				from: { ...(m0.from as object), role: "filler" },
				to: "filler",
				at: now - 2 * 86_400_000,
				state: "delivered",
			});
		writeFileSync(file, JSON.stringify(stored));
		const w2 = await world(w);
		// An unrelated send saves the store, which drops the oldest records: the whole real chain.
		expect(await send(w2, "gamma", G, "coo", {}, "")).toMatchObject({ ok: true });
		for (const id of real) expect(w2.rm.byId(id), id).toBeUndefined();
		for (const id of real) expect(w2.rm.chainFact(id), id).toBeDefined();
		expect(existsSync(join(data, "role-messages-chains.jsonl"))).toBe(true);
		// Before the chain memory this was "can't be proved" (the native code even reset it to hop 0).
		expect(await send(w2, "beta", B, "alpha", {}, betaLast)).toMatchObject({ ok: true }); // hop 4
		expect(w2.rm.handlingDepth(B, betaLast)).toBe(3);
		const w3 = await world(w2); // a restart reads the chain memory back
		for (const id of real) expect(w3.rm.chainFact(id), id).toBeDefined();
		let from = "alpha";
		let to = "beta";
		for (let h = 5; h <= 6; h++) {
			expect(await send(w3, from, homes()[from], to), `hop ${h}`).toMatchObject({ ok: true });
			[from, to] = [to, from];
		}
		expect(await send(w3, from, homes()[from], to)).toMatchObject({
			ok: false,
			approvalRequired: { hop: 7, tier: "lower" },
		});
	});

	it("approval history: metadata only, one line per change, and a write failure never blocks", async () => {
		const w = await world();
		const at = await chainTo(w, 7);
		const req = await ask(w, at.from, at.file, [at.to]);
		await cooDecides(w, (req.details as { requestId: string }).requestId, "requested_quantity");
		expect(await send(w, at.from, at.file, at.to)).toMatchObject({ ok: true });
		const path = join(data, "role-message-guard", "history.jsonl");
		const raw = readFileSync(path, "utf8");
		const events = raw
			.trim()
			.split("\n")
			.map((l) => (JSON.parse(l) as GuardHistoryLine).event);
		expect(events).toEqual(["request", "decision", "grant", "grant_use"]);
		expect(raw).not.toContain(context.goal);
		// The history file can't be written (a folder in its place): sends and approvals go on.
		rmSync(path);
		mkdirSync(path);
		expect(await send(w, at.to, homes()[at.to], at.from)).toMatchObject({ ok: true });
		expect(w.logs.some((l) => l.includes("history not written"))).toBe(true);
	});
});
