/**
 * roles-evidence (task #207): how far a working task's change has got, for the Roles page's Completion
 * evidence row (Built, Checked, Installed, Live, Confirmed), with real times. docs/roles-evidence.md.
 *
 * It only reads, never writes, loads no chat and calls no model:
 *   <wt state>/branches.jsonl          wt new: the chat that made each branch (agent-tools lib/wt.mjs)
 *   <wt state>/lands.jsonl             wt land: the commit each branch put on its base, once its checks passed
 *   <stage>/history.jsonl              pi-web-deploy: every finished install, with its checks
 *   <live>/dist/.pi-web-deploy.json    pi-web-deploy: the live build's commit
 * and asks git whether one commit contains another (cached by the pair: the answer never changes).
 *
 * The join: the task's chat -> the branches that chat made -> the lands of those branches (a land
 * belongs to the newest record of its repo and branch made before it, so a reused branch name never
 * gives one task another task's commit) -> the newest of them. With no branch record the task says
 * "Not recorded" (nothing is guessed for older tasks).
 */

import { execFile } from "node:child_process";
import { open, type FileHandle } from "node:fs/promises";
import { basename, join } from "node:path";
import { samePath } from "./identities.js";
import type { UiTaskEvidence, UiTaskEvidenceStep } from "./protocol.js";
import { readUpTo, STATE_READ_FLAGS } from "./state-file-read.js";

/** A record file bigger than this isn't read (wt keeps 90 days; pi-web-deploy 200 lines). */
export const EVIDENCE_FILE_MAX = 8 << 20;

export interface RolesEvidencePaths {
	/** wt's state folder: WT_STATE, or ~/.local/state/wt. */
	wtState: string;
	/** pi-web-deploy's live clone (pi-web-ui's main folder): only its installs are followed. */
	deployLive: string;
	/** pi-web-deploy's stage folder (history.jsonl). */
	deployStage: string;
}

/** Whether `outer` contains `inner` in `repo`: true, false, or null when git can't say. */
export type AncestryCheck = (repo: string, outer: string, inner: string) => Promise<boolean | null>;

/** git merge-base --is-ancestor: exit 0 yes, 1 no, anything else unknown. */
export const gitContains: AncestryCheck = (repo, outer, inner) =>
	new Promise((resolveIt) => {
		execFile(
			"git",
			["-C", repo, "merge-base", "--is-ancestor", inner, outer],
			{ timeout: 10_000, windowsHide: true },
			(err) => {
				if (!err) return resolveIt(true);
				const code = (err as { code?: unknown }).code;
				resolveIt(code === 1 ? false : null);
			},
		);
	});

interface BranchRecord {
	at: number;
	repo: string;
	branch: string;
	session?: string;
	chat?: string;
}
interface LandRecord {
	at: number;
	repo: string;
	branch: string;
	commit: string;
	committedAt: number;
}
interface InstallRecord {
	commit: string;
	startedAt: number;
	endedAt: number;
	checksAt?: number;
}
interface LiveMarker {
	commit: string;
	deployedAt?: number;
}

const SHA = /^[0-9a-f]{40}$/;
const CHAT_ID = /^[A-Za-z0-9-]{8,80}$/;
const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);
const time = (v: unknown): number | undefined => {
	const t = typeof v === "string" ? Date.parse(v) : NaN;
	return Number.isFinite(t) ? t : undefined;
};
const obj = (v: unknown): Record<string, unknown> | null =>
	v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

export function branchRecordOf(raw: unknown): BranchRecord | null {
	const o = obj(raw);
	const at = time(o?.at);
	const repo = str(o?.repo);
	const branch = str(o?.branch);
	if (!o || o.v !== 1 || at === undefined || !repo || !branch) return null;
	const session = str(o.session);
	const chat = str(o.chat);
	return {
		at,
		repo,
		branch,
		...(session ? { session } : {}),
		...(chat && CHAT_ID.test(chat) ? { chat } : {}),
	};
}

export function landRecordOf(raw: unknown): LandRecord | null {
	const o = obj(raw);
	const at = time(o?.at);
	const committedAt = time(o?.committedAt);
	const repo = str(o?.repo);
	const branch = str(o?.branch);
	const commit = str(o?.commit);
	if (!o || o.v !== 1 || at === undefined || committedAt === undefined || !repo || !branch) return null;
	if (!commit || !SHA.test(commit)) return null;
	return { at, repo, branch, commit, committedAt };
}

