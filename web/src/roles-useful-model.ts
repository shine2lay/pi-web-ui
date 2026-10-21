/** Closed presentation only. The inherited full wire/store is NOT a confidentiality boundary.
 * No native identity or execution claim can be derived from this feed.
 * Each call constructs a fresh projection of one received snapshot; nothing is retained or joined.
 *
 * roles-needs-you (task #200, owner plan 2026-10-16): widens the 2026-10-15 closed contract by
 * existing feed fields only: task names, blockers, asking/working/paused markers, the newest line
 * of a working task, the owner's open asks and in-app chat targets. Agent-written text becomes
 * bounded plain text or a fixed fallback; chat targets stay in memory and only ever reach the app's
 * existing openFromRoles path (switch_session, which the server path-checks again).
 * Security's design disposition (security-lab/roles-existing-feed-2026-10-15/ADDENDUM-OPS200.md)
 * sets the conditions kept here: whole-string rejection, "needs a decision" and "paused" wording,
 * every ask counted, a scoped "none reported" line only after a full update in this connection,
 * and zero counts only under the same guards as any other number.
 */
import { parseFocus } from "./chat-focus";
import { graceLeft } from "./page-live";

export const ROLE_LIMIT = 64;
export const RECORD_LIMIT = 20;
export const LABEL_LIMIT = 120;
export const NAME_LIMIT = 160;
export const TEXT_LIMIT = 300;
export const ASK_LIMIT = 50;
export const PATH_LIMIT = 4096;
/** No word from the server for this long while connected (it confirms every ~30 s): not live. */
export const STALE_MS = 120_000;
/** An ask's start may be this far ahead of this browser's clock (another device); more: "time unknown". */
export const CLOCK_SKEW_MS = 300_000;
/** An older server, one that doesn't send allChatsRead, read at most this many started task chats per
 *  role: open dialogs in the others weren't seen, so "nothing waits on you" can't be said then. A newer
 *  server says per role whether it read every one (roles-asks-read, Ops #268). */
export const TASK_CHATS_READ = 8;
const KEY_LIMIT = 300;

const STATUSES = ["ready", "working", "asking", "stuck", "waiting", "blocked", "done", "dropped"] as const;
const STOP_REASONS = ["user", "stopped", "error", "restart", "finished"] as const;
/** Rejects the whole text: controls, format characters (every bidi control, zero-width characters,
 *  the soft hyphen, tag characters), lone surrogates, private-use and unassigned code points, and
 *  line/paragraph separators. In agent text, tab, CR and LF read as one space first: visible
 *  whitespace a text node shows as a space anyway (multi-line task questions). Paths get no such pass. */
export const UNSAFE = /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}\u2028\u2029]/u;

export type ReportedStatus = (typeof STATUSES)[number];
export type StopReason = (typeof STOP_REASONS)[number];
export type PauseMarker = "reported-paused" | "not-reported" | "unknown";
/** A reported number (0 included), or why there is none. */
export type ReplayCount = number | "unavailable" | "no-queue";
export type SourceState =
	| "awaiting"
	| "error"
	| "cached-error"
	| "disconnected"
	| "cached"
	| "stale"
	/** pages-live: the last data, while the page waits up to LIVE_GRACE_MS of visible time for a new check. */
	| "updating"
	| "partial"
	| "unknown"
	| "connected-source-unverified";
/** What a task row says, in plain words (the view maps each to one fixed string). */
export type RowState =
	| "ready"
	| "ready-after"
	| "working"
	| "asking-ops"
	| "asking-lead"
	| "asking-main"
	| "asking"
	| "needs-decision"
	| "on-hold"
	| "blocked"
	| "done"
	| "dropped"
	| "unknown";
/** Whether the "Needs you" list is the current one (only then may an empty list read "none reported"). */
export type TellState = "can-tell" | "not-live" | "feed-error" | "awaiting" | "partial" | "decision" | "unknown";

