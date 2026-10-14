// R0 #141: synthetic fixed metadata only. vi.mock is the sole replacement for sealed native inputs.
// No native issuer/principal/outbox, owner choice, live chat, model request or policy change is exercised.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	createRtpiFixtureCapability,
	rtpiStructural,
	rtpiValidate,
	type RtpiAccepted,
	type RtpiCapability,
	type RtpiRef,
} from "../../server/rtpi-core.js";
import {
	ownWorkDeclarationRef,
	rolesNativeOriginRoot,
	rolesOriginCounts,
	rolesOwnWorkDisplay,
	type NativeOriginInput,
	type NativeOwnWorkPolicy,
	type OwnWorkDeclaration,
	type RolesOriginClass,
	type RolesOriginKey,
	type RolesOriginQueue,
	type RolesOriginRecord,
} from "../../server/roles-origin.js";
import type { RolesQueueEnvelope } from "../../server/roles-queue.js";

const native = vi.hoisted(() => ({ input: null as unknown, capability: null as unknown, policy: null as unknown }));
vi.mock("../../server/roles-origin-native.js", () => ({
	nativeOriginInput: () => native.input as NativeOriginInput | null,
	nativeOriginCapability: () => native.capability as RtpiCapability | null,
	nativeOwnWorkPolicy: () => native.policy as NativeOwnWorkPolicy | null,
}));
const R = (kind: string, id: string, revision = "1"): RtpiRef => ({ namespace: "rtpi-fixture", kind, id, revision });
const TARGET = R("role", "ops"),
	OWNER = R("owner", "owner"),
	PEER = R("role", "coo");
const binding = { queueId: "QA", sessionId: "QA", sessionEpoch: "e1", branchId: "b1", homeRevision: 1 };
const key = (id = 1, revision = 1): RolesOriginKey => ({ ...binding, taskId: id, planRevision: revision });
const envelope: RolesQueueEnvelope = {
	eventId: "origin-event",
	source: R("source", "r0"),
	issuer: R("issuer", "r0"),
	subject: R("subject", "role-ops"),
	lineage: R("lineage", "r0"),
	incarnation: "inc-1",
	sequence: 1,
	revision: 1,
	expectedRevision: 0,
	occurredAt: 1000,
};
const capability = (ownerPrincipal = true) =>
	createRtpiFixtureCapability({
		source: envelope.source,
		issuer: envelope.issuer,
		subject: envelope.subject,
		roots: ["rtpi/event/1"],
		facts: ["origin-classified", "policy-approved", "owner-opened"],
		policyAccepted: true,
		acceptedSidecars: [],
		seams: { inputHook: false, atomicOutbox: true, ownerPrincipal, confinedReader: false, issuerRegistry: true },
	});
