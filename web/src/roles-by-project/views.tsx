/**
 * roles-by-project body parts (design.md §First view 3 and 5, §Screen States): the fleet bar, the Now lanes, the
 * Status view, and the loading / all-clear / error / no-results panels.
 */
import { useState } from "react";
import type { UiBoardTask } from "../types";
import { Icon, StatePill } from "./icons";
import {
	countsOf,
	deptOf,
	groupLabelOf,
	isOpen,
	OPEN_STATES,
	plural,
	rankOf,
	roleName,
	STATE_KEY,
	STATE_WORD,
	type BoardContext,
	type NowLane,
	type StatusTile,
} from "./model";
import { CountsParts } from "./tile";
import { TaskCard } from "./task-map";

const UP_NEXT_MAX = 20;
const LEGEND_WORDS: Record<(typeof OPEN_STATES)[number], string> = {
	"needs-you": "Need you",
	blocked: "Blocked",
	waiting: "Waiting",
	working: "Working",
	queued: "Queued",
};

export function FleetBar({ open }: { open: readonly UiBoardTask[] }) {
	const counts = countsOf(open);
	const roles = new Set(open.map((t) => t.role ?? "")).size;
	return (
		<section className="rbp-fleet" aria-label="All open work">
			<span className="rbp-tot">
				<b className="num">{open.length}</b>open across {plural(roles, "role")}
			</span>
			<span className="rbp-bar" aria-hidden="true">
				{[...open]
					.sort((a, b) => rankOf(a) - rankOf(b))
					.map((t) => (
						<i key={t.ref} className={`k-${STATE_KEY[t.state]}`} />
					))}
			</span>
			<span className="rbp-legend">
				{OPEN_STATES.map((s) => (
					<span key={s}>
						<i className={`k-${STATE_KEY[s]}`} />
						<Icon name={STATE_KEY[s]} />
						<b className="num">{counts[s]}</b> {LEGEND_WORDS[s]}
					</span>
				))}
			</span>
		</section>
	);
}

function LaneSeg({
	title,
	rows,
	byRef,
	ctx,
	numbered,
	more,
}: {
	title: string;
	rows: UiBoardTask[];
	byRef: Map<string, UiBoardTask>;
	ctx: BoardContext;
	numbered?: boolean;
	more?: number;
}) {
	if (!rows.length) return null;
	return (
		<div className="rbp-segl">
			<p className="rbp-sec">
				{title} · {rows.length + (more ?? 0)}
			</p>
			<div className="rbp-cards">
				{rows.map((t, i) => (
					<TaskCard
						key={t.ref}
						task={t}
						byRef={byRef}
						from={{ kind: "group", labelOf: (x) => groupLabelOf(ctx, x.groupKey) }}
						order={numbered ? i + 1 : undefined}
					/>
				))}
			</div>
			{!!more && <p className="rbp-sec">+{more} more</p>}
		</div>
	);
}

export function NowView({ ctx, lanes }: { ctx: BoardContext; lanes: NowLane[] }) {
	const byRef = new Map(ctx.board.tasks.map((t) => [t.ref, t]));
	return (
		<div className="rbp-lanes">
			{lanes.map((lane) => {
				const c = countsOf(lane.rows);
				const next = lane.next.slice(0, UP_NEXT_MAX);
				return (
					<section
						key={lane.role}
						className={`rbp-lane${c["needs-you"] ? " is-you" : ""}`}
						aria-label={roleName(lane.role)}
					>
						<div className="rbp-lh">
							<span className="rbp-avatar" data-dept-role={deptOf(lane.role)} aria-hidden="true">
								{roleName(lane.role).slice(0, 2)}
							</span>
							<div>
								<h2>{roleName(lane.role)}</h2>
								<p className="rbp-counts">
									<CountsParts c={c} />
								</p>
							</div>
						</div>
						<div className="rbp-track">
							<LaneSeg title="Running" rows={lane.running} byRef={byRef} ctx={ctx} />
							<LaneSeg title="Held" rows={lane.held} byRef={byRef} ctx={ctx} />
							<LaneSeg
								title="Up next, in order"
								rows={next}
								byRef={byRef}
								ctx={ctx}
								numbered
								more={lane.next.length - next.length}
							/>
						</div>
					</section>
				);
			})}
		</div>
	);
}

