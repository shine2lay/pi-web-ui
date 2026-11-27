import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ImageContent } from "@earendil-works/pi-ai";

/** Shared host/addon capability. Never expose a writable SDK manager to an addon. */
export const RAW_RUN_RECOVERY_HOST = Symbol.for("pi-web.raw-run-recovery.v1");
export type NativeRecoveryDraft =
	| { type: "context_edit"; targetId: string; replacement: null }
	| { type: "custom"; customType: "openviking.raw-run.operation"; data: unknown }
	| { type: "custom_message"; customType: "openviking.archive"; content: string; display: boolean; details: unknown };
export interface NativeRecoveryHost {
	sessionId(): string;
	leafId(): string;
	projection(): ReturnType<AgentSession["sessionManager"]["buildSessionProjection"]>["entries"];
	branch(): ReturnType<AgentSession["sessionManager"]["getBranch"]>;
	entry(id: string): ReturnType<AgentSession["sessionManager"]["getEntry"]>;
	append(draft: NativeRecoveryDraft): string;
}
export interface RecoveryRegistration {
	register(factory: (host: NativeRecoveryHost) => { recover(): Promise<{ held: boolean }> }): void;
}
const registryGlobal = globalThis as typeof globalThis & {
	[RAW_RUN_RECOVERY_HOST]?: WeakMap<object, RecoveryRegistration>;
};
const registry = (registryGlobal[RAW_RUN_RECOVERY_HOST] ??= new WeakMap());

/** Install immediately after construction, before bindExtensions/session_start. */
export function installRawRunRecoveryHost(session: AgentSession): RecoveryRegistration {
	const manager = session.sessionManager;
	const existing = registry.get(manager);
	if (existing) return existing;
	let recovery: ReturnType<Parameters<RecoveryRegistration["register"]>[0]> | undefined;
	let registrationError: unknown;
	let applying = false;
	let admission: Promise<void> | undefined;
	const host: NativeRecoveryHost = {
		sessionId: () => manager.getSessionId(),
		leafId: () => manager.getLeafId() ?? "",
		projection: () => manager.buildSessionProjection().entries,
		branch: () => manager.getBranch(),
		entry: (id) => manager.getEntry(id),
		append: (draft) => {
			if (!applying) throw new Error("E_RAW_RUN_OUTSIDE_RECOVERY");
			switch (draft.type) {
				case "context_edit":
					if (draft.replacement !== null) throw new Error("E_RAW_RUN_INVALID_DRAFT");
					return manager.appendContextEdit(draft.targetId, null);
				case "custom":
					if (draft.customType !== "openviking.raw-run.operation") throw new Error("E_RAW_RUN_INVALID_DRAFT");
					return manager.appendCustomEntry(draft.customType, draft.data);
				case "custom_message":
					if (draft.customType !== "openviking.archive") throw new Error("E_RAW_RUN_INVALID_DRAFT");
					return manager.appendCustomMessageEntry(draft.customType, draft.content, draft.display, draft.details);
				default:
					throw new Error("E_RAW_RUN_INVALID_DRAFT");
			}
		},
	};
	const registration: RecoveryRegistration = {
		register(factory) {
			if (applying) throw new Error("E_RAW_RUN_RECOVERY_BUSY");
			try {
				const candidate = factory(host);
				if (typeof candidate?.recover !== "function") throw new Error("E_RAW_RUN_INVALID_RECOVERY");
				recovery = candidate;
				registrationError = undefined;
			} catch (error) {
				registrationError = error;
				throw error;
			}
		},
	};
	const admit = async () => {
		if (registrationError) throw registrationError;
		if (!recovery) {
			// Only the coordinator may interpret completion. Any native ownership
			// marker requires it, including a history that appears completed.
			if (
				manager
					.getBranch()
					.some((entry) => entry.type === "custom" && entry.customType === "openviking.raw-run.operation")
			) {
				throw new Error("E_RAW_RUN_RECOVERY_UNAVAILABLE");
			}
			return;
		}
		if (!admission) {
			admission = (async () => {
				applying = true;
				try {
					const result = await recovery!.recover();
					if (result?.held !== false) throw new Error("E_RAW_RUN_RECOVERY_HELD");
					// Canonical SDK refresh, never a second parser or message transform.
					session.refreshContext();
				} finally {
					applying = false;
				}
			})();
		}
		const pending = admission;
		try {
			await pending;
		} finally {
			if (admission === pending) admission = undefined;
		}
	};
	const prompt = session.prompt.bind(session);
	session.prompt = async (...args) => {
		// Streaming prompts only enqueue; never recover during tool execution.
		if (!session.isStreaming) await admit();
		return prompt(...args);
	};
	// Reject OUTSIDE the Agent run. Throwing from prepareRequest/prepareNextTurn
	// would let Agent.handleRunFailure append an error into the frozen native batch.
	const agentPrompt = session.agent.prompt.bind(session.agent);
	session.agent.prompt = async (input: string | AgentMessage | AgentMessage[], images?: ImageContent[]) => {
		if (!session.agent.state.isStreaming) await admit();
		return typeof input === "string" ? agentPrompt(input, images) : agentPrompt(input);
	};
	const continueRun = session.agent.continue.bind(session.agent);
	session.agent.continue = async () => {
		if (!session.agent.state.isStreaming) await admit();
		return continueRun();
	};
	const finishTurn = session.agent.finishTurn;
	session.agent.finishTurn = async (...args) => {
		// The SDK persists the completed tool pair and awaits addon turn_end first.
		// Any freshly frozen plan is then applied under this host-owned boundary.
		const decision = await finishTurn?.(...args);
		try {
			await admit();
		} catch {
			// Public abort synchronously suppresses SDK post-run compaction/settle.
			// Do not await it here: it waits for this very turn to finish.
			void session.abort().catch(() => {});
			return { action: "end" };
		}
		return decision ?? undefined;
	};
	registry.set(manager, registration);
	return registration;
}
