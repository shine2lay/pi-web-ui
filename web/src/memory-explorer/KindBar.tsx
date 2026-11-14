/** A bar split by the kinds of note in a folder (Rules, Cases and lessons, Facts, Events, Documents). */

import type { KindCounts } from "./explorer-api.js";
import { KIND_KEY } from "./explorer-text.js";

export function KindBar({ counts, small = false }: { counts: KindCounts; small?: boolean }) {
	const parts = KIND_KEY.map(([kind]) => [kind, counts[kind] ?? 0] as const).filter(([, n]) => n > 0);
	const total = parts.reduce((sum, [, n]) => sum + n, 0);
	if (total === 0) return <span className={small ? "mx-bar mx-bar-small" : "mx-bar"} aria-hidden="true" />;
	return (
		<span className={small ? "mx-bar mx-bar-small" : "mx-bar"} aria-hidden="true">
			{parts.map(([kind, n]) => (
				<i key={kind} className={`k-${kind}`} style={{ width: `${((n / total) * 100).toFixed(1)}%` }} />
			))}
		</span>
	);
}

/** The key above the tree: which colour is which kind. */
export function KindKey() {
	return (
		<ul className="mx-key" aria-label="Kinds of note">
			{KIND_KEY.map(([kind, word]) => (
				<li key={kind}>
					<i className={`mx-kind-dot k-${kind}`} aria-hidden="true" />
					{word}
				</li>
			))}
		</ul>
	);
}
