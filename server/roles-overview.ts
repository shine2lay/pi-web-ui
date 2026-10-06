/**
 * roles-overview: the Roles page's data: one snapshot with every role's state, made from what the app
 * already keeps:
 *   - the roles (identity.json: home chat, the owner's work mode and approved goals, the Focus line);
 *   - each role's home chat and its started task chats on disk: TL;DR lines and pi-queue entries, read
 *     once and then only the bytes added since (an unchanged file costs one stat);
 *   - the chats' runtime state (working or not) and the questions waiting now;
 *   - the whole role-message store (open requests, 6 am report requests), not just its last 100 rows;
 *   - the 6 am report job's runs (role-reports runs.json) and its scheduler job.
 *
 * It only reads: it loads no chat, starts no worker, calls no model and writes nothing.
 * What leaves it is display text only: TL;DR lines, task titles and questions, request first lines and
 * the report a role wrote for the owner. Never raw entries, thinking, tool calls or results, prompts,
 * rules or notebooks. Every transcript it opens must be a plain .jsonl file inside the session folders
 * (no "..", no symlinks).
 */

import { lstat, open, readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, resolve, sep } from "node:path";
import type { Ask } from "./asks.js";
import { goalEnded, type RoleGoal, type WorkMode } from "./identity-config.js";
import { samePath, type IdentityDef } from "./identities.js";
import type {
	ServerMessage,
	UiRoleAsk,
	UiRoleChatRef,
	UiRoleGoal,
	UiRoleOverview,
	UiRoleQueue,
	UiRoleReport,
	UiRoleRequest,
	UiRolesOverview,
	UiRoleStatus,
	UiRoleTask,
	UiRoleTldrLine,
	UiTaskQueueTask,
	UiTldrLine,
} from "./protocol.js";
import { ROLE_REPORT_HEADINGS, reportReplyText, type RoleMessageState, type RoleReportReply } from "./role-messages.js";
import { rulesGoals, rulesWorkMode } from "./role-rules.js";
import { TASK_QUEUE_ENTRY_TYPE, taskQueueFromEntries, taskRefLabel, type TaskQueueEntryLike } from "./task-queue.js";
import {
	isTldrReply,
	TLDR_ENTRY_TYPE,
	TLDR_MAX_LINES,
	tldrLinesFromEntries,
	type TldrEntryLike,
} from "./tldr-lines.js";

/** TL;DR lines sent per role (its home chat and task chats together, newest first). */
export const ROLES_TLDR_MAX = 20;
/** Queued (not started) tasks listed per role. */
export const ROLES_QUEUED_MAX = 20;
/** A report longer than this is cut (the rest is in the chat). */
export const ROLES_REPORT_MAX = 12_000;
/** Started task chats read per role (a queue runs at most 8 lanes). */
export const ROLES_TASK_CHATS_MAX = 8;
/** The 6 am report job's days are Pacific days (role-reports.mjs TZ). */
export const REPORT_TZ = "America/Los_Angeles";

/** The first bytes of a transcript line, enough to tell what it is. */
const HEAD = 512;
/** A longer line is read no further (a user message that long still counts as the owner's reply). */
const LINE_MAX = 1 << 20;
const CHUNK = 1 << 20;
/** Past this many kept TL;DR entries, a file's list is folded down to its newest lines. */
const KEEP_TLDR = 4000;

const ACTIVE: ReadonlySet<string> = new Set(["working", "asking", "stuck", "waiting", "blocked"]);

type ChatRuntime = "working" | "idle" | "closed";

// ---------------------------------------------------------------------------
// Transcript paths: only plain files inside the session folders
// ---------------------------------------------------------------------------

/** Checks that a transcript path is a plain .jsonl file inside a session folder (cached a while). */
export class ChatPaths {
	private readonly seen = new Map<string, { ok: boolean; at: number }>();
	private roots: { list: string[]; at: number } | null = null;

	constructor(
		private readonly sessionRoots: () => string[],
		private readonly now: () => number = Date.now,
	) {}

	/** The path itself when it may be read, else null. */
	async check(file: unknown): Promise<string | null> {
		if (typeof file !== "string" || !file || file.length > 4096 || file.includes("\0")) return null;
		// Absolute, already normal (no "." or ".." parts, no doubled slashes), a transcript.
		if (!isAbsolute(file) || resolve(file) !== file || !file.endsWith(".jsonl")) return null;
		const now = this.now();
		const hit = this.seen.get(file);
		if (hit && now - hit.at < (hit.ok ? 60_000 : 5_000)) return hit.ok ? file : null;
		let ok = false;
		try {
			const st = await lstat(file);
			// No symlink at the end, none on the way (its real path is itself), inside a session folder.
			if (st.isFile() && (await realpath(file)) === file) {
				ok = (await this.realRoots()).some((root) => file.startsWith(root.endsWith(sep) ? root : root + sep));
			}
		} catch {
			ok = false;
		}
		if (this.seen.size > 4000) this.seen.clear();
		this.seen.set(file, { ok, at: now });
		return ok ? file : null;
	}

	private async realRoots(): Promise<string[]> {
		const now = this.now();
		if (this.roots && now - this.roots.at < 60_000) return this.roots.list;
		const list: string[] = [];
		for (const r of new Set(this.sessionRoots().filter((x) => typeof x === "string" && isAbsolute(x)))) {
			try {
				list.push(await realpath(r));
			} catch {
				// no such folder (yet)
			}
		}
		this.roots = { list, at: now };
		return list;
	}
}

