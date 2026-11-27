/**
 * roles-by-project body by grouping (design.md §First view 5, §Screen States): Project and Department tiles with
 * their quiet and done folds, the Now lanes, the Status tiles, the all-clear panel and the no-results panel.
 */
import {
	departmentTiles,
	isOpen,
	nowLanes,
	plural,
	projectTiles,
	searchKey,
	statusTiles,
	suggestionsOf,
	type BoardContext,
	type GroupBy,
	type TileModel,
} from "./model";
import { Icon } from "./icons";
import { Mini, Tile } from "./tile";
import { CalmPanel, NoResults, NowView, StatusView } from "./views";

function Minis({ ctx, tiles, onOpen }: { ctx: BoardContext; tiles: TileModel[]; onOpen: (key: string) => void }) {
	return (
		<div className="rbp-minis">
			{tiles.map((tile) => (
				<Mini key={tile.group.key} ctx={ctx} tile={tile} onOpen={onOpen} />
			))}
		</div>
	);
}

function Fold({ title, children }: { title: string; children: React.ReactNode }) {
	return (
		<details className="rbp-fold rbp-donefold">
			<summary>
				<Icon name="chev" />
				{title}
			</summary>
			{children}
		</details>
	);
}

export function Body({
	ctx,
	groupBy,
	query,
	opened,
	onToggle,
	onQuery,
}: {
	ctx: BoardContext;
	groupBy: GroupBy;
	query: string;
	opened: ReadonlySet<string>;
	onToggle: (key: string) => void;
	onQuery: (q: string) => void;
}) {
	const key = searchKey(query);
	const noResults = (
		<NoResults query={query} suggestions={suggestionsOf(ctx)} onClear={() => onQuery("")} onSuggest={onQuery} />
	);
	const calm = !key && !ctx.board.tasks.some(isOpen);

	if (groupBy === "now") {
		const lanes = nowLanes(ctx, key);
		if (key && !lanes.length) return noResults;
		return calm ? <CalmPanel /> : <NowView ctx={ctx} lanes={lanes} />;
	}
	if (groupBy === "status") {
		const tiles = statusTiles(ctx, key);
		if (key && !tiles.length) return noResults;
		return (
			<>
				{calm && <CalmPanel />}
				<StatusView ctx={ctx} tiles={tiles} opened={opened} onToggle={onToggle} />
			</>
		);
	}

	const project = groupBy === "project";
	const grouped = project ? projectTiles(ctx, key, opened) : departmentTiles(ctx, key, opened);
	if (key && !grouped.tiles.length) return noResults;
	const open = (k: string) => onToggle(k);
	return (
		<>
			{calm && <CalmPanel />}
			{project &&
				ctx.progress.coherent &&
				!ctx.progress.lastKnown &&
				!ctx.progress.work?.problem &&
				Array.isArray(ctx.progress.work?.projects) &&
				ctx.progress.work.projects.length === 0 && <p className="rbp-note">No recorded projects</p>}
			{grouped.tiles.length > 0 && (
				<div className="rbp-bento">
					{grouped.tiles.map((tile) => (
						<Tile
							key={tile.group.key}
							ctx={ctx}
							tile={tile}
							open={opened.has(tile.group.key)}
							onToggle={onToggle}
							filtered={!!key}
						/>
					))}
				</div>
			)}
			{!key && project && grouped.quiet.length > 0 && (
				<section className="rbp-quiet" aria-labelledby="rbp-quiet-h">
					<h2 className="rbp-sec" id="rbp-quiet-h">
						Nothing open right now · <b>{plural(grouped.quiet.length, "project")}</b>
					</h2>
					<Minis ctx={ctx} tiles={grouped.quiet} onOpen={open} />
				</section>
			)}
			{!key && grouped.done.length > 0 && (
				<Fold
					title={
						project
							? `Done lately · ${plural(grouped.done.length, "project or tag", "projects and tags")}`
							: `Quiet roles · ${grouped.done.length}`
					}
				>
					<Minis ctx={ctx} tiles={grouped.done} onOpen={open} />
				</Fold>
			)}
		</>
	);
}
