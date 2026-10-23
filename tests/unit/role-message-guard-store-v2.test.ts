// Ops453: synthetic revision/container refusal and durable exact-grant proofs; never native authority.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type * as V1 from "../../server/role-message-guard-contract.js";
import type {
	GuardApprovalBindingV2,
	GuardAtomicMutationAny,
	GuardRequestV2,
	GuardStoreStateAny,
	GuardStoreStateV2,
} from "../../server/role-message-guard-contract-v2.js";
import {
	GuardFileStore,
	guardDigest,
	guardStateIsValid,
	guardTransactionId,
	type GuardFileStoreOptions,
} from "../../server/role-message-guard-store.js";
import { guardStateIsValid as previousStateIsValid } from "./role-message-guard-store-reference.js";
import { legacyGuardFileStoreView } from "./role-message-guard-v1-test-adapter.js";

const now = 2_000_000_000;
const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const actor: V1.GuardActor = {
	role: "alpha",
	sessionFile: "/synthetic-v2/alpha.jsonl",
	sessionId: "synthetic-alpha",
	runtimeIncarnation: "synthetic-runtime",
	task: { kind: "home" },
	currentHome: true,
	identityRevision: "synthetic-identities",
};
const proof: V1.GuardProofReference = {
	sourceId: "synthetic-source",
	sourceVersion: "synthetic-v1",
	sourceIncarnation: "synthetic-incarnation",
	eventId: "synthetic-event",
	revision: "synthetic-proof",
	digest: "synthetic-digest",
	observedAt: now,
};
const binding: V1.GuardApprovalBinding = {
	version: "role-message-guard/v1",
	requestId: "synthetic-old-request",
	generation: "1",
	requester: actor,
	causal: {
		kind: "legacy_boundary",
		anchorId: "synthetic-boundary",
		incomingRecordId: "synthetic-incoming",
		incomingHash: "synthetic-hash",
		nextHop: 7,
		historicalRoot: "unknown",
	},
	scope: {
		scopeId: "synthetic-scope",
		operation: "synthetic-operation",
		participants: ["alpha", "beta"],
		recipients: ["beta"],
		task: { kind: "home" },
	},
	tier: "lower",
	quantity: 3,
	upperHop: 9,
};
const selection: Extract<V1.GuardApproverSelection, { readonly tier: "lower" }> = {
	tier: "lower",
	role: "coo",
	route: "coo",
	home: { ...actor, role: "coo", sessionFile: "/synthetic-v2/coo.jsonl" },
	proof,
};
const decision: V1.GuardVerifiedDecision = {
	binding,
	choice: "requested_quantity",
	reason: "Synthetic earlier answer, not an executed approval",
	authority: { tier: "lower", selection, decisionId: "synthetic-old-decision", proof },
	answeredAt: now - 1000,
	firstAnswerEventId: "synthetic-first-answer",
};
const oldRequest: V1.GuardRequest = {
	binding,
	context: {
		goal: "Synthetic goal",
		progressAndChanges: "Synthetic progress",
		priorDecisions: [],
		whyNeeded: "Synthetic reason",
		nextStepAndOutcome: "Synthetic next step",
		outstandingQuestions: ["Synthetic question"],
		optionsAndTradeoffs: ["Synthetic option A", "Synthetic option B"],
		timeCostRisk: "Synthetic cost",
		exactCommunicationAuthority: "Synthetic only",
		nativeFacts: [proof],
		declaredClaims: [],
		safetyScopeAndHolds: ["All real holds unchanged"],
	},
	selectedApprover: selection,
	createdAt: now - 2000,
	expiresAt: now + 86_398_000,
	state: "approved",
	upwardEscalations: 0,
	initialNotificationKey: "synthetic-initial",
	decisionNotificationKey: "synthetic-decision",
	firstDecision: decision,
	grantId: "synthetic-old-grant",
};
const oldGrant: V1.GuardGrant = {
	id: "synthetic-old-grant",
	binding,
	authority: decision.authority,
	issuedAt: now - 1000,
	expiresAt: now + 3_599_000,
	maximumUses: 3,
	acceptedUses: 1,
	state: "approved",
	useTransactionIds: ["synthetic-prior-use"],
};
const newBinding: GuardApprovalBindingV2 = {
	...binding,
	version: "role-message-guard/v2",
	requestId: "synthetic-new-request",
	causal: { ...binding.causal, nextHop: 13 },
	quantity: 10,
	upperHop: 22,
};
const newRequest: GuardRequestV2 = {
	...oldRequest,
	binding: newBinding,
	selectedApprover: selection,
	firstDecision: null,
	state: "awaiting_approver",
	grantId: null,
};
function initial(): V1.GuardStoreState {
	return {
		version: "role-message-guard/v1",
		revision: "synthetic-store-v1",
		mode: "enabled",
		lastTrustedTime: now,
		requests: [oldRequest],
		grants: [oldGrant],
		incidents: [],
		usage: [],
		transactions: [],
		outbox: [],
		audits: [],
		tombstones: [],
		overflow: { count: 0, state: "none" },
	};
}
const mixed = (): GuardStoreStateV2 => ({
	...initial(),
	version: "role-message-guard/v2",
	requests: [oldRequest, newRequest],
});
const operation = (id: string): V1.GuardOperationIdentity => ({
	version: "role-message-guard/v1",
	operationId: id,
	fingerprint: guardDigest({ id }),
	actor,
});
const refused: Extract<V1.GuardResult, { readonly state: "blocked" }> = {
	state: "blocked",
	reason: "compatibility_unproved",
	request: null,
	requiredTier: null,
	accepted: false,
};
function mutation(current: GuardStoreStateAny, identity: V1.GuardOperationIdentity): GuardAtomicMutationAny {
	const transaction = {
		state: "committed" as const,
		identity,
		transactionId: guardTransactionId(identity),
		result: refused,
	};
	if (current.version === "role-message-guard/v1") {
		return {
			next: { ...current, revision: identity.operationId, transactions: [...current.transactions, transaction] },
			legacyAccepted: [],
			result: refused,
		};
	}
	return {
		next: { ...current, revision: identity.operationId, transactions: [...current.transactions, transaction] },
		legacyAccepted: [],
		result: refused,
	};
}
async function fixture(seed: GuardStoreStateAny) {
	const dir = mkdtempSync(join(tmpdir(), "guard-store-v2-"));
	dirs.push(dir);
	const options: GuardFileStoreOptions = {
		journalPath: join(dir, "journal.json"),
		legacyPath: join(dir, "accepted.json"),
		maximumBytes: 32 * 1024 * 1024,
		withExclusive: (work) => work(),
		boundary: null,
	};
	const store = new GuardFileStore(options);
	expect((await store.initialize(seed, { v: 1, paused: false, messages: [] })).state).toBe("ready");
	return { store, options };
}

