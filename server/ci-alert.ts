/**
 * ci-alert (Ops #720): what a CI alert may say. A script on this machine (the CI watch) tells a role's home chat
 * that a CI run failed, was cut off, or never appeared, through the control socket's ci_alert (with the app
 * token). The server writes the whole message from the fields checked here: a caller can't put free text in,
 * no logs, no test output. docs/ci-alert.md is the contract.
 *
 * Here: checkCiAlert (the fields, closed enums and their combinations), ciAlertKey (the dedupe key),
 * ciAlertText (the message), ciAlertTitle (the header's words) and ciAlertHint (what the receiving chat does).
 * Pure: role-messages.ts RoleMessages.requestCiAlert sends it on the app-report path.
 */
import { statusHint } from "./turn-status.js";

export type CiAlertKind = "failed" | "missing";
/** How a failed run ended (GitHub's conclusion). */
export type CiConclusion = "failure" | "timed_out" | "startup_failure" | "cancelled";
/** Why a cancelled run was cancelled, as the watcher worked it out. */
export type CiCancelReason = "time-limit" | "by-hand" | "unknown";
/** What started the run. */
export type CiEvent = "schedule" | "workflow_dispatch";

/** A checked alert: every field is one of the closed shapes checkCiAlert allows. */
export interface CiAlert {
	kind: CiAlertKind;
	repo: string;
	workflow: string;
	/** kind failed: the run. */
	runId?: string;
	/** https://github.com/<repo>/actions/runs/<digits> */
	url?: string;
	/** 40 hex, lower case. */
	sha?: string;
	/** At most 15 jobs that failed or didn't finish; unsafe names become "(name not shown)". */
	jobs?: string[];
	/** kind missing: the scheduled slot that got no run (ISO, UTC). */
	slot?: string;
	/** kind failed: always set (failure when the caller gave none). */
	conclusion?: CiConclusion;
	/** conclusion cancelled: always set (unknown when the caller gave none). */
	cancelReason?: CiCancelReason;
	/** cancelReason time-limit: the limit in minutes. */
	limitMinutes?: number;
	event?: CiEvent;
}

export type CiAlertCheck = { ok: true; alert: CiAlert } | { ok: false; error: string };

export const CI_JOBS_SHOWN = 15;
export const CI_JOB_NAME_MAX = 80;
export const CI_NAME_NOT_SHOWN = "(name not shown)";
const CI_WORKFLOW_MAX = 100;

const KINDS: readonly CiAlertKind[] = ["failed", "missing"];
const CONCLUSIONS: readonly CiConclusion[] = ["failure", "timed_out", "startup_failure", "cancelled"];
const CANCEL_REASONS: readonly CiCancelReason[] = ["time-limit", "by-hand", "unknown"];
const EVENTS: readonly CiEvent[] = ["schedule", "workflow_dispatch"];
/** The fields each kind takes; any other key is refused. */
const FIELDS: Readonly<Record<CiAlertKind, readonly string[]>> = {
	failed: [
		"kind",
		"repo",
		"workflow",
		"runId",
		"url",
		"sha",
		"jobs",
		"conclusion",
		"cancelReason",
		"limitMinutes",
		"event",
	],
	missing: ["kind", "repo", "workflow", "slot", "event"],
};

const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const WORKFLOW_RE = /^[A-Za-z0-9 _./()-]+$/;
const RUN_ID_RE = /^[A-Za-z0-9._:-]{1,64}$/;
const SHA_RE = /^[0-9a-fA-F]{40}$/;
const JOB_RE = /^[A-Za-z0-9 _.:/()[\],-]+$/;
const RUN_DIGITS_RE = /^[0-9]+$/;
const JOB_HEADER_RE = /(?:^|\s)\[(?:Role message|Board(?: order)?|Queue|System)(?:\s|\])/i;
const SLOT_RE =
	/^([0-9]{4})-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])T([01][0-9]|2[0-3]):[0-5][0-9](:[0-5][0-9](\.[0-9]+)?)?(Z|[+-]([01][0-9]|2[0-3]):[0-5][0-9])$/;

