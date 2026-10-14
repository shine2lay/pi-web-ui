/** IB1 / I1: inert Initiatives producer on the existing RTPI/1 journal. No importer, singleton, native issuer,
 * default directory, file read, timer, registration, controller, activation or real-store seeding. No Roles dependency.
 * Fixture constructors are synthetic only. Native source/outbox/issuer seams remain absent; native facts are unavailable.
 * Same-UID residual: these are display-only logical bindings, never approval or control authority.
 */
import {
	RTPI_NATIVE_SEAMS_C0,
	RtpiReject,
	createRtpiFixtureCapability,
	isRtpiAccepted,
	rtpiCanonical,
	rtpiParse,
	rtpiSha256,
	rtpiStructural,
	rtpiValidate,
	rtpiPrunable,
	type RtpiAccepted,
	type RtpiArtifactKey,
	type RtpiRef,
	type RtpiVerdict,
} from "./rtpi-core.js";
import {
	INITIATIVES_ENABLED,
	INITIATIVES_ISSUER_ID,
	INITIATIVES_ISSUER_REVISION,
	INITIATIVES_SOURCE_ID,
	INITIATIVES_REQUIRED_STAGES,
	INITIATIVES_ROOTS,
	type InitiativesOutcomeKind,
	type InitiativesStage,
	type InitiativesCauseKind,
} from "./rtpi-schema.js";

export { INITIATIVES_ENABLED, INITIATIVES_P03_CAUSE_KINDS, INITIATIVES_REF_KINDS } from "./rtpi-schema.js";
export const INITIATIVES_NATIVE_SEAMS = RTPI_NATIVE_SEAMS_C0;
const ref = (kind: string, id: string, revision: string): RtpiRef =>
	Object.freeze({ namespace: "rtpi-fixture", kind, id, revision });
const SOURCE = ref("source", INITIATIVES_SOURCE_ID, INITIATIVES_ISSUER_REVISION);
const ISSUER = ref("issuer", INITIATIVES_ISSUER_ID, INITIATIVES_ISSUER_REVISION);
const SUBJECT = ref("subject", "team-in-temper", "1");
const equal = (a: unknown, b: unknown) => rtpiCanonical(a) === rtpiCanonical(b);
const immutable = <T>(v: T): T => {
	const freeze = (x: unknown): void => {
		if (x !== null && typeof x === "object") {
			for (const y of Object.values(x)) freeze(y);
			Object.freeze(x);
		}
	};
	const copy = rtpiParse(rtpiCanonical(v)) as T;
	freeze(copy);
	return copy;
};

