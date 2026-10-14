// O0 (#140): I-CONTACT adapters on inert native responses only (Ops108 marks, fixture RTPI capabilities).
// No real chat, owner choice, Telegram send or human-observer substitute. Each case names the naive collapse it rules out.
// The native inputs (T03 owner, capability, clocks) are reachable only through vi.mock here: production code takes
// none of them as an argument, env, config or flag (Security rm-4c755cd7 B1).
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { browserRoleInput } from "../../server/role-replies.js";
import {
	classifyOwnerContact,
	contactStages,
	observeContact,
	OWNER_TYPED_INTENT_APPROVED,
	ownerActionRoot,
	ownerSavedRoot,
	type ContactEnvelope,
	type ContactEvidence,
	type NativeContactInput,
} from "../../server/roles-contact.js";
import {
	createOwnerChallengeHandler,
	type OwnerHostConnection,
	type OwnerPrincipalAdmission,
} from "../../server/roles-owner-challenge.js";
import {
	createRtpiFixtureCapability,
	RTPI_NATIVE_SEAMS_C0,
	rtpiValidate,
	type RtpiCapability,
	type RtpiRef,
	type RtpiVerdict,
} from "../../server/rtpi-core.js";

const native = vi.hoisted(() => ({
	capability: null as unknown,
	owner: null as unknown,
	admit: null as null | ((c: unknown) => unknown),
	wall: 5000,
	mono: 100,
}));
vi.mock("../../server/roles-owner-native.js", async (importOriginal) => {
	const real = await importOriginal<typeof import("../../server/roles-owner-native.js")>();
	return {
		...real,
		nativeContactCapability: () => (native.capability ?? real.nativeContactCapability()) as RtpiCapability | null,
		nativeOwnerOfSession: (s: RtpiRef) => (native.owner ?? real.nativeOwnerOfSession(s)) as RtpiRef | null,
		admitNativeOwnerPrincipal: (c: OwnerHostConnection) =>
			(native.admit ? native.admit(c) : real.admitNativeOwnerPrincipal(c)) as OwnerPrincipalAdmission,
		serverWallNow: () => native.wall,
		serverMonotonicNow: () => native.mono,
	};
});

const ref = (kind: string, id: string, revision = "1"): RtpiRef => ({ namespace: "rtpi-fixture", kind, id, revision });
const nativeRef = (kind: string, id: string, revision = "1"): RtpiRef => ({
	namespace: "rtpi-native",
	kind,
	id,
	revision,
});
const contactInput = (over: Partial<NativeContactInput>): NativeContactInput => ({
	source: "native-record",
	causes: ["browser"],
	ownerChannel: "browser",
	pseudoClient: false,
	taskOnly: false,
	...over,
});
const envelope: ContactEnvelope = {
	eventId: "contact-event-1",
	source: ref("source", "o0-source"),
	issuer: ref("issuer", "o0-issuer"),
	subject: ref("subject", "role-ops"),
	lineage: ref("lineage", "o0-lineage"),
	incarnation: "o0-incarnation",
	sequence: 1,
	revision: 1,
	expectedRevision: 0,
	occurredAt: 1000,
};
const FACTS = ["owner-saved", "owner-rendered", "owner-opened"] as const;
/** Test-only fixture capability (rtpi-fixture namespace); production never reaches one. */
const capability = (
	seams = { ...RTPI_NATIVE_SEAMS_C0, atomicOutbox: true, ownerPrincipal: true, issuerRegistry: true },
) =>
	createRtpiFixtureCapability({
		source: envelope.source,
		issuer: envelope.issuer,
		subject: envelope.subject,
		roots: ["rtpi/event/1"],
		facts: [...FACTS],
		policyAccepted: true,
		acceptedSidecars: [],
		seams,
	});
const none: ContactEvidence = {
	accepted: null,
	delivered: null,
	replyIndex: null,
	callback: null,
	transport: null,
	rendered: null,
	opened: null,
};

