import { expect, it } from "vitest";
import { B, useGuardWorld } from "../unit/role-message-guard-host-harness.js";
import { setup } from "./inbox-world.js";

useGuardWorld();
it.each(["needs_home", "spawn_failed"] as const)(
	"HOME canonical %s release projection preserves semantic obligation",
	async (reason) => {
		const h = await setup();
		const claim = await h.runtime.claim(h.key, { kind: "home", role: "beta", session: B });
		if (!("leaseId" in claim)) throw new Error("fixture claim refused");
		await h.runtime.coordinate(h.key, async (context) => {
			context.append(
				reason === "needs_home"
					? { op: "release", reason, need: "owner_consent", leaseId: claim.leaseId, epoch: claim.epoch }
					: { op: "release", reason, leaseId: claim.leaseId, epoch: claim.epoch },
			);
		});
		const read = h.runtime.read("beta");
		if (read.status !== "ok") throw new Error("fixture projection unknown");
		const item = read.items.find((item) => item.key === h.key)!;
		expect(item.route).toBe(reason === "needs_home" ? "home_only" : "helper_eligible");
		expect(item.effectivePriority).toBe(reason === "needs_home" ? "P1" : "P2");
		expect(item.lifecycle.state).toBe("open");
		expect(item.lifecycle.lease).toBeNull();
		expect(item.lifecycle.receipt.semantic).toBeNull();
	},
);
