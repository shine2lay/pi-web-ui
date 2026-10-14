// IB3 #167. Fixed synthetic DTOs/qualified fixture records only; no app/model/session/private store.
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, relative, resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import type { ParserOptions } from "prettier";
import { parsers } from "prettier/plugins/typescript";
import { describe, it, expect, vi } from "vitest";
import {
	createRtpiFixtureCapability,
	rtpiCanonical,
	rtpiSha256,
	rtpiStructural,
	rtpiValidate,
	type RtpiAccepted,
	type RtpiArtifactKey,
	type RtpiRef,
	type RtpiVerdict,
} from "../../server/rtpi-core.js";
import { RtpiJournal, rtpiJournalGrant } from "../../server/rtpi-journal.js";
import {
	createInitiativesFixtureIssuer,
	initiativesExecution,
	initiativesOutcomeContract,
	initiativesContractRef,
	initiativesRequiredGates,
	initiativesOutcomeCompletion,
	type InitiativeExecutionDraft,
	type InitiativeExecutionV1,
	type OutcomeContractDraft,
	type OutcomeContractV1,
	type InitiativesFixtureNamedFact,
	type InitiativeCause,
} from "../../server/initiatives-registry.js";
import { INITIATIVES_ISSUER_ID, INITIATIVES_ISSUER_REVISION } from "../../server/rtpi-schema.js";
import { rolesQueueSnapshot, type RolesQueueEnvelope, type RolesQueueInput } from "../../server/roles-queue.js";
import {
	rolesMessageAdmission,
	rolesMessageDelivery,
	type RolesMessageMeta,
	type RolesMessageResult,
} from "../../server/roles-messages.js";
import {
	rolesNativeOriginRoot,
	type NativeOriginInput,
	type RolesOriginKey,
	type RolesOriginQueue,
	type RolesOriginResult,
} from "../../server/roles-origin.js";
import { g0ArtifactRef, g0Issuer } from "../../server/roles-artifact.js";
import { rolesArtifactLifecycle, type RolesGateResult } from "../../server/roles-gates.js";
import {
	INITIATIVES_ADAPTERS_ENABLED,
	initiativesQueueTaskBinding,
	initiativesMessageBinding,
	initiativesOriginBinding,
	initiativesArtifactBinding,
	type InitiativesAdapterScope,
} from "../../server/initiatives-adapters.js";

const native = vi.hoisted(() => ({
	input: null as NativeOriginInput | null,
	cap: null as ReturnType<typeof createRtpiFixtureCapability> | null,
}));
vi.mock("../../server/roles-origin-native.js", () => ({
	nativeOriginInput: () => native.input,
	nativeOriginCapability: () => native.cap,
	nativeOwnWorkPolicy: () => null,
}));
const cases = JSON.parse(
	readFileSync(new URL("../fixtures/initiatives-adapter-cases.json", import.meta.url), "utf8"),
) as {
	sourcePins: { unit: string; repo?: string; commit: string; path: string; blob: string }[];
	stages: { id: string; linked: boolean; held: boolean; receipt: boolean; expected: string }[];
	boundaries: { pendingDisplayCap: number; fullIndexRows: number; outcomeResolutionMax: number };
};
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const ref = (kind: string, id: string, revision = "1"): RtpiRef => ({ namespace: "rtpi-fixture", kind, id, revision });
const accepted = (v: RtpiVerdict | null): RtpiAccepted => {
	expect(v?.status, v?.status === "accepted" ? "" : v?.reason).toBe("accepted");
	if (v?.status !== "accepted") throw new Error("fixture-not-accepted");
	return v;
};
const ON = { enabled: true };
const I = ref("initiative", "team-in-temper");
const ISSUER = ref("issuer", INITIATIVES_ISSUER_ID, INITIATIVES_ISSUER_REVISION);
const WORK = ref("operation", "task-operation-1");
const ARTIFACT: RtpiArtifactKey = {
	gitHead: "a".repeat(40),
	assetsSha256: "b".repeat(64),
	version: "1.0.1",
	manifestRevision: 1,
	targetEnvironment: "fixture-only",
	environmentEpoch: "e1",
};
const envelope = (id: string, issuer = ref("issuer", "ib3-source")): RolesQueueEnvelope => ({
	eventId: id,
	source: ref("source", id),
	issuer,
	subject: ref("subject", "role-ops"),
	lineage: ref("lineage", id),
	incarnation: "i1",
	sequence: 1,
	revision: 1,
	expectedRevision: 0,
	occurredAt: 1000,
});
const capability = (e: RolesQueueEnvelope, facts: Parameters<typeof createRtpiFixtureCapability>[0]["facts"]) =>
	createRtpiFixtureCapability({
		source: e.source,
		issuer: e.issuer,
		subject: e.subject,
		roots: ["rtpi/event/1"],
		facts,
		policyAccepted: true,
		acceptedSidecars: [],
		seams: { atomicOutbox: true, issuerRegistry: true, inputHook: true, ownerPrincipal: false, confinedReader: false },
	});
