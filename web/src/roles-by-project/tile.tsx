/**
 * roles-by-project tiles (design-elements.md §Tile): the closed tile (name, chip, lead, held-on, ring, numbers,
 * mini map, counts line) as one button with aria-expanded, the opened tile's full map and "Done when" fold, and
 * the compact minis of quiet projects.
 */
import type { UiBoardTask } from "../types";
import { Icon, Ring } from "./icons";
import {
	deptOf,
	goalsOf,
	groupLabelOf,
	heldOf,
	plural,
	roleName,
	type BoardContext,
	type Counts,
	type TileModel,
} from "./model";
import { OpenedMap, Thumb } from "./task-map";

const LARGE_OPEN = 6;

export const needLine = (n: number) => `${n} ${n === 1 ? "needs" : "need"} you`;

/** The counts line (design-elements.md §Tile): needs you first in gold, then each other open state as its own part. */
export function CountsParts({ c }: { c: Counts }) {
	const parts = [
		c.blocked ? `${c.blocked} blocked` : "",
		c.waiting ? `${c.waiting} waiting` : "",
		c.working ? `${c.working} working` : "",
		c.queued ? `${c.queued} queued` : "",
	].filter(Boolean);
	if (!parts.length && !c["needs-you"]) return <span>Idle: nothing queued</span>;
	return (
		<>
			{c["needs-you"] > 0 && <span className="c-you">{needLine(c["needs-you"])}</span>}
			{parts.map((p) => (
				<span key={p}>{p}</span>
			))}
		</>
	);
}

function Dot({ role }: { role: string }) {
	return <span className="rbp-sw" data-dept-role={deptOf(role)} />;
}

function Figure({ ctx, tile }: { ctx: BoardContext; tile: TileModel }) {
	const g = tile.group;
	if (g.kind === "project") {
		const goals = goalsOf(ctx.projects.get(g.projectId ?? ""));
		return goals && goals.total > 0 ? (
			<Ring met={goals.met} total={goals.total} label={`${goals.met} of ${goals.total} goals met`} />
		) : (
			<Ring met={0} total={0} label="No goals recorded" />
		);
	}
	if (g.kind === "role") {
		const role = g.key.slice("role:".length);
		return (
			<span className="rbp-avatar" data-dept-role={deptOf(role)} aria-hidden="true">
				{roleName(role).slice(0, 2)}
			</span>
		);
	}
	return (
		<span className="rbp-avatar" aria-hidden="true">
			{g.kind === "tag" ? "#" : <Icon name="q" />}
		</span>
	);
}

function Meta({ ctx, tile }: { ctx: BoardContext; tile: TileModel }) {
	const g = tile.group;
	const lead = g.kind === "project" ? ctx.projects.get(g.projectId ?? "")?.lead : undefined;
	const roles = g.kind === "tag" ? g.roles.slice(0, 3) : [];
	const groupsOfRole =
		g.kind === "role" ? new Set(tile.all.filter((t) => t.state !== "done").map((t) => t.groupKey)).size : 0;
	return (
		<span className="rbp-gmeta">
			{lead && (
				<span className="rbp-lead">
					<Dot role={lead} />
					Led by {roleName(lead)}
				</span>
			)}
			{g.kind === "none" && (
				<span>
					Across {plural(new Set(tile.all.filter((t) => t.state !== "done").map((t) => t.role)).size, "role")}
				</span>
			)}
			{roles.length > 0 && (
				<span className="rbp-lead">
					{roles.map((r) => (
						<span key={r} className="rbp-lead">
							<Dot role={r} />
							{roleName(r)}
						</span>
					))}
				</span>
			)}
			{g.kind === "role" && <span>In {plural(groupsOfRole, "project or tag", "projects or tags")}</span>}
			{tile.heldOn && (
				<span className="rbp-held">
					Mostly held on {roleName(tile.heldOn.role)} ({tile.heldOn.count})
				</span>
			)}
		</span>
	);
}

function chipOf(ctx: BoardContext, tile: TileModel): string | null {
	const g = tile.group;
	if (g.kind === "tag") return "Tag";
	if (g.kind !== "project") return null;
	const initiative = ctx.projects.get(g.projectId ?? "")?.initiative;
	return (initiative && ctx.initiatives.get(initiative)) || "Project";
}

function DoneWhen({ ctx, tile }: { ctx: BoardContext; tile: TileModel }) {
	if (tile.group.kind !== "project") return null;
	const goals = goalsOf(ctx.projects.get(tile.group.projectId ?? ""));
	if (!goals?.items.length) return null;
	return (
		<details className="rbp-fold">
			<summary>
				<Icon name="chev" />
				Done when · {goals.met} of {goals.total} met
			</summary>
			<ul className="rbp-dw">
				{goals.items.map((it, i) => (
					<li key={i} className={it.met ? "is-met" : undefined}>
						<Icon name={it.met ? "ok" : "q"} />
						<span>
							{it.item}
							<span className="rbp-sr">{it.met ? " (met)" : " (not met)"}</span>
						</span>
					</li>
				))}
			</ul>
		</details>
	);
}

