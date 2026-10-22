// Ops #416 H-WW-SCAN-1: prune's audit-receipt index gives exactly what the two scans it replaced gave.
import { describe, expect, it } from "vitest";
import type { GuardAuditReceipt } from "../../server/role-message-guard-contract.js";
import { guardAuditIndex } from "../../server/role-message-guard-core.js";

// Frozen copies of the scans prune ran before #416, one per outbox entry or transaction.
const scanLatest = (audits: readonly GuardAuditReceipt[], subjectId: string): number =>
	Math.max(...audits.filter((a) => a.subjectId === subjectId).map((a) => a.at));
const scanFirst = (audits: readonly GuardAuditReceipt[], transactionId: string): number | undefined =>
	audits.find((a) => a.transactionId === transactionId)?.at;

let made = 0;
const receipt = (transactionId: string, subjectId: string, at: number): GuardAuditReceipt => ({
	id: `audit-${++made}`,
	transactionId,
	subjectId,
	event: "used",
	proof: null,
	at,
});
/** Every lookup the index answers equals the old scan's answer, compared with Object.is (so NaN and -0 count). */
function agrees(audits: readonly GuardAuditReceipt[], extraKeys: readonly string[] = []): void {
	const index = guardAuditIndex(audits);
	for (const s of [...new Set(audits.map((a) => a.subjectId)), ...extraKeys])
		expect(Object.is(index.latestAt(s), scanLatest(audits, s)), `latestAt ${s}`).toBe(true);
	for (const t of [...new Set(audits.map((a) => a.transactionId)), ...extraKeys])
		expect(Object.is(index.firstAt(t), scanFirst(audits, t)), `firstAt ${t}`).toBe(true);
}

describe("guard core: prune's audit-receipt index (Ops #416)", () => {
	it("a transaction named by several receipts gives the FIRST receipt's time, not a later, larger or smaller one", () => {
		const audits = [
			receipt("tx-a", "operation:accepted", 100),
			receipt("tx-b", "outbox:1", 50),
			receipt("tx-a", "outbox:1", 300),
			receipt("tx-a", "operation:accepted", 20),
			receipt("tx-b", "outbox:2", 50),
		];
		const index = guardAuditIndex(audits);
		expect(index.firstAt("tx-a")).toBe(100);
		expect(index.firstAt("tx-b")).toBe(50);
		expect(index.firstAt("tx-none")).toBeUndefined();
		agrees(audits, ["tx-none"]);
	});

	it("a subject gives the largest time of its receipts, in any order, and -Infinity when it has none", () => {
		const audits = [
			receipt("tx-1", "outbox:9", 400),
			receipt("tx-2", "outbox:9", 900),
			receipt("tx-3", "outbox:8", 700),
			receipt("tx-4", "outbox:9", 600),
		];
		const index = guardAuditIndex(audits);
		expect(index.latestAt("outbox:9")).toBe(900);
		expect(index.latestAt("outbox:8")).toBe(700);
		expect(index.latestAt("outbox:7")).toBe(-Infinity);
		agrees(audits, ["outbox:7"]);
		agrees([...audits].reverse(), ["outbox:7"]);
		// So prune's age reads the same: Math.max(committed, evidence, latest) = Math.max(committed, evidence, ...scan).
		for (const s of ["outbox:9", "outbox:8", "outbox:7"])
			expect(Math.max(800, 0, index.latestAt(s))).toBe(
				Math.max(800, 0, ...audits.filter((a) => a.subjectId === s).map((a) => a.at)),
			);
	});

	it("NaN and -0 come out as the scans gave them; an empty list knows nothing", () => {
		agrees([receipt("tx-n", "outbox:1", Number.NaN), receipt("tx-n", "outbox:1", 5)]);
		agrees([receipt("tx-n", "outbox:1", 5), receipt("tx-n", "outbox:1", Number.NaN)]);
		agrees([receipt("tx-z", "outbox:2", -0)]);
		agrees([receipt("tx-z", "outbox:2", -0), receipt("tx-y", "outbox:2", 0)]);
		agrees([receipt("tx-z", "outbox:2", 0), receipt("tx-y", "outbox:2", -0)]);
		agrees([], ["outbox:1", "tx-a"]);
		expect(guardAuditIndex([]).latestAt("outbox:1")).toBe(-Infinity);
		expect(guardAuditIndex([]).firstAt("tx-a")).toBeUndefined();
	});

	it("agrees with both scans on 2,000 fixed pseudo-random receipts with many repeated ids", () => {
		// A 32-bit linear congruential generator, exact in integers (Math.imul), using its better high bits.
		let seed = 416;
		const next = (n: number) => {
			seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
			return (seed >>> 16) % n;
		};
		const audits = Array.from({ length: 2000 }, () =>
			receipt(`guard-tx-${next(60)}`, next(3) === 0 ? `operation:${next(4)}` : `outbox:${next(40)}`, next(50) * 1000),
		);
		agrees(audits, ["guard-tx-none", "outbox:none"]);
	});
});
