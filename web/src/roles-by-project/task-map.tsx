/**
 * roles-by-project task maps (design-elements.md §Task map): the opened map (chains left to right by `after` and
 * `block.on`, loose tasks "On their own", done tasks folded) and the closed tile's mini map. Layout comes from
 * graph.ts (taskMapOf / miniMapOf); this file only draws it.
 */
import { useState, type CSSProperties } from "react";
import { miniMapOf, taskMapOf, type TaskMap } from "../../../server/shared/roles-by-project/graph";
import type { UiBoardTask } from "../types";
import { Icon, StatePill } from "./icons";
import { deptOf, isOpen, plural, prettyRefs, refLabel, roleName, STATE_KEY } from "./model";
import { elbow, useEdges, type Seg } from "./edges";

const LOOSE_FIRST = 6;
const SUMMARY_MAX = 120;

/** Where a card says it comes from: the role (in a group) or the group (in a role's or a state's list). */
export type CardFrom = { kind: "role" } | { kind: "group"; labelOf: (task: UiBoardTask) => string };

function UnblockNote({ task, byRef }: { task: UiBoardTask; byRef: Map<string, UiBoardTask> }) {
	if (task.state === "needs-you")
		return (
			<p className="rbp-unb u-you">
				<b>Needs your answer: it's at the top</b>
			</p>
		);
	if (task.state === "blocked") {
		const deps = (task.dependsOnRefs ?? []).filter((r) => {
			const d = byRef.get(r);
			return !d || isOpen(d);
		});
		const names = deps.map((r) => prettyRefs(r));
		const title = names.length
			? `Unblocks when ${names.join(" and ")} ${names.length === 1 ? "finishes" : "finish"}`
			: "Blocked";
		const body = prettyRefs(task.howToUnblock ?? "");
		const sentence = (text: string) => text.replace(/\s+/g, " ").trim().replace(/\.$/, "");
		return (
			<p className="rbp-unb u-blk">
				<b>{title}</b>
				{body && sentence(body) !== sentence(title) && <span>{body}</span>}
			</p>
		);
	}
	if (task.state === "waiting") {
		const asking = task.status === "asking";
		return (
			<p className="rbp-unb u-wt">
				<b>{asking ? "Waits for its lead to answer" : "Carries on by itself when this is done"}</b>
				{(asking ? task.stuck?.question : task.howToUnblock) && (
					<span>{prettyRefs((asking ? task.stuck?.question : task.howToUnblock) ?? "")}</span>
				)}
			</p>
		);
	}
	return null;
}

export function TaskCard({
	task,
	byRef,
	from,
	order,
	holds,
	drawn = false,
}: {
	task: UiBoardTask;
	byRef: Map<string, UiBoardTask>;
	from: CardFrom;
	order?: number;
	holds?: number;
	/** On a drawn chain: links to tasks of this map are arrows already, so "After" names only the others. */
	drawn?: boolean;
}) {
	const done = task.state === "done";
	const summary = done && task.doneSummary ? task.doneSummary.slice(0, SUMMARY_MAX) : "";
	const after =
		task.state === "queued"
			? (task.dependsOnRefs ?? []).filter((r) => byRef.get(r)?.state !== "done" && !(drawn && byRef.has(r)))
			: [];
	return (
		<article
			className={`rbp-task${done ? " is-done" : ""}${holds ? " is-root" : ""}`}
			data-ref={task.ref}
			aria-label={`${refLabel(task)}: ${task.title}`}
		>
			<div className="rbp-row">
				{order !== undefined && <span className="rbp-ord num">{order}</span>}
				<StatePill state={task.state} />
				<span className="rbp-from" data-dept-role={from.kind === "role" ? deptOf(task.role) : undefined}>
					{from.kind === "role" ? (
						<>
							<span className="rbp-sw" />
							{roleName(task.role)}
						</>
					) : (
						from.labelOf(task)
					)}
				</span>
				<span className="rbp-id num">#{task.id}</span>
			</div>
			<h4 title={task.title}>{task.title}</h4>
			{!!holds && <span className="rbp-holdnote">{plural(holds, "task")} wait on this one</span>}
			<UnblockNote task={task} byRef={byRef} />
			{after.length > 0 && <p className="rbp-after">After {after.map(prettyRefs).join(", ")}</p>}
			{summary && <p className="rbp-after">{summary}</p>}
		</article>
	);
}

