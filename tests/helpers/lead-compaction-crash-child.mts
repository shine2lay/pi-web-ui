// External crash harness: terminate the process at the real native-append/acknowledgement boundary.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { LeadCompactionHost } from "../../server/lead-compaction-host.ts";
import { coldNativeApply, nativeSourceVerifier } from "../../server/lead-compaction-cold.ts";
const { config, source, sessionId, checkpoint, planId, planHash } = JSON.parse(readFileSync(process.argv[2]!, "utf8"));
const { createLeadExecutor } = await import(pathToFileURL(join(config.openVikingRoot, "src/v2/lead-executor.ts")).href);
const host = new LeadCompactionHost({
	resolveHome: (id) => (id === sessionId ? { source, role: "ops", bindingEpoch: 1 } : undefined),
	busy: () => false,
	invalidate: () => {},
	coldApply: coldNativeApply(config),
	verifySource: nativeSourceVerifier(config),
	reconstruct: async () => {
		throw new Error("unexpected-cached-owner");
	},
	acknowledge: async () => {
		process.exit(77);
	},
});
const executor = createLeadExecutor(config, host, {
	observation: () => ({
		checkpoint,
		usage: { tokens: 200000, mutationRevision: host.captureFence(sessionId).mutationRevision },
	}),
});
const ticket = await executor.resume(planId, planHash);
if (ticket.state) throw new Error("crash-precondition-no-ticket");
await host.tryApply(ticket);
throw new Error("crash-boundary-not-reached");
