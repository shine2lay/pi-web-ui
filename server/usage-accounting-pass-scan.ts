/** Worker-only, stat-only, bounded and resumable session inventory. No usage/content reads, discovery outside roots,
 * timer, main-thread service import or deletion. Same-UID check-then-use windows remain (see the week-store scope). */
import { lstatSync, opendirSync, realpathSync, statSync, type Dir, type Stats } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { isMainThread } from "node:worker_threads";
import { usageWeekBounds } from "./usage-accounting-week-store.js";
/** files: PLAN 5.1's cap a week (1.7x E2); stats: Architecture S1's per-pass slice of a resumable walk. */
export const PASS_SCAN_LIMITS = Object.freeze({ files: 4096, stats: 65_536 });
export interface PassFile {
	key: string;
	file: string;
	size: number;
	mtimeMs: number;
	dev: number;
	ino: number;
	/** Last complete inventory cycle in which this path was observed. */
	seen: number;
}
export interface PassInventory {
	week: string;
	files: Map<string, PassFile>;
	complete: boolean;
	through: string | null;
	fileCap: boolean;
	faults: Set<"unsafe-source" | "unreadable-directory" | "file-cap" | "missing-source">;
	stats: number;
	cycle: number;
	/** Worker-private live directory handles, never serialized or posted to the host. */
	walk: {
		stack: { dir: Dir; path: string }[];
		roots: string[];
		check: { root: string; path: string } | null;
		startedAt: string;
		inodes: Set<string>;
		/** Directories already opened in this walk (dev:ino), so a bind-mount loop is walked once. */
		dirs: Set<string>;
	} | null;
}
export const passFileKey = (file: string): string =>
	createHash("sha256").update(resolve(file)).digest("hex").slice(0, 16);
export function newPassInventory(week: string): PassInventory {
	usageWeekBounds(week);
	return {
		week,
		files: new Map(),
		complete: false,
		through: null,
		fileCap: false,
		faults: new Set(),
		stats: 0,
		cycle: 0,
		walk: null,
	};
}
export function closePassInventory(s: PassInventory): void {
	for (const frame of s.walk?.stack ?? []) {
		try {
			frame.dir.closeSync();
		} catch {
			/* already closed */
		}
	}
	s.walk = null;
}
const under = (file: string, root: string) => file === root || file.startsWith(root + sep);
const owned = (s: Stats): boolean => process.getuid !== undefined && s.uid === process.getuid() && !s.isSymbolicLink();
/** A configuration error, never a store fault: its code names it in a pass's lastError (Architecture #281 N1). */
const inventoryInput = (): Error =>
	Object.assign(new Error("usage-pass-inventory-input"), { code: "usage-pass-inventory-input" });
/**
 * The roots, checked once when the pass state opens (Architecture #281 N1, N5), so a wrong root is refused by name
 * before the week store is opened: nothing is written and no week is replayed. Every root is an absolute, normalised
 * path to an existing directory. A session root must be its own real path: the walk never follows a symlink, so a root
 * reached through one could only ever give a partial inventory. A Temper root is resolved to its real path, the one the
 * walk meets, so a Temper root spelled through a symlink is still excluded (no double count with T0), and a session
 * root at or inside a Temper root's real path is refused. dev:ino matching is not needed: no bind mount sits under the
 * roots on this machine (Ops #540, /proc/self/mountinfo). Same-UID check-then-use windows remain: the walk still
 * lstats every ancestor of a session root on each cycle.
 */
export function checkPassRoots(
	roots: readonly string[],
	temperRoots: readonly string[],
): { roots: readonly string[]; temperRoots: readonly string[] } {
	const real = (p: unknown): string => {
		if (typeof p !== "string" || !isAbsolute(p) || resolve(p) !== p) throw inventoryInput();
		try {
			const r = realpathSync(p);
			if (statSync(r).isDirectory()) return r;
		} catch {
			/* missing or unreadable: refused below */
		}
		throw inventoryInput();
	};
	const sessions = roots.map((p) => {
		if (real(p) !== p) throw inventoryInput();
		return p;
	});
	const temper = [...new Set(temperRoots.map(real))];
	if (sessions.some((root) => temper.some((r) => under(root, r)))) throw inventoryInput();
	return { roots: Object.freeze(sessions), temperRoots: Object.freeze(temper) };
}
/** One bounded scan unit; `stop` includes the pass work deadline. The full walk may span passes. The file cap is
 * cumulative within the week, not just the count in one page. Root ownership exclusions are native inputs, never
 * inferred from filenames/titles; Temper roots are compared as given, so the pass hands in checkPassRoots' real paths.
 * stat and opendir are synchronous deliberately: the Worker owns heavy I/O. */