const qualification = (e: RolesQueueEnvelope) => ({
	lineage: e.lineage,
	incarnation: e.incarnation,
	currentRevision: 0,
	currentSequence: 0,
	sourceCommitted: true,
	serverNow: 2000,
});
const cursor = (id: string) => ({
	lineage: ref("lineage", id),
	incarnation: "i1",
	expectedRevision: 0,
	publicationRevision: 1,
	publishedAt: 1000,
});

function scope(
	work: readonly RtpiRef[] = [WORK],
	causes: readonly InitiativeCause[] = [],
	artifact = ARTIFACT,
	complete: "complete" | "unknown" = "complete",
): InitiativesAdapterScope {
	const contractDraft: OutcomeContractDraft = {
		objectId: "ib3-outcome",
		initiative: I,
		title: "Fixed scoped outcome",
		order: 1,
		responsibleActor: ref("role", "ops"),
		recipient: ref("role", "temper"),
		authority: ref("operation", "outcome-authority"),
		kind: "software-delivery",
		acceptedBy: ISSUER,
		artifactRef: ref("artifact", rtpiSha256(rtpiCanonical(artifact))),
		artifact,
		contributions: [],
		handoffs: [],
		refs: [],
		required: initiativesRequiredGates(
			"software-delivery",
			Object.fromEntries(
				["built", "checked", "installed", "live", "owner-confirmed"].map((stage) => [
					stage,
					{
						rule: ref("contract", `rule-${stage}`),
						verifier: ref("issuer", `verifier-${stage}`),
						verifierActor: ref(stage === "owner-confirmed" ? "owner" : "role", stage === "checked" ? "qa" : "ops"),
						independentOf: stage === "checked" ? ref("role", "ops") : null,
					},
				]),
			),
		),
	};
	const named = (kind: InitiativesFixtureNamedFact["kind"], authority: RtpiRef, value: unknown) => ({
		kind,
		authority,
		initiative: I,
		publisher: ISSUER,
		valueSha256: rtpiSha256(rtpiCanonical(value)),
	});
	const registry = {
		fact: "add_initiative" as const,
		registryRecord: ref("operation", "registry-1"),
		initiative: I,
		name: "Team in Temper",
		markers: [],
	};
	const f = {
		registry,
		lead: null,
		publications: [named("outcome", contractDraft.authority, contractDraft)],
		outcomes: [],
		completeness: { membership: "unknown" as const, contributions: complete, outcomes: "complete" as const },
		atomicSourceOutbox: true,
	};
	const contract = accepted(
		initiativesOutcomeContract(createInitiativesFixtureIssuer(f), contractDraft, cursor("outcome")),
	);
	const outcomeRef = initiativesContractRef(contract.root as unknown as OutcomeContractV1);
	const draft: InitiativeExecutionDraft = {
		initiative: I,
		registryRecord: registry.registryRecord,
		name: registry.name,
		markers: [],
		goal: { text: null, authority: null },
		lead: null,
		members: [],
		started: null,
		finishTarget: null,
		outcomes: [outcomeRef],
		causes,
		refs: [],
		completeness: f.completeness,
		contributions: work.map((w, n) => ({
			id: `c${n}`,
			role: ref("role", "ops"),
			work: w,
			assignment: ref("operation", `assign-${n}`),
			origin: ref("origin", `origin-${n}`),
			outcomes: [outcomeRef],
			coverage: "complete",
		})),
	};
	const execution = accepted(
		initiativesExecution(
			createInitiativesFixtureIssuer({
				...f,
				outcomes: draft.outcomes,
				publications: [
					...f.publications,
					...draft.contributions.map((c) => named("contribution", c.assignment, c)),
					...causes.map((c) => named("cause", c.evidence, c)),
				],
			}),
			draft,
			cursor("initiative"),
		),
	);
	return { execution, contracts: [contract] };
}

