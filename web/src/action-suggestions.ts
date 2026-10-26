import type { UiMessage } from "./types";

export interface ActionSuggestion {
	label: string;
	prompt: string;
}

function unquote(value: string): string {
	const text = value.trim();
	return /^("[\s\S]*"|'[\s\S]*')$/.test(text) ? text.slice(1, -1) : text;
}

/** Supports the approved Label|Prompt form and upstream's Label,prompt=Text form.
 * Markers shown as code are examples, not actions. No eval, HTML or URL execution. */
export function parseActionSuggestions(text: string): { text: string; actions: ActionSuggestion[] } {
	const actions: ActionSuggestion[] = [];
	const seen = new Set<string>();
	const clean = text.replace(
		/(```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)|`+[^`]*`+)|\[\[action:suggest:([\s\S]*?)\]\]|\[\[action:suggest:[^\]]*$/g,
		(whole, code: string | undefined, payload: string | undefined) => {
			if (code) return code;
			if (payload === undefined) return ""; // still streaming a marker
			const pipe = payload.indexOf("|");
			const promptAt = payload.indexOf(",prompt=");
			const split = pipe >= 0 ? pipe : promptAt;
			const label = unquote((split >= 0 ? payload.slice(0, split) : payload).replace(/^label=/, ""));
			const prompt = unquote(split < 0 ? label : payload.slice(split + (pipe >= 0 ? 1 : 8)));
			if (!label || !prompt) return whole;
			const key = JSON.stringify([label, prompt]);
			if (!seen.has(key)) {
				seen.add(key);
				actions.push({ label, prompt });
			}
			return "";
		},
	);
	return { text: clean, actions };
}

export function messageSuggestions(message?: UiMessage): ActionSuggestion[] {
	if (message?.role !== "assistant") return [];
	return parseActionSuggestions(
		message.content
			.flatMap((block) =>
				block.type === "text" && "text" in block && typeof block.text === "string" ? [block.text] : [],
			)
			.join("\n"),
	).actions;
}