function StatusBody({ ctx, tile }: { ctx: BoardContext; tile: StatusTile }) {
	const byRef = new Map(ctx.board.tasks.map((t) => [t.ref, t]));
	return (
		<div className="rbp-gbody">
			{tile.clusters.map((cl) => {
				const g = ctx.groups.get(cl.key);
				const project = g?.kind === "project" ? ctx.projects.get(g.projectId ?? "") : undefined;
				const met = project?.doneWhen?.length
					? `${project.doneWhen.filter((d) => d.met).length} of ${project.doneWhen.length} done-when met`
					: g?.kind === "tag"
						? "Tag"
						: "";
				return (
					<section key={cl.key} className="rbp-cluster">
						<h3>
							{cl.label}
							{met && <small>{met}</small>}
						</h3>
						<div className="rbp-tasks">
							{cl.rows.map((t) => (
								<TaskCard key={t.ref} task={t} byRef={byRef} from={{ kind: "role" }} />
							))}
						</div>
					</section>
				);
			})}
		</div>
	);
}

export function StatusView({
	ctx,
	tiles,
	opened,
	onToggle,
}: {
	ctx: BoardContext;
	tiles: StatusTile[];
	opened: ReadonlySet<string>;
	onToggle: (key: string) => void;
}) {
	return (
		<div className="rbp-bento">
			{tiles.map((tile) => {
				const open = opened.has(tile.key);
				const key = STATE_KEY[tile.state];
				const groups = tile.clusters.length;
				const roles = new Set(tile.rows.map((t) => t.role)).size;
				return (
					<article
						key={tile.key}
						className={`rbp-tile${open ? " is-open" : ""}${tile.rows.length >= 6 ? " is-l" : ""}${tile.state === "needs-you" && tile.rows.length ? " is-you" : ""}`}
					>
						<button type="button" className="rbp-th" aria-expanded={open} onClick={() => onToggle(tile.key)}>
							<span className="rbp-gname">
								<span className="rbp-h">{tile.name}</span>
							</span>
							<span className="rbp-chev">
								<Icon name="chev" />
							</span>
							<span className="rbp-gmeta">
								<span>
									{plural(groups, "project or tag", "projects or tags")} · {plural(roles, "role")}
								</span>
							</span>
							<span className="rbp-fig">
								<span className={`rbp-sticon p-${key}`} aria-hidden="true">
									<Icon name={key} />
								</span>
								<span className="rbp-nums">
									<span>
										<b className="num">{tile.rows.length}</b>
										{tile.state === "done" ? "done · 14 days" : STATE_WORD[tile.state].toLowerCase()}
									</span>
								</span>
							</span>
						</button>
						{open && <StatusBody ctx={ctx} tile={tile} />}
					</article>
				);
			})}
		</div>
	);
}

export function LoadingView() {
	return (
		<>
			<p className="rbp-loadnote" role="status">
				Loading projects and queues…
			</p>
			<div className="rbp-bento" aria-hidden="true">
				{[2, 1, 1, 1, 1, 2].map((span, i) => (
					<div key={i} className={`rbp-sk${span === 2 ? " rbp-tile is-l" : ""}`}>
						<i className="c" />
						<span>
							<i style={{ width: "70%" }} />
							<i style={{ width: "45%", marginTop: 10 }} />
						</span>
						<i className="b" />
					</div>
				))}
			</div>
		</>
	);
}

export function CalmPanel() {
	return (
		<section className="rbp-calm">
			<span className="rbp-sticon" aria-hidden="true">
				<Icon name="ok" />
			</span>
			<div>
				<h2>All clear</h2>
				<p>
					No task is open and nothing waits on you. Projects with nothing running are below; start their next step from
					the lead's chat.
				</p>
			</div>
		</section>
	);
}

export function ErrorBanner({ at, reason, onRetry }: { at: string | null; reason?: string; onRetry: () => void }) {
	const why = reason?.trim().replace(/\.?$/, ". ") ?? "";
	return (
		<div className="rbp-banner" role="alert">
			<Icon name="fail" />
			<p>
				Couldn't read the queues just now.{at ? ` You're seeing what was read ${at}.` : " Nothing to show yet."}
				<small>{why}Your tasks are safe; only this page is behind.</small>
			</p>
			<button type="button" className="rbp-btn" onClick={onRetry}>
				Try again
			</button>
		</div>
	);
}

export function NoResults({
	query,
	suggestions,
	onClear,
	onSuggest,
}: {
	query: string;
	suggestions: string[];
	onClear: () => void;
	onSuggest: (q: string) => void;
}) {
	return (
		<section className="rbp-nores">
			<h2>No task, project or role matches “{query.trim()}”</h2>
			<p>Search looks at task titles and numbers, project names and role names.</p>
			<div className="rbp-acts">
				<button type="button" className="rbp-btn" onClick={onClear}>
					Clear search
				</button>
				{suggestions.length > 0 && <span className="rbp-sec">Try</span>}
				{suggestions.map((s) => (
					<button key={s} type="button" className="rbp-link" onClick={() => onSuggest(s)}>
						{s}
					</button>
				))}
			</div>
		</section>
	);
}
