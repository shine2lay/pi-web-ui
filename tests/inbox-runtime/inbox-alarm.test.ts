import { writeFileSync } from "node:fs";
import { expect, it } from "vitest";
import { B, useGuardWorld, who } from "../../tests/unit/role-message-guard-host-harness.js";
import { caseOf } from "./inbox-corpora.js";
import { claimOf, setup } from "./inbox-world.js";

useGuardWorld();
it("D5 projection is department-private metadata; viewing/restart never clears unanswered", async () => {
	caseOf("delivery", "C-DALM-1");
	caseOf("delivery", "C-DALM-3");
	const h = await setup();
	for (let n = 0; n < 3; n++) {
		const lease = claimOf(await h.runtime.claim(h.key, { kind: "home", role: "beta", session: B }));
		await h.runtime.end(lease, "turn_ended_unanswered");
	}
	const alarm = h.runtime.alarm("beta", "beta");
	expect(alarm.count).toBe(1);
	expect(alarm.items[0].key).toBe(h.key);
	expect(alarm.items[0].attempts).toBe(3);
	expect(Object.keys(alarm.items[0]).sort()).toEqual(["attempts", "cause", "checkpoint", "key", "sender"]);
	expect(JSON.stringify(alarm).includes("hello from alpha")).toBe(false);
	expect(h.runtime.alarm("beta", "owners")).toEqual(alarm);
	expect(() => h.runtime.alarm("beta", "gamma")).toThrow();
	await h.runtime.recover();
	expect(h.runtime.alarm("beta", "beta")).toEqual(alarm);
	const lease = claimOf(await h.runtime.claim(h.key, { kind: "home", role: "beta", session: B }));
	await h.runtime.reply(lease, who(h.w, "beta", B), { kind: "reply", to: "alpha", replyTo: h.id, text: "fixture answer" }, "alarm-reply");
	expect(h.runtime.alarm("beta", "beta").count).toBe(0);
});
it("D5 unreadable ledger projects UNKNOWN, not an empty answered inbox", async () => {
	caseOf("delivery", "C-DALM-1");
	const h = await setup();
	writeFileSync(h.ledgerFile, '{"v":"rpi/1"');
	expect(h.runtime.read("beta").status).toBe("unknown");
	expect(h.runtime.alarm("beta", "beta").items.some(item => item.cause === "unknown")).toBe(true);
});