// ---------------------------------------------------------------------------
// Transcripts, read incrementally
// ---------------------------------------------------------------------------

/** What is kept of one transcript: its TL;DR entries (and the owner's replies between them) and its
 *  pi-queue entries, plus when each task last got stuck. */
export interface TranscriptScan {
	ino: number;
	size: number;
	mtimeMs: number;
	/** Its first bytes (a file rewritten in place starts differently: it is read again). */
	head: string;
	/** The next byte to read (a line start). */
	offset: number;
	tldr: TldrEntryLike[];
	queue: TaskQueueEntryLike[];
	/** Task id -> the time of its latest "stuck" entry (when it started waiting on the owner). */
	stuckAt: Map<number, number>;
	/** A needs-you line came after the last kept reply (only then is a reply worth keeping). */
	waiting: boolean;
}

type LineKind = "tldr" | "queue" | "user" | "replyTool";

/** What a transcript line is, from its first bytes (null: nothing the page needs). */
export function lineKind(head: string): LineKind | null {
	if (head.includes('"type":"custom"')) {
		if (head.includes(`"customType":"${TLDR_ENTRY_TYPE}"`)) return "tldr";
		if (head.includes(`"customType":"${TASK_QUEUE_ENTRY_TYPE}"`)) return "queue";
		return null;
	}
	if (!head.includes('"type":"message"')) return null;
	if (head.includes('"role":"user"')) return "user";
	// The owner's answer in a questionnaire or a plan approval box (tldr-lines REPLY_TOOLS).
	if (
		head.includes('"role":"toolResult"') &&
		(head.includes('"toolName":"ask_user_question"') || head.includes('"toolName":"queue_add"'))
	) {
		return "replyTool";
	}
	return null;
}

const REPLY: TldrEntryLike = { type: "message", message: { role: "user", content: "(reply)" } };

/** Every transcript the page reads, kept up to date by reading only what was added. */
export class TranscriptScans {
	private readonly files = new Map<string, TranscriptScan>();
	private readonly inflight = new Map<string, Promise<TranscriptScan>>();
	/** Bytes read so far (for tests and the log). */
	bytesRead = 0;

	/** The file's scan, brought up to date (throws when it can't be read). */
	read(file: string): Promise<TranscriptScan> {
		const going = this.inflight.get(file);
		if (going) return going;
		const p = this.update(file).finally(() => this.inflight.delete(file));
		this.inflight.set(file, p);
		return p;
	}

	/** Forget every file not in `keep` (a role's chats changed). */
	retain(keep: ReadonlySet<string>): void {
		for (const f of this.files.keys()) if (!keep.has(f)) this.files.delete(f);
	}

	get size(): number {
		return this.files.size;
	}

	private async update(file: string): Promise<TranscriptScan> {
		const st = await stat(file);
		let s = this.files.get(file);
		const changed = !s || st.size !== s.size || st.mtimeMs !== s.mtimeMs;
		const head = changed ? await headOf(file) : (s?.head ?? "");
		if (changed) this.bytesRead += head.length;
		// (A file still under 256 bytes just grew: its old first bytes start the new ones.)
		const rewritten = !!s?.head && s.head !== head && !(s.head.length < 256 && head.startsWith(s.head));
		// A new file, a replaced one, one that shrank or was rewritten: read it from the start.
		if (!s || s.ino !== st.ino || st.size < s.offset || (changed && rewritten)) {
			s = {
				ino: st.ino,
				size: 0,
				mtimeMs: 0,
				head,
				offset: 0,
				tldr: [],
				queue: [],
				stuckAt: new Map(),
				waiting: false,
			};
			this.files.set(file, s);
		}
		if (changed) s.head = head;
		if (changed) {
			if (st.size > s.offset) await this.readFrom(file, s, st.size);
			s.size = st.size;
			s.mtimeMs = st.mtimeMs;
		}
		return s;
	}

	/** Reads complete lines from s.offset up to `end`; a last line without its newline waits. */
	private async readFrom(file: string, s: TranscriptScan, end: number): Promise<void> {
		const fh = await open(file, "r");
		try {
			const buf = Buffer.allocUnsafe(CHUNK);
			let pos = s.offset;
			let parts: Buffer[] = [];
			let len = 0;
			let kind: LineKind | null | undefined;
			let skip = false;
			let big = false;
			const classify = () => {
				const head = Buffer.concat(parts, Math.min(len, HEAD)).toString("utf8");
				kind = lineKind(head);
				// The owner's messages matter only while a needs-you line waits for an answer.
				if ((kind === "user" || kind === "replyTool") && !s.waiting) kind = null;
				if (kind === null) {
					skip = true;
					parts = [];
					len = 0;
				}
			};
			while (pos < end) {
				const { bytesRead } = await fh.read(buf, 0, Math.min(CHUNK, end - pos), pos);
				if (!bytesRead) break;
				this.bytesRead += bytesRead;
				let i = 0;
				while (i < bytesRead) {
					const nl = buf.indexOf(10, i);
					const stop = nl === -1 || nl >= bytesRead ? bytesRead : nl;
					if (!skip && stop > i) {
						const piece = buf.subarray(i, stop);
						if (len + piece.length > LINE_MAX) {
							if (kind === undefined) {
								parts.push(Buffer.from(piece.subarray(0, Math.max(0, HEAD - len))));
								len += Math.min(piece.length, Math.max(0, HEAD - len));
								classify();
							}
							big = kind !== null;
							skip = true;
							parts = [];
							len = 0;
						} else {
							parts.push(Buffer.from(piece));
							len += piece.length;
							if (kind === undefined && len >= HEAD) classify();
						}
					}
					if (stop === bytesRead && (nl === -1 || nl >= bytesRead)) break;
					// The line ends here.
					if (!skip && len > 0) {
						if (kind === undefined) classify();
						if (kind) this.take(s, kind, Buffer.concat(parts, len).toString("utf8"));
					} else if (big && kind === "user") {
						this.reply(s);
					}
					parts = [];
					len = 0;
					kind = undefined;
					skip = false;
					big = false;
					s.offset = pos + nl + 1;
					i = nl + 1;
				}
				pos += bytesRead;
			}
		} finally {
			await fh.close().catch(() => {});
		}
		if (s.tldr.length > KEEP_TLDR) fold(s);
	}

