import { appSend, useAppField, useIsDsh } from "../app-globals";
import { messageSuggestions, type ActionSuggestion } from "../action-suggestions";
import type { UiMessage } from "../types";
import { newPromptId } from "../pending-sends";

/** Upstream 0.111.0 follow-up chips. A click uses the normal prompt channel. */
export function SuggestionChips({
	message,
	actions,
	disabled,
	sessionId,
	onChoose,
}: {
	sessionId?: string | null;
	message?: UiMessage;
	actions?: ActionSuggestion[];
	disabled?: boolean;
	onChoose?: () => void;
}) {
	const ready = useAppField("ready");
	const isDsh = useIsDsh();
	const suggestions = actions ?? messageSuggestions(message);
	if (!suggestions.length) return null;
	return (
		<div className="action-suggestions" aria-label="Suggested follow-ups">
			<div className="action-suggestions-list">
				{suggestions.map((action) => (
					<button
						key={JSON.stringify([action.label, action.prompt])}
						type="button"
						className="action-suggestion-chip"
						title={action.prompt}
						disabled={disabled || !ready || (!isDsh && !sessionId)}
						onClick={() => {
							onChoose?.();
							appSend({ type: "prompt", text: action.prompt, id: newPromptId() });
						}}
					>
						<span className="action-suggestion-label">{action.label}</span>
						<span className="action-suggestion-icon" aria-hidden="true">
							↵
						</span>
					</button>
				))}
			</div>
		</div>
	);
}