/** Date.parse rolls impossible dates into the next month: check the calendar before normalising. */
function isoSlot(raw: unknown): string | undefined {
	if (typeof raw !== "string") return;
	const parts = SLOT_RE.exec(raw);
	if (!parts) return;
	const year = Number(parts[1]);
	const month = Number(parts[2]);
	const day = Number(parts[3]);
	const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
	const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
	if (day > days[month - 1]!) return;
	const time = Date.parse(raw);
	return Number.isNaN(time) ? undefined : new Date(time).toISOString();
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;
}

function oneOf<T extends string>(v: unknown, allowed: readonly T[]): v is T {
	return typeof v === "string" && (allowed as readonly string[]).includes(v);
}

/** A job name as it may appear in the message: the allowed characters only, else "(name not shown)". */
export function shownJobName(v: unknown): string {
	if (typeof v !== "string" || v.length > CI_JOB_NAME_MAX || !JOB_RE.test(v) || JOB_HEADER_RE.test(v))
		return CI_NAME_NOT_SHOWN;
	return v;
}

/** The checked alert, or why it's refused. Unknown keys, bad values and fields that don't fit the kind (or the
 *  conclusion, or the cancel reason) are refused. */
export function checkCiAlert(raw: unknown): CiAlertCheck {
	const no = (error: string): CiAlertCheck => ({ ok: false, error });
	if (!isPlainObject(raw)) return no("alert must be an object");
	const kind = raw.kind;
	if (!oneOf(kind, KINDS)) return no('alert.kind must be "failed" or "missing"');
	const extra = Object.keys(raw).filter((k) => !FIELDS[kind].includes(k));
	if (extra.length) {
		const names = extra.slice(0, 5).map((k) => k.slice(0, 30).replace(/[^A-Za-z0-9_]/g, "?"));
		return no(
			`alert.${names.join(", alert.")} ${extra.length === 1 ? "isn't a field" : "aren't fields"} of a ${kind} alert`,
		);
	}

	const repo = raw.repo;
	if (typeof repo !== "string" || !REPO_RE.test(repo)) return no("alert.repo must be owner/name");
	const workflow = raw.workflow;
	if (typeof workflow !== "string" || workflow.length > CI_WORKFLOW_MAX || !WORKFLOW_RE.test(workflow))
		return no(`alert.workflow must be 1-${CI_WORKFLOW_MAX} characters of letters, digits, space and _./()-`);
	const event = raw.event;
	if (event !== undefined && !oneOf(event, EVENTS)) return no("alert.event must be schedule or workflow_dispatch");
	const common: CiAlert = { kind, repo, workflow, ...(event === undefined ? {} : { event }) };

	if (kind === "missing") {
		const slot = isoSlot(raw.slot);
		if (!slot) return no("alert.slot must be an ISO time, e.g. 2026-11-01T06:00:00Z");
		return { ok: true, alert: { ...common, slot } };
	}

	const runId = raw.runId;
	if (typeof runId !== "string" || !RUN_ID_RE.test(runId))
		return no("a failed alert needs alert.runId: 1-64 characters of letters, digits and ._:-");
	const alert: CiAlert = { ...common, runId };
	if (raw.url !== undefined) {
		const url = raw.url;
		const prefix = `https://github.com/${repo}/actions/runs/`;
		if (typeof url !== "string" || !url.startsWith(prefix) || !RUN_DIGITS_RE.test(url.slice(prefix.length)))
			return no(`alert.url must be https://github.com/${repo}/actions/runs/<digits>`);
		alert.url = url;
	}
	if (raw.sha !== undefined) {
		if (typeof raw.sha !== "string" || !SHA_RE.test(raw.sha)) return no("alert.sha must be 40 hex characters");
		alert.sha = raw.sha.toLowerCase();
	}
	if (raw.jobs !== undefined) {
		if (!Array.isArray(raw.jobs)) return no("alert.jobs must be a list of job names");
		if (raw.jobs.length > CI_JOBS_SHOWN) return no(`alert.jobs may contain at most ${CI_JOBS_SHOWN} names`);
		alert.jobs = raw.jobs.map(shownJobName);
	}
	// Only a missing field takes the default: null is a bad value, refused like any other.
	const conclusion = raw.conclusion === undefined ? "failure" : raw.conclusion;
	if (!oneOf(conclusion, CONCLUSIONS))
		return no("alert.conclusion must be failure, timed_out, startup_failure or cancelled");
	alert.conclusion = conclusion;
	if (raw.cancelReason !== undefined && conclusion !== "cancelled")
		return no("alert.cancelReason goes only with conclusion cancelled");
	if (conclusion === "cancelled") {
		const reason = raw.cancelReason === undefined ? "unknown" : raw.cancelReason;
		if (!oneOf(reason, CANCEL_REASONS)) return no("alert.cancelReason must be time-limit, by-hand or unknown");
		alert.cancelReason = reason;
	}
	if (raw.limitMinutes !== undefined) {
		if (alert.cancelReason !== "time-limit") return no("alert.limitMinutes goes only with cancelReason time-limit");
		const n = raw.limitMinutes;
		if (typeof n !== "number" || !Number.isInteger(n) || n < 1 || n > 1440)
			return no("alert.limitMinutes must be a whole number from 1 to 1440");
		alert.limitMinutes = n;
	}
	return { ok: true, alert };
}

