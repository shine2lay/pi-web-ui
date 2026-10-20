/** Inert reporting contract. No I/O, hooks, authority registration, debit or stop. */
export const USAGE_ACCOUNTING_VERSION = 1;
export type Usd = string;
export type Basis = "list-estimate" | "provider-reported" | "invoice";
export type Producer = "pi" | "acp" | "temper";
export type Scope = "own" | "requested" | "team" | "unknown";
export type Completeness = "complete" | "partial" | "unknown";
export interface Price {
	basis: Basis;
	currency: "USD";
	amount: Usd | null;
	status: "known" | "unpriced" | "unknown-model" | "basis-unproven";
	rateVersion: string | null;
}
export interface Tokens {
	input: number | null;
	output: number | null;
	cacheRead: number | null;
	cacheWrite: number | null;
}
export interface CallIdentity {
	producer: Producer;
	incarnation: string;
	attempt: string;
}
export interface TaskMembership {
	queue: string;
	task: number;
	addedAt: string;
	project: string | null;
	initiative: string | null;
	effectiveAt: string;
}
export interface UsageFact {
	v: "usage-fact/1";
	id: string;
	revision: number;
	supersedes: number | null;
	identity: CallIdentity;
	identityStatus: "verified" | "unresolved";
	occurredAt: string;
	provider: string;
	model: string;
	kind: "assistant" | "cache-warm" | "compaction" | "delegate";
	tokens: Tokens;
	prices: Price[];
	source: { stream: string; event: string; observedAt: string; coverage: Completeness };
	links: { task: TaskMembership | null; session: string | null; run: string | null };
}
export interface Allocation {
	v: "allocation/1";
	factId: string;
	revision: number;
	supersedes: number | null;
	rootRef: string | null;
	scope: Scope;
	policyRef: string | null;
	payerRole: string | null;
	recordedAt: string;
	reason: "native-root" | "missing-root" | "mixed-root" | "legacy";
}
/** Projections from a future vetted native store, NOT a way to register a root. */
export interface DispatchRoot {
	ref: string;
	scopeRef: string;
	scope: Exclude<Scope, "unknown">;
	occurredAt: string;
	policyRef: string | null;
	payerRole: string;
	provenance: "trusted-native/1";
	evidenceRef: string;
}
export interface ReportingPolicy {
	ref: string;
	role: string;
	scopeRef: string;
	effectiveAt: string;
	weeklyUsd: Usd;
	basis: "list-estimate";
	timeZone: "America/Los_Angeles";
	sourceRef: string;
}
/** A prospective native mapping of two observations of the SAME actual attempt. */
export interface IdentityAlias {
	aliasFactId: string;
	canonicalFactId: string;
	provenance: "native-call-map/1";
	evidenceRef: string;
}
export interface SourceCoverage {
	stream: string;
	from: string;
	through: string;
	observedAt: string;
	status: Completeness | "unavailable";
}
/** Upsert by producer/incarnation/run, never add to facts or another snapshot. */
export interface RunSnapshot {
	producer: Producer;
	incarnation: string;
	run: string;
	observedAt: string;
	state: "running" | "parked" | "ended";
	price: Price;
	coveredFactIds: string[];
	coverage: Completeness;
}
export interface AccountingInput {
	v: 1;
	facts: UsageFact[];
	allocations: Allocation[];
	aliases: IdentityAlias[];
	roots: DispatchRoot[];
	policies: ReportingPolicy[];
	/** Canonical-parent history, including original task birth and reparent events. */
	memberships: TaskMembership[];
	snapshots: RunSnapshot[];
	coverage: SourceCoverage[];
	requiredStreams: string[];
}
export interface AccountingFault {
	code: string;
	ref: string;
}
export interface AccountingReport {
	v: 1;
	reportingOnly: true;
	policyRef: string;
	weekStart: string;
	asOf: string;
	grossKnownListUsd: Usd;
	dedupKnownListUsd: Usd;
	verifiedOwnLowerBoundUsd: Usd;
	exemptKnownListUsd: Usd;
	otherPolicyKnownListUsd: Usd;
	unallocatedKnownListUsd: Usd;
	/** These are NOT added to list estimates or to one another. */
	otherBases: { basis: "provider-reported" | "invoice"; knownUsd: Usd; unpriced: number }[];
	unpricedFacts: number;
	unallocatedFacts: number;
	unresolvedIdentities: number;
	coverage: "complete" | "partial";
	freshness: "fresh" | "stale";
	remainingUsd: Usd | null;
	faults: AccountingFault[];
}

