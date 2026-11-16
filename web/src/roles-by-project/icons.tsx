/**
 * roles-by-project icons (prototype ICON set, 16x16 stroke): every state carries its icon beside its word, so
 * colour is never the only signal (design.md §Accessibility).
 */
import type { UiBoardState } from "../types";
import { STATE_KEY, STATE_WORD, type StateKey } from "./model";

type IconName = StateKey | "chev" | "search" | "fail";

const PATHS: Record<IconName, React.ReactNode> = {
	you: (
		<>
			<circle cx="8" cy="8" r="6.2" />
			<path d="M8 4.8v3.6M8 11.2v.1" />
		</>
	),
	fail: (
		<>
			<circle cx="8" cy="8" r="6.2" />
			<path d="M8 4.8v3.6M8 11.2v.1" />
		</>
	),
	blk: (
		<>
			<circle cx="8" cy="8" r="6.2" />
			<path d="M3.8 12.2 12.2 3.8" />
		</>
	),
	wt: (
		<>
			<circle cx="8" cy="8" r="6.2" />
			<path d="M8 4.8V8l2.4 1.4" />
		</>
	),
	wk: <path d="M2.8 8a5.2 5.2 0 0 1 9.3-3.2M13.2 8a5.2 5.2 0 0 1-9.3 3.2M12.4 1.9v3h-3M3.6 14.1v-3h3" />,
	q: <circle cx="8" cy="8" r="6.2" strokeDasharray="2.2 2.4" />,
	ok: <path d="M3.2 8.6 6.4 11.6 12.8 4.6" />,
	chev: <path d="M4 6l4 4 4-4" />,
	search: (
		<>
			<circle cx="7" cy="7" r="4.5" />
			<path d="M10.5 10.5 14 14" />
		</>
	),
};

export function Icon({ name }: { name: IconName }) {
	return (
		<svg className="rbp-i" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
			{PATHS[name]}
		</svg>
	);
}

/** A state pill: icon + word in the state's colours. */
export function StatePill({ state }: { state: UiBoardState }) {
	const key = STATE_KEY[state];
	return (
		<span className={`rbp-pill p-${key}`}>
			<Icon name={key} />
			{STATE_WORD[state]}
		</span>
	);
}

/** The goals ring: met / total done-when items. */
export function Ring({ met, total, label }: { met: number; total: number; label: string }) {
	const r = 18;
	const c = 2 * Math.PI * r;
	const frac = total > 0 ? Math.min(1, met / total) : 0;
	return (
		<span className="rbp-ring" role="img" aria-label={label}>
			<svg viewBox="0 0 44 44" aria-hidden="true" focusable="false">
				<circle className="tr" cx="22" cy="22" r={r} />
				{frac > 0 && <circle className="pr" cx="22" cy="22" r={r} strokeDasharray={`${c * frac} ${c}`} />}
			</svg>
			<b className="num" aria-hidden="true">
				{total > 0 ? `${met}/${total}` : "–"}
			</b>
		</span>
	);
}