function ChainMap({
	chain,
	map,
	byRef,
	from,
}: {
	chain: string[];
	map: TaskMap;
	byRef: Map<string, UiBoardTask>;
	from: CardFrom;
}) {
	const inChain = new Set(chain);
	const columns = map.layers.map((l) => l.filter((r) => inChain.has(r))).filter((l) => l.length);
	const links = map.edges.filter((e) => inChain.has(e.from) && inChain.has(e.to));
	const holds = new Map(map.roots.filter((r) => inChain.has(r.ref)).map((r) => [r.ref, r.waiting]));
	const key = chain.map((r) => `${r}:${byRef.get(r)?.state}`).join("|") + links.map((e) => e.kind).join("");
	const { dag, layer } = useEdges(links, key);
	const rows = chain.map((r) => byRef.get(r)).filter((t): t is UiBoardTask => !!t);
	const open = rows.filter(isOpen).length;
	const top = map.roots.find((r) => inChain.has(r.ref));
	const loop = map.cycles.filter((c) => c.some((r) => inChain.has(r)));
	return (
		<section>
			<p className="rbp-sec">
				<span>{plural(chain.length, "linked task")}</span>
				<span>·</span>
				<span>
					{open} open, {chain.length - open} done
				</span>
				{top && (
					<>
						<span>·</span>
						<b>
							{prettyRefs(top.ref)} holds {top.waiting}
						</b>
					</>
				)}
				{loop.map((c) => (
					<span key={c.join()} className="rbp-held">
						Waits in a loop: {c.map(prettyRefs).join(", ")}
					</span>
				))}
			</p>
			<div className="rbp-dag" ref={dag}>
				{layer}
				{columns.map((col, i) => (
					<div className="rbp-col" key={i}>
						{col.map((ref) => {
							const t = byRef.get(ref);
							return t ? <TaskCard key={ref} task={t} byRef={byRef} from={from} holds={holds.get(ref)} drawn /> : null;
						})}
					</div>
				))}
			</div>
		</section>
	);
}

function LooseList({
	title,
	rows,
	byRef,
	from,
}: {
	title: string;
	rows: UiBoardTask[];
	byRef: Map<string, UiBoardTask>;
	from: CardFrom;
}) {
	const [all, setAll] = useState(false);
	const shown = all ? rows : rows.slice(0, LOOSE_FIRST);
	return (
		<section>
			<p className="rbp-sec">
				{title} · {rows.length}
			</p>
			<div className="rbp-tasks">
				{shown.map((t) => (
					<TaskCard key={t.ref} task={t} byRef={byRef} from={from} />
				))}
			</div>
			{rows.length > shown.length && (
				<button type="button" className="rbp-btn is-more" onClick={() => setAll(true)}>
					Show all {rows.length}
				</button>
			)}
		</section>
	);
}

/** The opened map of one group's rows: every chain, the loose open tasks, then the done ones folded. */
export function OpenedMap({ rows, from }: { rows: readonly UiBoardTask[]; from: CardFrom }) {
	const map = taskMapOf(rows);
	const byRef = new Map(rows.map((t) => [t.ref, t]));
	const loose = map.loose.map((r) => byRef.get(r)).filter((t): t is UiBoardTask => !!t);
	const looseOpen = loose.filter(isOpen);
	const looseDone = loose.filter((t) => !isOpen(t)).sort((a, b) => (b.finishedAt ?? 0) - (a.finishedAt ?? 0));
	return (
		<>
			{map.chains.map((chain) => (
				<ChainMap key={chain[0]} chain={chain} map={map} byRef={byRef} from={from} />
			))}
			{looseOpen.length > 0 && (
				<LooseList
					title={map.chains.length ? "On their own" : "Open tasks"}
					rows={looseOpen}
					byRef={byRef}
					from={from}
				/>
			)}
			{looseDone.length > 0 && (
				<details className="rbp-fold">
					<summary>
						<Icon name="chev" />
						Done in the last 14 days · {looseDone.length}
					</summary>
					<div className="rbp-tasks">
						{looseDone.map((t) => (
							<TaskCard key={t.ref} task={t} byRef={byRef} from={from} />
						))}
					</div>
				</details>
			)}
		</>
	);
}