/** An existing chat, maybe at one item of it (the Queue tab's task, a TL;DR line, a question). */
export interface UsefulOpenTarget {
	file: string;
	focus?: { kind: "tldr" | "task" | "question"; id: string };
	/** roles-panel: a message in that chat to jump to (its time), like a 6 am report's answer. */
	jumpAt?: number;
}
export interface UsefulRecord {
	taskId: number;
	/** null: absent or unsafe; the row says "Task #N" only. */
	name: string | null;
	state: RowState;
	/** asking-lead (owner 2026-10-17): the role whose lead has its question (its department, or one up the chain). */
	askLead: string | null;
	waitsOn: string | null;
	busy: boolean;
	/** The newest line of its own chat; working tasks only. */
	latest: string | null;
	/** roles-live (Ops #272): when that line was written (ms); absent when the server didn't say. */
	latestAt?: number;
	/** roles-live: a question still with a lead (the role id whose home chat has it), not the owner's;
	 *  question states only (asking, needs-decision), absent when the server didn't say. */
	withLead?: string;
	/** queue-drop: why its lead dropped it; dropped tasks only (null: absent or unsafe). */
	dropped: string | null;
	pause: PauseMarker;
	link: UsefulOpenTarget | null;
	/** roles-evidence (task #207): how far its change has got; working tasks from a server that says it. */
	evidence?: UsefulEvidence;
}
/** roles-evidence: one step: when it happened, or why there's no time (not yet, not recorded, not tracked). */
export type UsefulEvidenceStep = { at: number } | { not: "yet" | "recorded" | "tracked" };
export const EVIDENCE_STEPS = ["Built", "Checked", "Installed", "Live", "Confirmed"] as const;
export interface UsefulEvidence {
	/** The repo's folder name (null: not said, or unsafe). */
	repo: string | null;
	/** The landed commit, short (null: not landed, or unsafe). */
	commit: string | null;
	/** In EVIDENCE_STEPS order. */
	steps: UsefulEvidenceStep[];
}
function evidenceStep(value: unknown): UsefulEvidenceStep | null {
	const o = object(value);
	if (!o) return null;
	if (typeof o.at === "number" && Number.isFinite(o.at) && o.at > 0) return { at: o.at };
	if (o.not === "yet" || o.not === "recorded" || o.not === "tracked") return { not: o.not };
	return null;
}
/** A task's evidence as the server sent it, or undefined when any step is missing or malformed. */
export function evidenceOf(value: unknown): UsefulEvidence | undefined {
	const o = object(value);
	if (!o) return undefined;
	const steps = [o.built, o.checked, o.installed, o.live, o.confirmed].map(evidenceStep);
	if (steps.some((s) => s === null)) return undefined;
	return {
		repo: typeof o.repo === "string" && /^[\w.-]{1,80}$/.test(o.repo) ? o.repo : null,
		commit: typeof o.commit === "string" && /^[0-9a-f]{7,40}$/.test(o.commit) ? o.commit : null,
		steps: steps as UsefulEvidenceStep[],
	};
}
export interface UsefulRecords {
	available: boolean;
	omitted: boolean;
	notAllShown: boolean;
	records: UsefulRecord[];
}
export interface UsefulSpend {
	state: "ok" | "over" | "stale" | "none" | "old-week" | "unreadable";
	line: string;
	amounts: string | null;
	initiatives: { id: string; amount: string }[];
}
/** The existing tally is reported, not independently measured or enforced by this view. */
export function projectSpend(value: unknown): UsefulSpend | null {
	const s = object(value);
	const state = s?.state;
	if (
		state !== "ok" &&
		state !== "over" &&
		state !== "stale" &&
		state !== "none" &&
		state !== "old-week" &&
		state !== "unreadable"
	)
		return null;
	const line = plain(s?.line, 420);
	if (!line || line.clipped || /(?:\/|[a-z]:\\)[^\n\r]*?\.jsonl\b/i.test(line.text)) return null;
	const money = (v: unknown): v is string =>
		typeof v === "string" && v.length <= 40 && /^\$(?:\d{1,3}(?:,\d{3})*|\d+)(?:\.\d{2})?$/.test(v);
	const amounts = money(s?.spent) && money(s?.budget) ? `${s.spent} / ${s.budget}` : null;
	if ((state === "ok" || state === "stale" || state === "over") && amounts === null) return null;
	const initiatives: UsefulSpend["initiatives"] = [];
	if (Array.isArray(s?.byInitiative))
		for (const raw of s.byInitiative.slice(0, 20)) {
			const row = object(raw);
			if (
				typeof row?.id === "string" &&
				row.id.length <= 60 &&
				/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(row.id) &&
				money(row.amount)
			)
				initiatives.push({ id: row.id, amount: row.amount });
		}
	return { state, line: line.text, amounts, initiatives };
}
/** Exact scalar-only automatic view; no budget ratio, allowance or arithmetic on money. */
export interface UsefulUsageCost {
	value: import("./types").UiRoleUsageCost;
	stale: boolean;
	lines: string[];
}
const USAGE_CODES = [
	"collector-off",
	"inventory-partial",
	"invalid-batch",
	"batch-limit",
	"time-limit",
	"unapproved-source",
	"source-unavailable",
	"native-unverified",
	"provenance-mismatch",
	"retention-gap",
	"truncated-source",
	"cursor-gap",
	"cursor-conflict",
	"revision-gap",
	"revision-conflict",
	"rewritten-occurrence",
	"metadata-conflict",
	"binding-mismatch",
	"event-conflict",
	"alias-conflict",
	"snapshot-conflict",
	"journal-tail",
	"journal-corrupt",
	"checkpoint-corrupt",
	"store-capacity",
	"io-failure",
	"index-unavailable",
	"source-coverage",
	"coverage-conflict",
	"unpriced",
	"unallocated",
	"unresolved-identity",
	"invalid-subject-binding",
	"funding-unavailable",
	"unknown-accounting-fault",
	"worker-unavailable",
	"worker-stale",
	"source-stalled",
	"waiting-for-previous-writer",
];
const USAGE_STALLS = [
	"pending",
	"delayed",
	"drain-stalled",
	"dead-man",
	"off",
	"forbidden",
	"unavailable",
	"timeout",
	"malformed-page",
	"cursor-quarantined",
];
const usageClosed = (v: unknown, keys: string): v is Record<string, unknown> =>
	object(v) !== null &&
	Object.getPrototypeOf(v) === Object.prototype &&
	Reflect.ownKeys(v as object).every(
		(k) =>
			typeof k === "string" &&
			Object.getOwnPropertyDescriptor(v, k)?.enumerable === true &&
			Object.hasOwn(Object.getOwnPropertyDescriptor(v, k)!, "value"),
	) &&
	Object.keys(v as object)
		.sort()
		.join(",") === keys.split(" ").sort().join(",");
const usageChoice = (v: unknown, choices: readonly unknown[]) => choices.includes(v);
const usageCount = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const usageUsd = (v: unknown) => typeof v === "string" && /^(0|[1-9]\d{0,17})(?:\.\d{1,12})?$/.exec(v)?.[0] === v;
const usageTime = (v: unknown): v is string =>
	typeof v === "string" &&
	/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(v) &&
	Number.isFinite(Date.parse(v)) &&
	new Date(v).toISOString() === v;
const usageTimes = (vs: unknown[], at: string) => vs.every((v) => v === null || (usageTime(v) && v <= at));
const usageList = (v: unknown, cap: number, check: (v: unknown) => boolean): v is unknown[] =>
	Array.isArray(v) && v.length <= cap && Object.keys(v).length === v.length && v.every(check);
const usageFaults = (v: unknown) =>
	usageList(
		v,
		64,
		(f) => usageClosed(f, "code count") && usageChoice(f.code, USAGE_CODES) && usageCount(f.count) && f.count > 0,
	) && new Set(v.map((f) => (f as { code: string }).code)).size === v.length;