export interface UsageWindow {
	from: string;
	through: string;
}
export interface ObserveUsageOptions {
	asOf: string;
	staleAfterMs: number;
	window: UsageWindow;
}
/** Usage evidence only. No allocation, policy, payer or budget conclusions. */
export interface ObservedUsageReport {
	v: "observed-usage/1";
	reportingOnly: true;
	asOf: string;
	window: UsageWindow;
	grossKnownListUsd: Usd;
	dedupKnownListUsd: Usd;
	otherBases: AccountingReport["otherBases"];
	unpricedFacts: number;
	unresolvedIdentities: number;
	usageCoverage: "complete" | "partial";
	freshness: "fresh" | "stale";
	faults: AccountingFault[];
}
interface ObservedEvidence {
	input: AccountingInput;
	options: ObserveUsageOptions;
	report: ObservedUsageReport;
	facts: Map<string, UsageFact>;
	groups: Map<string, UsageFact[]>;
	allCharges: UsageFact[];
	counted: UsageFact[];
}

const SCALE = 1_000_000_000_000n;
const DECIMAL = /^(0|[1-9]\d{0,17})(?:\.\d{1,12})?$/;
const REF = /^[A-Za-z0-9_./:@+-]{1,256}$/;
const BASIS = ["list-estimate", "provider-reported", "invoice"];
const PRODUCERS = ["pi", "acp", "temper"];
const COMPLETENESS = ["complete", "partial", "unknown"];
const SCOPES = ["own", "requested", "team", "unknown"];
class ContractViolation extends Error {}
function requireValue(ok: unknown, code: string): asserts ok {
	if (!ok) throw new ContractViolation(code);
}
function object(raw: unknown, fields: string[]): Record<string, unknown> {
	requireValue(raw !== null && typeof raw === "object" && !Array.isArray(raw), "object");
	const value = raw as Record<string, unknown>;
	requireValue(
		Object.keys(value).length === fields.length && fields.every((k) => Object.hasOwn(value, k)),
		"closed-fields",
	);
	return value;
}
function ref(raw: unknown): void {
	requireValue(typeof raw === "string" && REF.test(raw), "reference");
}
function nullableRef(raw: unknown): void {
	if (raw !== null) ref(raw);
}
function factReference(raw: unknown): void {
	requireValue(typeof raw === "string" && raw.length <= 800, "fact-reference");
	let tuple: unknown;
	try {
		tuple = JSON.parse(raw);
	} catch {
		throw new ContractViolation("fact-reference");
	}
	requireValue(Array.isArray(tuple) && tuple.length === 4 && tuple[0] === "usage-fact/1", "fact-reference");
	oneOf(tuple[1], PRODUCERS);
	ref(tuple[2]);
	ref(tuple[3]);
	requireValue(JSON.stringify(tuple) === raw, "fact-reference");
}
function oneOf(raw: unknown, values: readonly unknown[]): void {
	requireValue(values.includes(raw), "enum");
}
function uint(raw: unknown): void {
	requireValue(typeof raw === "number" && Number.isSafeInteger(raw) && raw >= 0, "integer");
}
function timestamp(raw: unknown): void {
	requireValue(typeof raw === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(raw), "timestamp");
	requireValue(Number.isFinite(Date.parse(raw)) && new Date(raw).toISOString() === raw, "timestamp");
}
function usd(raw: unknown): void {
	requireValue(typeof raw === "string" && DECIMAL.test(raw), "decimal-usd");
}
function list(raw: unknown, validate: (item: unknown) => void): void {
	requireValue(Array.isArray(raw) && raw.length <= 100_000, "array");
	for (const item of raw) validate(item);
}
function revision(value: Record<string, unknown>): void {
	uint(value.revision);
	requireValue(value.supersedes === (value.revision === 0 ? null : Number(value.revision) - 1), "revision-chain");
}
function validateTokens(raw: unknown): void {
	const v = object(raw, ["input", "output", "cacheRead", "cacheWrite"]);
	for (const value of Object.values(v)) if (value !== null) uint(value);
}
function validatePrice(raw: unknown): void {
	const v = object(raw, ["basis", "currency", "amount", "status", "rateVersion"]);
	oneOf(v.basis, BASIS);
	requireValue(v.currency === "USD", "currency");
	oneOf(v.status, ["known", "unpriced", "unknown-model", "basis-unproven"]);
	nullableRef(v.rateVersion);
	if (v.status === "known") {
		usd(v.amount);
		if (v.basis === "list-estimate") ref(v.rateVersion);
	} else requireValue(v.amount === null, "unknown-price-not-zero");
}
function validateMembership(raw: unknown): void {
	const v = object(raw, ["queue", "task", "addedAt", "project", "initiative", "effectiveAt"]);
	ref(v.queue);
	uint(v.task);
	requireValue(Number(v.task) > 0, "task-number");
	timestamp(v.addedAt);
	timestamp(v.effectiveAt);
	requireValue(String(v.addedAt) <= String(v.effectiveAt), "task-birth");
	nullableRef(v.project);
	nullableRef(v.initiative);
}
function validateFact(raw: unknown): void {
	const v = object(raw, [
		"v",
		"id",
		"revision",
		"supersedes",
		"identity",
		"identityStatus",
		"occurredAt",
		"provider",
		"model",
		"kind",
		"tokens",
		"prices",
		"source",
		"links",
	]);
	requireValue(v.v === "usage-fact/1", "fact-version");
	revision(v);
	const identity = object(v.identity, ["producer", "incarnation", "attempt"]);
	oneOf(identity.producer, PRODUCERS);
	ref(identity.incarnation);
	ref(identity.attempt);
	requireValue(v.id === factId(identity as unknown as CallIdentity), "fact-id");
	oneOf(v.identityStatus, ["verified", "unresolved"]);
	timestamp(v.occurredAt);
	ref(v.provider);
	ref(v.model);
	oneOf(v.kind, ["assistant", "cache-warm", "compaction", "delegate"]);
	validateTokens(v.tokens);
	list(v.prices, validatePrice);
	const prices = v.prices as Price[];
	requireValue(
		new Set(prices.map((p) => p.basis)).size === prices.length && prices.some((p) => p.basis === "list-estimate"),
		"price-bases",
	);
	const source = object(v.source, ["stream", "event", "observedAt", "coverage"]);
	ref(source.stream);
	ref(source.event);
	timestamp(source.observedAt);
	requireValue(String(source.observedAt) >= String(v.occurredAt), "observation-time");
	oneOf(source.coverage, COMPLETENESS);
	const links = object(v.links, ["task", "session", "run"]);
	if (links.task !== null) {
		validateMembership(links.task);
		requireValue(String((links.task as TaskMembership).effectiveAt) <= String(v.occurredAt), "future-membership");
	}
	nullableRef(links.session);
	nullableRef(links.run);
}
function validateAllocation(raw: unknown): void {
	const v = object(raw, [
		"v",
		"factId",
		"revision",
		"supersedes",
		"rootRef",
		"scope",
		"policyRef",
		"payerRole",
		"recordedAt",
		"reason",
	]);
	requireValue(v.v === "allocation/1", "allocation-version");
	factReference(v.factId);
	revision(v);
	timestamp(v.recordedAt);
	nullableRef(v.rootRef);
	nullableRef(v.policyRef);
	nullableRef(v.payerRole);
	oneOf(v.scope, SCOPES);
	oneOf(v.reason, ["native-root", "missing-root", "mixed-root", "legacy"]);
	if (v.scope === "unknown")
		requireValue(v.rootRef === null && v.policyRef === null && v.reason !== "native-root", "unknown-allocation");
	else requireValue(v.rootRef !== null && v.payerRole !== null && v.reason === "native-root", "native-root-required");
}
/** Closed JSON validator. No passthrough metadata/payload bags. */
export function parseAccountingInput(raw: unknown): { ok: true; value: AccountingInput } | { ok: false; code: string } {
	try {
		const v = object(raw, [
			"v",
			"facts",
			"allocations",
			"aliases",
			"roots",
			"policies",
			"memberships",
			"snapshots",
			"coverage",
			"requiredStreams",
		]);
		requireValue(v.v === 1, "contract-version");
		list(v.facts, validateFact);
		list(v.allocations, validateAllocation);
		list(v.memberships, validateMembership);
		list(v.aliases, (rawAlias) => {
			const a = object(rawAlias, ["aliasFactId", "canonicalFactId", "provenance", "evidenceRef"]);
			factReference(a.aliasFactId);
			factReference(a.canonicalFactId);
			requireValue(a.aliasFactId !== a.canonicalFactId && a.provenance === "native-call-map/1", "alias");
			ref(a.evidenceRef);
		});
		list(v.roots, (rawRoot) => {
			const r = object(rawRoot, [
				"ref",
				"scopeRef",
				"scope",
				"occurredAt",
				"policyRef",
				"payerRole",
				"provenance",
				"evidenceRef",
			]);
			for (const k of ["ref", "scopeRef", "payerRole", "evidenceRef"]) ref(r[k]);
			timestamp(r.occurredAt);
			nullableRef(r.policyRef);
			oneOf(r.scope, ["own", "requested", "team"]);
			requireValue(
				r.provenance === "trusted-native/1" && (r.scope === "own" ? r.policyRef !== null : r.policyRef === null),
				"root-policy",
			);
		});
		list(v.policies, (rawPolicy) => {
			const p = object(rawPolicy, [
				"ref",
				"role",
				"scopeRef",
				"effectiveAt",
				"weeklyUsd",
				"basis",
				"timeZone",
				"sourceRef",
			]);
			for (const k of ["ref", "role", "scopeRef", "sourceRef"]) ref(p[k]);
			timestamp(p.effectiveAt);
			usd(p.weeklyUsd);
			requireValue(p.basis === "list-estimate" && p.timeZone === "America/Los_Angeles", "policy-basis");
		});
		list(v.coverage, (rawCoverage) => {
			const c = object(rawCoverage, ["stream", "from", "through", "observedAt", "status"]);
			ref(c.stream);
			for (const k of ["from", "through", "observedAt"]) timestamp(c[k]);
			requireValue(String(c.from) <= String(c.through) && String(c.through) <= String(c.observedAt), "coverage-time");
			oneOf(c.status, [...COMPLETENESS, "unavailable"]);
		});
		list(v.snapshots, (rawSnapshot) => {
			const s = object(rawSnapshot, [
				"producer",
				"incarnation",
				"run",
				"observedAt",
				"state",
				"price",
				"coveredFactIds",
				"coverage",
			]);
			oneOf(s.producer, PRODUCERS);
			ref(s.incarnation);
			ref(s.run);
			timestamp(s.observedAt);
			oneOf(s.state, ["running", "parked", "ended"]);
			validatePrice(s.price);
			list(s.coveredFactIds, factReference);
			oneOf(s.coverage, COMPLETENESS);
		});
		list(v.requiredStreams, ref);
		requireValue(
			(v.requiredStreams as string[]).length > 0 &&
				new Set(v.requiredStreams as string[]).size === (v.requiredStreams as string[]).length,
			"required-streams",
		);
		return { ok: true, value: raw as AccountingInput };
	} catch (error) {
		return { ok: false, code: error instanceof ContractViolation ? error.message : "invalid" };
	}
}
export function factId(identity: CallIdentity): string {
	return JSON.stringify(["usage-fact/1", identity.producer, identity.incarnation, identity.attempt]);
}
export function taskId(task: Pick<TaskMembership, "queue" | "task" | "addedAt">): string {
	return JSON.stringify([task.queue, task.task, task.addedAt]);
}
function units(value: Usd): bigint {
	usd(value);
	const [whole, fraction = ""] = value.split(".");
	return BigInt(whole) * SCALE + BigInt(fraction.padEnd(12, "0"));
}
function decimal(value: bigint): Usd {
	const fraction = (value % SCALE).toString().padStart(12, "0").replace(/0+$/, "");
	return `${value / SCALE}${fraction ? `.${fraction}` : ""}`;
}
export function addUsd(values: readonly Usd[]): Usd {
	return decimal(values.reduce((total, value) => total + units(value), 0n));
}
/** Exclusive token classes; rates are versioned USD per million, no fallback model. */
export function quoteListUsd(tokens: Tokens, rates: Record<keyof Tokens, Usd>): Usd | null {
	validateTokens(tokens);
	let numerator = 0n;
	for (const key of ["input", "output", "cacheRead", "cacheWrite"] as const) {
		if (tokens[key] === null) return null;
		numerator += BigInt(tokens[key]) * units(rates[key]);
	}
	requireValue(numerator % 1_000_000n === 0n, "price-precision");
	return decimal(numerator / 1_000_000n);
}
/** Pacific calendar Monday, not a fixed UTC offset or the task creation week. */
export function pacificWeekStart(occurredAt: string): string {
	timestamp(occurredAt);
	const parts = new Intl.DateTimeFormat("en-US", {
		timeZone: "America/Los_Angeles",
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
	}).formatToParts(new Date(occurredAt));
	const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
	const day = new Date(Date.UTC(get("year"), get("month") - 1, get("day")));
	day.setUTCDate(day.getUTCDate() - ((day.getUTCDay() + 6) % 7));
	return day.toISOString().slice(0, 10);
}
export function pacificWeekStartUtc(occurredAt: string): string {
	const date = pacificWeekStart(occurredAt);
	const noon = new Date(`${date}T12:00:00.000Z`);
	const zone = new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", timeZoneName: "longOffset" })
		.formatToParts(noon)
		.find((p) => p.type === "timeZoneName")?.value;
	const offset = zone?.match(/^GMT([+-])(\d{2}):(\d{2})$/);
	requireValue(offset, "pacific-offset");
	const minutes = (Number(offset[2]) * 60 + Number(offset[3])) * (offset[1] === "+" ? 1 : -1);
	return new Date(Date.parse(`${date}T00:00:00.000Z`) - minutes * 60_000).toISOString();
}
function canonical(raw: unknown): string {
	if (Array.isArray(raw)) return `[${raw.map(canonical).join(",")}]`;
	if (raw !== null && typeof raw === "object")
		return `{${Object.entries(raw)
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
			.join(",")}}`;
	return JSON.stringify(raw) ?? "undefined";
}
/** Retain all revisions externally; select only an unbroken, unambiguous chain. */
function latest<T extends { revision: number }>(
	rows: T[],
	key: (row: T) => string,
	fault: (code: string, ref: string) => void,
): Map<string, T> {
	const groups = new Map<string, Map<number, T>>();
	const bad = new Set<string>();
	for (const row of rows) {
		const id = key(row);
		const versions = groups.get(id) ?? new Map<number, T>();
		const old = versions.get(row.revision);
		if (old && canonical(old) !== canonical(row)) bad.add(id);
		versions.set(row.revision, row);
		groups.set(id, versions);
	}
	const result = new Map<string, T>();
	for (const [id, versions] of groups) {
		const max = Math.max(...versions.keys());
		if (bad.has(id) || versions.size !== max + 1) fault("revision-conflict", id);
		else result.set(id, versions.get(max)!);
	}
	return result;
}
function unique<T>(rows: T[], key: (row: T) => string, fault: (code: string, ref: string) => void): Map<string, T> {
	const result = new Map<string, T>();
	const bad = new Set<string>();
	for (const row of rows) {
		const id = key(row);
		if (result.has(id) && canonical(result.get(id)) !== canonical(row)) bad.add(id);
		result.set(id, row);
	}
	for (const id of bad) {
		fault("record-conflict", id);
		result.delete(id);
	}
	return result;
}
/** Reject a foreign task/birth or today's parent substituted for an older event. */
export function checkTaskBinding(fact: UsageFact, history: TaskMembership[]): "verified" | "unassigned" | "mismatch" {
	const task = fact.links.task;
	if (!task) return "unassigned";
	const candidates = history.filter((m) => taskId(m) === taskId(task) && m.effectiveAt <= fact.occurredAt);
	const at = candidates
		.map((m) => m.effectiveAt)
		.sort()
		.at(-1);
	const current = candidates.filter((m) => m.effectiveAt === at);
	return current.length > 0 && current.every((m) => canonical(m) === canonical(task)) ? "verified" : "mismatch";
}
function amount(fact: UsageFact, basis: Basis): Usd | null {
	return fact.prices.find((p) => p.basis === basis)?.amount ?? null;
}
function mergeCharge(group: UsageFact[], primary: UsageFact): UsageFact | null {
	if (
		group.some(
			(f) =>
				f.occurredAt !== primary.occurredAt ||
				f.provider !== primary.provider ||
				f.model !== primary.model ||
				f.kind !== primary.kind,
		)
	)
		return null;
	const merged = { ...primary, tokens: { ...primary.tokens }, prices: [...primary.prices] };
	const ordered = [primary, ...group.filter((f) => f.id !== primary.id).sort((a, b) => a.id.localeCompare(b.id))];
	for (const k of ["input", "output", "cacheRead", "cacheWrite"] as const) {
		const known = ordered.map((f) => f.tokens[k]).filter((n) => n !== null);
		if (new Set(known).size > 1) return null;
		merged.tokens[k] = known[0] ?? null;
	}
	for (const basis of BASIS as Basis[]) {
		const known = ordered.flatMap((f) => f.prices.filter((p) => p.basis === basis && p.amount !== null));
		if (new Set(known.map((p) => units(p.amount!))).size > 1) return null;
		if (known.length > 0) merged.prices = [...merged.prices.filter((p) => p.basis !== basis), known[0]];
	}
	return merged;
}
/** Producer-only reconciliation of numeric snapshots; NEVER another ledger charge. */
export function reconcileTemperUsd(input: {
	finalUsd: Usd | null;
	parkedFloorUsd: Usd | null;
	agents: { endedUsd: Usd | null; callsUsd: Usd[] }[];
}): { spendUsd: Usd; displayFloorUsd: Usd } {
	const spend =
		input.finalUsd !== null
			? units(input.finalUsd)
			: input.agents.reduce((total, agent) => {
					const calls = units(addUsd(agent.callsUsd));
					const ended = agent.endedUsd === null ? 0n : units(agent.endedUsd);
					return total + (calls > ended ? calls : ended);
				}, 0n);
	const floor = input.parkedFloorUsd === null ? 0n : units(input.parkedFloorUsd);
	return {
		spendUsd: decimal(spend),
		displayFloorUsd: decimal(input.finalUsd !== null || spend >= floor ? spend : floor),
	};
}