export interface InitiativesPublicationCursor {
	readonly lineage: RtpiRef;
	readonly incarnation: string;
	readonly expectedRevision: number;
	readonly publicationRevision: number;
	readonly publishedAt: number;
}
interface InitiativeEnvelope extends InitiativesPublicationCursor {
	readonly schema: keyof typeof INITIATIVES_ROOTS;
	readonly objectId: string;
	readonly source: RtpiRef;
	readonly issuer: RtpiRef;
	readonly subject: RtpiRef;
	readonly revision: number;
}
export interface InitiativeLead {
	readonly role: RtpiRef;
	readonly assignment: RtpiRef;
	readonly ownerReceipt: RtpiRef;
	readonly assignedAt: number;
}
export interface InitiativeMember {
	readonly role: RtpiRef;
	readonly part: string | null;
	readonly association: RtpiRef;
	readonly origin: RtpiRef;
	readonly activeFrom: number | null;
	readonly endedAt: number | null;
}
export interface InitiativeContribution {
	readonly id: string;
	readonly role: RtpiRef;
	readonly work: RtpiRef;
	readonly assignment: RtpiRef;
	readonly origin: RtpiRef;
	readonly outcomes: readonly RtpiRef[];
	readonly coverage: "complete" | "partial" | "unknown";
}
export interface InitiativeCause {
	readonly kind: InitiativesCauseKind;
	readonly subject: RtpiRef;
	readonly evidence: RtpiRef;
	readonly relatedRefs: readonly RtpiRef[];
	readonly since: number | null;
	readonly thresholdHours: number | null;
}
export interface InitiativeExecutionDraft {
	readonly initiative: RtpiRef;
	readonly registryRecord: RtpiRef;
	readonly name: string;
	readonly markers: readonly string[];
	readonly goal: { readonly text: string | null; readonly authority: RtpiRef | null };
	readonly lead: InitiativeLead | null;
	readonly members: readonly InitiativeMember[];
	readonly contributions: readonly InitiativeContribution[];
	readonly started: { readonly receipt: RtpiRef; readonly at: number } | null;
	readonly finishTarget: {
		readonly at: number;
		readonly timezone: "America/Los_Angeles";
		readonly issuer: RtpiRef;
		readonly commit: RtpiRef;
	} | null;
	readonly outcomes: readonly RtpiRef[];
	readonly causes: readonly InitiativeCause[];
	readonly refs: readonly RtpiRef[];
	readonly completeness: Readonly<
		Record<"membership" | "contributions" | "outcomes", "complete" | "partial" | "unknown">
	>;
}
export interface InitiativeExecutionV1 extends InitiativeEnvelope, InitiativeExecutionDraft {
	readonly schema: "rtpi/initiative-execution/1";
}
export interface InitiativeRequiredGate {
	readonly stage: InitiativesStage;
	readonly required: true;
	readonly applicable: true;
	readonly rule: RtpiRef;
	readonly verifier: RtpiRef;
	readonly verifierActor: RtpiRef;
	readonly independentOf: RtpiRef | null;
	readonly dependsOn: readonly InitiativesStage[];
}
export interface OutcomeContractDraft {
	readonly objectId: string;
	readonly initiative: RtpiRef;
	readonly title: string;
	readonly order: number;
	readonly responsibleActor: RtpiRef | null;
	readonly recipient: RtpiRef;
	readonly authority: RtpiRef;
	readonly kind: InitiativesOutcomeKind;
	readonly acceptedBy: RtpiRef;
	readonly artifactRef: RtpiRef;
	readonly artifact: RtpiArtifactKey;
	readonly contributions: readonly RtpiRef[];
	readonly handoffs: readonly RtpiRef[];
	readonly required: readonly InitiativeRequiredGate[];
	readonly refs: readonly RtpiRef[];
}
export interface OutcomeContractV1 extends InitiativeEnvelope, OutcomeContractDraft {
	readonly schema: "rtpi/outcome-contract/1";
}

type NamedFactKind = "goal" | "member" | "contribution" | "start" | "finish" | "cause" | "outcome";
export interface InitiativesFixtureNamedFact {
	readonly kind: NamedFactKind;
	readonly authority: RtpiRef;
	readonly publisher: RtpiRef;
	readonly initiative: RtpiRef;
	/** Canonical hash of exactly this named publication, not prose, a role name or mutable latest. */
	readonly valueSha256: string;
}
export interface InitiativesFixtureFacts {
	readonly registry: {
		readonly fact: "add_initiative";
		readonly registryRecord: RtpiRef;
		readonly initiative: RtpiRef;
		readonly name: string;
		readonly markers: readonly string[];
	};
	/** Only #85's owner initiative_lead action assigns a lead; missing is null, never inferred. */
	readonly lead: { readonly fact: "initiative_lead"; readonly value: InitiativeLead } | null;
	readonly publications: readonly InitiativesFixtureNamedFact[];
	readonly outcomes: readonly RtpiRef[];
	readonly completeness: InitiativeExecutionDraft["completeness"];
	readonly atomicSourceOutbox: boolean;
}
export interface InitiativesFixtureIssuer {
	readonly namespace: "rtpi-fixture";
	toJSON(): never;
}
const ISSUERS = new WeakMap<object, InitiativesFixtureFacts>();

/** Fixture-only logical issuer. No corresponding native constructor; caller flags cannot create native authority. */
export function createInitiativesFixtureIssuer(input: InitiativesFixtureFacts): InitiativesFixtureIssuer {
	const f = immutable(input);
	if (
		f.registry.fact !== "add_initiative" ||
		f.registry.initiative.namespace !== "rtpi-fixture" ||
		f.registry.initiative.kind !== "initiative" ||
		f.registry.initiative.id !== "team-in-temper" ||
		f.registry.registryRecord.namespace !== "rtpi-fixture" ||
		f.registry.registryRecord.kind !== "operation" ||
		(f.lead !== null && f.lead.fact !== "initiative_lead") ||
		f.publications.some((x) => !equal(x.publisher, ISSUER) || !equal(x.initiative, f.registry.initiative))
	)
		throw new RtpiReject("initiatives-fixture-source");
	const token: InitiativesFixtureIssuer = Object.freeze({
		namespace: "rtpi-fixture",
		toJSON(): never {
			throw new RtpiReject("initiatives-issuer-not-serializable");
		},
	});
	ISSUERS.set(token, f);
	return token;
}

