/** I-PUB candidate-2 sidecar. No new C0 root, authority, I/O, pricing or aggregate. */
import { rtpiCanonical, rtpiParseCanonical, type RtpiJson } from "./rtpi-core.js";

export const REQUESTED_MAX_BYTES = 65536;
export const REQUESTED_STALE_MS = 86400000;
export const REQUESTED_PINS = Object.freeze({
	schema: "d88b6ca2709abea7113ae9c86f5ed153b93c7d6e11fc1d48b815f83be2ba00ea",
	spec: "72dbb8ee6ba7f9b2c56552bafa49ee40df127762c10440d605235b101af79f5a",
	oracles: "8b3c060ea8638955aef34ac75b54f1da8319dd021180c7df292f32ac99cfebee",
});
export type RequestedObject = { [key: string]: RtpiJson };
export class RequestedError extends Error {
	constructor(readonly reason: string) {
		super(reason);
	}
}
export function checkRequested(ok: unknown, reason: string): asserts ok {
	if (!ok) throw new RequestedError(reason);
}
export function requestedObject(value: RtpiJson): RequestedObject {
	checkRequested(typeof value === "object" && value !== null && !Array.isArray(value), "schema-object");
	return value;
}
export function exactText(pattern: RegExp, value: RtpiJson): value is string {
	return typeof value === "string" && pattern.exec(value)?.[0] === value;
}
function safeInteger(value: RtpiJson): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
interface Rule {
	ref?: string;
	constant?: RtpiJson;
	enum?: readonly RtpiJson[];
	pattern?: RegExp;
	integer?: number;
	nullable?: boolean;
	object?: Record<string, Rule>;
	array?: { item: Rule; max: number };
}
const r = (name: string): Rule => ({ ref: name });
const c = (value: RtpiJson): Rule => ({ constant: value });
const e = (...values: string[]): Rule => ({ enum: values });
const axis = e("complete", "partial", "unknown");
const defs: Record<string, Rule> = {
	id: { pattern: /^[A-Za-z0-9_.:-]{1,128}$/ },
	nonnegative: { integer: 0 },
	positive: { integer: 1 },
	count: { integer: 0, nullable: true },
	decimal: { pattern: /^(0|[1-9][0-9]{0,63})\.[0-9]{18}$/, nullable: true },
	ref: {
		object: {
			namespace: e("rtpi-native", "rtpi-fixture"),
			kind: e(
				"source",
				"issuer",
				"subject",
				"lineage",
				"role",
				"cohort",
				"origin",
				"allocation",
				"policy",
				"price",
				"dedup",
				"receipt",
				"attestation",
				"publication",
				"coverage",
			),
			id: r("id"),
			revision: r("id"),
		},
	},
	period: {
		object: {
			start: { pattern: /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00Z$/ },
			end: { pattern: /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00Z$/ },
			timezone: c("America/Los_Angeles"),
			timeBasis: c("attempt-terminal"),
		},
	},
	cohort: {
		object: {
			revision: r("ref"),
			originRevision: r("ref"),
			allocationRevision: r("ref"),
			accountingRole: r("ref"),
			membership: e("eligible", "unknown"),
		},
	},
	chargeScope: {
		object: {
			revision: r("ref"),
			token: axis,
			nonToken: e("complete", "partial", "unknown", "not-applicable"),
		},
	},
	coverage: {
		object: { capture: axis, pricing: axis, settlement: axis, origin: axis, allocation: axis, count: axis },
	},
	counts: {
		object: {
			unit: c("invocation-attempt"),
			requestedObserved: r("count"),
			fullyPriced: r("count"),
			partlyPriced: r("count"),
			unpriced: r("count"),
			pending: r("count"),
			attributionUnknownObserved: r("count"),
			missingSourceCount: r("count"),
			uniqueAttemptBasis: r("ref"),
		},
	},
	reason: e(
		"capture-unknown",
		"capture-partial",
		"activation-midweek",
		"pricing-unresolved",
		"price-semantics-unresolved",
		"price-applicability-unresolved",
		"tier-unresolved",
		"settlement-pending",
		"settlement-unresolved",
		"origin-unresolved",
		"allocation-unresolved",
		"count-unresolved",
		"time-unassigned",
		"mirror-conflict",
		"charge-scope-incomplete",
		"cohort-unresolved",
		"source-missing",
		"numeric-bound-exceeded",
	),
	attestation: {
		object: {
			schema: c("i-pub/attestation/1"),
			receipt: r("ref"),
			validatorVersion: c("i-pub/requested/1:candidate-2"),
			calculationVersion: c("i-pub/calc/1"),
			result: e("complete", "incomplete"),
		},
	},
};
const root: Rule = {
	object: {
		schema: c("i-pub/requested/1"),
		contractRevision: c("candidate-2"),
		objectId: r("id"),
		source: r("ref"),
		issuer: r("ref"),
		subject: r("ref"),
		lineage: r("ref"),
		incarnation: r("id"),
		publicationRevision: r("positive"),
		expectedRevision: r("nonnegative"),
		role: r("ref"),
		currency: c("USD"),
		valuation: c("list-price"),
		precision: c(18),
		rounding: c("HALF_EVEN"),
		period: r("period"),
		generatedAt: r("nonnegative"),
		asOf: r("nonnegative"),
		captureStart: r("nonnegative"),
		cohort: r("cohort"),
		chargeScope: r("chargeScope"),
		coverage: r("coverage"),
		state: e("known", "partial", "unpriced", "unknown"),
		knownAmount: r("decimal"),
		counts: r("counts"),
		reasons: { array: { item: r("reason"), max: 24 } },
		evidence: { array: { item: r("ref"), max: 32 } },
		attestation: r("attestation"),
	},
};
function structural(value: RtpiJson, rule: Rule): void {
	if (rule.ref) return structural(value, defs[rule.ref]);
	if (rule.nullable && value === null) return;
	if (Object.hasOwn(rule, "constant")) checkRequested(value === rule.constant, "schema-constant");
	if (rule.enum) checkRequested(rule.enum.includes(value), "schema-enum");
	if (rule.pattern) checkRequested(exactText(rule.pattern, value), "schema-token");
	if (rule.integer !== undefined) checkRequested(safeInteger(value) && value >= rule.integer, "schema-integer");
	if (rule.object) {
		const obj = requestedObject(value);
		const keys = Object.keys(rule.object);
		checkRequested(
			Object.keys(obj).length === keys.length && keys.every((key) => Object.hasOwn(obj, key)),
			"schema-keys",
		);
		for (const key of keys) structural(obj[key], rule.object[key]);
	}
	if (rule.array) {
		checkRequested(Array.isArray(value) && value.length <= rule.array.max, "schema-array");
		checkRequested(new Set(value.map((v) => rtpiCanonical(v))).size === value.length, "schema-duplicate");
		for (const item of value) structural(item, rule.array.item);
	}
}
export function requestedPeriodBounds(value: RtpiJson): { start: number; end: number } {
	structural(value, defs.period);
	const p = requestedObject(value);
	const formatter = new Intl.DateTimeFormat("en-US", {
		timeZone: "America/Los_Angeles",
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		weekday: "short",
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
		hourCycle: "h23",
	});
	const dates: number[] = [];
	const times = [p.start, p.end].map((text) => {
		checkRequested(typeof text === "string", "period-instant");
		const time = Date.parse(text);
		checkRequested(safeInteger(time) && new Date(time).toISOString().replace(".000Z", "Z") === text, "period-instant");
		const parts = Object.fromEntries(formatter.formatToParts(time).map((part) => [part.type, part.value]));
		checkRequested(
			parts.weekday === "Mon" && parts.hour === "00" && parts.minute === "00" && parts.second === "00",
			"period-local-boundary",
		);
		dates.push(Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day)));
		return time;
	});
	checkRequested(dates[1] - dates[0] === 7 * REQUESTED_STALE_MS, "period-successor");
	return { start: times[0], end: times[1] };
}
export function validateRequestedWire(input: string | Uint8Array, trustedNow: number): RequestedObject {
	const value = rtpiParseCanonical(input, REQUESTED_MAX_BYTES);
	structural(value, root);
	const v = requestedObject(value);
	checkRequested(safeInteger(trustedNow), "trusted-time");
	const bounds = requestedPeriodBounds(v.period);
	checkRequested(
		Number(v.captureStart) <= Number(v.asOf) &&
			Number(v.asOf) <= Number(v.generatedAt) &&
			Number(v.generatedAt) <= trustedNow,
		"publication-time",
	);
	checkRequested(Number(v.publicationRevision) === Number(v.expectedRevision) + 1, "publication-revision");
	let namespace: RtpiJson = null;
	let refs = 0;
	function ref(value: RtpiJson, kind?: string): RequestedObject {
		const obj = requestedObject(value);
		checkRequested(++refs <= 64 && (!kind || obj.kind === kind), "ref-kind");
		if (namespace === null) namespace = obj.namespace;
		checkRequested(obj.namespace === namespace, "ref-namespace");
		return obj;
	}
	for (const name of ["source", "issuer", "subject", "lineage", "role"]) ref(v[name], name);
	const cohort = requestedObject(v.cohort);
	ref(cohort.revision, "cohort");
	ref(cohort.originRevision, "origin");
	ref(cohort.allocationRevision, "allocation");
	ref(cohort.accountingRole, "role");
	checkRequested(rtpiCanonical(cohort.accountingRole) === rtpiCanonical(v.role), "cohort-binding");
	const scope = requestedObject(v.chargeScope);
	ref(scope.revision, "policy");
	const counts = requestedObject(v.counts);
	ref(counts.uniqueAttemptBasis, "dedup");
	const category = [counts.requestedObserved, counts.fullyPriced, counts.partlyPriced, counts.unpriced, counts.pending];
	const numbers = [...category, counts.attributionUnknownObserved, counts.missingSourceCount];
	if (v.knownAmount === null) {
		checkRequested(
			(counts.fullyPriced === null || counts.fullyPriced === 0) &&
				(counts.partlyPriced === null || counts.partlyPriced === 0),
			"count-known-part",
		);
	}
	if (category.every((n) => n !== null)) {
		checkRequested(
			category.slice(1).reduce<bigint>((sum, n) => sum + BigInt(Number(n)), 0n) === BigInt(Number(category[0])),
			"count-partition",
		);
	}
	const coverage = requestedObject(v.coverage);
	if (counts.missingSourceCount === null || Number(counts.missingSourceCount) > 0) {
		checkRequested(coverage.capture !== "complete" && coverage.count !== "complete", "count-source-gap");
	}
	checkRequested(Array.isArray(v.evidence) && Array.isArray(v.reasons), "schema-array");
	for (const item of v.evidence) {
		checkRequested(["price", "receipt", "coverage", "publication"].includes(String(ref(item).kind)), "evidence-kind");
	}
	const attestation = requestedObject(v.attestation);
	ref(attestation.receipt, "attestation");
	checkRequested((v.state === "known") === (attestation.result === "complete"), "attestation-state");
	const complete =
		Object.values(coverage).every((axis) => axis === "complete") &&
		cohort.membership === "eligible" &&
		scope.token === "complete" &&
		["complete", "not-applicable"].includes(String(scope.nonToken));
	if (v.state === "known") {
		checkRequested(
			complete &&
				v.knownAmount !== null &&
				numbers.every((n) => n !== null) &&
				counts.missingSourceCount === 0 &&
				counts.attributionUnknownObserved === 0 &&
				counts.pending === 0 &&
				counts.partlyPriced === 0 &&
				counts.unpriced === 0 &&
				Number(v.captureStart) <= bounds.start &&
				v.reasons.length === 0,
			"known-prerequisites",
		);
		if (counts.requestedObserved === 0) {
			checkRequested(
				v.knownAmount === "0.000000000000000000" &&
					numbers.every((n) => n === 0) &&
					v.evidence.some((r) => requestedObject(r).kind === "coverage"),
				"empty-proof",
			);
		}
	} else {
		checkRequested(!complete && (v.state === "partial") === (v.knownAmount !== null), "incomplete-state");
	}
	for (const [axis, reason] of [
		["pricing", "pricing-unresolved"],
		["settlement", "settlement-unresolved"],
		["origin", "origin-unresolved"],
		["allocation", "allocation-unresolved"],
		["count", "count-unresolved"],
	]) {
		if (coverage[axis] !== "complete") {
			checkRequested(
				v.reasons.includes(reason) || (axis === "settlement" && v.reasons.includes("settlement-pending")),
				"coverage-reason",
			);
		}
	}
	if (coverage.capture !== "complete") {
		checkRequested(
			v.reasons.includes(coverage.capture === "unknown" ? "capture-unknown" : "capture-partial"),
			"coverage-reason",
		);
	}
	if (cohort.membership === "unknown") checkRequested(v.reasons.includes("cohort-unresolved"), "cohort-reason");
	if (scope.token !== "complete" || !["complete", "not-applicable"].includes(String(scope.nonToken))) {
		checkRequested(v.reasons.includes("charge-scope-incomplete"), "scope-reason");
	}
	return v;
}
export function displayRequestedAmount(text: string): string {
	checkRequested(exactText(/^(0|[1-9][0-9]{0,63})\.[0-9]{18}$/, text), "amount-format");
	const ticks = BigInt(text.replace(".", ""));
	const unit = 10n ** 16n;
	const quotient = ticks / unit;
	const twice = (ticks % unit) * 2n;
	const cents = quotient + (twice > unit || (twice === unit && quotient % 2n === 1n) ? 1n : 0n);
	return `$${cents / 100n}.${(cents % 100n).toString().padStart(2, "0")}`;
}