// Run the actual pinned canonical add-on, never reproduce its replay/hold rules in IB3.
function queue(held = false, count = 1) {
	const module = pathToFileURL(resolve("../pi-queue/queue-projection.ts")).href;
	const script = `import {projectQueue} from ${JSON.stringify(module)};
		const binding={queueId:'Q1',sessionId:'Q1',sessionEpoch:'E1',branchId:'B1',homeRevision:1};
		const plan={title:'team-in-temper',goal:'synthetic only',doneWhen:'d',decided:'c',steps:'s',verify:'v',mustNot:'m'};
		const ops=Array.from({length:${count}},(_,n)=>({op:'add',id:n+1,plan}));
		${held ? "ops.push({op:'hold',id:1,why:'Owner fixture pause',by:'tool'});" : ""}
		const entries=ops.map((op,n)=>({type:'custom',customType:'queue',data:{v:1,...op,ts:900+n}}));
		const source={binding,children:[],coverage:'complete',observedAt:2000,entries};
		const p=projectQueue(source,binding);
		console.log(JSON.stringify(projectQueue(source,binding,{binding,revision:p.revision,observedAt:2000,
			coverage:'complete',homeBusy:false,observations:[]})));`;
	return JSON.parse(
		execFileSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8", timeout: 15000 }),
	) as RolesQueueInput &
		RolesOriginQueue & {
			pending: { key: RolesOriginKey; held: boolean }[];
			recentDone: unknown[];
			held: boolean;
			running: boolean;
		};
}
function sources(p = queue(), key = p.index[0].key) {
	const qe = envelope("queue-1");
	const receipt = rolesQueueSnapshot(p, qe, {
		...ON,
		capability: capability(qe, ["queue-snapshot"]),
		qualification: qualification(qe),
	});
	accepted(receipt.verdict);
	const oe = envelope("origin-1");
	native.cap = capability(oe, ["origin-classified"]);
	native.input = {
		envelope: oe,
		qualification: qualification(oe),
		queueRevision: p.revision!,
		ownerPrincipal: null,
		record: {
			schema: "i-origin/1",
			context: { key, target: ref("role", "ops"), operation: WORK, sourceRequest: null, committedAt: 1000 },
			classification: "unclassified",
			request: null,
			actor: null,
			forwardChain: [],
			reason: "legacy-unclassified",
		},
	};
	const origin = rolesNativeOriginRoot();
	accepted(origin.verdict);
	return { p, key, receipt, origin };
}
function message(fact: "message-admitted" | "message-delivered" = "message-admitted"): RolesMessageResult {
	const meta: RolesMessageMeta = {
		schema: "i-message/1",
		id: "rm-fixture1",
		kind: "request",
		route: "home",
		from: { role: "ops", homeRevision: 1 },
		to: { role: "temper", homeRevision: 1 },
		target: { sessionId: "S1", sessionEpoch: "E1", branchId: "B1", homeRevision: 1 },
		task: null,
		replyTo: null,
	};
	const e = envelope("message-1");
	const options = { ...ON, capability: capability(e, [fact]), qualification: qualification(e) };
	return fact === "message-delivered"
		? rolesMessageDelivery(meta, { revision: 1, delivered: true }, e, options)
		: rolesMessageAdmission(fact, meta, e, options);
}
// A fixed synthetic C7/G0 result (upstream gate adapter/coverage tests stay unchanged and run in check.sh).
// This fixture supplies a known producing run; it does not emulate any native measurement/verification.
function gate(artifact = ARTIFACT): RolesGateResult {
	const e = envelope("gate-1", g0Issuer("pi-web-ui", "rtpi-fixture"));
	const root = {
		schema: "rtpi/event/1",
		...e,
		context: {
			queue: null,
			taskId: null,
			planRevision: null,
			session: null,
			epoch: null,
			turn: null,
			run: ref("run", "producing-run"),
			attempt: ref("attempt", "attempt-1"),
			recipient: null,
			channel: "unknown",
			action: null,
			artifact: g0ArtifactRef(artifact, "rtpi-fixture"),
			owner: null,
			client: null,
			window: null,
			projection: null,
			coverage: null,
			policy: null,
			challenge: null,
		},
		body: {
			fact: "gate-observed",
			stage: "built",
			result: "pass",
			contract: ref("contract", "gate-contract"),
			refs: [],
		},
	};
	const verdict = accepted(
		rtpiValidate(root, capability(e, ["gate-observed"]), {
			...qualification(e),
			gateContractAccepted: true,
			currentArtifact: root.context.artifact,
			rolesGateIssuer: e.issuer,
		}),
	);
	return { state: "validated", reason: "synthetic-qualified-source", native: false, verdict };
}

