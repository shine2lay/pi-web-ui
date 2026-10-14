// #143 candidate4 H3 fixed synthetic stages; no app/private data/native operation or owner observation.
import { readFileSync, readdirSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	createRtpiFixtureCapability,
	rtpiCanonical,
	rtpiStructural,
	type RtpiAccepted,
	type RtpiCapability,
	type RtpiRef,
} from "../../server/rtpi-core.js";
import {
	G0_PROFILES,
	G0_REQUIRED,
	G0_STAGES,
	g0ArtifactRef,
	g0Issuer,
	type RolesArtifactIdentity,
	type RolesArtifactKind,
	type RolesGateBinding,
	type RolesLifecycleStage,
	type RolesProducerContext,
} from "../../server/roles-artifact.js";
import {
	rolesArtifactConfirmation,
	rolesArtifactCoverage,
	rolesArtifactLifecycle,
	rolesCurrentConfirmationSnapshot,
	rolesRequiredGateContract,
	type RolesGateResult,
} from "../../server/roles-gates.js";
import {
	createOwnerChallengeHandler,
	type OwnerActionReceipt,
	type OwnerActionTarget,
	type OwnerHostConnection,
} from "../../server/roles-owner-challenge.js";
import type {
	NativeGateConfirmationSource,
	NativeGateIndexEntry,
	NativeGateOperation,
	NativeGateReceipt,
	NativeGateState,
	NativeGateStream,
} from "../../server/roles-gates-native.js";

const native = vi.hoisted(() => ({
	state: null as NativeGateState | null,
	life: null as RtpiCapability | null,
	check: null as RtpiCapability | null,
	contact: null as RtpiCapability | null,
	confirmation: null as NativeGateConfirmationSource | null,
	operations: {} as Partial<Record<RolesLifecycleStage, NativeGateOperation>>,
	admit: false,
	wall: 1000,
	mono: 100,
}));
vi.mock("../../server/roles-gates-native.js", () => ({
	nativeGateState: () => native.state,
	nativeGateCapability: (stage?: RolesLifecycleStage) => (stage === "checked" ? native.check : native.life),
	nativeGateObservation: (stage: RolesLifecycleStage) => native.operations[stage] ?? null,
	nativeGateConfirmationSource: () => native.confirmation,
}));
vi.mock("../../server/roles-owner-native.js", async (importOriginal) => {
	const real = await importOriginal<typeof import("../../server/roles-owner-native.js")>();
	return {
		...real,
		nativeContactCapability: () => native.contact,
		admitNativeOwnerPrincipal: (c: OwnerHostConnection) =>
			native.admit
				? {
						admitted: true,
						principal: { namespace: "rtpi-fixture", kind: "owner", id: "fixture-owner", revision: "1" },
					}
				: real.admitNativeOwnerPrincipal(c),
		serverWallNow: () => native.wall,
		serverMonotonicNow: () => native.mono,
	};
});
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;
const ref = (kind: string, id: string, revision = "1"): RtpiRef => ({ namespace: "rtpi-fixture", kind, id, revision });
const producer = (id: string, task = false): RolesProducerContext => ({
	queue: task ? ref("queue", "Q1") : null,
	taskId: task ? 143 : null,
	planRevision: task ? 3 : null,
	run: ref("run", id),
	attempt: ref("attempt", id + "-a1"),
});
const conn: OwnerHostConnection = {
	scope: "owner-client",
	channel: "browser",
	principalBasis: "t03-native",
	pseudoClient: false,
	session: ref("session", "s1"),
	window: ref("window", "w1"),
	client: { id: "c1", incarnation: "inc1", build: "fixture-build" },
};
const cap = (source: RtpiRef, issuer: RtpiRef) =>
	createRtpiFixtureCapability({
		source,
		issuer,
		subject: ref("subject", "role-ops"),
		roots: ["rtpi/event/1", "rtpi/gate-contract/1"],
		facts: ["gate-observed", "artifact-confirmed"],
		policyAccepted: true,
		acceptedSidecars: [],
		seams: { atomicOutbox: true, issuerRegistry: true, ownerPrincipal: true, inputHook: false, confinedReader: false },
	});
const accepted = (r: RolesGateResult): RtpiAccepted => {
	if (r.verdict?.status !== "accepted") throw new Error(r.reason);
	return r.verdict;
};