function named(f: InitiativesFixtureFacts, kind: NamedFactKind, authority: RtpiRef, value: unknown): boolean {
	return f.publications.some(
		(x) =>
			x.kind === kind &&
			equal(x.authority, authority) &&
			equal(x.publisher, ISSUER) &&
			x.valueSha256 === rtpiSha256(rtpiCanonical(value)),
	);
}
function publication(
	token: InitiativesFixtureIssuer | null,
	value: InitiativeExecutionV1 | OutcomeContractV1,
	bound: (f: InitiativesFixtureFacts) => boolean,
): RtpiVerdict {
	const structure = rtpiStructural(value);
	if (structure.status !== "accepted") return structure;
	if (token === null || !ISSUERS.has(token)) return { status: "unavailable", reason: "initiatives-issuer-missing" };
	const f = ISSUERS.get(token) as InitiativesFixtureFacts;
	if (!bound(f)) return { status: "rejected", reason: "initiatives-publication-not-named" };
	const cap = createRtpiFixtureCapability({
		source: SOURCE,
		issuer: ISSUER,
		subject: SUBJECT,
		roots: Object.keys(INITIATIVES_ROOTS) as (keyof typeof INITIATIVES_ROOTS)[],
		facts: [],
		policyAccepted: true,
		acceptedSidecars: [],
		seams: { ...INITIATIVES_NATIVE_SEAMS, atomicOutbox: f.atomicSourceOutbox, issuerRegistry: true },
	});
	return rtpiValidate(value, cap, {
		lineage: value.lineage,
		incarnation: value.incarnation,
		currentRevision: value.expectedRevision,
		sourceCommitted: f.atomicSourceOutbox,
		initiativesRegistryQualified: true,
		initiativesBindingDigest: structure.digest,
		initiativesPerKindIssuer: ISSUER,
		gateContractAccepted: true,
	});
}

export function initiativesExecution(
	token: InitiativesFixtureIssuer | null,
	draft: InitiativeExecutionDraft,
	cursor: InitiativesPublicationCursor,
): RtpiVerdict {
	const value: InitiativeExecutionV1 = {
		...draft,
		...cursor,
		schema: "rtpi/initiative-execution/1",
		objectId: draft.initiative.id,
		source: SOURCE,
		issuer: ISSUER,
		subject: SUBJECT,
		revision: cursor.publicationRevision,
	};
	return publication(token, value, (f) => {
		if (
			!equal(draft.registryRecord, f.registry.registryRecord) ||
			!equal(draft.initiative, f.registry.initiative) ||
			draft.name !== f.registry.name ||
			!equal(draft.markers, f.registry.markers) ||
			!equal(draft.lead, f.lead?.value ?? null) ||
			!equal(draft.outcomes, f.outcomes) ||
			!equal(draft.completeness, f.completeness) ||
			draft.contributions.some((x) => x.outcomes.some((r) => !f.outcomes.some((known) => equal(r, known))))
		)
			return false;
		return (
			(draft.goal.authority === null || named(f, "goal", draft.goal.authority, draft.goal)) &&
			draft.members.every((x) => named(f, "member", x.association, x)) &&
			draft.contributions.every((x) => named(f, "contribution", x.assignment, x)) &&
			(draft.started === null || named(f, "start", draft.started.receipt, draft.started)) &&
			(draft.finishTarget === null || named(f, "finish", draft.finishTarget.commit, draft.finishTarget)) &&
			draft.causes.every((x) => named(f, "cause", x.evidence, x))
		);
	});
}

/** Per-kind required contract issuer; no generic verified setter and no design/transport acceptance substitution. */
export function initiativesOutcomeContract(
	token: InitiativesFixtureIssuer | null,
	draft: OutcomeContractDraft,
	cursor: InitiativesPublicationCursor,
): RtpiVerdict {
	const value: OutcomeContractV1 = {
		...draft,
		...cursor,
		schema: "rtpi/outcome-contract/1",
		source: SOURCE,
		issuer: ISSUER,
		subject: SUBJECT,
		revision: cursor.publicationRevision,
	};
	return publication(
		token,
		value,
		(f) => equal(draft.initiative, f.registry.initiative) && named(f, "outcome", draft.authority, draft),
	);
}

