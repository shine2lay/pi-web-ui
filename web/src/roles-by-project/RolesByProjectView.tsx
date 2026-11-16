/**
 * roles-by-project page (spec-page.md, design.md): the Roles overview grouped by project (default), Now,
 * Department or Status, with Search, the fleet bar, Needs you and tiles that open into their task maps.
 * Data: the roles watch (full) -> overview.taskBoard; answering through RoleAnswerDialog. Mounted by PagePanes.
 */
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useAppField } from "../app-globals";
import { RoleAnswerDialog } from "../components/RoleAnswerDialog";
import { liveVisibleAt, subscribePageLive } from "../page-live";
import type { NativeDialogSummary } from "../roles-answer-actions";
import { reloadRoles, useRoles } from "../roles-state";
import { projectUsefulRoles, type NeedsYouItem, type UsefulOpenTarget } from "../roles-useful-model";
import { TASKS_ROLES_V8_TOKENS_CSS } from "../tasks-roles-v8/styles-tokens";
import { THEME_CHANGE_EVENT } from "../theme";
import type { UiTaskBoard } from "../types";
import { Body } from "./body";
import { Controls, readGroupBy, storeGroupBy } from "./controls";
import { busiestOf, contextOf, fleetOf, plural, searchKey, type GroupBy } from "./model";
import { NeedsStrip } from "./needs";
import { ROLES_BY_PROJECT_CSS } from "./styles";
import { ErrorBanner, FleetBar, LoadingView } from "./views";

/** The page's only colour and font source: the v8 carbon tokens (spec-build.md §Modules: no new colours or fonts). */
export const ROLES_BY_PROJECT_TOKENS_CSS = TASKS_ROLES_V8_TOKENS_CSS;

export interface RolesByProjectViewProps {
	active: boolean;
	dialogs?: readonly NativeDialogSummary[];
	onOpen: (target: UsefulOpenTarget) => void;
	onAbout: (roleId: string) => void;
}

/** The app theme is a :root stylesheet; light when its color-scheme says only light. */
function readLight(): boolean {
	if (typeof document === "undefined") return false;
	const scheme = getComputedStyle(document.documentElement).colorScheme.split(/\s+/);
	return scheme.includes("light") && !scheme.includes("dark");
}
function useLightTheme(): boolean {
	const [light, setLight] = useState(readLight);
	useEffect(() => {
		const sync = () => setLight(readLight());
		window.addEventListener(THEME_CHANGE_EVENT, sync);
		return () => window.removeEventListener(THEME_CHANGE_EVENT, sync);
	}, []);
	return light;
}

const asOfText = (ms: number | undefined) =>
	ms ? new Date(ms).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : null;