const qualification = () => ({
	lineage: envelope.lineage,
	incarnation: envelope.incarnation,
	currentRevision: 0,
	currentSequence: 0,
	sourceCommitted: true,
	serverNow: 2000,
	originIssuerQualified: true,
	requestQualified: true,
	ownerPrincipalAdmitted: true,
});
const record = (classification: RolesOriginClass = "owner-requested", id = 1): RolesOriginRecord => ({
	schema: "i-origin/1",
	context: {
		key: key(id),
		target: TARGET,
		operation: R("operation", `op-${id}`),
		sourceRequest: R("request", `req-${id}`),
		committedAt: 1000,
	},
	classification,
	request: classification === "unclassified" ? null : R("request", `req-${id}`),
	actor:
		classification === "own"
			? TARGET
			: classification === "owner-requested"
				? OWNER
				: classification === "role-requested"
					? PEER
					: null,
	forwardChain: [],
	reason: "synthetic-native-metadata",
});
function admit(r = record()): RtpiAccepted {
	native.input = {
		record: r,
		queueRevision: "queue-r1",
		ownerPrincipal: r.actor?.kind === "owner" ? OWNER : null,
		envelope: {
			...envelope,
			eventId: `event-${r.context.key.taskId}-${r.context.key.planRevision}`,
			occurredAt: r.context.committedAt,
		},
		qualification: qualification(),
	};
	native.capability = capability();
	const result = rolesNativeOriginRoot();
	if (result.verdict?.status !== "accepted") throw new Error(`fixture origin refused: ${JSON.stringify(result)}`);
	return result.verdict;
}
const queue = (): RolesOriginQueue => ({
	schema: "i-queue/1",
	binding,
	revision: "queue-r1",
	observedAt: 2000,
	queueCoverage: "complete",
	counts: { ready: 1, working: 0, asking: 0, stuck: 0, waiting: 0, blocked: 0, done: 0, removed: 0 },
	index: [{ key: key(), status: "ready" }],
});
function policyFixture(ownWork: OwnWorkDeclaration["ownWork"] = "paused", fact = "policy-approved") {
	const d: OwnWorkDeclaration = {
		schema: "i-own-work-policy/1",
		target: TARGET,
		owner: OWNER,
		action: R("operation", "own-policy-declared"),
		effectiveAt: 1000,
		ownWork,
	};
	const c = {
		queue: null,
		taskId: null,
		planRevision: null,
		session: R("session", "owner-session"),
		epoch: R("epoch", "owner-epoch"),
		turn: null,
		run: null,
		attempt: null,
		recipient: TARGET,
		channel: "browser",
		action: d.action,
		artifact: R("artifact", "policy-display"),
		owner: OWNER,
		client: R("client", "owner-client"),
		window: R("window", "owner-window"),
		projection: R("projection", "policy"),
		coverage: R("coverage", "policy"),
		policy: ownWorkDeclarationRef(d),
		challenge: R("challenge", "policy"),
	};
	const root = {
		schema: "rtpi/event/1",
		...envelope,
		context: c,
		body: {
			fact,
			status: "known",
			receipt: R("receipt", "policy"),
			clientRole: "owner",
			issuedAt: 1000,
			expiresAt: 61000,
			serverNow: 2000,
			mode: "new",
			refs: [],
		},
	};
	const q = {
		...qualification(),
		clientCurrent: true,
		currentArtifact: c.artifact,
		currentProjection: c.projection,
		currentCoverage: c.coverage,
	};
	const approval = rtpiValidate(root, capability(), q);
	if (approval.status !== "accepted") throw new Error(`fixture policy refused: ${JSON.stringify(approval)}`);
	return { declaration: d, approval, root, q };
}
beforeEach(() => {
	native.input = null;
	native.capability = null;
	native.policy = null;
});

