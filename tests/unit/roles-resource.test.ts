// L0 #142: fixed metadata only. No private resource, real chat, model payload, owner action or activation.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	createRtpiFixtureCapability,
	rtpiValidate,
	type RtpiAccepted,
	type RtpiCapability,
	type RtpiRef,
} from "../../server/rtpi-core.js";
import {
	rolesNativeResourceRoot,
	rolesResourceProjection,
	type NativeResourceCurrent,
	type NativeResourceInput,
	type ResourceRecord,
	type ResourceScope,
} from "../../server/roles-resource.js";

const native = vi.hoisted(() => ({
	input: null as unknown,
	capability: null as unknown,
	current: null as unknown,
	owner: null as unknown,
	readError: false,
}));
vi.mock("../../server/roles-resource-native.js", () => ({
	nativeResourceInput: () => {
		if (native.readError) throw new Error("fixed read failure");
		return native.input as NativeResourceInput | null;
	},
	nativeResourceCapability: () => native.capability as RtpiCapability | null,
	nativeResourceOwnerOfSession: () => native.owner as RtpiRef | null,
	nativeResourceCurrent: () => {
		if (native.readError) throw new Error("fixed read failure");
		return native.current as NativeResourceCurrent | null;
	},
}));
const R = (kind: string, id: string, revision = "1"): RtpiRef => ({ namespace: "rtpi-fixture", kind, id, revision });
const id = "1000000a-0000-4000-8000-000000000001",
	revision = "2000000b-0000-4000-8000-000000000002";
const O = (kind: "resource" | "attestation", rev = revision): RtpiRef => R(kind, id, rev);
const TARGET = R("role", "ops"),
	OWNER = R("owner", "owner"),
	PEER = R("role", "coo");
const scope = (): ResourceScope => ({
	target: TARGET,
	session: R("session", "s1", "branch1"),
	epoch: R("epoch", "e1", "home1"),
});
const envelope = () => ({
	eventId: "resource-event",
	source: R("source", "l0"),
	issuer: R("issuer", "l0"),
	subject: R("subject", "role-ops"),
	lineage: R("lineage", "l0"),
	incarnation: "inc-1",
	sequence: 1,
	revision: 1,
	expectedRevision: 0,
	occurredAt: 1000,
});
const qualification = () => ({
	lineage: envelope().lineage,
	incarnation: "inc-1",
	currentRevision: 0,
	currentSequence: 0,
	sourceCommitted: true,
	serverNow: 10000,
	ownerPrincipalAdmitted: true,
});
const capability = (ownerPrincipal = true, atomicOutbox = true) =>
	createRtpiFixtureCapability({
		source: envelope().source,
		issuer: envelope().issuer,
		subject: envelope().subject,
		roots: ["rtpi/event/1"],
		facts: ["resource-incorporated", "config-saved", "profile-selected"],
		policyAccepted: true,
		acceptedSidecars: [],
		seams: { inputHook: false, atomicOutbox, ownerPrincipal, confinedReader: false, issuerRegistry: true },
	});
const record = (patch: Partial<ResourceRecord> = {}): ResourceRecord => ({
	schema: "i-resource/1",
	binding: { ...scope(), operation: R("operation", "load1") },
	kind: "incorporation",
	category: "rules",
	revision: O("resource"),
	integrity: O("attestation"),
	outcome: "incorporated",
	selection: "not-applicable",
	occurredAt: 1000,
	actor: null,
	...patch,
});
function input(r = record()): NativeResourceInput {
	const n: NativeResourceInput = {
		binding: structuredClone(r.binding),
		record: r,
		envelope: { ...envelope(), occurredAt: r.occurredAt },
		qualification: qualification(),
		successfulIncorporation: r.kind === "incorporation" && r.outcome === "incorporated",
		authenticatedSaveActor: r.actor,
	};
	native.input = n;
	native.capability = capability();
	native.owner = OWNER;
	return n;
}
function admit(r = record()): RtpiAccepted {
	input(r);
	const result = rolesNativeResourceRoot();
	if (result.verdict?.status !== "accepted") throw new Error("fixed resource fixture refused: " + result.reason);
	return result.verdict;
}
const resource = (receipts: readonly RtpiAccepted[] = [], s = scope()) =>
	rolesResourceProjection(s, receipts).resources.find((r) => r.category === "rules")!;
const current = (patch: Partial<NativeResourceCurrent> = {}): NativeResourceCurrent => ({
	schema: "i-resource-current/1",
	scope: scope(),
	category: "rules",
	revision: O("resource"),
	integrity: O("attestation"),
	observedAt: 2000,
	success: true,
	...patch,
});
beforeEach(() => {
	native.input = null;
	native.capability = null;
	native.current = null;
	native.owner = null;
	native.readError = false;
});