// Each required stage has fixed catch/pass inputs before the isolated fresh-process replay below.
describe("IB3 stages / task links and holds", () => {
	for (const c of cases.stages)
		it(c.id, () => {
			const { p, key, receipt, origin } = sources(queue(c.held));
			const s = scope(c.linked ? [WORK] : []);
			const before = rtpiCanonical({ p, receipt, origin, s });
			const r = initiativesQueueTaskBinding(p, key, c.receipt ? receipt : { ...receipt, verdict: null }, origin, s, ON);
			expect(r.binding.state).toBe(c.expected);
			expect(r.projection).toBe(p);
			expect(r.task).toBe(p.index[0]);
			expect(r.origin).toBe(origin);
			if (c.held) expect(r.projection.pending[0].held).toBe(true);
			if (c.id === "task-no-link") expect(r.binding.initiative).toBeNull(); // matching title is not an assignment
			if (c.id === "truncated-mirror") {
				const tail = { ...p, pending: [], recentDone: [] };
				expect(initiativesQueueTaskBinding(tail, key, receipt, origin, s, ON).binding).toEqual(r.binding);
			}
			if (!c.receipt) expect(r.binding.capture).toBe("unknown");
			expect(rtpiCanonical({ p, receipt, origin, s })).toBe(before);
		});
	it("full canonical index binds rows past the display cap; stopping is not pausing", () => {
		const p = queue(false, cases.boundaries.fullIndexRows);
		expect(p.pending.length).toBe(cases.boundaries.pendingDisplayCap);
		expect(p.index.length).toBe(cases.boundaries.fullIndexRows);
		const { key, receipt, origin } = sources(p, p.index[p.index.length - 1].key);
		const r = initiativesQueueTaskBinding(p, key, receipt, origin, scope(), ON);
		expect(r.binding.state).toBe("linked");
		expect(r.projection.running).toBe(false);
		expect(r.projection.held).toBe(false);
	});
	it("missing outbox, copied receipts, stale key/revision, ambiguous index and incomplete capture stay unknown", () => {
		const { p, key, receipt, origin } = sources();
		const s = scope();
		for (const [projection, k, q, o] of [
			[p, key, { ...receipt, verdict: clone(receipt.verdict) }, origin],
			[p, key, receipt, { ...origin, verdict: clone(origin.verdict) }],
			[p, { ...key, planRevision: 2 }, receipt, origin],
			[{ ...p, revision: "c".repeat(64) }, key, receipt, origin],
			[{ ...p, queueCoverage: "partial" as const }, key, receipt, origin],
			[{ ...p, index: [...p.index, p.index[0]] }, key, receipt, origin],
			[p, key, receipt, { ...origin, verdict: null }],
		] as const)
			expect(initiativesQueueTaskBinding(projection, k, q, o, s, ON).binding.state).toBe("unknown");
		expect(
			initiativesQueueTaskBinding(p, key, receipt, origin, scope([], [], ARTIFACT, "unknown"), ON).binding.state,
		).toBe("unknown");
	});
});

