// RTPI/1 candidate-2 core: fixed stage cases with naive "old code" counterfactuals (Ops #136, unit C0).
// Synthetic rtpi-fixture data only: no native records, no real chats, no model calls, no files.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
	RTPI_LIMITS,
	createRtpiFixtureCapability,
	isRtpiAccepted,
	isRtpiCapability,
	rtpiActivityWindow,
	rtpiAuditSchema,
	rtpiCanonical,
	rtpiCheckpointDigest,
	rtpiDedupDecision,
	rtpiDomainCoverage,
	rtpiEncodeFrame,
	rtpiGateCoverage,
	rtpiParse,
	rtpiPendingWindow,
	rtpiProcessed,
	rtpiPrunable,
	rtpiRecoverSegment,
	rtpiRetention,
	rtpiSha256,
	rtpiSnapshotCoverage,
	rtpiStructural,
	rtpiValidate,
	rtpiValidateBytes,
	type RtpiAccepted,
	type RtpiArtifactKey,
	type RtpiCapabilitySpec,
	type RtpiFact,
	type RtpiNamespace,
	type RtpiQualification,
	type RtpiRef,
	type RtpiRootSchema,
	type RtpiVerdict,
} from "../../server/rtpi-core.js";
import { RTPI_SCHEMA, RTPI_SCHEMA_CANONICAL_BYTES, RTPI_SCHEMA_CANONICAL_SHA256 } from "../../server/rtpi-schema.js";

type J = Record<string, unknown>;
const ref = (kind: string, id: string, revision = "1", namespace: RtpiNamespace = "rtpi-fixture"): RtpiRef => ({
	namespace,
	kind,
	id,
	revision,
});
const SOURCE = ref("source", "fixture-source");
const ISSUER = ref("issuer", "fixture-issuer");
const SUBJECT = ref("subject", "role-ops");
const LINEAGE = ref("lineage", "lineage-ops");
const QUEUE = { queue: ref("queue", "queue-ops") };
const witness = (attempt = "a1", revision = "1") => ({
	session: ref("session", "s1"),
	epoch: ref("epoch", "e1"),
	turn: ref("turn", "t1"),
	run: ref("run", "r1"),
	attempt: ref("attempt", attempt, revision),
});
const W1 = witness();
const MSG_CTX = { ...W1, recipient: ref("role", "role-data") };
const ALL_FACTS: RtpiFact[] = [
	"queue-snapshot",
	"message-admitted",
	"message-delivered",
	"message-included",
	"message-settled",
	"message-replied",
	"owner-saved",
	"owner-rendered",
	"owner-opened",
	"owner-acknowledged",
	"artifact-confirmed",
	"policy-approved",
	"origin-classified",
	"gate-observed",
	"resource-incorporated",
	"config-saved",
	"profile-selected",
	"registry-linked",
	"design-linked",
	"report-linked",
	"handoff-accepted",
	"publication-linked",
	"capture-gap",
];
const ALL_ROOTS: RtpiRootSchema[] = [
	"rtpi/event/1",
	"rtpi/design/1",
	"rtpi/lineage/1",
	"rtpi/checkpoint/1",
	"rtpi/gate-contract/1",
	"rtpi/publication/1",
	"rtpi/aggregate/1",
];
const SEAMS = { inputHook: true, atomicOutbox: true, ownerPrincipal: true, confinedReader: true, issuerRegistry: true };

function cap(over: Partial<RtpiCapabilitySpec> = {}) {
	return createRtpiFixtureCapability({
		source: SOURCE,
		issuer: ISSUER,
		subject: SUBJECT,
		roots: ALL_ROOTS,
		facts: ALL_FACTS,
		policyAccepted: true,
		acceptedSidecars: [],
		seams: SEAMS,
		...over,
	});
}
function ctx(over: J = {}): J {
	return {
		queue: null,
		taskId: null,
		planRevision: null,
		session: null,
		epoch: null,
		turn: null,
		run: null,
		attempt: null,
		recipient: null,
		channel: "role",
		action: null,
		artifact: null,
		owner: null,
		client: null,
		window: null,
		projection: null,
		coverage: null,
		policy: null,
		challenge: null,
		...over,
	};
}
function event(body: J, context: J = {}, over: J = {}, n = 1): J {
	return {
		schema: "rtpi/event/1",
		eventId: `event-${n}`,
		source: SOURCE,
		issuer: ISSUER,
		subject: SUBJECT,
		lineage: LINEAGE,
		incarnation: "inc-1",
		sequence: n,
		revision: n,
		expectedRevision: n - 1,
		occurredAt: 1000 + n,
		context: ctx(context),
		body,
		...over,
	};
}
function q(n = 1, over: RtpiQualification = {}): RtpiQualification {
	return {
		lineage: LINEAGE,
		incarnation: "inc-1",
		currentRevision: n - 1,
		currentSequence: n - 1,
		sourceCommitted: true,
		serverNow: 5000,
		...over,
	};
}
const COUNTS = { ready: 1, working: 1, asking: 0, stuck: 0, waiting: 0, blocked: 0, done: 3 };
const queueBody = (over: J = {}): J => ({
	fact: "queue-snapshot",
	status: "known",
	capacity: 4,
	occupied: 2,
	counts: COUNTS,
	fullIndex: true,
	refs: [],
	...over,
});
const msg = (fact: string, over: J = {}): J => ({
	fact,
	status: "known",
	success: null,
	errorCode: "none",
	refs: [],
	...over,
});
function checkpoint(over: J = {}): J {
	const c: J = {
		schema: "rtpi/checkpoint/1",
		objectId: "cp-1",
		source: SOURCE,
		issuer: ISSUER,
		subject: SUBJECT,
		lineage: LINEAGE,
		sequence: 1,
		sourceWatermark: 1,
		captureStart: 0,
		cutoff: 1000,
		gapFree: true,
		durable: true,
		policy: ref("policy", "capture-policy"),
		dedup: [],
		accepted: [],
		held: [],
		acknowledged: [],
		needed: [],
		...over,
	};
	return { ...c, hash: rtpiCheckpointDigest(c) };
}
const ARTIFACT_KEY: RtpiArtifactKey = {
	gitHead: "a".repeat(40),
	assetsSha256: "b".repeat(64),
	version: "1.0.0",
	manifestRevision: 1,
	targetEnvironment: "spark",
	environmentEpoch: "env-1",
};
const GATE_ISSUER = ref("issuer", "roles-gate-issuer");
function gateContract(over: J = {}): J {
	return {
		schema: "rtpi/gate-contract/1",
		objectId: "gc-1",
		source: SOURCE,
		issuer: ISSUER,
		subject: SUBJECT,
		revision: 1,
		domain: "roles",
		acceptedBy: GATE_ISSUER,
		required: [
			{ stage: "built", applicable: true, independent: false, dependsOn: [] },
			{ stage: "checked", applicable: true, independent: true, dependsOn: ["built"] },
		],
		artifact: { ...ARTIFACT_KEY },
		...over,
	};
}