function fixture(kind: RolesArtifactKind = "pi-web-ui") {
	const identity: RolesArtifactIdentity = {
		kind,
		artifact: {
			gitHead: "a".repeat(40),
			assetsSha256: "b".repeat(64),
			version: "1.0.1",
			manifestRevision: 2,
			targetEnvironment: "fixture-only",
			environmentEpoch: "e1",
		},
		contract: ref("contract", "g0-" + kind, "2"),
	};
	const subject = producer("task-own", true);
	const binding = { ...identity, ...subject } as RolesGateBinding;
	const streams: NativeGateStream[] = [
		{
			source: ref("source", "lifecycle"),
			issuer: g0Issuer(kind, "rtpi-fixture"),
			lineage: ref("lineage", "life1"),
			incarnation: "inc1",
			sequence: 0,
			revision: 0,
		},
		{
			source: ref("source", "check"),
			issuer: g0Issuer(kind, "rtpi-fixture", "checked"),
			lineage: ref("lineage", "check1"),
			incarnation: "inc1",
			sequence: 0,
			revision: 0,
		},
		{
			source: ref("source", "owner-client"),
			issuer: g0Issuer(kind, "rtpi-fixture", "owner-confirmed"),
			lineage: ref("lineage", "owner1"),
			incarnation: "inc1",
			sequence: 0,
			revision: 0,
		},
	];
	const entries: NativeGateIndexEntry[] = [];
	const contract = {
		schema: "rtpi/gate-contract/1",
		objectId: identity.contract.id,
		source: streams[0].source,
		issuer: streams[0].issuer,
		subject: ref("subject", "role-ops"),
		revision: 2,
		domain: "roles",
		acceptedBy: streams[0].issuer,
		required: clone(G0_REQUIRED),
		artifact: identity.artifact,
	};
	const s: NativeGateState = {
		binding: identity,
		contract,
		qualification: { sourceCommitted: true, gateContractAccepted: true, rolesGateIssuer: streams[0].issuer },
		index: { complete: true, streams, entries },
		currentTask: subject,
		taskLink: null,
		latestInstall: null,
		projection: ref("projection", "p1"),
		coverage: ref("coverage", "cov1"),
		policy: ref("policy", "g0-confirm"),
	};
	native.state = s;
	native.life = cap(streams[0].source, streams[0].issuer);
	native.check = cap(streams[1].source, streams[1].issuer);
	native.contact = cap(streams[2].source, streams[2].issuer);
	function index(
		receipt: NativeGateReceipt,
		stage: RolesLifecycleStage | "owner-confirmed",
		key = identity,
		installReceipt: RtpiRef | null = null,
	) {
		const v = rtpiStructural(receipt.root);
		if (v.status !== "accepted") throw new Error(v.reason);
		const r = v.root;
		entries.push({
			kind,
			artifact: g0ArtifactRef(key.artifact, "rtpi-fixture"),
			contract: key.contract,
			targetEnvironment: key.artifact.targetEnvironment,
			stage,
			reference: receipt.reference,
			source: r.source as unknown as RtpiRef,
			issuer: r.issuer as unknown as RtpiRef,
			lineage: r.lineage as unknown as RtpiRef,
			incarnation: r.incarnation as string,
			sequence: r.sequence as number,
			revision: r.revision as number,
			digest: v.digest,
			producer: receipt.producer,
			installReceipt,
		});
	}
	function op(
		stage: RolesLifecycleStage,
		p = producer(stage),
		result = "pass",
		key = identity,
		installReceipt: RtpiRef | null = null,
		at = 1000,
	): NativeGateOperation {
		const st = streams[stage === "checked" ? 1 : 0];
		const seq = st.sequence + 1;
		Object.assign(st, { sequence: seq, revision: seq });
		const context = {
			...p,
			session: null,
			epoch: null,
			turn: null,
			recipient: null,
			channel: "unknown",
			action: null,
			artifact: g0ArtifactRef(key.artifact, "rtpi-fixture"),
			owner: null,
			client: null,
			window: null,
			projection: null,
			coverage: null,
			policy: null,
			challenge: null,
		};
		const root = {
			schema: "rtpi/event/1",
			eventId: stage + "-" + st.lineage.id + "-" + seq,
			source: st.source,
			issuer: st.issuer,
			subject: ref("subject", "role-ops"),
			lineage: st.lineage,
			incarnation: st.incarnation,
			sequence: seq,
			revision: seq,
			expectedRevision: seq - 1,
			occurredAt: at,
			context,
			body: {
				fact: "gate-observed",
				stage,
				result,
				contract: key.contract,
				refs: installReceipt === null ? [] : [installReceipt],
			},
		};
		const receipt: NativeGateReceipt = {
			root,
			reference: ref("receipt", root.eventId, String(seq)),
			producer: p,
			qualification: {
				lineage: st.lineage,
				incarnation: st.incarnation,
				currentRevision: seq - 1,
				currentSequence: seq - 1,
				sourceCommitted: true,
				serverNow: at,
				gateContractAccepted: true,
				independentVerifier: stage === "checked",
				currentArtifact: context.artifact,
			},
		};
		index(receipt, stage, key, installReceipt);
		return {
			receipt,
			measurement: {
				schema: "roles/g0-observation/1",
				identity: clone(key),
				producer: clone(p),
				stage,
				result,
				profile: G0_PROFILES[kind][stage],
				mode: "measurement",
				observedArtifact: clone(key.artifact),
				installReceipt,
			},
		};
	}
	const link = op("built", subject);
	Object.assign(s, { taskLink: { binding, resolutions: [identity], receipt: link.receipt } });
	native.operations.built = op("built");
	native.operations.checked = op("checked", {
		...producer("independent-check", true),
		taskId: 77,
		planRevision: 4,
		queue: ref("queue", "check-queue"),
	});
	const installed = op("installed");
	native.operations.installed = installed;
	Object.assign(s, { latestInstall: { identity, operation: "install", operationReceipt: installed } });
	native.operations.live = op("live", producer("waiter"), "pass", identity, installed.receipt.reference);
	return { s, identity, binding, streams, entries, op, index };
}
const observations = () => G0_STAGES.map((stage) => accepted(rolesArtifactLifecycle[stage]({ enabled: true })));
function target(): OwnerActionTarget {
	const snapshot = rolesCurrentConfirmationSnapshot();
	if (snapshot === null) throw new Error("fixture-current-four-roots-missing");
	return {
		action: "confirm",
		gateBinding: snapshot.binding,
		gateSnapshot: snapshot,
		artifact: g0ArtifactRef(snapshot.binding.artifact, "rtpi-fixture"),
		projection: snapshot.projection,
		coverage: snapshot.coverage,
		policy: snapshot.policy,
	};
}
const handler = () => createOwnerChallengeHandler({ currentBuild: "fixture-build", currentIncarnation: () => "inc1" });
function challenged(): OwnerActionReceipt {
	native.admit = true;
	const h = handler();
	const t = target();
	const i = h.issue(conn, t);
	if (i.status !== "issued") throw new Error(i.reason);
	const a = h.answer(conn, t, { challengeId: i.challengeId, value: i.value });
	if (a.status !== "accepted") throw new Error(a.reason);
	return a.receipt;
}
function confirmed(f: ReturnType<typeof fixture>, action = challenged()) {
	const st = f.streams[2];
	const seq = st.sequence + 1;
	Object.assign(st, { sequence: seq, revision: seq });
	const envelope = {
		eventId: "owner-" + seq,
		source: st.source,
		issuer: st.issuer,
		subject: ref("subject", "role-ops"),
		lineage: st.lineage,
		incarnation: st.incarnation,
		sequence: seq,
		revision: seq,
		expectedRevision: seq - 1,
		occurredAt: action.serverNow,
	};
	const context = {
		...producer("unused"),
		queue: action.gateBinding?.queue,
		taskId: action.gateBinding?.taskId,
		planRevision: action.gateBinding?.planRevision,
		session: action.session,
		epoch: null,
		turn: null,
		run: action.gateBinding?.run,
		attempt: action.gateBinding?.attempt,
		recipient: null,
		channel: "browser",
		action: { ...action.challenge, kind: "operation", id: "confirm:" + action.challenge.id },
		artifact: action.artifact,
		owner: action.principal,
		client: action.client,
		window: action.window,
		projection: action.projection,
		coverage: action.coverage,
		policy: action.policy,
		challenge: action.challenge,
	};
	const receiptRef = ref("receipt", "confirm-" + seq);
	const root = {
		schema: "rtpi/event/1",
		...envelope,
		context,
		body: {
			fact: "artifact-confirmed",
			status: "known",
			receipt: receiptRef,
			clientRole: "owner",
			issuedAt: action.issuedAt,
			expiresAt: action.expiresAt,
			serverNow: action.serverNow,
			mode: "new",
			refs: action.gateSnapshot?.gates.map((g) => g.receipt),
		},
	};
	const qualification = {
		lineage: st.lineage,
		incarnation: st.incarnation,
		currentRevision: seq - 1,
		currentSequence: seq - 1,
		sourceCommitted: true,
		serverNow: action.serverNow,
		clientCurrent: true,
		currentArtifact: action.artifact,
		currentProjection: action.projection,
		currentCoverage: action.coverage,
	};
	native.confirmation = { envelope, root, qualification };
	f.index(
		{
			root,
			reference: ref("receipt", envelope.eventId, String(seq)),
			producer: {
				queue: f.binding.queue,
				taskId: f.binding.taskId,
				planRevision: f.binding.planRevision,
				run: f.binding.run,
				attempt: f.binding.attempt,
			},
			qualification,
		},
		"owner-confirmed",
	);
	return accepted(rolesArtifactConfirmation(action, receiptRef, { enabled: true }));
}
function all(kind: RolesArtifactKind = "pi-web-ui") {
	const f = fixture(kind);
	const contract = accepted(rolesRequiredGateContract({ enabled: true }));
	const gates = observations();
	const confirm = confirmed(f);
	return { ...f, contract, gates, confirm };
}
beforeEach(() => {
	native.state = null;
	native.life = null;
	native.check = null;
	native.contact = null;
	native.confirmation = null;
	native.operations = {};
	native.admit = false;
	native.wall = 1000;
	native.mono = 100;
});

