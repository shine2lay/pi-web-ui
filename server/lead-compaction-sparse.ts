import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { setImmediate as yieldTurn } from "node:timers/promises";
import type { Fence, Prepared, VerifiedCommit } from "./lead-compaction-contract.js";
import type { LeadSparseHostPorts } from "./lead-compaction-host.js";
import { syncNativeFile } from "./lead-compaction-native.js";

/** Loaded only from the pinned canonical OpenViking add-on by server integration. */
export interface SparseLibrary {
	validateSparseApplication(value: unknown): void;
	sparsePrepared(value: unknown): Prepared;
	sparseEqual(a: unknown, b: unknown): boolean;
	applySparseNative(value: unknown, port: Record<string, unknown>): Promise<{ nativeEntryId: string }>;
	findSparseApplied(value: unknown, branch: readonly unknown[]): string | undefined;
}
export function createSparseHostPorts(options: {
	library: SparseLibrary;
	captureFence(sessionId: string): Fence;
	resolveHome(sessionId: string): { source: string; role: string; bindingEpoch: number } | undefined;
	verifyPrefix(source: string, sessionId: string, bytes: number, hash: string): Promise<void>;
	progress(prepared: Prepared, cursor: number, nativeId: string, fence: Fence): Promise<void>;
}): LeadSparseHostPorts {
	const { library } = options;
	function application(verified: VerifiedCommit) {
		if (verified.prepared.strategy !== "sparse" || verified.draft.strategy !== "sparse")
			throw new Error("sparse-strategy-mismatch");
		library.validateSparseApplication(verified.draft.application);
		if (!library.sparseEqual(library.sparsePrepared(verified.draft.application), verified.prepared))
			throw new Error("sparse-plan-mismatch");
		return verified.draft.application as {
			sessionId: string;
			binding: { principal: string; source: string };
			afterEstimate: number;
		};
	}
	return {
		validate(verified) {
			application(verified);
		},
		findApplied(session, verified) {
			application(verified);
			return library.findSparseApplied(
				verified.draft.strategy === "sparse" ? verified.draft.application : undefined,
				session.sessionManager.getBranch(),
			);
		},
		async apply(session: AgentSession, verified) {
			const app = application(verified),
				manager = session.sessionManager;
			const authorize = async () => {
				const home = options.resolveHome(verified.fence.sessionId);
				if (
					!home ||
					home.source !== verified.fence.source ||
					home.role !== app.binding.principal ||
					home.bindingEpoch !== verified.fence.bindingEpoch ||
					session.sessionId !== app.sessionId ||
					manager.getSessionFile() !== app.binding.source
				)
					throw new Error("sparse-authority-drift");
			};
			await authorize();
			const applied = await library.applySparseNative(app, {
				sessionId: () => session.sessionId,
				branch: () => manager.getBranch(),
				projection: () => manager.buildSessionProjection().entries,
				leafId: () => manager.getLeafId(),
				get: (id: string) => manager.getEntry(id),
				append: (draft: {
					type: string;
					targetId?: string;
					replacement?: unknown;
					customType?: string;
					content?: string;
					display?: boolean;
					details?: unknown;
					data?: Record<string, unknown>;
				}) => {
					if (draft.type === "context_edit" && typeof draft.targetId === "string" && draft.replacement === null)
						return manager.appendContextEdit(draft.targetId, null);
					if (draft.type === "custom" && typeof draft.customType === "string")
						return manager.appendCustomEntry(draft.customType, draft.data);
					if (
						draft.type === "custom_message" &&
						typeof draft.customType === "string" &&
						typeof draft.content === "string" &&
						typeof draft.display === "boolean"
					)
						return manager.appendCustomMessageEntry(draft.customType, draft.content, draft.display, draft.details);
					throw new Error("unsupported-sparse-native-operation");
				},
				sync: () => syncNativeFile(verified.fence.source),
				verifyPrefix: (bytes: number, hash: string) =>
					options.verifyPrefix(verified.fence.source, session.sessionId, bytes, hash),
				authorize,
				progress: (cursor: number, nativeId: string) =>
					options.progress(verified.prepared, cursor, nativeId, options.captureFence(session.sessionId)),
				yield: () => yieldTurn(),
			});
			// The validated, hash-bound plan's own estimate: the same figure E reports while archiving.
			return { nativeEntryId: applied.nativeEntryId, afterEstimate: app.afterEstimate };
		},
	};
}
