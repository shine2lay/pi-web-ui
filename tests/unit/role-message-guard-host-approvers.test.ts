// role-message-ladder (#122): the approval ladder wired over the native role messages, stage by stage on fixed
// cases (rule 16): who approves. Shared world: role-message-guard-host-harness.ts (Ops #230 split the one host test
// file so vitest runs its parts side by side; docs/test-speed.md).
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	ask,
	C,
	chainTo,
	cooDecides,
	data,
	homes,
	lastIn,
	send,
	tc,
	useGuardWorld,
	who,
	type World,
	world,
} from "./role-message-guard-host-harness.js";

useGuardWorld();

describe("ladder: who approves", () => {
	it("no self-approval: the requester can't decide its own request", async () => {
		const w = await world();
		const at = await chainTo(w, 7);
		const req = await ask(w, at.from, at.file, [at.to]);
		const self = await w.host.approval(
			who(w, at.from, at.file),
			{ action: "decide", requestId: (req.details as { requestId: string }).requestId, choice: "requested_quantity" },
			tc(),
		);
		expect(self.ok).toBe(false);
		expect(await send(w, at.from, at.file, at.to)).toMatchObject({ ok: false, approvalRequired: { hop: 7 } });
	});

	it("the COO asking for itself goes to the owner", async () => {
		const w = await world();
		// coo and beta talk; the 7th falls to the coo.
		let from = "coo";
		let to = "beta";
		for (let h = 1; h < 7; h++) {
			expect(await send(w, from, homes()[from], to)).toMatchObject({ ok: true });
			[from, to] = [to, from];
		}
		expect(from).toBe("coo");
		const seventhCoo = await send(w, "coo", C, "beta");
		expect(seventhCoo).toMatchObject({ ok: false, approvalRequired: { hop: 7, approver: "the owner" } });
		const req = await ask(w, "coo", C, ["beta"]);
		expect(req).toMatchObject({ ok: true, details: { tier: "owner" } });
		expect((await w.host.openQuestions()).map((q) => q.requesterRole)).toEqual(["coo"]);
	});

	it("owner tier: question only (no agent message, no charge); browser answer grants 12-16 at most", async () => {
		const w = await world();
		const at = await chainTo(w, 7);
		const r = await ask(w, at.from, at.file, [at.to]);
		await cooDecides(w, (r.details as { requestId: string }).requestId, "requested_quantity");
		let { from, to } = at;
		for (let h = 7; h <= 11; h++) {
			expect(await send(w, from, homes()[from], to)).toMatchObject({ ok: true });
			[from, to] = [to, from];
		}
		const before = w.rm.recent(0).length;
		const cooTurns = w.got.filter((g) => g.file === C).length;
		const req = await ask(w, from, homes()[from], [to]);
		expect(req).toMatchObject({ ok: true, details: { tier: "owner", quantity: 5, upperHop: 16 } });
		expect(w.rm.recent(0).length).toBe(before); // nothing sent to an agent for the owner's question
		expect(w.got.filter((g) => g.file === C).length).toBe(cooTurns);
		expect(w.changed).toBeGreaterThan(0);
		const [q] = await w.host.openQuestions();
		expect(q.ownerQuestion.choices).toEqual(["deny", "one_send", "requested_quantity"]);
		// A plugin pretending to be the browser is refused; only the page's own command (source "browser") counts.
		expect(
			await w.hub.answer(q.questionId, [{ id: q.generation, selected: ["requested_quantity"] }], "browser"),
		).toMatchObject({ ok: false });
		expect(await w.host.ownerAnswer(q.questionId, q.generation, "requested_quantity", "browser")).toEqual({ ok: true });
		await w.rm.tick();
		expect(await w.host.ownerAnswer(q.questionId, q.generation, "deny", "telegram")).toMatchObject({ ok: false });
		expect(await w.host.openQuestions()).toEqual([]);
		for (let h = 12; h <= 16; h++) {
			expect(await send(w, from, homes()[from], to), `hop ${h}`).toMatchObject({ ok: true });
			[from, to] = [to, from];
		}
		expect(await send(w, from, homes()[from], to)).toMatchObject({ ok: false });
	});

	it("Telegram: only the authorised plugin's answer counts", async () => {
		const w = await world();
		const at = await chainTo(w, 7);
		const r = await ask(w, at.from, at.file, [at.to]);
		await cooDecides(w, (r.details as { requestId: string }).requestId, "requested_quantity");
		let { from, to } = at;
		for (let h = 7; h <= 11; h++) {
			await send(w, from, homes()[from], to);
			[from, to] = [to, from];
		}
		await ask(w, from, homes()[from], [to]);
		const [q] = await w.host.openQuestions();
		expect(w.hub.get(q.questionId)).toBeTruthy();
		expect(await w.hub.answer(q.questionId, [{ id: q.generation, selected: ["one_send"] }], "company")).toMatchObject({
			ok: false,
		});
		expect(await w.hub.answer(q.questionId, [{ id: q.generation, selected: ["one_send"] }], "telegram")).toMatchObject({
			ok: true,
		});
		await w.rm.tick();
		expect(await send(w, from, homes()[from], to)).toMatchObject({ ok: true });
		expect(await send(w, from, homes()[from], to, {}, lastIn(w, homes()[from]))).toMatchObject({ ok: false });
	});

	it("the COO's one explicit escalation goes to the owner as a question", async () => {
		const w = await world();
		const at = await chainTo(w, 7);
		const req = await ask(w, at.from, at.file, [at.to]);
		const esc = await cooDecides(w, (req.details as { requestId: string }).requestId, "escalate_owner");
		expect(esc).toMatchObject({ ok: true });
		const qs = await w.host.openQuestions();
		expect(qs).toHaveLength(1);
		expect(qs[0].request.binding.generation.startsWith("owner-escalation-")).toBe(true);
		expect(await w.host.ownerAnswer(qs[0].questionId, qs[0].generation, "one_send", "browser")).toEqual({ ok: true });
		await w.rm.tick();
		expect(await send(w, at.from, at.file, at.to, {}, lastIn(w, at.file))).toMatchObject({ ok: true });
	});
});