export function scanPassInventory(
	s: PassInventory,
	options: {
		roots: readonly string[];
		temperRoots: readonly string[];
		asOf: string;
		stats?: number;
		files?: number;
		stop?: () => boolean;
	},
): { stats: number; finished: boolean } {
	if (isMainThread) throw new Error("usage-pass-worker-required");
	const cap = options.files ?? PASS_SCAN_LIMITS.files,
		budget = options.stats ?? PASS_SCAN_LIMITS.stats;
	if (
		![cap, budget].every((v) => Number.isSafeInteger(v) && v > 0) ||
		cap > PASS_SCAN_LIMITS.files ||
		budget > PASS_SCAN_LIMITS.stats ||
		[...options.roots, ...options.temperRoots].some((p) => !isAbsolute(p) || resolve(p) !== p) ||
		// A session root at or inside a Temper root would scan to a healthy-looking zero: a misconfiguration, refused
		// here (Architecture #277 S2). A Temper root inside a session root is the normal case and is skipped below.
		options.roots.some((root) => options.temperRoots.some((r) => under(root, r)))
	)
		throw inventoryInput();
	const bounds = usageWeekBounds(s.week);
	const from = Date.parse(bounds.start),
		through = Date.parse(bounds.end) - 1;
	if (!Number.isFinite(Date.parse(options.asOf)) || Date.parse(options.asOf) < from)
		throw new Error("usage-pass-inventory-time");
	if (!s.walk) {
		s.cycle++;
		s.complete = false;
		s.faults.clear();
		s.fileCap = false;
		s.walk = {
			stack: [],
			roots: [...new Set(options.roots)].sort().reverse(),
			check: null,
			startedAt: options.asOf,
			inodes: new Set(),
			dirs: new Set(),
		};
	}
	const walk = s.walk;
	let stats = 0;
	const open = (path: string): void => {
		try {
			walk.stack.push({ path, dir: opendirSync(path) });
		} catch {
			s.faults.add("unreadable-directory");
		}
	};
	while (stats < budget && !options.stop?.()) {
		if (!walk.stack.length) {
			if (walk.check) {
				const { root, path } = walk.check;
				stats++;
				try {
					const st = lstatSync(path);
					if (st.isSymbolicLink() || !st.isDirectory() || (path === root && !owned(st))) {
						s.faults.add("unsafe-source");
						walk.check = null;
					} else if (dirname(path) === path) {
						walk.check = null;
						open(root);
					} else walk.check.path = dirname(path);
				} catch {
					s.faults.add("unreadable-directory");
					walk.check = null;
				}
				continue;
			}
			const root = walk.roots.pop();
			if (!root) {
				for (const f of s.files.values()) if (f.seen !== s.cycle) s.faults.add("missing-source");
				s.complete = s.faults.size === 0;
				s.through = walk.startedAt;
				s.stats += stats;
				closePassInventory(s);
				return { stats, finished: true };
			}
			walk.check = { root, path: root };
			continue;
		}
		const frame = walk.stack[walk.stack.length - 1];
		let entry;
		try {
			entry = frame.dir.readSync();
		} catch {
			s.faults.add("unreadable-directory");
			try {
				frame.dir.closeSync();
			} catch {
				/* no handle */
			}
			walk.stack.pop();
			continue;
		}
		if (!entry) {
			frame.dir.closeSync();
			walk.stack.pop();
			continue;
		}
		const file = join(frame.path, entry.name);
		// An excluded directory is never opened, and excluded files are never inspected for payload or usage.
		if (options.temperRoots.some((r) => under(file, r))) continue;
		stats++;
		let st: Stats;
		try {
			st = lstatSync(file);
		} catch {
			s.faults.add("unreadable-directory");
			continue;
		}
		if (!owned(st)) {
			s.faults.add("unsafe-source");
			continue;
		}
		if (st.isDirectory()) {
			const dir = `${st.dev}:${st.ino}`;
			if (!walk.dirs.has(dir)) {
				walk.dirs.add(dir);
				open(file);
			}
			continue;
		}
		if (!file.endsWith(".jsonl")) continue;
		if (!st.isFile() || st.nlink !== 1 || !Number.isSafeInteger(st.size)) {
			s.faults.add("unsafe-source");
			continue;
		}
		const key = passFileKey(file),
			old = s.files.get(key);
		if (!old && (st.mtimeMs < from || st.mtimeMs > through)) continue;
		if (old && old.file !== file) {
			s.faults.add("unsafe-source");
			continue;
		} // digest collision, fail closed
		const inode = `${st.dev}:${st.ino}`;
		if (walk.inodes.has(inode)) continue;
		if (!old && s.files.size >= cap) {
			s.fileCap = true;
			s.faults.add("file-cap");
			continue;
		}
		walk.inodes.add(inode);
		s.files.set(key, { key, file, size: st.size, mtimeMs: st.mtimeMs, dev: st.dev, ino: st.ino, seen: s.cycle });
	}
	s.stats += stats;
	return { stats, finished: false };
}
