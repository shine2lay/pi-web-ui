/**
 * left-task-status (owner 2026-10-18, Ops #213): the words for a parked queued task's label on its chat's row in
 * the left panel, and its tooltip. The server says how the task stands (server/queue-chat-status.ts); this only
 * words it, with the Queue panel's wording where there is one. Pure functions + unit tests:
 * tests/unit/queue-chat-status.test.ts.
 */
import type { Translate } from "./i18n";
import { ageOf, clockOf } from "./roles-view-model";
import type { UiQueueChatStatus } from "./types";

export interface QueueStatusView {
	/** The row's label: "Waiting: …", "Blocked on #12", "Blocked: …", "Needs decision", "Asking Ops", "Paused". */
	label: string;
	/** The tooltip: the whole text, since when and how long, and for a wait how often it's checked and when it gives up. */
	tip: string;
	/** Its colour's class (the kind). */
	kind: UiQueueChatStatus["kind"];
}

/** The row's status to show, if any: none while the chat works (its running dot says so), nor a question's
 *  label when the row's "?" badge already says it waits on an answer. */
export function shownQueueStatus(row: {
	queueStatus?: UiQueueChatStatus;
	isStreaming: boolean;
	hasQuestion?: boolean;
	dialogId?: number;
}): UiQueueChatStatus | undefined {
	const s = row.queueStatus;
	if (!s || row.isStreaming) return undefined;
	if ((s.kind === "stuck" || s.kind === "asking") && (row.hasQuestion || row.dialogId !== undefined)) return undefined;
	return s;
}

/** "30 s", "2 min", "1 h", "1 h 30 min". */
export function everyText(ms: number): string {
	const sec = Math.max(1, Math.round(ms / 1000));
	if (sec < 60) return `${sec} s`;
	const min = Math.round(sec / 60);
	if (min < 60) return `${min} min`;
	const h = Math.floor(min / 60);
	const rest = min % 60;
	return rest ? `${h} h ${rest} min` : `${h} h`;
}

/** Who has an asking task's question, in the Queue panel's words. */
function askingLabel(t: Translate, lead: string | undefined): string {
	if (!lead) return t("taskQueueAskingMain");
	return lead === "ops" ? t("taskQueueAskingOps") : t("taskQueueAskingLead", { lead });
}

export function queueStatusView(t: Translate, s: UiQueueChatStatus, now: number): QueueStatusView {
	const tip: string[] = [];
	let label: string;
	switch (s.kind) {
		case "waiting":
			label = s.text ? t("leftTaskWaiting", { what: s.text }) : t("leftTaskWaitingBare");
			tip.push(s.detail ? t("leftTaskTipWaiting", { what: s.detail }) : label);
			break;
		case "blocked":
			label = !s.text
				? t("leftTaskBlockedBare")
				: s.on
					? t("leftTaskBlockedOn", { what: s.text })
					: t("leftTaskBlockedNeed", { what: s.text });
			if (s.refs) tip.push(t("leftTaskTipBlockedOn", { refs: s.refs }));
			if (s.need) tip.push(t("leftTaskTipNeed", { need: s.need }));
			if (s.lead) {
				tip.push(
					s.owes ? t("leftTaskTipLead", { lead: s.lead, owes: s.owes }) : t("leftTaskTipLeadBare", { lead: s.lead }),
				);
			}
			if (tip.length === 0) tip.push(label);
			break;
		case "stuck":
			label = t("leftTaskStuck");
			tip.push(t("leftTaskTipStuck"));
			if (s.detail) tip.push(t("leftTaskTipQuestion", { question: s.detail }));
			break;
		case "asking":
			label = askingLabel(t, s.lead);
			tip.push(label);
			if (s.detail) tip.push(t("leftTaskTipQuestion", { question: s.detail }));
			break;
		case "paused":
			label = t("leftTaskPaused");
			tip.push(t("leftTaskTipPaused"));
			if (s.detail) tip.push(t("leftTaskTipPausedWhy", { why: s.detail }));
			break;
	}
	if (s.since) tip.push(t("leftTaskTipSince", { time: clockOf(s.since, now), age: ageOf(s.since, now) }));
	if (s.kind === "waiting" && s.everyMs && s.giveUpAt) {
		tip.push(t("leftTaskTipCheck", { every: everyText(s.everyMs), time: clockOf(s.giveUpAt, now) }));
	}
	return { label, tip: tip.join("\n"), kind: s.kind };
}
