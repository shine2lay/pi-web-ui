import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { rtpiCanonical, rtpiStructural, type RtpiJson } from "../../server/rtpi-core.js";
import {
	displayRequestedAmount,
	requestedPeriodBounds,
	validateRequestedWire,
	type RequestedObject,
} from "../../server/roles-requested-contract.js";
import {
	createRequestedReaderFixture,
	readRequestedSpend,
	readRequestedSpendFixture,
	type FixtureDescriptorReceipt,
	type FixtureReaderBinding,
	type FixtureStat,
} from "../../server/roles-requested.js";

const NOW = 1791874800000;
const ref = (kind: string, id: string): RtpiJson => ({ namespace: "rtpi-fixture", kind, id, revision: "1" });
function publication(): RequestedObject {
	return {
		schema: "i-pub/requested/1",
		contractRevision: "candidate-2",
		objectId: "requested:ops-synthetic",
		source: ref("source", "fixture-own-role-attempts"),
		issuer: ref("issuer", "fixture-private-publisher"),
		subject: ref("subject", "ops-synthetic"),
		lineage: ref("lineage", "fixture-prospective-lineage"),
		incarnation: "fixture-1",
		publicationRevision: 1,
		expectedRevision: 0,
		role: ref("role", "ops-synthetic"),
		currency: "USD",
		valuation: "list-price",
		precision: 18,
		rounding: "HALF_EVEN",
		period: {
			start: "2026-10-05T07:00:00Z",
			end: "2026-10-12T07:00:00Z",
			timezone: "America/Los_Angeles",
			timeBasis: "attempt-terminal",
		},
		generatedAt: 1791788460000,
		asOf: 1791788400000,
		captureStart: 1791183600000,
		cohort: {
			revision: ref("cohort", "historical-eligible-ops"),
			originRevision: ref("origin", "fixture-origin"),
			allocationRevision: ref("allocation", "accepted-ops-full-share"),
			accountingRole: ref("role", "ops-synthetic"),
			membership: "eligible",
		},
		chargeScope: { revision: ref("policy", "fixture-charge-scope"), token: "complete", nonToken: "not-applicable" },
		coverage: {
			capture: "complete",
			pricing: "complete",
			settlement: "complete",
			origin: "complete",
			allocation: "complete",
			count: "complete",
		},
		state: "known",
		knownAmount: "2.000000000000000000",
		counts: {
			unit: "invocation-attempt",
			requestedObserved: 1,
			fullyPriced: 1,
			partlyPriced: 0,
			unpriced: 0,
			pending: 0,
			attributionUnknownObserved: 0,
			missingSourceCount: 0,
			uniqueAttemptBasis: ref("dedup", "component-then-attempt"),
		},
		reasons: [],
		evidence: [ref("coverage", "closed-own-role-period")],
		attestation: {
			schema: "i-pub/attestation/1",
			receipt: ref("attestation", "publisher-local-synthetic-reconciliation"),
			validatorVersion: "i-pub/requested/1:candidate-2",
			calculationVersion: "i-pub/calc/1",
			result: "complete",
		},
	};
}
function object(value: RtpiJson): RequestedObject {
	return value as RequestedObject;
}
function binding(pub = publication(), now = NOW): FixtureReaderBinding {
	return { rootId: "fixture-registry-root", publication: pub, viewPeriod: pub.period, trustedNow: now };
}
function stat(kind: "regular" | "directory", size = 0): FixtureStat {
	return { dev: 1, ino: kind === "directory" ? 2 : 3, size, mtimeNs: "1", ctimeNs: "2", nlink: 1, kind };
}
function receipt(pub = publication()): FixtureDescriptorReceipt {
	const bytes = rtpiCanonical(pub);
	return {
		schema: "i-pub/fd-fixture/1",
		namespace: "rtpi-fixture",
		rootId: "fixture-registry-root",
		basename: "requested-spend.json",
		components: [{ before: stat("directory"), after: stat("directory") }],
		before: stat("regular", Buffer.byteLength(bytes)),
		after: stat("regular", Buffer.byteLength(bytes)),
		violations: [],
		bytes,
	};
}
function attempt(pub: RequestedObject, expected = publication()) {
	return readRequestedSpendFixture(createRequestedReaderFixture(binding(expected)), receipt(pub));
}

