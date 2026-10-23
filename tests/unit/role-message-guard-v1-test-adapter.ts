// Explicit legacy-only view for frozen golden/replay fixtures, not a production downgrade reader.
// Any unexpected S2 state or V2 result fails loudly; no value is relabelled, filtered or cast.
import type {
	GuardCommitResult,
	GuardReadResult,
	GuardResult,
	GuardStorePort,
	GuardStoreState,
} from "../../server/role-message-guard-contract.js";
import type {
	GuardCommitResultAny,
	GuardReadResultAny,
	GuardResultAny,
} from "../../server/role-message-guard-contract-v2.js";
import type { GuardFileStore, GuardLegacyFile } from "../../server/role-message-guard-store.js";
import { guardRequestRevisionValid } from "../../server/role-message-limits.js";

type PersistedV1 = Exclude<GuardResult, { readonly state: "unknown" }>;
type PersistedAny = Exclude<GuardResultAny, { readonly state: "unknown" }>;
export type LegacyGuardFileStoreView = GuardStorePort & {
	initialize(state: GuardStoreState, legacy: GuardLegacyFile): Promise<GuardReadResult>;
};

function legacyRead(value: GuardReadResultAny): GuardReadResult {
	if (value.state !== "ready") return value;
	if (value.value.version !== "role-message-guard/v1") throw new Error("V1 fixture unexpectedly produced S2 state");
	return { state: "ready", value: value.value };
}
function legacyResult(value: PersistedAny): PersistedV1;
function legacyResult(value: GuardResultAny): GuardResult;
function legacyResult(value: GuardResultAny): GuardResult {
	if (value.state !== "recorded" && value.state !== "blocked") return value;
	if (value.state === "blocked" && value.request === null) return { ...value, request: null };
	if (!guardRequestRevisionValid(value.request, "role-message-guard/v1")) {
		throw new Error("V1 fixture unexpectedly produced a V2 or malformed request result");
	}
	return { ...value, request: value.request };
}
function legacyCommit(value: GuardCommitResultAny): GuardCommitResult {
	return value.state === "committed" ? { ...value, result: legacyResult(value.result) } : value;
}

/** All assertions/expected bytes remain V1; callback input and output stay V1 too. */
export function legacyGuardFileStoreView(store: GuardFileStore): LegacyGuardFileStoreView {
	return {
		async initialize(state, legacy) {
			return legacyRead(await store.initialize(state, legacy));
		},
		async read() {
			return legacyRead(await store.read());
		},
		async recover() {
			return legacyRead(await store.recover());
		},
		async lookup(identity) {
			const value = await store.lookup(identity);
			return value.state === "found" ? { state: "found", result: legacyResult(value.result) } : value;
		},
		async transact(identity, update) {
			const value = await store.transact(identity, async (current) => {
				if (current.version !== "role-message-guard/v1") {
					throw new Error("V1 fixture callback unexpectedly received S2 state");
				}
				return update(current);
			});
			return legacyCommit(value);
		},
	};
}
