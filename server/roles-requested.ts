/** R10 P0 INERT. Individual role-reported views only; production importer intentionally absent. */
import { rtpiCanonical, type RtpiJson } from "./rtpi-core.js";
import {
	REQUESTED_MAX_BYTES,
	REQUESTED_STALE_MS,
	RequestedError,
	checkRequested,
	displayRequestedAmount,
	requestedObject,
	requestedPeriodBounds,
	validateRequestedWire,
	type RequestedObject,
} from "./roles-requested-contract.js";
import { nativeRequestedReader } from "./roles-requested-native.js";

export interface RequestedUnavailable {
	status: "unavailable";
	reason: "T04-native-reader-absent";
	label: "Role-reported list-price";
	aggregateAllowed: false;
}
/** No caller role/path/capability/helper options. Missing T04 returns before any publication I/O. */
export function readRequestedSpend(): RequestedUnavailable {
	nativeRequestedReader();
	return {
		status: "unavailable",
		reason: "T04-native-reader-absent",
		label: "Role-reported list-price",
		aggregateAllowed: false,
	};
}
export interface FixtureReaderBinding {
	rootId: string;
	publication: RequestedObject;
	viewPeriod: RtpiJson;
	trustedNow: number;
}
export interface FixtureReaderCapability {
	readonly namespace: "rtpi-fixture";
}
interface FixtureState {
	binding: FixtureReaderBinding;
	acceptedRevision: number;
	acceptedBytes: string | null;
}
const FIXTURES = new WeakMap<object, FixtureState>();
function frozenCopy<T>(value: T): T {
	const copy = JSON.parse(rtpiCanonical(value)) as T;
	function freeze(v: unknown): void {
		if (v && typeof v === "object") {
			for (const part of Object.values(v)) freeze(part);
			Object.freeze(v);
		}
	}
	freeze(copy);
	return copy;
}
/** Test-only fixture admission. No native constructor/registry exists; never a kernel/CAS proof. */
export function createRequestedReaderFixture(binding: FixtureReaderBinding): FixtureReaderCapability {
	const copy = frozenCopy(binding);
	checkRequested(/^[A-Za-z0-9_.:-]{1,128}$/.exec(copy.rootId)?.[0] === copy.rootId, "fixture-root");
	const publication = validateRequestedWire(rtpiCanonical(copy.publication), copy.trustedNow);
	checkRequested(requestedObject(publication.role).namespace === "rtpi-fixture", "fixture-only");
	requestedPeriodBounds(copy.viewPeriod);
	const cap = Object.freeze({ namespace: "rtpi-fixture" as const });
	FIXTURES.set(cap, {
		binding: copy,
		acceptedRevision: Number(publication.expectedRevision),
		acceptedBytes: null,
	});
	return cap;
}
export interface FixtureStat {
	dev: number;
	ino: number;
	size: number;
	mtimeNs: string;
	ctimeNs: string;
	nlink: number;
	kind: "regular" | "directory" | "fifo" | "device" | "symlink";
}
export interface FixtureDescriptorReceipt {
	schema: "i-pub/fd-fixture/1";
	namespace: "rtpi-fixture";
	rootId: string;
	basename: "requested-spend.json";
	components: { before: FixtureStat; after: FixtureStat }[];
	before: FixtureStat;
	after: FixtureStat;
	violations: string[];
	bytes: string;
}
const DESCRIPTOR_FAILURES = new Set([
	"ancestor-symlink",
	"root-symlink",
	"leaf-symlink",
	"rename-swap",
	"root-rename",
	"magic-link",
	"traversal",
	"hard-link",
	"fifo",
	"device",
	"oversize",
	"changed-during-read",
]);
function exactKeys(value: unknown, keys: readonly string[], reason: string): void {
	checkRequested(typeof value === "object" && value !== null && !Array.isArray(value), reason);
	checkRequested(Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key)), reason);
}
function stat(value: FixtureStat, kind: "regular" | "directory"): void {
	exactKeys(value, ["dev", "ino", "size", "mtimeNs", "ctimeNs", "nlink", "kind"], "descriptor-stat-schema");
	checkRequested(
		[value.dev, value.ino, value.size, value.nlink].every((n) => Number.isSafeInteger(n) && n >= 0) &&
			[value.mtimeNs, value.ctimeNs].every((n) => typeof n === "string" && /^[0-9]{1,32}$/.exec(n)?.[0] === n) &&
			value.kind === kind &&
			(kind !== "regular" || value.nlink === 1),
		"descriptor-stat-refused",
	);
}
function descriptor(receipt: FixtureDescriptorReceipt, binding: FixtureReaderBinding): string {
	exactKeys(
		receipt,
		["schema", "namespace", "rootId", "basename", "components", "before", "after", "violations", "bytes"],
		"descriptor-schema",
	);
	checkRequested(
		receipt.schema === "i-pub/fd-fixture/1" &&
			receipt.namespace === "rtpi-fixture" &&
			receipt.rootId === binding.rootId &&
			receipt.basename === "requested-spend.json",
		"descriptor-binding",
	);
	checkRequested(
		Array.isArray(receipt.violations) &&
			receipt.violations.length <= 12 &&
			receipt.violations.every((v) => DESCRIPTOR_FAILURES.has(v)),
		"descriptor-violations-schema",
	);
	checkRequested(receipt.violations.length === 0, `descriptor-${receipt.violations[0]}`);
	checkRequested(
		Array.isArray(receipt.components) && receipt.components.length > 0 && receipt.components.length <= 32,
		"descriptor-components",
	);
	for (const component of receipt.components) {
		exactKeys(component, ["before", "after"], "descriptor-component-schema");
		stat(component.before, "directory");
		stat(component.after, "directory");
		checkRequested(rtpiCanonical(component.before) === rtpiCanonical(component.after), "descriptor-component-changed");
	}
	stat(receipt.before, "regular");
	stat(receipt.after, "regular");
	checkRequested(
		typeof receipt.bytes === "string" &&
			receipt.before.size <= REQUESTED_MAX_BYTES &&
			Buffer.byteLength(receipt.bytes, "utf8") <= REQUESTED_MAX_BYTES,
		"descriptor-oversize",
	);
	checkRequested(
		rtpiCanonical(receipt.before) === rtpiCanonical(receipt.after) &&
			receipt.before.size === Buffer.byteLength(receipt.bytes, "utf8"),
		"descriptor-changed-during-read",
	);
	return receipt.bytes;
}
export interface RequestedFixtureView {
	status: "fixture";
	label: "Role-reported list-price";
	aggregateAllowed: false;
	placement: "current" | "last-known";
	displayTotal: string | null;
	displayKnownParts: string | null;
	publication: RequestedObject;
	viewReasons: string[];
	idempotent: boolean;
	proof: "adapter-fixture-only-not-kernel-or-durable-CAS";
}
export type RequestedFixtureResult = RequestedFixtureView | { status: "refused"; reason: string };
/** Takes a branded fixture, never a real path/FD/reader. Refusals have no fallback or write. */
export function readRequestedSpendFixture(
	capability: unknown,
	receipt: FixtureDescriptorReceipt,
): RequestedFixtureResult {
	try {
		checkRequested(
			typeof capability === "object" && capability !== null && FIXTURES.has(capability),
			"fixture-capability-refused",
		);
		const fixture = FIXTURES.get(capability)!;
		const bytes = descriptor(receipt, fixture.binding);
		const pub = validateRequestedWire(bytes, fixture.binding.trustedNow);
		const expected = fixture.binding.publication;
		for (const key of ["source", "issuer", "subject", "lineage", "incarnation", "role", "objectId", "period"]) {
			checkRequested(rtpiCanonical(pub[key]) === rtpiCanonical(expected[key]), `mapping-${key}`);
		}
		for (const key of ["cohort", "chargeScope", "counts", "attestation"]) {
			const current = requestedObject(pub[key]);
			const bound = requestedObject(expected[key]);
			const refs =
				key === "cohort"
					? ["revision", "originRevision", "allocationRevision", "accountingRole"]
					: key === "chargeScope"
						? ["revision"]
						: key === "counts"
							? ["uniqueAttemptBasis"]
							: ["receipt"];
			for (const field of refs)
				checkRequested(rtpiCanonical(current[field]) === rtpiCanonical(bound[field]), `mapping-${key}-${field}`);
		}
		const revision = Number(pub.publicationRevision);
		const predecessor = Number(pub.expectedRevision);
		let idempotent = false;
		if (revision === fixture.acceptedRevision) {
			checkRequested(fixture.acceptedBytes === bytes, "publication-conflict");
			idempotent = true;
		} else {
			checkRequested(
				predecessor === fixture.acceptedRevision && revision === fixture.acceptedRevision + 1,
				"publication-predecessor",
			);
			fixture.acceptedRevision = revision;
			fixture.acceptedBytes = bytes;
		}
		const viewReasons: string[] = [];
		if (fixture.binding.trustedNow - Number(pub.asOf) > REQUESTED_STALE_MS) viewReasons.push("asOf-older-than-24h");
		if (rtpiCanonical(pub.period) !== rtpiCanonical(fixture.binding.viewPeriod)) viewReasons.push("period-mismatch");
		const placement = viewReasons.length > 0 ? "last-known" : "current";
		const amount = typeof pub.knownAmount === "string" ? pub.knownAmount : null;
		const display = amount === null ? null : displayRequestedAmount(amount);
		return {
			status: "fixture",
			label: "Role-reported list-price",
			aggregateAllowed: false,
			placement,
			displayTotal: pub.state === "known" ? display : null,
			displayKnownParts: pub.state === "partial" && display !== "$0.00" ? display : null,
			publication: frozenCopy(pub),
			viewReasons,
			idempotent,
			proof: "adapter-fixture-only-not-kernel-or-durable-CAS",
		};
	} catch (error) {
		return { status: "refused", reason: error instanceof RequestedError ? error.reason : "publication-invalid" };
	}
}