function accepted(v: RtpiVerdict): RtpiAccepted {
	expect(v.status, v.status === "accepted" ? "" : v.reason).toBe("accepted");
	return v as RtpiAccepted;
}
function refused(v: RtpiVerdict, status: string, reason: string): void {
	expect(v).toEqual({ status, reason });
}

describe("RTPI/1 schema binding", () => {
	it("binds the embedded schema to the accepted SCHEMAS.json canonical bytes", () => {
		const text = rtpiCanonical(RTPI_SCHEMA);
		expect(Buffer.byteLength(text)).toBe(RTPI_SCHEMA_CANONICAL_BYTES);
		expect(createHash("sha256").update(text).digest("hex")).toBe(RTPI_SCHEMA_CANONICAL_SHA256);
	});

	it("audits as closed: closed objects, bounded arrays and strings, local acyclic references", () => {
		expect(rtpiAuditSchema(RTPI_SCHEMA)).toBe(Object.keys(RTPI_SCHEMA.$defs).length);
		const open = {
			...RTPI_SCHEMA,
			$defs: { ...RTPI_SCHEMA.$defs, counts: { ...RTPI_SCHEMA.$defs.counts, additionalProperties: true } },
		};
		expect(() => rtpiAuditSchema(open)).toThrow("open-object-schema");
	});
});

describe("V01 closed envelope from a registered producer", () => {
	it("accepts a qualified fixture record and binds its digest to the canonical bytes", () => {
		const v = accepted(rtpiValidate(event(queueBody(), QUEUE), cap(), q()));
		expect(v.qualified).toBe(true);
		expect(v.digest).toBe(rtpiSha256(v.canonical));
		expect(isRtpiAccepted(v)).toBe(true);
		expect(isRtpiAccepted({ ...v })).toBe(false);
	});

	it("refuses duplicate keys that JSON.parse silently resolves", () => {
		const text = '{"a":1,"a":2}';
		expect(JSON.parse(text)).toEqual({ a: 2 }); // counterfactual: the last value wins without a trace
		expect(() => rtpiParse(text)).toThrow("duplicate-json-key");
		const wire = rtpiCanonical(event(queueBody(), QUEUE)).replace(
			'"eventId":"event-1"',
			'"eventId":"event-1","eventId":"event-9"',
		);
		refused(rtpiValidateBytes(wire, cap(), q()), "rejected", "duplicate-json-key");
	});

	it("refuses floats, non-finite numbers, unsafe integers, a BOM, lone surrogates and invalid UTF-8", () => {
		expect(() => rtpiParse('{"a":1.5}')).toThrow("float-json-number");
		expect(() => rtpiParse('{"a":NaN}')).toThrow("nonfinite-json-number");
		expect(() => rtpiParse('{"a":9007199254740993}')).toThrow("unsafe-json-integer");
		expect(() => rtpiParse('\ufeff{"a":1}')).toThrow("byte-order-mark");
		expect(() => rtpiParse('{"a":"\\ud800"}')).toThrow("invalid-canonical-number-or-unicode");
		expect(() => rtpiParse(Uint8Array.from([0x7b, 0xff, 0x7d]))).toThrow("invalid-utf8");
	});

	it("makes an unknown root version unavailable, not accepted", () => {
		refused(
			rtpiValidate(event(queueBody(), QUEUE, { schema: "rtpi/event/2" }), cap(), q()),
			"unavailable",
			"unknown-root-schema",
		);
	});

	it("refuses unknown fields such as authority flags (closed schema)", () => {
		refused(rtpiValidate(event(queueBody({ verified: true }), QUEUE), cap(), q()), "rejected", "closed-schema-union");
		refused(
			rtpiValidate(event(queueBody(), QUEUE, { ownerApproved: true }), cap(), q()),
			"rejected",
			"closed-schema-union",
		);
	});

	it("caps an event at 8192 canonical bytes, independently of the 64-reference bound", () => {
		const long = Array.from({ length: 40 }, (_, i) => ref("receipt", `r${i}-`.padEnd(128, "x")));
		const big = event(queueBody({ refs: long }), QUEUE);
		expect(Buffer.byteLength(rtpiCanonical(big))).toBeGreaterThan(8192);
		expect(Buffer.byteLength(rtpiCanonical(big))).toBeLessThan(65536); // counterfactual: the generic 64 KiB cap passes it
		refused(rtpiValidate(big, cap(), q()), "rejected", "canonical-root-byte-bound");
		const many = event(queueBody({ refs: Array.from({ length: 61 }, (_, i) => ref("receipt", `r${i}`)) }), QUEUE);
		expect(Buffer.byteLength(rtpiCanonical(many))).toBeLessThan(8192);
		refused(rtpiValidate(many, cap(), q()), "rejected", "total-nested-reference-bound");
	});

	it("refuses path-like and URL ids", () => {
		for (const id of ["../etc", "/etc/passwd", "https://example.com/x", "a b", "a\n"])
			refused(rtpiValidate(event(queueBody(), QUEUE, { eventId: id }), cap(), q()), "rejected", "closed-schema-union");
	});

	it("refuses a timestamp later than the native server clock", () => {
		refused(rtpiValidate(event(queueBody(), QUEUE, { occurredAt: 5001 }), cap(), q()), "rejected", "future-timestamp");
	});

	it("does not take a capability from model or client data", () => {
		const real = cap();
		const forged = JSON.parse(JSON.stringify({ ...real, toJSON: undefined })) as typeof real;
		expect(Object.keys(forged)).toContain("seams"); // counterfactual: a field-shape check would accept the copy
		expect(isRtpiCapability(forged)).toBe(false);
		refused(rtpiValidate(event(queueBody(), QUEUE), forged, q()), "unavailable", "capability-missing");
		expect(() => JSON.stringify(real)).toThrow("capability-not-serializable");
	});

	it("keeps every rtpi-native root unavailable: no native issuer registry exists in C0 (T05)", () => {
		const n = (kind: string, id: string) => ref(kind, id, "1", "rtpi-native");
		const native = event(
			queueBody(),
			{ queue: n("queue", "queue-ops") },
			{
				source: n("source", "s"),
				issuer: n("issuer", "i"),
				subject: n("subject", "role-ops"),
				lineage: n("lineage", "l"),
			},
		);
		refused(rtpiValidate(native, null, q()), "unavailable", "native-issuer-registry-missing");
		refused(rtpiValidate(native, cap(), q()), "rejected", "capability-namespace-mismatch");
		refused(rtpiValidate({ ...native, source: SOURCE }, cap(), q()), "rejected", "mixed-reference-namespace");
	});

	it("binds a record to its own role: a cross-role subject or another producer's source is refused", () => {
		refused(
			rtpiValidate(event(queueBody(), QUEUE, { subject: ref("subject", "role-data") }), cap(), q()),
			"rejected",
			"native-subject-unqualified",
		);
		refused(
			rtpiValidate(event(queueBody(), QUEUE, { source: ref("source", "other") }), cap(), q()),
			"rejected",
			"native-source-issuer-unqualified",
		);
	});

	it("makes publications and aggregates unavailable in C0, structurally too", () => {
		refused(rtpiStructural({ schema: "rtpi/publication/1" }), "rejected", "closed-schema-union");
	});
});

