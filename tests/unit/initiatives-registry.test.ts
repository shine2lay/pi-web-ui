// IB1 deterministic stages. Synthetic fixtures and private temp journals only, no live stores/model calls.
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { transform } from "esbuild";
import { describe, it, expect } from "vitest";
import { HANG_GUARD_MS } from "./load-independent.js";
import {
	RTPI_NATIVE_SEAMS_C0,
	createRtpiFixtureCapability,
	rtpiCanonical,
	rtpiSha256,
	rtpiStructural,
	rtpiValidate,
	rtpiEncodeFrame,
	rtpiCheckpointDigest,
	rtpiAuditSchema,
	type RtpiRef,
	type RtpiAccepted,
	type RtpiVerdict,
	type RtpiArtifactKey,
} from "../../server/rtpi-core.js";
import { RtpiJournal, rtpiJournalGrant, rtpiRecoverJournal } from "../../server/rtpi-journal.js";
import {
	INITIATIVES_ENABLED,
	INITIATIVES_NATIVE_SEAMS,
	createInitiativesFixtureIssuer,
	initiativesExecution,
	initiativesOutcomeContract,
	initiativesRequiredGates,
	initiativesContractRef,
	createInitiativesFixtureAcceptance,
	initiativesOutcomeCompletion,
	initiativesReferenceRetention,
	initiativesPrunable,
	type InitiativeExecutionDraft,
	type OutcomeContractDraft,
	type OutcomeContractV1,
	type InitiativesFixtureNamedFact,
	type InitiativesFixtureFacts,
	type InitiativesFixtureAcceptance,
	type InitiativeCause,
	type InitiativesPublicationCursor,
} from "../../server/initiatives-registry.js";
import {
	INITIATIVES_SCHEMA,
	INITIATIVES_ROOTS,
	INITIATIVES_P03_CAUSE_KINDS,
	INITIATIVES_ISSUER_ID,
	INITIATIVES_ISSUER_REVISION,
	INITIATIVES_SOURCE_ID,
	RTPI_SCHEMA,
	RTPI_SCHEMA_CANONICAL_SHA256,
	type InitiativesStage,
	type InitiativesOutcomeKind,
} from "../../server/rtpi-schema.js";

