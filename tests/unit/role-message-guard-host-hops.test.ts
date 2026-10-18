// role-message-ladder (#122): the approval ladder wired over the native role messages, stage by stage on fixed
// cases (rule 16): ordinary hops and the 7th. Shared world: role-message-guard-host-harness.ts (Ops #230 split the
// one host test file so vitest runs its parts side by side; docs/test-speed.md).
import { describe, expect, it } from "vitest";
import { ROLE_MESSAGE_CHAIN_MAX } from "../../server/role-messages.js";
import {
	ask,
	C,
	chainTo,
	context,
	cooDecides,
	homes,
	lastIn,
	now,
	send,
	setNow,
	tc,
	useGuardWorld,
	who,
	world,
} from "./role-message-guard-host-harness.js";

useGuardWorld();

describe("ladder: ordinary hops and the 7th", () => {
	it("hops 1-6 go as today; hop 7 becomes an approval request (not a refusal)", async () => {
		const w = await world();
		const at = await chainTo(w, 7);
		const seventh = await send(w, at.from, at.file, at.to);
		expect(seventh).toMatchObject({ ok: false, approvalRequired: { hop: 7, tier: "lower", approver: "the COO" } });
		expect((seventh as { error: string }).error).toContain("Approval needed");
		expect(w.rm.recent(0).filter((m) => !m.guard)).toHaveLength(6);
	});

	it("FE32/H7 counterfactual: the old rule refuses the 7th hop, the ladder asks for approval", async () => {
		const w = await world();
		const at = await chainTo(w, 7);
		const last = lastIn(w, at.file);
		// Old code: the native send (still the degraded path) with its hard limit of 6.
		const old = w.rm.send(
			{ ...who(w, at.from, at.file, last), handling: w.rm.handlingDepth(at.file, last) },
			{ to: at.to, kind: "fyi", text: "done" },
		);
		expect(ROLE_MESSAGE_CHAIN_MAX).toBe(6);
		expect(old).toMatchObject({ ok: false });
		expect((old as { error: string }).error).not.toContain("Approval needed");
		const ladder = await send(w, at.from, at.file, at.to, { text: "done" });
		expect(ladder).toMatchObject({ ok: false, approvalRequired: { hop: 7, tier: "lower" } });
	});

	it("a COO grant for 7-11 is finite: 5 sends at most, never past 11; hop 12 needs the owner", async () => {
		const w = await world();
		const at = await chainTo(w, 7);
		const req = await ask(w, at.from, at.file, [at.to]);
		expect(req).toMatchObject({ ok: true, details: { tier: "lower", quantity: 5, upperHop: 11 } });
		// The COO's home got the request as a typed control message (it starts a turn there).
		expect(lastIn(w, C)).toContain(at.from);
		const requestId = (req.details as { requestId: string }).requestId;
		expect(await cooDecides(w, requestId, "requested_quantity")).toMatchObject({ ok: true });
		// The requester heard the decision; its place in the chain is unchanged (control messages don't add a hop).
		let { from, to } = at;
		for (let h = 7; h <= 11; h++) {
			const r = await send(w, from, homes()[from], to);
			expect(r, `hop ${h}: ${JSON.stringify(r).slice(0, 300)}`).toMatchObject({ ok: true });
			[from, to] = [to, from];
		}
		const twelfth = await send(w, from, homes()[from], to);
		expect(twelfth).toMatchObject({ ok: false, approvalRequired: { hop: 12, tier: "owner", approver: "the owner" } });
	});

	it("the five-send cap counts every accepted send, fan-out on one hop included", async () => {
		const w = await world();
		const at = await chainTo(w, 7);
		const req = await ask(w, at.from, at.file, [at.to, "gamma"]);
		await cooDecides(w, (req.details as { requestId: string }).requestId, "requested_quantity");
		const last = lastIn(w, at.file);
		for (let i = 0; i < 5; i++) {
			const r = await send(w, at.from, at.file, i % 2 ? "gamma" : at.to, {}, last);
			expect(r, `use ${i + 1}`).toMatchObject({ ok: true });
		}
		const sixth = await send(w, at.from, at.file, at.to, {}, last);
		expect(sixth).toMatchObject({ ok: false });
		expect((sixth as { error: string }).error).toContain("used up; ask again");
	});

	it("a grant expires after 60 minutes (no sliding, no renewal)", async () => {
		const w = await world();
		const at = await chainTo(w, 7);
		const req = await ask(w, at.from, at.file, [at.to]);
		await cooDecides(w, (req.details as { requestId: string }).requestId, "requested_quantity");
		const last = lastIn(w, at.file);
		expect(await send(w, at.from, at.file, at.to, {}, last)).toMatchObject({ ok: true });
		setNow(now + 60 * 60 * 1000);
		const late = await send(w, at.from, at.file, at.to, {}, last);
		expect(late).toMatchObject({ ok: false });
		expect((late as { error: string }).error).toContain("expired; ask again");
	});

	it("deny leaves the chain stopped; one_send allows exactly one", async () => {
		const w = await world();
		const at = await chainTo(w, 7);
		const last = lastIn(w, at.file);
		const r1 = await ask(w, at.from, at.file, [at.to], undefined, last);
		await cooDecides(w, (r1.details as { requestId: string }).requestId, "deny");
		expect(lastIn(w, at.file)).not.toBe(last); // the requester heard the answer
		expect(await send(w, at.from, at.file, at.to, {}, last)).toMatchObject({ ok: false, approvalRequired: { hop: 7 } });
		const r2 = await w.host.approval(
			who(w, at.from, at.file, last),
			{ action: "request", recipients: [at.to], context },
			"tc-second",
		);
		await w.rm.tick();
		await cooDecides(w, (r2.details as { requestId: string }).requestId, "one_send");
		expect(await send(w, at.from, at.file, at.to, {}, last)).toMatchObject({ ok: true });
		const again = await send(w, at.from, at.file, at.to, {}, last);
		expect(again).toMatchObject({ ok: false });
		expect((again as { error: string }).error).toContain("used up; ask again");
	});

	it("a send outside the grant's recipients is refused and charges nothing", async () => {
		const w = await world();
		const at = await chainTo(w, 7);
		const last = lastIn(w, at.file);
		const req = await ask(w, at.from, at.file, [at.to], undefined, last);
		const requestId = (req.details as { requestId: string }).requestId;
		await cooDecides(w, requestId, "requested_quantity");
		const stray = await send(w, at.from, at.file, "gamma", {}, last);
		expect(stray).toMatchObject({ ok: false });
		expect((stray as { error: string }).error).toContain("gamma isn't a recipient");
		expect(await send(w, at.from, at.file, at.to, {}, last)).toMatchObject({ ok: true });
		const status = await w.host.approval(
			who(w, at.from, at.file, last),
			{ action: "status", requestId, generation: "1" },
			tc(),
		);
		expect(status.text).toContain("1 of 5 used");
	});
});
