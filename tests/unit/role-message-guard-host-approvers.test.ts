// role-message-ladder (#122): the approval ladder wired over the native role messages, stage by stage on fixed
// cases (rule 16): who approves. Shared world: role-message-guard-host-harness.ts (Ops #230 split the one host test
// file so vitest runs its parts side by side; docs/test-speed.md).
import { describe, expect, it } from "vitest";
import {
	ask,
	C,
	chainTo,
	cooDecides,
	homes,
	lastIn,
	send,
	tc,
	useGuardWorld,
	who,
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