const cases = JSON.parse(
	readFileSync(new URL("../fixtures/initiatives-registry-cases.json", import.meta.url), "utf8"),
) as {
	revisionReject: unknown[];
	schemaReject: { id: string; path: string; value: unknown }[];
	causeKinds: string[];
	boundaries: { bytesAccept: number; bytesReject: number; refsAccept: number; refsReject: number };
};
const ref = (kind: string, id = "x", revision = "1"): RtpiRef => ({ namespace: "rtpi-fixture", kind, id, revision });
const I = ref("initiative", "team-in-temper");
const REG = ref("operation", "add-initiative-1");
const ISSUER = ref("issuer", INITIATIVES_ISSUER_ID, INITIATIVES_ISSUER_REVISION);
const SOURCE = ref("source", INITIATIVES_SOURCE_ID, INITIATIVES_ISSUER_REVISION);
const SUBJECT = ref("subject", "team-in-temper");
const RESPONSIBLE = ref("role", "ops");
const RECIPIENT = ref("role", "temper");
const OWNER = ref("owner", "owner-1");
const ARTIFACT: RtpiArtifactKey = {
	gitHead: "a".repeat(40),
	assetsSha256: "b".repeat(64),
	version: "1.0.0",
	manifestRevision: 1,
	targetEnvironment: "fixture-environment",
	environmentEpoch: "e1",
};
const artifactRef = (a: RtpiArtifactKey) => ref("artifact", rtpiSha256(rtpiCanonical(a)));
const cursor = (n = 1, over: Partial<InitiativesPublicationCursor> = {}): InitiativesPublicationCursor => ({
	lineage: ref("lineage", "l"),
	incarnation: "i",
	expectedRevision: n - 1,
	publicationRevision: n,
	publishedAt: 1000,
	...over,
});
function execution(over: Partial<InitiativeExecutionDraft> = {}): InitiativeExecutionDraft {
	return {
		initiative: I,
		registryRecord: REG,
		name: "Team in Temper",
		markers: [],
		goal: { text: null, authority: null },
		lead: null,
		members: [],
		contributions: [],
		started: null,
		finishTarget: null,
		outcomes: [],
		causes: [],
		refs: [],
		completeness: { membership: "unknown", contributions: "unknown", outcomes: "unknown" },
		...over,
	};
}
function outcome(
	kind: InitiativesOutcomeKind = "software-delivery",
	over: Partial<OutcomeContractDraft> = {},
): OutcomeContractDraft {
	const designations = Object.fromEntries(
		["built", "checked", "installed", "live", "owner-confirmed"].map((stage) => [
			stage,
			{
				rule: ref("contract", `acceptance-rule-${stage}`),
				verifier: ref("issuer", `verifier-${stage}`),
				verifierActor: stage === "owner-confirmed" ? OWNER : ref("role", stage === "checked" ? "qa" : "ops"),
				independentOf: stage === "checked" ? RESPONSIBLE : null,
			},
		]),
	);
	return {
		objectId: "outcome-1",
		initiative: I,
		title: "Exact scoped outcome",
		order: 1,
		responsibleActor: RESPONSIBLE,
		recipient: RECIPIENT,
		authority: ref("operation", "outcome-authority"),
		kind,
		acceptedBy: ISSUER,
		artifactRef: artifactRef(ARTIFACT),
		artifact: ARTIFACT,
		contributions: [],
		handoffs: [],
		refs: [],
		required: initiativesRequiredGates(kind, designations),
		...over,
	};
}
function named(
	kind: InitiativesFixtureNamedFact["kind"],
	authority: RtpiRef,
	value: unknown,
): InitiativesFixtureNamedFact {
	return { kind, authority, publisher: ISSUER, initiative: I, valueSha256: rtpiSha256(rtpiCanonical(value)) };
}
function facts(
	d = execution(),
	o: OutcomeContractDraft[] = [],
	extra: Partial<InitiativesFixtureFacts> = {},
): InitiativesFixtureFacts {
	const publications: InitiativesFixtureNamedFact[] = [];
	if (d.goal.authority) publications.push(named("goal", d.goal.authority, d.goal));
	for (const m of d.members) publications.push(named("member", m.association, m));
	for (const c of d.contributions) publications.push(named("contribution", c.assignment, c));
	if (d.started) publications.push(named("start", d.started.receipt, d.started));
	if (d.finishTarget) publications.push(named("finish", d.finishTarget.commit, d.finishTarget));
	for (const c of d.causes) publications.push(named("cause", c.evidence, c));
	for (const c of o) publications.push(named("outcome", c.authority, c));
	return {
		registry: {
			fact: "add_initiative",
			registryRecord: d.registryRecord,
			initiative: d.initiative,
			name: d.name,
			markers: d.markers,
		},
		lead: d.lead === null ? null : { fact: "initiative_lead", value: d.lead },
		publications,
		outcomes: d.outcomes,
		completeness: d.completeness,
		atomicSourceOutbox: true,
		...extra,
	};
}
function accepted(v: RtpiVerdict): RtpiAccepted {
	expect(v.status, v.status === "accepted" ? "" : v.reason).toBe("accepted");
	if (v.status !== "accepted") throw new Error("not accepted");
	return v;
}
const publishExecution = (d = execution(), n = 1, over: Partial<InitiativesPublicationCursor> = {}) =>
	accepted(initiativesExecution(createInitiativesFixtureIssuer(facts(d)), d, cursor(n, over)));
const publishOutcome = (d = outcome(), n = 1) =>
	accepted(initiativesOutcomeContract(createInitiativesFixtureIssuer(facts(execution(), [d])), d, cursor(n)));
