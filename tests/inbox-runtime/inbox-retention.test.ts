import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { RoleMessages, type RoleMessageRecord } from "../../server/role-messages.js";
import { A, clock, data, send, useGuardWorld, world } from "../../tests/unit/role-message-guard-host-harness.js";
import { caseOf } from "./inbox-corpora.js";
useGuardWorld();
async function prune(state: "delivered" | "replied") {
	const w = await world();
	const sent = await send(w, "alpha", A, "beta");
	if (!sent.ok) throw new Error("Fixture request refused");
	const template = w.rm.byId(sent.record.id)!;
	w.rm.stop(); w.host.stop();
	const rows: RoleMessageRecord[] = Array.from({ length: 1001 }, (_, i) => ({
		...template, id: `rm-${String(i).padStart(8, "0")}`, at: clock() - 86_400_000,
		state, ...(state === "replied" ? { replyId: `rm-reply-${i}` } : {}),
	}));
	const file = join(data, "retention.json");
	writeFileSync(file, JSON.stringify({ v: 1, paused: true, messages: rows }));
	const store = new RoleMessages(file, { roles: () => [], chatState: () => "idle", deliver: async () => { throw new Error("No chat delivery"); }, log: () => {} }, clock);
	try {
		// Real canonical save/prune, not a copied retention predicate.
		(store as unknown as { save(schedule: (fn: () => void) => void): void }).save(() => {});
		return { file, retained: rows.filter(row => store.byId(row.id)).map(row => row.id) };
	} finally { store.stop(); }
}
it("C-DRET-2 actual save retains all unanswered delivered rows above KEEP", async () => {
	caseOf("delivery", "C-DRET-2");
	const result = await prune("delivered");
	expect(result.retained.length).toBe(1001);
});
it("C-DRET-1 actual closed-row prune leaves semantic metadata tombstone", async () => {
	caseOf("delivery", "C-DRET-1");
	const result = await prune("replied");
	expect(result.retained.length).toBe(1000);
	const first = JSON.parse(readFileSync(result.file.replace(/\.json$/, "-chains.jsonl"), "utf8").trim().split("\n")[0]);
	// Assert metadata only; never dump a store record or message body.
	expect(first.closedBy).toBe("replied");
	expect(first.kind).toBe("request");
	expect(first.replyId).toBe("rm-reply-0");
	expect(Object.hasOwn(first, "text")).toBe(false);
});
