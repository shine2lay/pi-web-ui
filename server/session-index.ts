/**
 * session-index: one saved, server-wide index of the chat files, so History and Recent chats appear
 * right away — also right after a restart — instead of every window re-reading every transcript.
 *
 * Why: pi's `SessionManager.listAll` reads every transcript in full on every call (59 files, 1.4 GB:
 * 5.8 s in a quiet process), builds every chat's full text for search on the way, and every window
 * called it for itself (twice, with the projects list), all at once after a restart.
 *
 * What it keeps per transcript: dev/inode, size and mtime as last seen, how far it has been read (always
 * the start of a line), a fingerprint of the bytes there, and the fields the listing needs, folded line by
 * line exactly as pi's `buildSessionInfo` folds them (server/session-index-worker.ts) — no full text.
 *
 * On each listing it walks the session folders (readdir + stat only):
 *  - unchanged files (same dev, inode, size and mtime) come from the index;
 *  - files that grew are read from where the last read stopped (transcripts are append-only);
 *  - files that shrank, were replaced (new inode) or rewritten in place (the fingerprint changed) are read
 *    again from the start; removed files are dropped.
 * Reading happens in worker threads, so a giant line never blocks the server. Listings that come in while
 * one runs join it (single-flight); `invalidate()` makes the next listing start a fresh walk.
 *
 * Saved to `<dataDir>/session-index.json` (versioned, written atomically, a few seconds after a change).
 * It's a cache: a missing, broken or old-version file only means one read from the start.
 *
 * The rows are the ones `SessionManager.listAll(dir)` / `SessionManager.list(cwd, dir)` return, in the same
 * order, except `allMessagesText` (always ""): global search keeps reading the full text through pi.
 */