describe("strict revision-correlated store reader", () => {
	it("reads exact V1 and mixed S2 while the pinned previous reader refuses S2", () => {
		expect(guardStateIsValid(initial())).toBe(true);
		expect(previousStateIsValid(initial())).toBe(true);
		expect(guardStateIsValid(mixed())).toBe(true);
		expect(previousStateIsValid(mixed())).toBe(false);
	});
	it.each([
		["V2 request in S1", { ...initial(), requests: [oldRequest, newRequest] }],
		[
			"V1 binding with quantity10",
			{ ...mixed(), requests: [{ ...newRequest, binding: { ...newBinding, version: binding.version } }] },
		],
		[
			"V2 first answer under V1 binding",
			{ ...mixed(), requests: [{ ...oldRequest, firstDecision: { ...decision, binding: newBinding } }] },
		],
		["V1 first answer under V2 binding", { ...mixed(), requests: [{ ...newRequest, firstDecision: decision }] }],
		[
			"new Owner reason under V1 binding",
			{ ...mixed(), requests: [{ ...oldRequest, selectedApprover: { tier: "owner", reason: "hop_23_plus" } }] },
		],
		[
			"old Owner reason under V2 binding",
			{ ...mixed(), requests: [{ ...newRequest, selectedApprover: { tier: "owner", reason: "hop_12_plus" } }] },
		],
	])("refuses %s without relabelling it", (_name, value) => {
		expect(guardStateIsValid(value)).toBe(false);
	});
	it.each(["recorded", "blocked"] as const)("does not hide a V2 %s result in an S1 transaction", (state) => {
		const identity = operation(`nested-${state}`);
		const result =
			state === "recorded"
				? { state, transactionId: guardTransactionId(identity), request: newRequest, communicationAccepted: false }
				: { ...refused, request: newRequest };
		const transaction = { state: "committed", identity, transactionId: guardTransactionId(identity), result };
		expect(guardStateIsValid({ ...initial(), transactions: [transaction] })).toBe(false);
		expect(guardStateIsValid({ ...mixed(), transactions: [transaction] })).toBe(true);
	});
});

