import { useRef, useState } from "react";
import { appAdmit, useAppField, useIsDsh } from "../app-globals";
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
	const inFlight = useRef(false);
	const [choosing, setChoosing] = useState(false);
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
						disabled={disabled || choosing || !ready || (!isDsh && !sessionId)}
						onClick={async () => {
							if (inFlight.current) return;
							inFlight.current = true;
							setChoosing(true);
							try {
								if ((await appAdmit({ type: "prompt", text: action.prompt, id: newPromptId() })) === true) onChoose?.();
							} catch {
								// No accepted handoff: keep the suggestion available.
							} finally {
								inFlight.current = false;
								setChoosing(false);
							}
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