function change(value: unknown, path: string, replacement: unknown): unknown {
	const copy = JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
	const bits = path.split(".");
	let p = copy;
	for (const key of bits.slice(0, -1)) p = p[key] as Record<string, unknown>;
	p[bits[bits.length - 1]] = replacement;
	return copy;
}
const CTX = {
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
};
function receipt(c: RtpiAccepted, stage: InitiativesStage, over: Record<string, unknown> = {}): RtpiAccepted {
	const contract = c.root as unknown as OutcomeContractV1;
	const gate = contract.required.find((g) => g.stage === stage);
	if (!gate) throw new Error("missing gate");
	const owner = stage === "owner-confirmed";
	const cref = initiativesContractRef(contract);
	const context = {
		...CTX,
		artifact: contract.artifactRef,
		run: ref("run"),
		attempt: ref("attempt"),
		recipient: contract.recipient,
		...(owner
			? {
					owner: OWNER,
					client: ref("client"),
					window: ref("window"),
					session: ref("session"),
					action: ref("operation", cref.id, cref.revision),
					policy: ref("policy", gate.rule.id, gate.rule.revision),
					projection: ref("projection"),
					coverage: ref("coverage"),
					challenge: ref("challenge"),
					channel: "browser",
				}
			: {}),
	};
	const fact = owner ? "artifact-confirmed" : "gate-observed";
	const event = {
		schema: "rtpi/event/1",
		eventId: `acceptance-${stage}`,
		source: ref("source", `native-${stage}`),
		issuer: gate.verifier,
		subject: SUBJECT,
		lineage: ref("lineage", `receipt-${stage}`),
		incarnation: "i",
		sequence: 1,
		revision: 1,
		expectedRevision: 0,
		occurredAt: 2000,
		context,
		body: owner
			? {
					fact,
					status: "known",
					receipt: ref("receipt", "owner-receipt"),
					clientRole: "owner",
					issuedAt: 1000,
					expiresAt: 61000,
					serverNow: 2000,
					mode: "new",
					refs: [],
				}
			: { fact, stage, result: "pass", contract: cref, refs: [] },
		...over,
	};
	const cap = createRtpiFixtureCapability({
		source: event.source,
		issuer: event.issuer,
		subject: SUBJECT,
		roots: ["rtpi/event/1"],
		facts: ["gate-observed", "artifact-confirmed", "message-replied"],
		policyAccepted: true,
		acceptedSidecars: [],
		seams: { inputHook: true, atomicOutbox: true, ownerPrincipal: true, confinedReader: true, issuerRegistry: true },
	});
	return accepted(
		rtpiValidate(event, cap, {
			lineage: event.lineage,
			incarnation: "i",
			currentRevision: 0,
			currentSequence: 0,
			sourceCommitted: true,
			gateContractAccepted: true,
			currentArtifact: contract.artifactRef,
			independentVerifier: true,
			serverNow: 2000,
			ownerPrincipalAdmitted: true,
			clientCurrent: true,
			currentProjection: context.projection,
			currentCoverage: context.coverage,
		}),
	);
}
function evidence(
	c: RtpiAccepted,
	stage: InitiativesStage,
	over: Record<string, unknown> = {},
	expired = false,
): InitiativesFixtureAcceptance {
	return createInitiativesFixtureAcceptance({ contract: c, receipt: receipt(c, stage, over), stage, expired });
}
function complete(c: RtpiAccepted | null, proofs: readonly InitiativesFixtureAcceptance[]) {
	return initiativesOutcomeCompletion({
		contract: c,
		acceptanceRefs: proofs.map((p) => p.acceptanceRef),
		resolve: (r) => proofs.find((p) => rtpiCanonical(p.acceptanceRef) === rtpiCanonical(r)) ?? null,
	});
}