	private take(s: TranscriptScan, kind: LineKind, line: string): void {
		let e: Record<string, unknown>;
		try {
			e = JSON.parse(line) as Record<string, unknown>;
		} catch {
			return;
		}
		if (!e || typeof e !== "object") return;
		if (kind === "tldr") {
			if (e.type !== "custom" || e.customType !== TLDR_ENTRY_TYPE || typeof e.id !== "string") return;
			const entry: TldrEntryLike = {
				type: "custom",
				customType: TLDR_ENTRY_TYPE,
				id: e.id,
				data: e.data,
				...(typeof e.timestamp === "string" ? { timestamp: e.timestamp } : {}),
			};
			s.tldr.push(entry);
			if ((e.data as { needsYou?: unknown } | undefined)?.needsYou === true) s.waiting = true;
			return;
		}
		if (kind === "queue") {
			if (e.type !== "custom" || e.customType !== TASK_QUEUE_ENTRY_TYPE) return;
			s.queue.push({ type: "custom", customType: TASK_QUEUE_ENTRY_TYPE, data: e.data });
			const op = (e.data ?? {}) as { op?: unknown; id?: unknown; ts?: unknown };
			if (op.op === "stuck" && typeof op.id === "number" && typeof op.ts === "number" && op.ts > 0) {
				s.stuckAt.set(op.id, op.ts);
			}
			return;
		}
		if (e.type === "message" && isTldrReply(e.message)) this.reply(s);
	}

	/** The owner replied: worth keeping only when a needs-you line waits for it. */
	private reply(s: TranscriptScan): void {
		if (!s.waiting) return;
		s.tldr.push(REPLY);
		s.waiting = false;
	}
}

/** A file's first 256 bytes (as text), "" when empty or unreadable. */
async function headOf(file: string): Promise<string> {
	try {
		const fh = await open(file, "r");
		try {
			const buf = Buffer.alloc(256);
			const { bytesRead } = await fh.read(buf, 0, 256, 0);
			return buf.subarray(0, bytesRead).toString("latin1");
		} finally {
			await fh.close().catch(() => {});
		}
	} catch {
		return "";
	}
}

/** Folds a long TL;DR entry list to the newest lines it makes (same lines, same answered marks). */
function fold(s: TranscriptScan): void {
	const lines = tldrLinesFromEntries(s.tldr, TLDR_MAX_LINES);
	// The answered needs-you lines are always the earliest ones (a reply answers every line before it).
	let lastAnswered = -1;
	lines.forEach((l, i) => {
		if (l.needsYou && l.answered) lastAnswered = i;
	});
	const out: TldrEntryLike[] = [];
	lines.forEach((l, i) => {
		out.push({
			type: "custom",
			customType: TLDR_ENTRY_TYPE,
			id: l.id,
			data: {
				text: l.text,
				needsYou: l.needsYou,
				ts: l.ts,
				...(l.chat ? { chat: l.chat } : {}),
				...(l.kind ? { kind: l.kind } : {}),
			},
		});
		if (i === lastAnswered) out.push(REPLY);
	});
	s.tldr = out;
	s.waiting = lines.some((l, i) => i > lastAnswered && l.needsYou);
}

// ---------------------------------------------------------------------------
// The 6 am report job: its runs and its schedule
// ---------------------------------------------------------------------------