import { existsSync, type Stats } from "node:fs";
import { mkdir, readdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { availableParallelism, homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { getAgentDir, SessionManager, type SessionInfo } from "@earendil-works/pi-coding-agent";
import {
	FOLD_VERSION,
	type Fingerprint,
	type Fold,
	type ScanResult,
	type ScanTask,
	scanTranscriptRange,
	WORKER_MARK,
} from "./session-index-worker.js";

/** Bump when the saved file's layout changes. */
const SAVE_VERSION = 1;
/** Wait this long after a change before saving (changes in a burst are saved once). */
const SAVE_DELAY_MS = 2000;
/** Workers left idle this long are stopped (the next read starts them again). */
const WORKER_IDLE_MS = 30_000;

/** A `custom` entry type the index follows (the last one with an id wins), e.g. the chat's identity. */
export interface CustomFollow {
	customType: string;
	/** The entry's id: null = cleared; undefined = not one (it doesn't count). */
	idOf(entry: { type: "custom"; customType: string; data: unknown }): string | null | undefined;
}

export interface SessionIndexOptions {
	/** Where the index is saved; none = memory only. */
	file?: string;
	/** Worker threads for reading (0 = read in-process). Default: up to 4. */
	workers?: number;
	identity?: CustomFollow;
}

export interface SessionIndexStats {
	/** Folder walks (listings that didn't join a running one). */
	refreshes: number;
	/** Listings that joined a running walk. */
	joined: number;
	/** Files read from the start. */
	fullReads: number;
	/** Files read from where the last read stopped. */
	partialReads: number;
	/** Files served from the index without reading. */
	unchanged: number;
	bytesRead: number;
	/** Entries taken from the saved file at start. */
	loadedFromDisk: number;
	/** The saved file was there but unusable (broken, other version): rebuilt. */
	rejectedSaves: number;
}

interface Entry {
	dev: number;
	ino: number;
	size: number;
	mtimeMs: number;
	/** Bytes folded into `committed` (the start of the next line). */
	offset: number;
	fp: Fingerprint;
	committed: Fold;
	/** With the unfinished last line folded in (null = the file ends with a newline). */
	view: Fold | null;
	/** The followed custom entry's last id among the complete lines (undefined = none). */
	identity: string | null | undefined;
}

type Cand = { path: string; st: Stats };

const zeroStats = (): SessionIndexStats => ({
	refreshes: 0,
	joined: 0,
	fullReads: 0,
	partialReads: 0,
	unchanged: 0,
	bytesRead: 0,
	loadedFromDisk: 0,
	rejectedSaves: 0,
});

// ---------------------------------------------------------------------------
// pi's path rules (utils/paths.js normalizePath/resolvePath, session-manager.js getDefaultSessionDirPath)
// ---------------------------------------------------------------------------

function piNormalizePath(input: string): string {
	if (input === "~") return homedir();
	if (input.startsWith("~/")) return join(homedir(), input.slice(2));
	if (input.startsWith("file://")) return fileURLToPath(input);
	return input;
}

function piResolvePath(input: string, base: string = process.cwd()): string {
	const normalized = piNormalizePath(input);
	return isAbsolute(normalized) ? resolve(normalized) : resolve(piNormalizePath(base), normalized);
}

/** pi's default session folder for a cwd (without creating it). */
export function defaultSessionDirPath(cwd: string): string {
	const resolvedCwd = piResolvePath(cwd);
	const safePath = `--${resolvedCwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
	return join(piResolvePath(getAgentDir()), "sessions", safePath);
}

/** pi's getSessionsDir(). */
function sessionsDir(): string {
	return join(getAgentDir(), "sessions");
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R> | R): Promise<R[]> {
	const out = new Array<R>(items.length);
	let next = 0;
	const run = async () => {
		while (next < items.length) {
			const i = next++;
			out[i] = await fn(items[i]);
		}
	};
	await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
	return out;
}

/** The SessionInfo pi's buildSessionInfo returns for this fold (null = left out). */
function toInfo(path: string, e: Entry, st: Stats): SessionInfo | null {
	const f = e.view ?? e.committed;
	if (f.bad || !f.header) return null;
	const h = f.header;
	const cwd = typeof h.cwd === "string" ? h.cwd : "";
	const headerTime = typeof h.timestamp === "string" ? new Date(h.timestamp).getTime() : NaN;
	const modified =
		typeof f.lastActivity === "number" && f.lastActivity > 0
			? new Date(f.lastActivity)
			: !Number.isNaN(headerTime)
				? new Date(headerTime)
				: st.mtime;
	return {
		path,
		id: h.id as string,
		cwd,
		name: f.name,
		parentSessionPath: h.parentSession as string | undefined,
		created: new Date(h.timestamp as string),
		modified,
		messageCount: f.messageCount,
		firstMessage: f.firstMessage || "(no messages)",
		allMessagesText: "",
	};
}

/** pi's sortSessionInfos: newest first, stable. */
function sortInfos(infos: SessionInfo[]): SessionInfo[] {
	return infos.sort((a, b) => b.modified.getTime() - a.modified.getTime());
}

// ---------------------------------------------------------------------------
// Saved file
// ---------------------------------------------------------------------------

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

function parseFold(v: unknown): Fold | null {
	if (!isObj(v)) return null;
	if (typeof v.bad !== "boolean" || !Number.isInteger(v.messageCount) || typeof v.firstMessage !== "string")
		return null;
	if (v.header !== null && !isObj(v.header)) return null;
	if (v.name !== undefined && typeof v.name !== "string") return null;
	if (v.lastActivity !== undefined && !isNum(v.lastActivity)) return null;
	const h = v.header as Record<string, unknown> | null;
	return {
		header: h ? { id: h.id, cwd: h.cwd, parentSession: h.parentSession, timestamp: h.timestamp } : null,
		bad: v.bad,
		name: v.name as string | undefined,
		messageCount: v.messageCount as number,
		firstMessage: v.firstMessage,
		lastActivity: v.lastActivity as number | undefined,
	};
}

function parseEntry(v: unknown): Entry | null {
	if (!isObj(v)) return null;
	const { dev, ino, size, mtimeMs, offset, fp } = v;
	if (!isNum(dev) || !isNum(ino) || !isNum(size) || !isNum(mtimeMs) || !isNum(offset) || offset > size || offset < 0) {
		return null;
	}
	if (
		!isObj(fp) ||
		!isNum(fp.headLen) ||
		!isNum(fp.tailLen) ||
		typeof fp.head !== "string" ||
		typeof fp.tail !== "string"
	) {
		return null;
	}
	const committed = parseFold(v.committed);
	if (!committed) return null;
	const view = v.view == null ? null : parseFold(v.view);
	if (v.view != null && !view) return null;
	const identity = v.identity;
	if (identity !== undefined && identity !== null && typeof identity !== "string") return null;
	return {
		dev,
		ino,
		size,
		mtimeMs,
		offset,
		fp: { headLen: fp.headLen, head: fp.head, tailLen: fp.tailLen, tail: fp.tail },
		committed,
		view,
		identity: identity as string | null | undefined,
	};
}

// ---------------------------------------------------------------------------
// Worker pool
// ---------------------------------------------------------------------------

type Job = { task: ScanTask; resolve: (r: ScanResult) => void; reject: (e: unknown) => void };

function workerUrl(): URL {
	// vitest runs the .ts sources (node strips the types in the worker); the build ships .js.
	const here = import.meta.url;
	return new URL(here.endsWith(".ts") ? "./session-index-worker.ts" : "./session-index-worker.js", here);
}

class ScanPool {
	private readonly all = new Set<Worker>();
	private idle: Worker[] = [];
	private readonly running = new Map<Worker, Job>();
	private queue: Job[] = [];
	private failures = 0;
	private broken = false;
	private idleTimer: NodeJS.Timeout | null = null;

	constructor(private readonly size: number) {}

	run(task: ScanTask): Promise<ScanResult> {
		if (this.broken || this.size <= 0) return scanTranscriptRange(task);
		return new Promise<ScanResult>((resolveJob, rejectJob) => {
			this.queue.push({ task, resolve: resolveJob, reject: rejectJob });
			this.pump();
		});
	}

	private pump(): void {
		if (this.idleTimer) {
			clearTimeout(this.idleTimer);
			this.idleTimer = null;
		}
		while (this.queue.length > 0) {
			let w = this.idle.pop();
			if (!w) {
				if (this.all.size >= this.size) return;
				w = this.spawn();
				if (!w) {
					// Workers can't start here: read in-process from now on.
					for (const job of this.queue.splice(0)) scanTranscriptRange(job.task).then(job.resolve, job.reject);
					return;
				}
			}
			const job = this.queue.shift()!;
			this.running.set(w, job);
			w.ref();
			w.postMessage({ id: 0, task: job.task });
		}
		if (this.running.size === 0 && this.all.size > 0) {
			this.idleTimer = setTimeout(() => this.stopAll(), WORKER_IDLE_MS);
			this.idleTimer.unref();
		}
	}

	private spawn(): Worker | undefined {
		let w: Worker;
		try {
			w = new Worker(workerUrl(), { workerData: { kind: WORKER_MARK }, execArgv: [] });
		} catch {
			this.broken = true;
			return undefined;
		}
		w.unref();
		w.on("message", (msg: { result?: ScanResult; error?: string }) => {
			const job = this.running.get(w);
			this.running.delete(w);
			w.unref();
			this.idle.push(w);
			if (job) {
				if (msg.error !== undefined) job.reject(new Error(msg.error));
				else job.resolve(msg.result!);
			}
			this.pump();
		});
		w.on("error", () => this.lost(w));
		w.on("exit", () => this.lost(w));
		this.all.add(w);
		return w;
	}

	/** A worker died (couldn't start, or a file broke it): its job is read in-process instead. */
	private lost(w: Worker): void {
		if (!this.all.delete(w)) return;
		this.idle = this.idle.filter((x) => x !== w);
		const job = this.running.get(w);
		this.running.delete(w);
		if (job) {
			if (++this.failures >= 3) this.broken = true;
			scanTranscriptRange(job.task).then(job.resolve, job.reject);
		}
		this.pump();
	}

	private stopAll(): void {
		this.idleTimer = null;
		if (this.running.size > 0 || this.queue.length > 0) return;
		for (const w of this.all) {
			this.all.delete(w);
			void w.terminate();
		}
		this.idle = [];
	}
}

// ---------------------------------------------------------------------------
// The index
// ---------------------------------------------------------------------------

export class SessionIndex {
	readonly stats: SessionIndexStats = zeroStats();
	private file: string | undefined;
	private identity: CustomFollow | undefined;
	private readonly entries = new Map<string, Entry>();
	private loading: Promise<void> | null = null;
	/** Bumped by invalidate(): a listing asked for after it doesn't join an older walk. */
	private gen = 0;
	private readonly flights = new Map<string, { gen: number; p: Promise<SessionInfo[]> }>();
	private readonly reads = new Map<string, Promise<Entry | null>>();
	private readonly pool: ScanPool;
	private dirty = false;
	private saveTimer: NodeJS.Timeout | null = null;
	private saving: Promise<void> | null = null;
	private saveWarned = false;
	private announced = false;

	constructor(opts: SessionIndexOptions = {}) {
		this.file = opts.file;
		this.identity = opts.identity;
		const workers = opts.workers ?? Math.max(1, Math.min(4, availableParallelism() - 1));
		this.pool = new ScanPool(workers);
	}

	/** Set where the index is saved and which custom entry it follows. Takes effect before the first listing. */
	configure(opts: { file?: string; identity?: CustomFollow }): void {
		if (this.loading) return;
		if (opts.file !== undefined) this.file = opts.file;
		if (opts.identity !== undefined) this.identity = opts.identity;
	}

	/** Disk changed under a listing (a chat deleted or created): the next listing walks the folders again. */
	invalidate(): void {
		this.gen++;
	}

	/** Same rows and order as `SessionManager.listAll(customRoot)` (allMessagesText left empty). */
	async listAll(customRoot?: string): Promise<SessionInfo[]> {
		if (process.platform === "win32") return SessionManager.listAll(customRoot);
		const want = this.gen;
		await this.ensureLoaded();
		const rows = await this.single(`all\0${customRoot ?? ""}`, want, async () => {
			this.stats.refreshes++;
			const t0 = performance.now();
			const out = await (customRoot ? this.listDir(piNormalizePath(customRoot), null) : this.walkAll());
			if (!this.announced) {
				// One line per process, counts only: how the first full listing after a start went.
				this.announced = true;
				const s = this.stats;
				console.log(
					`[session-index] first listing: ${out.length} chats in ${Math.round(performance.now() - t0)} ms; ` +
						`${s.loadedFromDisk} files from the saved index, ${s.unchanged} unchanged, ` +
						`${s.fullReads} read in full, ${s.partialReads} read from where they stopped` +
						(s.rejectedSaves ? " (saved index unusable: rebuilt)" : ""),
				);
			}
			return out;
		});
		return rows.slice();
	}

	/** Same rows and order as `SessionManager.list(cwd, customRoot)` (allMessagesText left empty). */
	async listProject(cwd: string, customRoot?: string): Promise<SessionInfo[]> {
		if (process.platform === "win32") return SessionManager.list(cwd, customRoot);
		const want = this.gen;
		await this.ensureLoaded();
		const dir = customRoot ? piNormalizePath(customRoot) : defaultSessionDirPath(cwd);
		const filterCwd = customRoot !== undefined && dir !== defaultSessionDirPath(cwd);
		const resolvedCwd = piResolvePath(cwd);
		const include = filterCwd
			? (s: SessionInfo) => s.cwd !== undefined && s.cwd !== "" && piResolvePath(s.cwd) === resolvedCwd
			: null;
		const rows = await this.single(`dir\0${dir}\0${filterCwd ? resolvedCwd : ""}`, want, async () => {
			this.stats.refreshes++;
			return this.listDir(dir, include);
		});
		return rows.slice();
	}

	/** The last id of the followed custom entry in a file the index knows as `st` shows it
	 *  (null = not known as it is now: read it yourself). */
	identityOf(
		path: string,
		st: { ino: number; size: number; mtimeMs: number },
	): { id: string | null | undefined } | null {
		if (!this.identity) return null;
		const e = this.entries.get(path);
		if (!e || e.ino !== st.ino || e.size !== st.size || e.mtimeMs !== st.mtimeMs) return null;
		// An unfinished last line isn't followed: let the reader decide while one is being written.
		if (e.offset !== e.size) return null;
		return { id: e.identity };
	}

	/** Save now (tests, shutdown). */
	async flush(): Promise<void> {
		if (this.saveTimer) {
			clearTimeout(this.saveTimer);
			this.saveTimer = null;
		}
		while (this.saving) await this.saving;
		if (this.dirty) await this.save();
	}

	// -- listing ---------------------------------------------------------------

	/** Join the walk under way for `key` unless it started before the generation the caller asked at. */
	private single(key: string, want: number, run: () => Promise<SessionInfo[]>): Promise<SessionInfo[]> {
		const cur = this.flights.get(key);
		if (cur && cur.gen >= want) {
			this.stats.joined++;
			return cur.p;
		}
		const settle = () => undefined;
		const before = cur ? cur.p.then(settle, settle) : Promise.resolve();
		const flight = { gen: want, p: before.then(run) };
		this.flights.set(key, flight);
		const clear = () => {
			if (this.flights.get(key) === flight) this.flights.delete(key);
		};
		flight.p.then(clear, clear);
		return flight.p;
	}

	/** pi's listAll() without a custom folder: every folder under <agentDir>/sessions. */
	private async walkAll(): Promise<SessionInfo[]> {
		const root = sessionsDir();
		if (!existsSync(root)) {
			this.prune((p) => p.startsWith(root + sep), new Set());
			return [];
		}
		let dirs: string[];
		try {
			const ents = await readdir(root, { withFileTypes: true });
			dirs = ents.filter((e) => e.isDirectory() || e.isSymbolicLink()).map((e) => join(root, e.name));
		} catch {
			return [];
		}
		const files = (
			await mapLimit(dirs, 64, async (d) => {
				try {
					return (await readdir(d)).filter((f) => f.endsWith(".jsonl")).map((f) => join(d, f));
				} catch {
					return [];
				}
			})
		).flat();
		const cands = await this.statAll(files);
		cands.sort((a, b) => b.st.mtimeMs - a.st.mtimeMs || basename(b.path).localeCompare(basename(a.path)));
		this.prune((p) => p.startsWith(root + sep), new Set(cands.map((c) => c.path)));
		return this.infosInOrder(cands);
	}

	/** pi's listSessionsFromDir(): the .jsonl files of one folder, names newest first. */
	private async listDir(dir: string, include: ((s: SessionInfo) => boolean) | null): Promise<SessionInfo[]> {
		const dirKey = resolve(dir);
		const inDir = (p: string) => resolve(dirname(p)) === dirKey;
		if (!existsSync(dir)) {
			this.prune(inDir, new Set());
			return [];
		}
		let names: string[];
		try {
			names = (await readdir(dir)).filter((f) => f.endsWith(".jsonl")).sort((a, b) => b.localeCompare(a));
		} catch {
			return [];
		}
		const files = names.map((n) => join(dir, n));
		const cands = await this.statAll(files);
		this.prune(inDir, new Set(cands.map((c) => c.path)));
		const infos = await this.infosInOrder(cands);
		return include ? infos.filter(include) : infos;
	}

	private async statAll(files: string[]): Promise<Cand[]> {
		const out = await mapLimit(files, 64, async (path): Promise<Cand | null> => {
			try {
				const st = await stat(path);
				return st.isFile() ? { path, st } : null;
			} catch {
				return null;
			}
		});
		return out.filter((c): c is Cand => c !== null);
	}

	private async infosInOrder(cands: Cand[]): Promise<SessionInfo[]> {
		const out = await mapLimit(cands, 16, async (c) => {
			const e = await this.ensure(c.path, c.st);
			return e ? toInfo(c.path, e, c.st) : null;
		});
		return sortInfos(out.filter((i): i is SessionInfo => i !== null));
	}

	/** Drop entries in a walked folder whose file is gone. */
	private prune(inScope: (path: string) => boolean, seen: Set<string>): void {
		for (const path of this.entries.keys()) {
			if (inScope(path) && !seen.has(path)) {
				this.entries.delete(path);
				this.markDirty();
			}
		}
	}

	// -- reading ---------------------------------------------------------------

	private ensure(path: string, st: Stats): Promise<Entry | null> {
		const e = this.entries.get(path);
		if (e && e.dev === st.dev && e.ino === st.ino && e.size === st.size && e.mtimeMs === st.mtimeMs) {
			this.stats.unchanged++;
			return Promise.resolve(e);
		}
		const running = this.reads.get(path);
		if (running) return running;
		const p = this.read(path, st, e).finally(() => this.reads.delete(path));
		this.reads.set(path, p);
		return p;
	}

	private async read(path: string, st: Stats, prev: Entry | undefined): Promise<Entry | null> {
		const resume = !!prev && prev.dev === st.dev && prev.ino === st.ino && prev.offset > 0 && st.size >= prev.offset;
		const task: ScanTask = {
			file: path,
			from: resume ? prev!.offset : 0,
			to: st.size,
			fold: resume ? prev!.committed : null,
			fp: resume ? prev!.fp : null,
			customTypes: this.identity ? [this.identity.customType] : [],
		};
		let r: ScanResult;
		try {
			r = await this.pool.run(task);
		} catch {
			// Gone or unreadable: pi leaves it out too.
			if (this.entries.delete(path)) this.markDirty();
			return null;
		}
		let identity = r.full ? undefined : prev?.identity;
		if (this.identity) {
			for (const c of r.customs) {
				const id = this.identity.idOf({ type: "custom", customType: c.customType, data: c.data });
				if (id !== undefined) identity = id;
			}
		}
		if (r.full) this.stats.fullReads++;
		else this.stats.partialReads++;
		this.stats.bytesRead += r.bytesRead;
		const entry: Entry = {
			dev: st.dev,
			ino: st.ino,
			size: st.size,
			mtimeMs: st.mtimeMs,
			offset: r.offset,
			fp: r.fp,
			committed: r.committed,
			view: r.view,
			identity,
		};
		this.entries.set(path, entry);
		this.markDirty();
		return entry;
	}

	// -- saved file -------------------------------------------------------------

	private ensureLoaded(): Promise<void> {
		if (!this.loading) this.loading = this.file ? this.load(this.file) : Promise.resolve();
		return this.loading;
	}

	private async load(file: string): Promise<void> {
		let raw: string;
		try {
			raw = await readFile(file, "utf8");
		} catch {
			return; // none yet
		}
		let saved: unknown;
		try {
			saved = JSON.parse(raw);
		} catch {
			saved = null;
		}
		if (
			!isObj(saved) ||
			saved.version !== SAVE_VERSION ||
			saved.fold !== FOLD_VERSION ||
			saved.identityType !== (this.identity?.customType ?? null) ||
			!isObj(saved.files)
		) {
			this.stats.rejectedSaves++;
			this.markDirty();
			return;
		}
		for (const [path, v] of Object.entries(saved.files)) {
			const e = parseEntry(v);
			if (e && !this.entries.has(path)) this.entries.set(path, e);
		}
		this.stats.loadedFromDisk = this.entries.size;
	}

	private markDirty(): void {
		if (!this.file) return;
		this.dirty = true;
		if (this.saveTimer) return;
		this.saveTimer = setTimeout(() => {
			this.saveTimer = null;
			void this.save();
		}, SAVE_DELAY_MS);
		this.saveTimer.unref();
	}

	private async save(): Promise<void> {
		const file = this.file;
		if (!file) return;
		if (this.saving) {
			// One write at a time; the change that came meanwhile is saved by the next timer.
			this.markDirty();
			return;
		}
		this.dirty = false;
		const files: Record<string, unknown> = {};
		for (const [path, e] of this.entries) files[path] = e;
		const body = JSON.stringify({
			version: SAVE_VERSION,
			fold: FOLD_VERSION,
			identityType: this.identity?.customType ?? null,
			files,
		});
		const tmp = `${file}.${process.pid}.tmp`;
		this.saving = (async () => {
			try {
				await mkdir(dirname(file), { recursive: true });
				await writeFile(tmp, body);
				await rename(tmp, file);
			} catch (err) {
				await unlink(tmp).catch(() => {});
				if (!this.saveWarned) {
					this.saveWarned = true;
					console.warn(`[session-index] cannot save ${file}: ${(err as Error).message}`);
				}
			} finally {
				this.saving = null;
			}
		})();
		await this.saving;
	}
}

/** The server's index (every window shares it). agent-service configures where it's saved. */
export const sessionIndex = new SessionIndex();