describe("IB3 stages / origin, messages, artifact and cause", () => {
	it("preserves unclassified origins instead of turning initiative membership into a request", () => {
		const { origin } = sources();
		const r = initiativesOriginBinding(origin, scope(), ON);
		expect(r.source).toBe(origin);
		expect(r.binding.state).toBe("linked");
		expect((accepted(r.source.verdict).root.body as { classification: string }).classification).toBe("unknown");
	});
	it("keeps messages at their own delivery stage and binds only an explicit whole action ref", () => {
		for (const fact of ["message-admitted", "message-delivered"] as const) {
			const source = message(fact);
			const work = (accepted(source.verdict).root.context as unknown as { action: RtpiRef }).action;
			const r = initiativesMessageBinding(source, scope([work]), ON);
			expect(r.source).toBe(source);
			expect(r.binding.state).toBe("linked");
			expect((accepted(r.source.verdict).root.body as { fact: string }).fact).toBe(fact);
			expect(initiativesMessageBinding(source, scope([{ ...work, revision: "2" }]), ON).binding.state).toBe("unlinked");
		}
	});
	it("no native origin or artifact receipt means unknown, never a completed step", () => {
		native.input = null;
		const origin = rolesNativeOriginRoot();
		expect(initiativesOriginBinding(origin, scope(), ON).binding.capture).toBe("unknown");
		const source = rolesArtifactLifecycle.built(ON); // native source is deliberately absent
		expect(initiativesArtifactBinding(source, scope([ref("run", "producing-run")]), ON).binding.state).toBe("unknown");
		const c = scope().contracts[0];
		expect(initiativesOutcomeCompletion({ contract: c, acceptanceRefs: [], resolve: () => null }).state).not.toBe(
			"done",
		);
	});
	it("G0 producing run + all six artifact fields bind exactly; a receipt never proves completion", () => {
		const source = gate();
		const work = ref("run", "producing-run");
		const r = initiativesArtifactBinding(source, scope([work]), ON);
		expect(r.source).toBe(source);
		expect(r.binding).toMatchObject({ state: "linked", outcomeState: "linked" });
		for (const [field, replacement] of Object.entries({
			gitHead: "c".repeat(40),
			assetsSha256: "d".repeat(64),
			version: "2.0.0",
			manifestRevision: 2,
			targetEnvironment: "other",
			environmentEpoch: "e2",
		})) {
			const wrong = scope([work], [], { ...ARTIFACT, [field]: replacement });
			expect(initiativesArtifactBinding(source, wrong, ON).binding.outcomeState).toBe("unknown");
		}
		expect(initiativesArtifactBinding(source, scope([WORK]), ON).binding.state).toBe("unlinked");
		expect(
			initiativesOutcomeCompletion({
				contract: r.binding.outcomes[0].contract,
				acceptanceRefs: [],
				resolve: () => null,
			}).state,
		).not.toBe("done");
	});
	it("OD8 passes only published P03 stall causes; no #87 cause is unknown", () => {
		const { origin } = sources();
		expect(initiativesOriginBinding(origin, scope(), ON).binding.stall).toEqual({ state: "unknown", causes: [] });
		const cause: InitiativeCause = {
			kind: "finished-task-not-acted-on",
			subject: WORK,
			evidence: ref("receipt", "stall-87"),
			relatedRefs: [WORK],
			since: 900,
			thresholdHours: null,
		};
		const s = scope([WORK], [cause]);
		const r = initiativesOriginBinding(origin, s, ON);
		expect(r.binding.stall.state).toBe("known");
		expect(r.binding.stall.causes[0]).toBe((s.execution!.root as unknown as InitiativeExecutionV1).causes[0]);
		expect(
			initiativesOriginBinding(origin, scope([WORK], [{ ...cause, subject: ref("operation", "unrelated") }]), ON)
				.binding.stall.state,
		).toBe("unknown");
	});
	it("missing publication/contracts, conflict and non-qualified publication cannot be called linked outcomes", () => {
		const { origin } = sources();
		const s = scope();
		expect(initiativesOriginBinding(origin, { ...s, execution: null }, ON).binding.state).toBe("unknown");
		expect(initiativesOriginBinding(origin, { ...s, execution: clone(s.execution) }, ON).binding.state).toBe("unknown");
		expect(
			initiativesOriginBinding(origin, { ...s, execution: accepted(rtpiStructural(s.execution!.root)) }, ON).binding
				.state,
		).toBe("unknown");
		expect(initiativesOriginBinding(origin, { ...s, contracts: [] }, ON).binding.outcomeState).toBe("unknown");
		expect(
			initiativesOriginBinding(origin, { ...s, contracts: [clone(s.contracts[0])] }, ON).binding.outcomeState,
		).toBe("unknown");
		expect(
			initiativesOriginBinding(
				origin,
				{ ...s, contracts: Array(cases.boundaries.outcomeResolutionMax + 1).fill(s.contracts[0]) },
				ON,
			).binding.state,
		).toBe("unknown");
		expect(initiativesOriginBinding(origin, scope([WORK, WORK]), ON).binding.state).toBe("unknown");
	});
});

