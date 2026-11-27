import { expect, it } from "vitest";
import { identityOfEntry, identityCommandRefusal } from "../../server/specialist-entry.js";
import { startTaskChat } from "../../server/task-chat-start.js";
import { corpus, caseOf, pins } from "./inbox-corpora.js";

it("pins all core90/delivery69/helper120 without claiming runtime case coverage", () => {
	for (const name of ["core", "delivery", "helper"] as const) expect(corpus(name)).toHaveLength(pins[name].count);
});
it("C-HID-1 real web identity reader never downgrades unbound helper to plain role", () => {
	caseOf("helper", "C-HID-1");
	const value = identityOfEntry({ type: "custom", customType: "identity", data: {
		v: 1, id: "beta", via: "inbox-helper", inbox: { msgId: "rm-00000001", leaseId: "l1", epoch: 1, homeChat: "/fixture/home" },
	} });
	expect(value === "unusable").toBe(true);
});
it("C-HID-3 real web reader refuses malformed helper rather than ordinary role fallback", () => {
	caseOf("helper", "C-HID-3");
	const value = identityOfEntry({ type: "custom", customType: "identity", data: { v: 1, id: "beta", via: "inbox-helper", msgId: "rm-00000001" } });
	expect(value === "unusable").toBe(true);
});
it("legacy no-helper/no-specialist entry keeps plain department and command permission", () => {
	const entry = { type: "custom", customType: "identity", data: { v: 1, id: "beta", via: "queue" } };
	expect(identityOfEntry(entry)).toEqual({ id: "beta" });
	expect(identityCommandRefusal([entry])).toBeNull();
});
it("legacy launch primitive starts only on actual preflight acceptance, no helper/model", async () => {
	let accepted = 0;
	await startTaskChat({ ranTurn: () => false, send: async hooks => { hooks.gate("started"); accepted++; hooks.ended(); } });
	expect(accepted).toBe(1);
});