const usageStamp = (v: string | null) => (v === null ? "UNKNOWN" : `${v.slice(0, 16).replace("T", " ")} UTC`);
const usageN = (v: number | null) => (v === null ? "UNKNOWN" : String(v));
function usageWeek(now: number): string {
	const p = new Intl.DateTimeFormat("en-CA", {
		timeZone: "America/Los_Angeles",
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
	}).formatToParts(now);
	const part = (key: string) => p.find((v) => v.type === key)!.value;
	const day = new Date(`${part("year")}-${part("month")}-${part("day")}T00:00:00.000Z`);
	day.setUTCDate(day.getUTCDate() - ((day.getUTCDay() + 6) % 7));
	return day.toISOString().slice(0, 10);
}
/** Closed protocol consumer. A page read/poll never renews native observations or certifies Temper. */
export function projectRoleUsageCost(raw: unknown, role: string, now: number): UsefulUsageCost | null {
	if (
		!Number.isFinite(now) ||
		!roleId(role) ||
		!usageClosed(
			raw,
			"v reportingOnly role generation evaluatedAt weekStart firstNativeObservedAt state storage inventory usage sources faults",
		) ||
		raw.v !== "role-usage-cost/1" ||
		raw.reportingOnly !== true ||
		raw.role !== role ||
		!usageChoice(raw.state, ["ready", "recovering", "stale", "unavailable", "waiting-for-previous-writer"]) ||
		!usageChoice(raw.storage, ["healthy", "partial", "unavailable"]) ||
		!usageChoice(raw.inventory, ["complete", "partial", "unavailable"]) ||
		!usageFaults(raw.faults)
	)
		return null;
	if (raw.generation === null) {
		if (
			raw.state !== "unavailable" ||
			raw.evaluatedAt !== null ||
			raw.weekStart !== null ||
			raw.firstNativeObservedAt !== null ||
			raw.usage !== null ||
			!Array.isArray(raw.sources) ||
			raw.sources.length !== 0
		)
			return null;
	} else if (
		!usageClosed(raw.generation, "epoch sequence") ||
		typeof raw.generation.epoch !== "string" ||
		raw.generation.epoch.length !== 64 ||
		!/^[a-f0-9]{64}$/.test(raw.generation.epoch) ||
		!usageCount(raw.generation.sequence) ||
		!usageTime(raw.evaluatedAt) ||
		Date.parse(raw.evaluatedAt) > now ||
		typeof raw.weekStart !== "string" ||
		!usageTime(`${raw.weekStart}T00:00:00.000Z`) ||
		new Date(`${raw.weekStart}T00:00:00.000Z`).getUTCDay() !== 1 ||
		(raw.firstNativeObservedAt !== null &&
			(!usageCount(raw.firstNativeObservedAt) ||
				raw.firstNativeObservedAt === 0 ||
				raw.firstNativeObservedAt > Date.parse(raw.evaluatedAt)))
	)
		return null;
	const evaluated = raw.evaluatedAt as string | null;
	if (
		!usageList(raw.sources, 1024, (rawSource) => {
			const s = object(rawSource);
			if (
				!s ||
				!usageCount(s.index) ||
				s.index >= 1024 ||
				typeof s.enabled !== "boolean" ||
				typeof s.required !== "boolean"
			)
				return false;
			if (s.kind === "temper") {
				if (
					!usageClosed(s, "index kind required enabled state coverage observedAt frontier") ||
					s.coverage !== "unknown" ||
					!usageChoice(s.state, ["available", "unavailable"]) ||
					!usageTimes([s.observedAt], evaluated!) ||
					(!s.enabled && s.state !== "unavailable")
				)
					return false;
				const f = s.frontier;
				return (
					usageClosed(
						f,
						"diagnosticOnly recorded_through pending_count oldest_pending last_drain assessed_from assessed_through freshness stallCodes",
					) &&
					f.diagnosticOnly === true &&
					usageTimes(
						[f.recorded_through, f.oldest_pending, f.last_drain, f.assessed_from, f.assessed_through],
						evaluated!,
					) &&
					(f.pending_count === null || usageCount(f.pending_count)) &&
					!(f.pending_count === 0 && f.oldest_pending !== null) &&
					(f.assessed_from === null) === (f.assessed_through === null) &&
					(f.assessed_from === null || String(f.assessed_from) <= String(f.assessed_through)) &&
					usageChoice(f.freshness, ["fresh", "delayed", "stalled", "dead-man", "unknown"]) &&
					usageList(f.stallCodes, USAGE_STALLS.length, (c) => usageChoice(c, USAGE_STALLS)) &&
					new Set(f.stallCodes).size === f.stallCodes.length &&
					(f.freshness !== "fresh" ||
						(s.enabled &&
							s.state === "available" &&
							s.observedAt !== null &&
							Date.parse(evaluated!) - Date.parse(String(s.observedAt)) <= 60_000))
				);
			}
			return (
				usageClosed(s, "index kind required enabled state coveredThrough observedAt lastProgressAt stalled alarm") &&
				usageChoice(s.kind, ["pi", "acp", "metadata"]) &&
				usageChoice(s.state, ["complete", "partial", "unknown", "unavailable"]) &&
				typeof s.stalled === "boolean" &&
				usageChoice(s.alarm, [null, "source-stalled"]) &&
				usageTimes([s.coveredThrough, s.observedAt, s.lastProgressAt], evaluated!) &&
				(s.coveredThrough === null || (s.observedAt !== null && String(s.coveredThrough) <= String(s.observedAt))) &&
				(s.enabled || s.state === "unavailable") &&
				(s.alarm === null ||
					(s.required &&
						s.enabled &&
						s.stalled &&
						s.lastProgressAt !== null &&
						Date.parse(evaluated!) - Date.parse(String(s.lastProgressAt)) >= 300_000)) &&
				(!(
					s.required &&
					s.enabled &&
					s.lastProgressAt !== null &&
					Date.parse(evaluated!) - Date.parse(String(s.lastProgressAt)) >= 300_000
				) ||
					(s.stalled && s.alarm === "source-stalled")) &&
				(s.state !== "complete" ||
					(s.enabled && !s.stalled && s.coveredThrough !== null && s.observedAt !== null && s.lastProgressAt !== null))
			);
		}) ||
		new Set(raw.sources.map((s) => (s as { index: number }).index)).size !== raw.sources.length
	)
		return null;
	const u = raw.usage;
	if (u !== null) {
		if (
			!usageClosed(
				u,
				"window usageCoverage fundingCoverage freshness coveredThrough observedAt list otherBases counts funding faults",
			) ||
			!usageClosed(u.window, "from through") ||
			!usageTime(u.window.from) ||
			!usageTime(u.window.through) ||
			u.window.from > u.window.through ||
			u.window.through > evaluated! ||
			!usageChoice(u.usageCoverage, ["complete", "partial", "unavailable"]) ||
			!usageChoice(u.fundingCoverage, ["complete", "partial", "unavailable", "not-evaluated"]) ||
			!usageChoice(u.freshness, ["fresh", "stale", "unknown"]) ||
			!usageTimes([u.coveredThrough, u.observedAt], evaluated!) ||
			(u.coveredThrough !== null && (u.observedAt === null || String(u.coveredThrough) > String(u.observedAt))) ||
			!usageClosed(u.counts, "unpriced unresolvedIdentities") ||
			![u.counts.unpriced, u.counts.unresolvedIdentities].every((n) => n === null || usageCount(n)) ||
			!usageFaults(u.faults) ||
			(u.list !== null &&
				(!usageClosed(u.list, "grossObservations deduplicatedRecorded") ||
					!usageUsd(u.list.grossObservations) ||
					!usageUsd(u.list.deduplicatedRecorded))) ||
			!usageList(
				u.otherBases,
				2,
				(b) =>
					usageClosed(b, "basis knownUsd unpriced") &&
					usageChoice(b.basis, ["provider-reported", "invoice"]) &&
					usageUsd(b.knownUsd) &&
					usageCount(b.unpriced),
			) ||
			new Set(u.otherBases.map((b) => (b as { basis: string }).basis)).size !== u.otherBases.length
		)
			return null;
		const required = raw.sources.filter(
			(s) => (s as { required: boolean }).required,
		) as import("./types").UiRoleUsageSource[];
		const clean =
			raw.state === "ready" &&
			raw.storage === "healthy" &&
			raw.inventory === "complete" &&
			(raw.faults as unknown[]).length === 0 &&
			(u.faults as unknown[]).length === 0 &&
			u.freshness === "fresh" &&
			u.coveredThrough !== null &&
			String(u.coveredThrough) >= u.window.through &&
			u.observedAt !== null &&
			Date.parse(evaluated!) - Date.parse(String(u.observedAt)) <= 60_000 &&
			u.list !== null &&
			u.counts.unpriced === 0 &&
			u.counts.unresolvedIdentities === 0 &&
			required.length > 0 &&
			required.every(
				(s) =>
					s.kind !== "temper" &&
					s.enabled &&
					!s.stalled &&
					s.state === "complete" &&
					s.coveredThrough !== null &&
					s.coveredThrough >= String(u.coveredThrough) &&
					s.observedAt !== null &&
					s.observedAt >= String(u.observedAt),
			);
		if (u.usageCoverage === "complete" && !clean) return null;
		const f = u.funding;
		if (f === null) {
			if (u.fundingCoverage === "complete") return null;
		} else if (
			!usageClosed(
				f,
				"wholePolicySubject verifiedOwnLowerBound exempt otherPolicy unallocated unallocatedFacts remainingUsd",
			) ||
			typeof f.wholePolicySubject !== "boolean" ||
			![f.verifiedOwnLowerBound, f.exempt, f.otherPolicy, f.unallocated].every(usageUsd) ||
			!usageCount(f.unallocatedFacts) ||
			(f.remainingUsd !== null && !usageUsd(f.remainingUsd)) ||
			usageChoice(u.fundingCoverage, ["unavailable", "not-evaluated"]) ||
			(u.fundingCoverage === "complete" && (!clean || u.usageCoverage !== "complete" || f.unallocatedFacts !== 0)) ||
			(f.remainingUsd !== null &&
				(!clean ||
					u.usageCoverage !== "complete" ||
					u.fundingCoverage !== "complete" ||
					!f.wholePolicySubject ||
					f.unallocatedFacts !== 0))
		)
			return null;
	}
	// Everything is checked before the type assertion; no untrusted key/string reaches a label.
	const value = raw as unknown as import("./types").UiRoleUsageCost;
	const usage = value.usage;
	const stale =
		value.state !== "ready" ||
		value.weekStart !== usageWeek(now) ||
		evaluated === null ||
		now - Date.parse(evaluated) > 60_000 ||
		usage?.freshness !== "fresh" ||
		[usage?.coveredThrough, usage?.observedAt].some(
			(t) => t !== null && t !== undefined && now - Date.parse(t) > 60_000,
		);
	const requiredTemper = value.sources.some((s) => s.required && s.kind === "temper");
	const coverage = !usage
		? "unavailable"
		: usage.usageCoverage === "complete" && stale
			? "partial"
			: usage.usageCoverage;
	const funding = usage?.fundingCoverage ?? "not-evaluated";
	const lines = [
		`Automatic — recorded known list subtotal: ${usage?.list ? `$${usage.list.deduplicatedRecorded} USD` : "UNKNOWN"}`,
		`Gross list observations (may overlap): ${usage?.list ? `$${usage.list.grossObservations} USD` : "UNKNOWN"}`,
		`Usage source-attributed to this role — own and requested mixed; usage coverage: ${requiredTemper ? "UNKNOWN (Temper); " : ""}${coverage}${stale ? "; stale/unverified" : ""}`,
		`Funding: ${funding === "not-evaluated" ? "not evaluated" : stale && funding === "complete" ? "partial" : funding}; ${!stale && usage?.funding?.remainingUsd !== null && usage?.funding?.remainingUsd !== undefined ? `reporting remainder $${usage.funding.remainingUsd} USD — not spending permission` : "UNKNOWN — no certified budget remainder"}`,
		`Unpriced list facts: ${usageN(usage?.counts.unpriced ?? null)}; unresolved identities: ${usageN(usage?.counts.unresolvedIdentities ?? null)}`,
		`Week (America/Los_Angeles): ${value.weekStart ?? "UNKNOWN"}; evaluated ${usageStamp(evaluated)}; covered ${usageStamp(usage?.coveredThrough ?? null)}; observed ${usageStamp(usage?.observedAt ?? null)}`,
	];
	for (const b of usage?.otherBases ?? [])
		lines.push(
			`${b.basis} known subtotal: $${b.knownUsd} USD; unpriced: ${b.unpriced} — separate basis, not added to list`,
		);
	if (usage?.funding) {
		const f = usage.funding;
		lines.push(
			`List allocation breakdown (already included, not additional): verified own lower bound $${f.verifiedOwnLowerBound}; exempt $${f.exempt}; other policy $${f.otherPolicy}; unallocated $${f.unallocated} USD (${f.unallocatedFacts} facts)`,
		);
	}
	for (const s of value.sources.slice(0, 24)) {
		if (s.kind === "temper") {
			const f = s.frontier;
			const age = s.observedAt === null ? null : now - Date.parse(s.observedAt);
			const diagnostic =
				f.stallCodes.includes("dead-man") || f.freshness === "dead-man" || (age !== null && age >= 300_000)
					? "dead-man"
					: f.stallCodes.includes("drain-stalled") || f.freshness === "stalled"
						? "stalled"
						: f.stallCodes.includes("delayed") || f.freshness === "delayed" || (age !== null && age > 60_000)
							? "delayed"
							: f.freshness;
			lines.push(
				`Temper recorded through ${usageStamp(f.recorded_through)}; coverage UNKNOWN; diagnostic only: ${diagnostic}; observed ${usageStamp(s.observedAt)}; frontier age ${age === null ? "UNKNOWN" : `${Math.floor(age / 1000)}s`}; pending ${usageN(f.pending_count)}; oldest pending ${usageStamp(f.oldest_pending)}; last drain ${usageStamp(f.last_drain)}; inspected ${usageStamp(f.assessed_from)} to ${usageStamp(f.assessed_through)}; stall codes: ${f.stallCodes.join(", ") || "none recorded"}`,
			);
		} else
			lines.push(
				`${s.kind.toUpperCase()} source #${s.index}: ${s.state}; covered ${usageStamp(s.coveredThrough)}; observed ${usageStamp(s.observedAt)}; progress ${usageStamp(s.lastProgressAt)}; diagnostic ${s.alarm ?? (s.stalled ? "stalled" : "no stall recorded")}`,
			);
	}
	if (value.sources.length > 24) lines.push(`${value.sources.length - 24} additional source diagnostics not shown`);
	const faults = value.faults.concat(usage?.faults ?? []);
	if (faults.length) lines.push(`Recorded faults: ${faults.map((f) => `${f.code} (${f.count})`).join(", ")}`);
	lines.push(
		`Collector ${value.state}; storage ${value.storage}; inventory ${value.inventory}. Reporting only; unknown costs are not zero or permission.`,
	);
	return { value, stale, lines };
}