/** Shared pure observation, retaining internal evidence for the separate budget step. */
function observeEvidence(raw: unknown, options: ObserveUsageOptions): ObservedEvidence {
	const parsed = parseAccountingInput(raw);
	requireValue(parsed.ok, parsed.ok ? "invalid" : parsed.code);
	timestamp(options.asOf);
	uint(options.staleAfterMs);
	timestamp(options.window.from);
	timestamp(options.window.through);
	requireValue(options.window.from <= options.window.through && options.window.through <= options.asOf, "usage-window");
	const input = parsed.value;
	const faults: AccountingFault[] = [];
	const fault = (code: string, ref: string) => {
		faults.push({ code, ref });
	};
	const observedFacts = input.facts.filter((f) => f.source.observedAt <= options.asOf);
	const facts = latest(observedFacts, (f) => f.id, fault);
	// A revision may repair price/tokens, never rewrite original call identity/time/links.
	for (const f of facts.values()) {
		if (
			observedFacts.some(
				(old) => old.id === f.id && (old.occurredAt !== f.occurredAt || canonical(old.links) !== canonical(f.links)),
			)
		)
			fault("rewritten-occurrence", f.id);
	}
	const eligible = [...facts.values()].filter((f) => f.occurredAt <= options.asOf);
	const inWindow = (f: UsageFact) => f.occurredAt >= options.window.from && f.occurredAt <= options.window.through;
	const visible = eligible.filter(inWindow);
	const badAliases = new Set<string>();
	const aliases = unique(
		input.aliases,
		(a) => a.aliasFactId,
		(code, id) => {
			fault(code, id);
			for (const a of input.aliases.filter((a) => a.aliasFactId === id)) {
				badAliases.add(a.aliasFactId);
				badAliases.add(a.canonicalFactId);
			}
		},
	);
	for (const a of aliases.values())
		if (!facts.has(a.aliasFactId) || !facts.has(a.canonicalFactId)) fault("missing-alias-target", a.aliasFactId);
	const resolve = (id: string): string | null => {
		const seen = new Set<string>();
		let next = id;
		while (aliases.has(next)) {
			if (badAliases.has(next)) return null;
			if (seen.has(next)) {
				fault("alias-cycle", id);
				return null;
			}
			seen.add(next);
			next = aliases.get(next)!.canonicalFactId;
		}
		return facts.has(next) && !badAliases.has(next) ? next : null;
	};
	const groups = new Map<string, UsageFact[]>();
	let unresolvedIdentities = 0;
	const events = new Map<string, string>();
	const collisions = new Set<string>();
	for (const f of facts.values()) {
		const key = JSON.stringify([f.identity.producer, f.identity.incarnation, f.source.stream, f.source.event]);
		const old = events.get(key);
		if (old && old !== f.id) {
			collisions.add(old);
			collisions.add(f.id);
		}
		events.set(key, f.id);
	}
	for (const f of eligible) {
		const id = resolve(f.id);
		if (id === null || f.identityStatus === "unresolved" || collisions.has(f.id)) {
			unresolvedIdentities++;
			fault("unresolved-identity", f.id);
			continue;
		}
		groups.set(id, [...(groups.get(id) ?? []), f]);
	}
	const allCharges: UsageFact[] = [];
	for (const [id, group] of groups) {
		const primary = facts.get(id)!;
		const merged = mergeCharge(group, primary);
		if (!group.some((f) => f.id === id) || merged === null) {
			unresolvedIdentities++;
			fault("identity-conflict", id);
			continue;
		}
		allCharges.push(merged);
	}
	const counted = allCharges.filter(inWindow);
	const unpricedFacts = counted.filter((f) => amount(f, "list-estimate") === null).length;
	for (const f of counted)
		if (f.source.coverage !== "complete" || Object.values(f.tokens).some((n) => n === null))
			fault("partial-fact", f.id);
	// Replayed snapshots are upserts. They are reconciliation/coverage evidence, not leaves.
	const snapshotKeys = new Map<string, RunSnapshot>();
	const snapshotVersions = new Map<string, RunSnapshot>();
	const snapshotConflicts = new Set<string>();
	for (const s of input.snapshots.filter((s) => s.observedAt <= options.asOf)) {
		const key = JSON.stringify([s.producer, s.incarnation, s.run]);
		const versionKey = JSON.stringify([key, s.observedAt]);
		const version = snapshotVersions.get(versionKey);
		if (version && canonical(version) !== canonical(s)) snapshotConflicts.add(versionKey);
		snapshotVersions.set(versionKey, s);
		const old = snapshotKeys.get(key);
		if (!old || old.observedAt <= s.observedAt) snapshotKeys.set(key, s);
	}
	for (const versionKey of snapshotConflicts) fault("snapshot-conflict", versionKey);
	const chargeById = new Map(allCharges.map((f) => [f.id, f]));
	for (const [key, s] of snapshotKeys) {
		if (snapshotConflicts.has(JSON.stringify([key, s.observedAt]))) continue;
		const leaves = s.coveredFactIds.map((id) => facts.get(id));
		const uniqueIds = new Set(s.coveredFactIds.map(resolve));
		const charges = [...uniqueIds].map((id) => (id === null ? undefined : chargeById.get(id)));
		if (
			s.coverage !== "complete" ||
			leaves.length === 0 ||
			leaves.some(
				(f) =>
					!f || f.links.run !== s.run || f.identity.producer !== s.producer || f.identity.incarnation !== s.incarnation,
			) ||
			uniqueIds.has(null) ||
			uniqueIds.size !== s.coveredFactIds.length ||
			charges.some((f) => f === undefined)
		) {
			fault("snapshot-coverage", key);
			continue;
		}
		const prices = charges.map((f) => amount(f!, s.price.basis));
		if (s.price.amount === null || prices.some((p) => p === null)) {
			fault("snapshot-unpriced", key);
			continue;
		}
		const sum = units(addUsd(prices as Usd[]));
		const total = units(s.price.amount);
		if (s.state === "ended" ? sum !== total : total > sum) fault("snapshot-mismatch", key);
	}
	let stale = false;
	for (const stream of input.requiredStreams) {
		const rows = input.coverage
			.filter((c) => c.stream === stream && c.observedAt <= options.asOf)
			.sort((a, b) => a.observedAt.localeCompare(b.observedAt));
		const c = rows.at(-1);
		if (c && Date.parse(options.asOf) - Date.parse(c.observedAt) > options.staleAfterMs) stale = true;
		if (!c || c.status !== "complete" || c.through < options.window.through || c.from > options.window.from)
			fault("source-coverage", stream);
		if (c && rows.some((r) => r.observedAt === c.observedAt && canonical(r) !== canonical(c)))
			fault("coverage-conflict", stream);
	}
	for (const f of counted)
		if (!input.requiredStreams.includes(f.source.stream)) fault("uninventoried-stream", f.source.stream);
	const report: ObservedUsageReport = {
		v: "observed-usage/1",
		reportingOnly: true,
		asOf: options.asOf,
		window: { ...options.window },
		grossKnownListUsd: addUsd(visible.flatMap((f) => amount(f, "list-estimate") ?? [])),
		dedupKnownListUsd: addUsd(counted.flatMap((f) => amount(f, "list-estimate") ?? [])),
		otherBases: (["provider-reported", "invoice"] as const).map((basis) => ({
			basis,
			knownUsd: addUsd(counted.flatMap((f) => amount(f, basis) ?? [])),
			unpriced: counted.filter((f) => amount(f, basis) === null).length,
		})),
		unpricedFacts,
		unresolvedIdentities,
		usageCoverage: faults.length > 0 || stale || unpricedFacts > 0 || unresolvedIdentities > 0 ? "partial" : "complete",
		freshness: stale ? "stale" : "fresh",
		faults: faults.sort((a, b) => a.code.localeCompare(b.code) || a.ref.localeCompare(b.ref)),
	};
	return { input, options, report, facts, groups, allCharges, counted };
}