const OWNER = ref("owner", "owner-1");
const conn: OwnerHostConnection = {
	scope: "owner-client",
	channel: "browser",
	principalBasis: "t03-native",
	pseudoClient: false,
	session: ref("session", "s-1", "branch-1"),
	window: ref("window", "w-1", "load-1"),
	client: { id: "c-1", incarnation: "inc-1", build: "build-b" },
};
const target = {
	artifact: ref("artifact", "roles-page", "rev-7"),
	projection: ref("projection", "p-1", "rev-7"),
	coverage: ref("coverage", "cov-1", "complete"),
	policy: ref("policy", "o0-display", "1"),
};
/** A receipt minted by the real handler, with a fixture T03 admission switched on only for the issue and answer. */
function acceptedReceipt(action: "render" | "open", now = 5000) {
	native.admit = () => ({ admitted: true, principal: OWNER });
	native.wall = now;
	try {
		const h = createOwnerChallengeHandler({ currentBuild: "build-b", currentIncarnation: () => "inc-1" });
		const i = h.issue(conn, { action, ...target });
		if (i.status !== "issued") throw new Error("not issued");
		const r = h.answer(conn, { action, ...target }, { challengeId: i.challengeId, value: i.value });
		if (r.status !== "accepted") throw new Error("not accepted");
		return { receipt: r.receipt, value: i.value };
	} finally {
		native.admit = null;
	}
}
/** Host facts J0 would rehydrate; owner admission and server time are never among them. */
const qual = (over: Record<string, unknown> = {}) => ({
	lineage: envelope.lineage,
	incarnation: envelope.incarnation,
	currentRevision: 0,
	currentSequence: 0,
	sourceCommitted: true,
	clientCurrent: true,
	currentArtifact: target.artifact,
	currentProjection: target.projection,
	currentCoverage: target.coverage,
	...over,
});
const bodyOf = (v: RtpiVerdict | null) =>
	(v as unknown as { root: { body: Record<string, unknown>; context: Record<string, unknown> } }).root;

beforeEach(() => {
	native.capability = null;
	native.owner = null;
	native.admit = null;
	native.wall = 5000;
	native.mono = 100;
});

describe("O0 I-CONTACT channel classification (V05, S01)", () => {
	it("browser: only Ops108's accepted non-pseudo stamp counts; neutral 'Your contacts'", () => {
		const accepted = browserRoleInput(true, false);
		const c = classifyOwnerContact(contactInput({ causes: [accepted.cause], ownerChannel: accepted.ownerChannel }));
		expect(c).toMatchObject({ channel: "browser", kind: "contact", label: "Your contacts", ownerDelivery: true });
		// Ops108 gives a pseudo client no stamp: the contact is not an owner browser contact.
		const pseudo = browserRoleInput(true, true);
		expect(classifyOwnerContact(contactInput({ ownerChannel: pseudo.ownerChannel })).reason).toBe("browser-unadmitted");
		expect(classifyOwnerContact(contactInput({ ownerChannel: undefined })).channel).toBe("unknown");
	});

	it("Telegram keeps its own route; a legacy unstamped Telegram record stays Telegram; a browser stamp conflicts", () => {
		expect(classifyOwnerContact(contactInput({ causes: ["telegram"], ownerChannel: "telegram" })).channel).toBe(
			"telegram",
		);
		expect(classifyOwnerContact(contactInput({ causes: ["telegram"], ownerChannel: undefined })).channel).toBe(
			"telegram",
		);
		expect(classifyOwnerContact(contactInput({ causes: ["telegram"], ownerChannel: "browser" }))).toMatchObject({
			channel: "unknown",
			reason: "channel-conflict",
		});
	});

	it("mixed causes fail closed (no cross-channel authority)", () => {
		for (const causes of [
			["browser", "telegram"],
			["browser", "role"],
			["telegram", "plugin"],
		] as const) {
			expect(classifyOwnerContact(contactInput({ causes: [...causes] }))).toMatchObject({
				channel: "unknown",
				reason: "mixed-cause",
				ownerDelivery: false,
			});
		}
	});

	it("pseudo client, invalid stamp, or a stamp without an owner cause: unknown", () => {
		expect(classifyOwnerContact(contactInput({ pseudoClient: true })).reason).toBe("pseudo-client");
		expect(classifyOwnerContact(contactInput({ ownerChannel: "owner" })).reason).toBe("owner-channel-invalid");
		expect(classifyOwnerContact(contactInput({ causes: ["plugin"], ownerChannel: "browser" })).reason).toBe(
			"owner-channel-without-owner-cause",
		);
		expect(classifyOwnerContact(contactInput({ causes: [], ownerChannel: undefined })).reason).toBe("cause-unknown");
	});

	it("model, tool, plugin-argument or client owner flags never count", () => {
		for (const source of ["model", "tool", "plugin-argument", "client"] as const) {
			const flagged = {
				...contactInput({ source }),
				forOwner: true,
				owner: true,
				verified: true,
			} as NativeContactInput;
			expect(classifyOwnerContact(flagged)).toMatchObject({ channel: "unknown", reason: "non-native-owner-flag" });
		}
	});

	it("task-only reply stays task-only: never owner delivery, never rendered or opened", () => {
		const c = classifyOwnerContact(contactInput({ taskOnly: true }));
		expect(c).toMatchObject({ channel: "task-only", label: "Task answer", ownerDelivery: false });
		const s = contactStages(c, { ...none, accepted: true, delivered: true, callback: { kind: "persisted", at: 1 } });
		expect(s.delivered).toMatchObject({ state: "not-applicable", reason: "task-only-not-owner-delivery" });
		expect(s.rendered.state).toBe("not-applicable");
		expect(s.saved.state).toBe("recorded");
	});

	it("untyped contacts stay neutral: no text input, '?' types nothing (C02)", () => {
		expect(OWNER_TYPED_INTENT_APPROVED).toBe(false);
		const withText = { ...contactInput({}), text: "Can you check this?", intent: "question" } as NativeContactInput;
		expect(classifyOwnerContact(withText)).toEqual(classifyOwnerContact(contactInput({})));
		expect(classifyOwnerContact(withText).kind).toBe("contact");
		expect(classifyOwnerContact(contactInput({ causes: ["role"], ownerChannel: undefined })).label).toBe(
			"Role message",
		);
	});
});

