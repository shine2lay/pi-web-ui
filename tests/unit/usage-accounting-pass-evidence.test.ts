import { expect, it } from "vitest";
import { buildUsageMeterSnapshot, type SnapshotBuildInput } from "../../server/usage-accounting-snapshot.js";
import type { WeekPassEvidence } from "../../server/usage-accounting-evidence.js";
const AT = "2026-10-23T21:00:00.000Z",
	FROM = "2026-10-19T07:00:00.000Z";
function empty(): SnapshotBuildInput {
	const evidence: WeekPassEvidence = {
		v: "usage-evidence/2",
		producer: "week-pass",
		sequence: 1,
		asOf: AT,
		storage: "healthy",
		inventoryComplete: true,
		requiredStreams: ["sessions:2026-10-19"],
		faults: [],
		faultCounts: [],
	};
	return {
		epoch: "a".repeat(64),
		asOf: AT,
		evidence,
		completed: true,
		partitions: [],
		subjects: [{ subject: { kind: "role", role: "design" }, policy: null }],
		coverage: [{ stream: evidence.requiredStreams[0], from: FROM, through: AT, observedAt: AT, status: "complete" }],
		sources: [
			{
				stream: evidence.requiredStreams[0],
				status: {
					index: 0,
					kind: "pi",
					required: true,
					enabled: true,
					state: "complete",
					complete_through: AT,
					observedAt: AT,
					lastProgressAt: AT,
					stalled: false,
					alarm: null,
				},
			},
		],
	};
}
it("only a fully inventoried, complete empty week proves zero with the new producer-neutral header", () => {
	const s = buildUsageMeterSnapshot(empty());
	expect(s.subjects[0].usageCoverage).toBe("complete");
	expect(s.subjects[0].list?.deduplicatedRecorded).toBe("0");
});
it.each(["backlog", "cap", "cursor", "hash", "aborted"])("never turns %s into a healthy empty zero", (fault) => {
	const b = empty();
	if (fault === "backlog") b.coverage[0].status = "partial";
	if (fault === "cap") b.evidence.inventoryComplete = false;
	if (fault === "cursor") {
		b.coverage[0].status = "partial";
		b.evidence.faultCounts.push({ code: "cursor-conflict", count: 1 });
	}
	if (fault === "hash") b.evidence.storage = "unavailable";
	if (fault === "aborted") b.completed = false;
	const s = buildUsageMeterSnapshot(b);
	expect(s.subjects[0].usageCoverage).not.toBe("complete");
	// A known subtotal may be zero, but it is not clean/full evidence or a funding remainder.
	expect(s.subjects[0].funding?.remainingUsd ?? null).toBeNull();
});
it("rejects a v2 stamp without its declared producer rather than impersonating W0", () => {
	const b = empty();
	Object.assign(b.evidence, { producer: "unreviewed" });
	const s = buildUsageMeterSnapshot(b);
	expect(s.subjects[0].usageCoverage).toBe("unavailable");
});