const PITCH_X = 44;
const PITCH_Y = 16;
const BOX_W = 28;
const BOX_H = 10;
const SQ = 10;
const SQ_PITCH = 14;

/** The closed tile's mini map (miniMapOf): the windowed chain as small boxes, then loose squares. */
export function Thumb({ rows, scale }: { rows: readonly UiBoardTask[]; scale: number }) {
	const map = taskMapOf(rows);
	const mini = miniMapOf(map, rows);
	const byRef = new Map(rows.map((t) => [t.ref, t]));
	const at = new Map<string, { x: number; y: number }>();
	const boxes: { ref: string; x: number; y: number; w: number; h: number }[] = [];
	mini.columns.forEach((col, i) =>
		col.refs.forEach((ref, j) => {
			at.set(ref, { x: i * PITCH_X, y: j * PITCH_Y });
			boxes.push({ ref, x: i * PITCH_X, y: j * PITCH_Y, w: BOX_W, h: BOX_H });
		}),
	);
	const chainW = mini.columns.length ? (mini.columns.length - 1) * PITCH_X + BOX_W : 0;
	// Only the chain's horizontal geometry fits to width; counts stay at the page's readable text size.
	const chainH = Math.max(0, ...mini.columns.map((c) => c.refs.length * PITCH_Y * scale + (c.more ? 18 : 0)));
	const perRow = chainW ? 6 : 14;
	const segs: Seg[] = [];
	for (const e of map.edges) {
		const a = at.get(e.from);
		const b = at.get(e.to);
		// Mini map links stay plain (prototype thumbHtml); edge kinds are drawn on the opened map only.
		if (a && b && b.x > a.x) segs.push(...elbow(a.x + BOX_W, a.y + BOX_H / 2, b.x, b.y + BOX_H / 2, "plain", false));
	}
	if (!boxes.length && !mini.squares.refs.length) return null;
	const s = (n: number) => Math.round(n * scale * 10) / 10;
	const x = (n: number) => `${(n / chainW) * 100}%`;
	const square = (ref: string, style: CSSProperties) => {
		const st = byRef.get(ref)?.state ?? "queued";
		return (
			<i
				key={ref}
				data-mini-ref={ref}
				className={`sq k-${STATE_KEY[st]}${st === "done" ? " f-ok" : ""}`}
				style={style}
			/>
		);
	};
	const open = rows.filter(isOpen).length;
	return (
		<>
			{mini.earlier > 0 && <span className="rbp-cut">+{plural(mini.earlier, "earlier layer")}</span>}
			<span
				className="rbp-thumb"
				role="img"
				aria-label={`Task map: ${plural(boxes.length + mini.squares.refs.length, "task")} shown, ${open} open${mini.columns.map((col, i) => (col.more ? `; ${col.more} more in layer ${i + 1}` : "")).join("")}`}
			>
				{chainW > 0 && (
					<span className="rbp-mini-chain" style={{ width: s(chainW), height: chainH }}>
						{segs.map((g, i) => (
							<i
								key={i}
								className={g.cls}
								style={{ left: x(g.left), top: s(g.top), width: x(g.width), height: s(g.height) }}
							/>
						))}
						{boxes.map((b) => square(b.ref, { left: x(b.x), top: s(b.y), width: x(b.w), height: s(b.h) }))}
						{mini.columns.map(
							(col, i) =>
								col.more > 0 && (
									<span
										key={i}
										className="rbp-cut rbp-layer-more"
										title={`${col.more} more tasks in this layer`}
										style={{ left: x(i * PITCH_X), top: s(col.refs.length * PITCH_Y), width: x(BOX_W) }}
									>
										+{col.more}
									</span>
								),
						)}
					</span>
				)}
				{mini.squares.refs.length > 0 && (
					<span
						className="rbp-mini-loose"
						style={{ width: s(perRow * SQ_PITCH - (SQ_PITCH - SQ)), gap: s(SQ_PITCH - SQ) }}
					>
						{mini.squares.refs.map((ref) => square(ref, { width: s(SQ), height: s(SQ) }))}
					</span>
				)}
			</span>
			{mini.later > 0 && <span className="rbp-cut">+{mini.later} later</span>}
			{mini.squares.more > 0 && <span className="rbp-cut">+{mini.squares.more}</span>}
		</>
	);
}