describe("V04 and S02 idempotence", () => {
	const base = () => accepted(rtpiValidate(event(queueBody(), QUEUE), cap(), q()));

	it("same key and same canonical body -> one receipt (duplicate of the first)", () => {
		const a = base();
		const b = base();
		expect(b.dedupKey).toBe(a.dedupKey);
		const prior = { key: a.dedupKey, digest: a.digest, sequence: 7 };
		expect(rtpiDedupDecision(prior, { key: b.dedupKey, digest: b.digest })).toEqual({ decision: "duplicate", prior });
	});

	it("same key, other bytes -> conflict, even with a new event id (no second effect)", () => {
		const a = base();
		const rebuilt = accepted(
			rtpiValidate(
				event(queueBody({ counts: { ...COUNTS, done: 4 } }), QUEUE, { eventId: "event-rebuilt", occurredAt: 1500 }),
				cap(),
				q(),
			),
		);
		expect(rebuilt.dedupKey).toBe(a.dedupKey);
		const prior = { key: a.dedupKey, digest: a.digest, sequence: 7 };
		expect(rtpiDedupDecision(prior, { key: rebuilt.dedupKey, digest: rebuilt.digest })).toEqual({
			decision: "conflict",
			prior,
		});
		// Counterfactual: keying by event id treats the rebuilt record as new and mirrors it twice.
		const byEventId = new Set([String(a.root.eventId)]);
		expect(byEventId.has(String(rebuilt.root.eventId))).toBe(false);
	});

	it("a new home, fork or version (incarnation) cannot borrow an old receipt", () => {
		const a = base();
		const b = accepted(
			rtpiValidate(event(queueBody(), QUEUE, { incarnation: "inc-2" }), cap(), q(1, { incarnation: "inc-2" })),
		);
		expect(b.dedupKey).not.toBe(a.dedupKey);
		expect(
			rtpiDedupDecision({ key: a.dedupKey, digest: a.digest, sequence: 1 }, { key: b.dedupKey, digest: b.digest }),
		).toEqual({ decision: "new" });
	});

	it("binds the exact lineage tuple: stale revision, reused sequence, other incarnation or unknown state", () => {
		refused(rtpiValidate(event(queueBody(), QUEUE), cap(), q(2)), "rejected", "stale-or-nonatomic-revision");
		refused(
			rtpiValidate(event(queueBody(), QUEUE), cap(), q(1, { currentSequence: 1 })),
			"rejected",
			"source-sequence-reused-or-gap",
		);
		refused(
			rtpiValidate(event(queueBody(), QUEUE), cap(), q(1, { incarnation: "inc-0" })),
			"rejected",
			"incarnation-mismatch",
		);
		refused(
			rtpiValidate(event(queueBody(), QUEUE), cap(), q(1, { lineage: ref("lineage", "other") })),
			"rejected",
			"lineage-unqualified",
		);
		refused(
			rtpiValidate(event(queueBody(), QUEUE), cap(), q(1, { lineage: null })),
			"unknown",
			"lineage-state-unknown",
		);
		refused(
			rtpiValidate(event(queueBody(), QUEUE), cap(), q(1, { sourceCommitted: false })),
			"unknown",
			"canonical-source-not-committed",
		);
	});
});

