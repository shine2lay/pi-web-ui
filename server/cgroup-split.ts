/**
 * cgroup-split (Ops #628): keep the server's main thread ahead of the commands chats run.
 *
 * Every process a chat starts (bash tool, terminal PTYs, eval sandboxes, test loops, builds)
 * is a child of this server, so it lands in the server's own cgroup and competes with the
 * node main thread on equal terms. 2026-10-28 ~20:30–21:17: several `pytest -n 4` loops in
 * chat terminals took load to ~55 and every page hung on "Loading session"; the unit's
 * CPUWeight=1000 protects the whole cgroup from other services, not the main thread inside it.
 *
 * The fix splits the service in two child cgroups:
 *   <service>/server  the node process alone, cpu.weight 10000
 *   <service>/tools   every other process, cpu.weight 100
 * systemd (>= 254) starts the main process in `server/` itself when the unit has
 * `Delegate=yes` and `DelegateSubgroup=server`. This module then creates `tools/`, turns the
 * cpu controller on for the children, sets both weights, and every second moves any process
 * other than the server out of `server/` into `tools/` (a child starts where its parent is).
 * Writing a pid to cgroup.procs moves the whole process with its threads.
 *
 * It only acts when that layout is there (/proc/self/cgroup ends in /server and the files are
 * writable). Anywhere else (dev runs, sealed tests, other machines, an old unit) it does nothing
 * but log one line. A pid that can't be moved (already gone, permission) is skipped; a setup
 * failure logs one line and the server runs on as before. PI_WEB_CGROUP_SPLIT=0 turns it off.
 */
import fs from "node:fs";
import path from "node:path";

export const SERVER_GROUP = "server";
export const TOOLS_GROUP = "tools";
/** The server's share against the chats' commands: 10000 : 100. Kernel range is 1..10000. */
export const SERVER_CPU_WEIGHT = 10000;
export const TOOLS_CPU_WEIGHT = 100;
export const MOVE_INTERVAL_MS = 1000;

export interface CgroupFs {
	readFile(file: string): string;
	writeFile(file: string, data: string): void;
	mkdir(dir: string): void;
	exists(file: string): boolean;
	writable(file: string): boolean;
}

export const realCgroupFs: CgroupFs = {
	readFile: (file) => fs.readFileSync(file, "utf8"),
	writeFile: (file, data) => fs.writeFileSync(file, data),
	mkdir: (dir) => fs.mkdirSync(dir),
	exists: (file) => fs.existsSync(file),
	writable: (file) => {
		try {
			fs.accessSync(file, fs.constants.W_OK);
			return true;
		} catch {
			return false;
		}
	},
};

export interface CgroupLayout {
	serviceDir: string;
	serverDir: string;
	toolsDir: string;
}

export type Detection = { ok: true; layout: CgroupLayout } | { ok: false; reason: string };

/** The cgroup v2 path of this process ("0::/a/b/server" → "/a/b/server"), or null. */
export function unifiedCgroupPath(procSelfCgroup: string): string | null {
	for (const line of procSelfCgroup.split("\n")) {
		if (line.startsWith("0::")) return line.slice(3).trim() || null;
	}
	return null;
}

/** Is the delegated layout there? Reads only; changes nothing. */
export function detectCgroupSplit(cfs: CgroupFs, opts: { procSelfCgroup: string; cgroupRoot?: string }): Detection {
	const rel = unifiedCgroupPath(opts.procSelfCgroup);
	if (!rel) return { ok: false, reason: "no cgroup v2 path in /proc/self/cgroup" };
	if (path.posix.basename(rel) !== SERVER_GROUP)
		return {
			ok: false,
			reason: `not started in a "${SERVER_GROUP}" subgroup (${rel}); the unit needs Delegate=yes and DelegateSubgroup=${SERVER_GROUP}`,
		};
	const serverDir = path.join(opts.cgroupRoot ?? "/sys/fs/cgroup", rel);
	const serviceDir = path.dirname(serverDir);
	const toolsDir = path.join(serviceDir, TOOLS_GROUP);
	let controllers = "";
	try {
		controllers = cfs.readFile(path.join(serviceDir, "cgroup.controllers"));
	} catch {
		return { ok: false, reason: `can't read ${serviceDir}/cgroup.controllers` };
	}
	if (!controllers.split(/\s+/).includes("cpu")) return { ok: false, reason: `no cpu controller in ${serviceDir}` };
	for (const file of [path.join(serviceDir, "cgroup.subtree_control"), path.join(serverDir, "cgroup.procs")]) {
		if (!cfs.writable(file)) return { ok: false, reason: `${file} isn't writable (not delegated)` };
	}
	return { ok: true, layout: { serviceDir, serverDir, toolsDir } };
}

/** Create tools/, turn the cpu controller on for both children, set the weights. Throws on failure. */
export function setupCgroupSplit(cfs: CgroupFs, layout: CgroupLayout): void {
	if (!cfs.exists(layout.toolsDir)) cfs.mkdir(layout.toolsDir);
	const subtree = cfs.readFile(path.join(layout.serviceDir, "cgroup.subtree_control"));
	if (!subtree.split(/\s+/).includes("cpu"))
		cfs.writeFile(path.join(layout.serviceDir, "cgroup.subtree_control"), "+cpu");
	cfs.writeFile(path.join(layout.serverDir, "cpu.weight"), String(SERVER_CPU_WEIGHT));
	cfs.writeFile(path.join(layout.toolsDir, "cpu.weight"), String(TOOLS_CPU_WEIGHT));
}

