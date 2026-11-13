/**
 * The Queue tab's answer card on a task that waits on the user (telegram-answers, #592).
 *
 * frontend #286: an answer that doesn't go through is never silent. The card shows why (no reply,
 * refused, connection dropped, question changed) and a Try again button; the typed words stay. It
 * never resends by itself: a retry is always the user's own tap, and the server refuses a second
 * answer to the same question (its questionId check), so two taps can't apply two answers. A card
 * that can't take an answer at all says so and points to the chat, instead of showing dead buttons.
 */
import { useLayoutEffect, useRef, useState } from "react";
import type { UiTaskQueueTask } from "../types";
import { useT } from "../i18n";
import type {
	TaskQueueAnswerBinding,
	TaskQueueAnswerFailure,
	TaskQueueAnswerOutcome,
	TaskQueueAnswerRequest,
	TaskQueueAnswerResult,
} from "./TaskQueueLines";

type Phase = "idle" | "pending" | "applied" | "error";
type Translate = ReturnType<typeof useT>;

function failureOf(result: unknown): TaskQueueAnswerFailure | undefined {
	if (!result || typeof result !== "object") return undefined;
	const r = result as Partial<TaskQueueAnswerFailure>;
	return r.applied === false && typeof r.why === "string" ? (r as TaskQueueAnswerFailure) : undefined;
}

/** What the card says when an answer didn't go through, in plain words. */
export function answerFailureText(t: Translate, failure: TaskQueueAnswerFailure | undefined): string {
	switch (failure?.why) {
		case "no-reply":
			return t("taskQueueAnswerNoReply");
		case "offline":
			return t("taskQueueAnswerOffline");
		case "stale":
			return t("taskQueueAnswerStale");
		case "moved-on":
			return t("taskQueueAnswerMovedOn");
		case "refused": {
			const reason = failure.reason?.trim().replace(/[.\s]+$/, "");
			return reason ? t("taskQueueAnswerRefused", { reason }) : t("taskQueueAnswerFailed");
		}
		default:
			return t("taskQueueAnswerFailed");
	}
}

export function StuckAnswer({
	task,
	conversationId,
	queueId,
	binding,
	onAnswerResult,
}: {
	task: UiTaskQueueTask;
	conversationId?: string;
	queueId?: string;
	binding?: TaskQueueAnswerBinding;
	onAnswerResult?: TaskQueueAnswerResult;
}) {
	const t = useT();
	const [text, setText] = useState("");
	const revision = useRef(0);
	const [phase, setPhase] = useState<Phase>("idle");
	const [failure, setFailure] = useState<TaskQueueAnswerFailure | undefined>(undefined);
	const lastTry = useRef<{ value: string; typed: boolean } | null>(null);
	const key = JSON.stringify([
		conversationId,
		queueId,
		task.id,
		binding?.questionId,
		task.question,
		task.choices ?? [],
		task.detail,
		!!onAnswerResult,
	]);
	const owner = useRef<{ live: boolean; pending?: object; applied: boolean }>({ live: false, applied: false });
	useLayoutEffect(() => {
		const lifetime = { live: true, applied: false };
		owner.current = lifetime;
		lastTry.current = null;
		setPhase("idle");
		setFailure(undefined);
		return () => {
			lifetime.live = false;
		};
	}, [key]);
	const send = async (value: string, typed: boolean) => {
		const lifetime = owner.current;
		if (!value.trim() || !binding || !onAnswerResult || !lifetime.live || lifetime.pending || lifetime.applied) return;
		const request: TaskQueueAnswerRequest = Object.freeze({
			binding: Object.freeze({ ...binding, choices: Object.freeze([...binding.choices]) }),
			text: value,
		});
		const submittedRevision = revision.current;
		const attempt = {};
		lifetime.pending = attempt;
		lastTry.current = { value, typed };
		setPhase("pending");
		let outcome: TaskQueueAnswerOutcome | undefined;
		try {
			const result = onAnswerResult(request);
			if (result && typeof result.then === "function") outcome = await result;
		} catch {
			// Refused, failed or unknown: keep the original words; never resend automatically.
		}
		if (!lifetime.live || owner.current !== lifetime || lifetime.pending !== attempt) return;
		const applied = outcome === true;
		lifetime.pending = undefined;
		lifetime.applied = applied;
		setFailure(applied ? undefined : failureOf(outcome));
		setPhase(applied ? "applied" : "error");
		if (applied && typed && revision.current === submittedRevision) setText("");
	};
	const unavailable = !binding || !onAnswerResult;
	const disabled = unavailable || phase === "pending" || phase === "applied";
	const unavailableText = t(task.lane ? "taskQueueAnswerUnavailable" : "taskQueueAnswerUnavailableHere");
	const retry = () => {
		const last = lastTry.current;
		if (!last) return;
		// A typed answer retries the words as they stand now (kept, maybe corrected); a choice retries itself.
		void send(last.typed ? text : last.value, last.typed);
	};
	return (
		<div
			className="task-queue-answer"
			data-answer-state={phase}
			data-answer-error={phase === "error" ? (failure?.why ?? "failed") : undefined}
			data-answer-unavailable={unavailable ? "true" : undefined}
			aria-busy={phase === "pending"}
		>
			{task.choices && task.choices.length > 0 && (
				<div className="task-queue-choices">
					{task.choices.map((c) => (
						<button
							key={c}
							type="button"
							className="task-queue-choice"
							disabled={disabled}
							title={unavailable ? unavailableText : undefined}
							onClick={() => void send(c, false)}
						>
							{c}
						</button>
					))}
				</div>
			)}
			<form
				className="task-queue-answer-form"
				onSubmit={(e) => {
					e.preventDefault();
					void send(text, true);
				}}
			>
				<input
					className="task-queue-answer-input"
					value={text}
					placeholder={t("taskQueueAnswerPlaceholder")}
					aria-label={t("taskQueueAnswerPlaceholder")}
					onChange={(e) => {
						revision.current++;
						setText(e.target.value);
					}}
				/>
				<button type="submit" className="task-queue-answer-send" disabled={disabled || !text.trim()}>
					{t(phase === "pending" ? "sendingTag" : phase === "applied" ? "done" : "taskQueueAnswerSend")}
				</button>
			</form>
			{phase === "error" ? (
				<div className="task-queue-answer-error" role="alert">
					<span className="task-queue-answer-error-text">{answerFailureText(t, failure)}</span>
					<button
						type="button"
						className="task-queue-answer-retry"
						disabled={!lastTry.current || (lastTry.current.typed && !text.trim())}
						onClick={retry}
					>
						{t("taskQueueAnswerRetry")}
					</button>
				</div>
			) : (
				<span
					className={unavailable ? "task-queue-hint task-queue-answer-unavailable" : "task-queue-hint"}
					role="status"
					title={unavailable ? undefined : t(task.lane ? "taskQueueAnswerGoesToTaskChat" : "taskQueueAnswerGoesHere")}
				>
					{phase === "pending"
						? t("sendingTag")
						: phase === "applied"
							? t("done")
							: unavailable
								? unavailableText
								: t(task.lane ? "taskQueueAnswerGoesToTaskChat" : "taskQueueAnswerGoesHere")}
				</span>
			)}
		</div>
	);
}
