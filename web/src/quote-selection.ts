/// <reference lib="dom" />
/** Adapted from pi-web-ui 0.111.0. This fork uses Markdown quotes in the draft,
 * not upstream's new server-side quote attachment type. */
const CONTENT = ".msg-text";
const EXCLUDED = "button, input, textarea, [contenteditable], .msg-meta, .msg-actions, .chead";

function element(node: Node): Element | null {
	return node.nodeType === 1 ? (node as Element) : node.parentElement;
}

export function readQuoteSelection(root: HTMLElement, selection: Selection | null): string | null {
	if (!selection || selection.isCollapsed || selection.rangeCount !== 1) return null;
	const range = selection.getRangeAt(0);
	const start = element(range.startContainer);
	const end = element(range.endContainer);
	if (!start || !end || !root.contains(start) || !root.contains(end)) return null;
	if (!start.closest(CONTENT) || !end.closest(CONTENT) || start.closest(EXCLUDED) || end.closest(EXCLUDED)) return null;
	const message = start.closest<HTMLElement>('.msg[data-role="assistant"][data-msg-id]');
	if (!message || message !== end.closest(".msg[data-msg-id]")) return null;
	for (const node of message.querySelectorAll(EXCLUDED)) {
		if (range.intersectsNode(node)) return null;
	}
	const text = selection.toString();
	return text.trim() ? text : null;
}

export function formatQuote(text: string): string {
	return (
		text
			.replace(/\r\n?/g, "\n")
			.trim()
			.split("\n")
			.map((line) => `>${line ? ` ${line}` : ""}`)
			.join("\n") + "\n\n"
	);
}