export function RolesByProjectView({ active, dialogs = [], onOpen }: RolesByProjectViewProps) {
	const state = useRoles(active ? "full" : "off");
	const connection = useAppField("status");
	const visibleAt = useSyncExternalStore(subscribePageLive, liveVisibleAt, liveVisibleAt);
	const [now, setNow] = useState(() => Date.now());
	const light = useLightTheme();
	const [groupBy, setGroupBy] = useState<GroupBy>(readGroupBy);
	const [query, setQuery] = useState("");
	const [opened, setOpened] = useState<ReadonlySet<string>>(() => new Set());
	const [answer, setAnswer] = useState<{ item: NeedsYouItem; from: HTMLElement | null } | null>(null);
	const lastGood = useRef<UiTaskBoard | null>(null);

	const model = useMemo(
		() => projectUsefulRoles(state, connection, now, { visibleAt }),
		[state, connection, now, visibleAt],
	);
	useEffect(() => {
		if (!active) return;
		const tick = setInterval(() => setNow(Date.now()), 30_000);
		const wait = model.graceUntil
			? setTimeout(() => setNow(Date.now()), Math.max(0, model.graceUntil - Date.now()))
			: null;
		return () => {
			clearInterval(tick);
			if (wait) clearTimeout(wait);
		};
	}, [active, model.graceUntil]);

	const overview = state.overview;
	const fresh = overview?.taskBoard ?? null;
	if (fresh) lastGood.current = fresh;
	const board = fresh ?? lastGood.current;
	const failed = state.status === "error" || !!state.error || (!!overview && !fresh && !!lastGood.current);
	const ctx = useMemo(() => (overview && board ? contextOf(overview, board) : null), [overview, board]);

	// A tile whose group left the board closes (spec-page.md §Live updates).
	useEffect(() => {
		if (!ctx || !opened.size) return;
		const kept = [...opened].filter((k) => ctx.groups.has(k) || k.startsWith("status:"));
		if (kept.length !== opened.size) setOpened(new Set(kept));
	}, [ctx, opened]);

	const toggle = useCallback((key: string) => {
		setOpened((prev) => {
			const next = new Set(prev);
			if (!next.delete(key)) next.add(key);
			return next;
		});
	}, []);
	const pickGroupBy = (v: GroupBy) => {
		setGroupBy(v);
		storeGroupBy(v);
	};
	const showGroup = (ref: string) => {
		const key = ctx?.board.tasks.find((t) => t.ref === ref)?.groupKey;
		if (!key) return;
		if (groupBy !== "project") pickGroupBy("project");
		setQuery("");
		setOpened((prev) => new Set(prev).add(key));
		requestAnimationFrame(() =>
			document.querySelector(`.rbp [data-group="${CSS.escape(key)}"]`)?.scrollIntoView({ block: "start" }),
		);
	};

	const key = searchKey(query);
	const fleet = board ? fleetOf(board) : null;
	const needs = model.needsYou;
	const busiest = ctx ? busiestOf(ctx) : null;
	const asOf = asOfText(board?.asOf ?? state.checkedAt);
	const showNeeds = !!ctx && (groupBy === "project" || groupBy === "department") && needs.total > 0;

	return (
		<div className="rbp" data-tasks-roles-v8-theme={light ? "light" : "dark"}>
			<style>{ROLES_BY_PROJECT_TOKENS_CSS}</style>
			<style>{ROLES_BY_PROJECT_CSS}</style>
			<main className="rbp-main" aria-labelledby="rbp-title">
				<header className="rbp-top">
					<div>
						<h1 id="rbp-title">Roles</h1>
						{!ctx && !failed && <p className="rbp-lede">Reading every role's queue…</p>}
						{ctx && fleet && (
							<p className="rbp-lede">
								{fleet.open.length === 0 ? (
									"Nothing is open. Every role's queue is clear."
								) : (
									<>
										{needs.total > 0 ? <b>{plural(needs.total, "thing")} need you.</b> : "Nothing needs you right now."}
										{busiest && ` ${busiest.label} is the busiest: ${busiest.open} open, ${busiest.held} held.`}
									</>
								)}
							</p>
						)}
					</div>
					{asOf && <span className="rbp-asof">As of {asOf}</span>}
				</header>
				{(ctx || !failed) && <Controls groupBy={groupBy} onGroupBy={pickGroupBy} query={query} onQuery={setQuery} />}
				{failed && <ErrorBanner at={asOf} reason={state.error} onRetry={reloadRoles} />}
				{!ctx && !failed && <LoadingView />}
				{ctx && board?.problem && <p className="rbp-note">{board.problem}</p>}
				{ctx && fleet && !key && fleet.open.length > 0 && <FleetBar open={fleet.open} />}
				{showNeeds && (
					<NeedsStrip
						needs={needs}
						dialogs={dialogs}
						groupLabelOf={(ref) => {
							const t = ctx.board.tasks.find((row) => row.ref === ref);
							return t ? (ctx.groups.get(t.groupKey)?.label ?? null) : null;
						}}
						onAnswer={(item, from) => setAnswer({ item, from })}
						onOpenChat={(item) => item.link && onOpen(item.link)}
						onShowGroup={showGroup}
					/>
				)}
				{ctx && <Body ctx={ctx} groupBy={groupBy} query={query} opened={opened} onToggle={toggle} onQuery={setQuery} />}
			</main>
			{answer && (
				<RoleAnswerDialog
					item={answer.item}
					needs={needs}
					connected={connection === "open"}
					onAnswered={() => reloadRoles()}
					onOpen={onOpen}
					onClose={(back) => {
						const from = answer.from;
						setAnswer(null);
						if (back && from) requestAnimationFrame(() => from.isConnected && from.focus());
					}}
				/>
			)}
		</div>
	);
}