describe("C02 processed: exact inclusion and successful settlement of the same attempt", () => {
	const included = (w = W1) =>
		accepted(
			rtpiValidate(
				event(msg("message-included"), { ...w, recipient: MSG_CTX.recipient }),
				cap(),
				q(1, { includedWitness: w }),
			),
		);
	const settled = (w = W1, success = true) =>
		accepted(
			rtpiValidate(
				event(
					msg("message-settled", { success, errorCode: success ? "none" : "error" }),
					{ ...w, recipient: MSG_CTX.recipient },
					{},
					2,
				),
				cap(),
				q(2, { includedWitness: w, settledWitness: w, settledSuccess: success }),
			),
		);

	it("same witness + success -> processed; same attempt error -> not processed", () => {
		expect(rtpiProcessed(included(), settled(), cap())).toEqual({ state: "processed", reason: "same-attempt-success" });
		expect(rtpiProcessed(included(), settled(W1, false), cap())).toEqual({
			state: "not-processed",
			reason: "same-attempt-error-or-abort",
		});
	});

	it("another attempt, a missing record or an unsupported input hook stays unknown", () => {
		expect(rtpiProcessed(included(), settled(witness("a2")), cap()).state).toBe("unknown");
		expect(rtpiProcessed(included(), null, cap())).toEqual({ state: "unknown", reason: "settlement-unknown" });
		expect(rtpiProcessed(included(), settled(), cap({ seams: { ...SEAMS, inputHook: false } }))).toEqual({
			state: "unknown",
			reason: "input-hook-unsupported",
		});
		refused(
			rtpiValidate(
				event(msg("message-included"), MSG_CTX),
				cap({ seams: { ...SEAMS, inputHook: false } }),
				q(1, { includedWitness: W1 }),
			),
			"unknown",
			"input-hook-unsupported",
		);
	});

	it("compares witnesses as whole refs: same id, other revision is a mismatch (Architecture condition D)", () => {
		const stale = witness("a1", "2");
		const idOnly = (a: J, b: J) =>
			(["session", "epoch", "turn", "run", "attempt"] as const).every((k) => (a[k] as J).id === (b[k] as J).id);
		expect(idOnly(stale, W1)).toBe(true); // counterfactual: the oracle's id-only witness_of would accept it
		refused(
			rtpiValidate(
				event(msg("message-included"), { ...stale, recipient: MSG_CTX.recipient }),
				cap(),
				q(1, { includedWitness: W1 }),
			),
			"rejected",
			"input-witness-mismatch",
		);
	});

	it("a known inclusion without the run/epoch witness is refused; an error is never success", () => {
		refused(
			rtpiValidate(event(msg("message-included"), { ...MSG_CTX, epoch: null }), cap(), q(1, { includedWitness: W1 })),
			"rejected",
			"fact-context-missing-epoch",
		);
		refused(
			rtpiValidate(event(msg("message-settled", { success: true, errorCode: "error" }), MSG_CTX), cap(), q()),
			"rejected",
			"error-abort-not-success",
		);
	});
});

describe("V13 coverage: never a fabricated zero", () => {
	const snap = (body: J = queueBody()) => accepted(rtpiValidate(event(body, QUEUE), cap(), q()));
	const ok = { receiptExpired: false, socketLost: false, stale: false, capped: false, partialIndex: false };
	const LAST = { ...COUNTS, done: 2 };

	it("complete snapshot + watermarks -> fresh; complete empty -> nothing waiting", () => {
		expect(
			rtpiSnapshotCoverage({ snapshot: snap(), watermarksComplete: true, heartbeat: ok, lastKnown: null }),
		).toMatchObject({ state: "fresh", counts: COUNTS });
		const zero = { ready: 0, working: 0, asking: 0, stuck: 0, waiting: 0, blocked: 0, done: 0 };
		expect(
			rtpiSnapshotCoverage({
				snapshot: snap(queueBody({ occupied: 0, counts: zero })),
				watermarksComplete: true,
				heartbeat: ok,
				lastKnown: null,
			}).state,
		).toBe("nothing-waiting");
	});

	it("no snapshot -> loading or last-known, never zero", () => {
		expect(
			rtpiSnapshotCoverage({ snapshot: null, watermarksComplete: false, heartbeat: null, lastKnown: null }),
		).toEqual({ state: "loading", counts: null, reason: "no-snapshot" });
		expect(
			rtpiSnapshotCoverage({ snapshot: null, watermarksComplete: false, heartbeat: null, lastKnown: LAST }).state,
		).toBe("last-known");
	});

	it("an expired receipt, lost socket, stale, capped or partial index keeps last-known or unknown", () => {
		for (const fault of ["receiptExpired", "socketLost", "stale", "capped", "partialIndex"] as const) {
			const hb = { ...ok, [fault]: true };
			expect(
				rtpiSnapshotCoverage({ snapshot: snap(), watermarksComplete: true, heartbeat: hb, lastKnown: LAST }),
			).toMatchObject({ state: "last-known", counts: LAST });
			const none = rtpiSnapshotCoverage({ snapshot: snap(), watermarksComplete: true, heartbeat: hb, lastKnown: null });
			expect(none).toMatchObject({ state: "unknown", counts: null });
			// Counterfactual: a reader that falls back to zeros would show "nothing waiting".
			const naive = none.counts ?? { ready: 0 };
			expect(naive.ready).toBe(0);
		}
		expect(
			rtpiSnapshotCoverage({ snapshot: snap(), watermarksComplete: false, heartbeat: ok, lastKnown: null }).state,
		).toBe("unknown");
	});

	it("an unknown snapshot carries nulls, never zeros; a fabricated zero is refused", () => {
		const nulls = { ready: null, working: null, asking: null, stuck: null, waiting: null, blocked: null, done: null };
		const unknown = queueBody({ status: "unknown", capacity: null, occupied: null, counts: nulls, fullIndex: false });
		expect(
			rtpiSnapshotCoverage({ snapshot: snap(unknown), watermarksComplete: true, heartbeat: ok, lastKnown: null }),
		).toMatchObject({ state: "unknown", reason: "snapshot-unknown" });
		refused(
			rtpiValidate(event({ ...unknown, counts: { ...nulls, ready: 0 } }, QUEUE), cap(), q()),
			"rejected",
			"unknown-queue-fabricated-zero",
		);
		refused(
			rtpiValidate(event(queueBody({ fullIndex: false }), QUEUE), cap(), q()),
			"rejected",
			"queue-capacity-or-index-incomplete",
		);
	});

	it("one inaccessible domain is unknown while the others stay usable", () => {
		const out = rtpiDomainCoverage({
			ops: { snapshot: snap(), watermarksComplete: true, heartbeat: ok, lastKnown: null },
			data: null,
		});
		expect(out.ops?.state).toBe("fresh");
		expect(out.data).toEqual({ state: "unknown", counts: null, reason: "domain-inaccessible" });
	});
});

