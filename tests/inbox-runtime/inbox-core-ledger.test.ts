import { writeFileSync } from "node:fs";
import { expect, it } from "vitest";
import { InboxRuntime, type InboxClaim } from "../../server/inbox-runtime.js";
import type { InboxOutcome } from "../../server/shared/inbox-wire.js";
import { A, B, chat, send, useGuardWorld, who } from "../unit/role-message-guard-host-harness.js";
import { core, seed, view } from "./inbox-core-fixture.js";
import { claimOf, setup } from "./inbox-world.js";

useGuardWorld();
it("HOME ordinary request accepts one real reply and rejects a second", async () => {
	const h = await setup();
	const claim = claimOf(await h.runtime.claim(h.key, { kind: "home", role: "beta", session: B }));
	const reply = { kind: "reply" as const, replyTo: h.id, to: "alpha", text: "HOME fixture answer" };
	const first = await h.runtime.reply(claim, who(h.w, "beta", B, ""), reply, "home-first");
	expect(first.code).toBeUndefined();
	const replyId = h.w.rm.byId(h.id)?.replyId;
	expect(typeof replyId).toBe("string");
	expect(first.resultRef).toBe(replyId);
	expect(view(h).lifecycle.state).toBe("replied");
	const second = await h.runtime.reply(claim, who(h.w, "beta", B, ""), reply, "home-second");
	expect(second.code).toBe("E_RPI_ALREADY_REPLIED");
	expect(h.w.rm.rows(Number.POSITIVE_INFINITY).filter((r) => r.kind === "reply" && r.replyTo === h.id)).toHaveLength(1);
});
for (const id of [
	"C-LEASE-1",
	"C-LEASE-2",
	"C-LEASE-3",
	"C-LEASE-4",
	"C-LEASE-5",
	"C-LEASE-6",
	"C-LEASE-7",
	"C-EFFECT-1",
	"C-EFFECT-4",
	"C-LIFE-8",
]) {
	it(`${id} real claim and guard operation replay`, async () => {
		const c = core(id),
			h = await setup();
		if (c.input.route === "home_only")
			await seed(h, (records) => {
				records.find((r) => r.id === h.id)!.forOwner = true;
			});
		const sessions = new Map<string, string>([["home", B]]);
		const session = (name: string) => {
			if (!sessions.has(name)) sessions.set(name, chat(name));
			return sessions.get(name)!;
		};
		const claims = new Map<string, InboxClaim>();
		if (c.input.holder_other_live) {
			const other = await send(h.w, "alpha", A, "beta", { text: "independent request" });
			if (!other.ok) throw new Error("Second source admission failed");
			for (const name of Object.keys(c.input.holder_other_live as object))
				claimOf(
					await h.runtime.claim(`rm:${other.record.id}`, { kind: "helper", role: "beta", session: session(name) }),
				);
		}
		const steps: string[] = [];
		for (const raw of c.input.ops as Array<Record<string, unknown>>) {
			let code: string | undefined;
			if (raw.op === "claim") {
				if (raw.reader_ok === false) writeFileSync(h.ledgerFile, '{"v":"rpi/1",');
				const holder = raw.holder as { kind: "home" | "helper"; session: string };
				const result = await h.runtime.claim(h.key, { ...holder, role: "beta", session: session(holder.session) });
				if ("code" in result) code = result.code;
				else claims.set(String(raw.as), claimOf(result));
			} else if (raw.op === "reply") {
				const claim = claims.get(String(raw.lease));
				if (!claim) throw new Error("Missing named claim");
				const result = await h.runtime.reply(
					claim,
					who(h.w, raw.caller_role === "architecture" ? "beta" : String(raw.caller_role), claim.session, ""),
					{
						kind: "reply",
						replyTo: raw.replyTo === c.input.ref ? h.id : String(raw.replyTo),
						to: raw.to === "ops" ? "alpha" : String(raw.to),
						text: "core fixture reply",
					},
					`${id}-${steps.length}`,
				);
				code = result.code;
			} else if (raw.op === "session_close" || raw.op === "release") {
				const claim = claims.get(String(raw.lease));
				if (!claim) throw new Error("Missing named claim");
				await h.runtime.end(claim, raw.op === "release" ? "released_to_home" : "crashed");
			} else if (raw.op === "restart") {
				h.runtime = new InboxRuntime(h.runtime.ports);
				await h.runtime.recover();
			} else throw new Error(`Unadapted operation ${raw.op}`);
			steps.push(code ? `refuse:${code}` : "allow");
		}
		expect(steps).toEqual(c.expect.steps);
		// The intentionally torn reader cannot expose a lifecycle; verify no lease bytes instead.
		if (id === "C-LEASE-3") {
			expect(h.w.rm.byId(h.id)?.replyId).toBeUndefined();
			return;
		}
		const item = view(h);
		if ("state" in c.expect) expect(item.lifecycle.state).toBe(c.expect.state);
		if ("route" in c.expect) expect(item.route).toBe(c.expect.route);
		if ("epoch" in c.expect) {
			const lines = h.runtime.audit("beta", "beta").filter((l) => l.key === h.key && l.op === "claim");
			expect(Math.max(0, ...lines.map((l) => ("epoch" in l ? l.epoch : 0)))).toBe(c.expect.epoch);
		}
		if ("sends" in c.expect) {
			const replyId = h.w.rm.byId(h.id)?.replyId;
			expect(replyId ? 1 : 0).toBe(c.expect.sends);
			expect(
				h.w.rm.rows(Number.POSITIVE_INFINITY).filter((r) => r.kind === "reply" && r.replyTo === h.id),
			).toHaveLength(Number(c.expect.sends));
			if (replyId) expect(h.w.rm.byId(replyId)).toMatchObject({ kind: "reply", replyTo: h.id, from: { role: "beta" } });
			if ("resultRef" in c.expect) expect(item.lifecycle.receipt.semantic).toBe(replyId);
		}
	});
}
for (const id of ["C-LIFE-1", "C-LIFE-2", "C-LIFE-3", "C-LIFE-4", "C-LIFE-5", "C-LIFE-7"]) {
	it(`${id} real source and attempt lifecycle`, async () => {
		const c = core(id),
			h = await setup();
		await seed(h, (records) => {
			const r = records.find((r) => r.id === h.id)!;
			if (c.input.rm_state) r.state = c.input.rm_state as typeof r.state;
			if (c.input.class === "turn_required") {
				r.kind = "report";
				r.script = { kind: "request" } as typeof r.script;
			}
			if (c.input.replyId) r.replyId = String(c.input.replyId);
			if (c.input.reply_record) {
				const reply = c.input.reply_record as { id: string; kind: typeof r.kind };
				records.push({
					...r,
					id: reply.id,
					kind: reply.kind,
					replyId: undefined,
					replyTo: h.id,
					from: { ...r.from, role: "beta", file: B },
					to: { ...r.to, role: "alpha" },
				});
			}
		});
		if (c.input.live_lease) claimOf(await h.runtime.claim(h.key, { kind: "home", role: "beta", session: B }));
		for (const attempt of (c.input.attempts ?? []) as Array<{ outcome: InboxOutcome }>) {
			const claim = claimOf(await h.runtime.claim(h.key, { kind: "home", role: "beta", session: B }));
			await h.runtime.end(claim, attempt.outcome);
		}
		expect(view(h).lifecycle.state).toBe(c.expect.state);
	});
}
for (const id of ["C-RETRY-1", "C-RETRY-2", "C-RETRY-3"]) {
	it(`${id} persisted attempt and alarm replay`, async () => {
		const c = core(id),
			h = await setup();
		const attempts = c.input.attempts as Array<{ outcome: InboxOutcome }>;
		for (const attempt of attempts) {
			const claim = claimOf(await h.runtime.claim(h.key, { kind: "home", role: "beta", session: B }));
			await h.runtime.end(claim, attempt.outcome);
		}
		expect(view(h).lifecycle.state).toBe(c.expect.state);
		const lines = h.runtime.audit("beta", "beta").filter((l) => l.key === h.key);
		expect(lines.filter((l) => l.op === "attempt").map((l) => l.op === "attempt" && l.outcome)).toEqual(
			attempts.map((a) => a.outcome),
		);
		expect(lines.some((l) => l.op === "alarm")).toBe(c.expect.alarm);
		if (c.expect.banned === false)
			expect(claimOf(await h.runtime.claim(h.key, { kind: "home", role: "beta", session: B })).key).toBe(h.key);
		// Scheduling/prefix are intentionally uncovered: no event/prefix boundary exists in this seam.
	});
}