export interface UsefulRole {
	roleId: string;
	roleLabel: string;
	labelTruncated: boolean;
	partial: boolean;
	queueEnabled: boolean | null;
	stopReason: StopReason | null;
	hold: PauseMarker;
	counts: { active: ReplayCount; queued: ReplayCount; done: ReplayCount; dropped: ReplayCount };
	active: UsefulRecords;
	queued: UsefulRecords;
	/** queue-drop: the tasks its lead dropped, newest first (the server sends at most ROLES_DROPPED_MAX). */
	dropped: UsefulRecords;
	spend?: UsefulSpend | null;
	usageCost?: UsefulUsageCost | null;
	/** roles-lanes: lanes it may run at once and how many are in use; null (or absent) = not recorded. */
	lanes?: { atOnce: number; inUse: number } | null;
	/** roles-links (Ops #222): its open tasks by where each belongs (in a project, under an initiative,
	 *  standalone, not recorded); null (or absent) = not recorded. */
	links?: UsefulLinks | null;
	/** roles-model: the model its home chat runs, as that chat's header names it; absent = not recorded. */
	model?: string;
}
/** roles-links (Ops #222): open tasks by parent, as the server counts them (UiRoleQueue.links). */
export interface UsefulLinks {
	project: number;
	initiative: number;
	standalone: number;
	unrecorded: number;
}
export interface NeedsYouItem {
	/** Validated roster id, for associating the ask with one role's panel, never its display name. */
	roleId: string | null;
	/** Its place in the feed; React only, never rendered. */
	key: string;
	/** Opaque AskHub target, kept only in memory. No URL or DOM data attribute. */
	answer?: { key: string; id: string };
	/** null: an unknown or invalid role; the row says "Unknown role". */
	roleLabel: string | null;
	/** null: absent or unsafe; the row says "Open item". */
	text: string | null;
	/** null: absent, invalid or in the future; the row says "time unknown". */
	since: number | null;
	link: UsefulOpenTarget | null;
}
export interface NeedsYou {
	tell: TellState;
	/** When this window applied the last full update in this connection (its clock); only when "can-tell". */
	asOf: number | null;
	/** Every ask the feed reported, unreadable ones included. */
	total: number;
	items: NeedsYouItem[];
	/** Asks beyond ASK_LIMIT, unreadable ones included. */
	more: number;
}
export interface UsefulRoles {
	source: SourceState;
	roster: "reported" | "unavailable";
	omitted: boolean;
	/** The roles below are as last received, not current (not live, feed error, no full update yet). */
	lastReceived: boolean;
	roles: UsefulRole[];
	needsYou: NeedsYou;
	/** pages-live: while an alarm waits for fresh data, when that wait ends (this clock, ms), so the page
	 *  can look again then; missing when nothing waits or the tab is hidden. */
	graceUntil?: number;
}

