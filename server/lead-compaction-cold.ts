import { Worker } from "node:worker_threads";
import { isAbsolute } from "node:path";
import type { VerifiedCommit } from "./lead-compaction-contract.js";
import { nativeDetails, validateDraft } from "./lead-compaction-native.js";

export interface ColdNativeConfig {
	sdkModule: string;
	openVikingRoot: string;
	planPath: string;
	sessionsRoot: string;
	identitiesDir: string;
	rolloutStatePath: string;
}
async function request(
	config: ColdNativeConfig,
	data: Record<string, unknown>,
): Promise<{ nativeEntryId?: string; validated?: boolean }> {
	if (
		[
			config.sdkModule,
			config.openVikingRoot,
			config.planPath,
			config.sessionsRoot,
			config.identitiesDir,
			config.rolloutStatePath,
		].some((path) => typeof path !== "string" || !isAbsolute(path))
	)
		throw new Error("noncanonical-native-config");
	const extension = import.meta.url.endsWith(".ts") ? ".ts" : ".js";
	const worker = new Worker(new URL(`./lead-compaction-cold-worker${extension}`, import.meta.url), {
		workerData: { config, ...data },
	});
	try {
		return await new Promise((resolve, reject) => {
			worker.once("message", (message) =>
				message?.result ? resolve(message.result) : reject(new Error("cold-native-recovery-required")),
			);
			worker.once("error", () => reject(new Error("cold-native-recovery-required")));
			worker.once("exit", () => reject(new Error("cold-native-recovery-required")));
		});
	} finally {
		await worker.terminate();
	}
}
/** Construct only inside trusted server integration; no client-selected paths or authority. */
export function coldNativeApply(
	config: ColdNativeConfig,
): (verified: VerifiedCommit) => Promise<{ nativeEntryId: string }> {
	return async (verified) => {
		if (verified.fence.cached) throw new Error("cold-cached-collision");
		validateDraft(verified.prepared, verified.draft);
		const result = await request(config, { verified, details: nativeDetails(verified.prepared, verified.draft) });
		if (typeof result.nativeEntryId !== "string") throw new Error("cold-native-recovery-required");
		return { nativeEntryId: result.nativeEntryId };
	};
}
export function nativeSourceVerifier(config: ColdNativeConfig): (source: string, sessionId: string) => Promise<void> {
	return async (source, sessionId) => {
		const result = await request(config, { mode: "inspect", source, sessionId });
		if (result.validated !== true) throw new Error("native-source-unverified");
	};
}