/** One run of role-reports (runs.json), as far as the page needs it. */
export interface ReportRun {
	date: string;
	at: number;
	active: string[];
	inactive: string[];
	skipped: string[];
	sent: Record<string, { id?: string; error?: string }>;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** runs.json -> its runs, oldest first (a wrong file: none). */
export function reportRunsOf(raw: unknown): ReportRun[] {
	const runs = (raw as { runs?: unknown } | null)?.runs;
	if (!Array.isArray(runs)) return [];
	const out: ReportRun[] = [];
	for (const r of runs) {
		if (!r || typeof r !== "object") continue;
		const o = r as Record<string, unknown>;
		if (typeof o.date !== "string" || !DATE_RE.test(o.date) || typeof o.at !== "number") continue;
		const names = (x: unknown) => (Array.isArray(x) ? x.filter((v): v is string => typeof v === "string") : []);
		const sent: ReportRun["sent"] = {};
		if (o.sent && typeof o.sent === "object") {
			for (const [role, v] of Object.entries(o.sent as Record<string, unknown>)) {
				const s = (v ?? {}) as { id?: unknown; error?: unknown };
				sent[role] = {
					...(typeof s.id === "string" && s.id ? { id: s.id } : {}),
					...(typeof s.error === "string" ? { error: s.error } : {}),
				};
			}
		}
		out.push({
			date: o.date,
			at: o.at,
			active: o.active && typeof o.active === "object" && !Array.isArray(o.active) ? Object.keys(o.active) : [],
			inactive: names(o.inactive),
			skipped: o.skipped && typeof o.skipped === "object" && !Array.isArray(o.skipped) ? Object.keys(o.skipped) : [],
			sent,
		});
	}
	return out.sort((a, b) => a.at - b.at);
}

/** jobs.json -> the 6 am report job (enabled), or null. */
export function reportJobOf(raw: unknown): { nextRunAt?: number } | null {
	const jobs = (raw as { jobs?: unknown } | null)?.jobs;
	if (!Array.isArray(jobs)) return null;
	for (const j of jobs) {
		const o = (j ?? {}) as { target?: unknown; enabled?: unknown; nextRunAt?: unknown };
		if (typeof o.target !== "string" || !/(^|\s)role-reports run(\s|$)/.test(o.target) || o.enabled === false) continue;
		return typeof o.nextRunAt === "number" && o.nextRunAt > 0 ? { nextRunAt: o.nextRunAt } : {};
	}
	return null;
}

/** A small JSON file read again only when it changed. */
class JsonFile<T> {
	private seen: { mtimeMs: number; size: number; value: T } | null = null;
	constructor(
		private readonly path: () => string,
		private readonly parse: (raw: unknown) => T,
		private readonly empty: T,
	) {}
	async get(): Promise<T> {
		const p = this.path();
		try {
			const st = await stat(p);
			if (st.size > 8 << 20) return this.empty;
			if (this.seen && this.seen.mtimeMs === st.mtimeMs && this.seen.size === st.size) return this.seen.value;
			const value = this.parse(JSON.parse(await readFile(p, "utf8")));
			this.seen = { mtimeMs: st.mtimeMs, size: st.size, value };
			return value;
		} catch {
			this.seen = null;
			return this.empty;
		}
	}
}

/** A report's text under its four headings (heading names without "## "), or null when it has none. */
export function reportSections(text: string): { heading: string; text: string }[] | null {
	const wanted = ROLE_REPORT_HEADINGS.map((h) => h.toLowerCase());
	const out: { heading: string; lines: string[] }[] = [];
	let cur: { heading: string; lines: string[] } | null = null;
	for (const line of text.split(/\r?\n/)) {
		const i = wanted.indexOf(line.trim().toLowerCase());
		if (i >= 0) {
			const heading = ROLE_REPORT_HEADINGS[i].slice(3);
			cur = out.find((s) => s.heading === heading) ?? null;
			if (!cur) {
				cur = { heading, lines: [] };
				out.push(cur);
			}
			continue;
		}
		cur?.lines.push(line);
	}
	if (!out.length) return null;
	return out.map((s) => ({ heading: s.heading, text: s.lines.join("\n").trim() }));
}

/** A report cut to `max` characters in all (the cut part ends with "…"). */
function cutReport(
	sections: { heading: string; text: string }[] | null,
	text: string,
	max: number,
): Pick<UiRoleReport, "sections" | "text" | "cut"> {
	if (!sections) return text.length > max ? { text: `${text.slice(0, max)}…`, cut: true } : { text };
	let left = max;
	let cut = false;
	const out: { heading: string; text: string }[] = [];
	for (const s of sections) {
		if (left <= 0) {
			cut = true;
			break;
		}
		if (s.text.length > left) {
			out.push({ heading: s.heading, text: `${s.text.slice(0, left)}…` });
			cut = true;
			left = 0;
			continue;
		}
		out.push(s);
		left -= s.text.length;
	}
	return { sections: out, ...(cut ? { cut: true } : {}) };
}

// ---------------------------------------------------------------------------
// Work mode and goals: the owner's fields, else the every-chat rules (read-only)
// ---------------------------------------------------------------------------

/** How a role works and its running goals: the owner's fields where set, else the rules' default. */
export function roleWorkMode(
	id: string,
	config: { workMode: WorkMode | null; goals: RoleGoal[] | null },
	now: number,
): Pick<UiRoleOverview, "workMode" | "workModeFrom" | "goals" | "goalsFrom" | "conflict"> {
	const rules: WorkMode = rulesWorkMode(id);
	const workMode = config.workMode ?? rules;
	const all = config.goals ?? rulesGoals(id);
	const goals: UiRoleGoal[] = all.filter((g) => !goalEnded(g, now)).map((g) => ({ ...g }));
	let conflict: string | undefined;
	if (config.workMode && config.workMode !== rules) {
		conflict =
			rules === "request-only"
				? "Set to start its own work, but the every-chat rules say it works on request. The page shows your setting; the rules still decide."
				: "Set to work on request, but the every-chat rules let it start its own work. The page shows your setting; the rules still decide.";
	}
	return {
		workMode,
		workModeFrom: config.workMode ? "owner" : "rules",
		goals,
		goalsFrom: config.goals ? "owner" : "rules",
		...(conflict ? { conflict } : {}),
	};
}

// ---------------------------------------------------------------------------
// The snapshot
// ---------------------------------------------------------------------------

/** What the reader needs from the app (AgentService). */
export interface RolesOverviewHost {
	identities(): IdentityDef[];
	/** Whether the chat with this transcript is working now (no chat is loaded for it). */
	chatState(file: string): ChatRuntime;
	/** The questions, dialogs and approvals waiting now. */
	asks(): Ask[];
	openRequestsTo(role: string): { open: number; newest?: UiRoleRequest };
	latestReportTo(role: string):
		| {
				id: string;
				date: string;
				at: number;
				state: RoleMessageState | "held";
				target?: string;
				scanFrom?: number;
				reply?: RoleReportReply;
				error?: string;
		  }
		| undefined;
	rolePaused(): boolean;
	/** The folders transcripts may be in. */
	sessionRoots(): string[];
	/** role-reports' runs.json and the scheduler's jobs.json. */
	reportRunsFile(): string;
	schedulerJobsFile(): string;
	now?(): number;
}

interface RoleTaskInfo {
	task: UiTaskQueueTask;
	file?: string;
	lines: UiTldrLine[];
	mtimeMs?: number;
}

/** Makes the Roles page's snapshot (cached reads; see the file comment). */
export class RolesOverviewReader {
	readonly scans = new TranscriptScans();
	private readonly paths: ChatPaths;
	private readonly runs: JsonFile<ReportRun[]>;
	private readonly job: JsonFile<{ nextRunAt?: number } | null>;
	/** Report texts by request id and check time (a report doesn't change once checked). */
	private readonly reportTexts = new Map<string, { text: string; at?: number; file: string }>();

