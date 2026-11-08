// ---------------------------------------------------------------------------
// server/shared/task-tags.ts — Canonical tag slug validation & inheritance
// ---------------------------------------------------------------------------

export const TAG_SLUG_RE = /^[a-z0-9][a-z0-9-]{0,59}$/;
export const MAX_TAGS_PER_ITEM = 16;

export type TagCheckResult = { ok: true; value: string[] | undefined } | { ok: false; error: string };

/**
 * Validates and deduplicates an optional tags input at a tool or API boundary.
 * - undefined -> { ok: true, value: undefined } (caller omitted tags)
 * - []        -> { ok: true, value: [] }        (caller explicitly cleared/suppressed tags)
 * - string[]  -> trims outer whitespace, validates each against TAG_SLUG_RE, deduplicates preserving first-seen order.
 * Fails loud on non-arrays, non-strings, uppercase, spaces, underscores, leading hyphens, >60 chars, or >16 unique tags.
 */
export function checkTags(raw: unknown, maxTags: number = MAX_TAGS_PER_ITEM): TagCheckResult {
	if (raw === undefined) return { ok: true, value: undefined };
	if (!Array.isArray(raw)) {
		return {
			ok: false,
			error: "tags must be an array of tag slugs (lowercase letters, digits, and dashes; 1-60 chars each).",
		};
	}
	const seen = new Set<string>();
	const out: string[] = [];
	for (let i = 0; i < raw.length; i++) {
		const item = raw[i];
		if (typeof item !== "string") {
			return {
				ok: false,
				error: `invalid tag at index ${i}: each tag must be a string slug.`,
			};
		}
		const trimmed = item.trim();
		if (trimmed.length === 0 || trimmed.length > 60 || !TAG_SLUG_RE.test(trimmed)) {
			return {
				ok: false,
				error: `invalid tag "${item}": use lowercase letters, digits, and dashes (at most 60 characters, e.g. "roles-rework").`,
			};
		}
		if (!seen.has(trimmed)) {
			seen.add(trimmed);
			out.push(trimmed);
		}
	}
	if (out.length > maxTags) {
		return {
			ok: false,
			error: `too many tags (${out.length}): at most ${maxTags} tags are allowed per item.`,
		};
	}
	return { ok: true, value: out };
}

/**
 * Merges inherited tags from turn origin inputs when caller omits explicit tags on task creation.
 */
export function resolveInheritedTags(
	explicitTags: string[] | undefined,
	originInputs: ReadonlyArray<{ tags?: string[] } | { kind?: string; tags?: string[] }> | undefined,
	maxTags: number = MAX_TAGS_PER_ITEM,
): string[] | undefined {
	if (explicitTags !== undefined) {
		return explicitTags.length > 0 ? explicitTags : undefined;
	}
	if (!originInputs || originInputs.length === 0) return undefined;
	const seen = new Set<string>();
	const inherited: string[] = [];
	for (const input of originInputs) {
		const rawTags = "tags" in input ? input.tags : undefined;
		if (!Array.isArray(rawTags)) continue;
		for (const tag of rawTags) {
			if (typeof tag === "string") {
				const trimmed = tag.trim();
				if (TAG_SLUG_RE.test(trimmed) && !seen.has(trimmed)) {
					seen.add(trimmed);
					inherited.push(trimmed);
					if (inherited.length >= maxTags) break;
				}
			}
		}
		if (inherited.length >= maxTags) break;
	}
	return inherited.length > 0 ? inherited : undefined;
}

/**
 * Replay helper that filters, trims, and deduplicates valid tag slugs without throwing.
 * Returns undefined when raw is not an array or contains no valid tag slugs.
 */
export function normTags(raw: unknown, maxTags: number = MAX_TAGS_PER_ITEM): string[] | undefined {
	if (!Array.isArray(raw)) return undefined;
	const seen = new Set<string>();
	const out: string[] = [];
	for (const item of raw) {
		if (typeof item !== "string") continue;
		const trimmed = item.trim();
		if (trimmed.length > 0 && trimmed.length <= 60 && TAG_SLUG_RE.test(trimmed) && !seen.has(trimmed)) {
			seen.add(trimmed);
			out.push(trimmed);
			if (out.length >= maxTags) break;
		}
	}
	return out.length > 0 ? out : undefined;
}
