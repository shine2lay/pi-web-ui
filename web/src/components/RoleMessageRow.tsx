import { memo, useLayoutEffect, useRef, useSyncExternalStore } from "react";
import { FiClock, FiList, FiMail } from "react-icons/fi";
import { useT, type Translate } from "../i18n";
import { roleMessagePreview, roleMessageRowText, type RoleMessageView } from "../role-message-text";

/**
 * role-message-fold (owner 2026-10-06: "Make the agent to agent messages collapsed by default"):
 * a message from another role shows as one folded row until it is opened. Which ones are open is
 * kept for as long as the page is (a module-level set, so it survives the list re-mounting rows);
 * display only, nothing is saved and the model's text is untouched.
 */
const openIds = new Set<string>();
const listeners = new Set<() => void>();
/** quiet-turns: bumped on every toggle, so the message list can re-plan which turns are folded. */
let openVersion = 0;
/** The row or fold button to focus after a toggle, so Enter can open and fold again. */
let focusAfterToggle: string | null = null;

function subscribe(fn: () => void): () => void {
	listeners.add(fn);
	return () => {
		listeners.delete(fn);
	};
}
const noSubscribe = () => () => {};

export function setRoleMessageOpen(msgId: string, open: boolean, focus = false): void {
	if (openIds.has(msgId) === open) return;
	if (open) openIds.add(msgId);
	else openIds.delete(msgId);
	focusAfterToggle = focus ? msgId : null;
	openVersion++;
	for (const fn of listeners) fn();
}

/** quiet-turns: is the row of chat message `msgId` open (a role message, or a turn another agent began)? */
export function isRoleMessageOpen(msgId: string): boolean {
	return openIds.has(msgId);
}

/** quiet-turns: changes whenever a row is opened or folded (the message list re-plans its quiet turns). */
export function useRoleMessageOpenVersion(): number {
	return useSyncExternalStore(
		subscribe,
		() => openVersion,
		() => 0,
	);
}

/** Whether the role message in chat message `msgId` is open; pass null for any other message. */
export function useRoleMessageOpen(msgId: string | null): boolean {
	return useSyncExternalStore(
		msgId ? subscribe : noSubscribe,
		() => (msgId ? openIds.has(msgId) : false),
		() => false,
	);
}

/** Focus `el` when it is the control the last toggle of `msgId` asked for. */
export function useFocusAfterToggle(msgId: string, ref: { current: HTMLElement | null }): void {
	useLayoutEffect(() => {
		if (focusAfterToggle !== msgId) return;
		focusAfterToggle = null;
		ref.current?.focus({ preventScroll: true });
	});
}

/** The row's "From ..." label. */
export function roleMessageFrom(m: RoleMessageView, t: Translate): string {
	if (m.kind === "report") return t("roleMessageFoldApp");
	// board (task #76): the turn-start note comes from the board; an order from its poster.
	if (m.kind === "board") return t("roleMessageFoldBoard");
	if (m.kind === "board-order" && m.via) return t("roleMessageFoldFromVia", { from: m.from || "?", via: m.via });
	return t("roleMessageFoldFrom", { from: m.from || "?" });
}

/** The row's kind word. */
export function roleMessageKindWord(m: RoleMessageView, t: Translate): string {
	if (m.kind === "report") return t("roleMessageFoldReport", { date: m.reportDate ?? "?" });
	if (m.kind === "board") return m.what ?? "";
	if (m.kind === "board-order") return t("roleMessageFoldBoardOrder");
	if (m.kind === "reply" && m.replyTo) return t("roleMessageReplyKind", { id: m.replyTo });
	return m.kind;
}