describe("V15 and S01 allowlist, capability and actor", () => {
	it("refuses unknown facts, raw prompt fields and authority kinds in evidence refs", () => {
		refused(rtpiValidate(event(msg("message-dispatched"), MSG_CTX), cap(), q()), "rejected", "closed-schema-union");
		refused(
			rtpiValidate(event({ ...msg("message-delivered"), prompt: "raw text" }, MSG_CTX), cap(), q()),
			"rejected",
			"closed-schema-union",
		);
		refused(
			rtpiValidate(event(queueBody({ refs: [ref("owner", "o")] }), QUEUE), cap(), q()),
			"rejected",
			"evidence-reference-kind",
		);
		refused(
			rtpiValidate(event(queueBody(), { queue: ref("role", "queue-ops") }), cap(), q()),
			"rejected",
			"reference-kind-queue",
		);
	});

	it("a producer may only write its own families and stages", () => {
		refused(
			rtpiValidate(event(msg("message-delivered"), MSG_CTX), cap({ facts: ["queue-snapshot"] }), q()),
			"rejected",
			"native-family-scope-mismatch",
		);
		refused(
			rtpiValidate(event(queueBody(), QUEUE), cap({ roots: ["rtpi/checkpoint/1"] }), q()),
			"rejected",
			"capability-root-scope",
		);
		refused(
			rtpiValidate(event(queueBody(), QUEUE), cap({ policyAccepted: false }), q()),
			"unavailable",
			"capture-policy-unaccepted",
		);
	});

	it("an observer cannot mint an owner action; owner facts need the owner principal", () => {
		const ownerCtx = {
			owner: ref("owner", "owner"),
			client: ref("client", "c1"),
			window: ref("window", "w1"),
			session: ref("session", "s1"),
			action: ref("operation", "op1"),
			artifact: ref("artifact", "art1"),
			projection: ref("projection", "p1"),
			coverage: ref("coverage", "cov1"),
			policy: ref("policy", "pol1"),
			challenge: ref("challenge", "ch1"),
		};
		const body = (clientRole: string) => ({
			fact: "owner-acknowledged",
			status: "known",
			receipt: ref("receipt", "rc1"),
			clientRole,
			issuedAt: 1000,
			expiresAt: 61000,
			serverNow: 2000,
			mode: "new",
			refs: [],
		});
		refused(rtpiValidate(event(body("observer"), ownerCtx), cap(), q()), "rejected", "observer-or-stale-client");
		refused(
			rtpiValidate(event(body("owner"), ownerCtx), cap({ seams: { ...SEAMS, ownerPrincipal: false } }), q()),
			"unknown",
			"owner-principal-not-admitted",
		);
		const current = {
			ownerPrincipalAdmitted: true,
			clientCurrent: true,
			currentArtifact: ownerCtx.artifact,
			currentProjection: ownerCtx.projection,
			currentCoverage: ownerCtx.coverage,
			serverNow: 2000,
		};
		accepted(rtpiValidate(event(body("owner"), ownerCtx), cap(), q(1, current)));
		refused(
			rtpiValidate(event(body("owner"), ownerCtx), cap(), q(1, { ...current, serverNow: 61000 })),
			"rejected",
			"supplied-or-backdated-server-clock",
		);
		refused(
			rtpiValidate(
				event(body("owner"), ownerCtx),
				cap(),
				q(1, { ...current, currentArtifact: ref("artifact", "art1", "2") }),
			),
			"rejected",
			"owner-current-subject-mismatch",
		);
	});

	it("an origin needs a qualified issuer; unknown origin cannot carry a fabricated actor", () => {
		const origin = (classification: string, request: unknown, actor: unknown) => ({
			fact: "origin-classified",
			classification,
			request,
			actor,
			forwardChain: [],
			refs: [],
		});
		refused(
			rtpiValidate(event(origin("unknown", null, ref("role", "r"))), cap(), q()),
			"rejected",
			"unknown-origin-fabricated-actor",
		);
		refused(
			rtpiValidate(event(origin("role-requested", ref("request", "rq"), ref("role", "r"))), cap(), q()),
			"unknown",
			"origin-issuer-unqualified",
		);
		accepted(rtpiValidate(event(origin("unknown", null, null)), cap(), q()));
	});
});