// Ops #257 (N2): approvals can turn off while a call awaits (another call failed, another server took the lock).
// The call then answers plainly that they are off, never with a raw error, and never says a notice or dialog went.
describe("ladder: approvals turning off during an approval call (Ops #257, N2)", () => {
	const OFF = "another call turned approvals off";
	type Calls = Record<string, (...a: unknown[]) => Promise<unknown>>;
	/** Approvals turn off, as when another call fails meanwhile, once the host's next `name` call has finished. */
	function offAfter(w: World, of: "agent" | "native" | "host", name: string): void {
		const h = w.host as unknown as Calls & { adapters: Record<"agent" | "native", Calls>; degrade(r: string): void };
		const target: Calls = of === "host" ? h : h.adapters[of];
		const orig = target[name];
		target[name] = async function (this: unknown, ...a: unknown[]) {
			target[name] = orig;
			const r = await orig.apply(this, a);
			h.degrade(OFF);
			return r;
		};
	}
	const offText = (r: { ok: boolean; text: string }, reason = OFF) => {
		expect(r.ok).toBe(false);
		expect(r.text).toContain(`Approvals turned off meanwhile (${reason}).`);
		expect(r.text).not.toMatch(/Cannot read|gets a dialog|gets your answer|Asked the/);
		return r.text;
	};
	async function asked(w: World) {
		const at = await chainTo(w, 7);
		const req = await ask(w, at.from, at.file, [at.to]);
		expect(req).toMatchObject({ ok: true, details: { tier: "lower" } });
		return { at, id: (req.details as { requestId: string }).requestId };
	}
	const turnsIn = (w: World, file: string) => w.got.filter((g) => g.file === file && g.via === "deliver").length;

	it("during a decision: recorded, and the requester isn't said to be told", async () => {
		const w = await world();
		const { at, id } = await asked(w);
		const turns = turnsIn(w, at.file);
		offAfter(w, "agent", "roleDecision");
		expect(offText(await cooDecides(w, id, "requested_quantity"))).toContain(
			`Your requested_quantity for ${id} was recorded, but the requester wasn't told.`,
		);
		expect(turnsIn(w, at.file)).toBe(turns);
		expect(w.host.state).toEqual({ status: "degraded", reason: OFF });
	});

	it("during a pass to the owner: recorded, and no dialog is said to be shown", async () => {
		const w = await world();
		const { id } = await asked(w);
		offAfter(w, "agent", "roleDecision");
		expect(offText(await cooDecides(w, id, "escalate_owner"))).toContain(
			`Your escalate_owner for ${id} was recorded, but the owner wasn't shown his dialog.`,
		);
	});

	it("during a request's first read: nothing asked or recorded", async () => {
		const w = await world();
		const at = await chainTo(w, 7);
		const cooTurns = turnsIn(w, C);
		offAfter(w, "host", "state_");
		expect(offText(await ask(w, at.from, at.file, [at.to]))).toContain("Nothing was asked or recorded.");
		expect(turnsIn(w, C)).toBe(cooTurns);
	});

	it("during a request: recorded, and the COO isn't said to be asked", async () => {
		const w = await world();
		const at = await chainTo(w, 7);
		const cooTurns = turnsIn(w, C);
		offAfter(w, "agent", "request");
		expect(offText(await ask(w, at.from, at.file, [at.to]))).toMatch(
			/Request cr-\w+ was recorded, but the COO wasn't asked\./,
		);
		expect(turnsIn(w, C)).toBe(cooTurns);
	});

	it("another server takes the lock before a decision: a plain answer, not the raw error", async () => {
		const w = await world();
		const { id } = await asked(w);
		const lock = join(data, "role-message-guard", "lock");
		rmSync(lock);
		writeFileSync(lock, `${process.ppid}\n`);
		offText(
			await cooDecides(w, id, "requested_quantity"),
			`another server (pid ${process.ppid}) took the guard's lock`,
		);
	});

	it("during the owner's answer: a plain error, not the raw one", async () => {
		const w = await world();
		let from = "coo";
		let to = "beta";
		for (let h = 1; h < 7; h++) {
			expect(await send(w, from, homes()[from], to)).toMatchObject({ ok: true });
			[from, to] = [to, from];
		}
		expect(await ask(w, "coo", C, ["beta"])).toMatchObject({ ok: true, details: { tier: "owner" } });
		const [q] = await w.host.openQuestions();
		offAfter(w, "host", "exclusive");
		const r = await w.host.ownerAnswer(q.questionId, q.generation, "one_send", "browser");
		expect(r).toEqual({
			ok: false,
			error: `Approvals turned off meanwhile (${OFF}). Your answer was saved but not applied; ask Ops.`,
		});
	});
});