describe("L0 incorporation and current revision (V09/S01/S02)", () => {
	it("native defaults are unavailable, owner principal absent, with no caller-selected source", async () => {
		const real = await vi.importActual<typeof import("../../server/roles-resource-native.js")>(
			"../../server/roles-resource-native.js",
		);
		const owner = await vi.importActual<typeof import("../../server/roles-owner-native.js")>(
			"../../server/roles-owner-native.js",
		);
		expect(real.nativeResourceInput()).toBeNull();
		expect(real.nativeResourceCapability()).toBeNull();
		expect(real.nativeResourceCurrent(scope(), "rules")).toBeNull();
		expect(real.nativeResourceOwnerOfSession(scope().session)).toBeNull();
		expect(owner.nativeOwnerOfSession(scope().session)).toBeNull();
		expect(rolesNativeResourceRoot()).toMatchObject({ state: "unavailable", verdict: null });
		expect(rolesNativeResourceRoot.length).toBe(0);
		expect(resource().loaded).toEqual({
			label: "Not recorded",
			at: null,
			revision: null,
			integrity: null,
			actor: null,
		});
		expect(resource().changed.label).toBe("Not recorded");
	});
	it("successful host incorporation binds exact role/session/epoch/operation and opaque metadata", () => {
		const receipt = admit();
		expect(receipt.root.context).toMatchObject({
			session: scope().session,
			epoch: scope().epoch,
			recipient: TARGET,
			action: record().binding.operation,
		});
		expect(receipt.root.body).toMatchObject({
			fact: "resource-incorporated",
			status: "known",
			success: true,
			category: "rules",
			revision: O("resource"),
		});
		expect(receipt.root.body).toMatchObject({ refs: [] });
		expect(receipt.bytes).toBeLessThan(8192);
		expect(resource([receipt]).loaded).toMatchObject({
			label: "Recorded",
			at: 1000,
			revision: O("resource"),
			integrity: O("attestation"),
			actor: null,
		});
		expect(receipt.canonical).not.toMatch(/content|digest|mtime|prompt|apiKey|\/home\//);
	});
	for (const outcome of ["prepared", "failed"] as const)
		it(outcome + " is Not recorded, never incorporated", () => {
			const receipt = admit(record({ outcome }));
			expect(receipt.root.body).toMatchObject({ status: "unknown", success: outcome === "prepared" ? null : false });
			expect(resource([receipt]).loaded.label).toBe("Not recorded");
			// Counterfactual: a baseline mtime or current profile exists in both cases, but proves nothing.
			native.current = current();
			expect(resource([receipt]).changed.label).toBe("Not recorded");
		});
	it("selected DTO success cannot supply the native incorporation signal or atomic outbox", () => {
		const n = input();
		native.input = { ...n, successfulIncorporation: false };
		expect(rolesNativeResourceRoot()).toMatchObject({ state: "unknown", reason: "prepared-not-incorporated" });
		input();
		native.capability = capability(true, false);
		expect(rolesNativeResourceRoot().state).toBe("unknown");
		input();
		native.capability = null;
		expect(rolesNativeResourceRoot().state).toBe("unavailable");
		const uncommitted = input();
		native.input = { ...uncommitted, qualification: { ...qualification(), sourceCommitted: false } };
		expect(rolesNativeResourceRoot().state).toBe("unknown");
	});
	it("changed-since-load compares native current revision with actual historical load, never mutating it", () => {
		const receipt = admit();
		native.current = current();
		expect(resource([receipt]).changed.label).toBe("Unchanged");
		native.current = current({ revision: O("resource", "3000000c-0000-4000-8000-000000000003") });
		expect(resource([receipt]).changed).toEqual({ label: "Changed since load", observedAt: 2000 });
		expect(resource([receipt]).loaded.revision).toEqual(O("resource"));
	});
	it("missing/failed/stale/wrong-scope current read remains Not recorded, not unchanged", () => {
		const receipt = admit();
		for (const bad of [
			null,
			current({ success: false }),
			current({ observedAt: 999 }),
			current({ scope: { ...scope(), target: PEER } }),
			{ mtime: 2000 },
			{ ...current(), contentHash: "a".repeat(64) },
		]) {
			native.current = bad;
			expect(resource([receipt]).changed.label).toBe("Not recorded");
		}
		native.readError = true;
		expect(resource([receipt]).changed.label).toBe("Not recorded");
		expect(rolesNativeResourceRoot()).toMatchObject({ state: "unknown", reason: "resource-metadata-read-failed" });
	});
	it("wrong role, same-id/different session or epoch revision cannot inherit the old load (S02)", () => {
		const receipt = admit();
		for (const key of ["target", "session", "epoch"] as const) {
			const s = scope();
			expect(resource([receipt], { ...s, [key]: { ...s[key], revision: "different" } }).loaded.label).toBe(
				"Not recorded",
			);
		}
		for (const part of ["target", "session", "epoch", "operation"] as const) {
			const n = input();
			native.input = {
				...n,
				record: {
					...n.record,
					binding: { ...n.record.binding, [part]: { ...n.record.binding[part], revision: "other" } },
				},
			};
			expect(rolesNativeResourceRoot().state).toBe("rejected");
		}
		const n = input();
		native.input = { ...n, envelope: { ...n.envelope, occurredAt: 999 } };
		expect(rolesNativeResourceRoot().state).toBe("rejected");
	});
	it("a failed later load cannot be quietly replaced with a stale success", () => {
		const prior = admit();
		const failed = admit(
			record({ outcome: "failed", occurredAt: 2000, binding: { ...scope(), operation: R("operation", "load2") } }),
		);
		expect(resource([prior, failed]).loaded.label).toBe("Not recorded");
	});
});

describe("L0 authenticated saves and runtime selection (V09/V15/S01)", () => {
	const saved = (actor: RtpiRef | null = OWNER) => record({ kind: "save", outcome: "saved", actor });
	it("save editedAt and actor only from native authenticated save; neither load nor mtime supplies them", () => {
		const load = admit();
		expect(resource([load]).saved.label).toBe("Not recorded");
		const save = admit(saved());
		expect(resource([save]).saved).toMatchObject({ label: "Recorded", editedAt: 1000, actor: OWNER });
		expect(resource([save]).loaded.label).toBe("Not recorded");
		const roleSave = admit(saved(PEER));
		expect(resource([roleSave]).saved.actor).toEqual(PEER);
	});
	it("owner inference, wrong principal, absent T03 and unauthenticated role are not recorded", () => {
		for (const actor of [null, OWNER, PEER]) {
			const n = input(saved(actor));
			native.input = { ...n, authenticatedSaveActor: null };
			expect(rolesNativeResourceRoot()).toMatchObject({ state: "unknown", reason: "save-actor-not-authenticated" });
		}
		input(saved());
		native.owner = null;
		expect(rolesNativeResourceRoot().reason).toBe("owner-principal-not-admitted");
		input(saved());
		native.owner = { ...OWNER, revision: "other" };
		expect(rolesNativeResourceRoot().reason).toBe("owner-principal-not-admitted");
		input(saved());
		native.capability = capability(false);
		expect(rolesNativeResourceRoot().reason).toBe("owner-principal-not-admitted");
		const n = input(saved());
		native.input = { ...n, qualification: { ...qualification(), ownerPrincipalAdmitted: false } };
		expect(rolesNativeResourceRoot().reason).toBe("owner-principal-not-admitted");
	});
	it("failed save clears editedAt and actor, never supplies a successful save", () => {
		const receipt = admit(record({ kind: "save", outcome: "failed" }));
		expect(resource([receipt]).saved).toMatchObject({ label: "Not recorded", editedAt: null, actor: null });
	});
	it("requested, launch, current-selected can differ; none is an executed model assertion", () => {
		const receipts = ["requested", "launch", "current-selected"].map((selection, i) =>
			admit(
				record({
					kind: "selection",
					outcome: "selected",
					category: "runtime",
					selection: selection as ResourceRecord["selection"],
					revision: O(
						"resource",
						[revision, "3000000c-0000-4000-8000-000000000003", "4000000d-0000-4000-8000-000000000004"][i],
					),
					binding: { ...scope(), operation: R("operation", "selection-" + i) },
				}),
			),
		);
		const runtime = rolesResourceProjection(scope(), receipts).runtime;
		expect(runtime.requested.revision).not.toEqual(runtime.launch.revision);
		expect(runtime.launch.revision).not.toEqual(runtime.currentSelected.revision);
		expect(runtime.executedModel).toBe("Not recorded");
		expect(runtime.saved.label).toBe("Not recorded");
		const onlyCurrent = rolesResourceProjection(scope(), [receipts[2]]).runtime;
		expect(onlyCurrent.launch.label).toBe("Not recorded");
		expect(onlyCurrent.requested.label).toBe("Not recorded");
	});
});

describe("L0 no content, no replay and compatible inert seam (V15/V18/S07)", () => {
	it("extra keys, content digests, path refs, controls, namespace mixes and wrong kinds are rejected", () => {
		for (const field of [
			"content",
			"prompt",
			"about",
			"rules",
			"hash",
			"digest",
			"apiKey",
			"auth",
			"settings",
			"model",
			"mtime",
			"editedAt",
			"authenticated",
			"executedModel",
		]) {
			const n = input();
			native.input = { ...n, record: { ...n.record, [field]: "forbidden" } };
			expect(rolesNativeResourceRoot().state).toBe("rejected");
		}
		for (const field of ["revision", "integrity"] as const)
			for (const bad of [
				"a".repeat(64),
				"sha256:" + "a".repeat(64),
				"/private",
				id + "\n",
				id + "\r",
				id + "\0",
				id + " ",
				id.toUpperCase(),
			]) {
				const n = input();
				native.input = { ...n, record: { ...n.record, [field]: { ...n.record[field], id: bad } } };
				expect(rolesNativeResourceRoot().state).toBe("rejected");
			}
		const n = input();
		native.input = { ...n, record: { ...n.record, revision: { ...O("resource"), namespace: "rtpi-native" } } };
		expect(rolesNativeResourceRoot().state).toBe("rejected");
		input();
		native.input = { ...n, record: { ...n.record, integrity: O("resource") } };
		expect(rolesNativeResourceRoot().state).toBe("rejected");
	});
	it("copies/generic C0 roots are not native resource receipts; conflicting same operation stays unknown", () => {
		const receipt = admit();
		expect(resource([structuredClone(receipt)]).loaded.label).toBe("Not recorded");
		const generic = rtpiValidate(structuredClone(receipt.root), capability(), {
			...qualification(),
			resourceIncorporated: true,
		});
		expect(generic.status).toBe("accepted");
		if (generic.status === "accepted") expect(resource([generic]).loaded.label).toBe("Not recorded");
		expect(resource([receipt, receipt]).loaded.label).toBe("Recorded");
		const conflict = admit(record({ revision: O("resource", "3000000c-0000-4000-8000-000000000003") }));
		expect(resource([receipt, conflict]).loaded.label).toBe("Not recorded");
	});
	it("mutated input or projection cannot rewrite immutable incorporated metadata", () => {
		const receipt = admit();
		const n = native.input as NativeResourceInput;
		Object.assign(n.record.revision, { revision: "different" });
		const displayed = resource([receipt]);
		Object.assign(displayed.loaded.revision!, { revision: "different" });
		expect(resource([receipt]).loaded.revision).toEqual(O("resource"));
	});
	it("no production importer or resource reader added; native default functions take no authority arguments", () => {
		const server = new URL("../../server/", import.meta.url);
		for (const file of readdirSync(server).filter((f) => f.endsWith(".ts") && !f.startsWith("roles-resource")))
			expect(readFileSync(new URL(file, server), "utf8"), file).not.toMatch(
				/from ["']\.\/roles-resource(?:-native)?\.js["']/,
			);
		expect(readFileSync(new URL("roles-resource.ts", server), "utf8")).not.toMatch(
			/from ["']node:fs|readFile|statSync|process\.env/,
		);
	});
	const rootPath = fileURLToPath(new URL("../../", import.meta.url));
	const identity = ["pi-identity", "pi-identity-roles-r8-l0-identity"]
		.map((name) => resolve(dirname(rootPath), name, "resource-metadata.ts"))
		.find(existsSync);
	it.skipIf(!identity)(
		"actual pi-identity structural seam agrees on successful/prepared/failed and forbidden metadata",
		() => {
			const fixtures = [
				record(),
				record({ outcome: "prepared" }),
				record({ outcome: "failed" }),
				{ ...record(), digest: "a".repeat(64) },
				{ ...record(), revision: { ...O("resource"), id: "a".repeat(64) } },
			];
			const answers = execFileSync(
				process.execPath,
				[
					"--input-type=module",
					"-e",
					"const m = await import(process.argv[1]); console.log(JSON.stringify(JSON.parse(process.argv[2]).map(v => m.parseResourceMetadata(v) !== null)))",
					pathToFileURL(identity!).href,
					JSON.stringify(fixtures),
				],
				{ encoding: "utf8" },
			);
			expect(JSON.parse(answers)).toEqual([true, true, true, false, false]);
			for (let i = 0; i < fixtures.length; i++) {
				input(fixtures[i] as ResourceRecord);
				expect(rolesNativeResourceRoot().state).toBe(i < 3 ? "accepted" : "rejected");
			}
		},
	);
});
