/** Approved Project-grouping body only; the disclosure/header, maps and all other cards stay native. */
import type { UiBoardTask } from "../types";
import { Icon, StatePill } from "./icons";
import { plural, refLabel, type BoardContext, type TileModel } from "./model";
import { projectProgressOf } from "./project-progress-state";
import { OpenedMap, Thumb } from "./task-map";

const NOW_PREVIEW = 3;
const QUEUED_PREVIEW = 2;

export function ProjectProgress({
	ctx,
	tile,
	open,
	filtered,
	bodyId,
}: {
	ctx: BoardContext;
	tile: TileModel;
	open: boolean;
	filtered: boolean;
	bodyId: string;
}) {
	const p = projectProgressOf(ctx, tile, filtered);
	const { goals, notice, warning } = p.milestones;
	return (
		<div className={`rpp${open ? " rpp-open" : ""}`}>
			{p.lastKnown && <p className="rpp-warning">Last-known view · current project progress isn't confirmed.</p>}
			{p.queueWarning && <p className="rpp-warning">{p.queueWarning}</p>}
			{p.mismatch && <p className="rpp-warning">Project lifecycle mismatch: board and registry disagree.</p>}
			<div className="rpp-main">
				<section className="rpp-milestones" aria-label="Milestones">
					<h3>
						Milestones{" "}
						{goals && (
							<span className="rpp-fraction">
								<b className="num">
									{goals.met} of {goals.total}
								</b>{" "}
								met
							</span>
						)}
					</h3>
					{notice && <p className={warning ? "rpp-warning" : "rpp-note"}>{notice}</p>}
					{!!goals?.items.length && (
						<>
							<div className="rpp-strip" aria-hidden="true">
								{goals.items.map((it, n) => (
									<i key={n} className={it.met ? "is-met" : undefined} />
								))}
							</div>
							<ol className="rpp-criteria">
								{goals.items.map((it, n) => (
									<li key={n} className={it.met ? "is-met" : undefined}>
										<Icon name={it.met ? "ok" : "q"} />
										<span className="rpp-number num" aria-hidden="true">
											{n + 1}
										</span>
										<span className="rpp-criterion" title={it.item}>
											{it.item}
										</span>
										<span className="rbp-sr">{it.met ? " (met)" : " (not met)"}</span>
									</li>
								))}
							</ol>
						</>
					)}
				</section>
				<div className="rpp-work">
					<section className="rpp-now" aria-label="Now">
						<h3>Now {p.now.length > 0 && <small>{plural(p.now.length, "task")} in progress or held</small>}</h3>
						{p.now.length ? (
							<WorkRows rows={p.now} open={open} limit={NOW_PREVIEW} />
						) : (
							<p className="rpp-note">{p.nowEmpty}</p>
						)}
					</section>
					<section className="rpp-queued" aria-label="Queued work">
						{p.queued.length > 0 ? (
							<>
								<h3>Queued work · no project-wide order recorded</h3>
								<WorkRows rows={p.queued} open={open} limit={QUEUED_PREVIEW} />
							</>
						) : (
							<p className="rpp-note">{p.queuedEmpty}</p>
						)}
					</section>
				</div>
			</div>
			<section className="rpp-activity" aria-label="Recent activity">
				<h3>Recent activity</h3>
				<p>
					<b className="num">{tile.group.done14d}</b> tasks completed · last 14 days
				</p>
				<span className="rpp-lifecycle">Lifecycle: {p.lifecycle ?? "unknown"}</span>
				{!open && <Thumb rows={tile.shown} scale={1.25} />}
			</section>
			{open && (
				<div className="rbp-gbody" id={bodyId}>
					<OpenedMap rows={tile.shown} from={{ kind: "role" }} />
					{tile.shown.length === 0 && <p className="rbp-note">No task of this group is on the board right now.</p>}
				</div>
			)}
		</div>
	);
}

function WorkRows({ rows, open, limit }: { rows: UiBoardTask[]; open: boolean; limit: number }) {
	return (
		<>
			<ul className="rpp-tasks">
				{(open ? rows : rows.slice(0, limit)).map((t) => (
					<li key={t.ref} data-ref={t.ref}>
						<div className="rpp-task-head">
							<StatePill state={t.state} />
							<span>{refLabel(t)}</span>
						</div>
						<p className="rpp-title">{t.title}</p>
						{(t.state === "blocked" || t.state === "waiting") && (
							<p className="rpp-reason rpp-unblock">{t.howToUnblock || "How it unblocks: not recorded."}</p>
						)}
						{t.state === "needs-you" && <p className="rpp-note">Needs your answer: it's at the top</p>}
					</li>
				))}
			</ul>
			{!open && rows.length > limit && (
				<p className="rpp-note">{rows.length - limit} more · open project for all work</p>
			)}
		</>
	);
}