export type Fields = Record<string, unknown>;
type Bounded = { text: string; clipped: boolean };
/* roles-panel: the role panel (roles-panel-model.ts) projects through the same checks; they are exported for it. */
export function object(value: unknown): Fields | null {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Fields) : null;
}
export function roleId(value: unknown): value is string {
	// Require the entire matched value, not a prefix match.
	return typeof value === "string" && /^[a-z][a-z0-9-]{0,31}$/.exec(value)?.[0] === value;
}
export function taskId(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}
export function time(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}
function status(value: unknown): ReportedStatus | null {
	return STATUSES.find((candidate) => candidate === value) ?? null;
}
function stop(value: unknown): StopReason | null {
	return STOP_REASONS.find((candidate) => candidate === value) ?? null;
}
export function marker(record: Fields | null, key: string): PauseMarker {
	if (!record) return "unknown";
	if (!Object.hasOwn(record, key)) return "not-reported";
	const value = object(record[key]);
	return value &&
		typeof value.at === "number" &&
		Number.isFinite(value.at) &&
		typeof value.why === "string" &&
		value.why.trim().length > 0
		? "reported-paused"
		: "unknown";
}
/** A reported number, 0 included, only when the role's queue was read without problems, the field is
 *  a safe integer >= 0 (no defaults) and it fits the rows received. Otherwise "couldn't read". */
/** roles-lanes: pi-queue's MAX_LANES. */
const LANES_MAX = 8;
/** roles-lanes: a readable queue's lanes, only when both numbers are whole and 0 <= inUse <= atOnce <= 8. */
function laneUse(value: unknown, readable: boolean): { atOnce: number; inUse: number } | null {
	const v = object(value);
	const atOnce = v?.atOnce;
	const inUse = v?.inUse;
	return readable &&
		typeof atOnce === "number" &&
		typeof inUse === "number" &&
		Number.isSafeInteger(atOnce) &&
		Number.isSafeInteger(inUse) &&
		atOnce >= 1 &&
		atOnce <= LANES_MAX &&
		inUse >= 0 &&
		inUse <= atOnce
		? { atOnce, inUse }
		: null;
}
/** roles-links (Ops #222): a readable queue's open tasks by parent, only when all four are whole numbers >= 0. */
function linkCounts(value: unknown, readable: boolean): UsefulLinks | null {
	const v = object(value);
	if (!readable || !v) return null;
	const links: UsefulLinks = { project: 0, initiative: 0, standalone: 0, unrecorded: 0 };
	for (const key of ["project", "initiative", "standalone", "unrecorded"] as const) {
		const n = v[key];
		if (typeof n !== "number" || !Number.isSafeInteger(n) || n < 0) return null;
		links[key] = n;
	}
	return links;
}
function count(value: unknown, readable: boolean, fits: (n: number) => boolean = () => true): ReplayCount {
	return readable && typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && fits(value)
		? value
		: "unavailable";
}
/** Any reported problem (or a malformed list); absence or an empty list means none. */
function anyProblem(value: unknown): boolean {
	return value !== undefined && (!Array.isArray(value) || value.length > 0);
}
/** An ask's start: a safe integer, not further ahead of this browser's clock than CLOCK_SKEW_MS. */
function sinceOf(value: unknown, now: number | undefined): number | null {
	return typeof value === "number" &&
		Number.isSafeInteger(value) &&
		value > 0 &&
		(now === undefined || value <= now + CLOCK_SKEW_MS)
		? value
		: null;
}
/** Agent-written text -> bounded plain text, or null when absent or unsafe. Never partly shown:
 *  an unsafe character anywhere rejects all of it. */