/** Data construction only, not authority. Actual issuance still requires the named immutable native publication. */
export function initiativesRequiredGates(
	kind: InitiativesOutcomeKind,
	designations: Readonly<
		Partial<
			Record<InitiativesStage, Pick<InitiativeRequiredGate, "rule" | "verifier" | "verifierActor" | "independentOf">>
		>
	>,
): readonly InitiativeRequiredGate[] {
	const stages = INITIATIVES_REQUIRED_STAGES[kind];
	if (stages === undefined) throw new RtpiReject("initiatives-outcome-kind");
	return immutable(
		stages.map((stage, i) => {
			const d = designations[stage];
			if (d === undefined) throw new RtpiReject("initiatives-gate-designation-missing");
			return {
				...d,
				stage,
				required: true as const,
				applicable: true as const,
				dependsOn: i === 0 ? [] : [stages[i - 1]],
			};
		}),
	);
}

export interface InitiativesFixtureAcceptance {
	readonly acceptanceRef: RtpiRef;
	readonly contractRef: RtpiRef;
	readonly contractSha256: string;
	readonly rule: RtpiRef;
	readonly stage: InitiativesStage;
	readonly verifier: RtpiRef;
	readonly recipient: RtpiRef;
	readonly artifactRef: RtpiRef;
	readonly artifact: RtpiArtifactKey;
	readonly at: number;
	readonly result: "pass" | "fail";
	readonly expired: boolean;
}
const ACCEPTANCES = new WeakSet<object>();
export const initiativesContractRef = (contract: OutcomeContractV1): RtpiRef =>
	Object.freeze({
		namespace: contract.issuer.namespace,
		kind: "contract",
		id: rtpiSha256(rtpiCanonical(contract)),
		revision: String(contract.publicationRevision),
	});

/** Sealed fixture readback over an authentic, qualified C7 receipt. No strings/flags/replies manufacture business proof.
 * Native acceptance and owner confirmation must come from the future C7/client-native adapters, not this constructor. */
export function createInitiativesFixtureAcceptance(input: {
	readonly contract: RtpiAccepted;
	readonly receipt: RtpiAccepted;
	readonly stage: InitiativesStage;
	readonly expired?: boolean;
}): InitiativesFixtureAcceptance {
	const { contract, receipt, stage } = input;
	if (
		!isRtpiAccepted(contract) ||
		!contract.qualified ||
		contract.schema !== "rtpi/outcome-contract/1" ||
		!isRtpiAccepted(receipt) ||
		!receipt.qualified ||
		receipt.schema !== "rtpi/event/1" ||
		contract.namespace !== "rtpi-fixture" ||
		receipt.namespace !== "rtpi-fixture"
	)
		throw new RtpiReject("initiatives-acceptance-unqualified");
	const c = contract.root as unknown as OutcomeContractV1;
	const event = receipt.root;
	const body = event.body as Readonly<Record<string, unknown>>;
	const context = event.context as Readonly<Record<string, unknown>>;
	const gate = c.required.find((g) => g.stage === stage);
	const cref = initiativesContractRef(c);
	if (
		gate === undefined ||
		!equal(event.issuer, gate.verifier) ||
		!equal(context.artifact, c.artifactRef) ||
		!equal(context.recipient, c.recipient) ||
		(stage === "owner-confirmed"
			? body.fact !== "artifact-confirmed" ||
				body.status !== "known" ||
				!equal(context.owner, gate.verifierActor) ||
				!equal(context.action, ref("operation", cref.id, cref.revision)) ||
				!equal(context.policy, ref("policy", gate.rule.id, gate.rule.revision))
			: body.fact !== "gate-observed" ||
				body.stage !== stage ||
				!equal(body.contract, cref) ||
				!(["pass", "fail"] as unknown[]).includes(body.result))
	)
		throw new RtpiReject("initiatives-acceptance-binding");
	const acceptance: InitiativesFixtureAcceptance = immutable({
		acceptanceRef: ref("receipt", event.eventId as string, String(event.revision)),
		contractRef: cref,
		contractSha256: contract.digest,
		rule: gate.rule,
		stage,
		verifier: gate.verifier,
		recipient: c.recipient,
		artifactRef: c.artifactRef,
		artifact: c.artifact,
		at: event.occurredAt as number,
		result: stage === "owner-confirmed" || body.result === "pass" ? "pass" : "fail",
		expired: input.expired === true,
	});
	ACCEPTANCES.add(acceptance);
	return acceptance;
}

