import { describe, expect, it, vi } from "vitest";
import { createLeadChecks } from "../../server/lead-compaction-checks.js";
import type { Fence, Prepared, Ticket } from "../../server/lead-compaction-contract.js";

const fence: Fence = {
	sessionId: "home",
	source: "/isolated/home.jsonl",
	generation: 1,
	mutationRevision: 2,
	bindingEpoch: 1,
	leafId: "leaf",
	cached: true,
};
const prepared: Prepared = {
	planId: "plan",
	planHash: "hash",
	originalFence: fence,
	bindingFingerprint: "binding",
	archiveFingerprints: ["archive"],
	boundary: "keep",
	summaryHash: "summary",
	sourceHash: "source",
	anchorHash: "anchor",
	protectedHash: "protected",
	tailHash: "tail",
	checkpointHash: "checkpoint",
};
function setup() {
	const ticket = Object.freeze({}) as Ticket;
	const host = {
		captureFence: vi.fn(() => fence),
		issueTicket: vi.fn(() => ticket),
		tryApply: vi.fn(async () => ({ state: "applied" as const, sessionId: "home", nativeEntryId: "native" })),
		recover: vi.fn(async () => {}),
	};
	const executor = {
		prepare: vi.fn(async (): Promise<Prepared> => prepared),
		resume: vi.fn(async () => ticket),
		acknowledge: vi.fn(async () => {}),
	};
	return { host, executor, ticket, checks: createLeadChecks(host, executor) };
}
const request = { sessionId: "home", trigger: "idle" as const };
describe("trusted lead check join", () => {
	it("prepares then resumes the exact frozen plan before native application", async () => {
		const { host, executor, ticket, checks } = setup();
		expect(await checks.requestCheck(request)).toEqual({
			state: "applied",
			sessionId: "home",
			nativeEntryId: "native",
			trigger: "idle",
		});
		expect(executor.prepare).toHaveBeenCalledWith(fence);
		expect(executor.resume).toHaveBeenCalledWith("plan", "hash");
		expect(host.tryApply).toHaveBeenCalledWith(ticket);
		expect(executor.acknowledge).not.toHaveBeenCalled(); // H owns durable ack, never duplicate it here.
	});
	it("does not turn an explicit protected floor into a native operation", async () => {
		const { host, executor, checks } = setup();
		executor.prepare.mockResolvedValueOnce({
			state: "protected_floor",
			sessionId: "home",
			protectedFloorEstimate: 220000,
		} as never);
		expect((await checks.requestCheck(request)).state).toBe("protected_floor");
		expect(executor.resume).not.toHaveBeenCalled();
		expect(host.tryApply).not.toHaveBeenCalled();
	});
	it("preserves archive failure without applying or retrying", async () => {
		const { host, executor, checks } = setup();
		executor.resume.mockResolvedValueOnce({
			state: "blocked",
			sessionId: "home",
			errorCode: "E_FOLD_HASH_CONFLICT",
		} as never);
		expect((await checks.requestCheck(request)).errorCode).toBe("E_FOLD_HASH_CONFLICT");
		expect(host.tryApply).not.toHaveBeenCalled();
		expect(executor.resume).toHaveBeenCalledTimes(1);
	});
	it("awaits native recovery, never labels reopened as applied or spins a second cut", async () => {
		const { host, executor, checks } = setup();
		let release!: () => void;
		host.tryApply.mockResolvedValueOnce({
			state: "blocked",
			sessionId: "home",
			errorCode: "native-recovery-required",
		} as never);
		host.recover.mockImplementationOnce(
			() =>
				new Promise<void>((resolve) => {
					release = resolve;
				}),
		);
		const operation = checks.requestCheck(request);
		await vi.waitFor(() => expect(host.recover).toHaveBeenCalledOnce());
		let settled = false;
		void operation.then(() => {
			settled = true;
		});
		await Promise.resolve();
		expect(settled).toBe(false);
		release();
		expect(await operation).toMatchObject({ state: "blocked", nextRetryReason: "native-recovered" });
		expect(executor.prepare).toHaveBeenCalledTimes(1);
		expect(host.tryApply).toHaveBeenCalledTimes(1);
	});
	it("retries owed recovery before preparation and keeps another home independent", async () => {
		const { host, executor, checks } = setup();
		host.tryApply.mockResolvedValueOnce({
			state: "blocked",
			sessionId: "home",
			errorCode: "native-recovery-required",
		} as never);
		host.recover.mockRejectedValue(new Error("private failure must not become status"));
		await checks.requestCheck(request);
		expect(await checks.requestCheck(request)).toMatchObject({
			state: "blocked",
			nextRetryReason: "native-recovery-required",
		});
		expect(executor.prepare).toHaveBeenCalledTimes(1);
		await checks.requestCheck({ ...request, sessionId: "other" });
		expect(executor.prepare).toHaveBeenCalledTimes(2);
		host.recover.mockResolvedValue(undefined);
		await checks.requestCheck(request);
		expect(executor.prepare).toHaveBeenCalledTimes(3);
	});
});