describe("S08 required gates", () => {
	const contract = (over: J = {}, qual: RtpiQualification = {}) =>
		rtpiValidate(gateContract(over), cap(), {
			sourceCommitted: true,
			gateContractAccepted: true,
			rolesGateIssuer: GATE_ISSUER,
			...qual,
		});
	const ART = ref("artifact", "artifact-1");
	// Each observation is accepted against the artifact that was current when it was made.
	const observed = (stage: string, result: string, n: number, c: J = {}) =>
		accepted(
			rtpiValidate(
				event(
					{ fact: "gate-observed", stage, result, contract: ref("contract", "gc-1", "1"), refs: [] },
					{ artifact: ART, run: W1.run, attempt: W1.attempt, taskId: 136, planRevision: 1, ...c },
					{},
					n,
				),
				cap(),
				q(n, {
					gateContractAccepted: true,
					currentArtifact: (c.artifact as typeof ART | undefined) ?? ART,
					independentVerifier: true,
				}),
			),
		);
	const join = (a: { id: string }) =>
		a.id === "artifact-1" ? ARTIFACT_KEY : { ...ARTIFACT_KEY, environmentEpoch: "env-0" };

	it("validates the required set as a nonempty DAG with an independent check", () => {
		accepted(contract());
		const req = (r: J[]) => contract({ required: r });
		refused(req([]), "rejected", "closed-schema-union");
		refused(
			req([
				{ stage: "built", applicable: true, independent: false, dependsOn: [] },
				{ stage: "built", applicable: true, independent: false, dependsOn: [] },
			]),
			"rejected",
			"duplicate-or-empty-required-set",
		);
		refused(
			req([
				{ stage: "built", applicable: true, independent: false, dependsOn: ["live"] },
				{ stage: "live", applicable: true, independent: false, dependsOn: ["built"] },
			]),
			"rejected",
			"gate-dependency-cycle",
		);
		refused(
			req([{ stage: "built", applicable: true, independent: false, dependsOn: ["live"] }]),
			"rejected",
			"gate-dependency-missing",
		);
		refused(
			req([{ stage: "checked", applicable: true, independent: false, dependsOn: [] }]),
			"rejected",
			"required-check-independence",
		);
		refused(
			req([{ stage: "built", applicable: false, independent: false, dependsOn: [] }]),
			"rejected",
			"closed-schema-union",
		);
	});

	it("Initiatives contracts need I1's per-kind issuer; Roles never waits for I1", () => {
		refused(contract({ domain: "initiatives" }), "unavailable", "initiatives-per-kind-issuer-unqualified");
		accepted(contract({ domain: "initiatives" }, { initiativesPerKindIssuer: GATE_ISSUER }));
		accepted(contract({}, { initiativesPerKindIssuer: null }));
		refused(contract({}, { gateContractAccepted: false }), "unavailable", "required-contract-unaccepted");
		refused(
			rtpiValidate(gateContract(), cap({ seams: { ...SEAMS, issuerRegistry: false } }), {
				sourceCommitted: true,
				gateContractAccepted: true,
				rolesGateIssuer: GATE_ISSUER,
			}),
			"unavailable",
			"native-issuer-registry-missing",
		);
	});

	it("live only when every required stage passed for the exact artifact key, task and plan", () => {
		const c = accepted(contract());
		const base = {
			contract: c,
			ownerConfirmations: [],
			artifactKeyOf: join,
			task: { taskId: 136, planRevision: 1 },
			indexComplete: true,
		};
		expect(
			rtpiGateCoverage({ ...base, observations: [observed("built", "pass", 1), observed("checked", "pass", 2)] }).state,
		).toBe("complete");
		const na = [observed("built", "pass", 1), observed("checked", "not-applicable", 2)];
		expect(rtpiGateCoverage({ ...base, observations: na }).state).toBe("incomplete");
		// Counterfactual: "no failure observed" calls it live although the check never passed.
		expect(na.every((r) => (r.root.body as J).result !== "fail")).toBe(true);
		expect(
			rtpiGateCoverage({ ...base, observations: [observed("built", "pass", 1), observed("checked", "fail", 2)] }).state,
		).toBe("failed");
		const other = [
			observed("built", "pass", 1),
			observed("checked", "pass", 2, { artifact: ref("artifact", "artifact-0") }),
		];
		expect(rtpiGateCoverage({ ...base, observations: other }).stages.checked).toBe("missing");
		const otherPlan = [observed("built", "pass", 1), observed("checked", "pass", 2, { planRevision: 2 })];
		expect(rtpiGateCoverage({ ...base, observations: otherPlan }).state).toBe("incomplete");
	});

	it("an undefined receipt join, a stale index or a missing contract is unknown, never live", () => {
		const c = accepted(contract());
		const obs = [observed("built", "pass", 1), observed("checked", "pass", 2)];
		const base = { contract: c, observations: obs, ownerConfirmations: [], task: { taskId: 136, planRevision: 1 } };
		expect(rtpiGateCoverage({ ...base, artifactKeyOf: null, indexComplete: true })).toMatchObject({
			state: "unknown",
			reason: "receipt-artifact-join-undefined",
		});
		expect(rtpiGateCoverage({ ...base, artifactKeyOf: join, indexComplete: false }).state).toBe("unknown");
		expect(rtpiGateCoverage({ ...base, contract: null, artifactKeyOf: join, indexComplete: true }).state).toBe(
			"unknown",
		);
	});

	it("a checked pass needs an independent verifier", () => {
		refused(
			rtpiValidate(
				event(
					{ fact: "gate-observed", stage: "checked", result: "pass", contract: ref("contract", "gc-1", "1"), refs: [] },
					{ artifact: ART, run: W1.run, attempt: W1.attempt },
				),
				cap(),
				q(1, { gateContractAccepted: true, currentArtifact: ART }),
			),
			"unknown",
			"gate-independent-verifier-missing",
		);
	});
});

