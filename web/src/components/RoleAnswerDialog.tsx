/** Owner-only answer surface, using the same AskHub path as the original chat. */
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useT } from "../i18n";
import { projectRoleAsk, roleAnswerError, roleAnswerForm, type RoleAnswerDrafts } from "../roles-answer-model";
import { answerRoleAsk, openRoleAsk } from "../roles-answer-state";
import type { NeedsYouItem, UsefulOpenTarget } from "../roles-useful-model";
import type { UiRoleAskView } from "../types";

type Stage = "loading" | "ready" | "sending" | "sent" | "error";
type ErrorKey = ReturnType<typeof roleAnswerError>;
export function RoleAnswerDialog({
	item,
	connected,
	onClose,
	onOpen,
}: {
	item: NeedsYouItem;
	connected: boolean;
	onClose: (back: boolean) => void;
	onOpen: (target: UsefulOpenTarget) => void;
}) {
	const t = useT();
	const dialog = useRef<HTMLDialogElement>(null);
	const close = useRef<HTMLButtonElement>(null);
	const mounted = useRef(false);
	const stageRef = useRef<Stage>("loading");
	const [stage, setStage] = useState<Stage>("loading");
	const [error, setError] = useState<ErrorKey>("raUnavailable");
	const [view, setView] = useState<UiRoleAskView | null>(null);
	const [drafts, setDrafts] = useState<RoleAnswerDrafts>(new Map());
	const move = (next: Stage) => {
		stageRef.current = next;
		setStage(next);
	};
	const isStage = (expected: Stage) => stageRef.current === expected;
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
		mounted.current = true;
		let current = true;
		if (!item.answer || !connected) {
			setError("raOffline");
			move("error");
		} else
			void openRoleAsk(item.answer.key).then((reply) => {
				if (!current || stageRef.current !== "loading") return;
				const form = reply.ask ? projectRoleAsk(reply.ask) : null;
				if (!form || form.id !== item.answer?.id) {
					setError(reply.error ? roleAnswerError(reply.error) : form ? "raChanged" : "raOpenInChat");
					move("error");
					return;
				}
				setView(form);
				move("ready");
			});
		return () => {
			current = false;
			mounted.current = false;
		};
		// The parent mounts one dialog for one snapshot of an item; reconnect never reopens it.
	}, []);
	useEffect(() => {
		if (!connected && stageRef.current !== "sent") {
			setError(stageRef.current === "sending" ? "raUncertain" : "raOffline");
			move("error");
		}
	}, [connected]);
	const form = view ? roleAnswerForm(view, drafts) : null;
	const change = (id: string, selected: string[], text: string) => {
		if (!view || stageRef.current !== "ready") return;
		const updated = new Map(drafts);
		updated.set(id, { selected, text });
		// Remove hidden answers now, so they do not reappear if the parent choice is changed back.
		setDrafts(
			new Map(roleAnswerForm(view, updated).answers.map((a) => [a.id, { selected: a.selected, text: a.text ?? "" }])),
		);
	};
	const send = async () => {
		if (!connected || stageRef.current !== "ready" || !item.answer || !view || !form?.complete) return;
		move("sending"); // synchronous guard: a second click cannot enter
		const reply = await answerRoleAsk(item.answer.key, view.id, view.revision, form.answers);
		if (!mounted.current || !isStage("sending")) return;
		if (reply.ok === true) move("sent");
		else {
			setError(roleAnswerError(reply.error));
			move("error");
		}
	};
	return (
		<dialog
			ref={dialog}
			className="roles-panel roles-answer"
			aria-labelledby="roles-answer-title"
			onCancel={(e) => {
				e.preventDefault();
				onClose(true);
			}}
			onClick={(e) => {
				if (e.target === e.currentTarget) onClose(true);
			}}
		>
			<header className="roles-panel-head">
				<div className="roles-panel-title">
					<h2 id="roles-answer-title">{t("raTitle")}</h2>
					<p>{item.roleLabel ?? t("ruUnknownRole")}</p>
				</div>
				<button ref={close} type="button" className="roles-panel-close" onClick={() => onClose(true)}>
					{t("rpClose")}
				</button>
			</header>
			<div className="roles-panel-body" tabIndex={0} aria-label={t("raBody")}>
				<div role="status" aria-live="polite">
					{stage === "loading" && <p>{t("raLoading")}</p>}
					{stage === "sending" && <p>{t("raSending")}</p>}
					{stage === "sent" && <p>{t("raSent")}</p>}
					{stage === "error" && <p className="roles-answer-error">{t(error)}</p>}
				</div>
				{view && (
					<>
						<h3 className="roles-answer-text">{view.title}</h3>
						{view.task && (
							<p className="roles-answer-text">
								<span>#{view.task.id}</span>
								{" · "}
								{view.task.title}
							</p>
						)}
						{view.body && <div className="roles-answer-text roles-answer-package">{view.body}</div>}
						{form?.shown.map(({ field, index, options, answer }) => (
							<fieldset key={field.id} className="roles-answer-field" disabled={stage !== "ready" || !connected}>
								<legend className="roles-answer-text">{field.text}</legend>
								{field.header && <p className="roles-answer-text">{field.header}</p>}
								{field.detail && <div className="roles-answer-text roles-answer-package">{field.detail}</div>}
								{options.map((option) => (
									<label key={option.value} className="roles-answer-option">
										<input
											type={field.multi ? "checkbox" : "radio"}
											name={`roles-answer-option-${index}`}
											checked={answer.selected.includes(option.value)}
											onChange={(e) =>
												change(
													field.id,
													field.multi
														? e.currentTarget.checked
															? [...answer.selected, option.value]
															: answer.selected.filter((v) => v !== option.value)
														: [option.value],
													field.multi ? (answer.text ?? "") : "",
												)
											}
										/>
										<span>
											<span className="roles-answer-text">{option.label}</span>
											{option.description && (
												<span className="roles-answer-text roles-answer-description">{option.description}</span>
											)}
											{option.preview !== undefined && (
												<span className="roles-answer-text roles-answer-preview">{option.preview}</span>
											)}
										</span>
									</label>
								))}
								{field.allowText && (
									<label className="roles-answer-write">
										<span>{t("raYourAnswer")}</span>
										<textarea
											rows={3}
											maxLength={20_000}
											value={drafts.get(field.id)?.text ?? ""}
											onChange={(e) => change(field.id, field.multi ? answer.selected : [], e.currentTarget.value)}
										/>
									</label>
								)}
							</fieldset>
						))}
					</>
				)}
			</div>
			<footer className="roles-answer-footer">
				{stage === "ready" && <p>{t("raReceipt")}</p>}
				<div className="roles-panel-actions">
					{item.link && (
						<button
							type="button"
							className="roles-useful-open"
							onClick={() => {
								const link = item.link;
								if (link) {
									onClose(false);
									onOpen(link);
								}
							}}
						>
							{t("raOpenChat")}
						</button>
					)}
					{stage !== "sent" && (
						<button
							type="button"
							className="roles-useful-open roles-answer-send"
							disabled={stage !== "ready" || !connected || !form?.complete}
							onClick={() => void send()}
						>
							{t("raSend")}
						</button>
					)}
				</div>
			</footer>
		</dialog>
	);
}
