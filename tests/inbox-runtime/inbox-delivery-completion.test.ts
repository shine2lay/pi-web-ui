import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { InboxRuntime } from "../../server/inbox-runtime.js";
import { A, B, clock, data, send, useGuardWorld, who, world } from "../unit/role-message-guard-host-harness.js";
import { caseOf } from "./inbox-corpora.js";
import { claimOf } from "./inbox-world.js";

useGuardWorld();

it("C-DDONE-1 question closes only on accepted canonical reply", async () => {
	const c = caseOf("delivery", "C-DDONE-1");
	const w = await world();
	const original = await send(w, "alpha", A, "beta", { kind: "question" });
	if (!original.ok) throw new Error("Question fixture refused");
	const id = original.record.id;
	const ledgerFile = join(data, "role-inbox-ledger.jsonl");
	writeFileSync(ledgerFile, "", { mode: 0o600 });
	const runtime = new InboxRuntime({
		ledgerFile,
		roleMessagesFile: join(data, "role-messages.json"),
		messages: w.rm,
		guard: w.host,
		now: clock,
	});
	const key = `rm:${id}`;
	const lease = claimOf(await runtime.claim(key, { kind: "home", role: "beta", session: B }));
	const accepted = await runtime.reply(
		lease,
		who(w, "beta", B),
		{ kind: "reply", replyTo: id, to: "alpha", text: "fixture answer" },
		"reply-record",
	);
	expect(accepted.code).toBeUndefined();
	const replyId = w.rm.byId(id)?.replyId;
	expect(replyId).toBe(accepted.resultRef);
	expect(w.rm.byId(replyId!)).toMatchObject({ replyTo: id, from: { role: "beta" } });
	const read = runtime.read("beta");
	if (read.status !== "ok") throw new Error("Expected whole read");
	expect(read.items.find((item) => item.key === key)?.lifecycle.state).toBe(c.expect.state);
});
