/** Exclusive native file owner. Parent holds admission from dispatch through durable acknowledgement. */
import { parentPort, workerData } from "node:worker_threads";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { open } from "node:fs/promises";
import { createHash } from "node:crypto";
import type { VerifiedCommit } from "./lead-compaction-contract.js";
import type { ColdNativeConfig } from "./lead-compaction-cold.js";

const { config, verified, details } = workerData as {
	config: ColdNativeConfig;
	verified: VerifiedCommit;
	details: Record<string, unknown>;
};
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const moduleAt = (name: string) => import(pathToFileURL(join(config.openVikingRoot, "src/v2", name)).href);
async function apply() {
	if (workerData.mode === "inspect") {
		const reader = await moduleAt("fold-binding.ts");
		const snapshot = reader.readDurableFoldBinding(workerData.source, workerData.sessionId, config.sessionsRoot);
		if (snapshot.entries[0]?.version !== 3) throw new Error("unsupported-native-version");
		return { validated: true };
	}
	const [{ SessionManager }, plans, handoff, source, binding, owner] = await Promise.all([
		import(pathToFileURL(config.sdkModule).href),
		moduleAt("lead-handoff-plan.ts"),
		moduleAt("lead-handoff.ts"),
		moduleAt("lead-handoff-source.ts"),
		moduleAt("fold-binding.ts"),
		moduleAt("lead-window-owner.ts"),
	]);
	const { prepared, fence, draft } = verified;
	const records = plans.readLeadHandoffRecords(config.planPath);
	const plan = records.find(
		(row: { kind: string; plan_id: string }) => row.kind === "plan" && row.plan_id === prepared.planId,
	);
	if (
		!plan?.executor ||
		plans.executorPlanHash(plan) !== prepared.planHash ||
		plan.session_id !== fence.sessionId ||
		plan.binding.source !== fence.source ||
		plan.first_kept_entry_id !== draft.firstKeptEntryId ||
		plan.summary_sha !== hash(draft.summary)
	)
		throw new Error("cold-plan-conflict");
	const snapshot = binding.readDurableFoldBinding(fence.source, fence.sessionId, config.sessionsRoot);
	if (snapshot.entries[0]?.version !== 3) throw new Error("unsupported-native-version");
	const manager = SessionManager.open(fence.source);
	const readBinding = owner.createLeadBindingReader({
		...config,
		roleOf: () => plan.binding.principal,
		isWorker: () => false,
	});
	const authority = readBinding({ sessionManager: manager });
	if (!authority || hash(JSON.stringify(authority)) !== prepared.bindingFingerprint)
		throw new Error("cold-authority-drift");
	let found = handoff.findAppliedLeadHandoff(plan, manager.getBranch());
	if (!found) {
		const entries = source.handoffView(manager.buildSessionProjection().entries).entries;
		const frozen = plan.executor;
		const tail = entries.slice(plan.entry_count, plan.entry_count + frozen.tailIds.length);
		const protectedIds = new Set(frozen.protectedIds);
		if (
			manager.getSessionId() !== fence.sessionId ||
			(fence.leafId !== null && manager.getLeafId() !== fence.leafId) ||
			source.sourceHash(entries.slice(0, plan.entry_count)) !== prepared.sourceHash ||
			source.sourceHash(tail) !== prepared.tailHash ||
			hash(JSON.stringify(manager.getBranch().filter((entry: { id: string }) => protectedIds.has(entry.id)))) !==
				prepared.protectedHash
		)
			throw new Error("cold-source-drift");
		manager.appendCompaction(draft.summary, draft.firstKeptEntryId, draft.tokensBefore, details);
	}
	const fd = await open(fence.source, "r+");
	try {
		await fd.sync();
	} finally {
		await fd.close();
	}
	const reopened = SessionManager.open(fence.source);
	found = handoff.findAppliedLeadHandoff(plan, reopened.getBranch());
	if (!found || reopened.getSessionId() !== fence.sessionId) throw new Error("cold-readback-failed");
	return { nativeEntryId: found.id as string };
}
apply().then(
	(result) => parentPort!.postMessage({ result }),
	() => parentPort!.postMessage({ error: "cold-native-recovery-required" }),
);