/** The dedupe key: one alert per run (failed) or per missed slot (missing). */
export function ciAlertKey(a: Pick<CiAlert, "kind" | "repo" | "workflow" | "runId" | "slot">): string {
	return a.kind === "missing"
		? `${a.repo}:${a.workflow}:missing:${a.slot ?? ""}`
		: `${a.repo}:${a.workflow}:${a.runId ?? ""}`;
}

/** What happened, in a few words (the header's kind). */
export function ciAlertWhat(a: Pick<CiAlert, "kind" | "conclusion">): string {
	if (a.kind === "missing") return "missing run";
	switch (a.conclusion) {
		case "timed_out":
			return "timed out";
		case "startup_failure":
			return "failed to start";
		case "cancelled":
			return "cancelled";
		default:
			return "failed";
	}
}

/** The header's words after "from the CI watch": what happened, the repo and the workflow. */
export function ciAlertTitle(a: Pick<CiAlert, "kind" | "conclusion" | "repo" | "workflow">): string {
	return `${ciAlertWhat(a)} \u00b7 ${a.repo} \u00b7 ${a.workflow}`;
}

function endedWith(a: CiAlert): string {
	switch (a.conclusion) {
		case "timed_out":
			return "timed out";
		case "startup_failure":
			return "failed to start";
		case "cancelled":
			if (a.cancelReason === "time-limit")
				return a.limitMinutes ? `was cut off by its ${a.limitMinutes}-min time limit` : "was cut off by its time limit";
			if (a.cancelReason === "by-hand") return "was cancelled by hand";
			return "was cancelled (no reason given)";
		default:
			return "failed";
	}
}

/** The message, from the checked fields only. */
export function ciAlertText(a: CiAlert): string {
	if (a.kind === "missing")
		return `CI watch: ${a.repo} ${a.workflow}: the run scheduled for ${a.slot ?? "?"} never appeared.`;
	const run = a.event === "schedule" ? "nightly run" : a.event === "workflow_dispatch" ? "manual run" : "run";
	const at = a.sha ? ` on commit ${a.sha.slice(0, 7)}` : "";
	let text = `CI watch: ${a.repo} ${a.workflow}, ${run} ${a.runId ?? "?"}${at} ${endedWith(a)}.`;
	if (a.jobs?.length) {
		const label = a.conclusion === "cancelled" || a.conclusion === "timed_out" ? "Jobs not finished" : "Failed jobs";
		text += ` ${label}: ${a.jobs.join(", ")}.`;
	}
	if (a.url) text += ` ${a.url}`;
	return text;
}

/** The hint under a CI alert: what the receiving chat does with it. turn-status (Ops #688): its turn ends
 *  with one status line, as the work check's wake asks. */
export function ciAlertHint(a: Pick<CiAlert, "kind">): string {
	const action =
		a.kind === "missing"
			? "(The CI watch found a scheduled CI run that never appeared. Look into it with your tools: check the workflow's schedule and whether it is turned on, then fix it or queue the fix."
			: "(The CI watch found a CI run that didn't pass. Look into it with your tools: open the run, find the failing tests, then fix them or queue the fix.";
	return `${action} No reply is needed. ${statusHint("poke")})`;
}