	constructor(private readonly host: RolesOverviewHost) {
		this.paths = new ChatPaths(
			() => host.sessionRoots(),
			() => this.now(),
		);
		this.runs = new JsonFile(() => host.reportRunsFile(), reportRunsOf, []);
		this.job = new JsonFile(() => host.schedulerJobsFile(), reportJobOf, null);
	}

	private now(): number {
		return this.host.now?.() ?? Date.now();
	}

	async read(): Promise<UiRolesOverview> {
		const at = this.now();
		const defs = [...this.host.identities()].sort((a, b) => a.id.localeCompare(b.id));
		const asks = this.host.asks().filter((a) => a.kind !== "stuck");
		const runs = await this.runs.get();
		const job = await this.job.get();
		const keep = new Set<string>();
		const roles: UiRoleOverview[] = [];
		for (const def of defs) {
			roles.push(await this.role(def, at, asks, runs, job, keep));
		}
		this.scans.retain(keep);
		const all = roles.flatMap((r) => r.asks);
		return { at, roles, asks: sortAsks(all), paused: this.host.rolePaused(), reportTz: REPORT_TZ };
	}

	private async role(
		def: IdentityDef,
		now: number,
		liveAsks: Ask[],
		runs: ReportRun[],
		job: { nextRunAt?: number } | null,
		keep: Set<string>,
	): Promise<UiRoleOverview> {
		const problems: string[] = [];
		const mode = roleWorkMode(def.id, def.role.config, now);
		const home = def.homeChat ? await this.paths.check(def.homeChat) : null;
		if (def.homeChat && !home) problems.push("home chat");
		let homeLines: UiTldrLine[] = [];
		let tasks: UiTaskQueueTask[] = [];
		let running = false;
		let pausedReason: string | undefined;
		let stuckAt = new Map<number, number>();
		let lastActivity: number | undefined;
		if (home) {
			try {
				const s = await this.scans.read(home);
				keep.add(home);
				lastActivity = Math.round(s.mtimeMs);
				homeLines = tldrLinesFromEntries(s.tldr, TLDR_MAX_LINES);
				const q = taskQueueFromEntries(s.queue, true, Number.MAX_SAFE_INTEGER);
				tasks = q.tasks;
				running = q.running;
				pausedReason = q.pausedReason;
				stuckAt = s.stuckAt;
			} catch {
				problems.push("home chat");
			}
		}

		// Started tasks' own chats: their latest lines (and whether they are working).
		const infos: RoleTaskInfo[] = [];
		let chats = 0;
		for (const task of tasks) {
			if (task.status === "done") continue;
			const info: RoleTaskInfo = { task, lines: [] };
			infos.push(info);
			if (!task.chat?.file || !ACTIVE.has(task.status) || chats >= ROLES_TASK_CHATS_MAX) continue;
			chats++;
			const file = await this.paths.check(task.chat.file);
			if (!file) {
				problems.push(`task #${task.id} chat`);
				continue;
			}
			info.file = file;
			try {
				const s = await this.scans.read(file);
				keep.add(file);
				info.lines = tldrLinesFromEntries(s.tldr, TLDR_MAX_LINES);
				info.mtimeMs = s.mtimeMs;
				lastActivity = Math.max(lastActivity ?? 0, Math.round(s.mtimeMs));
			} catch {
				problems.push(`task #${task.id} chat`);
			}
		}
		const taskOfChat = (file: string | undefined) =>
			file ? tasks.find((t) => t.chat?.file && samePath(t.chat.file, file)) : undefined;

		const homeRef: UiRoleChatRef = { file: home ?? def.homeChat ?? "", where: "home" };
		const taskRef = (t: UiTaskQueueTask): UiRoleChatRef => ({
			file: t.chat?.file ?? homeRef.file,
			...(t.chat?.title ? { title: t.chat.title } : {}),
			where: t.id,
		});

		// TL;DR: the home chat's lines (a line copied up from a task chat keeps that chat) and the task
		// chats' own lines; a copy whose original is here too is left out.
		const tldr: UiRoleTldrLine[] = [];
		const own = new Set<string>();
		for (const info of infos) {
			for (const l of info.lines) {
				own.add(`${info.file}\n${l.text}`);
				tldr.push(lineOf(l, taskRef(info.task)));
			}
		}
		for (const l of homeLines) {
			const t = taskOfChat(l.chat?.file);
			if (t?.chat?.file && own.has(`${t.chat.file}\n${l.text}`)) continue;
			// A copy stays a home chat line (its id is there) that says which task it is about.
			const ref: UiRoleChatRef = t ? { file: homeRef.file, where: t.id } : homeRef;
			tldr.push(lineOf(l, ref));
		}
		tldr.sort((a, b) => b.ts - a.ts);

		// What waits on the owner.
		const asks: UiRoleAsk[] = [];
		const keyOf = (rest: string) => `${def.id}:${rest}`;
		for (const l of homeLines) {
			if (!l.needsYou || l.answered) continue;
			// A task's line: its task decides (stuck -> the task's ask; asking its main chat -> none).
			if (taskOfChat(l.chat?.file)) continue;
			asks.push({
				key: keyOf(`tldr:${l.id}`),
				role: def.id,
				kind: "tldr",
				text: l.text,
				...(l.ts > 0 ? { since: l.ts } : {}),
				chat: homeRef,
				focus: `tldr:${l.id}`,
			});
		}
		for (const info of infos) {
			const t = info.task;
			if (t.status !== "stuck") continue;
			const since = stuckAt.get(t.id);
			const line = newestWaiting([
				...info.lines,
				...homeLines.filter((l) => t.chat?.file && samePath(l.chat?.file, t.chat.file)),
			]);
			asks.push({
				key: keyOf(`task:${t.id}`),
				role: def.id,
				kind: "task",
				text: t.question || line?.text || t.plan.title,
				...(since ? { since } : line && line.ts > 0 ? { since: line.ts } : {}),
				// Answered in the queue's chat (its Queue tab), not the task's own chat.
				chat: { file: homeRef.file, where: t.id },
				focus: `task:${t.id}`,
			});
		}
		for (const a of liveAsks) {
			const file = a.sessionFile;
			if (!file) continue;
			let ref: UiRoleChatRef | undefined;
			let lines: UiTldrLine[] = [];
			if (home && samePath(file, home)) {
				ref = homeRef;
				lines = homeLines.filter((l) => !l.chat);
			} else {
				const info = infos.find((i) => i.file && samePath(i.file, file));
				if (info) {
					ref = { ...taskRef(info.task), file: info.file ?? file };
					lines = info.lines;
				}
			}
			if (!ref) continue;
			// The needs-you line its chat wrote for this question (just before it) is the same ask.
			const line = newestWaiting(lines.filter((l) => l.ts <= a.createdAt + 5_000));
			if (line) {
				const dup = asks.findIndex((x) => x.key === keyOf(`tldr:${line.id}`));
				if (dup >= 0) asks.splice(dup, 1);
			}
			const since = line && line.ts > 0 ? Math.min(line.ts, a.createdAt) : a.createdAt;
			asks.push({
				key: keyOf(`question:${a.id}`),
				role: def.id,
				kind: "question",
				text: line?.text || a.title,
				...(since > 0 ? { since } : {}),
				chat: ref,
				focus: `question:${a.id}`,
			});
		}

		// The queue in short.
		let queue: UiRoleQueue | undefined;
		if (tasks.length || pausedReason || running) {
			const active: UiRoleTask[] = [];
			const queued: UiRoleTask[] = [];
			let ready = 0;
			let done = 0;
			for (const t of tasks) {
				if (t.status === "done") {
					done++;
					continue;
				}
				if (t.status === "ready") {
					ready++;
					if (queued.length < ROLES_QUEUED_MAX) queued.push(taskOf(t));
					continue;
				}
				const info = infos.find((i) => i.task === t);
				const busy = info?.file ? this.host.chatState(info.file) === "working" : false;
				const latest = info?.lines.length ? info.lines[info.lines.length - 1] : undefined;
				active.push({
					...taskOf(t),
					...(busy ? { busy: true } : {}),
					...(latest ? { latest: lineOf(latest, taskRef(t)) } : {}),
				});
			}
			queue = {
				running,
				...(pausedReason ? { pausedReason } : {}),
				active,
				queued,
				counts: { active: active.length, queued: ready, done },
			};
		}

		// Its 6 am report.
		let report: UiRoleReport;
		try {
			report = await this.reportOf(def.id, runs, job);
		} catch {
			report = { state: "unavailable", error: "couldn't be read" };
			problems.push("report");
		}

		const requests = this.host.openRequestsTo(def.id);
		const homeBusy = home ? this.host.chatState(home) === "working" : false;
		const sortedAsks = sortAsks(asks);
		const status = statusOf({
			asks: sortedAsks.length,
			busy: homeBusy || (queue?.active.some((t) => t.busy || t.status === "working") ?? false),
			paused:
				!!queue &&
				!queue.running &&
				(queue.pausedReason === "user" || queue.pausedReason === "stopped") &&
				tasks.some((t) => t.status === "ready" || t.status === "waiting" || t.status === "blocked"),
			something: !!home && (homeLines.length > 0 || tasks.length > 0),
		});
		return {
			id: def.id,
			title: def.title,
			...(home ? { homeChat: { file: home } } : {}),
			...mode,
			status,
			...(lastActivity ? { lastActivity } : {}),
			...(homeBusy ? { homeBusy: true } : {}),
			asks: sortedAsks,
			tldr: tldr.slice(0, ROLES_TLDR_MAX),
			...(queue ? { queue } : {}),
			requests: { open: requests.open, ...(requests.newest ? { newest: requests.newest } : {}) },
			report,
			...(problems.length ? { problems } : {}),
		};
	}

