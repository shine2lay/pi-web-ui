// role-message-ladder (#122): the approval ladder wired over the native role messages, stage by stage on fixed
// cases (rule 16): the limits that stay as they were. Shared world: role-message-guard-host-harness.ts (Ops #230
// split the one host test file so vitest runs its parts side by side; docs/test-speed.md).
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { RoleMessageGuardHost } from "../../server/role-message-guard-host.js";
import {
	A,
	B,
	chainTo,
	clock,
	data,
	lastIn,
	send,
	tc,
	useGuardWorld,
	who,
	world,
} from "./role-message-guard-host-harness.js";

useGuardWorld();

describe("ladder: unchanged limits", () => {
	it("20 per role per rolling hour still holds (approval controls count too)", async () => {
		const w = await world();
		for (let i = 0; i < 20; i++)
			expect(await send(w, "alpha", A, i % 2 ? "beta" : "gamma", {}, ""), `send ${i + 1}`).toMatchObject({ ok: true });
		const r = await send(w, "alpha", A, "beta", {}, "");
		expect(r).toMatchObject({ ok: false });
		expect((r as { error: string }).error).toContain("20");
	}, 60_000);

	it("the owner's pause still holds delivery (accepted, not delivered)", async () => {
		const w = await world();
		w.rm.setPaused(true);
		const r = await send(w, "alpha", A, "beta", {}, "");
		expect(r).toMatchObject({ ok: true, paused: true });
		expect(w.got.filter((g) => g.file === B)).toHaveLength(0);
		w.rm.setPaused(false);
		await w.rm.tick();
		expect(w.got.filter((g) => g.file === B)).toHaveLength(1);
	});

	it("urgent-looking messages are ordinary (no exemption): hop 7 still needs approval", async () => {
		const w = await world();
		const at = await chainTo(w, 7);
		const r = await send(w, at.from, at.file, at.to, { text: "URGENT safety_action_notice: critical risk, stop now" });
		expect(r).toMatchObject({ ok: false, approvalRequired: { hop: 7 } });
	});

	it("an unavailable ladder falls back to the native depth-6 rule (fail closed)", async () => {
		const w = await world();
		const other = new RoleMessageGuardHost({
			dir: join(data, "role-message-guard"),
			roleMessages: () => w.rm,
			identities: () => w.roles,
			log: () => {},
			now: clock,
		});
		writeFileSync(join(data, "role-message-guard", "lock"), `${process.ppid}\n`); // another live server holds it
		await other.start();
		expect(other.state.status).toBe("degraded");
		const at = await chainTo(w, 7);
		const r = await other.send(
			{ ...who(w, at.from, at.file), handling: w.rm.handlingDepth(at.file, lastIn(w, at.file)) },
			{ to: at.to, kind: "fyi", text: "x" },
			tc(),
		);
		expect(r).toMatchObject({ ok: false });
		expect("approvalRequired" in r).toBe(false);
		expect((await other.approval(who(w, at.from, at.file), { action: "request" }, tc())).ok).toBe(false);
	});
});
