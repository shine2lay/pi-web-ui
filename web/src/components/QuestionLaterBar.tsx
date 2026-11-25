import { useState } from "react";
import { useT } from "../i18n";

/** A question kept for later, as the bar needs it. */
export interface SavedQuestion {
	id: string;
	questions: { header?: string; question: string }[];
}

/** The bar's one-line title: the first question's header, else its text (markup and spacing flattened). */
export function savedQuestionTitle(q: SavedQuestion): string {
	const first = q.questions[0];
	const text = first?.header?.trim() || first?.question || "";
	return text
		.replace(/<[^>]*>/g, "")
		.replace(/\s+/g, " ")
		.trim();
}

/**
 * Keep for later (Ops #1087, Shine m104353): in the asking chat, one line above the composer for its questions kept
 * for later: "Question saved for later: <title>" and Answer, which opens it right there. Several: "1/2" and a step to
 * the next. The chat stays free while it shows.
 */
export function QuestionLaterBar({ saved, onAnswer }: { saved: SavedQuestion[]; onAnswer: (id: string) => void }) {
	const t = useT();
	const [index, setIndex] = useState(0);
	if (saved.length === 0) return null;
	const at = Math.min(index, saved.length - 1);
	const shown = saved[at]!;
	const title = savedQuestionTitle(shown);
	return (
		<div className="question-later-bar" role="status">
			<span className="question-later-icon" aria-hidden="true">
				?
			</span>
			<span className="question-later-text" title={title}>
				{t("questionSavedForLater")}
				{title ? `: ${title}` : ""}
			</span>
			{saved.length > 1 && (
				<>
					<span className="question-later-count">
						{at + 1}/{saved.length}
					</span>
					<button
						type="button"
						className="question-later-next"
						title={t("questionLaterNext")}
						aria-label={t("questionLaterNext")}
						onClick={() => setIndex((at + 1) % saved.length)}
					>
						›
					</button>
				</>
			)}
			<button type="button" className="question-later-answer" onClick={() => onAnswer(shown.id)}>
				{t("questionLaterAnswer")}
			</button>
		</div>
	);
}