export function plain(value: unknown, limit: number): Bounded | null {
	if (typeof value !== "string") return null;
	const text = value.replace(/[\t\n\r]+/g, " ").trim();
	if (!text || UNSAFE.test(text)) return null;
	// At most 2 code units per code point: this head holds limit + 1 whole code points if more exist.
	const head = Array.from(text.slice(0, limit * 2 + 2));
	if (text.length <= limit * 2 + 2 && head.length <= limit) return { text, clipped: false };
	return { text: head.slice(0, limit - 1).join("") + "…", clipped: true };
}
function label(value: unknown, id: string): { text: string; truncated: boolean } {
	const bounded = plain(value, LABEL_LIMIT);
	return bounded ? { text: bounded.text, truncated: bounded.clipped } : { text: id, truncated: false };
}
/** A transcript path as the feed gives it: absolute, .jsonl, no empty, "." or ".." segment, no unsafe
 *  character. The server checks it again (inside the sessions folder) when it is opened. */
export function chatFile(value: unknown): string | null {
	if (typeof value !== "string" || value.length > PATH_LIMIT || UNSAFE.test(value) || !value.endsWith(".jsonl"))
		return null;
	const root = /^(\/|[A-Za-z]:[\\/])/.exec(value)?.[0];
	if (!root) return null;
	return value
		.slice(root.length)
		.split(/[\\/]/)
		.every((segment) => segment !== "" && segment !== "." && segment !== "..")
		? value
		: null;
}
export function focusOf(value: unknown): UsefulOpenTarget["focus"] | null {
	if (typeof value !== "string" || value !== value.trim()) return null;
	const focus = parseFocus(value);
	if (!focus) return null;
	return focus.kind === "tldr" || focus.kind === "task" || focus.kind === "question"
		? { kind: focus.kind, id: focus.id }
		: null;
}
export function idFrequencies(
	rows: unknown[],
	getId: (value: unknown) => string | number | null,
): Map<string | number, number> {
	const seen = new Map<string | number, number>();
	for (const row of rows) {
		const id = getId(row);
		if (id !== null) seen.set(id, (seen.get(id) ?? 0) + 1);
	}
	return seen;
}
function rowState(row: Fields, reported: ReportedStatus | null): RowState {
	switch (reported) {
		case "ready":
			// A ready task that waits on other tasks never reads as "ready".
			return typeof row.waitsOn === "string" && row.waitsOn.trim() ? "ready-after" : "ready";
		case "working":
			return "working";
		case "asking":
			if (row.askOps === true) return roleId(row.askLead) && row.askLead !== "ops" ? "asking-lead" : "asking-ops";
			return row.askOps === undefined ? "asking-main" : "asking";
		case "stuck":
			// Task questions go to Ops or the task's lead first (rule 21): "needs you" is for asks only.
			return "needs-decision";
		case "waiting":
			return "on-hold";
		case "blocked":
			return "blocked";
		case "done":
			return "done";
		case "dropped":
			return "dropped";
		default:
			return "unknown";
	}
}
/** Started: its own chat. Not started: its queue (the home chat's Queue tab, at the task). */
function taskLink(row: Fields, id: number, home: string | null): UsefulOpenTarget | null {
	if (row.chat !== undefined) {
		const file = chatFile(object(row.chat)?.file);
		return file ? { file } : null;
	}
	const focus = focusOf(`task:${id}`);
	return home && focus ? { file: home, focus } : null;
}
/** roles-live (Ops #272, docs/live-progress.md): a task's newest own-chat line with its time: `progress`
 *  ({text, at}) when the server sends a readable one, else the older `latest` line and its `ts`. */