describe("O0 stages stay separate (V06, S04)", () => {
	const browser = classifyOwnerContact(contactInput({}));
	const telegram = classifyOwnerContact(contactInput({ causes: ["telegram"], ownerChannel: "telegram" }));

	it("lost callback is 'Delivery not recorded', not failed; failed needs a native proof", () => {
		expect(contactStages(browser, none).saved).toMatchObject({ state: "not-recorded", label: "Delivery not recorded" });
		expect(contactStages(browser, { ...none, callback: { kind: "failed", proof: "" } }).saved.state).toBe(
			"not-recorded",
		);
		expect(
			contactStages(browser, { ...none, callback: { kind: "failed", proof: "store-write-eacces" } }).saved.state,
		).toBe("failed");
	});

	it("reply index: missing/incomplete -> Reply not recorded; complete empty -> Not yet; ids -> Replied", () => {
		expect(contactStages(browser, none).replied.label).toBe("Reply not recorded");
		expect(contactStages(browser, { ...none, replyIndex: { complete: false, replyIds: ["r1"] } }).replied.state).toBe(
			"not-recorded",
		);
		expect(contactStages(browser, { ...none, replyIndex: { complete: true, replyIds: [] } }).replied.label).toBe(
			"Not yet",
		);
		expect(contactStages(browser, { ...none, replyIndex: { complete: true, replyIds: ["r1"] } }).replied.state).toBe(
			"recorded",
		);
	});

	it("save is not render or open", () => {
		const s = contactStages(browser, { ...none, callback: { kind: "persisted", at: 10 } });
		expect(s.saved.state).toBe("recorded");
		expect(s.rendered).toMatchObject({ state: "unknown", reason: "owner-principal-not-admitted" });
		expect(s.opened.state).toBe("unknown");
	});

	it("Telegram acceptance is transport, not a read; partial is partial; API failure is failed; browser has none", () => {
		const ok = contactStages(telegram, {
			...none,
			transport: { kind: "api-accepted", messageIds: [11, 12], parts: 2 },
		});
		expect(ok.transport).toMatchObject({ state: "recorded", label: "Accepted by Telegram (not a read)" });
		expect(ok.rendered.state).toBe("unknown");
		expect(ok.opened.state).toBe("unknown");
		expect(
			contactStages(telegram, { ...none, transport: { kind: "api-accepted", messageIds: [11], parts: 2 } }).transport
				.state,
		).toBe("partial");
		expect(contactStages(telegram, { ...none, transport: { kind: "api-failed", code: 400 } }).transport.state).toBe(
			"failed",
		);
		expect(contactStages(telegram, none).transport.state).toBe("not-recorded");
		expect(contactStages(browser, { ...none, transport: { kind: "api-failed", code: 400 } }).transport.state).toBe(
			"not-applicable",
		);
	});

	it("V06 timeline 10:00-10:05: each stage from its own evidence; removing one leaves the others", () => {
		const r = acceptedReceipt("render", 10_04);
		const o = acceptedReceipt("open", 10_05);
		native.capability = capability();
		const rendered = ownerActionRoot(r.receipt, ref("receipt", "rr-1"), envelope, {
			enabled: true,
			qualification: qual(),
		}).verdict;
		const opened = ownerActionRoot(o.receipt, ref("receipt", "ro-1"), envelope, {
			enabled: true,
			qualification: qual(),
		}).verdict;
		const full: ContactEvidence = {
			accepted: true,
			delivered: true,
			replyIndex: { complete: true, replyIds: ["r1"] },
			callback: { kind: "persisted", at: 10_03 },
			transport: null,
			rendered,
			opened,
		};
		const all = contactStages(browser, full);
		for (const s of ["accepted", "delivered", "replied", "saved", "rendered", "opened"] as const)
			expect(all[s].state, s).toBe("recorded");
		expect(all.rendered.label).toBe("Shown on your screen");
		expect(all.opened.label).toBe("Opened by you");
		const keys = ["accepted", "delivered", "replyIndex", "callback", "rendered", "opened"] as const;
		const blank = { accepted: null, delivered: null, replyIndex: null, callback: null, rendered: null, opened: null };
		for (const k of keys) {
			const s = contactStages(browser, { ...full, [k]: blank[k] });
			const changed = (Object.keys(s) as (keyof typeof s)[]).filter((n) => s[n].state !== all[n].state);
			expect(changed.length, k).toBe(1);
		}
		// A render receipt is not an open receipt.
		expect(contactStages(browser, { ...full, opened: rendered }).opened).toMatchObject({
			state: "unknown",
			reason: "receipt-fact-mismatch",
		});
	});
});