describe("R0 native-only source / I-ORIGIN C0 envelope (V07/V15/S01)", () => {
	it("production defaults unavailable, with no caller-selectable input/admitter/capability", async () => {
		const real = await vi.importActual<typeof import("../../server/roles-origin-native.js")>(
			"../../server/roles-origin-native.js",
		);
		expect(real.nativeOriginInput()).toBeNull();
		expect(real.nativeOriginCapability()).toBeNull();
		expect(real.nativeOwnWorkPolicy(TARGET)).toBeNull();
		expect(rolesNativeOriginRoot()).toMatchObject({ state: "unavailable", verdict: null });
		expect(rolesNativeOriginRoot.length).toBe(0);
	});
	for (const classification of ["own", "owner-requested", "role-requested", "unclassified"] as const)
		it(`${classification}: binds native request/actor/target/queue/operation/full task tuple, never plan bodies`, () => {
			const r = record(classification);
			const accepted = admit(r);
			const body = accepted.root.body as Record<string, unknown>;
			expect(body.classification).toBe(classification === "unclassified" ? "unknown" : classification);
			expect(body.request).toEqual(r.request);
			expect(body.actor).toEqual(r.actor);
			expect(accepted.root.context).toMatchObject({
				queue: { id: "QA", revision: "queue-r1" },
				taskId: 1,
				planRevision: 1,
				session: { id: "QA", revision: "b1" },
				epoch: { id: "e1", revision: "1" },
				recipient: TARGET,
				action: r.context.operation,
			});
			expect(accepted.bytes).toBeLessThan(8192);
			expect(accepted.canonical).not.toMatch(/title|goal|prompt|\/home\//);
		});
	it("owner text/approval/initiative/wrong reference cannot be smuggled in through DTO extra fields", () => {
		for (const extra of [
			{ text: "owner said do it" },
			{ approved: true },
			{ initiative: "team-in-temper" },
			{ validated: true },
		]) {
			admit();
			const input = native.input as NativeOriginInput;
			native.input = { ...input, record: { ...record(), ...extra } };
			expect(rolesNativeOriginRoot().state).toBe("rejected");
		}
		admit();
		const input = structuredClone(native.input as NativeOriginInput);
		Object.assign(input.record.request!, { revision: "wrong-ref" });
		native.input = input;
		expect(rolesNativeOriginRoot().state).toBe("rejected");
	});
	it("owner needs T03 principal+admitted native owner action; fixture capability cannot mint native output", () => {
		admit();
		const input = native.input as NativeOriginInput;
		for (const principal of [null, PEER, R("owner", "owner", "2")]) {
			native.input = { ...input, ownerPrincipal: principal };
			expect(rolesNativeOriginRoot().state).toBe("unknown");
		}
		native.input = { ...input, qualification: { ...input.qualification, ownerPrincipalAdmitted: false } };
		expect(rolesNativeOriginRoot().state).toBe("unknown");
		native.input = input;
		native.capability = capability(false);
		expect(rolesNativeOriginRoot().state).toBe("unknown");
		native.capability = null;
		expect(rolesNativeOriginRoot().state).not.toBe("accepted");
		const nativeRecord = JSON.parse(JSON.stringify(input).replaceAll("rtpi-fixture", "rtpi-native"));
		native.input = nativeRecord;
		native.capability = capability();
		expect(rolesNativeOriginRoot().state).not.toBe("accepted");
	});
	it("missing source/issuer/atomic or stale native state never admits an origin", () => {
		admit();
		const input = native.input as NativeOriginInput;
		for (const q of [
			{ ...input.qualification, requestQualified: false },
			{ ...input.qualification, originIssuerQualified: false },
			{ ...input.qualification, sourceCommitted: false },
			{ ...input.qualification, currentRevision: 4 },
		]) {
			native.input = { ...input, qualification: q };
			expect(rolesNativeOriginRoot().state).not.toBe("accepted");
		}
		native.input = { ...input, envelope: { ...input.envelope, occurredAt: 999 } };
		expect(rolesNativeOriginRoot().state).toBe("rejected");
	});
});

describe("B02 whole index, unknown and prospective revision counts (V07/V14/S02)", () => {
	it("whole key/target/time required; duplicate replay idempotent; unknown excluded from both classes", () => {
		const p = queue();
		const r = admit();
		expect(rolesOriginCounts(p, TARGET, [r]).counts).toEqual({
			open: 1,
			own: 0,
			requested: 1,
			byOwner: 1,
			byRole: 0,
			unclassified: 0,
		});
		expect(rolesOriginCounts(p, TARGET, [r, r]).counts?.byOwner).toBe(1);
		expect(rolesOriginCounts(p, TARGET, [structuredClone(r)]).counts?.unclassified).toBe(1);
		for (const field of [
			"queueId",
			"sessionId",
			"sessionEpoch",
			"branchId",
			"homeRevision",
			"taskId",
			"planRevision",
		] as const) {
			const other = structuredClone(p);
			Object.assign(other.index[0].key, { [field]: typeof other.index[0].key[field] === "number" ? 2 : "other" });
			const out = rolesOriginCounts(other, TARGET, [r]);
			expect(out.counts?.byOwner ?? 0).toBe(0);
		}
		expect(rolesOriginCounts(p, R("role", "ops", "2"), [r]).counts?.unclassified).toBe(1);
		expect(rolesOriginCounts({ ...p, observedAt: 999 }, TARGET, [r]).counts?.unclassified).toBe(1);
		expect(rolesOriginCounts(p, TARGET, [admit(record("unclassified"))]).counts).toMatchObject({
			own: 0,
			requested: 0,
			unclassified: 1,
		});
		expect(rolesOriginCounts(p, TARGET, [r, admit(record("role-requested"))]).counts?.unclassified).toBe(1);
	});
	it("future revision cannot reclassify old plan or old work; gaps/counter mismatch never mean zero", () => {
		const old = admit(record("unclassified"));
		const later = structuredClone(record());
		Object.assign(later.context.key, { planRevision: 2 });
		Object.assign(later.context, { committedAt: 2000 });
		const newRoot = admit(later);
		expect(rolesOriginCounts(queue(), TARGET, [old, newRoot]).counts?.unclassified).toBe(1);
		const p = queue();
		Object.assign(p.index[0].key, { planRevision: 2 });
		expect(rolesOriginCounts({ ...p, observedAt: 1999 }, TARGET, [old, newRoot]).counts?.byOwner).toBe(0);
		expect(rolesOriginCounts(p, TARGET, [old, newRoot]).counts?.byOwner).toBe(1);
		for (const other of [
			{ ...p, queueCoverage: "partial" as const },
			{ ...p, index: [] },
			{ ...p, counts: null },
			{ ...p, index: [...p.index, ...p.index] },
		])
			expect(rolesOriginCounts(other, TARGET, [old, newRoot]).counts).toBeNull();
	});
	it("cross-repo fixed canonical index + immutable origins: both projections agree, >200 cap disclosed", () => {
		const module = process.env.R0_QUEUE_MODULE ?? resolve("../pi-queue/queue-origin.ts");
		expect(existsSync(module), "R0_QUEUE_MODULE must name the owned queue-origin.ts before pi-queue lands").toBe(true);
		const projectionModule = resolve(dirname(module), "queue-projection.ts");
		const script = `
			import { projectQueue } from ${JSON.stringify(pathToFileURL(projectionModule).href)};
			import { createOriginHistory, projectQueueOrigins } from ${JSON.stringify(pathToFileURL(module).href)};
			const b = ${JSON.stringify(binding)}, target = ${JSON.stringify(TARGET)}, owner = ${JSON.stringify(OWNER)};
			const ref = (kind,id)=>({namespace:'rtpi-fixture',kind,id,revision:'1'});
			const plan = {title:'fixed',goal:'g',doneWhen:'d',decided:'d',steps:'s',verify:'v',mustNot:'m'};
			const entries = Array.from({length:250},(_,i)=>({type:'custom',customType:'queue',data:{v:1,op:'add',id:i+1,plan,ts:900}}));
			entries.push({type:'custom',customType:'queue',data:{v:1,op:'done',id:249,summary:'fixed',ts:1000}},
				{type:'custom',customType:'queue',data:{v:1,op:'remove',id:250,ts:1000}});
			const p=projectQueue({binding:b,children:[],coverage:'complete',observedAt:2000,entries},b), h=createOriginHistory();
			for(const id of [1,2,3,249,250]) {
				const actor=id===2?target:id===3?ref('role','coo'):owner;
				const context={key:p.index.find(r=>r.key.taskId===id).key,target,operation:ref('operation','op-'+id),sourceRequest:ref('request','req-'+id),committedAt:1000};
				h.append(context,{requests:[{ref:context.sourceRequest,kind:id===2?'own-declaration':'request',actor,target,key:context.key,occurredAt:900,ownerPrincipal:actor.kind==='owner'?owner:null}],forwards:[]});
			}
			const {schema,binding,revision,observedAt,queueCoverage,counts,index}=p;
			console.log(JSON.stringify({queue:{schema,binding,revision,observedAt,queueCoverage,counts,index},shown:p.pending.length,
				records:h.snapshot(),counts:projectQueueOrigins(p,target,h.snapshot()).counts}));`;
		const data = JSON.parse(
			execFileSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8" }),
		) as { queue: RolesOriginQueue; shown: number; records: RolesOriginRecord[]; counts: unknown };
		expect(data.shown).toBe(200);
		expect(data.queue.index).toHaveLength(250);
		expect(
			rolesOriginCounts(
				data.queue,
				TARGET,
				data.records.map((r) => admit(r)),
			).counts,
		).toEqual(data.counts);
		expect(data.counts).toEqual({ open: 248, own: 1, requested: 2, byOwner: 1, byRole: 1, unclassified: 245 });
	});
});

describe("C10 explicit typed native policy only; holds and stops remain distinct", () => {
	it("no declaration reads Not recorded even when queue stopped/held or a budget stop exists", () => {
		const facts = { queueHold: true, budgetStop: true };
		expect(rolesOwnWorkDisplay(TARGET, facts)).toEqual({
			ownPolicy: { state: "not-recorded", label: "Not recorded", policy: null },
			...facts,
		});
		const old = { running: false, pausedReason: "owner", queueHold: false, budgetStop: false };
		expect(rolesOwnWorkDisplay(TARGET, old).ownPolicy.state).toBe("not-recorded");
		expect(rolesOwnWorkDisplay(TARGET, old)).not.toHaveProperty("running");
	});
	for (const ownWork of ["paused", "permitted"] as const)
		it(`${ownWork} requires an exact authenticated declaration; never releases hold or stop`, () => {
			const { declaration, approval } = policyFixture(ownWork);
			native.policy = { declaration, approval };
			expect(rolesOwnWorkDisplay(TARGET, { queueHold: true, budgetStop: true })).toMatchObject({
				ownPolicy: { state: ownWork },
				queueHold: true,
				budgetStop: true,
			});
		});
	it("copied/unqualified/read-only/ordinary open/plan approval or wrong typed declaration cannot supply policy", () => {
		const good = policyFixture();
		const cases: unknown[] = [
			{ declaration: good.declaration, approval: structuredClone(good.approval) },
			{ declaration: good.declaration, approval: rtpiStructural(good.root) },
			{ declaration: { ...good.declaration, ownWork: "permitted" }, approval: good.approval },
			{ declaration: { ...good.declaration, effectiveAt: 999 }, approval: good.approval },
			{ declaration: { ...good.declaration, target: R("role", "ops", "2") }, approval: good.approval },
			{ declaration: { ...good.declaration, owner: R("owner", "owner", "2") }, approval: good.approval },
			{ declaration: { ...good.declaration, action: R("operation", "other") }, approval: good.approval },
			{ declaration: { ...good.declaration, boardText: "pause own work" }, approval: good.approval },
			{ declaration: good.declaration, approval: policyFixture("paused", "owner-opened").approval },
			{
				declaration: good.declaration,
				approval: rtpiValidate(good.root, capability(), { ...good.q, ownerPrincipalAdmitted: false }),
			},
			{
				declaration: good.declaration,
				approval: rtpiValidate(good.root, capability(), { ...good.q, clientCurrent: false }),
			},
		];
		for (const bad of cases) {
			native.policy = bad;
			expect(rolesOwnWorkDisplay(TARGET, { queueHold: null, budgetStop: null }).ownPolicy.label).toBe("Not recorded");
		}
	});
	it("no production wiring, timers, writers, policy/approval affordances, environment override or scheduling imports", () => {
		for (const path of [
			"server/index.ts",
			"server/agent-service.ts",
			"server/roles-overview.ts",
			"server/roles-overview-tool.ts",
			"server/queue-host.ts",
		])
			expect(readFileSync(path, "utf8")).not.toMatch(/from\s+["'][^"']*roles-origin/);
		for (const path of ["server/roles-origin.ts", "server/roles-origin-native.ts"])
			expect(readFileSync(path, "utf8")).not.toMatch(
				/registerTool|appendFile|writeFile|setInterval|setTimeout|process\.env|from ["'][^"']*(?:task-queue|role-board|roles-spend)/,
			);
	});
});
