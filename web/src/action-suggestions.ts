import { fromMarkdown } from "mdast-util-from-markdown";
import type { Nodes } from "mdast";
import type { UiMessage } from "./types";

export interface ActionSuggestion {
	label: string;
	prompt: string;
}

function unquote(value: string): string {
	const text = value.trim();
	return /^("[\s\S]*"|'[\s\S]*')$/.test(text) ? text.slice(1, -1) : text;
}

/** Use the same CommonMark tokenizer as react-markdown: indentation, container
 * blocks and matching fence/backtick lengths are Markdown rules, not regexes. */
function codeRanges(text: string): [number, number][] {
	const ranges: [number, number][] = [];
	const visit = (node: Nodes) => {
		if (node.type === "code" || node.type === "inlineCode") {
			const start = node.position?.start.offset;
			const end = node.position?.end.offset;
			if (start !== undefined && end !== undefined) ranges.push([start, end]);
		} else if ("children" in node) {
			for (const child of node.children) visit(child);
		}
	};
	visit(fromMarkdown(text));
	return ranges;
}

/** Supports the approved Label|Prompt form and upstream's Label,prompt=Text form.
 * Markers shown as code are examples, not actions. No eval, HTML or URL execution. */
export function parseActionSuggestions(text: string): { text: string; actions: ActionSuggestion[] } {
	const actions: ActionSuggestion[] = [];
	const seen = new Set<string>();
	const code = codeRanges(text);
	const markers = /\[\[action:suggest:([\s\S]*?)\]\]|\[\[action:suggest:[^\]]*$/g;
	let clean = "";
	let copied = 0;
	let match: RegExpExecArray | null;
	while ((match = markers.exec(text))) {
		const [whole, payload] = match;
		const offset = match.index;
		const origin = code.find(([start, end]) => start <= offset && offset < end);
		if (origin) {
			// A partial marker inside code may have matched through the next prose
			// marker's close. Resume at the code boundary, not that false close.
			markers.lastIndex = origin[1];
			continue;
		}
		if (payload !== undefined) {
			const pipe = payload.indexOf("|");
			const promptAt = payload.indexOf(",prompt=");
			const split = pipe >= 0 ? pipe : promptAt;
			const label = unquote((split >= 0 ? payload.slice(0, split) : payload).replace(/^label=/, ""));
			const prompt = unquote(split < 0 ? label : payload.slice(split + (pipe >= 0 ? 1 : 8)));
			if (!label || !prompt) continue;
			const key = JSON.stringify([label, prompt]);
			if (!seen.has(key)) {
				seen.add(key);
				actions.push({ label, prompt });
			}
		}
		clean += text.slice(copied, match.index);
		copied = match.index + whole.length;
	}
	return { text: clean + text.slice(copied), actions };
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