describe("O0 RTPI owner roots (S01, S03, V15)", () => {
	it("production defaults: no owner, no admission, no capability; every owner root unknown or unavailable", async () => {
		const real = await vi.importActual<typeof import("../../server/roles-owner-native.js")>(
			"../../server/roles-owner-native.js",
		);
		expect(real.nativeContactCapability()).toBeNull();
		expect(real.nativeOwnerOfSession(conn.session)).toBeNull();
		expect(real.admitNativeOwnerPrincipal(conn)).toEqual({ admitted: false, reason: "owner-principal-not-admitted" });
		const { receipt } = acceptedReceipt("render");
		expect(ownerActionRoot(receipt, ref("receipt", "rr-1"), envelope).state).toBe("off");
		expect(
			ownerSavedRoot({ session: conn.session, receipt: ref("receipt", "s-1"), serverNow: 5000 }, envelope).state,
		).toBe("off");
		expect(
			ownerActionRoot(receipt, ref("receipt", "rr-1"), envelope, { enabled: true, qualification: qual() }),
		).toMatchObject({ state: "unavailable", reason: "capability-missing" });
		// A native-namespace root has no issuer registry (T05) and no fixture capability can stand in for one.
		const nativeEnvelope: ContactEnvelope = {
			...envelope,
			source: nativeRef("source", "o0-source"),
			issuer: nativeRef("issuer", "o0-issuer"),
			subject: nativeRef("subject", "role-ops"),
			lineage: nativeRef("lineage", "o0-lineage"),
		};
		const nativeSaved = () =>
			ownerSavedRoot(
				{ session: nativeRef("session", "s-1"), receipt: nativeRef("receipt", "s-1"), serverNow: 5000 },
				nativeEnvelope,
				{ enabled: true, qualification: qual({ lineage: nativeEnvelope.lineage }) },
			);
		expect(nativeSaved()).toMatchObject({ state: "unavailable", reason: "native-issuer-registry-missing" });
		native.capability = capability();
		expect(nativeSaved().state).not.toBe("validated");
		expect(nativeSaved().reason).toBe("capability-namespace-mismatch");
	});

	it("under the C0 seams an owner root is unknown; outbox without T03 is still not admitted", () => {
		const { receipt } = acceptedReceipt("render");
		native.capability = capability(RTPI_NATIVE_SEAMS_C0);
		const r = ownerActionRoot(receipt, ref("receipt", "rr-1"), envelope, { enabled: true, qualification: qual() });
		expect(r).toMatchObject({ state: "unknown", reason: "canonical-source-not-committed" });
		native.capability = capability({ ...RTPI_NATIVE_SEAMS_C0, atomicOutbox: true });
		expect(
			ownerActionRoot(receipt, ref("receipt", "rr-1"), envelope, { enabled: true, qualification: qual() }).reason,
		).toBe("owner-principal-not-admitted");
		native.owner = OWNER;
		expect(
			ownerSavedRoot({ session: conn.session, receipt: ref("receipt", "s-1"), serverNow: 5000 }, envelope, {
				enabled: true,
				qualification: qual(),
			}).reason,
		).toBe("owner-principal-not-admitted");
	});

	it("a capability, owner, admission flag or clock given by the caller is ignored", () => {
		const { receipt } = acceptedReceipt("render");
		const smuggled = {
			enabled: true,
			capability: capability(),
			qualification: { ...qual(), ownerPrincipalAdmitted: true, serverNow: receipt.serverNow + 1 },
		} as never;
		// No native capability: the caller's capability is not used.
		expect(ownerActionRoot(receipt, ref("receipt", "rr-1"), envelope, smuggled)).toMatchObject({
			state: "unavailable",
			reason: "capability-missing",
		});
		native.capability = capability();
		// The caller's serverNow is replaced by the one the handler read: still the receipt's own time.
		const ok = ownerActionRoot(receipt, ref("receipt", "rr-1"), envelope, smuggled);
		expect(ok.state).toBe("validated");
		expect(bodyOf(ok.verdict).body.serverNow).toBe(receipt.serverNow);
		// owner-saved: no native owner (T03 missing) -> the fact is "unknown" with no owner, whatever the caller says.
		const savedInput = { owner: OWNER, session: conn.session, receipt: ref("receipt", "s-1"), serverNow: 5000 };
		const unknownOwner = ownerSavedRoot(savedInput as never, envelope, smuggled);
		expect(unknownOwner.verdict?.status).toBe("accepted");
		expect(bodyOf(unknownOwner.verdict).body.status).toBe("unknown");
		expect(bodyOf(unknownOwner.verdict).context.owner).toBeNull();
		// Only the native owner of the session makes it known.
		native.owner = OWNER;
		const known = ownerSavedRoot(savedInput as never, envelope, smuggled);
		expect(known.state).toBe("validated");
		expect(bodyOf(known.verdict).body.status).toBe("known");
		expect(bodyOf(known.verdict).context.owner).toEqual(OWNER);
	});

	it("a copied or hand-built receipt cannot mint; a verdict the adapter did not return does not count", () => {
		const { receipt } = acceptedReceipt("render");
		native.capability = capability();
		const opts = { enabled: true, qualification: qual() };
		for (const fake of [{ ...receipt }, JSON.parse(JSON.stringify(receipt))]) {
			expect(ownerActionRoot(fake, ref("receipt", "rr-1"), envelope, opts)).toEqual({
				state: "rejected",
				reason: "receipt-not-minted-by-handler",
				verdict: null,
			});
		}
		const ok = ownerActionRoot(receipt, ref("receipt", "rr-1"), envelope, opts);
		expect(ok.state).toBe("validated");
		const browser = classifyOwnerContact(contactInput({}));
		const direct = rtpiValidate(bodyOf(ok.verdict), capability(), {
			...qual(),
			ownerPrincipalAdmitted: true,
			serverNow: receipt.serverNow,
		});
		expect(direct.status).toBe("accepted");
		for (const v of [direct, { ...ok.verdict }, JSON.parse(JSON.stringify(ok.verdict))] as RtpiVerdict[]) {
			expect(contactStages(browser, { ...none, rendered: v }).rendered).toMatchObject({
				state: "unknown",
				reason: "verdict-not-from-contact-adapter",
			});
		}
		expect(contactStages(browser, { ...none, rendered: ok.verdict }).rendered.state).toBe("recorded");
	});

	it("a stale or observer client and a moved subject cannot mint render/open; the challenge value never enters a record", () => {
		const { receipt, value } = acceptedReceipt("render");
		native.capability = capability();
		const ok = ownerActionRoot(receipt, ref("receipt", "rr-1"), envelope, { enabled: true, qualification: qual() });
		expect(ok.state).toBe("validated");
		expect(JSON.stringify(ok.verdict)).not.toContain(value.slice(0, 8));
		expect(
			ownerActionRoot(receipt, ref("receipt", "rr-1"), envelope, {
				enabled: true,
				qualification: qual({ clientCurrent: false }),
			}).reason,
		).toBe("observer-or-stale-client");
		expect(
			ownerActionRoot(receipt, ref("receipt", "rr-1"), envelope, {
				enabled: true,
				qualification: qual({ currentArtifact: ref("artifact", "roles-page", "rev-8") }),
			}).reason,
		).toBe("owner-current-subject-mismatch");
		const stale = contactStages(classifyOwnerContact(contactInput({})), {
			...none,
			rendered: ownerActionRoot(receipt, ref("receipt", "rr-1"), envelope, {
				enabled: true,
				qualification: qual({ clientCurrent: false }),
			}).verdict,
		});
		expect(stale.rendered).toMatchObject({ state: "not-recorded", label: "Not counted" });
	});

	it("an open receipt makes owner-opened, never acknowledged, confirmed or approved", () => {
		const { receipt } = acceptedReceipt("open");
		native.capability = capability();
		const r = ownerActionRoot(receipt, ref("receipt", "ro-1"), envelope, { enabled: true, qualification: qual() });
		expect(r.state).toBe("validated");
		expect(bodyOf(r.verdict).body.fact).toBe("owner-opened");
		const src = readFileSync("server/roles-contact.ts", "utf8");
		expect(src).not.toMatch(/fact:\s*"(owner-acknowledged|artifact-confirmed|policy-approved)"/);
	});
});

