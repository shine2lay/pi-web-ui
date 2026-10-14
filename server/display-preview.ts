/** Automatic display labels only. Never apply this to indexed, searched or model text. */
export const DISPLAY_PREVIEW_SCALARS = 300;

/**
 * A bounded Unicode-scalar prefix, with one ellipsis iff text remains. Only the prefix is
 * visited: a long first message must not allocate a full Array.from(text) just to display it.
 * Unpaired UTF-16 surrogates become replacement characters in this display copy only.
 * Smaller existing display budgets (e.g. the live list's 30) use the same formatter.
 */
export function displayPreview(text: string, maxScalars = DISPLAY_PREVIEW_SCALARS): string {
	if (!Number.isSafeInteger(maxScalars) || maxScalars < 0 || maxScalars > DISPLAY_PREVIEW_SCALARS) {
		throw new RangeError("Display preview budget must be an integer from 0 to 300");
	}
	// UTF-16 length is an upper bound on scalar count, not a truncation budget.
	// The Unicode-mode pattern finds unpaired surrogates only; its input is <=300 units.
	if (text.length <= maxScalars && !/[\uD800-\uDFFF]/u.test(text)) return text;
	let end = 0;
	let count = 0;
	let copiedFrom = 0;
	let repaired = "";
	while (end < text.length && count < maxScalars) {
		const point = text.codePointAt(end)!;
		if (point >= 0xd800 && point <= 0xdfff) {
			repaired += `${text.slice(copiedFrom, end)}\ufffd`;
			end += 1;
			copiedFrom = end;
		} else {
			end += point > 0xffff ? 2 : 1;
		}
		count += 1;
	}
	const prefix = repaired ? repaired + text.slice(copiedFrom, end) : text.slice(0, end);
	return end < text.length ? `${prefix}…` : prefix;
}