	/** A role's latest 6 am report, or why there is none. */
	private async reportOf(role: string, runs: ReportRun[], job: { nextRunAt?: number } | null): Promise<UiRoleReport> {
		const rec = this.host.latestReportTo(role);
		const run = [...runs]
			.reverse()
			.find((r) => r.active.includes(role) || r.inactive.includes(role) || role in r.sent || r.skipped.includes(role));
		if (!run) {
			if (rec) return this.fromRecord(rec);
			if (job && !runs.length) return { state: "first", ...(job.nextRunAt ? { next: job.nextRunAt } : {}) };
			return { state: "not-in-job" };
		}
		if (rec && rec.date > run.date) return this.fromRecord(rec);
		if (run.inactive.includes(role)) return { state: "not-active", date: run.date, askedAt: run.at };
		if (run.skipped.includes(role) && !run.active.includes(role)) return { state: "not-in-job" };
		const sent = run.sent[role];
		if (sent?.error && !sent.id) return { state: "failed", date: run.date, askedAt: run.at, error: short(sent.error) };
		if (rec && rec.date === run.date) return this.fromRecord(rec);
		return { state: "pending", date: run.date, askedAt: run.at };
	}

	private async fromRecord(rec: NonNullable<ReturnType<RolesOverviewHost["latestReportTo"]>>): Promise<UiRoleReport> {
		const base = { date: rec.date, askedAt: rec.at };
		if (rec.state === "failed") return { state: "failed", ...base, ...(rec.error ? { error: short(rec.error) } : {}) };
		if (!rec.reply) return { state: "pending", ...base };
		if (!rec.reply.answered) return { state: "no-answer", ...base };
		const key = `${rec.id}:${rec.reply.at}`;
		let got = this.reportTexts.get(key);
		if (!got) {
			const file = rec.target ? await this.paths.check(rec.target) : null;
			if (!file) return { state: "unavailable", ...base, error: "the chat it was written in can't be read" };
			const r = await reportReplyText(file, rec.scanFrom ?? 0, rec.id);
			got = { text: r.text, file, ...(r.at !== undefined ? { at: r.at } : {}) };
			if (this.reportTexts.size > 200) this.reportTexts.clear();
			this.reportTexts.set(key, got);
		}
		if (!got.text) return { state: "unavailable", ...base, error: "the answer isn't in its chat any more" };
		return {
			state: "report",
			...base,
			...cutReport(reportSections(got.text), got.text, ROLES_REPORT_MAX),
			chat: { file: got.file },
			...(got.at !== undefined ? { messageAt: got.at } : {}),
		};
	}
}

function short(s: string): string {
	const line = s.split("\n")[0].trim();
	return line.length > 160 ? `${line.slice(0, 159)}…` : line;
}

function lineOf(l: UiTldrLine, chat: UiRoleChatRef): UiRoleTldrLine {
	return {
		id: l.id,
		text: l.text,
		ts: l.ts,
		...(l.needsYou && !l.answered ? { needsYou: true } : {}),
		...(l.needsYou && l.answered ? { answered: true } : {}),
		...(l.kind ? { kind: l.kind } : {}),
		chat,
	};
}

function newestWaiting(lines: UiTldrLine[]): UiTldrLine | undefined {
	let best: UiTldrLine | undefined;
	for (const l of lines) if (l.needsYou && !l.answered && (!best || l.ts >= best.ts)) best = l;
	return best;
}

function taskOf(t: UiTaskQueueTask): UiRoleTask {
	let waitsOn: string | undefined;
	if (t.status === "waiting" && t.wait?.what) waitsOn = t.wait.what;
	else if (t.status === "blocked" && t.block) {
		const on = (t.block.on ?? []).map((r) => taskRefLabel(r)).join(", ");
		waitsOn = [on, t.block.need].filter(Boolean).join("; ") || undefined;
	} else if (t.status === "ready" && t.waitingFor?.length) waitsOn = t.waitingFor.map((n) => `#${n}`).join(", ");
	return {
		id: t.id,
		status: t.status,
		title: t.plan.title,
		...(t.chat ? { chat: { file: t.chat.file, ...(t.chat.title ? { title: t.chat.title } : {}) } } : {}),
		...(waitsOn ? { waitsOn } : {}),
	};
}

/** Oldest first; an ask whose start isn't known goes last. */
function sortAsks(asks: UiRoleAsk[]): UiRoleAsk[] {
	return [...asks].sort((a, b) => {
		if (a.since === undefined || b.since === undefined) {
			if (a.since !== b.since) return a.since === undefined ? 1 : -1;
		} else if (a.since !== b.since) return a.since - b.since;
		return a.key.localeCompare(b.key);
	});
}

/** The first state that applies: needs you, busy, paused, idle, nothing yet. */
export function statusOf(s: { asks: number; busy: boolean; paused: boolean; something: boolean }): UiRoleStatus {
	if (s.asks > 0) return "needs-you";
	if (s.busy) return "busy";
	if (s.paused) return "paused";
	return s.something ? "idle" : "nothing-yet";
}

// ---------------------------------------------------------------------------
// Pushing it: to the windows that watch (the page: everything; the top bar: the count)
// ---------------------------------------------------------------------------

export interface RolesWatchOptions {
	/** How often to look again while a Roles page is open / while only top bars watch. */
	fullMs?: number;
	countMs?: number;
	/** Unchanged: a page still hears "checked at" this often. */
	heartbeatMs?: number;
	/** Several changes close together make one look. */
	debounceMs?: number;
	log?: (line: string) => void;
}

/** The windows watching the roles, keyed by their socket: looks again on a timer and on pokes. */
export class RolesWatch<K> {
	private readonly watchers = new Map<K, { full: boolean; send: (msg: ServerMessage) => void }>();
	private timer: ReturnType<typeof setTimeout> | null = null;
	private running: Promise<void> | null = null;
	private again = false;
	private last: { overview: UiRolesOverview; json: string; checkedAt: number; heard: number } | null = null;
	private lastError: string | null = null;
	private stopped = false;
	private readonly o: Required<Omit<RolesWatchOptions, "log">> & Pick<RolesWatchOptions, "log">;