describe("O0 observer, undo and Ops108 baseline (S04, V18)", () => {
	it("the diagnostic observer gets a frozen read-only view and no way to mint", () => {
		const c = classifyOwnerContact(contactInput({}));
		const v = observeContact("observer", c, none);
		expect(Object.isFrozen(v)).toBe(true);
		expect(v.stages.rendered.state).toBe("unknown");
		expect(() => observeContact("owner-client" as "observer", c, none)).toThrow("observer-scope-required");
		expect(Object.keys(v).sort()).toEqual(["contact", "scope", "stages"]);
	});

	it("Ops108 routing bytes are unchanged and nothing in production imports O0", () => {
		const sha = (p: string) => createHash("sha256").update(readFileSync(p)).digest("hex");
		expect(sha("server/role-replies.ts")).toBe("4df90a6f48be5599ed50c6a5fa0380dfc31a43ef6d74a268348bf40f70a41ad6");
		expect(sha("server/plugins.ts")).toBe("b3f0f42f182104555fc5abeb94bf0340da9f577b7fa0a098942c45682bf3b17a");
		expect(sha("plugins/telegram/index.mjs")).toBe("9bd0faeb8e469c27afb9ef7005f5a3d626db01444c4f7b9a0f4c8cc1a7b1eeff");
		for (const path of [
			"server/index.ts",
			"server/agent-service.ts",
			"server/roles-overview.ts",
			"server/role-messages.ts",
		]) {
			expect(readFileSync(path, "utf8")).not.toMatch(/from\s+["'][^"']*roles-(contact|owner-challenge|owner-native)/);
		}
		const code = readFileSync("server/roles-contact.ts", "utf8");
		expect(code).not.toMatch(
			/registerTool|appendFile|writeFile|setInterval|setTimeout|process\.env|sendMessage|fetch\(/,
		);
		expect(code).not.toMatch(/createRtpiFixtureCapability|rtpi-fixture|vitest/);
	});
});
