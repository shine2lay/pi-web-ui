import type { LeadChecks, LeadExecutor, LeadNativeHost, Status } from "./lead-compaction-contract.js";

/** One serialized H/E operation per home; archive I/O stays outside the native commit lock. */
export function createLeadChecks(
	host: LeadNativeHost & {
		recover(sessionId: string): Promise<void>;
		clearSparsePending?(sessionId: string, planId: string, planHash: string): void;
	},
	executor: LeadExecutor,
): LeadChecks & { recoverPending(sessionId: string, planId: string, planHash: string): Promise<Status> } {
	const recovery = new Map<string, Status>();
	const running = new Map<string, Promise<unknown>>();
	function serial<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
		const result = (running.get(sessionId) ?? Promise.resolve()).catch(() => {}).then(operation);
		running.set(sessionId, result);
		void result
			.finally(() => {
				if (running.get(sessionId) === result) running.delete(sessionId);
			})
			.catch(() => {});
		return result;
	}
	async function recover(sessionId: string): Promise<Status | undefined> {
		const owed = recovery.get(sessionId);
		if (!owed) return;
		try {
			await host.recover(sessionId);
			recovery.delete(sessionId);
		} catch {
			return { ...owed, nextRetryReason: "native-recovery-required" };
		}
	}
	async function apply(
		sessionId: string,
		ticket: Parameters<LeadNativeHost["tryApply"]>[0],
		trigger: Status["trigger"],
	): Promise<Status> {
		const result = await host.tryApply(ticket);
		if (result.state === "blocked" && result.errorCode === "native-recovery-required") {
			recovery.set(sessionId, result);
			const failed = await recover(sessionId);
			return {
				...(failed ?? result),
				trigger,
				nextRetryReason: failed ? "native-recovery-required" : "native-recovered",
			};
		}
		return { ...result, trigger };
	}
	return {
		requestCheck({ sessionId, trigger }) {
			return serial(sessionId, async () => {
				const held = await recover(sessionId);
				if (held) return { ...held, trigger };
				const prepared = await executor.prepare(host.captureFence(sessionId));
				if ("state" in prepared) return { ...prepared, trigger };
				const ticket = await executor.resume(prepared.planId, prepared.planHash);
				if ("state" in ticket) return { ...ticket, trigger };
				return apply(sessionId, ticket, trigger);
			});
		},
		recoverPending(sessionId, planId, planHash) {
			return serial(sessionId, async () => {
				const held = await recover(sessionId);
				if (held) return held;
				const ticket = await executor.resume(planId, planHash);
				if ("state" in ticket) {
					if (ticket.state === "applied" && ticket.planId === planId && ticket.planHash === planHash) {
						if (!host.clearSparsePending) throw new Error("sparse-recovery-confirmation-unavailable");
						host.clearSparsePending(sessionId, planId, planHash);
					}
					return { ...ticket, trigger: "home-open" };
				}
				return apply(sessionId, ticket, "home-open");
			});
		},
	};
}
