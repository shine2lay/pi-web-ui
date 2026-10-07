import { memo, useLayoutEffect, useRef, useSyncExternalStore } from "react";
import { FiMail } from "react-icons/fi";
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
	for (const fn of listeners) fn();
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
}: {
	msgId: string;
	view: RoleMessageView;
	timestamp?: number;
}) {
	const t = useT();
	const ref = useRef<HTMLButtonElement>(null);
	useFocusAfterToggle(msgId, ref);
	const from = roleMessageFrom(view, t);
	const kind = roleMessageKindWord(view, t);
	const preview = roleMessagePreview(roleMessageRowText(view));
	return (
		<div
			className={`rolemsg-row rolemsg-${view.kind}${view.stamped ? "" : " rolemsg-unstamped"}`}
			data-msg-id={msgId}
			data-role-message={view.id}
		>
			<button
				ref={ref}
				type="button"
				className="rolemsg-row-btn"
				aria-expanded={false}
				title={`${t("roleMessageFoldOpen")} \u00b7 ${view.id}${view.stamped ? "" : ` \u00b7 ${t("roleMessageFoldUnstamped")}`}`}
				onClick={() => setRoleMessageOpen(msgId, true, true)}
			>
				<span className="rolemsg-row-chevron" aria-hidden="true" />
				<FiMail className="rolemsg-row-icon" aria-hidden="true" />
				<span className="rolemsg-row-from">{from}</span>
				<span className="rolemsg-row-kind">{kind}</span>
				<span className="rolemsg-row-preview">{preview}</span>
				{timestamp ? <span className="rolemsg-row-time">{formatTime(timestamp)}</span> : null}
			</button>
		</div>
	);
});