/** A pi-web-deploy history line that put its commit in and passed its checks; null for any other. */
export function installRecordOf(raw: unknown): InstallRecord | null {
	const o = obj(raw);
	const commit = str(o?.commit);
	const startedAt = time(o?.startedAt);
	const endedAt = time(o?.endedAt);
	if (!o || !commit || !SHA.test(commit) || startedAt === undefined || endedAt === undefined) return null;
	if (o.result !== "swapped" || o.up === false || o.restart === "failed") return null;
	// Rolled back by its own checks: it didn't stay in.
	if (obj(o.autoRollback)) return null;
	const checks = obj(o.checks);
	const results = Array.isArray(checks?.results) ? checks.results : [];
	if (!checks || checks.stopped || !results.length) return null;
	if (results.some((r) => obj(r)?.status === "fail")) return null;
	const checksAt = time(checks.at);
	return { commit, startedAt, endedAt, ...(checksAt !== undefined ? { checksAt } : {}) };
}

function liveMarkerOf(raw: unknown): LiveMarker | null {
	const o = obj(raw);
	const commit = str(o?.commit);
	if (!o || !commit || !SHA.test(commit)) return null;
	const deployedAt = time(o.deployedAt);
	return { commit, ...(deployedAt !== undefined ? { deployedAt } : {}) };
}

/** A file read again only when its size or time changed; [] / null when absent, too big or unreadable. */
class CachedFile<T> {
	private seen: { mtimeMs: number; size: number; value: T } | null = null;
	constructor(
		private readonly path: () => string,
		private readonly parse: (text: string) => T,
		private readonly empty: T,
	) {}
	async get(): Promise<T> {
		let fh: FileHandle;
		try {
			fh = await open(this.path(), STATE_READ_FLAGS);
		} catch {
			this.seen = null;
			return this.empty;
		}
		try {
			const st = await fh.stat();
			if (!st.isFile() || st.size > EVIDENCE_FILE_MAX) {
				this.seen = null;
				return this.empty;
			}
			if (this.seen && this.seen.mtimeMs === st.mtimeMs && this.seen.size === st.size) return this.seen.value;
			const bytes = await readUpTo(fh, EVIDENCE_FILE_MAX, 1 << 20);
			if (bytes === null) {
				this.seen = null;
				return this.empty;
			}
			const value = this.parse(bytes.toString("utf8"));
			this.seen = { mtimeMs: st.mtimeMs, size: st.size, value };
			return value;
		} catch {
			this.seen = null;
			return this.empty;
		} finally {
			await fh.close().catch(() => undefined);
		}
	}
}

function linesOf<T>(text: string, parse: (raw: unknown) => T | null): T[] {
	const out: T[] = [];
	for (const line of text.split("\n")) {
		if (!line.trim()) continue;
		try {
			const v = parse(JSON.parse(line));
			if (v) out.push(v);
		} catch {
			// A torn or foreign line is skipped.
		}
	}
	return out;
}

/** The task a row is about: its own chat's transcript, and whether (and when) its queue marked it done. */
export interface EvidenceTask {
	file?: string;
	status: string;
	doneAt?: number;
}

const NOT = (not: "yet" | "recorded" | "tracked"): UiTaskEvidenceStep => ({ not });
const NOT_RECORDED: UiTaskEvidence = {
	built: NOT("recorded"),
	checked: NOT("recorded"),
	installed: NOT("recorded"),
	live: NOT("recorded"),
	confirmed: NOT("recorded"),
};

/** One overview's view of the records (read once per overview), answering for each task. */
export class EvidenceView {
	constructor(
		private readonly paths: RolesEvidencePaths,
		private readonly branches: BranchRecord[],
		private readonly lands: LandRecord[],
		private readonly installs: InstallRecord[],
		private readonly live: LiveMarker | null,
		private readonly contains: (outer: string, inner: string) => Promise<boolean | null>,
	) {}

	/** Whether a branch record was made by the chat with transcript `file`: every id it holds names it. */
	private madeBy(b: BranchRecord, file: string): boolean {
		if (!b.session && !b.chat) return false;
		if (b.session && !samePath(b.session, file)) return false;
		if (b.chat && !basename(file).endsWith(`_${b.chat}.jsonl`)) return false;
		return true;
	}

	/** The branch record a land belongs to: the newest of its repo and branch made before the land. */
	private ownerOf(land: LandRecord): BranchRecord | undefined {
		let owner: BranchRecord | undefined;
		for (const b of this.branches) {
			if (b.branch !== land.branch || !samePath(b.repo, land.repo) || b.at > land.at) continue;
			if (!owner || b.at >= owner.at) owner = b;
		}
		return owner;
	}

