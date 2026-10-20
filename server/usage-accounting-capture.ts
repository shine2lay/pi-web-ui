/** Inert numeric boundary. No SDK imports, source reads, listeners or authority registry. */
import {
	factId,
	parseAccountingInput,
	taskId,
	type AccountingInput,
	type Basis,
	type CallIdentity,
	type Price,
	type TaskMembership,
	type Tokens,
	type UsageFact,
} from "./usage-accounting-contract.js";

export type CaptureSource = "pi-sdk/1.0.1" | "acp/deb0e772" | "temper/legacy-summary";
export type CaptureKind = UsageFact["kind"] | "branch-summary";
export interface CaptureProjection {
	v: "numeric-capture/1";
	source: CaptureSource;
	stream: string;
	event: string;
	observedAt: string;
	occurredAt: string | null;
	provider: string | null;
	model: string | null;
	kind: CaptureKind;
	shape: "attempt" | "report" | "snapshot";
	outcome: "success" | "error" | "aborted" | "unavailable";
	identity: CallIdentity | null;
	usageEvidence: "reported" | "not-reported" | "unknown";
	tokenConvention: "pi-usage/1.0.1" | "raw-inclusive" | "unknown";
	tokens: Tokens & { reasoning: number | null; cacheWrite1h: number | null; total: number | null };
	price: {
		amountUsd: string | null;
		basis: Basis | null;
		rateVersion: string | null;
		evidenceRef: string | null;
		zero: "explicit" | "unmarked";
	};
	/** Observed subject only; never a payer, budget scope or policy. */
	subject: { role: string | null; session: string | null; run: string | null };
	task: Pick<TaskMembership, "queue" | "task" | "addedAt"> | null;
	ancestry: "missing" | "mixed" | "unknown";
}
/** Read from a prospective independently vetted native attempt store, never from labels. */
export interface NativeAttemptEvidence {
	identity: CallIdentity;
	/** Durable first observation, preserved on restart/replay/fork. */
	sourceStamp: { stream: string; event: string; observedAt: string };
	occurredAt: string;
	provider: string;
	model: string;
	kind: CaptureKind;
	session: string | null;
	run: string | null;
	/** Original task association stamped on this actual attempt, not a display lookup. */
	task: CaptureProjection["task"];
	overlap: "independent" | "alias" | "unknown";
	canonical: CallIdentity | null;
	evidenceRef: string;
}
export interface NativePriceEvidence {
	amountUsd: string;
	provider: string;
	model: string;
	basis: Basis;
	rateVersion: string | null;
	evidenceRef: string;
	validFrom: string;
	validThrough: string;
	tokenConvention: "pi-usage/1.0.1";
	explicitZero: boolean;
}
/** Process-injected evidence readers, NOT JSON trust flags or producer registration.
 * No implementations are exported/installed. Fixture readers authenticate nothing live.
 * Each reader must validate its approved native source before returning metadata.
 */
export interface CaptureEvidenceReaders {
	attempt?: (source: CaptureSource, stream: string, event: string) => unknown;
	price?: (source: CaptureSource, stream: string, event: string) => unknown;
	parentHistory?: (task: Readonly<NonNullable<CaptureProjection["task"]>>) => unknown;
}
export interface CaptureObservation {
	source: CaptureSource;
	stream: string;
	event: string;
	observedAt: string;
	occurredAt: string | null;
	provider: string | null;
	model: string | null;
	kind: CaptureKind;
	shape: CaptureProjection["shape"];
	outcome: CaptureProjection["outcome"];
	identity: CallIdentity | null;
	identityStatus: "verified" | "unresolved" | "not-an-attempt";
	tokens: Tokens;
	/** Raw bounded numeric classes retained for diagnostics, NOT normalized/additive. */
	reportedTokens: CaptureProjection["tokens"];
	tokenConvention: CaptureProjection["tokenConvention"];
	usageEvidence: CaptureProjection["usageEvidence"];
	reportedPrice: CaptureProjection["price"];
	reportedTask: CaptureProjection["task"];
	/** Never a budget amount or additive report/leaf charge. */
	unprovenUsd: string | null;
	priceStatus: Price["status"];
	subject: CaptureProjection["subject"];
	taskStatus: "verified" | "unassigned" | "mismatch" | "unavailable";
}
export type CaptureResult =
	| { ok: false; code: string }
	| {
			ok: true;
			projectionOnly: true;
			producerRegistered: false;
			accounting: AccountingInput;
			observation: CaptureObservation;
			faults: string[];
	  };

