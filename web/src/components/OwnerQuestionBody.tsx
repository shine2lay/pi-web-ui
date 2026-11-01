import { useMemo, useState } from "react";
import { Markdown } from "./Markdown";

interface OwnerQuestionBodyPart {
	kind: "text" | "package";
	text: string;
}

/** server/owner-question-card.ts quotes every package line, including blank ones as bare `>`.
 * Only that contiguous quote after "Package:" folds; the next question and guidance stay outside. */
export function parseOwnerQuestionBody(text: string): OwnerQuestionBodyPart[] {
	const lines = text.split("\n");
	const parts: OwnerQuestionBodyPart[] = [];
	let start = 0;
	let cursor = 0;
	while (cursor < lines.length) {
		if (lines[cursor] !== "Package:" || !lines[cursor + 1]?.startsWith(">")) {
			cursor++;
			continue;
		}
		if (start < cursor) parts.push({ kind: "text", text: lines.slice(start, cursor).join("\n") });
		const quoted: string[] = [];
		cursor++;
		while (cursor < lines.length && lines[cursor].startsWith(">")) {
			quoted.push(lines[cursor].replace(/^> ?/, ""));
			cursor++;
		}
		parts.push({ kind: "package", text: quoted.join("\n") });
		start = cursor;
	}
	if (start < lines.length) parts.push({ kind: "text", text: lines.slice(start).join("\n") });
	return parts;
}

function OwnerQuestionPackage({ text, forceOpen }: { text: string; forceOpen: boolean }) {
	const [open, setOpen] = useState(false);
	return (
		<details open={open || forceOpen}>
			<summary
				onClick={(event) => {
					// Search opens packages only for display, without changing the reader's own folds.
					event.preventDefault();
					if (!forceOpen) setOpen((value) => !value);
				}}
			>
				Package
			</summary>
			<Markdown text={text} hardBreaks />
		</details>
	);
}

/** Expanded body only: the existing RoleMessageCard owns the card shell and its outer fold. */
export function OwnerQuestionBody({ text, forceOpen = false }: { text: string; forceOpen?: boolean }) {
	const parts = useMemo(() => parseOwnerQuestionBody(text), [text]);
	return (
		<>
			{parts.map((part, index) =>
				part.kind === "package" ? (
					<OwnerQuestionPackage key={index} text={part.text} forceOpen={forceOpen} />
				) : (
					<Markdown key={index} text={part.text} hardBreaks />
				),
			)}
		</>
	);
}