export function latestLine(row: Fields): { text: string; at: number | null } | null {
	const progress = object(row.progress);
	const text = plain(progress?.text, TEXT_LIMIT);
	const at = time(progress?.at);
	if (text && at !== null) return { text: text.text, at };
	const latest = object(row.latest);
	const old = plain(latest?.text, TEXT_LIMIT);
	return old ? { text: old.text, at: time(latest?.ts) } : null;
}
const QUESTION_STATES: readonly RowState[] = ["asking", "asking-main", "asking-ops", "asking-lead", "needs-decision"];
export function record(row: Fields, id: number, home: string | null): UsefulRecord {
	const reported = status(row.status);
	const pause = marker(row, "paused");
	const state = rowState(row, reported);
	const latest = state === "working" ? latestLine(row) : null;
	const evidence = evidenceOf(row.evidence);
	const result: UsefulRecord = {
		taskId: id,
		name: plain(row.title, NAME_LIMIT)?.text ?? null,
		state,
		askLead: state === "asking-lead" && roleId(row.askLead) ? row.askLead : null,
		waitsOn: plain(row.waitsOn, NAME_LIMIT)?.text ?? null,
		busy: row.busy === true,
		latest: latest ? latest.text : null,
		dropped: state === "dropped" ? (plain(object(row.dropped)?.why, TEXT_LIMIT)?.text ?? null) : null,
		pause,
		link: taskLink(row, id, home),
	};
	if (evidence) result.evidence = evidence;
	// roles-live: only when the server says, so a row without them reads exactly as before.
	if (latest && latest.at !== null) result.latestAt = latest.at;
	if (QUESTION_STATES.includes(state) && roleId(row.withLead) && row.withLead !== "owner")
		result.withLead = row.withLead;
	return result;
}
function records(
	value: unknown,
	seen: Map<string | number, number>,
	reported: ReplayCount,
	home: string | null,
): UsefulRecords {
	const result: UsefulRecords = {
		available: Array.isArray(value),
		omitted: false,
		notAllShown: typeof reported === "number" && reported > 0,
		records: [],
	};
	if (!Array.isArray(value)) return result;
	// omitted: rows that can't be shown (malformed, or an id seen twice); capped: valid rows past the cap.
	let capped = false;
	for (const raw of value) {
		const row = object(raw);
		if (!row || !taskId(row.id) || seen.get(row.id) !== 1) {
			result.omitted = true;
			continue;
		}
		if (result.records.length >= RECORD_LIMIT) {
			capped = true;
			continue;
		}
		result.records.push(record(row, row.id, home));
	}
	result.notAllShown = capped || (typeof reported === "number" && reported > result.records.length);
	return result;
}
interface ProjectedRole {
	role: UsefulRole;
	/** Every started task chat was read (open dialogs in the rest aren't seen). */
	asksSeen: boolean;
	/** The ask key each stuck task should have ("<role>:task:<n>"), unless reported paused. */
	decisionKeys: string[];
}
function projectRole(row: Fields, id: string, now?: number): ProjectedRole {
	const name = label(row.title, id);
	const queuePresent = row.queue !== undefined;
	const queue = object(row.queue);
	const problems = anyProblem(row.problems);
	const home = chatFile(object(row.homeChat)?.file);
	const rawCounts = object(queue?.counts);
	const activeRows = Array.isArray(queue?.active) ? queue.active.length : null;
	const queuedRows = Array.isArray(queue?.queued) ? queue.queued.length : null;
	// queue-drop: the server sends the dropped list (capped) and its count only when there are some.
	const droppedRows = Array.isArray(queue?.dropped) ? queue.dropped.length : null;
	// Zero is shown like any other number, under the same guards (Security addendum, item 8). Active
	// rows aren't capped, so they must match; queued rows are capped, so the count may be larger.
	const readable = queue !== null && !problems;
	const counts: UsefulRole["counts"] =
		!queuePresent && !problems
			? { active: "no-queue", queued: "no-queue", done: "no-queue", dropped: "no-queue" }
			: {
					active: count(rawCounts?.active, readable, (n) => n === activeRows),
					queued: count(rawCounts?.queued, readable, (n) => queuedRows !== null && n >= queuedRows),
					done: count(rawCounts?.done, readable),
					// Counts read, with neither the dropped count nor the list: none dropped (0).
					dropped: count(
						rawCounts && rawCounts.dropped === undefined && droppedRows === null ? 0 : rawCounts?.dropped,
						readable,
						(n) => (droppedRows === null ? n === 0 : n >= droppedRows),
					),
				};
	// Ambiguity is role-local and spans both received lists, even beyond the display cap.
	const taskRows: unknown[] = [];
	if (Array.isArray(queue?.active)) for (const task of queue.active) taskRows.push(task);
	if (Array.isArray(queue?.queued)) for (const task of queue.queued) taskRows.push(task);
	if (Array.isArray(queue?.dropped)) for (const task of queue.dropped) taskRows.push(task);
	const seen = idFrequencies(taskRows, (raw) => {
		const candidate = object(raw)?.id;
		return taskId(candidate) ? candidate : null;
	});
	const active = records(queue?.active, seen, counts.active, home);
	const queued = records(queue?.queued, seen, counts.queued, home);
	const dropped = records(queue?.dropped, seen, counts.dropped, home);
	let startedChats = 0;
	if (Array.isArray(queue?.active)) for (const task of queue.active) if (object(task)?.chat) startedChats++;
	// The server lists every stuck task's question unless the task, or else its queue, is paused
	// (taskQueueHeld). Only a well-formed pause excuses a missing question.
	const hold = queuePresent ? marker(queue, "hold") : "not-reported";
	const lanes = laneUse(queue?.lanes, readable);
	const links = linkCounts(queue?.links, readable);
	const decisionKeys: string[] = [];
	for (const raw of taskRows) {
		const task = object(raw);
		if (!task || task.status !== "stuck" || !taskId(task.id)) continue;
		if (marker(task, "paused") === "reported-paused" || hold === "reported-paused") continue;
		// roles-live: a question still with a lead isn't the owner's ask (docs/live-progress.md, the owner rule).
		if (roleId(task.withLead) && task.withLead !== "owner") continue;
		decisionKeys.push(`${id}:task:${task.id}`);
	}
	const projected: UsefulRole = {
		roleId: id,
		roleLabel: name.text,
		labelTruncated: name.truncated,
		partial: problems || (queuePresent && (!queue || !active.available || !queued.available)),
		queueEnabled: typeof queue?.running === "boolean" ? queue.running : null,
		stopReason: stop(queue?.pausedReason),
		hold,
		counts,
		active,
		queued,
		dropped,
		spend: projectSpend(row.spend),
	};
	if (Object.hasOwn(row, "usageCost")) projected.usageCost = projectRoleUsageCost(row.usageCost, id, now ?? Date.now());
	// roles-lanes: only when recorded, so a role without them reads exactly as before.
	if (lanes) projected.lanes = lanes;
	// roles-links: the same, so a role without them reads exactly as before.
	if (links) projected.links = links;
	// roles-model: plain bounded text only; anything else reads as not recorded.
	const model = plain(row.model, LABEL_LIMIT);
	if (model) projected.model = model.text;
	return {
		role: projected,
		// roles-asks-read: the server's own word when it gives one (only a real boolean); else the old count rule.
		asksSeen: typeof row.allChatsRead === "boolean" ? row.allChatsRead : startedChats <= TASK_CHATS_READ,
		decisionKeys,
	};
}
function askLink(ask: Fields): UsefulOpenTarget | null {
	const file = chatFile(object(ask.chat)?.file);
	if (!file) return null;
	const focus = focusOf(ask.focus);
	return focus ? { file, focus } : { file };
}
function askKey(value: unknown): value is string {
	return typeof value === "string" && value.length > 0 && value.length <= KEY_LIMIT;
}
function answerTarget(ask: Fields, unique: boolean): NeedsYouItem["answer"] {
	if (
		!unique ||
		!roleId(ask.role) ||
		(ask.kind !== "question" && ask.kind !== "task") ||
		!askKey(ask.key) ||
		UNSAFE.test(ask.key) ||
		typeof ask.askId !== "string" ||
		!ask.askId ||
		ask.askId.length > 200 ||
		UNSAFE.test(ask.askId)
	)
		return undefined;
	const focus = focusOf(ask.focus);
	if (!focus || focus.kind !== ask.kind || ask.key !== `${ask.role}:${ask.kind}:${focus.id}`) return undefined;
	return { key: ask.key, id: ask.askId };
}
function needsYou(
	overview: Fields | null,
	labels: Map<string, string>,
	source: SourceState,
	roles: { asksSeen: boolean; decisionKeys: string[] },
	applied: number | null,
	now: number | undefined,
): NeedsYou {
	const listed = Array.isArray(overview?.asks);
	const raw: unknown[] = Array.isArray(overview?.asks) ? overview.asks : [];
	const items: NeedsYouItem[] = [];
	const keys = new Set<string>();
	const counts = idFrequencies(raw, (value) => {
		const key = object(value)?.key;
		return askKey(key) ? key : null;
	});
	// Feed order (oldest first). Every entry counts; one that can't be read still shows, as "Open item".
	raw.forEach((value, index) => {
		const ask = object(value) ?? {};
		if (askKey(ask.key)) keys.add(ask.key);
		if (index >= ASK_LIMIT) return;
		items.push({
			key: String(index),
			roleId: roleId(ask.role) && labels.has(ask.role) ? ask.role : null,
			answer: answerTarget(ask, counts.get(String(ask.key)) === 1),
			roleLabel: roleId(ask.role) ? (labels.get(ask.role) ?? null) : null,
			text: plain(ask.text, TEXT_LIMIT)?.text ?? null,
			since: sinceOf(ask.since, now),
			link: askLink(ask),
		});
	});
	let tell: TellState;
	if (source === "disconnected" || source === "cached" || source === "stale") tell = "not-live";
	else if (source === "error" || source === "cached-error") tell = "feed-error";
	else if (source === "awaiting" || source === "updating") tell = "awaiting";
	else if (source === "partial" || !roles.asksSeen || (overview !== null && !listed)) tell = "partial";
	else if (source !== "connected-source-unverified") tell = "unknown";
	// Withdrawn on every new watch and every error until the server is heard looking again (roles-state appliedAt).
	else if (applied === null) tell = "awaiting";
	// A stuck task whose question isn't in the list: the list can't be the whole story.
	else if (roles.decisionKeys.some((key) => !keys.has(key))) tell = "decision";
	else tell = "can-tell";
	return {
		tell,
		asOf: tell === "can-tell" ? applied : null,
		total: raw.length,
		items,
		more: Math.max(0, raw.length - ASK_LIMIT),
	};
}