/** Reviewed source capabilities, not promises about an installed producer. */
export function captureCapabilities(): {
	source: CaptureSource;
	producer: CallIdentity["producer"];
	numericProjection: "supported" | "summary-only";
	tokens: "pi-usage/1.0.1" | "unavailable";
	nativeAttempts: "unavailable";
	priceEvidence: "unavailable";
	originalTaskBinding: "unavailable";
	nativeCause: "unavailable";
	liveProducer: false;
}[] {
	return (["pi-sdk/1.0.1", "acp/deb0e772", "temper/legacy-summary"] as const).map((source) => ({
		source,
		producer: producer(source),
		numericProjection: source === "temper/legacy-summary" ? "summary-only" : "supported",
		tokens: source === "temper/legacy-summary" ? "unavailable" : "pi-usage/1.0.1",
		nativeAttempts: "unavailable",
		priceEvidence: "unavailable",
		originalTaskBinding: "unavailable",
		nativeCause: "unavailable",
		liveProducer: false,
	}));
}

class InvalidMetadata extends Error {}
function need(ok: unknown, code: string): asserts ok {
	if (!ok) throw new InvalidMetadata(code);
}
/** Reject accessors/symbols/nonenumerable keys as well as ordinary extra payload keys. */
function closed(raw: unknown, fields: string[]): Record<string, unknown> {
	need(raw !== null && typeof raw === "object" && !Array.isArray(raw), "object");
	need(Object.getPrototypeOf(raw) === Object.prototype || Object.getPrototypeOf(raw) === null, "plain-object");
	const keys = Reflect.ownKeys(raw);
	need(keys.length === fields.length && fields.every((key) => keys.includes(key)), "closed-fields");
	const descriptors = Object.getOwnPropertyDescriptors(raw);
	need(
		fields.every((key) => "value" in descriptors[key] && descriptors[key].enumerable),
		"data-fields",
	);
	return raw as Record<string, unknown>;
}
function ref(raw: unknown): void {
	need(typeof raw === "string" && /^[A-Za-z0-9_./:@+-]{1,256}$/.test(raw), "reference");
}
function nullable(raw: unknown, validate: (v: unknown) => void): void {
	if (raw !== null) validate(raw);
}
function stamp(raw: unknown): void {
	need(typeof raw === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(raw), "timestamp");
	need(Number.isFinite(Date.parse(raw)) && new Date(raw).toISOString() === raw, "timestamp");
}
function uint(raw: unknown): void {
	need(typeof raw === "number" && Number.isSafeInteger(raw) && raw >= 0, "token-count");
}
function usd(raw: unknown): void {
	need(typeof raw === "string" && /^(0|[1-9]\d{0,17})(?:\.\d{1,12})?$/.test(raw), "decimal-usd");
}
function choice(raw: unknown, values: readonly unknown[]): void {
	need(values.includes(raw), "enum");
}
function producer(source: CaptureSource): CallIdentity["producer"] {
	return source === "pi-sdk/1.0.1" ? "pi" : source === "acp/deb0e772" ? "acp" : "temper";
}
function identity(raw: unknown): void {
	const v = closed(raw, ["producer", "incarnation", "attempt"]);
	choice(v.producer, ["pi", "acp", "temper"]);
	ref(v.incarnation);
	ref(v.attempt);
}
function task(raw: unknown, membership = false): void {
	const v = closed(
		raw,
		membership ? ["queue", "task", "addedAt", "project", "initiative", "effectiveAt"] : ["queue", "task", "addedAt"],
	);
	ref(v.queue);
	uint(v.task);
	need(Number(v.task) > 0, "task-number");
	stamp(v.addedAt);
	if (membership) {
		stamp(v.effectiveAt);
		need(String(v.addedAt) <= String(v.effectiveAt), "task-birth");
		nullable(v.project, ref);
		nullable(v.initiative, ref);
	}
}
function parseProjection(raw: unknown): CaptureProjection {
	const v = closed(raw, [
		"v",
		"source",
		"stream",
		"event",
		"observedAt",
		"occurredAt",
		"provider",
		"model",
		"kind",
		"shape",
		"outcome",
		"identity",
		"usageEvidence",
		"tokenConvention",
		"tokens",
		"price",
		"subject",
		"task",
		"ancestry",
	]);
	need(v.v === "numeric-capture/1", "capture-version");
	choice(v.source, ["pi-sdk/1.0.1", "acp/deb0e772", "temper/legacy-summary"]);
	ref(v.stream);
	ref(v.event);
	stamp(v.observedAt);
	nullable(v.occurredAt, stamp);
	need(v.occurredAt === null || String(v.occurredAt) <= String(v.observedAt), "observation-time");
	nullable(v.provider, ref);
	nullable(v.model, ref);
	choice(v.kind, ["assistant", "cache-warm", "compaction", "branch-summary", "delegate"]);
	choice(v.shape, ["attempt", "report", "snapshot"]);
	choice(v.outcome, ["success", "error", "aborted", "unavailable"]);
	nullable(v.identity, identity);
	if (v.identity !== null)
		need((v.identity as CallIdentity).producer === producer(v.source as CaptureSource), "producer-source");
	choice(v.usageEvidence, ["reported", "not-reported", "unknown"]);
	choice(v.tokenConvention, ["pi-usage/1.0.1", "raw-inclusive", "unknown"]);
	const t = closed(v.tokens, ["input", "output", "cacheRead", "cacheWrite", "reasoning", "cacheWrite1h", "total"]);
	for (const value of Object.values(t)) nullable(value, uint);
	const p = closed(v.price, ["amountUsd", "basis", "rateVersion", "evidenceRef", "zero"]);
	nullable(p.amountUsd, usd);
	nullable(p.basis, (value) => choice(value, ["list-estimate", "provider-reported", "invoice"]));
	nullable(p.rateVersion, ref);
	nullable(p.evidenceRef, ref);
	choice(p.zero, ["explicit", "unmarked"]);
	const s = closed(v.subject, ["role", "session", "run"]);
	for (const value of Object.values(s)) nullable(value, ref);
	nullable(v.task, task);
	choice(v.ancestry, ["missing", "mixed", "unknown"]);
	// Copy only after all closed schemas pass. No reference to caller objects escapes.
	return structuredClone(raw) as CaptureProjection;
}
function attemptEvidence(raw: unknown): NativeAttemptEvidence {
	const v = closed(raw, [
		"identity",
		"sourceStamp",
		"occurredAt",
		"provider",
		"model",
		"kind",
		"session",
		"run",
		"task",
		"overlap",
		"canonical",
		"evidenceRef",
	]);
	identity(v.identity);
	const source = closed(v.sourceStamp, ["stream", "event", "observedAt"]);
	ref(source.stream);
	ref(source.event);
	stamp(source.observedAt);
	stamp(v.occurredAt);
	need(String(v.occurredAt) <= String(source.observedAt), "native-observation-time");
	for (const key of ["provider", "model", "evidenceRef"]) ref(v[key]);
	choice(v.kind, ["assistant", "cache-warm", "compaction", "branch-summary", "delegate"]);
	nullable(v.session, ref);
	nullable(v.run, ref);
	nullable(v.task, task);
	choice(v.overlap, ["independent", "alias", "unknown"]);
	nullable(v.canonical, identity);
	need((v.overlap === "alias") === (v.canonical !== null), "alias-evidence");
	if (v.canonical !== null)
		need(factId(v.canonical as CallIdentity) !== factId(v.identity as CallIdentity), "self-alias");
	return structuredClone(raw) as NativeAttemptEvidence;
}
function priceEvidence(raw: unknown): NativePriceEvidence {
	const v = closed(raw, [
		"amountUsd",
		"provider",
		"model",
		"basis",
		"rateVersion",
		"evidenceRef",
		"validFrom",
		"validThrough",
		"tokenConvention",
		"explicitZero",
	]);
	usd(v.amountUsd);
	for (const key of ["provider", "model", "evidenceRef"]) ref(v[key]);
	choice(v.basis, ["list-estimate", "provider-reported", "invoice"]);
	nullable(v.rateVersion, ref);
	stamp(v.validFrom);
	stamp(v.validThrough);
	need(String(v.validFrom) <= String(v.validThrough), "price-window");
	need(v.tokenConvention === "pi-usage/1.0.1" && typeof v.explicitZero === "boolean", "price-evidence");
	return structuredClone(raw) as NativePriceEvidence;
}
function sameTask(a: TaskMembership, b: TaskMembership): boolean {
	return (
		taskId(a) === taskId(b) &&
		a.effectiveAt === b.effectiveAt &&
		a.project === b.project &&
		a.initiative === b.initiative
	);
}
function nullTokens(): Tokens {
	return { input: null, output: null, cacheRead: null, cacheWrite: null };
}

