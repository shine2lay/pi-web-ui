/**
 * Find: the question box, Search, the two ways to search (by meaning, exact words), where to search,
 * and a few example questions to try.
 */

import type { FormEvent } from "react";
import type { MemoryRoot, SearchMode, SearchScope } from "./explorer-api.js";
import { rootName } from "./explorer-text.js";

/** Questions that show what search can do. */
export const TRY_EXAMPLES: ReadonlyArray<{ readonly query: string; readonly mode: SearchMode }> = [
	{ query: "how should marketing copy be written", mode: "meaning" },
	{ query: "rules for rolling a covered call down", mode: "meaning" },
	{ query: "why did chats keep reconnecting", mode: "meaning" },
	{ query: "flaky tests", mode: "meaning" },
	{ query: "Show&Tell", mode: "words" },
];

const MODE_HINT: Readonly<Record<SearchMode, string>> = {
	meaning: "Finds notes about the idea, even in other words.",
	words: "Finds these exact words and shows the line.",
};

/** Scope menu: everything, the shared places, then each department by name. */
export function scopeOptions(roots: readonly MemoryRoot[]): Array<{ value: SearchScope; label: string }> {
	const order = { shared: 0, projects: 1, department: 2 } as const;
	const sorted = [...roots].sort(
		(a, b) => order[a.group] - order[b.group] || rootName(a.uri).localeCompare(rootName(b.uri)),
	);
	return [{ value: "all", label: "Everything" }, ...sorted.map((r) => ({ value: r.uri, label: rootName(r.uri) }))];
}

export interface FindPanelProps {
	readonly disabled?: boolean;
	readonly query: string;
	readonly mode: SearchMode;
	readonly scope: SearchScope;
	readonly roots: readonly MemoryRoot[];
	onQuery(query: string): void;
	onMode(mode: SearchMode): void;
	onScope(scope: SearchScope): void;
	onSearch(query: string, mode: SearchMode): void;
	onClear(): void;
}

export function FindPanel(props: FindPanelProps) {
	const { query, mode, scope, roots } = props;
	const submit = (event: FormEvent) => {
		event.preventDefault();
		if (!props.disabled && query.trim()) props.onSearch(query.trim(), mode);
	};
	return (
		<section className="mx-find" aria-label="Search memory">
			<form className="mx-find-form" role="search" onSubmit={submit}>
				<label htmlFor="mx-q" className="mx-find-label">
					What do you want to find?
				</label>
				<div className="mx-find-box">
					<input
						id="mx-q"
						disabled={props.disabled}
						type="search"
						autoComplete="off"
						placeholder="Ask in your own words, e.g. rules for rolling a covered call down"
						value={query}
						onChange={(e) => props.onQuery(e.target.value)}
					/>
					{query ? (
						<button type="button" className="mx-clear" aria-label="Clear search" onClick={props.onClear}>
							<svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
								<path d="M2 2l10 10M12 2L2 12" />
							</svg>
						</button>
					) : null}
					<button type="submit" className="mx-btn mx-btn-solid" disabled={props.disabled}>
						Search
					</button>
				</div>
				<div className="mx-find-ways">
					<div className="mx-seg" role="group" aria-label="How to search">
						{(["meaning", "words"] as const).map((m) => (
							<button
								key={m}
								type="button"
								disabled={props.disabled}
								aria-pressed={mode === m}
								onClick={() => props.onMode(m)}
							>
								{m === "meaning" ? "By meaning" : "Exact words"}
							</button>
						))}
					</div>
					<select
						className="mx-scope"
						disabled={props.disabled}
						aria-label="Where to search"
						value={scope}
						onChange={(e) => props.onScope(e.target.value)}
					>
						{scopeOptions(roots).map((o) => (
							<option key={o.value} value={o.value}>
								{o.label}
							</option>
						))}
					</select>
				</div>
				<p className="mx-dim mx-find-hint">{MODE_HINT[mode]}</p>
				<div className="mx-tries">
					<span className="mx-dim">Try:</span>
					{TRY_EXAMPLES.map((t) => (
						<button
							key={t.query}
							disabled={props.disabled}
							type="button"
							className="mx-chip"
							data-try={t.query}
							data-try-mode={t.mode}
							onClick={() => props.onSearch(t.query, t.mode)}
						>
							{t.query}
						</button>
					))}
				</div>
			</form>
		</section>
	);
}