describe("R07 checkpoint integrity and full-string tokens", () => {
	it("verifies the domain-separated digest; replacing the hash or a retained field is refused", () => {
		const c = checkpoint();
		accepted(rtpiStructural(c));
		refused(rtpiStructural({ ...c, hash: "0".repeat(64) }), "rejected", "checkpoint-integrity-mismatch");
		refused(rtpiStructural({ ...c, cutoff: 1001 }), "rejected", "checkpoint-integrity-mismatch");
		const { hash: _omit, ...p } = c;
		const undomained = createHash("sha256").update(rtpiCanonical(p)).digest("hex");
		refused(rtpiStructural({ ...c, hash: undomained }), "rejected", "checkpoint-integrity-mismatch");
	});

	it("refuses a hash or id with a trailing LF that a Python-style $ accepts (all 13 oracle cases: L-S-05 below)", () => {
		const c = checkpoint();
		const pythonStyle = /^[0-9a-f]{64}$/m;
		expect(pythonStyle.test(`${c.hash as string}\n`)).toBe(true); // counterfactual
		refused(rtpiStructural({ ...c, hash: `${c.hash as string}\n` }), "rejected", "closed-schema-union");
		refused(rtpiStructural({ ...c, hash: (c.hash as string).toUpperCase() }), "rejected", "closed-schema-union");
		refused(rtpiStructural(checkpoint({ objectId: "cp-1\n" })), "rejected", "closed-schema-union");
	});

	it("a checkpoint qualifies only reconciled, keeps prior live references and binds checkpoint kinds", () => {
		const held = [ref("operation", "op1")];
		accepted(
			rtpiValidate(checkpoint({ held }), cap(), {
				lineage: LINEAGE,
				sourceCommitted: true,
				checkpointReconciled: true,
			}),
		);
		refused(
			rtpiValidate(checkpoint(), cap(), { lineage: LINEAGE, sourceCommitted: true, checkpointReconciled: false }),
			"unknown",
			"checkpoint-not-reconciled",
		);
		const prev = { dedup: [], accepted: [], held, acknowledged: [], needed: [] };
		refused(
			rtpiValidate(checkpoint(), cap(), {
				lineage: LINEAGE,
				sourceCommitted: true,
				checkpointReconciled: true,
				previousLive: prev,
			}),
			"rejected",
			"checkpoint-live-reference-lost-held",
		);
		refused(rtpiStructural(checkpoint({ accepted: [ref("owner", "o")] })), "rejected", "reference-kind-accepted");
	});
});

describe("S05 recovery: quarantine, never repair", () => {
	const recs = [1, 2, 3].map((n) =>
		accepted(rtpiStructural(event(queueBody({ counts: { ...COUNTS, done: n } }), QUEUE, {}, n))),
	);
	const lines = recs.map((r, i) => rtpiEncodeFrame(i + 1, r));

	it("recovers clean frames in order", () => {
		const r = rtpiRecoverSegment(lines.join(""), 0);
		expect(r.state).toBe("clean");
		expect(r.frames.map((f) => f.sequence)).toEqual([1, 2, 3]);
		expect(r.lastSequence).toBe(3);
	});

	it("a torn tail, a duplicate or skipped sequence, a corrupt frame or a bad digest is quarantined", () => {
		const torn = lines.join("") + lines[0]?.slice(0, 40);
		expect(rtpiRecoverSegment(torn, 0)).toMatchObject({ state: "quarantine", reason: "torn-tail", lastSequence: 3 });
		// Counterfactual: a reader that skips unparsable lines reports 3 clean records and loses the evidence.
		const naive = torn.split("\n").flatMap((l) => {
			try {
				return [JSON.parse(l) as unknown];
			} catch {
				return [];
			}
		});
		expect(naive).toHaveLength(3);
		expect(rtpiRecoverSegment(lines[0]! + lines[0]!, 0)).toMatchObject({
			state: "quarantine",
			reason: "frame-sequence-duplicate",
		});
		expect(rtpiRecoverSegment(lines[0]! + lines[2]!, 0)).toMatchObject({
			state: "quarantine",
			reason: "frame-sequence-gap",
		});
		expect(rtpiRecoverSegment(lines[0]!.replace('"frame"', ' "frame"'), 0)).toMatchObject({
			state: "quarantine",
			reason: "frame-not-canonical-bytes",
		});
		const badDigest = lines[0]!.replace(recs[0]!.digest, "0".repeat(64));
		expect(rtpiRecoverSegment(badDigest, 0)).toMatchObject({ state: "quarantine", reason: "frame-digest-mismatch" });
		const tampered = lines[0]!.replace('"done":1', '"done":9');
		expect(rtpiRecoverSegment(tampered, 0)).toMatchObject({ state: "quarantine", reason: "frame-digest-mismatch" });
		const badRecord = lines[0]!.replace('"fullIndex":true', '"fullIndex":false');
		expect(rtpiRecoverSegment(badRecord, 0)).toMatchObject({
			state: "quarantine",
			reason: "frame-record-queue-capacity-or-index-incomplete",
		});
	});

	it("prunes nothing without a verified, durable, reconciled, gap-free checkpoint over a clean journal", () => {
		const cp = accepted(rtpiStructural(checkpoint()));
		expect(rtpiPrunable({ checkpoint: cp, reconciled: true, journal: "clean" })).toEqual({
			prunable: true,
			reason: "reconciled-gap-free-checkpoint",
		});
		expect(rtpiPrunable({ checkpoint: cp, reconciled: false, journal: "clean" }).prunable).toBe(false);
		expect(rtpiPrunable({ checkpoint: cp, reconciled: true, journal: "quarantine" }).prunable).toBe(false);
		const gap = accepted(rtpiStructural(checkpoint({ gapFree: false })));
		expect(rtpiPrunable({ checkpoint: gap, reconciled: true, journal: "clean" }).prunable).toBe(false);
		// Counterfactual: "the hash verifies, so prune" would prune the gap checkpoint.
		expect(gap.root.hash).toBe(rtpiCheckpointDigest(gap.root));
		expect(rtpiPrunable({ checkpoint: null, reconciled: true, journal: "clean" }).prunable).toBe(false);
	});
});

