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
	/** Per role its files, or null for a role with no such folder; the whole map is null when a walk failed. */
	role_trees: Map<string, OpenVikingMemoryFile[] | null> | null;
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

export class OpenVikingMemoryTreeCache {
	private held: OpenVikingMemoryTree | null = null;
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
	 */
	async read(http: OpenVikingDaemonHttp, nowMs: number): Promise<OpenVikingMemoryTree | null> {
		const held = this.held;
		if (held && nowMs - held.observed_at_ms <= this.cadenceMs) return held;
		const refresh = this.refresh(http, nowMs);
		if (held === null) return refresh;
		return nowMs - held.observed_at_ms <= this.maxServeAgeMs ? held : null;
	}

	/** The one refresh in flight: a request that asks while it runs joins it instead of starting a second walk. */
	private refresh(http: OpenVikingDaemonHttp, nowMs: number): Promise<OpenVikingMemoryTree> {
		if (this.inFlight) return this.inFlight;
		const run = this.walk(http, nowMs)
			.then((tree) => {
				this.held = tree;
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