describe("R10 V10/V12/S01: closed I-PUB sidecar, not a C0 or native capability", () => {
	it("no T04 is unavailable, has no caller knobs and no publication I/O", () => {
		expect(readRequestedSpend.length).toBe(0);
		expect(readRequestedSpend()).toEqual({
			status: "unavailable",
			reason: "T04-native-reader-absent",
			label: "Role-reported list-price",
			aggregateAllowed: false,
		});
		const native = readFileSync(new URL("../../server/roles-requested-native.ts", import.meta.url), "utf8");
		expect(native).not.toMatch(/from\s*["']node:fs|readFile|realpath|lstat|O_NOFOLLOW/);
		expect(native).toContain("return null;");
	});
	it("accepts exact role-reported fixture only; forged/copied/null capabilities refuse", () => {
		const cap = createRequestedReaderFixture(binding());
		const result = readRequestedSpendFixture(cap, receipt());
		expect(result).toMatchObject({
			status: "fixture",
			label: "Role-reported list-price",
			aggregateAllowed: false,
			placement: "current",
			displayTotal: "$2.00",
			displayKnownParts: null,
			proof: "adapter-fixture-only-not-kernel-or-durable-CAS",
		});
		for (const fake of [null, {}, { ...cap }, { namespace: "rtpi-native", qualified: true }]) {
			expect(readRequestedSpendFixture(fake, receipt())).toEqual({
				status: "refused",
				reason: "fixture-capability-refused",
			});
		}
		expect(rtpiStructural(publication()).status).not.toBe("accepted");
	});
	it("frozen exact mapping refuses every role/source/issuer/subject/lineage/incarnation/stream drift", () => {
		for (const key of ["source", "issuer", "subject", "lineage", "role"]) {
			const pub = publication();
			object(pub[key]).id = "other-role-or-stream";
			if (key === "role") object(pub.cohort).accountingRole = structuredClone(pub.role);
			expect(attempt(pub).status).toBe("refused");
		}
		for (const key of ["incarnation", "objectId"]) {
			const pub = publication();
			pub[key] = "different";
			expect(attempt(pub).status).toBe("refused");
		}
		const fixed = binding();
		const cap = createRequestedReaderFixture(fixed);
		object(fixed.publication.source).id = "mutated-after-admission";
		expect(readRequestedSpendFixture(cap, receipt()).status).toBe("fixture");
		const native = publication();
		object(native.role).namespace = "rtpi-native";
		expect(() => createRequestedReaderFixture(binding(native))).toThrow();
	});
	it("closed keys at every nested object, token/enum/count/ref/attestation/period constraints", () => {
		for (const name of [
			null,
			"source",
			"issuer",
			"subject",
			"lineage",
			"role",
			"period",
			"cohort",
			"chargeScope",
			"coverage",
			"counts",
			"attestation",
		] as const) {
			const pub = publication();
			(name === null ? pub : object(pub[name])).extra = "refused";
			expect(() => validateRequestedWire(rtpiCanonical(pub), NOW)).toThrow();
		}
		const mutations: ((p: RequestedObject) => void)[] = [
			(p) => {
				p.contractRevision = "candidate-1";
			},
			(p) => {
				p.objectId = "control\n";
			},
			(p) => {
				p.knownAmount = "02.000000000000000000";
			},
			(p) => {
				p.knownAmount = null;
			},
			(p) => {
				p.generatedAt = NOW + 1;
			},
			(p) => {
				p.captureStart = NOW;
			},
			(p) => {
				object(p.counts).unit = "task";
			},
			(p) => {
				object(p.counts).fullyPriced = 2;
			},
			(p) => {
				object(p.counts).missingSourceCount = null;
			},
			(p) => {
				object(p.counts).requestedObserved = 0;
				object(p.counts).fullyPriced = 0;
			},
			(p) => {
				object(p.cohort).accountingRole = ref("role", "other");
			},
			(p) => {
				object(p.source).kind = "issuer";
			},
			(p) => {
				object(p.source).namespace = "rtpi-native";
			},
			(p) => {
				object(p.coverage).pricing = "unpriced";
			},
			(p) => {
				object(p.chargeScope).token = "unknown";
			},
			(p) => {
				object(p.attestation).calculationVersion = "2";
			},
			(p) => {
				object(p.period).end = "2026-10-13T07:00:00Z";
			},
			(p) => {
				p.evidence = [ref("subject", "not-evidence")];
			},
		];
		for (const mutate of mutations) {
			const pub = publication();
			mutate(pub);
			expect(() => validateRequestedWire(rtpiCanonical(pub), NOW)).toThrow();
		}
	});
	it("RTPI canonical bytes reject duplicate keys, BOM, whitespace, floats and raw oversize", () => {
		const bytes = rtpiCanonical(publication());
		for (const invalid of [bytes + " ", "\uFEFF" + bytes, '{"schema":1,"schema":2}', '{"x":0.1}', " ".repeat(65537)]) {
			expect(() => validateRequestedWire(invalid, NOW)).toThrow();
		}
	});
});
describe("R10 P0 S06 descriptor adapter refusals — FIXTURES, not kernel confinement", () => {
	for (const violation of [
		"ancestor-symlink",
		"root-symlink",
		"leaf-symlink",
		"rename-swap",
		"root-rename",
		"magic-link",
		"traversal",
		"hard-link",
		"fifo",
		"device",
		"oversize",
		"changed-during-read",
	]) {
		it(`refuses ${violation} with no fallback`, () => {
			const fd = receipt();
			fd.violations = [violation];
			expect(readRequestedSpendFixture(createRequestedReaderFixture(binding()), fd)).toEqual({
				status: "refused",
				reason: `descriptor-${violation}`,
			});
		});
	}
	it("checks fixed root/basename, every component, regular nlink1, raw cap and stable same descriptor", () => {
		const mutations: ((fd: FixtureDescriptorReceipt) => void)[] = [
			(fd) => {
				fd.rootId = "different-root";
			},
			(fd) => {
				fd.namespace = "rtpi-native" as "rtpi-fixture";
			},
			(fd) => {
				fd.before.kind = "fifo";
			},
			(fd) => {
				fd.before.nlink = 2;
			},
			(fd) => {
				fd.before.size = 65537;
			},
			(fd) => {
				fd.after.ino++;
			},
			(fd) => {
				fd.after.ctimeNs = "3";
			},
			(fd) => {
				fd.after.mtimeNs = "3";
			},
			(fd) => {
				fd.after.dev++;
			},
			(fd) => {
				fd.bytes += " ";
			},
			(fd) => {
				fd.components = [];
			},
			(fd) => {
				fd.components[0].after.ino++;
			},
			(fd) => {
				fd.components[0].before.kind = "symlink";
			},
			(fd) => {
				fd.violations = ["unrecognized-proof"];
			},
		];
		for (const mutate of mutations) {
			const fd = receipt();
			mutate(fd);
			expect(readRequestedSpendFixture(createRequestedReaderFixture(binding()), fd).status).toBe("refused");
		}
	});
});
describe("R10 V12 revision, freshness, individual display and unchanged own-v1", () => {
	it("revision idempotence/conflict/next predecessor are fixture-only, never sum or mtime winners", () => {
		const cap = createRequestedReaderFixture(binding());
		expect(readRequestedSpendFixture(cap, receipt())).toMatchObject({ status: "fixture", idempotent: false });
		expect(readRequestedSpendFixture(cap, receipt())).toMatchObject({ status: "fixture", idempotent: true });
		const conflict = publication();
		conflict.knownAmount = "3.000000000000000000";
		expect(readRequestedSpendFixture(cap, receipt(conflict))).toMatchObject({
			status: "refused",
			reason: "publication-conflict",
		});
		const next = publication();
		next.publicationRevision = 2;
		next.expectedRevision = 1;
		expect(readRequestedSpendFixture(cap, receipt(next))).toMatchObject({ status: "fixture", idempotent: false });
		expect(readRequestedSpendFixture(cap, receipt())).toMatchObject({
			status: "refused",
			reason: "publication-predecessor",
		});
		const skip = publication();
		skip.publicationRevision = 4;
		skip.expectedRevision = 3;
		expect(readRequestedSpendFixture(cap, receipt(skip)).status).toBe("refused");
	});
	it("strictly greater than 24h asOf is separate last-known; mtime/generatedAt never refresh it", () => {
		for (const [age, placement] of [
			[86400000, "current"],
			[86400001, "last-known"],
		] as const) {
			const fixed = binding();
			fixed.trustedNow = Number(fixed.publication.asOf) + age;
			fixed.publication.generatedAt = fixed.trustedNow;
			const fd = receipt(fixed.publication);
			fd.before.mtimeNs = "999999999999999999";
			fd.after.mtimeNs = fd.before.mtimeNs;
			const view = readRequestedSpendFixture(createRequestedReaderFixture(fixed), fd);
			expect(view).toMatchObject({ status: "fixture", placement });
		}
		const fixed = binding();
		fixed.viewPeriod = {
			...object(fixed.publication.period),
			start: "2026-10-12T07:00:00Z",
			end: "2026-10-19T07:00:00Z",
		};
		expect(readRequestedSpendFixture(createRequestedReaderFixture(fixed), receipt())).toMatchObject({
			status: "fixture",
			placement: "last-known",
			viewReasons: ["period-mismatch"],
		});
	});
	it("proven-empty zero allowed; incomplete zero/missing amount never shows a zero total", () => {
		const empty = publication();
		empty.knownAmount = "0.000000000000000000";
		object(empty.counts).requestedObserved = 0;
		object(empty.counts).fullyPriced = 0;
		expect(attempt(empty, empty)).toMatchObject({ status: "fixture", displayTotal: "$0.00", displayKnownParts: null });
		for (const knownAmount of ["0.000000000000000000", "0.004000000000000000", "0.250000000000000000", null]) {
			const pub = publication();
			pub.knownAmount = knownAmount;
			pub.state = knownAmount === null ? "unpriced" : "partial";
			object(pub.coverage).capture = "partial";
			object(pub.coverage).count = "partial";
			object(pub.attestation).result = "incomplete";
			pub.reasons = ["capture-partial", "count-unresolved"];
			if (knownAmount === null) {
				object(pub.coverage).pricing = "unknown";
				object(pub.counts).fullyPriced = 0;
				object(pub.counts).unpriced = 1;
				pub.reasons.push("pricing-unresolved");
			}
			expect(attempt(pub, pub)).toMatchObject({
				status: "fixture",
				displayTotal: null,
				displayKnownParts: knownAmount === "0.250000000000000000" ? "$0.25" : null,
			});
		}
		expect(displayRequestedAmount("0.005000000000000000")).toBe("$0.00");
		expect(displayRequestedAmount("0.015000000000000000")).toBe("$0.02");
	});
	it("DST successive local Mondays preserve 167h/169h, not fixed 168h", () => {
		for (const [start, end, hours] of [
			["2026-03-02T08:00:00Z", "2026-03-09T07:00:00Z", 167],
			["2026-10-26T07:00:00Z", "2026-11-02T08:00:00Z", 169],
		] as const) {
			const times = requestedPeriodBounds({ ...object(publication().period), start, end });
			expect((times.end - times.start) / 3600000).toBe(hours);
		}
	});
	it("S07 own-v1 implementation/tests bytes unchanged, additive sidecar has no production importer or aggregate", () => {
		for (const [file, hash] of [
			["../../server/roles-spend.ts", "38fb25ea8903c7abfd9694a0b94531a49f92105975f26023660193987e30c858"],
			["./roles-spend.test.ts", "d7c8feb802567765a7ea11f7570b30a08980170fa4b4da8fe8b4ac0dd3c0c914"],
		]) {
			expect(
				createHash("sha256")
					.update(readFileSync(new URL(file, import.meta.url)))
					.digest("hex"),
			).toBe(hash);
		}
		const server = new URL("../../server/", import.meta.url).pathname;
		function scan(directory: string): void {
			for (const entry of readdirSync(directory, { withFileTypes: true })) {
				const path = join(directory, entry.name);
				if (entry.isDirectory()) scan(path);
				else if (entry.name.endsWith(".ts") && !entry.name.startsWith("roles-requested")) {
					expect(/(?:from\s*|import\s*\()["'][^"']*roles-requested/.test(readFileSync(path, "utf8"))).toBe(false);
				}
			}
		}
		scan(server);
		const pub = publication();
		pub.aggregateAmount = "2.000000000000000000";
		expect(() => validateRequestedWire(rtpiCanonical(pub), NOW)).toThrow();
		expect(attempt(publication())).toMatchObject({ status: "fixture", aggregateAllowed: false });
	});
});
