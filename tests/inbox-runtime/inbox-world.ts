import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { InboxRuntime, type InboxClaim, type InboxQueuePort } from "../../server/inbox-runtime.js";
import { A, clock, data, send, world } from "../../tests/unit/role-message-guard-host-harness.js";

export async function setup(queue?: InboxQueuePort) {
	const w = await world();
	const sent = await send(w, "alpha", A, "beta");
	if (!sent.ok) throw new Error("Fixture request was refused");
	const id = sent.record.id;
	const ledgerFile = join(data, "role-inbox-ledger.jsonl");
	const roleMessagesFile = join(data, "role-messages.json");
	writeFileSync(ledgerFile, "", { mode: 0o600 });
	const runtime = new InboxRuntime({ ledgerFile, roleMessagesFile, messages: w.rm, guard: w.host, now: clock, queue });
	return { w, id, key: `rm:${id}`, runtime, ledgerFile, roleMessagesFile };
}
export function claimOf(value: Awaited<ReturnType<InboxRuntime["claim"]>>): InboxClaim {
	if (!("leaseId" in value)) throw new Error("Expected a live lease");
	return value;
}