describe("G0 S03 disabled, no native seam/flag upgrade", () => {
	it("TS shares the 235-byte MJS/Python pinned artifact join", () => {
		const f = fixture();
		const key = { ...f.identity.artifact, environmentEpoch: "e-1" };
		expect(Buffer.byteLength(rtpiCanonical(key))).toBe(235);
		expect(g0ArtifactRef(key, "rtpi-fixture").id).toBe(
			"ak-7765dc8016f16ee64cd2e9ee94f4ed273575252af7eeb4a9c749207d901b8302",
		);
		expect(g0ArtifactRef({ ...key, assetsSha256: "c".repeat(64) }, "rtpi-fixture").id).not.toBe(
			g0ArtifactRef(key, "rtpi-fixture").id,
		);
		for (const version of ["1.0.1+build.7", "v\n", "v\r", "v\r\n", "/tmp/v", ""])
			expect(() => g0ArtifactRef({ ...key, version }, "rtpi-fixture")).toThrow("artifact-version-unsupported");
	});
	it("default off, forced enable stays unavailable; supplied capabilities/state/flags cannot substitute", () => {
		for (const fn of [rolesRequiredGateContract, ...G0_STAGES.map((s) => rolesArtifactLifecycle[s])]) {
			expect(fn().state).toBe("off");
			expect(fn({ enabled: true, state: {}, capability: {}, fixture: true } as never)).toMatchObject({
				state: "unavailable",
				native: false,
				verdict: null,
			});
		}
	});
	it.each(["pi-web-ui", "agent-tools"] as const)("%s has fixed profiles and distinct whole check issuer", (kind) => {
		const r = all(kind);
		const c = rolesArtifactCoverage(r.contract, r.gates, [r.confirm]);
		expect(c).toMatchObject({
			state: "complete",
			synthetic: true,
			nativeLifecycle: false,
			ownerConfirmed: false,
			scope: "task",
			liveMeasuredAt: 1000,
		});
		expect(r.gates[1].root.issuer).toEqual(g0Issuer(kind, "rtpi-fixture", "checked"));
		expect(r.gates[0].root.issuer).toEqual(g0Issuer(kind, "rtpi-fixture"));
	});
	it("artifact-only scope may show gate history, never task confirm/done", () => {
		const f = fixture();
		Object.assign(f.s, { currentTask: null, taskLink: null });
		const c = rolesArtifactCoverage(accepted(rolesRequiredGateContract({ enabled: true })), observations(), []);
		expect(c.scope).toBe("artifact");
		expect(c.state).toBe("incomplete");
		expect(rolesCurrentConfirmationSnapshot()).toBeNull();
	});
	it("unknown kind is not generic", () => {
		const f = fixture();
		Object.assign(f.identity, { kind: "generic" });
		expect(rolesRequiredGateContract({ enabled: true }).state).toBe("rejected");
	});
	it("native lifecycle getter cannot masquerade as client confirmation", () => {
		const f = fixture();
		const a = challenged();
		native.confirmation = null;
		expect(rolesArtifactConfirmation(a, ref("receipt", "x"), { enabled: true }).reason).toBe(
			"client-native-confirmation-source-missing",
		);
		expect(f.s.latestInstall).not.toBeNull();
	});
});

