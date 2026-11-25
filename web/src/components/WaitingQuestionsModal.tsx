/**
 * The waiting-questions bell's list (Ops #1090, Shine 2026-11-25 m104486 "We need a way to see questions waiting for
 * us tho", m104524 "Top bar maybe a notification icon ?"): every question waiting on this window's owner, from any
 * chat, newest first. Each one says who asks, how long ago, what kind it is and whether it was saved for later, with
 * Answer (in place, RoleAnswerDialog over the bell's own channel), Open chat (switches to the asking chat at its
 * question) and, for a model's question, Cancel question.
 *
 * The list is the server's (owner-asks-state.ts): already this owner's only, never another owner's nor one held for
 * COO, and it shrinks by itself when a question is answered anywhere.
 */
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { FiBell } from "react-icons/fi";
import { appSend } from "../app-globals";
import { useT } from "../i18n";
import {
	ownerAskAge,
	ownerAskDialogItem,
	ownerAskKindKey,
	ownerAskOpenTarget,
	ownerAskWho,
	useOwnerAsks,
} from "../owner-asks-state";
import { OWNER_ASK_CHANNEL } from "../roles-answer-state";
import type { NeedsYou, UsefulOpenTarget } from "../roles-useful-model";
import type { UiOwnerAskItem } from "../types";
import { RoleAnswerDialog } from "./RoleAnswerDialog";
import "../waiting-questions.css";

/** How often the ages ("5m ago") move on while the list is open. */
const AGE_TICK_MS = 30_000;

export function WaitingQuestionsModal({
	connected,
	onClose,
	onOpenChat,
}: {
	connected: boolean;
	onClose: () => void;
	/** Switch to the asking chat at its question (the caller closes nothing else). */
	onOpenChat: (target: UsefulOpenTarget) => void;
}) {
	const t = useT();
	const { asks, received } = useOwnerAsks();
	const dialog = useRef<HTMLDialogElement>(null);
	const close = useRef<HTMLButtonElement>(null);
	const [answering, setAnswering] = useState<UiOwnerAskItem | null>(null);
	/** Cancelled here: hidden until the server's list catches up. */
	const [cancelled, setCancelled] = useState<readonly string[]>([]);
	const [now, setNow] = useState(() => Date.now());
	useLayoutEffect(() => {
		const d = dialog.current;
		if (d && !d.open) {
			try {
				d.showModal();
			} catch {
				d.setAttribute("open", "");
			}
		}
		close.current?.focus();
	}, []);
	useEffect(() => {
		const timer = setInterval(() => setNow(Date.now()), AGE_TICK_MS);
		return () => clearInterval(timer);
	}, []);
	const shown = asks.filter((a) => !cancelled.includes(a.askId));
	const openChat = (item: UiOwnerAskItem) => {
		const target = ownerAskOpenTarget(item);
		if (!target) return;
		onClose();
		onOpenChat(target);
	};
	const cancel = (item: UiOwnerAskItem) => {
		if (appSend({ type: "question_answer", id: item.askId, answers: [], cancelled: true }))
			setCancelled((ids) => [...ids, item.askId]);
	};
	// The Answer dialog's view of the list: it closes by itself once its question has left it.
	const needs: NeedsYou = {
		tell: received ? "can-tell" : "unknown",
		asOf: null,
		total: shown.length,
		items: shown.map((a) => ownerAskDialogItem(a, t)),
		more: 0,
	};
	return (
		<>
			<dialog
				ref={dialog}
				className="roles-panel wq-modal"
				aria-labelledby="wq-modal-title"
				onCancel={(e) => {
					e.preventDefault();
					onClose();
				}}
				onClick={(e) => {
					if (e.target === e.currentTarget) onClose();
				}}
			>
				<header className="roles-panel-head">
					<div className="roles-panel-title">
						<h2 id="wq-modal-title">{t("waitingQuestionsTitle")}</h2>
					</div>
					<button ref={close} type="button" className="roles-panel-close" onClick={onClose}>
						{t("waitingQuestionsClose")}
					</button>
				</header>
				<div className="roles-panel-body wq-body">
					{!connected && (
						<p className="wq-offline" role="status">
							{t("waitingQuestionsOffline")}
						</p>
					)}
					{shown.length === 0 ? (
						<div className="wq-empty">
							<FiBell aria-hidden />
							<p>{t("waitingQuestionsEmpty")}</p>
						</div>
					) : (
						<ul className="wq-list">
							{shown.map((item) => {
								const age = ownerAskAge(item, now);
								const text = item.summary && item.summary !== item.title ? item.summary : null;
								return (
									<li key={item.askId} className="wq-item">
										<div className="wq-meta">
											<span className="wq-who">{ownerAskWho(item, t)}</span>
											{age && <span className="wq-age">{age}</span>}
											<span className={`wq-pill wq-kind-${item.kind}`}>{t(ownerAskKindKey(item.kind))}</span>
											{item.later && <span className="wq-pill wq-saved">{t("waitingQuestionsSaved")}</span>}
										</div>
										{/* a title that only repeats the kind pill ("Question") says nothing new */}
										{item.title.toLowerCase() !== t(ownerAskKindKey(item.kind)).toLowerCase() && (
											<p className="wq-title">{item.title}</p>
										)}
										{text && <p className="wq-summary">{text}</p>}
										<div className="wq-actions">
											{item.answerable && (
												<button
													type="button"
													className="roles-useful-open wq-answer"
													disabled={!connected}
													onClick={() => setAnswering(item)}
												>
													{t("waitingQuestionsAnswer")}
												</button>
											)}
											{item.sessionFile && (
												<button type="button" className="roles-useful-open" onClick={() => openChat(item)}>
													{t("waitingQuestionsOpenChat")}
												</button>
											)}
											{item.kind === "question" && (
												<button
													type="button"
													className="roles-useful-open wq-cancel"
													title={t("waitingQuestionsCancelTip")}
													disabled={!connected}
													onClick={() => cancel(item)}
												>
													{t("waitingQuestionsCancel")}
												</button>
											)}
										</div>
									</li>
								);
							})}
						</ul>
					)}
				</div>
			</dialog>
			{answering && (
				<RoleAnswerDialog
					item={ownerAskDialogItem(answering, t)}
					needs={needs}
					connected={connected}
					channel={OWNER_ASK_CHANNEL}
					onClose={() => setAnswering(null)}
					onOpen={(target) => {
						setAnswering(null);
						onClose();
						onOpenChat(target);
					}}
				/>
			)}
		</>
	);
}