describe("IB1 schema/authority stage", () => {
	it("is inert, has exactly two compile-time roots and preserves C0's original document hash", () => {
		expect(INITIATIVES_ENABLED).toBe(false);
		expect(INITIATIVES_NATIVE_SEAMS).toEqual(RTPI_NATIVE_SEAMS_C0);
		expect(Object.values(INITIATIVES_NATIVE_SEAMS).every((x) => x === false)).toBe(true);
		expect(Object.keys(INITIATIVES_ROOTS)).toEqual(["rtpi/initiative-execution/1", "rtpi/outcome-contract/1"]);
		expect(rtpiSha256(rtpiCanonical(RTPI_SCHEMA))).toBe(RTPI_SCHEMA_CANONICAL_SHA256);
		expect(rtpiAuditSchema(RTPI_SCHEMA)).toBe(Object.keys(RTPI_SCHEMA.$defs).length);
		expect(Object.isFrozen(INITIATIVES_ROOTS)).toBe(true);
		expect(Object.isFrozen(INITIATIVES_SCHEMA)).toBe(true);
	});
	it("every extension schema reference is local and resolvable, including acceptedBy", () => {
		const missingRefs = (document: typeof INITIATIVES_SCHEMA): string[] => {
			const missing = new Set<string>();
			const walk = (value: unknown): void => {
				if (value === null || typeof value !== "object") return;
				const target = (value as { readonly $ref?: unknown }).$ref;
				if (
					typeof target === "string" &&
					(!target.startsWith("#/$defs/") || !Object.hasOwn(document.$defs, target.slice("#/$defs/".length)))
				)
					missing.add(target);
				for (const child of Object.values(value)) walk(child);
			};
			walk(document);
			return [...missing];
		};
		expect(missingRefs(INITIATIVES_SCHEMA)).toEqual([]);
		// Fixed negative control reproduces the preserved formatted candidate's dangling reference.
		const broken = {
			...INITIATIVES_SCHEMA,
			$defs: {
				...INITIATIVES_SCHEMA.$defs,
				outcomeContract: {
					...INITIATIVES_SCHEMA.$defs.outcomeContract,
					properties: {
						...INITIATIVES_SCHEMA.$defs.outcomeContract.properties,
						acceptedBy: { $ref: "#/$defs/issuer" },
					},
				},
			},
		};
		expect(missingRefs(broken)).toEqual(["#/$defs/issuer"]);
	});
	it("accepts only the existing registry seed, preserves null unknowns and never converts creation into start", () => {
		const v = publishExecution();
		expect(v.root.started).toBeNull();
		expect(v.root.goal).toEqual({ text: null, authority: null });
		expect(v.root.lead).toBeNull();
		expect(v.root.completeness).toEqual(execution().completeness);
	});
	it.each(
		Object.keys({
			"software-delivery": 1,
			"artifact-acceptance": 1,
			"owner-confirmation": 1,
		}) as InitiativesOutcomeKind[],
	)("issues the immutable required contract for %s", (kind) => {
		expect(publishOutcome(outcome(kind)).qualified).toBe(true);
	});
	for (const root of ["execution", "outcome"] as const) {
		it.each(cases.schemaReject)(`${root}: rejects $id`, (c) => {
			const base = root === "execution" ? publishExecution().root : publishOutcome().root;
			expect(rtpiStructural(change(base, c.path, c.value)).status).not.toBe("accepted");
		});
		it.each(cases.revisionReject)(`${root}: rejects publicationRevision %s`, (r) => {
			const base = root === "execution" ? publishExecution().root : publishOutcome().root;
			for (const key of ["publicationRevision", "revision"])
				expect(rtpiStructural(change(base, key, r)).status).not.toBe("accepted");
		});
	}
	it.each(["rtpi/initiative-execution/2", "rtpi/outcome-contract/2", "rtpi/arbitrary/1"])(
		"fails closed on unknown root %s",
		(schema) => {
			expect(rtpiStructural({ ...publishExecution().root, schema }).status).not.toBe("accepted");
		},
	);
	it("rejects unknown outcome kinds and malformed roots", () => {
		expect(rtpiStructural({ schema: "rtpi/outcome-contract/1" }).status).toBe("rejected");
		expect(rtpiStructural(change(publishOutcome().root, "kind", "made-up")).status).toBe("rejected");
	});
	it("observer/model/client flags and copied fixture tokens cannot issue native authority", () => {
		const token = createInitiativesFixtureIssuer(facts());
		expect(initiativesExecution({ ...token }, execution(), cursor())).toEqual({
			status: "unavailable",
			reason: "initiatives-issuer-missing",
		});
		const native = rtpiCanonical(publishExecution().root).replaceAll("rtpi-fixture", "rtpi-native");
		expect(rtpiValidate(JSON.parse(native), null)).toEqual({
			status: "unavailable",
			reason: "native-issuer-registry-missing",
		});
		expect(() =>
			createInitiativesFixtureIssuer({
				...facts(),
				registry: { ...facts().registry, initiative: { ...I, namespace: "rtpi-native" } },
			}),
		).toThrow("initiatives-fixture-source");
		expect(() => JSON.stringify(token)).toThrow("initiatives-issuer-not-serializable");
	});
	it("rejects an unassigned goal, member, contribution, start, finish, cause or outcome publisher", () => {
		const d = execution({
			goal: { text: "Approved goal", authority: ref("operation", "goal") },
			members: [
				{
					role: RESPONSIBLE,
					part: "tools",
					association: ref("operation", "member"),
					origin: ref("origin"),
					activeFrom: null,
					endedAt: null,
				},
			],
			contributions: [
				{
					id: "c",
					role: RESPONSIBLE,
					work: ref("operation"),
					assignment: ref("operation", "assign"),
					origin: ref("origin"),
					outcomes: [],
					coverage: "unknown",
				},
			],
			started: { receipt: ref("receipt", "start"), at: 500 },
			finishTarget: { at: 5000, timezone: "America/Los_Angeles", issuer: ISSUER, commit: ref("operation", "finish") },
			causes: [
				{
					kind: "only-owner-can-unblock",
					subject: ref("operation"),
					evidence: ref("receipt"),
					relatedRefs: [],
					since: null,
					thresholdHours: null,
				},
			],
		});
		const f = facts(d);
		expect(initiativesExecution(createInitiativesFixtureIssuer(f), d, cursor()).status).toBe("accepted");
		for (const p of f.publications) {
			const token = createInitiativesFixtureIssuer({ ...f, publications: f.publications.filter((x) => x !== p) });
			expect(initiativesExecution(token, d, cursor())).toEqual({
				status: "rejected",
				reason: "initiatives-publication-not-named",
			});
		}
		expect(initiativesOutcomeContract(createInitiativesFixtureIssuer(facts()), outcome(), cursor()).status).toBe(
			"rejected",
		);
		expect(() =>
			createInitiativesFixtureIssuer(
				facts(d, [], { publications: [{ ...f.publications[0], publisher: ref("issuer", "design") }] }),
			),
		).toThrow();
	});
	it("lead changes are only the #85 owner action; fabricated outcome/completeness membership is refused", () => {
		const lead = {
			role: RESPONSIBLE,
			assignment: ref("operation", "lead"),
			ownerReceipt: ref("receipt", "owner-action"),
			assignedAt: 800,
		};
		const d = execution({ lead });
		expect(publishExecution(d).root.lead).toEqual(lead);
		expect(initiativesExecution(createInitiativesFixtureIssuer(facts()), d, cursor()).status).toBe("rejected");
		const token = createInitiativesFixtureIssuer(facts());
		expect(initiativesExecution(token, execution({ outcomes: [ref("contract", "fake")] }), cursor()).status).toBe(
			"rejected",
		);
		expect(
			initiativesExecution(
				token,
				execution({ completeness: { membership: "complete", contributions: "complete", outcomes: "complete" } }),
				cursor(),
			).status,
		).toBe("rejected");
	});
	it("missing atomic source/outbox evidence stays unknown and changes no controller", () => {
		const f = facts(execution(), [], { atomicSourceOutbox: false });
		expect(initiativesExecution(createInitiativesFixtureIssuer(f), execution(), cursor())).toEqual({
			status: "unknown",
			reason: "canonical-source-not-committed",
		});
	});
	it("holds the exact closed P03 table with typed source claims; unknown kinds/thresholds fail", () => {
		expect(INITIATIVES_P03_CAUSE_KINDS).toEqual(cases.causeKinds);
		for (const kind of INITIATIVES_P03_CAUSE_KINDS) {
			const timed = kind === "no-activity-for-n-hours" || kind === "stall-check-silent";
			const cause: InitiativeCause = {
				kind,
				subject: timed
					? I
					: ref(
							kind === "request-unanswered"
								? "request"
								: kind === "chat-stopped-by-account-fault"
									? "session"
									: "operation",
						),
				evidence: ref("receipt"),
				relatedRefs: kind === "blocked-only-on-done-tasks" ? [ref("operation")] : [],
				since: timed ? 100 : null,
				thresholdHours: timed ? 2 : null,
			};
			const v = publishExecution(execution({ causes: [cause] }));
			expect(rtpiStructural(change(v.root, "causes.0.kind", "new-stall-kind")).status).toBe("rejected");
			expect(rtpiStructural(change(v.root, "causes.0.subject.kind", "owner")).status).toBe("rejected");
			if (timed) expect(rtpiStructural(change(v.root, "causes.0.thresholdHours", null)).status).toBe("rejected");
		}
	});
});