/** Pure policy-free recorded subtotals; validates the unchanged input envelope, ignores funding. */
export function observeUsage(raw: unknown, options: ObserveUsageOptions): ObservedUsageReport {
	return observeEvidence(raw, options).report;
}

/** Funding evaluation is deliberately separate from usage evidence. Not an authority API. */
function evaluateBudget(observed: ObservedEvidence, policyRef: string): AccountingReport {
	const { input, options, report, facts, groups, allCharges, counted } = observed;
	const faults = [...report.faults];
	const fault = (code: string, ref: string) => {
		faults.push({ code, ref });
	};
	const policies = unique(input.policies, (p) => p.ref, fault);
	const policy = policies.get(policyRef);
	requireValue(policy, "missing-policy");
	const allocations = latest(
		input.allocations.filter((a) => a.recordedAt <= options.asOf),
		(a) => a.factId,
		fault,
	);
	const roots = unique(input.roots, (r) => r.ref, fault);
	for (const [id, allocation] of allocations)
		if (!facts.has(id) || allocation.recordedAt < facts.get(id)!.occurredAt) fault("orphan-allocation", id);
	for (const f of allCharges) {
		const group = groups.get(f.id)!;
		const assigned = group.map((f) => allocations.get(f.id)).filter((a) => a !== undefined);
		if (
			assigned.some(
				(a) =>
					a.rootRef !== assigned[0].rootRef ||
					a.scope !== assigned[0].scope ||
					a.policyRef !== assigned[0].policyRef ||
					a.payerRole !== assigned[0].payerRole,
			) ||
			new Set(group.flatMap((f) => (f.links.task ? [canonical(f.links.task)] : []))).size > 1
		) {
			fault("alias-allocation-conflict", f.id);
			allocations.delete(f.id);
		}
	}
	let own = 0n,
		exempt = 0n,
		other = 0n,
		unallocated = 0n;
	let unallocatedFacts = 0;
	for (const f of counted) {
		const price = amount(f, "list-estimate");
		const cost = price === null ? 0n : units(price);
		const binding = checkTaskBinding(f, input.memberships);
		if (binding !== "verified") fault(binding === "mismatch" ? "task-binding-mismatch" : "unassigned-task", f.id);
		const a = allocations.get(f.id);
		const root = a?.rootRef ? roots.get(a.rootRef) : undefined;
		const p = a?.policyRef ? policies.get(a.policyRef) : undefined;
		const verified =
			a &&
			root &&
			binding !== "mismatch" &&
			a.scope === root.scope &&
			a.policyRef === root.policyRef &&
			a.payerRole === root.payerRole &&
			root.occurredAt <= f.occurredAt &&
			a.recordedAt >= f.occurredAt &&
			(a.scope !== "own" ||
				(p && p.effectiveAt <= f.occurredAt && p.scopeRef === root.scopeRef && p.role === a.payerRole));
		if (!verified) {
			unallocated += cost;
			unallocatedFacts++;
			fault("unknown-allocation", f.id);
		} else if (a.scope === "requested" || a.scope === "team") exempt += cost;
		else if (a.policyRef === policy.ref) own += cost;
		else other += cost;
	}
	const hasExposure =
		faults.length > 0 ||
		report.freshness === "stale" ||
		report.unpricedFacts > 0 ||
		report.unresolvedIdentities > 0 ||
		unallocatedFacts > 0 ||
		policy.effectiveAt > options.asOf;
	const limit = units(policy.weeklyUsd);
	return {
		v: 1,
		reportingOnly: true,
		policyRef: policy.ref,
		weekStart: pacificWeekStart(options.asOf),
		asOf: options.asOf,
		grossKnownListUsd: report.grossKnownListUsd,
		dedupKnownListUsd: report.dedupKnownListUsd,
		verifiedOwnLowerBoundUsd: decimal(own),
		exemptKnownListUsd: decimal(exempt),
		otherPolicyKnownListUsd: decimal(other),
		unallocatedKnownListUsd: decimal(unallocated),
		otherBases: report.otherBases,
		unpricedFacts: report.unpricedFacts,
		unallocatedFacts,
		unresolvedIdentities: report.unresolvedIdentities,
		coverage: hasExposure ? "partial" : "complete",
		freshness: report.freshness,
		remainingUsd: hasExposure ? null : decimal(limit > own ? limit - own : 0n),
		faults: faults.sort((a, b) => a.code.localeCompare(b.code) || a.ref.localeCompare(b.ref)),
	};
}

/** Unchanged policy report: Pacific-week observation followed by separate budget evaluation. */
export function accountUsage(
	raw: unknown,
	options: { policyRef: string; asOf: string; staleAfterMs: number },
): AccountingReport {
	const observed = observeEvidence(raw, {
		asOf: options.asOf,
		staleAfterMs: options.staleAfterMs,
		window: { from: pacificWeekStartUtc(options.asOf), through: options.asOf },
	});
	return evaluateBudget(observed, options.policyRef);
}
