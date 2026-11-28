import type {
	CanonicalHome,
	LeadChecks,
	LeadDiscovery,
	LeadProgress,
	LeadTrigger,
	Status,
} from "./lead-compaction-contract.js";
import { projectLeadStatus } from "./lead-compaction-status.js";

export interface LeadSchedulerOptions {
	discovery: LeadDiscovery;
	checks: LeadChecks;
	/** Existing diagnostics transport; this projection is not a second durable journal. */
	publish: LeadProgress;
	now?: () => string;
}

/** Inactive until explicitly called by integration. No SDK access, threshold math, or model calls. */
export function createLeadScheduler(options: LeadSchedulerOptions) {
	const active = new Map<string, Promise<Status>>();
	const snapshots = new Map<string, Status>();
	const now = options.now ?? (() => new Date().toISOString());

	function homes(): readonly CanonicalHome[] {
		const result = options.discovery.enumerateCanonicalHomes();
		const ids = new Set<string>();
		for (const home of result) {
			if (!home.sessionId || !home.role || ids.has(home.sessionId)) throw new Error("E_LEAD_DISCOVERY");
			ids.add(home.sessionId);
		}
		return result;
	}
	function publish(value: Status, home: CanonicalHome, trigger: LeadTrigger, inheritMeasurement = false): Status {
		// E measures; H's final native receipt contains no estimates. Carry only measured scalars
		// within this attempt, never previous-attempt authority/errors/native effects.
		const previous = inheritMeasurement ? snapshots.get(home.sessionId) : undefined;
		const fields = [
			"measurementSource",
			"measurementRevision",
			"beforeEstimate",
			"afterEstimate",
			"protectedFloorEstimate",
		] as const;
		const measured = previous
			? Object.fromEntries(fields.filter((key) => previous[key] !== undefined).map((key) => [key, previous[key]]))
			: {};
		const status = Object.freeze({ ...measured, ...projectLeadStatus(value, home), trigger });
		snapshots.set(home.sessionId, status);
		// A broken viewer must not turn an actual native apply into a failed compaction.
		try {
			options.publish(status);
		} catch {
			/* diagnostics reader can retrieve snapshot */
		}
		return status;
	}
	function requestCheck(request: { sessionId: string; trigger: LeadTrigger }): Promise<Status> {
		const home = homes().find((candidate) => candidate.sessionId === request.sessionId);
		if (!home)
			return Promise.resolve({ state: "blocked", sessionId: request.sessionId, errorCode: "E_NOT_CANONICAL_HOME" });
		const pending = active.get(home.sessionId);
		if (pending) return pending;
		// Defer the capability call until after registration, including synchronous throws.
		const run = Promise.resolve().then(async () => {
			publish({ state: "checking", sessionId: home.sessionId, at: now() }, home, request.trigger);
			try {
				// H/E own busy admission, applied-plan reconciliation BEFORE threshold, and fresh accounting.
				const result = await options.checks.requestCheck(request);
				return publish(result, home, request.trigger, true);
			} catch {
				return publish(
					{
						state: "blocked",
						sessionId: home.sessionId,
						at: now(),
						errorCode: "E_LEAD_CHECK",
						nextRetryReason: "check_failed",
					},
					home,
					request.trigger,
				);
			} finally {
				active.delete(home.sessionId);
			}
		});
		active.set(home.sessionId, run);
		return run;
	}
	function scan(trigger: "startup" | "idle"): Promise<Status[]> {
		// Launch all homes before awaiting any one: busy/blocked/archive work is per home.
		return Promise.all(homes().map((home) => requestCheck({ sessionId: home.sessionId, trigger })));
	}
	return {
		requestCheck,
		scan,
		/** Wire trusted pipeline progress here, never client-supplied status. */
		progress(value: Status): void {
			const home = homes().find((candidate) => candidate.sessionId === value.sessionId);
			const previous = snapshots.get(value.sessionId);
			if (!home || !active.has(value.sessionId) || !previous?.trigger) return;
			publish(value, home, previous.trigger, true);
		},
		status(): readonly Status[] {
			const ids = new Set(homes().map((home) => home.sessionId));
			for (const id of snapshots.keys()) if (!ids.has(id)) snapshots.delete(id);
			return [...snapshots.values()];
		},
	};
}
export type LeadScheduler = ReturnType<typeof createLeadScheduler>;