	constructor(
		private readonly read: () => Promise<UiRolesOverview>,
		opts: RolesWatchOptions = {},
	) {
		this.o = {
			fullMs: opts.fullMs ?? 3_000,
			countMs: opts.countMs ?? 10_000,
			heartbeatMs: opts.heartbeatMs ?? 30_000,
			debounceMs: opts.debounceMs ?? 300,
			log: opts.log,
		};
	}

	/** This window wants everything (full) or just the count; it gets what is known at once. */
	watch(key: K, full: boolean, send: (msg: ServerMessage) => void): void {
		this.watchers.set(key, { full, send });
		const last = this.last;
		if (last) {
			const asks = last.overview.asks.length;
			send(
				full ? { type: "roles", overview: last.overview, asks, checkedAt: last.checkedAt } : { type: "roles", asks },
			);
		}
		this.schedule(last ? this.o.debounceMs : 0);
	}

	drop(key: K): void {
		this.watchers.delete(key);
		if (!this.watchers.size && this.timer) {
			clearTimeout(this.timer);
			this.timer = null;
		}
	}

	/** Something changed (role messages, a chat's state): look again soon. */
	poke(): void {
		if (this.watchers.size) this.schedule(this.o.debounceMs);
	}

	stop(): void {
		this.stopped = true;
		if (this.timer) clearTimeout(this.timer);
		this.timer = null;
		this.watchers.clear();
	}