describe("IB1 gate reducer stage", () => {
	it("empty, optional-only, all-NA and forged required sets cannot be Done", () => {
		const c = publishOutcome();
		for (const required of [
			[],
			(c.root.required as unknown[]).map((g) => ({ ...(g as object), required: false })),
			(c.root.required as unknown[]).map((g) => ({ ...(g as object), applicable: false })),
		]) {
			expect(rtpiStructural({ ...c.root, required }).status).toBe("rejected");
			expect(complete({ ...c, root: { ...c.root, required } } as RtpiAccepted, []).state).not.toBe("done");
		}
	});
	it.each(["software-delivery", "artifact-acceptance", "owner-confirmation"] as InitiativesOutcomeKind[])(
		"all current required %s gates pass",
		(kind) => {
			const c = publishOutcome(outcome(kind));
			const proofs = (c.root as unknown as OutcomeContractV1).required.map((g) => evidence(c, g.stage));
			expect(complete(c, proofs)).toMatchObject({ state: "done", completedAt: 2000 });
			expect(complete(c, [])).toMatchObject({ state: "unknown", completedAt: null });
		},
	);
	it("contract/recipient/rule/artifact changes invalidate old acceptance, independent of lead/member metadata", () => {
		const draft = outcome();
		const c = publishOutcome(draft);
		const proofs = draft.required.map((g) => evidence(c, g.stage));
		for (const changed of [
			draft,
			{ ...draft, recipient: RESPONSIBLE },
			{ ...draft, required: draft.required.map((g) => ({ ...g, rule: { ...g.rule, revision: "2" } })) },
			{
				...draft,
				artifact: { ...ARTIFACT, manifestRevision: 2 },
				artifactRef: artifactRef({ ...ARTIFACT, manifestRevision: 2 }),
			},
		]) {
			const c2 = publishOutcome(changed, 2);
			expect(complete(c2, proofs).state).toBe("unknown");
			expect(() =>
				createInitiativesFixtureAcceptance({ contract: c2, receipt: receipt(c, "built"), stage: "built" }),
			).toThrow("initiatives-acceptance-binding");
		}
		publishExecution(
			execution({
				lead: { role: RECIPIENT, assignment: ref("operation", "lead2"), ownerReceipt: ref("receipt"), assignedAt: 900 },
				members: [
					{
						role: RECIPIENT,
						part: "engine",
						association: ref("operation", "m2"),
						origin: ref("origin"),
						activeFrom: 900,
						endedAt: null,
					},
				],
			}),
		);
		expect(complete(c, proofs).state).toBe("done");
	});
	it("wrong verifier, copied proof, wrong resolver reference and transport reply cannot satisfy a business gate", () => {
		const c = publishOutcome();
		const proof = evidence(c, "built");
		expect(complete(c, [{ ...proof }]).state).not.toBe("done");
		expect(() => evidence(c, "built", { issuer: ref("issuer", "another") })).toThrow("initiatives-acceptance-binding");
		expect(() =>
			evidence(c, "built", {
				body: { fact: "message-replied", status: "known", success: true, errorCode: "none", refs: [] },
				context: { ...CTX, recipient: RECIPIENT, session: ref("session"), artifact: artifactRef(ARTIFACT) },
			}),
		).toThrow("initiatives-acceptance-binding");
		expect(
			initiativesOutcomeCompletion({ contract: c, acceptanceRefs: [ref("receipt", "wrong")], resolve: () => proof })
				.state,
		).not.toBe("done");
	});
	it("expired or conflicting immutable receipts stay unknown; a failed required gate stays incomplete", () => {
		const c = publishOutcome(outcome("artifact-acceptance"));
		const pass = evidence(c, "checked");
		expect(complete(c, [evidence(c, "checked", {}, true)]).state).toBe("unknown");
		const fail = evidence(c, "checked", {
			eventId: "failure",
			body: {
				fact: "gate-observed",
				stage: "checked",
				result: "fail",
				contract: initiativesContractRef(c.root as unknown as OutcomeContractV1),
				refs: [],
			},
		});
		expect(complete(c, [fail]).state).toBe("incomplete");
		expect(complete(c, [pass, fail]).state).toBe("unknown");
	});
	it("mutable latest, duplicate stages, dependency cycles and nonindependent checks are refused", () => {
		const c = publishOutcome();
		for (const [path, value] of [
			["required.0.rule.revision", "latest"],
			["required.1.verifierActor", RESPONSIBLE],
			["required.1.dependsOn", ["checked"]],
			["required.1.stage", "built"],
			["acceptedBy", ref("issuer", "other")],
			["artifactRef.id", "mutable-artifact"],
		] as [string, unknown][])
			expect(rtpiStructural(change(c.root, path, value)).status).toBe("rejected");
	});
});