describe("G0 V08/V15/V18 contract and measured exact artifacts", () => {
	it.each(["acceptedBy", "issuer", "revision", "objectId", "artifact", "required"])("rejects changed %s", (field) => {
		const f = fixture();
		const c = f.s.contract as Record<string, unknown>;
		c[field] =
			field === "required"
				? []
				: field === "artifact"
					? { ...f.identity.artifact, assetsSha256: "c".repeat(64) }
					: field === "revision"
						? 3
						: field === "objectId"
							? "other"
							: ref("issuer", "other");
		expect(rolesRequiredGateContract({ enabled: true }).state).toBe("rejected");
	});
	it.each([
		{ title: "empty", required: [], reason: "required-contract-invalid" },
		{
			title: "all-NA",
			required: [{ stage: "built", applicable: false, independent: false, dependsOn: [] }],
			reason: "required-contract-invalid",
		},
		{
			title: "optional-only",
			required: [{ stage: "built", applicable: true, independent: false, dependsOn: [], optional: true }],
			reason: "required-contract-invalid",
		},
	])("rejects $title required set", ({ required, reason }) => {
		const f = fixture();
		(f.s.contract as Record<string, unknown>).required = required;
		expect(rolesRequiredGateContract({ enabled: true })).toMatchObject({ state: "rejected", native: false, reason });
	});
	it.each(["gitHead", "assetsSha256", "version", "manifestRevision", "targetEnvironment", "environmentEpoch"])(
		"measured %s mismatch cannot qualify",
		(key) => {
			fixture();
			const m = native.operations.live?.measurement as Record<string, unknown>;
			const a = m.observedArtifact as Record<string, unknown>;
			a[key] = key === "manifestRevision" ? 99 : "different";
			expect(rolesArtifactLifecycle.live({ enabled: true }).reason).toBe("measured-artifact-mismatch");
		},
	);
	it.each(["dry-run", "http-200", "queue-done", "prose", "na", "generic"])("%s is not measurement", (mode) => {
		fixture();
		(native.operations.live?.measurement as Record<string, unknown>).mode = mode;
		expect(rolesArtifactLifecycle.live({ enabled: true }).reason).toBe("not-a-measurement");
	});
	it("NA never passes a required applicable stage", () => {
		const f = fixture();
		native.operations.checked = f.op("checked", producer("check-na"), "not-applicable");
		const c = rolesArtifactCoverage(accepted(rolesRequiredGateContract({ enabled: true })), observations(), []);
		expect(c.stages.checked).toBe("missing");
		expect(c.state).toBe("incomplete");
	});
	it("empty input / cloned verdict never qualifies current stage", () => {
		const f = all();
		expect(rolesArtifactCoverage(f.contract, [], [f.confirm]).state).not.toBe("complete");
		expect(rolesArtifactCoverage(clone(f.contract), f.gates, [f.confirm]).state).toBe("unknown");
		expect(rolesArtifactCoverage(f.contract, f.gates.map(clone), [f.confirm]).state).not.toBe("complete");
	});
	it.each(["sourceCommitted", "gateContractAccepted", "independentVerifier"])(
		"a missing native %s is not made true by the consumer",
		(flag) => {
			fixture();
			Object.assign(native.operations.checked?.receipt.qualification as object, { [flag]: false });
			expect(rolesArtifactLifecycle.checked({ enabled: true }).state).not.toBe("validated");
		},
	);
});