export interface MoveResult {
	moved: number;
	/** Pids that couldn't be moved this round (gone already, permission, …): skipped. */
	skipped: number;
}

/** Move every process in server/ except mainPid into tools/. Never throws for one pid. */
export function moveStrayProcesses(cfs: CgroupFs, layout: CgroupLayout, mainPid: number): MoveResult {
	const out: MoveResult = { moved: 0, skipped: 0 };
	const text = cfs.readFile(path.join(layout.serverDir, "cgroup.procs"));
	const target = path.join(layout.toolsDir, "cgroup.procs");
	for (const word of text.split(/\s+/)) {
		const pid = Number(word);
		if (!word || !Number.isInteger(pid) || pid <= 0 || pid === mainPid) continue;
		try {
			cfs.writeFile(target, String(pid));
			out.moved++;
		} catch {
			out.skipped++;
		}
	}
	return out;
}

export interface CgroupSplitStats {
	active: boolean;
	/** Why it isn't active (null when it is). */
	reason: string | null;
	moved: number;
	skipped: number;
	/** Rounds where reading server/cgroup.procs itself failed. */
	failedRounds: number;
}

export interface CgroupSplitHandle {
	stats(): CgroupSplitStats;
	/** One round now (tests; also run by the timer). */
	tick(): void;
	stop(): void;
}

export interface StartOptions {
	cfs?: CgroupFs;
	procSelfCgroup?: string;
	cgroupRoot?: string;
	mainPid?: number;
	env?: NodeJS.ProcessEnv;
	log?: (line: string) => void;
	intervalMs?: number;
	/** false: don't start the timer (tests call tick()). */
	timer?: boolean;
}

const STATS_KEY = Symbol.for("pi-web-ui.cgroup-split.v1");

/** Detect, set up and start the mover. Never throws; logs one line about what it did. */
export function startCgroupSplit(opts: StartOptions = {}): CgroupSplitHandle {
	const cfs = opts.cfs ?? realCgroupFs;
	const log = opts.log ?? ((line: string) => console.log(line));
	const env = opts.env ?? process.env;
	const mainPid = opts.mainPid ?? process.pid;
	const stats: CgroupSplitStats = { active: false, reason: null, moved: 0, skipped: 0, failedRounds: 0 };
	(globalThis as Record<symbol, unknown>)[STATS_KEY] = stats;
	let timer: NodeJS.Timeout | null = null;
	let layout: CgroupLayout | null = null;
	const inactive = (reason: string): CgroupSplitHandle => {
		stats.reason = reason;
		log(`[cgroup-split] off: ${reason}`);
		return { stats: () => ({ ...stats }), tick: () => {}, stop: () => {} };
	};
	if (env.PI_WEB_CGROUP_SPLIT === "0") return inactive("PI_WEB_CGROUP_SPLIT=0");
	let procSelfCgroup = opts.procSelfCgroup;
	if (procSelfCgroup === undefined) {
		try {
			procSelfCgroup = fs.readFileSync("/proc/self/cgroup", "utf8");
		} catch {
			return inactive("no /proc/self/cgroup (not Linux)");
		}
	}
	const found = detectCgroupSplit(cfs, { procSelfCgroup, cgroupRoot: opts.cgroupRoot });
	if (!found.ok) return inactive(found.reason);
	try {
		setupCgroupSplit(cfs, found.layout);
	} catch (err) {
		return inactive(`setup failed, running as before: ${(err as Error)?.message ?? err}`);
	}
	layout = found.layout;
	stats.active = true;
	const tick = () => {
		if (!layout) return;
		try {
			const r = moveStrayProcesses(cfs, layout, mainPid);
			stats.moved += r.moved;
			stats.skipped += r.skipped;
		} catch {
			stats.failedRounds++;
		}
	};
	tick();
	log(
		`[cgroup-split] on: server ${found.layout.serverDir} (cpu.weight ${SERVER_CPU_WEIGHT}), chats' commands → ${found.layout.toolsDir} (cpu.weight ${TOOLS_CPU_WEIGHT}), checked every ${opts.intervalMs ?? MOVE_INTERVAL_MS} ms`,
	);
	if (opts.timer !== false) {
		timer = setInterval(tick, opts.intervalMs ?? MOVE_INTERVAL_MS);
		timer.unref?.();
	}
	return {
		stats: () => ({ ...stats }),
		tick,
		stop: () => {
			if (timer) clearInterval(timer);
			timer = null;
			layout = null;
		},
	};
}

/** The running server's stats (null before startCgroupSplit ran). */
export function cgroupSplitStats(): CgroupSplitStats | null {
	const s = (globalThis as Record<symbol, unknown>)[STATS_KEY] as CgroupSplitStats | undefined;
	return s ? { ...s } : null;
}