	async of(task: EvidenceTask): Promise<UiTaskEvidence> {
		const file = task.file;
		if (!file) return NOT_RECORDED;
		const mine = this.branches.filter((b) => this.madeBy(b, file));
		if (!mine.length) return NOT_RECORDED;
		const mySet = new Set(mine);
		let land: LandRecord | undefined;
		for (const l of this.lands) {
			const owner = this.ownerOf(l);
			if (owner && mySet.has(owner) && (!land || l.at >= land.at)) land = l;
		}
		const newest = mine.reduce((a, b) => (b.at >= a.at ? b : a));
		const repo = land?.repo ?? newest.repo;
		const tracked = samePath(repo, this.paths.deployLive);
		const doneAfter = (step: UiTaskEvidenceStep): UiTaskEvidenceStep =>
			"at" in step && task.status === "done" && typeof task.doneAt === "number" && task.doneAt >= step.at
				? { at: task.doneAt }
				: NOT("yet");
		if (!land) {
			return {
				repo: basename(repo),
				built: NOT("yet"),
				checked: NOT("yet"),
				installed: NOT(tracked ? "yet" : "tracked"),
				live: NOT(tracked ? "yet" : "tracked"),
				confirmed: NOT("yet"),
			};
		}
		const built: UiTaskEvidenceStep = { at: land.committedAt };
		const checked: UiTaskEvidenceStep = { at: land.at };
		let installed: UiTaskEvidenceStep = NOT("tracked");
		let live: UiTaskEvidenceStep = NOT("tracked");
		if (tracked) {
			// The first install that went in with it and passed its checks (an install of a newer commit
			// that contains it counts: it went in with that one).
			let job: InstallRecord | undefined;
			for (const j of this.installs) {
				if (j.endedAt < land.committedAt) continue;
				if (j.commit === land.commit || (await this.contains(j.commit, land.commit)) === true) {
					job = j;
					break;
				}
			}
			installed = job ? { at: job.endedAt } : NOT("yet");
			const inLive =
				!!this.live &&
				(this.live.commit === land.commit || (await this.contains(this.live.commit, land.commit)) === true);
			const liveAt = job ? (job.checksAt ?? job.endedAt) : this.live?.deployedAt;
			live = inLive && liveAt !== undefined ? { at: liveAt } : NOT("yet");
		}
		return {
			repo: basename(land.repo),
			commit: land.commit.slice(0, 8),
			built,
			checked,
			installed,
			live,
			confirmed: doneAfter(tracked ? live : checked),
		};
	}
}

/** Reads the records for the Roles page (cached by file size and time, and git answers by commit pair). */
export class RolesEvidence {
	private readonly branches: CachedFile<BranchRecord[]>;
	private readonly lands: CachedFile<LandRecord[]>;
	private readonly history: CachedFile<InstallRecord[]>;
	private readonly marker: CachedFile<LiveMarker | null>;
	/** "outer\0inner" -> whether outer contains inner (only definite answers are kept). */
	private readonly known = new Map<string, boolean>();

	constructor(
		private readonly paths: () => RolesEvidencePaths,
		private readonly ancestry: AncestryCheck = gitContains,
	) {
		this.branches = new CachedFile(
			() => join(paths().wtState, "branches.jsonl"),
			(t) => linesOf(t, branchRecordOf),
			[],
		);
		this.lands = new CachedFile(
			() => join(paths().wtState, "lands.jsonl"),
			(t) => linesOf(t, landRecordOf),
			[],
		);
		this.history = new CachedFile(
			() => join(paths().deployStage, "history.jsonl"),
			(t) => linesOf(t, installRecordOf),
			[],
		);
		this.marker = new CachedFile(
			() => join(paths().deployLive, "dist", ".pi-web-deploy.json"),
			(t) => liveMarkerOf(JSON.parse(t)),
			null,
		);
	}

	async load(): Promise<EvidenceView> {
		const paths = this.paths();
		const [branches, lands, installs, live] = await Promise.all([
			this.branches.get(),
			this.lands.get(),
			this.history.get(),
			this.marker.get(),
		]);
		const contains = async (outer: string, inner: string): Promise<boolean | null> => {
			if (outer === inner) return true;
			const key = `${outer}\0${inner}`;
			const had = this.known.get(key);
			if (had !== undefined) return had;
			const v = await this.ancestry(paths.deployLive, outer, inner);
			if (v !== null) {
				if (this.known.size > 4096) this.known.clear();
				this.known.set(key, v);
			}
			return v;
		};
		return new EvidenceView(paths, branches, lands, installs, live, contains);
	}
}