describe("H3 known bads / preserved guards, CAS-current selection", () => {
	it("H3-01 rollback to B retires A install/live/confirm, not prior build/check", () => {
		const f = all();
		const b = {
			...f.identity,
			artifact: { ...f.identity.artifact, gitHead: "c".repeat(40) },
			contract: ref("contract", "B", "2"),
		};
		const p = f.op("installed", producer("rollback"), "pass", b, null, 2000);
		Object.assign(f.s, { latestInstall: { identity: b, operation: "rollback", operationReceipt: p } });
		const c = rolesArtifactCoverage(f.contract, f.gates, [f.confirm]);
		expect(c.stages.built).toBe("pass");
		expect(c.stages.installed).toBe("unknown");
		expect(c.stages.live).toBe("unknown");
		expect(c.ownerConfirmed).toBe(false);
		expect(c.state).not.toBe("complete");
		expect(c.history.some((h) => h.stage === "live" && h.observedAt === 2000)).toBe(true);
	});
	it("H3-02 fail after pass wins by CAS; old pass preference and list order do not", () => {
		const f = all();
		native.operations.checked = f.op("checked", producer("check-fail"), "fail", f.identity, null, 1);
		const fail = accepted(rolesArtifactLifecycle.checked({ enabled: true }));
		for (const list of [[...f.gates, fail], [fail, ...f.gates].reverse()])
			expect(rolesArtifactCoverage(f.contract, list, [f.confirm])).toMatchObject({
				state: "failed",
				stages: { checked: "fail" },
			});
	});
	it("H3-03 latest passing retry replaces earlier failure without borrowing its producer", () => {
		const f = all();
		native.operations.checked = f.op("checked", producer("check-fail"), "fail");
		const failed = accepted(rolesArtifactLifecycle.checked({ enabled: true }));
		const retry = { ...producer("check-retry"), attempt: ref("attempt", "retry2") };
		native.operations.checked = f.op("checked", retry, "pass", f.identity, null, 1);
		const passed = accepted(rolesArtifactLifecycle.checked({ enabled: true }));
		const c = rolesArtifactCoverage(f.contract, [failed, ...f.gates, passed], [f.confirm]);
		expect(c.stages.checked).toBe("pass");
		expect(passed.root.context).toMatchObject(retry);
		expect(c.stages["owner-confirmed"]).toBe("unknown");
		expect(c.state).not.toBe("complete");
	});
	it("H3-04 batched containing head is installed UNKNOWN; no ancestry/partial match", () => {
		const f = all();
		const b = { ...f.identity, artifact: { ...f.identity.artifact, gitHead: "d".repeat(40) } };
		const p = f.op("installed", producer("batched"), "pass", b);
		Object.assign(f.s, { latestInstall: { identity: b, operation: "install", operationReceipt: p } });
		const c = rolesArtifactCoverage(f.contract, f.gates, [f.confirm]);
		expect(c.stages.installed).toBe("unknown");
		expect(c.state).not.toBe("complete");
	});
	it("H3-05 borrowed producer triplet is refused, genuinely non-task waiter remains all-null", () => {
		const f = fixture();
		const wait = accepted(rolesArtifactLifecycle.live({ enabled: true }));
		expect(wait.root.context).toMatchObject({
			queue: null,
			taskId: null,
			planRevision: null,
			run: ref("run", "waiter"),
		});
		Object.assign(native.operations.live?.receipt as object, { producer: f.s.currentTask });
		expect(rolesArtifactLifecycle.live({ enabled: true }).reason).toBe("borrowed-native-producer-context");
	});
	it("H3-06 same task number in Q2 cannot reuse Q1 linkage or confirm", () => {
		const f = all();
		Object.assign(f.s, { currentTask: { ...f.s.currentTask, queue: ref("queue", "Q2") } });
		expect(rolesArtifactCoverage(f.contract, f.gates, [f.confirm]).reason).toBe("native-exact-task-link-unavailable");
		expect(rolesCurrentConfirmationSnapshot()).toBeNull();
	});
	it("H3-07 no current live before issue; a changed root before answer consumes pending binding", () => {
		const f = fixture();
		const h = handler();
		native.admit = true;
		const t = target();
		const i = h.issue(conn, t);
		if (i.status !== "issued") throw new Error(i.reason);
		native.operations.checked = f.op("checked", producer("later-fail"), "fail");
		expect(h.answer(conn, t, { challengeId: i.challengeId, value: i.value }).status).not.toBe("accepted");
		expect(h.pendingCount).toBe(0);
		expect(h.issue(conn, t)).toMatchObject({ status: "unknown", reason: "confirm-current-passing-roots-required" });
	});
	it("H3-08 '+' version gives explicit unsupported reason, never normalized", () => {
		const f = fixture();
		Object.assign(f.identity.artifact, { version: "1.0.1+build.7" });
		expect(rolesRequiredGateContract({ enabled: true }).reason).toBe("artifact-version-unsupported");
	});
	it("H3-09 build/check/install/delayed waiter retain their OWN run/attempt", () => {
		const f = all();
		const runs = f.gates.map((v) => (v.root.context as Record<string, unknown>).run);
		expect(new Set(runs.map((r) => JSON.stringify(r))).size).toBe(4);
		expect(runs).not.toContainEqual(f.binding.run);
		expect(rolesArtifactCoverage(f.contract, f.gates, [f.confirm]).state).toBe("complete");
	});
	it("H3-10 lifecycle issuer plus independent boolean cannot assert checked", () => {
		fixture();
		const op = native.operations.checked as NativeGateOperation;
		(op.receipt.root as Record<string, unknown>).issuer = g0Issuer("pi-web-ui", "rtpi-fixture");
		expect(rolesArtifactLifecycle.checked({ enabled: true }).reason).toBe("fixed-stage-issuer-required");
		(op.measurement as Record<string, unknown>).independent = true;
		expect(rolesArtifactLifecycle.checked({ enabled: true }).reason).toBe("gate-measurement-closed-schema");
	});
	it("H3-11 reinstall SAME key with new receipt requires fresh live AND confirm", () => {
		const f = all();
		const p = f.op("installed", producer("same-key-reinstall"), "pass", f.identity, null, 1);
		native.operations.installed = p;
		Object.assign(f.s, { latestInstall: { identity: f.identity, operation: "rollback", operationReceipt: p } });
		const install = accepted(rolesArtifactLifecycle.installed({ enabled: true }));
		let c = rolesArtifactCoverage(f.contract, [...f.gates, install], [f.confirm]);
		expect(c.stages.live).toBe("unknown");
		expect(c.state).not.toBe("complete");
		native.operations.live = f.op("live", producer("new-waiter"), "pass", f.identity, p.receipt.reference, 1);
		const live = accepted(rolesArtifactLifecycle.live({ enabled: true }));
		c = rolesArtifactCoverage(f.contract, [...f.gates, install, live], [f.confirm]);
		expect(c.stages.live).toBe("pass");
		expect(c.stages["owner-confirmed"]).toBe("unknown");
		const fresh = confirmed(f);
		expect(rolesArtifactCoverage(f.contract, [...f.gates, install, live], [f.confirm, fresh]).state).toBe("complete");
	});
	it("H3-12 a new lineage is current by native pointer, not newer-looking wall clock", () => {
		const f = all();
		Object.assign(f.streams[0], { lineage: ref("lineage", "life2"), incarnation: "inc2", sequence: 0, revision: 0 });
		const p = f.op("installed", producer("restored-head"), "pass", f.identity, null, 1);
		native.operations.installed = p;
		Object.assign(f.s, {
			currentTask: null,
			taskLink: null,
			latestInstall: { identity: f.identity, operation: "rollback", operationReceipt: p },
		});
		const install = accepted(rolesArtifactLifecycle.installed({ enabled: true }));
		const c = rolesArtifactCoverage(f.contract, [...f.gates, install], [f.confirm]);
		expect(c.stages.installed, c.reason).toBe("pass");
		expect(c.stages.built).toBe("missing");
		expect(c.stages.live).toBe("unknown");
		expect(c.state).not.toBe("complete");
	});
	it.each(["assetsSha256", "version", "manifestRevision", "targetEnvironment", "environmentEpoch"])(
		"H3-13 same HEAD/different %s cannot be guessed from link",
		(field) => {
			const f = fixture();
			const b = {
				...f.identity,
				artifact: {
					...f.identity.artifact,
					[field]: field === "assetsSha256" ? "c".repeat(64) : field === "manifestRevision" ? 3 : "other",
				},
			};
			Object.assign(f.s.taskLink as object, { resolutions: [b] });
			expect(rolesCurrentConfirmationSnapshot()).toBeNull();
		},
	);
	it("H3-13 ambiguous/missing FULL association unknown, exact full ref selects among same HEAD", () => {
		const f = fixture();
		Object.assign(f.s.taskLink as object, { resolutions: [f.identity, clone(f.identity)] });
		expect(rolesCurrentConfirmationSnapshot()).toBeNull();
		Object.assign(f.s.taskLink as object, { resolutions: [] });
		expect(rolesCurrentConfirmationSnapshot()).toBeNull();
		Object.assign(f.s.taskLink as object, {
			resolutions: [f.identity, { ...f.identity, artifact: { ...f.identity.artifact, assetsSha256: "c".repeat(64) } }],
		});
		expect(rolesCurrentConfirmationSnapshot()).not.toBeNull();
	});
	it.each(["queue", "taskId", "planRevision"])("H3-14 partial non-task %s refused", (field) => {
		fixture();
		Object.assign(native.operations.live?.receipt.producer as object, {
			[field]: field === "queue" ? ref("queue", "Q1") : 143,
		});
		expect(rolesArtifactLifecycle.live({ enabled: true }).reason).toBe("canonical-producer-invalid");
	});
	it.each(["planRevision", "run", "attempt", "taskId", "queue"])(
		"H3-14 superseded task %s invalidates link and confirmation",
		(field) => {
			const f = all();
			Object.assign(f.s.currentTask as object, {
				[field]: field === "planRevision" ? 4 : field === "taskId" ? 144 : ref(field, "superseded"),
			});
			expect(rolesArtifactCoverage(f.contract, f.gates, [f.confirm]).state).toBe("unknown");
		},
	);
	it("H3-14 changing task's own link receipt alone invalidates old confirmation", () => {
		const f = all();
		const p = f.op("built", f.s.currentTask as RolesProducerContext);
		Object.assign(f.s.taskLink as object, { receipt: p.receipt });
		native.operations.built = p;
		const built = accepted(rolesArtifactLifecycle.built({ enabled: true }));
		expect(rolesArtifactCoverage(f.contract, [...f.gates, built], [f.confirm]).stages["owner-confirmed"]).toBe(
			"unknown",
		);
	});
	it("H3-15 incomplete/conflicting source state refuses green, never ranks across lineages", () => {
		const f = all();
		Object.assign(f.s.index as object, { complete: false });
		expect(rolesArtifactCoverage(f.contract, f.gates, [f.confirm]).reason).toBe("gate-index-incomplete");
		Object.assign(f.s.index as object, { complete: true });
		f.entries.push({ ...f.entries[1], digest: "c".repeat(64) });
		expect(rolesArtifactCoverage(f.contract, f.gates, [f.confirm]).reason).toBe("gate-index-conflict");
	});
	it("H3-15 extra index keys, oversized index and path refs refused", () => {
		const f = all();
		Object.assign(f.s.index as object, { sidecarPath: "/tmp/forge" });
		expect(rolesArtifactCoverage(f.contract, f.gates, [f.confirm]).state).toBe("unknown");
		delete (f.s.index as unknown as Record<string, unknown>).sidecarPath;
		f.entries[0] = { ...f.entries[0], reference: ref("receipt", "/tmp/forge") };
		expect(rolesArtifactCoverage(f.contract, f.gates, [f.confirm]).reason).toBe("gate-index-invalid");
		f.entries.length = 201;
		expect(rolesArtifactCoverage(f.contract, f.gates, [f.confirm]).reason).toBe("gate-index-overflow");
	});
	it.each(["source", "lineage", "subject"])(
		"H3-15 full-string R07 canonical %s rejects final LF before qualification",
		(field) => {
			fixture();
			const root = native.operations.built?.receipt.root as Record<string, unknown>;
			const r = root[field] as RtpiRef;
			root[field] = { ...r, id: r.id + "\n" };
			expect(rolesArtifactLifecycle.built({ enabled: true }).state).toBe("rejected");
		},
	);
	it("current index receipt not supplied/qualified is UNKNOWN, not old pass", () => {
		const f = all();
		native.operations.checked = f.op("checked", producer("unsupplied-fail"), "fail");
		expect(rolesArtifactCoverage(f.contract, f.gates, [f.confirm]).stages.checked).toBe("unknown");
	});
});

