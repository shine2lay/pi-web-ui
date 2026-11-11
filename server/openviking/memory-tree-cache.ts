/**
 * OpenViking Memory Dashboard — the store-count walk, held in this server process (Backend #147).
 *
 * One overview used to cost ~85 `:1933` GETs (1 `/health` + 1 `/observer/system` + ~83 `fs/ls`), so a single slow
 * listing could report the whole server down (#144). The walk is now read at the observer cadence and answered
 * from memory in between (~2 GETs warm), with one refresh in flight that every concurrent request shares.
 *
 * In memory only, nothing persisted, no figure invented: a piece the daemon would not give reads `null`
 * (unmeasured, never `0`), and a tree older than `MEMORY_TREE_MAX_SERVE_AGE_MS` is not served at all.
 */
import type { OpenVikingDaemonHttp } from "./daemon-http.js";
import {
	listDir,
	RESOURCES_ROOT_URI,
	SHARED_MEMORIES_ROOT_URI,
	walkMemoryTree,
	walkRoleTrees,
	type OpenVikingMemoryFile,
	type OpenVikingRoleTree,
} from "./memory-tree.js";
import {
	MEMORY_TREE_CADENCE_MS,
	MEMORY_TREE_MAX_SERVE_AGE_MS,
	OPENVIKING_ROLES,
	OpenVikingDashboardError,
} from "./types.js";
import { resolveRequestHeaders } from "./uri.js";

/** One observation of the two-layer store; each piece is null when this walk could not read it. */
export interface OpenVikingMemoryTree {
	/** Folders directly under `viking://resources`. */
	resource_dir_count: number | null;
	shared: OpenVikingMemoryFile[] | null;
	/** Per role its reading (measured, absent or unmeasured); the whole map is null when the walk itself failed. */
	role_trees: Map<string, OpenVikingRoleTree> | null;
	/** Epoch ms the walk started: the tree is no fresher than this. */
	observed_at_ms: number;
}

/** A read the daemon failed leaves its own piece unmeasured (spec-states.md §4); a bug still throws. */
async function unmeasured<T>(p: Promise<T>): Promise<T | null> {
	try {
		return await p;
	} catch (err) {
		if (err instanceof OpenVikingDashboardError) return null;
		throw err;
	}
}

/**
 * A walk that read every piece it set out to read. Only a complete walk replaces the held tree, so a refresh
 * the daemon failed cannot blank counts that are still inside the serve-age bound (Backend #149, #148 row 38).
 */
function isComplete(tree: OpenVikingMemoryTree): boolean {
	if (tree.resource_dir_count === null || tree.shared === null || tree.role_trees === null) return false;
	return [...tree.role_trees.values()].every((reading) => reading.state !== "unmeasured");
}

export class OpenVikingMemoryTreeCache {
	/** The last walk that read everything: what a request is answered with, up to the serve-age bound. */
	private good: OpenVikingMemoryTree | null = null;
	/** The last walk of any completeness: the cadence gate, and the fallback once `good` is past the bound. */
	private latest: OpenVikingMemoryTree | null = null;
	private inFlight: Promise<OpenVikingMemoryTree> | null = null;

	constructor(
		private readonly cadenceMs: number = MEMORY_TREE_CADENCE_MS,
		private readonly maxServeAgeMs: number = MEMORY_TREE_MAX_SERVE_AGE_MS,
	) {}

	/**
	 * The tree to answer with at `nowMs`, or null when none may be served (every store count is then null).
	 *
	 * Inside the cadence it costs no `:1933` call. Past it one refresh runs — shared by every request that asks
	 * while it does. The first walk is awaited (there is nothing to answer with yet); a held tree inside the age
	 * bound answers meanwhile; past the bound nothing is served, because an old count shown as the current one
	 * would be a false figure.
	 *
	 * A refresh the daemon failed changes none of that: it never discards the last good tree, which keeps
	 * answering (stale, inside the bound) while the next cadence retries (Backend #149, #148 row 38).
	 */
	async read(http: OpenVikingDaemonHttp, nowMs: number): Promise<OpenVikingMemoryTree | null> {
		const latest = this.latest;
		const servable = this.servable(nowMs);
		if (latest && nowMs - latest.observed_at_ms <= this.cadenceMs) return servable;
		const refresh = this.refresh(http, nowMs);
		// Nothing has ever been walked in this process: there is nothing to answer with but this walk.
		if (latest === null) return refresh;
		return servable;
	}

	/**
	 * The freshest tree inside the serve-age bound: the last complete walk first, and only when that is past the
	 * bound the last walk of any completeness (its measured pieces are current; its failed ones read null).
	 */
	private servable(nowMs: number): OpenVikingMemoryTree | null {
		const inBound = (tree: OpenVikingMemoryTree | null) =>
			tree !== null && nowMs - tree.observed_at_ms <= this.maxServeAgeMs ? tree : null;
		return inBound(this.good) ?? inBound(this.latest);
	}

	/** The one refresh in flight: a request that asks while it runs joins it instead of starting a second walk. */
	private refresh(http: OpenVikingDaemonHttp, nowMs: number): Promise<OpenVikingMemoryTree> {
		if (this.inFlight) return this.inFlight;
		const run = this.walk(http, nowMs)
			.then((tree) => {
				this.latest = tree;
				if (isComplete(tree)) this.good = tree;
				return tree;
			})
			.finally(() => {
				this.inFlight = null;
			});
		this.inFlight = run;
		// A refresh nobody awaits must not take the process down; a caller that awaits it still sees the failure.
		run.catch(() => {});
		return run;
	}

	private async walk(http: OpenVikingDaemonHttp, startedAtMs: number): Promise<OpenVikingMemoryTree> {
		const headers = resolveRequestHeaders("user");
		const [resources, shared, roleTrees] = await Promise.all([
			unmeasured(listDir(http, RESOURCES_ROOT_URI, headers)),
			unmeasured(walkMemoryTree(http, SHARED_MEMORIES_ROOT_URI, headers)),
			unmeasured(walkRoleTrees(http, OPENVIKING_ROLES)),
		]);
		return {
			resource_dir_count: resources ? resources.filter((i) => i.isDir).length : null,
			shared,
			role_trees: roleTrees,
			observed_at_ms: startedAtMs,
		};
	}
}