describe("IB1 ceilings, CAS and recovery stage", () => {
	it("whole canonical envelope 8192 accepts, 8193 rejects; no truncation", () => {
		const d = execution({
			markers: Array(8).fill("m".repeat(128)),
			goal: { text: "x", authority: ref("operation", "goal") },
		});
		const base = publishExecution(d).root;
		const n = cases.boundaries.bytesAccept - Buffer.byteLength(rtpiCanonical(base)) + 1;
		expect(n).toBeLessThanOrEqual(6144);
		expect(n).toBeGreaterThan(0);
		const exactly = change(base, "goal.text", "x".repeat(n));
		expect(Buffer.byteLength(rtpiCanonical(exactly))).toBe(8192);
		expect(rtpiStructural(exactly).status).toBe("accepted");
		const over = change(exactly, "goal.text", "x".repeat(n + 1));
		expect(Buffer.byteLength(rtpiCanonical(over))).toBe(8193);
		expect(rtpiStructural(over)).toEqual({ status: "rejected", reason: "canonical-root-byte-bound" });
	});
	it("64 nested refs accepts, 65 rejects, long refs overflow bytes rather than truncate", () => {
		const base = publishExecution();
		const n = 64 - base.refs;
		const boundary = { ...base.root, refs: Array.from({ length: n }, () => ref("receipt")) };
		expect(accepted(rtpiStructural(boundary)).refs).toBe(64);
		expect(rtpiStructural({ ...boundary, refs: [...boundary.refs, ref("receipt")] })).toEqual({
			status: "rejected",
			reason: "total-nested-reference-bound",
		});
		expect(
			rtpiStructural({ ...boundary, refs: boundary.refs.map((r) => ({ ...r, id: "x".repeat(128) })) }).status,
		).toBe("rejected");
	});
	it("publication CAS is atomic, durable, idempotent and not reset by restore/fork/rebind", async () => {
		const dir = await mkdtemp(join(tmpdir(), "initiatives-ib1-"));
		try {
			const grant = rtpiJournalGrant({ enabled: true, directory: dir });
			const journal = await RtpiJournal.open(grant);
			const first = publishExecution();
			const competing = publishExecution(execution({ refs: [ref("receipt")] }), 1, {
				lineage: ref("lineage", "fork"),
				incarnation: "fork",
			});
			const both = await Promise.all([journal.append(first), journal.append(competing)]);
			expect(both[0]).toMatchObject({ status: "appended" });
			expect(both[1]).toEqual({ status: "rejected", reason: "initiatives-publication-cas" });
			expect(await journal.append(first)).toMatchObject({ status: "duplicate", sequence: 1 });
			const changedSameKey = publishExecution(execution({ refs: [ref("receipt")] }));
			expect(await journal.append(changedSameKey)).toMatchObject({ status: "conflict" });
			const reopened = await RtpiJournal.open(grant);
			expect(reopened.state.status).toBe("clean");
			expect(reopened.records()[0].record.digest).toBe(first.digest);
			expect(await reopened.append(competing)).toMatchObject({ status: "rejected" });
			const next = publishExecution(execution(), 2, { lineage: ref("lineage", "rebind"), incarnation: "new" });
			expect(await reopened.append(next)).toMatchObject({ status: "appended", sequence: 2 });
			expect(rtpiRecoverJournal([rtpiEncodeFrame(1, next)], null)).toMatchObject({
				state: "quarantine",
				reason: "initiatives-publication-cas-recovery",
			});
			expect(rtpiStructural(change(next.root, "expectedRevision", 0)).status).toBe("rejected");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
	it("independent retention policies do not force common expiry; expired/unknown refs never complete or zero", () => {
		const policy = { execution: 100, outcome: 200 };
		expect(initiativesReferenceRetention({ domain: "execution", terminalAt: 1000, now: 1150, policy })).toBe("expired");
		expect(initiativesReferenceRetention({ domain: "outcome", terminalAt: 1000, now: 1150, policy })).toBe("retained");
		expect(initiativesReferenceRetention({ domain: "execution", terminalAt: null, now: 1150, policy })).toBe("unknown");
		expect(
			initiativesReferenceRetention({
				domain: "execution",
				terminalAt: 1000,
				now: 1150,
				policy: { execution: null, outcome: 200 },
			}),
		).toBe("retained");
		expect(initiativesPrunable(null)).toBe(false);
	});
});

describe("IB1 old-code controls", () => {
	it("same seven-root inputs have identical canonical bytes, hashes and validation on accepted #136 vs extension", async () => {
		const cwd = fileURLToPath(new URL("../../", import.meta.url));
		const at136 = (path: string) =>
			execFileSync("git", ["show", `370f92e5:${path}`], { cwd, encoding: "utf8", maxBuffer: 1024 * 1024 });
		const uri = (code: string) => `data:text/javascript;base64,${Buffer.from(code).toString("base64")}`;
		const oldSchema = uri((await transform(at136("server/rtpi-schema.ts"), { loader: "ts", format: "esm" })).code);
		const oldCore = uri(
			(await transform(at136("server/rtpi-core.ts"), { loader: "ts", format: "esm" })).code.replace(
				'"./rtpi-schema.js"',
				JSON.stringify(oldSchema),
			),
		);
		const common = {
			objectId: "control",
			source: ref("source"),
			issuer: ref("issuer"),
			subject: ref("subject"),
			lineage: ref("lineage"),
			incarnation: "i",
			revision: 1,
			expectedRevision: 0,
		};
		const cp = {
			schema: "rtpi/checkpoint/1",
			objectId: "cp",
			source: common.source,
			issuer: common.issuer,
			subject: common.subject,
			lineage: common.lineage,
			sequence: 1,
			sourceWatermark: 1,
			captureStart: 0,
			cutoff: 1000,
			gapFree: true,
			durable: true,
			policy: ref("policy"),
			dedup: [],
			accepted: [],
			held: [],
			acknowledged: [],
			needed: [],
		};
		const roots = [
			{
				...common,
				schema: "rtpi/event/1",
				objectId: undefined,
				eventId: "event",
				sequence: 1,
				occurredAt: 1000,
				context: CTX,
				body: { fact: "capture-gap", reason: "outbox-missing", missingCount: null, refs: [] },
			},
			{
				...common,
				schema: "rtpi/design/1",
				classification: "authorized-plain-text",
				grant: ref("policy"),
				parent: null,
				sections: [],
			},
			{ ...common, schema: "rtpi/publication/1", role: RESPONSIBLE },
			{
				schema: "rtpi/lineage/1",
				objectId: "lineage",
				source: common.source,
				issuer: common.issuer,
				subject: common.subject,
				incarnation: "i",
				parent: null,
				recovery: null,
				currentRevision: 0,
				currentSequence: 0,
			},
			{ ...cp, hash: rtpiCheckpointDigest(cp) },
			{
				schema: "rtpi/gate-contract/1",
				objectId: "gate",
				source: common.source,
				issuer: common.issuer,
				subject: common.subject,
				revision: 1,
				domain: "roles",
				acceptedBy: common.issuer,
				required: [{ stage: "checked", applicable: true, independent: true, dependsOn: [] }],
				artifact: ARTIFACT,
			},
			{
				schema: "rtpi/aggregate/1",
				objectId: "aggregate",
				source: common.source,
				issuer: common.issuer,
				subject: common.subject,
			},
		];
		// Vitest's VM has no dynamic-import callback. Node imports the frozen old modules outside that VM;
		// bounded synthetic inputs go over stdin, only comparison values come back. No filesystem writes.
		const inputs = JSON.parse(JSON.stringify(roots)) as Record<string, unknown>[];
		const script = `import { readFileSync } from "node:fs";
			const input = JSON.parse(readFileSync(0, "utf8"));
			const legacy = await import(input.module);
			console.log(JSON.stringify(input.roots.map((v) => ({
				canonical: legacy.rtpiCanonical(v), hash: legacy.rtpiSha256(legacy.rtpiCanonical(v)),
				structural: legacy.rtpiStructural(v), unqualified: legacy.rtpiValidate(v, null),
				extra: legacy.rtpiStructural({ ...v, extra: true })
			}))));`;
		const controls = JSON.parse(
			execFileSync(process.execPath, ["--input-type=module", "-e", script], {
				input: JSON.stringify({ module: oldCore, roots: inputs }),
				encoding: "utf8",
				timeout: HANG_GUARD_MS, // Ops #639: a hang guard, not 15 s of a busy machine
				maxBuffer: 1024 * 1024,
			}),
		) as { canonical: string; hash: string; structural: unknown; unqualified: unknown; extra: unknown }[];
		for (const [i, v] of inputs.entries()) {
			expect(rtpiCanonical(v)).toBe(controls[i].canonical);
			expect(rtpiSha256(rtpiCanonical(v))).toBe(controls[i].hash);
			expect(rtpiStructural(v)).toEqual(controls[i].structural);
			expect(rtpiValidate(v, null)).toEqual(controls[i].unqualified);
			expect(rtpiStructural({ ...v, extra: true })).toEqual(controls[i].extra);
		}
	});
});