/** One bounded already-projected observation; a report/snapshot is never a new charge.
 * Missing readers are supported and intentionally fail closed. Reader exceptions are
 * reduced to fixed codes; no values, errors, input serialization or content hashes escape.
 */
export function captureUsage(raw: unknown, readers: CaptureEvidenceReaders = {}): CaptureResult {
	let c: CaptureProjection;
	try {
		c = parseProjection(raw);
	} catch (error) {
		return { ok: false, code: error instanceof InvalidMetadata ? error.message : "invalid-metadata" };
	}
	const faults: string[] = [];
	const fault = (code: string) => {
		if (!faults.includes(code)) faults.push(code);
	};
	const read = <T>(fn: (() => unknown) | undefined, validate: (value: unknown) => T, code: string): T | null => {
		if (!fn) return null;
		try {
			const value = fn();
			return value === null ? null : validate(value);
		} catch {
			fault(code);
			return null;
		}
	};
	const accounting: AccountingInput = {
		v: 1,
		facts: [],
		allocations: [],
		aliases: [],
		roots: [],
		policies: [],
		memberships: [],
		snapshots: [],
		coverage: [],
		requiredStreams: [c.stream],
	};
	// Observation time is not an occurrence interval. Never manufacture a coverage window.
	fault("producer-unavailable");
	const numericSource = c.source !== "temper/legacy-summary";
	let tokens = nullTokens();
	if (numericSource && c.usageEvidence === "reported" && c.tokenConvention === "pi-usage/1.0.1") {
		tokens = {
			input: c.tokens.input,
			output: c.tokens.output,
			cacheRead: c.tokens.cacheRead,
			cacheWrite: c.tokens.cacheWrite,
		};
		const t = c.tokens;
		const badSubset =
			(t.reasoning !== null && (t.output === null || t.reasoning > t.output)) ||
			(t.cacheWrite1h !== null && (t.cacheWrite === null || t.cacheWrite1h > t.cacheWrite));
		const classes = Object.values(tokens);
		const badTotal =
			t.total !== null &&
			classes.every((n) => n !== null) &&
			classes.reduce((sum, n) => sum + BigInt(n!), 0n) !== BigInt(t.total);
		if (badSubset || badTotal) {
			tokens = nullTokens();
			fault("token-convention-mismatch");
		}
	} else fault(c.usageEvidence !== "reported" ? "usage-unavailable" : "token-convention-unavailable");
	if (Object.values(tokens).some((n) => n === null)) fault("partial-tokens");

	let evidence: NativeAttemptEvidence | null = null;
	let identityStatus: CaptureObservation["identityStatus"] = c.shape === "attempt" ? "unresolved" : "not-an-attempt";
	if (c.shape === "attempt" && numericSource) {
		evidence = read(
			readers.attempt ? () => readers.attempt!(c.source, c.stream, c.event) : undefined,
			attemptEvidence,
			"attempt-evidence-invalid",
		);
		if (
			evidence &&
			c.identity &&
			factId(evidence.identity) === factId(c.identity) &&
			evidence.occurredAt === c.occurredAt &&
			evidence.provider === c.provider &&
			evidence.model === c.model &&
			evidence.kind === c.kind &&
			evidence.session === c.subject.session &&
			evidence.run === c.subject.run &&
			evidence.sourceStamp.observedAt <= c.observedAt &&
			evidence.overlap !== "unknown"
		)
			identityStatus = "verified";
		else fault(evidence ? "attempt-evidence-mismatch" : "native-attempt-unavailable");
	} else fault(c.shape === "attempt" ? "source-attempt-unavailable" : "nonadditive-observation");

	const price: Price = {
		basis: "list-estimate",
		currency: "USD",
		amount: null,
		status:
			c.model === null || c.provider === null
				? "unknown-model"
				: c.price.amountUsd === null
					? "unpriced"
					: "basis-unproven",
		rateVersion: null,
	};
	const prices: Price[] = [price];
	const pe = read(
		readers.price ? () => readers.price!(c.source, c.stream, c.event) : undefined,
		priceEvidence,
		"price-evidence-invalid",
	);
	const zero = c.price.amountUsd !== null && /^0(?:\.0+)?$/.test(c.price.amountUsd);
	const provenPrice =
		numericSource &&
		c.shape === "attempt" &&
		c.usageEvidence === "reported" &&
		!faults.includes("token-convention-mismatch") &&
		c.tokenConvention === "pi-usage/1.0.1" &&
		c.occurredAt !== null &&
		pe !== null &&
		pe.amountUsd === c.price.amountUsd &&
		pe.provider === c.provider &&
		pe.model === c.model &&
		pe.basis === c.price.basis &&
		pe.rateVersion === c.price.rateVersion &&
		pe.evidenceRef === c.price.evidenceRef &&
		pe.validFrom <= c.occurredAt &&
		c.occurredAt <= pe.validThrough &&
		(pe.basis !== "list-estimate" || pe.rateVersion !== null) &&
		(!zero || (pe.explicitZero && c.price.zero === "explicit"));
	if (provenPrice && c.price.amountUsd !== null) {
		const known: Price = {
			basis: pe.basis,
			currency: "USD",
			amount: c.price.amountUsd,
			status: "known",
			rateVersion: pe.rateVersion,
		};
		if (known.basis === "list-estimate") prices[0] = known;
		else prices.push(known);
	} else if (c.price.amountUsd !== null)
		fault(zero && c.price.zero === "unmarked" ? "unmarked-zero" : "price-basis-unproven");
	if (prices[0].amount === null) fault("list-price-unavailable");

	let taskStatus: CaptureObservation["taskStatus"] = c.task ? "unavailable" : "unassigned";
	let membership: TaskMembership | null = null;
	if (c.task && identityStatus === "verified" && evidence?.task && taskId(evidence.task) === taskId(c.task)) {
		const history = read(
			readers.parentHistory ? () => readers.parentHistory!(Object.freeze({ ...c.task! })) : undefined,
			(value) => {
				need(
					Array.isArray(value) && value.length <= 1024 && Reflect.ownKeys(value).length === value.length + 1,
					"history-bound",
				);
				for (let i = 0; i < value.length; i++) {
					const descriptor = Object.getOwnPropertyDescriptor(value, String(i));
					need(descriptor && "value" in descriptor, "history-data");
					task(descriptor.value, true);
				}
				return structuredClone(value) as TaskMembership[];
			},
			"parent-history-invalid",
		);
		if (history && c.occurredAt !== null) {
			const rows = history.filter((m) => taskId(m) === taskId(c.task!));
			const original = rows.filter((m) => m.effectiveAt === c.task!.addedAt);
			const versions = new Map<string, TaskMembership>();
			let conflict = false;
			for (const m of rows) {
				const old = versions.get(m.effectiveAt);
				if (old && !sameTask(old, m)) conflict = true;
				versions.set(m.effectiveAt, m);
			}
			const current = rows
				.filter((m) => m.effectiveAt <= c.occurredAt!)
				.sort((a, b) => a.effectiveAt.localeCompare(b.effectiveAt))
				.at(-1);
			if (original.length > 0 && !conflict && current) {
				membership = { ...current };
				taskStatus = "verified";
				accounting.memberships = [...versions.values()].sort((a, b) => a.effectiveAt.localeCompare(b.effectiveAt));
			} else taskStatus = "mismatch";
		}
	} else if (c.task && evidence && identityStatus === "verified") taskStatus = "mismatch";
	if (taskStatus !== "verified") fault(`task-${taskStatus}`);
	// No own/requested/team root producer exists here. Subject role never supplies a payer.
	fault(c.ancestry === "mixed" ? "mixed-root" : "missing-root");
	if (c.shape === "attempt" && numericSource && c.identity && c.occurredAt && c.provider && c.model) {
		const id = factId(c.identity);
		const source =
			identityStatus === "verified" && evidence
				? { ...evidence.sourceStamp }
				: { stream: c.stream, event: c.event, observedAt: c.observedAt };
		accounting.requiredStreams = [...new Set([c.stream, source.stream])];
		accounting.facts.push({
			v: "usage-fact/1",
			id,
			revision: 0,
			supersedes: null,
			identity: { ...c.identity },
			identityStatus: identityStatus === "verified" ? "verified" : "unresolved",
			occurredAt: c.occurredAt,
			provider: c.provider,
			model: c.model,
			kind: c.kind === "branch-summary" ? "compaction" : c.kind,
			tokens,
			prices,
			source: { ...source, coverage: "partial" },
			links: { task: membership, session: c.subject.session, run: c.subject.run },
		});
		accounting.allocations.push({
			v: "allocation/1",
			factId: id,
			revision: 0,
			supersedes: null,
			rootRef: null,
			scope: "unknown",
			policyRef: null,
			payerRole: null,
			recordedAt: source.observedAt,
			reason: c.ancestry === "mixed" ? "mixed-root" : "missing-root",
		});
		if (identityStatus === "verified" && evidence?.overlap === "alias" && evidence.canonical)
			accounting.aliases.push({
				aliasFactId: id,
				canonicalFactId: factId(evidence.canonical),
				provenance: "native-call-map/1",
				evidenceRef: evidence.evidenceRef,
			});
	} else if (c.shape === "attempt") fault("fact-fields-unavailable");
	// Defensive compatibility check against unchanged #293. It never authenticates evidence.
	const parsed = parseAccountingInput(accounting);
	if (!parsed.ok) return { ok: false, code: "projection-contract" };
	return {
		ok: true,
		projectionOnly: true,
		producerRegistered: false,
		accounting,
		observation: {
			source: c.source,
			stream: c.stream,
			event: c.event,
			observedAt: c.observedAt,
			occurredAt: c.occurredAt,
			provider: c.provider,
			model: c.model,
			kind: c.kind,
			shape: c.shape,
			outcome: c.outcome,
			identity: c.identity,
			identityStatus,
			tokens,
			reportedTokens: c.tokens,
			tokenConvention: c.tokenConvention,
			usageEvidence: c.usageEvidence,
			reportedPrice: c.price,
			reportedTask: c.task,
			unprovenUsd: c.price.amountUsd !== null && !prices.some((p) => p.status === "known") ? c.price.amountUsd : null,
			priceStatus: prices.find((p) => p.status === "known")?.status ?? prices[0].status,
			subject: c.subject,
			taskStatus,
		},
		faults,
	};
}
