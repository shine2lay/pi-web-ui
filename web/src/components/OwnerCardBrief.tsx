/**
 * owner-card-brief (Ops #682): the plain brief a queue card that reaches the owner opens with, before its
 * question: what it's about, why it's his, what waits on it and what each answer does, a short label on each
 * line. The server builds it from the records (server/owner-card-brief.ts); the page takes it only whole and
 * plain (roles-useful-model briefLines). The Roles page's Needs-you rows, its answer dialog and the Queue tab
 * show it the same way.
 */
import type { UiOwnerCardBriefLine } from "../types";

export function OwnerCardBrief({ lines }: { lines: readonly UiOwnerCardBriefLine[] | undefined }) {
	if (!lines?.length) return null;
	return (
		<dl className="owner-card-brief">
			{lines.map((line, index) => (
				<div key={`${index}:${line.label}`} className="owner-card-brief-line">
					<dt>{line.label}:</dt> <dd>{line.text}</dd>
				</div>
			))}
		</dl>
	);
}
