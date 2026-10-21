import { describe, expect, it } from "vitest";
import {
	METER_LIMITS,
	METER_WORKER_RESOURCE_LIMITS,
	parseMeterHostMessage,
	parseMeterWorkerMessage,
	validateMeterIndexCheckpoint,
	validateMeterSnapshot,
	type UsageMeterSnapshot,
	type MeterIndexCheckpoint,
	type MeterCoveredSourceStatus,
	type MeterTemperSourceStatus,
} from "../../server/usage-accounting-meter-contract.js";

const AT = "2026-10-20T12:00:00.000Z";
const SHA = "a".repeat(64);
function clean(): UsageMeterSnapshot & { sources: MeterCoveredSourceStatus[] } {
	return {
		v: "usage-meter-snapshot/1",
		reportingOnly: true,
		generation: { epoch: SHA, sequence: 1 },
		evaluatedAt: AT,
		weekStart: "2026-10-19",
		state: "ready",
		storage: "healthy",
		inventory: "complete",
		oldestCoveredThrough: AT,
		oldestObservedAt: AT,
		sources: [
			{
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
		],
		subjects: [
			{
				subject: { kind: "role", role: "design" },
				window: { from: "2026-10-19T07:00:00.000Z", through: AT },
				usageCoverage: "complete",
				fundingCoverage: "complete",
				freshness: "fresh",
				coveredThrough: AT,
				observedAt: AT,
				list: { grossObservations: "1.5", deduplicatedRecorded: "1" },
				otherBases: [{ basis: "invoice", knownUsd: "0.5", unpriced: 0 }],
				counts: { unpriced: 0, unresolvedIdentities: 0 },
				funding: {
					wholePolicySubject: true,
					verifiedOwnLowerBound: "1",
					exempt: "0",
					otherPolicy: "0",
					unallocated: "0",
					unallocatedFacts: 0,
					remainingUsd: "1999",
				},
				faults: [],
			},
		],
		faults: [],
	};
}
function checkpoint(): MeterIndexCheckpoint {
	return {
		v: "usage-meter-index/1",
		storeMajor: 1,
		generation: SHA,
		sequence: 12,
		journal: { segment: 3, byte: 1240, sha256: SHA },
		index: { generation: SHA, sequence: 12, sha256: SHA },
		cursors: [
			{
				kind: "file",
				stream: "pi:fixture",
				incarnation: "file:inode",
				ordinal: 8,
				byte: 200,
				line: 3,
				headerSha256: SHA,
				anchor: { start: 100, bytes: 100, sha256: SHA },
			},
			{
				kind: "feed",
				stream: "temper:fixture",
				readerEpoch: "reader-epoch-1",
				token: "opaque/unchanged?token=abc",
				state: "committed",
			},
		],
	};
}

describe("usage meter closed worker seam (no runtime)", () => {
	it("round trips only detached closed scalar snapshots; does not invent invoice/list interchangeability", () => {
		const original = clean();
		const parsed = parseMeterWorkerMessage(JSON.stringify(original));
		expect(parsed).toEqual(original);
		const copy = validateMeterSnapshot(original)!;
		copy.subjects[0].list!.grossObservations = "2";
		expect(original.subjects[0].list!.grossObservations).toBe("1.5");
		expect(original.subjects[0].otherBases).toEqual([{ basis: "invoice", knownUsd: "0.5", unpriced: 0 }]);
	});
	it("fixed worker death/stale/unavailable envelopes cannot expose budget authority", () => {
		for (const state of ["recovering", "stale", "unavailable", "waiting-for-previous-writer"] as const) {
			const value = clean();
			value.state = state;
			expect(validateMeterSnapshot(value)).toBeNull();
			value.subjects[0].usageCoverage = "partial";
			value.subjects[0].fundingCoverage = "partial";
			value.subjects[0].funding!.remainingUsd = null;
			expect(validateMeterSnapshot(value)).toBeNull();
			value.subjects[0].freshness = "stale";
			expect(validateMeterSnapshot(value)).not.toBeNull();
		}
		expect(
			parseMeterWorkerMessage(
				JSON.stringify({
					v: "usage-meter-health/1",
					epoch: SHA,
					at: AT,
					state: "unavailable",
					code: "worker-unavailable",
				}),
			),
		).not.toBeNull();
		expect(
			parseMeterWorkerMessage(
				JSON.stringify({
					v: "usage-meter-health/1",
					epoch: SHA,
					at: AT,
					state: "unavailable",
					code: "worker-unavailable",
					exception: "/secret/path",
				}),
			),
		).toBeNull();
	});
	it("partial inventory, faults, disabled or stalled source cannot become a complete zero or headroom", () => {
		const mutate: ((v: ReturnType<typeof clean>) => void)[] = [
			(v) => {
				v.inventory = "partial";
			},
			(v) => {
				v.storage = "partial";
			},
			(v) => {
				v.faults = [{ code: "store-capacity", count: 1 }];
			},
			(v) => {
				v.subjects[0].faults = [{ code: "revision-gap", count: 1 }];
			},
			(v) => {
				v.sources[0].stalled = true;
			},
			(v) => {
				v.sources[0].enabled = false;
			},
			(v) => {
				v.subjects[0].coveredThrough = "2026-10-20T11:59:00.000Z";
			},
			(v) => {
				v.subjects[0].freshness = "stale";
			},
		];
		for (const change of mutate) {
			const value = clean();
			change(value);
			expect(validateMeterSnapshot(value)).toBeNull();
		}
		const partial = clean();
		partial.inventory = "partial";
		partial.faults = [{ code: "inventory-partial", count: 1 }];
		partial.subjects[0].usageCoverage = "partial";
		partial.subjects[0].fundingCoverage = "partial";
		partial.subjects[0].funding!.remainingUsd = null;
		expect(validateMeterSnapshot(partial)).not.toBeNull();
	});
	it("keeps non-policy subviews neutral; unallocated/unknown counts cannot claim full evidence", () => {
		for (const change of [
			(v: UsageMeterSnapshot) => {
				v.subjects[0].funding!.wholePolicySubject = false;
			},
			(v: UsageMeterSnapshot) => {
				v.subjects[0].funding!.unallocatedFacts = 1;
			},
			(v: UsageMeterSnapshot) => {
				v.subjects[0].counts.unpriced = null;
			},
		]) {
			const value = clean();
			change(value);
			expect(validateMeterSnapshot(value)).toBeNull();
		}
	});
	it("refuses raw provider/session paths, arbitrary faults, fields, huge snapshots and duplicate subjects/sources", () => {
		for (const field of ["payload", "sessionId", "journal", "cursor", "pause", "stop", "cap", "credentials"]) {
			const value = { ...clean(), [field]: "never-forward" };
			expect(parseMeterWorkerMessage(JSON.stringify(value))).toBeNull();
		}
		const bad: unknown[] = [
			null,
			[],
			{},
			{ ...clean(), sources: [{ ...clean().sources[0], path: "/home/private" }] },
			{ ...clean(), faults: [{ code: "/raw/error", count: 1 }] },
			{ ...clean(), subjects: [...clean().subjects, ...clean().subjects] },
			{ ...clean(), sources: [...clean().sources, ...clean().sources] },
		];
		for (const value of bad) expect(validateMeterSnapshot(value)).toBeNull();
		expect(parseMeterWorkerMessage(" ".repeat(METER_LIMITS.snapshotBytes + 1))).toBeNull();
		expect(
			validateMeterSnapshot({
				...clean(),
				subjects: Array.from({ length: METER_LIMITS.subjects + 1 }, () => clean().subjects[0]),
			}),
		).toBeNull();
		const duplicate = clean();
		duplicate.subjects.push({ ...duplicate.subjects[0], subject: { role: "design", kind: "role" } });
		expect(validateMeterSnapshot(duplicate)).toBeNull();
		const accessor = clean();
		Object.defineProperty(accessor, "subjects", {
			enumerable: true,
			get() {
				throw new Error("must-not-read");
			},
		});
		expect(validateMeterSnapshot(accessor)).toBeNull();
	});
	it("watermarks are the independent oldest required source, never newest completion/publication", () => {
		const value = clean();
		const old = "2026-10-20T11:55:00.000Z";
		value.sources.push({
			...value.sources[0],
			index: 1,
			kind: "acp",
			state: "partial",
			complete_through: old,
			observedAt: old,
			lastProgressAt: old,
			stalled: true,
			alarm: "source-stalled",
		});
		expect(validateMeterSnapshot(value)).toBeNull();
		value.oldestCoveredThrough = old;
		value.oldestObservedAt = old;
		value.subjects[0].usageCoverage = "partial";
		value.subjects[0].fundingCoverage = "partial";
		value.subjects[0].funding!.remainingUsd = null;
		expect(validateMeterSnapshot(value)).not.toBeNull();
		value.sources[1].required = false;
		expect(validateMeterSnapshot(value)).toBeNull();
	});
	it("freshness, complete funding and stalled alarms are checked rather than trusted flags", () => {
		const old = "2026-10-20T11:54:59.999Z";
		const v = clean();
		v.sources[0].lastProgressAt = old;
		expect(validateMeterSnapshot(v)).toBeNull();
		v.sources[0].stalled = true;
		v.sources[0].state = "partial";
		v.sources[0].alarm = "source-stalled";
		v.subjects[0].usageCoverage = "partial";
		v.subjects[0].fundingCoverage = "partial";
		v.subjects[0].funding!.remainingUsd = null;
		expect(validateMeterSnapshot(v)).not.toBeNull();
		v.sources[0].lastProgressAt = AT;
		expect(validateMeterSnapshot(v)).toBeNull();
		const partial = clean();
		partial.subjects[0].funding!.remainingUsd = null;
		partial.subjects[0].funding!.unallocatedFacts = 1;
		expect(validateMeterSnapshot(partial)).toBeNull();
		partial.subjects[0].fundingCoverage = "partial";
		partial.subjects[0].usageCoverage = "partial";
		partial.subjects[0].coveredThrough = old;
		partial.subjects[0].observedAt = old;
		expect(validateMeterSnapshot(partial)).toBeNull();
		partial.subjects[0].freshness = "stale";
		expect(validateMeterSnapshot(partial)).not.toBeNull();
		const future = clean();
		future.subjects[0].subject = { kind: "task", queueKey: SHA, task: 1, addedAt: "2027-01-01T00:00:00.000Z" };
		expect(validateMeterSnapshot(future)).toBeNull();
		const notMonday = clean();
		notMonday.weekStart = "2026-10-20";
		expect(validateMeterSnapshot(notMonday)).toBeNull();
	});
	it("Temper v1 frontier is diagnostic only and always UNKNOWN, including delayed/stalled/dead-man", () => {
		const value: UsageMeterSnapshot = clean();
		const temper: MeterTemperSourceStatus = {
			index: 1,
			kind: "temper",
			required: true,
			enabled: true,
			state: "available",
			coverage: "unknown",
			observedAt: AT,
			frontier: {
				diagnosticOnly: true,
				recorded_through: AT,
				pending_count: 2,
				oldest_pending: "2026-10-20T11:58:00.000Z",
				last_drain: "2026-10-20T11:59:59.000Z",
				assessed_from: "2026-10-20T11:00:00.000Z",
				assessed_through: AT,
				freshness: "fresh",
				stallCodes: ["pending"],
			},
		};
		value.sources.push(temper);
		value.oldestCoveredThrough = null;
		expect(validateMeterSnapshot(value)).toBeNull(); // no complete subject/headroom from a frontier
		value.subjects[0].usageCoverage = "partial";
		value.subjects[0].fundingCoverage = "partial";
		value.subjects[0].funding!.remainingUsd = null;
		for (const freshness of ["fresh", "delayed", "stalled", "dead-man", "unknown"] as const) {
			temper.frontier.freshness = freshness;
			expect(validateMeterSnapshot(value)?.sources[1]).toEqual(temper);
		}
		for (const change of [
			(t: Record<string, unknown>) => {
				t.coverage = "complete";
			},
			(t: Record<string, unknown>) => {
				t.state = "partial";
			},
			(t: Record<string, unknown>) => {
				t.complete_through = AT;
			},
			(t: Record<string, unknown>) => {
				t.alarm = "source-stalled";
			},
			(t: Record<string, unknown>) => {
				t.frontier = { ...temper.frontier, diagnosticOnly: false };
			},
			(t: Record<string, unknown>) => {
				t.frontier = { ...temper.frontier, stallCodes: ["raw private exception"] };
			},
			(t: Record<string, unknown>) => {
				t.frontier = { ...temper.frontier, assessed_from: "2027-01-01T00:00:00.000Z" };
			},
		]) {
			const bad = structuredClone(value);
			change(bad.sources[1] as unknown as Record<string, unknown>);
			expect(validateMeterSnapshot(bad)).toBeNull();
		}
		for (const code of [
			"off",
			"forbidden",
			"unavailable",
			"timeout",
			"malformed-page",
			"cursor-quarantined",
		] as const) {
			temper.state = "unavailable";
			temper.frontier.freshness = "unknown";
			temper.frontier.stallCodes = [code];
			value.faults = [{ code: "source-unavailable", count: 1 }];
			expect(validateMeterSnapshot(value)?.sources[1]).toEqual(temper);
		}
	});
	it("host command is only bounded evaluate; no native source, stop, root or grant command", () => {
		const command = { v: "usage-meter-command/1", kind: "evaluate", request: 1, asOf: AT };
		expect(parseMeterHostMessage(command)).toEqual(command);
		for (const value of [
			{ ...command, kind: "stop" },
			{ ...command, root: "fabricated" },
			{ ...command, request: Infinity },
			{ ...command, asOf: "2026-10-99T00:00:00.000Z" },
		])
			expect(parseMeterHostMessage(value)).toBeNull();
	});
	it("closed private checkpoints keep anchored file bytes and exact opaque feed tokens separate from seq", () => {
		const value = checkpoint();
		expect(validateMeterIndexCheckpoint(value)).toEqual(value);
		const corrupt = structuredClone(value);
		corrupt.index.sequence++;
		expect(validateMeterIndexCheckpoint(corrupt)).toBeNull();
		const file = value.cursors[0];
		if (file.kind !== "file") throw new Error("fixture");
		file.anchor.start++;
		expect(validateMeterIndexCheckpoint(value)).toBeNull();
		const feed = checkpoint();
		(feed.cursors[1] as { token: string }).token = "x".repeat(257);
		expect(validateMeterIndexCheckpoint(feed)).toBeNull();
		expect(validateMeterSnapshot(checkpoint())).toBeNull();
		const opaque = checkpoint();
		const cursor = opaque.cursors[1];
		if (cursor.kind !== "feed") throw new Error("fixture");
		cursor.token = "x".repeat(256);
		expect(validateMeterIndexCheckpoint(opaque)).toEqual(opaque);
		cursor.state = "quarantined";
		expect(validateMeterIndexCheckpoint(opaque)?.cursors[1]).toEqual(cursor); // old token retained verbatim on 409
		for (const key of ["seq", "after", "through_seq", "max_seq", "ordinal", "complete_through"]) {
			expect(validateMeterIndexCheckpoint({ ...opaque, cursors: [{ ...cursor, [key]: 1 }] })).toBeNull();
		}
	});
	it("operational bounds are finite and immutable, not money caps", () => {
		for (const n of [...Object.values(METER_LIMITS), ...Object.values(METER_WORKER_RESOURCE_LIMITS)])
			expect(Number.isFinite(n) && n > 0).toBe(true);
		expect(Object.isFrozen(METER_LIMITS)).toBe(true);
		expect(Object.isFrozen(METER_WORKER_RESOURCE_LIMITS)).toBe(true);
		expect(METER_LIMITS.pageBytes).toBe(262144);
		expect(METER_LIMITS.pageRows).toBe(256);
		expect(METER_LIMITS.segmentBytes).toBe(1048576);
		expect(METER_LIMITS.unitWorkMs).toBe(100);
	});
});