function formatTime(ts: number): string {
	const d = new Date(ts);
	return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/**
 * The folded row: who sent it, its kind and its first words as plain text (no Markdown), styled like
 * the collapsed old-message rows. A button: a click, Enter or Space opens the message.
 */
export const RoleMessageRow = memo(function RoleMessageRow({
	msgId,
	view,
	timestamp,
	turn,
}: {
	msgId: string;
	view: RoleMessageView;
	timestamp?: number;
	/** quiet-turns: the message began a turn the owner doesn't read: what that turn did ("→ replied to coo"). */
	turn?: string;
}) {
	const t = useT();
	const ref = useRef<HTMLButtonElement>(null);
	useFocusAfterToggle(msgId, ref);
	const from = roleMessageFrom(view, t);
	const kind = roleMessageKindWord(view, t);
	const preview = roleMessagePreview(roleMessageRowText(view));
	return (
		<div
			className={`rolemsg-row rolemsg-${view.kind}${view.stamped ? "" : " rolemsg-unstamped"}${turn ? " quiet-turn-row" : ""}`}
			data-msg-id={msgId}
			data-role-message={view.id}
			{...(turn ? { "data-quiet-turn": msgId } : {})}
		>
			<button
				ref={ref}
				type="button"
				className="rolemsg-row-btn"
				aria-expanded={false}
				title={`${t(turn ? "quietTurnOpen" : "roleMessageFoldOpen")} \u00b7 ${view.id}${view.stamped ? "" : ` \u00b7 ${t("roleMessageFoldUnstamped")}`}`}
				onClick={() => setRoleMessageOpen(msgId, true, true)}
			>
				<span className="rolemsg-row-chevron" aria-hidden="true" />
				<FiMail className="rolemsg-row-icon" aria-hidden="true" />
				<span className="rolemsg-row-from">{from}</span>
				<span className="rolemsg-row-kind">{kind}</span>
				<span className="rolemsg-row-preview">{preview}</span>
				{turn ? <span className="rolemsg-row-turn">{turn}</span> : null}
				{timestamp ? <span className="rolemsg-row-time">{formatTime(timestamp)}</span> : null}
			</button>
		</div>
	);
});

/**
 * quiet-turns: the row of a turn that an app notice began, when the owner folds that kind (a finished queue
 * task waking its main chat, a scheduled wake-up), or of a turn that began before the loaded messages.
 * Closed: one button that opens the turn. Open: a head that folds it again, above the turn as before.
 */
export const NoticeTurnRow = memo(function NoticeTurnRow({
	msgId,
	kind,
	text,
	timestamp,
	turn,
	open,
}: {
	msgId: string;
	kind: "queue-wake" | "scheduled" | "earlier";
	text: string;
	timestamp?: number;
	turn: string;
	open: boolean;
}) {
	const t = useT();
	const ref = useRef<HTMLButtonElement>(null);
	useFocusAfterToggle(msgId, ref);
	const label =
		kind === "queue-wake"
			? t("quietTurnQueueWake")
			: kind === "scheduled"
				? t("quietTurnScheduled")
				: t("quietTurnEarlier");
	const Icon = kind === "scheduled" ? FiClock : FiList;
	return (
		<div
			className={`rolemsg-row quiet-turn-row quiet-turn-${kind}${open ? " quiet-turn-open" : ""}`}
			data-msg-id={msgId}
			data-quiet-turn={msgId}
		>
			<button
				ref={ref}
				type="button"
				className="rolemsg-row-btn"
				aria-expanded={open}
				title={t(open ? "quietTurnClose" : "quietTurnOpen")}
				onClick={() => setRoleMessageOpen(msgId, !open, true)}
			>
				<span className="rolemsg-row-chevron" aria-hidden="true" />
				<Icon className="rolemsg-row-icon" aria-hidden="true" />
				<span className="rolemsg-row-from">{label}</span>
				<span className="rolemsg-row-preview">{roleMessagePreview(text)}</span>
				<span className="rolemsg-row-turn">{turn}</span>
				{timestamp ? <span className="rolemsg-row-time">{formatTime(timestamp)}</span> : null}
			</button>
		</div>
	);
});