/** "No project or tag": the open body clusters its tasks by role. */
function RoleClusters({ rows }: { rows: readonly UiBoardTask[] }) {
	const by = new Map<string, UiBoardTask[]>();
	for (const t of rows) by.set(t.role ?? "", [...(by.get(t.role ?? "") ?? []), t]);
	return (
		<>
			{[...by].map(([role, rs]) => (
				<section key={role} className="rbp-cluster">
					<h3>
						<Dot role={role} />
						{roleName(role)}
						<small>{plural(rs.filter((t) => t.state !== "done").length, "open task")}</small>
					</h3>
					<OpenedMap rows={rs} from={{ kind: "role" }} />
				</section>
			))}
		</>
	);
}

export function Tile({
	ctx,
	tile,
	open,
	onToggle,
}: {
	ctx: BoardContext;
	tile: TileModel;
	open: boolean;
	onToggle: (key: string) => void;
}) {
	const g = tile.group;
	const c = tile.counts;
	const chip = chipOf(ctx, tile);
	// The prototype shows "done · 14 days" on every project, tag and role tile (0 too), never on "No project or tag".
	const done14 = g.kind === "none" ? null : g.done14d;
	const bodyId = `rbp-body-${g.key.replace(/[^a-z0-9-]/gi, "-")}`;
	const cls = [
		"rbp-tile",
		tile.open >= LARGE_OPEN ? "is-l" : "",
		open ? "is-open" : "",
		c["needs-you"] > 0 ? "is-you" : "",
		tile.open === 0 ? "is-idle" : "",
	]
		.filter(Boolean)
		.join(" ");
	return (
		<article className={cls} data-group={g.key}>
			<button
				type="button"
				className="rbp-th"
				aria-expanded={open}
				aria-controls={open ? bodyId : undefined}
				onClick={() => onToggle(g.key)}
			>
				<span>
					<span className="rbp-gname">
						<span className="rbp-h">{g.label}</span>
						{chip && <span className="rbp-chip">{chip}</span>}
					</span>
					<Meta ctx={ctx} tile={tile} />
				</span>
				<span className="rbp-chev">
					<Icon name="chev" />
				</span>
				<span className="rbp-fig">
					<Figure ctx={ctx} tile={tile} />
					<span className="rbp-nums">
						<span>
							<b className="num">{tile.open}</b>open
						</span>
						{c["needs-you"] > 0 && (
							<span className="c-you">
								<b className="num">{c["needs-you"]}</b>
								{c["needs-you"] === 1 ? "needs" : "need"} you
							</span>
						)}
						{heldOf(c) > 0 && (
							<span>
								<b className="num">{heldOf(c)}</b>held
							</span>
						)}
						{done14 !== null && (
							<span>
								<b className="num">{done14}</b>done · 14 days
							</span>
						)}
					</span>
				</span>
				<span className="rbp-draw">
					<Thumb rows={tile.shown} scale={1.25} />
				</span>
				{tile.open > 0 && (
					<span className="rbp-counts">
						<CountsParts c={c} />
					</span>
				)}
			</button>
			{open && (
				<div className="rbp-gbody" id={bodyId}>
					{g.kind === "none" ? (
						<RoleClusters rows={tile.shown} />
					) : (
						<OpenedMap
							rows={tile.shown}
							from={
								g.kind === "role" ? { kind: "group", labelOf: (t) => groupLabelOf(ctx, t.groupKey) } : { kind: "role" }
							}
						/>
					)}
					{tile.shown.length === 0 && <p className="rbp-note">No task of this group is on the board right now.</p>}
					<DoneWhen ctx={ctx} tile={tile} />
				</div>
			)}
		</article>
	);
}

/** A quiet project or a finished group: ring, name, what it did lately, its mini map; opens as a tile. */
export function Mini({ ctx, tile, onOpen }: { ctx: BoardContext; tile: TileModel; onOpen: (key: string) => void }) {
	const g = tile.group;
	return (
		<button type="button" className="rbp-mini" onClick={() => onOpen(g.key)}>
			<Figure ctx={ctx} tile={tile} />
			<span className="rbp-mtxt">
				<b>{g.label}</b>
				<small>{g.done14d > 0 ? `${plural(g.done14d, "task")} done in 14 days` : "Nothing done lately"}</small>
				{tile.shown.length > 0 && (
					<span className="rbp-draw">
						<Thumb rows={tile.shown} scale={1} />
					</span>
				)}
			</span>
		</button>
	);
}