describe("S07 windows and retention", () => {
	it("shows at most 200 pending with the full total, and 20 activities per scope", () => {
		const entries = Array.from({ length: 250 }, (_, i) => i);
		const w = rtpiPendingWindow(entries, 250);
		expect(w.shown).toHaveLength(RTPI_LIMITS.pendingShown);
		expect(w).toMatchObject({ total: 250, complete: true });
		expect(rtpiPendingWindow(entries, null)).toMatchObject({ total: null, complete: false });
		expect(rtpiActivityWindow(entries)).toHaveLength(20);
	});

	it("30-day terminal metadata expires (not completed); unknown time stays unknown", () => {
		const day = 86400000;
		expect(rtpiRetention(0, 30 * day)).toBe("expired");
		expect(rtpiRetention(0, 30 * day - 1)).toBe("retained");
		expect(rtpiRetention(null, 0)).toBe("unknown");
	});
});

// Security rm-b79f71e9 note 1: C0 carries the sealed oracle's own L-S-05 cases, on the oracle's own documents
// (tests/fixtures/rtpi-oracle-ls05.json, produced by check.py d3553f1e). Old-code counterfactuals: Python's re.search
// reads a final "$" as "end, or just before a final LF", and a trim-then-match check drops trailing white space.
interface Ls05Edit {
	path: string;
	suffix?: string;
	truncate?: number;
	upper?: boolean;
}
interface Ls05Case {
	id: string;
	base: string;
	tokenEdit: Ls05Edit;
	expect: string;
	reason: string;
	oracle: { verdict: string; reason: string };
}
const LS05 = JSON.parse(readFileSync(new URL("../fixtures/rtpi-oracle-ls05.json", import.meta.url), "utf8")) as {
	bases: Record<string, { canonicalSha256: string; doc: J }>;
	cases: Ls05Case[];
};
const LS05_PATTERN: Record<string, string | undefined> = {
	hash: RTPI_SCHEMA.$defs.hash?.pattern,
	objectId: RTPI_SCHEMA.$defs.id?.pattern,
	eventId: RTPI_SCHEMA.$defs.id?.pattern,
	"source.id": RTPI_SCHEMA.$defs.id?.pattern,
	"artifact.assetsSha256": RTPI_SCHEMA.$defs.hash?.pattern,
	"components.0.amount.n": RTPI_SCHEMA.$defs.rational?.properties?.n?.pattern,
};
/** check.py's tokenEdit on a copy: upper, then truncate, then suffix, at a dotted path (array steps by index). */
function ls05Edit(doc: J, e: Ls05Edit): { doc: J; token: string } {
	const copy = structuredClone(doc);
	const parts = e.path.split(".");
	let holder = copy as Record<string, unknown>;
	for (const p of parts.slice(0, -1)) holder = holder[p] as Record<string, unknown>;
	const key = parts[parts.length - 1];
	let token = holder[key] as string;
	if (e.upper) token = token.toUpperCase();
	if (e.truncate !== undefined) token = token.slice(0, e.truncate);
	token += e.suffix ?? "";
	holder[key] = token;
	return { doc: copy, token };
}
const pythonSearch = (pattern: string, s: string): boolean =>
	new RegExp(pattern).test(s) || (s.endsWith("\n") && new RegExp(pattern).test(s.slice(0, -1)));
const trimThenMatch = (pattern: string, s: string): boolean => new RegExp(pattern).test(s.trim());

describe("L-S-05 full-string tokens on the oracle's own documents (Security rm-b79f71e9)", () => {
	it("the oracle's clean bases have the same canonical bytes here and get the C0 verdicts", () => {
		expect(Object.keys(LS05.bases).sort()).toEqual(["checkpoint", "gate-contract", "publication", "queue"]);
		for (const [name, b] of Object.entries(LS05.bases)) {
			expect(rtpiSha256(rtpiCanonical(b.doc)), name).toBe(b.canonicalSha256);
			if (name === "publication") refused(rtpiStructural(b.doc), "unavailable", "publication-stage-not-in-c0");
			else accepted(rtpiStructural(b.doc));
		}
	});

	it.each(LS05.cases)("$id is refused, as the oracle refused it", (c) => {
		expect(c).toMatchObject({ expect: "reject", oracle: { verdict: "reject", reason: c.reason } });
		refused(rtpiStructural(ls05Edit(LS05.bases[c.base].doc, c.tokenEdit).doc), "rejected", c.reason);
	});

	it("carries all 13 cases; the naive checks would let the trailing LF, CR and space through", () => {
		expect(LS05.cases).toHaveLength(13);
		const naive: string[] = [];
		for (const c of LS05.cases) {
			const pattern = LS05_PATTERN[c.tokenEdit.path];
			expect(pattern, c.id).toBeDefined();
			const { token } = ls05Edit(LS05.bases[c.base].doc, c.tokenEdit);
			if (pythonSearch(pattern as string, token) || trimThenMatch(pattern as string, token)) naive.push(c.id);
		}
		expect(naive).toEqual([
			"L-S-05-hash-trailing-lf",
			"L-S-05-hash-trailing-cr",
			"L-S-05-hash-trailing-space",
			"L-S-05-id-trailing-lf",
			"L-S-05-id-trailing-space",
			"L-S-05-rational-trailing-lf",
		]);
	});
});