describe("IB3 restart replay / required fixed stages", () => {
	it("reopens a private RTPI journal and requalifies in a fresh process without the mirror tail", async () => {
		const dir = await mkdtemp(join(tmpdir(), "ib3-restart-"));
		try {
			const bundle = await build({
				stdin: {
					contents: `export * from './server/rtpi-core.ts';
				export * from './server/rtpi-journal.ts'; export * from './server/initiatives-adapters.ts';`,
					resolveDir: process.cwd(),
				},
				bundle: true,
				platform: "node",
				format: "esm",
				write: false,
			});
			const uri = `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`;
			for (const c of cases.stages) {
				const { p, key, receipt, origin } = sources(queue(c.held));
				const s = scope(c.linked ? [WORK] : []);
				await mkdir(join(dir, c.id), { mode: 0o700 });
				const grant = rtpiJournalGrant({ enabled: true, directory: join(dir, c.id) });
				const journal = await RtpiJournal.open(grant);
				expect(journal.state, c.id).toMatchObject({ status: "clean" });
				const records = [accepted(receipt.verdict), accepted(origin.verdict), s.execution!, ...s.contracts];
				for (const record of records) expect((await journal.append(record)).status).toBe("appended");
				const script = `import {readFileSync} from 'node:fs';
					const x=JSON.parse(readFileSync(0,'utf8'));
					const m=await import(x.module);
					const journal=await m.RtpiJournal.open(m.rtpiJournalGrant({enabled:true,directory:x.directory}));
					if(journal.state.status!=='clean') throw new Error('journal-not-clean');
					const values=journal.records().map(({record})=>{
						const root=record.root, fact=root.body?.fact;
						const cap=m.createRtpiFixtureCapability({source:root.source,issuer:root.issuer,subject:root.subject,
							roots:[root.schema],facts:fact?[fact]:[],policyAccepted:true,acceptedSidecars:[],
							seams:{atomicOutbox:true,issuerRegistry:true,inputHook:true,ownerPrincipal:false,confinedReader:false}});
						const v=m.rtpiValidate(root,cap,{lineage:root.lineage,incarnation:root.incarnation,
							currentRevision:root.expectedRevision,currentSequence:root.sequence-1,sourceCommitted:true,serverNow:3000,
							initiativesRegistryQualified:true,initiativesBindingDigest:record.digest,initiativesPerKindIssuer:root.issuer,
							gateContractAccepted:true});
						if(v.status!=='accepted'||!v.qualified||v.digest!==record.digest) throw new Error('fixture-requalification');
						return v;
					});
					const [q,o,execution,...contracts]=values;
					const result=m.initiativesQueueTaskBinding(x.projection,x.key,{...x.receipt,verdict:x.missing?null:q},
						{...x.origin,verdict:o},{execution,contracts},{enabled:true});
					console.log(JSON.stringify({binding:result.binding,held:result.projection.pending[0]?.held??null,
						digests:values.map(v=>v.digest)}));`;
				const replay = JSON.parse(
					execFileSync(process.execPath, ["--input-type=module", "-e", script], {
						input: JSON.stringify({
							module: uri,
							directory: join(dir, c.id),
							projection: c.id === "truncated-mirror" ? { ...p, pending: [], recentDone: [] } : p,
							key,
							receipt,
							origin,
							missing: !c.receipt,
						}),
						encoding: "utf8",
						timeout: 15000,
						maxBuffer: 2 * 1024 * 1024,
					}),
				);
				expect(replay.binding.state, c.id).toBe(c.expected);
				expect(replay.digests).toEqual(records.map((r) => r.digest));
				if (c.held) expect(replay.held).toBe(true);
			}
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});

// Test-only source-graph fence. Parse syntax, not words in comments or strings; no runtime loading.
const productionRoots = ["server", "web/src", "plugins", "extensions", "bin", "desktop"];
const sourceExtension = /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
function productionSources(dir: string): [string, string][] {
	if (!existsSync(dir)) return [];
	return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const path = join(dir, entry.name);
		if (entry.isDirectory())
			return ["node_modules", "dist", ".git"].includes(entry.name) ? [] : productionSources(path);
		return sourceExtension.test(entry.name) ? [[path, readFileSync(path, "utf8")]] : [];
	});
}
function astObject(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}
function literalModule(value: unknown): string | undefined {
	const node = astObject(value);
	if (!node) return undefined;
	if ((node.type === "Literal" || node.type === "StringLiteral") && typeof node.value === "string") return node.value;
	if (
		node.type === "TemplateLiteral" &&
		Array.isArray(node.expressions) &&
		node.expressions.length === 0 &&
		Array.isArray(node.quasis) &&
		node.quasis.length === 1
	) {
		const cooked = astObject(astObject(node.quasis[0])?.value)?.cooked;
		return typeof cooked === "string" ? cooked : undefined;
	}
	return undefined;
}
async function inboundInitiativesImports(sources: ReadonlyMap<string, string>): Promise<string[]> {
	const target = resolve("server/initiatives-adapters");
	const hits = new Set<string>();
	for (const [path, text] of sources) {
		const record = (specifier: string) => {
			const value = specifier.split(/[?#]/, 1)[0];
			if (!value.startsWith(".") && !value.startsWith("/")) return;
			if (resolve(dirname(path), value).replace(sourceExtension, "") === target) hits.add(`${path} -> ${specifier}`);
		};
		// H6: existing public grammar parser, not TS7's metadata-only root export.
		// This parser consumes filepath (including JSX) only; no formatting/config lookup.
		// Await its public T | Promise<T> contract; API/syntax errors propagate, never skip.
		const tree: unknown = await parsers.typescript.parse(text, { filepath: path } as ParserOptions);
		const root = astObject(tree);
		if (root?.type !== "Program" || !Array.isArray(root.body))
			throw new Error(`H6 parser returned no source AST for ${path}`);
		const visited = new WeakSet<object>();
		const visit = (value: unknown): void => {
			if (value === null || typeof value !== "object" || visited.has(value)) return;
			visited.add(value);
			if (Array.isArray(value)) {
				value.forEach(visit);
				return;
			}
			const node = value as Record<string, unknown>;
			let specifier: string | undefined;
			if (
				node.type === "ImportDeclaration" ||
				node.type === "ExportNamedDeclaration" ||
				node.type === "ExportAllDeclaration" ||
				node.type === "ImportExpression"
			) {
				specifier = literalModule(node.source);
			} else if (node.type === "TSExternalModuleReference") {
				specifier = literalModule(node.expression);
			} else if (node.type === "TSImportType") {
				specifier = literalModule(node.argument) ?? literalModule(node.source);
			} else if (node.type === "CallExpression") {
				const callee = astObject(node.callee);
				const isImport = callee?.type === "Import";
				const isRequire = callee?.type === "Identifier" && callee.name === "require";
				if ((isImport || isRequire) && Array.isArray(node.arguments)) specifier = literalModule(node.arguments[0]);
			}
			if (specifier !== undefined) record(specifier);
			for (const [key, child] of Object.entries(node))
				if (!["tokens", "comments", "parent", "loc", "range"].includes(key)) visit(child);
		};
		visit(tree);
	}
	return [...hits].sort();
}

describe("IB3 exact source pins and inert boundary", () => {
	it("all consumed modules equal their qualified result commits, including the corrected M0 and canonical add-on", () => {
		for (const pin of cases.sourcePins) {
			const cwd = resolve(pin.repo ?? ".");
			const git = (args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
			expect(git(["rev-parse", `${pin.commit}:${pin.path}`]), pin.unit).toBe(pin.blob);
			expect(git(["hash-object", pin.path]), `${pin.unit} current bytes`).toBe(pin.blob);
			expect(git(["merge-base", "--is-ancestor", pin.commit, "HEAD"])).toBe("");
		}
	});
	it("flag is off and every source/receipt is imported, not redefined or wired", () => {
		expect(INITIATIVES_ADAPTERS_ENABLED).toBe(false);
		const { p, key, receipt, origin } = sources();
		const s = scope();
		const msg = message();
		const g = gate();
		for (const options of [{}, { enabled: false }]) {
			expect(initiativesQueueTaskBinding(p, key, receipt, origin, s, options).binding.state).toBe("off");
			expect(initiativesOriginBinding(origin, s, options).binding.state).toBe("off");
			expect(initiativesMessageBinding(msg, s, options).binding.state).toBe("off");
			expect(initiativesArtifactBinding(g, s, options).binding.state).toBe("off");
		}
		const code = readFileSync("server/initiatives-adapters.ts", "utf8");
		expect(code).not.toMatch(
			/interface\s+(?:Roles|Queue)|type\s+Roles|rtpiValidate|createRtpiFixture|readFile|writeFile|appendFile|registerTool|setTimeout|setInterval|process\.env/,
		);
		for (const name of [
			"RolesQueueInput",
			"RolesQueueSnapshot",
			"RolesMessageResult",
			"RolesOriginKey",
			"RolesOriginQueue",
			"RolesOriginResult",
			"RolesGateResult",
		])
			expect(code).toContain(name);
	});
	it("H5 inbound-import fence / every production root stays outside the inert IB3 closure", async () => {
		const files = new Map(productionRoots.flatMap(productionSources));
		expect(files.has("server/index.ts")).toBe(true);
		expect(files.has("server/initiatives-adapters.ts")).toBe(true);
		expect(await inboundInitiativesImports(files)).toEqual([]);
		// Both older fences name the exact inert path, never a nested namesake.
		for (const path of ["tests/unit/roles-gates.test.ts", "tests/unit/roles-owner-challenge.test.ts"]) {
			const guard = readFileSync(path, "utf8");
			expect(guard).toContain('"server/initiatives-adapters.ts"');
			expect(guard).not.toContain('"initiatives-adapters.ts"');
		}
		expect(readFileSync("tests/unit/roles-gates.test.ts", "utf8")).toContain("!component.has(p)");
	}, 120_000);
	it("H5 inbound-import fence / injected bad-import counterfactuals and clean controls", async () => {
		const clean = new Map([
			[
				"server/index.ts",
				'import "./unrelated.js"; // import "./initiatives-adapters.js"\nconst text = \'require("./initiatives-adapters.js")\';',
			],
			["server/nested/initiatives-adapters.ts", "export type Namesake = never;"],
		]);
		expect(await inboundInitiativesImports(clean)).toEqual([]);
		await expect(inboundInitiativesImports(new Map([["server/broken.ts", "import {"]]))).rejects.toThrow();
		const missingAst = vi.spyOn(parsers.typescript, "parse").mockResolvedValueOnce(undefined);
		try {
			await expect(inboundInitiativesImports(clean)).rejects.toThrow("H6 parser returned no source AST");
		} finally {
			missingAst.mockRestore();
		}
		const forms = [
			(s: string) => `import { x } from ${s};`,
			(s: string) => `import type { X } from ${s};`,
			(s: string) => `export { x } from ${s};`,
			(s: string) => `export * from ${s};`,
			(s: string) => `import ${s};`,
			(s: string) => `const p = import(${s});`,
			(s: string) => `const p = require(${s});`,
			(s: string) => `import p = require(${s});`,
			(s: string) => `type P = typeof import(${s});`,
		];
		for (const root of productionRoots) {
			for (const extension of ["ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "cjs"]) {
				const path = join(root, `guard-candidate.${extension}`);
				const rel = relative(dirname(path), "server/initiatives-adapters.js");
				const specifier = rel.startsWith(".") ? rel : `./${rel}`;
				for (const form of forms) {
					const files = new Map([...clean, [path, form(JSON.stringify(specifier))]]);
					expect(await inboundInitiativesImports(files), `${path}: ${form(specifier)}`).toEqual([
						`${path} -> ${specifier}`,
					]);
				}
			}
		}
		// An identically named source outside the exact inert path gains no exemption.
		const path = "server/nested/initiatives-adapters.ts";
		const specifier = "../initiatives-adapters.js";
		expect(
			await inboundInitiativesImports(new Map([...clean, [path, `import ${JSON.stringify(specifier)};`]])),
		).toEqual([`${path} -> ${specifier}`]);
		expect(
			await inboundInitiativesImports(new Map([["server/index.ts", "import(`./initiatives-adapters.js`);"]])),
		).toEqual(["server/index.ts -> ./initiatives-adapters.js"]);
	});
});
