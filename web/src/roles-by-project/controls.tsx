/**
 * roles-by-project control row (design.md §First view 2): exactly two controls, the Group by radiogroup
 * (arrow keys move and focus, choice remembered as roles.groupBy) and the Search box. Search is never stored.
 */
import { useRef, type KeyboardEvent } from "react";
import { Icon } from "./icons";
import { GROUP_BYS, type GroupBy } from "./model";

export const GROUP_BY_KEY = "roles.groupBy";

export function readGroupBy(): GroupBy {
	try {
		const v = localStorage.getItem(GROUP_BY_KEY);
		return GROUP_BYS.includes(v as GroupBy) ? (v as GroupBy) : "project";
	} catch {
		return "project";
	}
}
export function storeGroupBy(v: GroupBy): void {
	try {
		localStorage.setItem(GROUP_BY_KEY, v);
	} catch {
		/* storage off: the choice lasts this visit */
	}
}

const LABELS: Record<GroupBy, [string, string]> = {
	project: ["Project", "Project"],
	now: ["Now", "Now"],
	department: ["Department", "Dept."],
	status: ["Status", "Status"],
};

export function Controls({
	groupBy,
	onGroupBy,
	query,
	onQuery,
}: {
	groupBy: GroupBy;
	onGroupBy: (v: GroupBy) => void;
	query: string;
	onQuery: (q: string) => void;
}) {
	const seg = useRef<HTMLDivElement | null>(null);
	const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
		const step =
			e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
		const at = GROUP_BYS.indexOf(groupBy);
		const next =
			e.key === "Home"
				? 0
				: e.key === "End"
					? GROUP_BYS.length - 1
					: step
						? (at + step + GROUP_BYS.length) % GROUP_BYS.length
						: -1;
		if (next < 0) return;
		e.preventDefault();
		onGroupBy(GROUP_BYS[next]);
		seg.current?.querySelectorAll<HTMLButtonElement>('[role="radio"]')[next]?.focus();
	};
	return (
		<div className="rbp-controls" data-filters="">
			<div className="rbp-gb">
				<span id="rbp-gb-label">Group by</span>
				<div className="rbp-seg" role="radiogroup" aria-labelledby="rbp-gb-label" ref={seg} onKeyDown={onKey}>
					{GROUP_BYS.map((v) => {
						const [long, short] = LABELS[v];
						const on = v === groupBy;
						return (
							<button
								key={v}
								type="button"
								role="radio"
								aria-checked={on}
								aria-label={long}
								tabIndex={on ? 0 : -1}
								onClick={() => onGroupBy(v)}
							>
								{short === long ? (
									long
								) : (
									<>
										<span className="rbp-lg">{long}</span>
										<span className="rbp-sm" aria-hidden="true">
											{short}
										</span>
									</>
								)}
							</button>
						);
					})}
				</div>
			</div>
			<div className="rbp-search">
				<Icon name="search" />
				<input
					type="search"
					aria-label="Find a task, project or role"
					placeholder="Find a task, project or role"
					value={query}
					onChange={(e) => onQuery(e.currentTarget.value)}
					onKeyDown={(e) => {
						if (e.key === "Escape" && query) {
							e.stopPropagation();
							onQuery("");
						}
					}}
				/>
			</div>
		</div>
	);
}
