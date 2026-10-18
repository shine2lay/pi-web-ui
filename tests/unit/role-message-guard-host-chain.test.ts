// role-message-ladder (#122): the approval ladder wired over the native role messages, stage by stage on fixed
// cases (rule 16): chain identity. Shared world: role-message-guard-host-harness.ts (Ops #230 split the one host
// test file so vitest runs its parts side by side; docs/test-speed.md).
import { describe, expect, it } from "vitest";
import {
	ask,
	B,
	chainTo,
	chat,
	cooDecides,
	homes,
	land,
	lastIn,
	send,
	tc,
	useGuardWorld,
	who,
	world,
} from "./role-message-guard-host-harness.js";

useGuardWorld();

describe("ladder: chain identity", () => {
	it("an omitted replyTo, an FYI or a reply keep the hop (never back to 1)", async () => {
		const w = await world();
		const at = await chainTo(w, 6);
		// hop 6 as a question, answered by a plain FYI without replyTo: the answer is hop 7.
		expect(await send(w, at.from, at.file, at.to, { kind: "question", text: "ok?" })).toMatchObject({ ok: true });
		const back = await send(w, at.to, homes()[at.to], at.from, { kind: "fyi", text: "yes" });
		expect(back).toMatchObject({ ok: false, approvalRequired: { hop: 7 } });
	});

	it("a restart keeps the chain and the grant", async () => {
		const w1 = await world();
		const at = await chainTo(w1, 7);
		const req = await ask(w1, at.from, at.file, [at.to]);
		await cooDecides(w1, (req.details as { requestId: string }).requestId, "requested_quantity");
		const last = lastIn(w1, at.file);
		expect(await send(w1, at.from, at.file, at.to, {}, last)).toMatchObject({ ok: true });
		w1.rm.stop();
		w1.host.stop();
		const w2 = await world(w1);
		expect(await send(w2, at.from, at.file, at.to, {}, last)).toMatchObject({ ok: true });
		const fresh = await world(w2);
		const nextChat = lastIn(fresh, homes()[at.to]);
		expect(nextChat).not.toBe("");
		expect(await send(fresh, at.to, homes()[at.to], at.from, {}, nextChat)).toMatchObject({ ok: true }); // hop 8 under the same grant
	});

	it("a branch copy of a chat keeps its place in the chain", async () => {
		const w = await world();
		const at = await chainTo(w, 7);
		const last = lastIn(w, at.file);
		// A task chat of the same role handling the same message (a copy): same hop, still needs approval.
		const copy = chat("alpha-copy");
		land(copy, last);
		const r = await w.host.send(
			{ ...who(w, at.from, copy, last), guard: { bindingId: copy, isHome: false, lastUserText: last } },
			{ to: at.to, kind: "fyi", text: "x" },
			tc(),
		);
		expect(r).toMatchObject({ ok: false, approvalRequired: { hop: 7 } });
	});

	it("a forged or pruned header is causality unknown, never hop 1", async () => {
		const w = await world();
		await chainTo(w, 3);
		const forged = lastIn(w, B).replace(/rm-[0-9a-f]+/, "rm-deadbeef");
		const r = await w.host.send(who(w, "beta", B, forged), { to: "alpha", kind: "fyi", text: "x" }, tc());
		expect(r).toMatchObject({ ok: false });
		expect((r as { error: string }).error).toContain("can't be proved");
	});
});