describe("single writer preserves old authority and never downgrades containers", () => {
	it("promotes only by normal atomic write and reads exact old grant fields after restart", async () => {
		const { store, options } = await fixture(initial());
		const identity = operation("promote-s2");
		const result = await store.transact(identity, async (current) => {
			const update = mutation(current, identity);
			return {
				...update,
				next: { ...update.next, version: "role-message-guard/v2", requests: [oldRequest, newRequest] },
			};
		});
		expect(result.state).toBe("committed");
		const bytes = readFileSync(options.journalPath);
		const fresh = new GuardFileStore(options);
		expect((await fresh.recover()).state).toBe("ready");
		const read = await fresh.read();
		if (read.state !== "ready") throw new Error("synthetic reader not ready");
		expect(read.value.version).toBe("role-message-guard/v2");
		expect(read.value.grants).toEqual([oldGrant]);
		expect(read.value.requests[0]).toEqual(oldRequest);
		expect(readFileSync(options.journalPath)).toEqual(bytes);
		await expect(legacyGuardFileStoreView(fresh).read()).rejects.toThrow("V1 fixture unexpectedly produced S2 state");
	});
	it("refuses a structurally valid S2-to-S1 mutation before any bytes change", async () => {
		const { store, options } = await fixture(mixed());
		const bytes = readFileSync(options.journalPath);
		const identity = operation("downgrade-s1");
		const result = await store.transact(identity, async () => mutation(initial(), identity));
		expect(result).toMatchObject({
			state: "not_committed",
			reason: "guard store policy revision cannot be downgraded",
		});
		expect(readFileSync(options.journalPath)).toEqual(bytes);
	});
	const grantChanges: [string, V1.GuardGrant][] = [
		["quantity", { ...oldGrant, maximumUses: 4, binding: { ...binding, quantity: 4, upperHop: 10 } }],
		["expiry", { ...oldGrant, expiresAt: oldGrant.expiresAt + 1 }],
		["scope", { ...oldGrant, binding: { ...binding, scope: { ...binding.scope, recipients: ["gamma"] } } }],
		["authority", { ...oldGrant, authority: { ...decision.authority, decisionId: "synthetic-different-decision" } }],
	];
	it.each(grantChanges)(
		"refuses to rewrite an old grant's %s during an otherwise valid S2 write",
		async (_name, changed) => {
			const { store, options } = await fixture(mixed());
			const bytes = readFileSync(options.journalPath);
			const identity = operation(`alter-old-${_name}`);
			const result = await store.transact(identity, async (current) => {
				const update = mutation(current, identity);
				return { ...update, next: { ...update.next, version: "role-message-guard/v2", grants: [changed] } };
			});
			expect(result).toMatchObject({
				state: "not_committed",
				reason: "issued grant authority, quantity, scope and expiry cannot change",
			});
			expect(readFileSync(options.journalPath)).toEqual(bytes);
		},
	);
	it("refuses to relabel an issued V1 grant as V2 even if its quantity stays three", async () => {
		const { store, options } = await fixture(mixed());
		const bytes = readFileSync(options.journalPath);
		const identity = operation("relabel-old-grant");
		const revisedBinding: GuardApprovalBindingV2 = {
			...binding,
			version: "role-message-guard/v2",
			causal: { ...binding.causal, nextHop: 13 },
			upperHop: 15,
		};
		const result = await store.transact(identity, async (current) => {
			const update = mutation(current, identity);
			return {
				...update,
				next: {
					...update.next,
					version: "role-message-guard/v2",
					grants: [{ ...oldGrant, binding: revisedBinding }],
				},
			};
		});
		expect(result).toMatchObject({
			state: "not_committed",
			reason: "issued grant authority, quantity, scope and expiry cannot change",
		});
		expect(readFileSync(options.journalPath)).toEqual(bytes);
	});
	it("refuses to reset exact historical use even while compatibility active limits remain old", async () => {
		const { store, options } = await fixture(mixed());
		const bytes = readFileSync(options.journalPath);
		const identity = operation("reset-use");
		const result = await store.transact(identity, async (current) => {
			const update = mutation(current, identity);
			return {
				...update,
				next: {
					...update.next,
					version: "role-message-guard/v2",
					grants: [{ ...oldGrant, acceptedUses: 0, useTransactionIds: [] }],
				},
			};
		});
		expect(result).toMatchObject({ state: "not_committed", reason: "grant use/refusal cannot be reset" });
		expect(readFileSync(options.journalPath)).toEqual(bytes);
	});
});
