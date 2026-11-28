import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { LeadChecks, Status } from "../../server/lead-compaction-contract.js";
import { attachLeadLifecycle } from "../../server/lead-compaction-lifecycle.js";
import { createLeadScheduler } from "../../server/lead-compaction-scheduler.js";
import { projectLeadStatus } from "../../server/lead-compaction-status.js";

const home = { role: "ops", sessionId: "home" };
function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}
function fixture(
	check: LeadChecks["requestCheck"] = async (): Promise<Status> => ({
		state: "ready",
		sessionId: "home",
		nextRetryReason: "below_threshold",
	}),
) {
	const requestCheck = vi.fn(check);
	const publish = vi.fn();
	const discovery = { enumerateCanonicalHomes: vi.fn(() => [home]) };
	return {
		requestCheck,
		publish,
		discovery,
		scheduler: createLeadScheduler({ discovery, checks: { requestCheck }, publish }),
	};
}

// External scalar capability adapters only. Joined real H/E/SDK A1–A6 acceptance is NOT claimed here.
describe("lead scheduler capability integration", () => {
	it("retains E measurements through H completion but never into another attempt", async () => {
		const entered = deferred<void>();
		const done = deferred<Status>();
		const f = fixture(async () => {
			entered.resolve();
			return done.promise;
		});
		const run = f.scheduler.requestCheck({ sessionId: "home", trigger: "idle" });
		await entered.promise;
		f.scheduler.progress({
			sessionId: "home",
			state: "ready",
			measurementSource: "current-projection",
			measurementRevision: 3,
			beforeEstimate: 210000,
			afterEstimate: 150000,
		});
		done.resolve({ sessionId: "home", state: "applied", nativeEntryId: "native-1" });
		expect(await run).toMatchObject({
			state: "applied",
			beforeEstimate: 210000,
			afterEstimate: 150000,
			measurementRevision: 3,
		});
		f.requestCheck.mockResolvedValueOnce({ sessionId: "home", state: "waiting_busy" });
		expect(await f.scheduler.requestCheck({ sessionId: "home", trigger: "idle" })).not.toHaveProperty("beforeEstimate");
	});
	it("coalesces simultaneous checks without blocking another unopened canonical home", async () => {
		const held = deferred<Status>();
		const second = deferred<void>();
		const calls: string[] = [];
		const scheduler = createLeadScheduler({
			discovery: { enumerateCanonicalHomes: () => [home, { role: "backend", sessionId: "cold" }] },
			checks: {
				requestCheck: async ({ sessionId }) => {
					calls.push(sessionId);
					if (sessionId === "home") return held.promise;
					second.resolve();
					return { state: "applied", sessionId, nativeEntryId: "native-1" };
				},
			},
			publish: () => {},
		});
		const first = scheduler.requestCheck({ sessionId: "home", trigger: "settled" });
		expect(scheduler.requestCheck({ sessionId: "home", trigger: "idle" })).toBe(first);
		const scan = scheduler.scan("startup");
		await second.promise;
		expect(calls).toEqual(["home", "cold"]);
		held.resolve({ state: "waiting_busy", sessionId: "home", nextRetryReason: "pending_input" });
		expect((await scan).map((s) => s.state)).toEqual(["waiting_busy", "applied"]);
	});
	it("refuses non-home workers before calling capabilities and retries busy homes on idle", async () => {
		const f = fixture(async () => ({ state: "waiting_busy", sessionId: "home", nextRetryReason: "pending_input" }));
		expect((await f.scheduler.requestCheck({ sessionId: "worker", trigger: "settled" })).state).toBe("blocked");
		expect(f.requestCheck).not.toHaveBeenCalled();
		await f.scheduler.scan("startup");
		await f.scheduler.scan("idle");
		expect(f.requestCheck).toHaveBeenCalledTimes(2);
	});
	it("delegates even below threshold to allow E to reconcile prior native effects first", async () => {
		const f = fixture(async () => ({
			state: "applied",
			sessionId: "home",
			nativeEntryId: "recovered",
			measurementSource: "current-projection",
			measurementRevision: 2,
			afterEstimate: 50000,
		}));
		await f.scheduler.scan("startup");
		expect(f.requestCheck).toHaveBeenCalledOnce();
		expect(f.scheduler.status()[0]).toMatchObject({
			state: "applied",
			nativeEntryId: "recovered",
			afterEstimate: 50000,
		});
	});
	it.each(["native-usage", "current-projection"] as const)(
		"projects %s accounting without recomputing it",
		async (measurementSource) => {
			const f = fixture(async () => ({
				state: "ready",
				sessionId: "home",
				measurementSource,
				measurementRevision: 3,
				beforeEstimate: 199999,
				nextRetryReason: "below_threshold",
			}));
			await f.scheduler.scan("idle");
			expect(f.scheduler.status()[0]).toMatchObject({
				measurementSource,
				measurementRevision: 3,
				beforeEstimate: 199999,
				state: "ready",
				nextRetryReason: "below_threshold",
			});
		},
	);
	it("projects real progress, preserves floor, and strips undeclared content", async () => {
		const held = deferred<Status>();
		const started = deferred<void>();
		const f = fixture(async () => {
			started.resolve();
			return held.promise;
		});
		const run = f.scheduler.scan("startup");
		await started.promise;
		f.scheduler.progress({
			sessionId: "home",
			state: "partial",
			planId: "p1",
			planHash: "abc",
			cursor: 1,
			total: 3,
			lastAttempt: "attempt-1",
			nextRetryReason: "archive_pending",
			summary: "PRIVATE",
		} as Status);
		expect(f.scheduler.status()[0]).toMatchObject({ cursor: 1, total: 3, state: "partial", trigger: "startup" });
		expect(JSON.stringify(f.scheduler.status())).not.toContain("PRIVATE");
		held.resolve({ state: "protected_floor", sessionId: "home", protectedFloorEstimate: 220000 });
		await run;
		expect(f.scheduler.status()[0]).toMatchObject({ state: "protected_floor", protectedFloorEstimate: 220000 });
	});
	it("isolates thrown faults without exposing error text and allows a subsequent check", async () => {
		const f = fixture(async () => {
			throw new Error("PRIVATE transcript");
		});
		await f.scheduler.scan("startup");
		expect(f.scheduler.status()[0]).toMatchObject({ state: "blocked", errorCode: "E_LEAD_CHECK" });
		expect(JSON.stringify(f.scheduler.status())).not.toContain("PRIVATE");
		await f.scheduler.scan("idle");
		expect(f.requestCheck).toHaveBeenCalledTimes(2);
	});
	it("does not call archive completion applied or let a viewer failure change native success", async () => {
		expect(() => projectLeadStatus({ state: "applied", sessionId: "home" }, home)).toThrow("E_LEAD_STATUS");
		expect(() => projectLeadStatus({ state: "partial", sessionId: "home", cursor: 2, total: 1 }, home)).toThrow();
		expect(() =>
			projectLeadStatus({ state: "blocked", sessionId: "home", errorCode: "private words" }, home),
		).toThrow();
		const f = fixture(async () => ({ state: "applied", sessionId: "home", nativeEntryId: "n1" }));
		f.publish.mockImplementation(() => {
			throw new Error("viewer down");
		});
		expect((await f.scheduler.scan("idle"))[0].state).toBe("applied");
	});
	it("removes diagnostic snapshots when canonical home identity changes", async () => {
		const f = fixture();
		await f.scheduler.scan("startup");
		f.discovery.enumerateCanonicalHomes.mockReturnValue([]);
		expect(f.scheduler.status()).toEqual([]);
	});
});

