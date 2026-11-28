import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { ClientSession } from "./agent-service.js";
import { addonBundlePath } from "./addon-bundle-paths.js";
import { resolvePiSdkFile } from "./sdk-file-patch.js";
import {
	coldNativeApply,
	nativeSourceVerifier,
	nativePrefixVerifier,
	nativeRecoveryInspection,
} from "./lead-compaction-cold.js";
import {
	createWebLeadCompactionHost,
	readNativeLeadObservation,
	nativeLeadAdmission,
} from "./lead-compaction-runtime.js";
import { enumerateCanonicalHomes, resolveCanonicalLeadHome } from "./lead-compaction-homes.js";
import { createLeadChecks } from "./lead-compaction-checks.js";
import { createSparseHostPorts, type SparseLibrary } from "./lead-compaction-sparse.js";
import { createLeadScheduler, type LeadScheduler } from "./lead-compaction-scheduler.js";
import { attachLeadLifecycle } from "./lead-compaction-lifecycle.js";
import { leadLifecycleHooks } from "./lead-compaction-events.js";
import type { LeadExecutor } from "./lead-compaction-contract.js";
import type { LeadCompactionHost } from "./lead-compaction-host.js";

let scheduler: LeadScheduler | undefined, detach: (() => void) | undefined;
let executor: (LeadExecutor & { close(): Promise<void> }) | undefined;
let host: LeadCompactionHost | undefined, checks: ReturnType<typeof createLeadChecks> | undefined;
let inspect: ReturnType<typeof nativeRecoveryInspection> | undefined;
let startup: Promise<void> | undefined,
	errorCode: string | undefined,
	stopped = false;
const opening = new Map<string, Promise<void>>();
/** Read only through the authenticated diagnostics transport, never public health. */
export function leadCompactionDiagnostics() {
	return { enabled: !!detach, errorCode, homes: scheduler?.status() ?? [] };
}
export function startLeadCompaction(): Promise<void> {
	return (startup ??= (async () => {
		try {
			const sdkModule = resolvePiSdkFile("core", "session-manager.js");
			if (!sdkModule) throw new Error("sdk-unavailable");
			const openVikingRoot = addonBundlePath("/home/shinelay/projects/pi-openviking");
			const load = (file: string) => import(pathToFileURL(join(openVikingRoot, "src", "v2", file)).href);
			const [configuration, api, sparseNative, sparseValidation, sparseExecutor] = await Promise.all([
				load("lead-executor-config.ts"),
				load("lead-executor.ts"),
				load("lead-sparse-native.ts"),
				load("lead-sparse-plan.ts"),
				load("lead-sparse-executor.ts"),
			]);
			if (stopped) throw new Error("lead-recovery-stopped");
			const config = configuration.defaultLeadExecutorConfig(sdkModule),
				native = { ...config, openVikingRoot };
			const ports = ClientSession.leadCompactionPorts(
				(prepared, result) => executor!.acknowledge(prepared, result),
				coldNativeApply(native),
				nativeSourceVerifier(native),
			);
			host = createWebLeadCompactionHost(ports);
			executor = api.createLeadExecutor(config, host, {
				observation: (sessionId: string) => {
					const home = resolveCanonicalLeadHome(sessionId);
					return home ? readNativeLeadObservation(home.source) : {};
				},
				progress: (status: Parameters<LeadScheduler["progress"]>[0]) => scheduler?.progress(status),
			});
			const library = { ...sparseValidation, ...sparseNative, ...sparseExecutor } as SparseLibrary;
			ports.sparse = createSparseHostPorts({
				library,
				captureFence: (id) => host!.captureFence(id),
				resolveHome: ports.resolveHome,
				verifyPrefix: nativePrefixVerifier(native),
				progress: async (prepared, cursor, nativeId, fence) => {
					if (!executor?.nativeProgress) throw new Error("native-progress-unavailable");
					await executor.nativeProgress(prepared, cursor, nativeId, fence);
				},
			});
			checks = createLeadChecks(host, executor!);
			inspect = nativeRecoveryInspection(native);
			scheduler = createLeadScheduler({ discovery: { enumerateCanonicalHomes }, checks, publish: () => {} });
			detach = attachLeadLifecycle(scheduler, leadLifecycleHooks);
		} catch {
			errorCode = "E_LEAD_STARTUP";
			await executor?.close();
			throw new Error(errorCode);
		}
	})());
}
/** Before a canonical home is opened, reconcile a DURABLE partial application without a model turn. */
export async function ensureLeadRecoveryBeforeOpen(source: string): Promise<void> {
	const home = enumerateCanonicalHomes()
		.map((h) => ({ sessionId: h.sessionId, home: resolveCanonicalLeadHome(h.sessionId) }))
		.find((h) => h.home?.source === source);
	if (!home) return; // Ordinary/assigned worker sessions never acquire lead recovery authority.
	if (stopped) throw new Error("lead-recovery-stopped");
	const existing = opening.get(source);
	if (existing) return existing;
	const operation = (async () => {
		await startLeadCompaction();
		if (!host || !checks || !inspect) throw new Error("lead-recovery-unavailable");
		const file = nativeLeadAdmission.file(source);
		if (file.session && !file.recovery) return;
		let pendingObserved = false;
		try {
			const pending = await inspect(source, home.sessionId);
			pendingObserved = pending.length > 0;
			if (pending.length > 1) throw new Error("multiple-pending-native-applications");
			if (!pending.length) {
				if (file.recovery) await host.recover(home.sessionId);
				return;
			}
			host.markSparsePending(home.sessionId, pending[0]);
			const result = await checks.recoverPending(home.sessionId, pending[0].applicationId, pending[0].applicationHash);
			if (result.state !== "applied" || file.recovery) throw new Error("lead-native-recovery-held");
		} catch (error) {
			if (pendingObserved) file.recovery = true;
			throw error;
		}
	})();
	opening.set(source, operation);
	try {
		await operation;
	} finally {
		if (opening.get(source) === operation) opening.delete(source);
	}
}
export async function stopLeadCompaction(): Promise<void> {
	stopped = true;
	await startup?.catch(() => {});
	detach?.();
	detach = undefined;
	await executor?.close();
}
