/** Exclusive native file owner. Parent holds admission through durable acknowledgement. */
import { parentPort, workerData } from "node:worker_threads";
import { pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { open, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { setImmediate as yieldTurn } from "node:timers/promises";
import type { VerifiedCommit } from "./lead-compaction-contract.js";
import type { ColdNativeConfig } from "./lead-compaction-cold.js";
const { config, verified, details } = workerData as {
	config: ColdNativeConfig;
	verified: VerifiedCommit;
	details: Record<string, unknown>;
};
const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const moduleAt = (name: string) => import(pathToFileURL(join(config.openVikingRoot, "src/v2", name)).href);
async function sync(source: string) {
	const fd = await open(source, "r+");
	try {
		await fd.sync();
	} finally {
		await fd.close();
	}
}
async function prefix(source: string, bytes: number, expected: string) {
	if (!Number.isSafeInteger(bytes) || bytes < 1 || !/^[a-f0-9]{64}$/.test(expected))
		throw new Error("invalid-prefix-proof");
	const raw = await readFile(source);
	if (raw.length < bytes || hash(raw.subarray(0, bytes)) !== expected) throw new Error("native-prefix-changed");
}
async function afterEstimate(manager: any): Promise<number> {
	const api = await import(pathToFileURL(join(dirname(config.sdkModule), "compaction", "compaction.js")).href);
	return api.estimateProjectedContextTokens(manager.buildSessionProjection(), manager.getBranch()).tokens;
}
async function apply() {
	if (workerData.mode === "inspect" || workerData.mode === "prefix") {
		const reader = await moduleAt("fold-binding.ts");
		const snapshot = reader.readDurableFoldBinding(workerData.source, workerData.sessionId, config.sessionsRoot);
		if (snapshot.entries[0]?.version !== 3) throw new Error("unsupported-native-version");
		if (workerData.mode === "prefix") {
			await prefix(workerData.source, workerData.bytes, workerData.hash);
			return { validated: true };
		}
		const [{ SessionManager }, recovery, plans] = await Promise.all([
			import(pathToFileURL(config.sdkModule).href),
			moduleAt("lead-sparse-recovery.ts"),
			moduleAt("lead-handoff-plan.ts"),
		]);
		const manager = SessionManager.open(workerData.source);
		return {
			validated: true,
			pending: recovery.sparseRecoveryObligations(manager.getBranch(), plans.readLeadHandoffRecords(config.planPath)),
		};
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
	const snapshot = binding.readDurableFoldBinding(fence.source, fence.sessionId, config.sessionsRoot);
	if (snapshot.entries[0]?.version !== 3) throw new Error("unsupported-native-version");
	const manager = SessionManager.open(fence.source);
	if (manager.getSessionId() !== fence.sessionId) throw new Error("native-session-drift");
	if (draft.strategy === "sparse") {
		if (prepared.strategy !== "sparse") throw new Error("sparse-strategy-mismatch");
		const [sparse, validation, executor] = await Promise.all([
			moduleAt("lead-sparse-native.ts"),
			moduleAt("lead-sparse-plan.ts"),
			moduleAt("lead-sparse-executor.ts"),
		]);
		const plan = records.find(
			(row: { kind: string; plan_id: string }) => row.kind === "sparse-plan" && row.plan_id === prepared.planId,
		);
		if (
			!plan ||
			plan.application.hash !== prepared.planHash ||
			!validation.sparseEqual(plan.application, draft.application) ||
			!validation.sparseEqual(executor.sparsePrepared(plan.application), prepared)
		)
			throw new Error("cold-sparse-plan-conflict");
		const app = plan.application;
		const authorityOptions = {
			...config,
			bindingCache: {},
			roleOf: () => app.binding.principal,
			isWorker: () => false,
		};
		const readBinding = owner.createLeadBindingReader(authorityOptions);
		if (
			!validation.sparseEqual(readBinding({ sessionManager: manager }), app.binding) ||
			app.binding.source !== fence.source
		)
			throw new Error("cold-authority-drift");
		const authorize = async () => {
			if (!owner.verifyOwnedNativeLeadBinding(authorityOptions, { sessionManager: manager }, app.binding))
				throw new Error("cold-authority-drift");
		};
		await authorize();
		const archived = new Set(
			records
				.filter(
					(r: { kind: string; plan_id: string; phase?: string; cursor?: number }) =>
						r.kind === "sparse-progress" && r.plan_id === app.id && r.phase === "archived",
				)
				.map((r: { cursor: number }) => r.cursor),
		);
		if (archived.size !== app.folds.length) throw new Error("cold-sparse-receipts-missing");
		const result = await sparse.applySparseNative(app, {
			sessionId: () => manager.getSessionId(),
			branch: () => manager.getBranch(),
			projection: () => manager.buildSessionProjection().entries,
			leafId: () => manager.getLeafId(),
			get: (id: string) => manager.getEntry(id),
			authorize,
			append: (op: {
				type: string;
				targetId?: string;
				replacement?: unknown;
				customType?: string;
				content?: string;
				display?: boolean;
				details?: unknown;
				data?: unknown;
			}) => {
				if (op.type === "context_edit" && typeof op.targetId === "string" && op.replacement === null)
					return manager.appendContextEdit(op.targetId, null);
				if (op.type === "custom" && typeof op.customType === "string")
					return manager.appendCustomEntry(op.customType, op.data);
				if (
					op.type === "custom_message" &&
					typeof op.customType === "string" &&
					typeof op.content === "string" &&
					typeof op.display === "boolean"
				)
					return manager.appendCustomMessageEntry(op.customType, op.content, op.display, op.details);
				throw new Error("unsupported-sparse-native-operation");
			},
			sync: () => sync(fence.source),
			verifyPrefix: (bytes: number, digest: string) => prefix(fence.source, bytes, digest),
			yield: () => yieldTurn(),
			progress: async (cursor: number, nativeId: string) =>
				plans.appendLeadHandoffRecord(
					{
						kind: "sparse-progress",
						plan_id: app.id,
						session_id: app.sessionId,
						at: new Date().toISOString(),
						plan_hash: app.hash,
						phase: "native",
						cursor,
						native_id: nativeId,
					},
					config.planPath,
				),
		});
		await sync(fence.source);
		const reopened = SessionManager.open(fence.source);
		if (!validation.sparseEqual(readBinding({ sessionManager: reopened }), app.binding))
			throw new Error("cold-authority-drift");
		if (sparse.findSparseApplied(app, reopened.getBranch()) !== result.nativeEntryId)
			throw new Error("cold-sparse-readback-failed");
		return { nativeEntryId: result.nativeEntryId, afterEstimate: await afterEstimate(reopened) };
	}
	if (prepared.strategy === "sparse") throw new Error("prefix-strategy-mismatch");
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
		const entries = source.handoffView(manager.buildSessionProjection().entries).entries,
			frozen = plan.executor;
		const tail = entries.slice(plan.entry_count, plan.entry_count + frozen.tailIds.length),
			protectedIds = new Set(frozen.protectedIds);
		if (
			(fence.leafId !== null && manager.getLeafId() !== fence.leafId) ||
			source.sourceHash(entries.slice(0, plan.entry_count)) !== prepared.sourceHash ||
			source.sourceHash(tail) !== prepared.tailHash ||
			hash(JSON.stringify(manager.getBranch().filter((entry: { id: string }) => protectedIds.has(entry.id)))) !==
				prepared.protectedHash
		)
			throw new Error("cold-source-drift");
		manager.appendCompaction(draft.summary, draft.firstKeptEntryId, draft.tokensBefore, details);
	}
	await sync(fence.source);
	const reopened = SessionManager.open(fence.source);
	found = handoff.findAppliedLeadHandoff(plan, reopened.getBranch());
	if (!found || reopened.getSessionId() !== fence.sessionId) throw new Error("cold-readback-failed");
	return { nativeEntryId: found.id as string, afterEstimate: await afterEstimate(reopened) };
}
apply().then(
	(result) => parentPort!.postMessage({ result }),
	() => parentPort!.postMessage({ error: "cold-native-recovery-required" }),
);
