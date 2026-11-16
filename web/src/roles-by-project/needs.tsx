/**
 * roles-by-project "Needs you · N" (design.md §First view 4): a fold, open by default and remembered
 * (roles.needsOpen), showing the first row of cards only (measured from the grid) then "Show N more". Each card:
 * question, task ref, a link to its group, one gold Answer through the existing answer flow.
 */
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
	questionAction,
	QUESTION_ACTION_REASONS,
	type NativeDialogSummary,
	type QuestionAction,
} from "../roles-answer-actions";
import type { NeedsYou, NeedsYouItem } from "../roles-useful-model";
import { Icon } from "./icons";
import { prettyRefs, refOfAskKey } from "./model";

export const NEEDS_OPEN_KEY = "roles.needsOpen";

function readOpen(): boolean {
	try {
		return localStorage.getItem(NEEDS_OPEN_KEY) !== "0";
	} catch {
		return true;
	}
}

/** The board ref an item's question belongs to ("frontend #294"), or null when it isn't a task's. */
export function refOfItem(item: NeedsYouItem): string | null {
	return refOfAskKey(item.answer?.key ?? item.chatAnswer?.key ?? item.key);
}

/** How many grid columns the strip has now (its first row); null when the layout can't tell. */
function columnsOf(strip: HTMLElement): number | null {
	const cols = getComputedStyle(strip)
		.gridTemplateColumns.split(" ")
		.filter((c) => /^[\d.]+px$/.test(c));
	return cols.length || null;
}

function NeedCard({
	item,
	needs,
	dialogs,
	hidden,
	groupLabel,
	onAnswer,
	onOpenChat,
	onShowGroup,
}: {
	item: NeedsYouItem;
	needs: NeedsYou;
	dialogs: readonly NativeDialogSummary[];
	hidden: boolean;
	groupLabel: string | null;
	onAnswer: (item: NeedsYouItem, from: HTMLElement) => void;
	onOpenChat: (item: NeedsYouItem) => void;
	onShowGroup: (ref: string) => void;
}) {
	// spec-page.md §Answering: an inline ask always opens the dialog, which re-reads it (roles_ask_open) and is refused
	// when stale; only chat-only asks need the list confirmed before they link out.
	const action: QuestionAction = item.answer ? { kind: "inline" } : questionAction(needs, item, dialogs);
	const ref = refOfItem(item);
	return (
		<article className="rbp-askc" hidden={hidden}>
			<span className="rbp-lbl">
				<Icon name="you" />
				{item.roleLabel ?? "A role"} asks
			</span>
			<p title={item.text ?? undefined}>{item.text ?? "Open the original item to read it"}</p>
			{action.kind === "unavailable" && <p className="rbp-why">{QUESTION_ACTION_REASONS[action.reason]}</p>}
			<div className="rbp-foot">
				<span className="rbp-who">
					{ref ? <span className="num">{prettyRefs(ref)}</span> : null}
					{ref && groupLabel && (
						<>
							{" · in "}
							<button type="button" className="rbp-link" onClick={() => onShowGroup(ref)}>
								{groupLabel}
							</button>
						</>
					)}
				</span>
				{action.kind === "inline" ? (
					<button type="button" className="rbp-btn-you" onClick={(e) => onAnswer(item, e.currentTarget)}>
						Answer
					</button>
				) : action.kind === "chat" ? (
					<button
						type="button"
						className="rbp-btn-you"
						title="Opens the question in its own chat; opening sends nothing."
						onClick={() => onOpenChat(item)}
					>
						Answer
					</button>
				) : item.link ? (
					<button type="button" className="rbp-btn" onClick={() => onOpenChat(item)}>
						Open chat
					</button>
				) : null}
			</div>
		</article>
	);
}

export function NeedsStrip({
	needs,
	dialogs,
	groupLabelOf,
	onAnswer,
	onOpenChat,
	onShowGroup,
}: {
	needs: NeedsYou;
	dialogs: readonly NativeDialogSummary[];
	groupLabelOf: (ref: string) => string | null;
	onAnswer: (item: NeedsYouItem, from: HTMLElement) => void;
	onOpenChat: (item: NeedsYouItem) => void;
	onShowGroup: (ref: string) => void;
}) {
	const fold = useRef<HTMLDetailsElement | null>(null);
	const strip = useRef<HTMLDivElement | null>(null);
	const [open, setOpen] = useState(readOpen);
	const [all, setAll] = useState(false);
	const [cols, setCols] = useState<number | null>(null);
	const items = needs.items;

	useEffect(() => {
		const el = fold.current;
		if (!el) return;
		const onToggle = () => {
			setOpen(el.open);
			try {
				localStorage.setItem(NEEDS_OPEN_KEY, el.open ? "1" : "0");
			} catch {
				/* storage off: the fold still works, it just isn't remembered */
			}
		};
		el.addEventListener("toggle", onToggle);
		return () => el.removeEventListener("toggle", onToggle);
	}, []);

	useLayoutEffect(() => {
		const el = strip.current;
		if (!el || !open) return;
		const measure = () => setCols(columnsOf(el));
		measure();
		if (typeof ResizeObserver === "undefined") return;
		const ro = new ResizeObserver(measure);
		ro.observe(el);
		return () => ro.disconnect();
	}, [open]);

	const total = needs.total || items.length;
	const visible = all || cols === null ? items.length : Math.min(items.length, cols);
	const more = total - visible;
	return (
		<details className="rbp-needs rbp-fold" open={open} ref={fold}>
			<summary>
				<Icon name="chev" />
				Needs you · {total}
			</summary>
			{/* Closed: no cards at all (a closed fold's content still takes layout boxes in Chromium). */}
			{open && (
				<div className="rbp-strip" ref={strip}>
					{items.map((item, i) => {
						const ref = refOfItem(item);
						return (
							<NeedCard
								key={item.key}
								item={item}
								needs={needs}
								dialogs={dialogs}
								hidden={i >= visible}
								groupLabel={ref ? groupLabelOf(ref) : null}
								onAnswer={onAnswer}
								onOpenChat={onOpenChat}
								onShowGroup={onShowGroup}
							/>
						);
					})}
				</div>
			)}
			{open && more > 0 && (
				<button type="button" className="rbp-btn is-more" onClick={() => setAll(true)}>
					Show {more} more
				</button>
			)}
		</details>
	);
}