export interface InitiativesGateResult {
	readonly state: "done" | "incomplete" | "unknown";
	readonly completedAt: number | null;
	readonly stages: Readonly<Partial<Record<InitiativesStage, "pass" | "fail" | "missing" | "unknown">>>;
}

/** Read-only reduction. Caller supplies immutable acceptance refs and their confined native resolution, not latest.
 * Registry lead/member/report changes do not enter this function; contract/recipient/artifact/rule changes do. */
export function initiativesOutcomeCompletion(input: {
	readonly contract: RtpiAccepted | null;
	readonly acceptanceRefs: readonly RtpiRef[];
	readonly resolve: (ref: RtpiRef) => InitiativesFixtureAcceptance | null;
}): InitiativesGateResult {
	const unknown = (): InitiativesGateResult => ({ state: "unknown", completedAt: null, stages: {} });
	if (
		input.contract === null ||
		!isRtpiAccepted(input.contract) ||
		!input.contract.qualified ||
		input.contract.schema !== "rtpi/outcome-contract/1" ||
		input.acceptanceRefs.length > 64
	)
		return unknown();
	const checked = rtpiStructural(input.contract.root);
	if (checked.status !== "accepted") return unknown();
	const c = input.contract.root as unknown as OutcomeContractV1;
	const stages: Partial<Record<InitiativesStage, "pass" | "fail" | "missing" | "unknown">> = {};
	let completedAt = 0;
	for (const gate of c.required) {
		const proofs = input.acceptanceRefs
			.map((r) => {
				const p = input.resolve(r);
				return p !== null && ACCEPTANCES.has(p) && equal(r, p.acceptanceRef) ? p : null;
			})
			.filter(
				(p): p is InitiativesFixtureAcceptance =>
					p !== null &&
					p.stage === gate.stage &&
					equal(p.contractRef, initiativesContractRef(c)) &&
					p.contractSha256 === input.contract?.digest &&
					equal(p.rule, gate.rule) &&
					equal(p.verifier, gate.verifier) &&
					equal(p.recipient, c.recipient) &&
					equal(p.artifactRef, c.artifactRef) &&
					equal(p.artifact, c.artifact),
			);
		const distinct = new Map(proofs.map((p) => [rtpiCanonical(p.acceptanceRef), p]));
		const values = [...distinct.values()];
		if (values.length === 0) stages[gate.stage] = "missing";
		else if (values.length > 1 || values[0].expired) stages[gate.stage] = "unknown";
		else if (gate.dependsOn.some((d) => stages[d] !== "pass")) stages[gate.stage] = "missing";
		else {
			stages[gate.stage] = values[0].result;
			if (values[0].result === "pass") completedAt = Math.max(completedAt, values[0].at);
		}
	}
	const all = Object.values(stages);
	const done = all.length > 0 && all.every((s) => s === "pass");
	return {
		state: done ? "done" : all.some((s) => s === "unknown" || s === "missing") ? "unknown" : "incomplete",
		completedAt: done ? completedAt : null,
		stages,
	};
}

/** Independent domain retention choices; null is no deletion. IB1 never prunes anything. Publication heads, dedupe,
 * held/acknowledged refs and source/outbox boundaries must survive a future pruning design. */
export function initiativesReferenceRetention(input: {
	readonly domain: "execution" | "outcome";
	readonly terminalAt: number | null;
	readonly now: number;
	readonly policy: Readonly<Record<"execution" | "outcome", number | null>>;
}): "retained" | "expired" | "unknown" {
	const ms = input.policy[input.domain];
	if (
		input.terminalAt === null ||
		!Number.isSafeInteger(input.terminalAt) ||
		!Number.isSafeInteger(input.now) ||
		input.terminalAt < 0 ||
		input.now < input.terminalAt ||
		(ms !== null && (!Number.isSafeInteger(ms) || ms < 0))
	)
		return "unknown";
	return ms === null || input.now - input.terminalAt < ms ? "retained" : "expired";
}
export function initiativesPrunable(checkpoint: RtpiAccepted | null): false {
	// The common predicate still applies, but IB1 grants no pruner and may not drop the publication CAS history.
	rtpiPrunable({ checkpoint, reconciled: false, journal: "unavailable" });
	return false;
}