/** pages-live (Ops #244): when the page's wait for a new check began: the store's waitingSince (a lost
 *  connection, a pending full watch, a failed look) or the moment a silent feed turned stale, whichever
 *  came first. null: no wait this page knows the start of. */
function waitStart(input: Fields | null, heard: number | null, stale: boolean): number | null {
	const since = time(input?.waitingSince);
	const staleAt = stale && heard !== null ? heard + STALE_MS : null;
	if (since === null) return staleAt;
	return staleAt === null ? since : Math.min(since, staleAt);
}

/** Input deliberately unknown: validate at the actual store/consumer boundary, not only by DTO types.
 *  `now` (this browser's clock) turns a silent feed into "stale"; without it nothing is aged.
 *  `live` (pages-live): when the tab last became visible (null: hidden). With it, a wait for a new check
 *  shows as "updating" (the last data, or "awaiting" with none) for up to LIVE_GRACE_MS of visible time
 *  before it turns into its alarm; without it every alarm shows at once. */
export function projectUsefulRoles(
	state: unknown,
	connection: unknown,
	now?: number,
	live?: { visibleAt: number | null },
): UsefulRoles {
	const input = object(state);
	const overview = object(input?.overview);
	const rows = Array.isArray(overview?.roles) ? overview.roles : [];
	const seen = idFrequencies(rows, (raw) => {
		const candidate = object(raw)?.id;
		return roleId(candidate) ? candidate : null;
	});
	const roles: UsefulRole[] = [];
	const labels = new Map<string, string>();
	let omitted = false;
	const coverage = { asksSeen: true, decisionKeys: [] as string[] };
	for (const raw of rows) {
		const row = object(raw);
		if (!row || !roleId(row.id) || seen.get(row.id) !== 1 || roles.length >= ROLE_LIMIT) {
			omitted = true;
			continue;
		}
		const projected = projectRole(row, row.id, now);
		roles.push(projected.role);
		labels.set(projected.role.roleId, projected.role.roleLabel);
		if (!projected.asksSeen) coverage.asksSeen = false;
		for (const key of projected.decisionKeys) coverage.decisionKeys.push(key);
	}
	const cached = overview !== null;
	const error =
		input?.status === "error" || (input !== null && Object.hasOwn(input, "error") && input.error !== undefined);
	const heard = time(input?.heardAt);
	const stale = cached && typeof now === "number" && (heard === null || now - heard > STALE_MS);
	let source: SourceState;
	if (connection === "closed" || connection === "connecting") source = cached ? "cached" : "disconnected";
	else if (error) source = cached ? "cached-error" : "error";
	else if (!cached && (input?.status === "idle" || input?.status === "loading")) source = "awaiting";
	else if (connection !== "open" || !cached) source = "unknown";
	else if (stale) source = "stale";
	else if (!roles.length || omitted || roles.some((row) => row.partial)) source = "partial";
	else source = "connected-source-unverified";
	let graceUntil: number | undefined;
	// pages-live: an alarm (or a pending watch) waits for the page's own fresh data, never past the grace.
	if (live && typeof now === "number") {
		const waiting =
			source === "cached" ||
			source === "cached-error" ||
			source === "stale" ||
			source === "disconnected" ||
			source === "error" ||
			(source === "connected-source-unverified" && time(input?.appliedAt) === null);
		const start = waiting ? waitStart(input, heard, stale) : null;
		const left = start !== null ? graceLeft(start, now, time(live.visibleAt)) : 0;
		if (left > 0) {
			source = cached ? "updating" : "awaiting";
			if (time(live.visibleAt) !== null) graceUntil = now + left;
		}
	}
	const needs = needsYou(overview, labels, source, coverage, time(input?.appliedAt), now);
	const model: UsefulRoles = {
		source,
		roster: roles.length ? "reported" : "unavailable",
		omitted,
		// Security addendum (item 8): whenever the page can't tell, counts are marked last received, not current.
		lastReceived: roles.length > 0 && needs.tell !== "can-tell",
		roles,
		needsYou: needs,
	};
	if (graceUntil !== undefined) model.graceUntil = graceUntil;
	return model;
}
