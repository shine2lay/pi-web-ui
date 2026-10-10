/**
 * quiet-turns (task #96): the page side of server/quiet-turns.ts. A turn another agent began (a role's
 * message, a Board order, and the kinds the owner switched on) shows as one closed row: the incoming
 * message's row plus what the turn sent ("→ replied to coo"). Opening it shows the turn as before.
 * The owner (2026-10-10, via COO rm-37872561): "i dont need anything to see, the response should be sent
 * to the agent only if needed or just don't respond at all". Display only.
 */
import {
	addSent,
	ownerFacing,
	planQuietRuns,
	quietUnder,
	type QuietMsg,
	type QuietRun,
	type QuietSwitches,
} from "../../server/quiet-turns.js";
import type { Translate } from "./i18n";
import type { UiMessage, UiQuietRun, UiQuietSent } from "./types";

export { quietUnder, type QuietRun, type QuietSwitches };

/** The owner's switches as the settings carry them (UiSettingsState). */
export function quietSwitchesOf(
	s: { quietQueueWakes?: boolean; quietStallPokes?: boolean; quietScheduledWakes?: boolean } | null | undefined,
): QuietSwitches {
	return {
		queueWakes: s?.quietQueueWakes === true,
		stallPokes: s?.quietStallPokes === true,
		scheduledWakes: s?.quietScheduledWakes === true,
	};
}

const cache = new WeakMap<UiMessage, QuietMsg>();

function textOf(m: UiMessage): string {
	let out = "";
	for (const b of m.content) if (b.type === "text" && typeof b.text === "string") out += b.text;
	return out;
}

/** A page message as the classifier reads it (messages don't change once in; the streaming one isn't here). */
export function quietMsgOf(m: UiMessage): QuietMsg {
	const hit = cache.get(m);
	if (hit) return hit;
	let q: QuietMsg;
	if (m.role === "user" || m.role === "custom") {
		const rm = m.roleMessage;
		q = {
			role: m.role,
			...(m.customType ? { customType: m.customType } : {}),
			text: textOf(m),
			...(rm ? { stamp: { kind: rm.kind, ...(rm.forOwner ? { forOwner: true } : {}) } } : {}),
		};
	} else if (m.role === "assistant") {
		const calls = [];
		for (const b of m.content) {
			if (b.type === "toolCall" && typeof b.id === "string" && typeof b.name === "string") {
				calls.push({ id: b.id, name: b.name, args: (b as { argumentsText?: string }).argumentsText });
			}
		}
		q = { role: m.role, ...(m.stopReason ? { stopReason: m.stopReason } : {}), calls };
	} else if (m.role === "toolResult") {
		q = {
			role: m.role,
			...(m.toolCallId ? { toolCallId: m.toolCallId } : {}),
			isError: m.isError === true,
			details: m.details,
		};
	} else {
		q = { role: m.role };
	}
	cache.set(m, q);
	return q;
}

/** The turns of the page's messages; `lead`: the turn the window starts inside of (UiState.quietLead). */
export function planChatQuiet(messages: readonly UiMessage[], lead?: UiQuietRun): QuietRun[] {
	const runs = planQuietRuns(
		messages.map(quietMsgOf),
		lead ? { kinds: [...lead.kinds], visible: !!lead.visible } : undefined,
	);
	// The part before the window: what it sent counts too.
	if (lead && runs[0]?.row === -1) {
		const r = runs[0];
		const sent: UiQuietSent[] = lead.sent.map((s) => ({ ...s }));
		for (const s of r.sent) addSent(sent, s);
		r.sent = sent;
		r.joined += lead.joined ?? 0;
	}
	return runs;
}

/** An assistant message in a closed quiet turn with only its calls that are for the owner (a question
 *  dialog, a Needs-you item): those stay in sight. */
export function ownerOnly(m: UiMessage): UiMessage {
	return {
		...m,
		content: m.content.filter(
			(b) =>
				b.type === "toolCall" &&
				ownerFacing({
					id: String(b.id ?? ""),
					name: String(b.name ?? ""),
					args: (b as { argumentsText?: string }).argumentsText,
				}),
		),
	};
}

function sentWords(s: UiQuietSent, t: Translate): string {
	switch (s.t) {
		case "message":
			if (s.kind === "reply") return t("quietSentReply", { to: s.to });
			if (s.kind === "question") return t("quietSentQuestion", { to: s.to });
			if (s.kind === "request") return t("quietSentRequest", { to: s.to });
			return t("quietSentFyi", { to: s.to });
		case "ack":
			return t("quietSentAck", { id: s.id });
		case "post":
			return t("quietSentPost");
		case "close":
			return t("quietSentClose", { id: s.id });
		case "queued":
			return s.n !== undefined ? t("quietSentQueued", { n: s.n }) : t("quietSentQueuedTask");
		case "plan":
			return t("quietSentPlan", { n: s.n });
		case "answered":
			return t("quietSentAnswered", { n: s.n });
		case "passed":
			return t("quietSentPassed", { n: s.n });
		case "done":
			return t("quietSentDone");
	}
}

/** What the row says the turn did: "→ replied to coo · acked bp-…", "→ nothing sent", plus "· failed". */
export function quietTurnSummary(
	run: { sent: readonly UiQuietSent[]; ended?: "error" | "aborted"; running?: boolean },
	t: Translate,
): string {
	const words = run.sent.map((s) => sentWords(s, t));
	const shown = words.slice(0, 3);
	if (words.length > 3) shown.push(t("quietTurnMore", { n: words.length - 3 }));
	if (shown.length === 0) shown.push(run.running ? t("quietTurnRunning") : t("quietSentNothing"));
	else if (run.running) shown.push(t("quietTurnRunning"));
	if (run.ended === "error") shown.push(t("quietTurnFailed"));
	else if (run.ended === "aborted") shown.push(t("quietTurnStopped"));
	return `\u2192 ${shown.join(" \u00b7 ")}`;
}

/** The "done" cues left once the chats whose last turn another agent began are taken out (nothing for the
 *  owner to read). Read when the cue goes off (done-settle waits a moment), so the list row has arrived. */
export function withoutQuietRuns<T extends { id: string }>(
	cues: readonly T[],
	list: readonly { id: string; quietRun?: boolean }[] | undefined,
): T[] {
	const quiet = new Set((list ?? []).filter((c) => c.quietRun).map((c) => c.id));
	return cues.filter((c) => !quiet.has(c.id));
}