	get watching(): number {
		return this.watchers.size;
	}

	private schedule(ms: number): void {
		if (this.stopped || !this.watchers.size) return;
		if (this.running) {
			this.again = true;
			return;
		}
		if (this.timer) clearTimeout(this.timer);
		this.timer = setTimeout(() => {
			this.timer = null;
			void this.look();
		}, ms);
		this.timer.unref?.();
	}

	/** Looks once (tests call it directly). */
	look(): Promise<void> {
		if (this.running) {
			this.again = true;
			return this.running;
		}
		this.running = (async () => {
			try {
				do {
					this.again = false;
					await this.lookOnce();
				} while (this.again && !this.stopped && this.watchers.size);
			} finally {
				this.running = null;
				const full = [...this.watchers.values()].some((w) => w.full);
				this.schedule(full ? this.o.fullMs : this.o.countMs);
			}
		})();
		return this.running;
	}

	private async lookOnce(): Promise<void> {
		if (!this.watchers.size) return;
		let overview: UiRolesOverview;
		try {
			overview = await this.read();
		} catch (err) {
			const error = (err as Error)?.message || String(err);
			if (error !== this.lastError) this.o.log?.(`[roles] couldn't make the overview: ${error}`);
			this.lastError = error;
			const asks = this.last?.overview.asks.length ?? 0;
			for (const w of this.watchers.values()) if (w.full) w.send({ type: "roles", asks, error });
			return;
		}
		this.lastError = null;
		const { at: _at, ...rest } = overview;
		const json = JSON.stringify(rest);
		const prev = this.last;
		const asks = overview.asks.length;
		const now = overview.at;
		if (prev && prev.json === json) {
			prev.checkedAt = now;
			if (now - prev.heard >= this.o.heartbeatMs) {
				prev.heard = now;
				for (const w of this.watchers.values()) if (w.full) w.send({ type: "roles", asks, checkedAt: now });
			}
			return;
		}
		const countChanged = !prev || prev.overview.asks.length !== asks;
		this.last = { overview, json, checkedAt: now, heard: now };
		for (const w of this.watchers.values()) {
			if (w.full) w.send({ type: "roles", overview, asks, checkedAt: now });
			else if (countChanged) w.send({ type: "roles", asks });
		}
	}
}
