/** What the page says about its own data: whether it is loading or offline, the heading's department count and date,
 *  the freshness pill (and its Retry or Refresh), the approvals-off chip, and the footer lines. */
import {
	EXACT_SOURCE,
	exactAge,
	exactClock,
	exactWhen,
	type ExactApprovalsOff,
	type ExactRoles,
} from "../roles-exact-model";
import type { SurfaceValues } from "../roles-u0/types";
import type { TellState } from "../roles-useful-model";
import type { ExactViewState } from "./view-state";

/** ladder-alarm: the amber chip's words, and its tooltip: fixed words around the start's own reason (projected
 *  plain text) and when this server started. */
export const APPROVALS_OFF_TEXT = "Message approvals off";
export function approvalsTip(off: ExactApprovalsOff, now: number): string {
	const reason = off.reason?.replace(/[.\s]+$/u, "") || "not recorded";
	const since = off.since !== null ? ` at ${exactWhen(off.since, now)}` : "";
	return `Chains between roles stop at 6 messages and nobody can approve more. Reason: ${reason}. Off since this server started${since}.`;
}
/** roles-small-fixes N2: why a connected feed's owner asks can't be confirmed (fixed words only). */
const ASKS_UNCONFIRMED: Partial<Record<TellState, { label: string; body: string }>> = {
	partial: {
		label: "Asks unconfirmed: some roles not read",
		body: "Not every role\u2019s open asks were read, so this list may be missing some. Open the original chats for anything not shown here.",
	},
	decision: {
		label: "Asks unconfirmed: a stuck task\u2019s question is missing",
		body: "A stuck task is waiting on you, but its question isn\u2019t in this list. Open that role\u2019s chat to answer it.",
	},
	awaiting: {
		label: "Asks unconfirmed: still checking",
		body: "The server hasn\u2019t confirmed the current asks since this page connected. The list below is the last one received.",
	},
};

export function pageStatusValues(model: ExactRoles, view: ExactViewState): SurfaceValues {
	const source = EXACT_SOURCE[model.source];
	const loading = model.source === "awaiting" && model.roster === "unavailable";
	const needs = model.needs;
	const unavailable = model.source !== "connected-source-unverified" || needs.tell !== "can-tell";
	const failed = ["error", "cached-error", "disconnected", "cached"].includes(model.source);
	const stale = model.source === "stale";
	// pages-live: "Updating" is calm (neutral) for up to LIVE_GRACE_MS; the red or amber state follows if no check comes.
	const updating = model.source === "updating";
	const palette = failed
		? { bg: "#221415", bd: "#5A2A2C", fg: "#FF8A80" }
		: stale || (unavailable && !loading && !updating)
			? { bg: "#1D1A12", bd: "#4D3F1F", fg: "#F0B95A" }
			: { bg: "#16181B", bd: "#2A2E34", fg: "#ECEDEE" };
	const receipt =
		model.receivedAt !== null
			? `last received ${exactClock(model.receivedAt)}${stale ? ` (${exactAge(model.receivedAt, model.now)} ago)` : ""}`
			: model.hasOverview
				? "receipt time unknown"
				: "nothing loaded yet";
	// roles-small-fixes N2: a connected feed whose asks can't be confirmed says why, in amber.
	const asksWhy = model.source === "connected-source-unverified" ? ASKS_UNCONFIRMED[needs.tell] : undefined;
	const freshText = unavailable
		? `${model.source === "connected-source-unverified" ? (asksWhy?.label ?? "Incomplete status") : source.label} · ${receipt}`
		: `Live · ${model.receivedAt !== null ? `updated ${exactClock(model.receivedAt)}` : receipt}`;
	// roles-retry-pill (owner 2026-10-18): the freshness banner never shows. Its reason moves into the
	// status pill's tooltip, and the pill does the banner's old Retry now / Refresh now in every state.
	const why = {
		title: source.title || "Some owner asks could not be confirmed",
		body:
			source.body ||
			asksWhy?.body ||
			"The received list may be incomplete. Open the original chats for anything not shown here.",
	};
	const date = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" }).format(model.now);
	return {
		loading,
		offline: model.source === "disconnected",
		lastKnown: model.lastReceived,
		isGlance: true,
		headingSummary:
			model.roster === "reported"
				? `${model.roles.length} departments${model.omitted ? " shown · some unavailable" : ""} · ${date}`
				: "Department list unavailable",
		fresh: {
			text: freshText,
			fg: unavailable ? palette.fg : "#9FD8B8",
			bd: unavailable ? palette.bd : "#2F4A3C",
			tip: unavailable ? `${why.title}\n${why.body}\nClick to retry` : "Click to refresh",
			label: `${freshText}. ${unavailable ? "Retry now" : "Refresh now"}`,
			retry: () => {
				if (!view.disposed()) view.actions.reload();
			},
		},
		// ladder-alarm: an amber chip beside the pill only while the approval step is off; no banner, no row.
		approvalsOff: model.approvalsOff !== null,
		approvals: {
			text: APPROVALS_OFF_TEXT,
			tip: model.approvalsOff !== null ? approvalsTip(model.approvalsOff, model.now) : "",
		},
		// The supplied template keeps its banner markup, unused (the same hidden shape the reference fixture sends).
		banner: { show: false, bg: "", bd: "", fg: "", title: "", body: "", hasAction: false, action: "" },
		footerText: model.lastReceived
			? "Last received data · current state unconfirmed"
			: "Existing Roles feed · reported information",
		provenanceText: "Missing data is marked as not recorded.",
	};
}