describe("explicit inactive lifecycle wiring", () => {
	it("startup, home-open, settled and idle fire without a model turn; end hooks never do", async () => {
		const f = fixture();
		let agent!: (sessionId: string, type: string) => void;
		let open!: (sessionId: string) => void;
		let idle!: () => void;
		const unsub = vi.fn();
		const onError = vi.fn();
		expect(f.requestCheck).not.toHaveBeenCalled();
		const done = deferred<void>();
		let expectedTrigger = "startup";
		let reached = done;
		f.publish.mockImplementation((s: Status) => {
			if (s.state === "ready" && s.trigger === expectedTrigger) reached.resolve();
		});
		const stop = attachLeadLifecycle(f.scheduler, {
			onAgentEvent: (cb) => {
				agent = cb;
				return unsub;
			},
			onHomeOpen: (cb) => {
				open = cb;
				return unsub;
			},
			onIdle: (cb) => {
				idle = cb;
				return unsub;
			},
			onError,
		});
		await done.promise;
		for (const trigger of ["home-open", "settled", "idle"]) {
			expectedTrigger = trigger;
			reached = deferred<void>();
			if (trigger === "home-open") open("home");
			else if (trigger === "settled") agent("home", "agent_settled");
			else idle();
			await reached.promise;
		}
		agent("home", "agent_end");
		agent("home", "turn_end");
		stop();
		stop();
		idle();
		agent("home", "agent_settled");
		await Promise.resolve();
		expect(f.requestCheck.mock.calls.map((args) => args[0])).toEqual([
			{ sessionId: "home", trigger: "startup" },
			{ sessionId: "home", trigger: "home-open" },
			{ sessionId: "home", trigger: "settled" },
			{ sessionId: "home", trigger: "idle" },
		]);
		expect(unsub).toHaveBeenCalledTimes(3);
		expect(onError).not.toHaveBeenCalled();
	});
	it("pins the real host completion source, not agent_end or fabricated turns", () => {
		const host = readFileSync(new URL("../../server/agent-service.ts", import.meta.url), "utf8");
		expect(host).toContain('case "agent_settled":');
		const durable = readFileSync(new URL("../../server/durable/addon-bridges.ts", import.meta.url), "utf8");
		expect(durable).toContain('if (!continuation) await this.runner.emit({ type: "agent_settled"');
	});
});