describe("G0 F14 explicit authenticated, current-gates owner action only", () => {
	it("ordinary adapters expose no confirm method", () =>
		expect(Object.keys(rolesArtifactLifecycle)).toEqual([...G0_STAGES]));
	it("no T03 means no owner challenge or confirmation", () => {
		fixture();
		expect(handler().issue(conn, target())).toMatchObject({
			status: "unknown",
			reason: "owner-principal-not-admitted",
		});
	});
	it.each(["render", "open"] as const)("%s receipt never confirms", (action) => {
		fixture();
		native.admit = true;
		const t = target();
		const { gateBinding: _b, gateSnapshot: _s, ...plain } = t;
		const h = handler();
		const i = h.issue(conn, { ...plain, action });
		if (i.status !== "issued") throw new Error(i.reason);
		const a = h.answer(conn, { ...plain, action }, { challengeId: i.challengeId, value: i.value });
		if (a.status !== "accepted") throw new Error(a.reason);
		expect(rolesArtifactConfirmation(a.receipt, ref("receipt", "x"), { enabled: true }).reason).toBe(
			"explicit-handler-confirm-required",
		);
	});
	it("handmade/cloned action and non-client issuer/atomic-root cannot confirm", () => {
		const f = fixture();
		const a = challenged();
		const v = confirmed(f, a);
		expect(v.namespace).toBe("rtpi-fixture");
		expect(rolesArtifactConfirmation(clone(a), ref("receipt", "confirm-1"), { enabled: true }).reason).toBe(
			"explicit-handler-confirm-required",
		);
		Object.assign(native.confirmation?.envelope as object, { issuer: g0Issuer("pi-web-ui", "rtpi-fixture") });
		expect(rolesArtifactConfirmation(a, ref("receipt", "confirm-1"), { enabled: true }).reason).toBe(
			"client-native-confirmation-issuer-required",
		);
	});
	it("own client canonical sourceCommitted is required, not lifecycle true", () => {
		const f = fixture();
		const a = challenged();
		confirmed(f, a);
		Object.assign(native.confirmation?.qualification as object, { sourceCommitted: false });
		expect(rolesArtifactConfirmation(a, ref("receipt", "confirm-1"), { enabled: true }).state).toBe("unknown");
	});
	it("payload extras refused; observers cannot invalidate owner's pending id", () => {
		fixture();
		native.admit = true;
		const h = handler();
		const t = target();
		const i = h.issue(conn, t);
		if (i.status !== "issued") throw new Error(i.reason);
		expect(h.answer({ ...conn, scope: "observer" }, t, { challengeId: i.challengeId, value: i.value }).status).toBe(
			"rejected",
		);
		expect(h.pendingCount).toBe(1);
		expect(h.answer(conn, t, { challengeId: i.challengeId, value: i.value, verified: true } as never)).toMatchObject({
			status: "rejected",
			reason: "confirm-answer-closed-schema",
		});
	});
	it("projection/coverage/contract/install/current root change after action defeats later read", () => {
		const f = all();
		Object.assign(f.s, { coverage: ref("coverage", "cov2") });
		expect(rolesArtifactCoverage(f.contract, f.gates, [f.confirm]).stages["owner-confirmed"]).toBe("unknown");
	});
	it("snapshot immutable; exact issuer/ref revision matters, no token trimming", () => {
		fixture();
		const a = challenged();
		expect(Object.isFrozen(a.gateSnapshot?.gates)).toBe(true);
		expect(Object.isFrozen(a.gateBinding?.queue)).toBe(true);
		const t = target();
		native.admit = true;
		expect(
			handler().issue(conn, {
				...t,
				gateSnapshot: { ...t.gateSnapshot, installReceipt: ref("receipt", "wrong", "2") },
			} as never).status,
		).toBe("rejected");
	});
});

it("S03/S08 no first production importer, registry, instance, timer, env fixture enable or wire/schema edits", () => {
	const component = new Set([
		"roles-artifact.ts",
		"roles-gates.ts",
		"roles-gates-native.ts",
		"roles-owner-challenge.ts",
		"roles-owner-native.ts",
		"roles-contact.ts",
	]);
	const importers: string[] = [];
	function walk(dir: string) {
		for (const e of readdirSync(dir, { withFileTypes: true })) {
			const p = `${dir}/${e.name}`;
			if (e.isDirectory()) walk(p);
			else if (e.name.endsWith(".ts")) {
				const t = readFileSync(p, "utf8");
				if (
					!component.has(e.name) &&
					/(?:from|import\s*\()\s*["'][^"']*roles-(?:artifact|gates(?:-native)?|owner-challenge|owner-native|contact)\.js["']/.test(
						t,
					)
				)
					importers.push(p);
			}
		}
	}
	walk("server");
	expect(importers).toEqual([]);
	for (const name of ["roles-gates-native.ts"]) {
		const text = readFileSync("server/" + name, "utf8");
		expect(text).not.toMatch(/process\.env|setInterval|setTimeout|readFile|writeFile|createRtpiFixtureCapability/);
	}
});
