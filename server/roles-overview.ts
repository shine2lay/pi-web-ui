/**
 * roles-overview: the Roles page's data: one snapshot with every role's state, made from what the app
 * already keeps:
 *   - the roles (identity.json: home chat, the owner's work mode and approved goals, the Focus line);
 *   - each role's home chat and its started task chats on disk: TL;DR lines and pi-queue entries, read
 *     once and then only the bytes added since (an unchanged file costs one stat); of a home chat also its
 *     newest model change (provider and model id, never message text);
 *   - the chats' runtime state (working or not) and the questions waiting now;
 *   - the whole role-message store (open requests, 6 am report requests), not just its last 100 rows;
 *   - the 6 am report job's runs (role-reports runs.json) and its scheduler job.
 *
 * It only reads: it loads no chat, starts no worker, calls no model and writes nothing.
 * What leaves it is display text only: TL;DR lines, task titles and questions, request first lines and
 * the report a role wrote for the owner, and its home chat's model name. Never raw entries, thinking, tool calls or results, prompts,
 * rules or notebooks. Every transcript it opens must be a plain .jsonl file inside the session folders
 * (no "..", no symlinks).
 */

import { lstat, open, realpath, stat, type FileHandle } from "node:fs/promises";
import { isAbsolute, resolve, sep } from "node:path";
import type { Ask } from "./asks.js";
import { goalEnded, type RoleGoal, type WorkMode } from "./identity-config.js";
import { focusPart, identityFilePath, samePath, type IdentityDef } from "./identities.js";
import { readUpTo, STATE_READ_FLAGS } from "./state-file-read.js";
import type {
	ServerMessage,
	UiBoard,
	UiRoleAsk,
	UiRoleBoardOrder,
	UiRoleChatRef,
	UiRoleConfigHistory,
	UiRoleGoal,
	UiRoleOverview,
	UiRoleQueue,
	UiRoleOpenPair,
	UiRoleReport,
	UiRoleRequest,
	UiRoleSent,
	UiRolesOverview,
	UiMessageApprovals,
	UiOwnerContact,
	UiRoleStatus,
	UiRoleTask,
	UiRoleTaskOwing,
	UiRoleTldrLine,
	UiTaskQueue,
	UiTaskQueueHold,
	UiTaskQueueTask,
	UiTaskParent,
	UiTldrLine,
} from "./protocol.js";
import {
	ROLE_REPORT_HEADINGS,
	ROLE_REPORT_HEADINGS_BEFORE,
	reportReplyText,
	type RoleMessageState,
	type RoleReportReply,
} from "./role-messages.js";
import { rulesGoals, rulesWorkMode } from "./role-rules.js";
import { readRoleSpend } from "./roles-spend.js";
import { readRoleInstructions } from "./roles-instructions.js";
import { roleSettingsOf, type RoleSettings } from "./roles-config-history.js";
import { roleAnswerKindAllowed } from "./roles-asks.js";
import { roleTaskNext } from "./roles-task-next.js";
import { requesterOf } from "./queue-requester.js";
import {
	TASK_QUEUE_ENTRY_TYPE,
	taskQueueFromEntries,
	taskQueueHeld,
	taskQueueLaneUse,
	taskRefLabel,
	type TaskQueueEntryLike,
} from "./task-queue.js";
import { WorkRecordsFile } from "./work-records.js";
import { RolesEvidence, type EvidenceView, type RolesEvidencePaths } from "./roles-evidence.js";
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
/** queue-drop: how many of a role's dropped tasks the Roles page gets (newest first). */
export const ROLES_DROPPED_MAX = 5;
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
	/** Native session-header queue ID; never inferred from a path or role home name. */
	sessionId?: string;
	/** Task id -> the time of its latest "stuck" entry (when it started waiting on the owner). */
	stuckAt: Map<number, number>;
	/** A needs-you line came after the last kept reply (only then is a reply worth keeping). */
	waiting: boolean;
	/** roles-model: the newest model change written to it (provider and model id only). */
	model?: { provider: string; modelId: string };
}

type LineKind = "session" | "tldr" | "queue" | "user" | "replyTool" | "model";

/** What a transcript line is, from its first bytes (null: nothing the page needs). */
export function lineKind(head: string): LineKind | null {
	if (head.startsWith('{"type":"session"')) return "session";
	// roles-model: the SDK's model change entry (no message text in it).
	if (head.startsWith('{"type":"model_change"')) return "model";
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
		if (kind === "session") {
			if (s.offset === 0 && e.type === "session" && typeof e.id === "string" && e.id.length > 0) s.sessionId = e.id;
			return;
		}
		if (kind === "model") {
			// roles-model: a later change replaces an earlier one (lines are read in file order).
			if (e.type === "model_change" && modelPart(e.provider) && modelPart(e.modelId)) {
				s.model = { provider: e.provider, modelId: e.modelId };
			}
			return;
		}
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

/** roles-model: a provider or model id as the SDK writes it: short, no control characters. */
function modelPart(value: unknown): value is string {
	return typeof value === "string" && value.length > 0 && value.length <= 200 && !/[\u0000-\u001f\u007f]/.test(value);
}

/** roles-model: the most the page gets of a model's name. */
export const ROLE_MODEL_MAX = 120;

/** roles-model: a model name fit for the page (trimmed, short, no control characters), else undefined. */
export function roleModelLabel(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const text = value.trim();
	return text && text.length <= ROLE_MODEL_MAX && !/[\u0000-\u001f\u007f]/.test(text) ? text : undefined;
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

/** The most a small JSON file (the report runs, the scheduler's jobs) may hold before it reads as empty. */
export const JSON_FILE_MAX = 8 << 20;

/** A small JSON file read again only when it changed. Read as the registry's log is (state-file-read.ts): a
 *  FIFO, device or folder in its place, or one bigger than 8 MiB (also when it grows while read), reads as
 *  empty at once. */
export class JsonFile<T> {
	private seen: { mtimeMs: number; size: number; value: T } | null = null;
	constructor(
		private readonly path: () => string,
		private readonly parse: (raw: unknown) => T,
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
			if (!st.isFile() || st.size > JSON_FILE_MAX) {
				this.seen = null;
				return this.empty;
			}
			if (this.seen && this.seen.mtimeMs === st.mtimeMs && this.seen.size === st.size) return this.seen.value;
			const bytes = await readUpTo(fh, JSON_FILE_MAX, 1 << 20);
			if (bytes === null) {
				this.seen = null;
				return this.empty;
			}
			const value = this.parse(JSON.parse(bytes.toString("utf8")));
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

/** The headings a report is split by: today's four, then the ones asked for before 2026-10-06 (a report
 *  stays on the Roles page for days, so one written under the old headings still shows in parts). */
const REPORT_HEADINGS_READ: readonly string[] = [
	...new Set<string>([...ROLE_REPORT_HEADINGS, ...ROLE_REPORT_HEADINGS_BEFORE]),
];

/** A report's text under its four headings (heading names without "## "), or null when it has none. */
export function reportSections(text: string): { heading: string; text: string }[] | null {
	const wanted = REPORT_HEADINGS_READ.map((h) => h.toLowerCase());
	const out: { heading: string; lines: string[] }[] = [];
	let cur: { heading: string; lines: string[] } | null = null;
	for (const line of text.split(/\r?\n/)) {
		const i = wanted.indexOf(line.trim().toLowerCase());
		if (i >= 0) {
			const heading = REPORT_HEADINGS_READ[i].slice(3);
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
// ladder-alarm: the approval step for long role-message chains
// ---------------------------------------------------------------------------

/** The approval step's own state (RoleMessageGuardHost.state) plus when this server started, as the host
 *  hands it over. Only read, never changed. */
export interface RolesApprovalsState {
	status: string;
	reason?: string;
	since?: number;
}

const APPROVALS_REASON_MAX = 300;

/** What the Roles page gets: "ready" -> on; "degraded" -> off, with its reason (one line, clipped) and the
 *  server's start; "starting", anything else or nothing -> nothing, so nothing shows. */
export function approvalsOf(state: RolesApprovalsState | null | undefined): UiMessageApprovals | undefined {
	if (!state || typeof state !== "object") return undefined;
	if (state.status === "ready") return { on: true };
	if (state.status !== "degraded") return undefined;
	let reason = typeof state.reason === "string" ? state.reason.replace(/\s+/g, " ").trim() : "";
	if (reason.length > APPROVALS_REASON_MAX) reason = `${reason.slice(0, APPROVALS_REASON_MAX - 1)}\u2026`;
	const since = state.since;
	const sinceOk = typeof since === "number" && Number.isSafeInteger(since) && since > 0;
	return { on: false, ...(reason ? { reason } : {}), ...(sinceOk ? { since } : {}) };
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
	/** roles-sent: a role's open requests and questions to the receivers `keep` lets through (absent: none read). */
	openRequestsFrom?(role: string, keep: (to: string) => boolean): UiRoleSent;
	/** roles-sent: every sender → receiver pair with open requests or questions (absent: none read). */
	openPairs?(): UiRoleOpenPair[];
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
	/** board (task #76): the roles' shared board for the page (absent: none in this app). */
	board?(): UiBoard;
	/** board: a role's open orders it hasn't marked done. */
	boardOrdersOf?(role: string): UiRoleBoardOrder[];
	/** The folders transcripts may be in. */
	sessionRoots(): string[];
	/** role-reports' runs.json and the scheduler's jobs.json. */
	reportRunsFile(): string;
	schedulerJobsFile(): string;
	/** roles-panel: the work registry's log (pi-work-management's events.jsonl); absent: none is read. */
	workFile?(): string;
	/** owner-contacts (Roles D3): the owner's messages to role home chats, newest first; absent: none. */
	ownerContacts?(): UiOwnerContact[];
	/** roles-model: the model name the open chat with this transcript shows in its header (its live state).
	 *  undefined: it isn't open; null: it is open without a model. Loads nothing. */
	chatModel?(file: string): string | null | undefined;
	/** roles-model: a model's name in the app's model list (as a chat's header shows it), when known. */
	modelName?(provider: string, modelId: string): string | undefined;
	/** roles-instructions: the every-chat rules file pi loads (AGENTS.md); absent: no instructions state. */
	agentsFile?(): string;
	/** roles-evidence (task #207): wt's records and pi-web-deploy's folders; absent: no evidence is read. */
	evidencePaths?(): RolesEvidencePaths;
	/** roles-config-history (Ops #209): a role's recorded settings changes; absent or undefined: none recorded. */
	configHistory?(role: string): UiRoleConfigHistory | undefined;
	/** ladder-alarm: the approval step's state and this server's start; absent or undefined: nothing shown. */
	messageApprovals?(): RolesApprovalsState | undefined;
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
	/** roles-panel: the work registry's initiatives and projects. */
	private readonly work: WorkRecordsFile | null;
	/** Report texts by request id and check time (a report doesn't change once checked). */
	private readonly reportTexts = new Map<string, { text: string; at?: number; file: string }>();
	/** roles-evidence: wt's and pi-web-deploy's records, for the working tasks' Completion evidence. */
	private readonly evidence: RolesEvidence | null;

	constructor(private readonly host: RolesOverviewHost) {
		this.paths = new ChatPaths(
			() => host.sessionRoots(),
			() => this.now(),
		);
		this.runs = new JsonFile(() => host.reportRunsFile(), reportRunsOf, []);
		this.job = new JsonFile(() => host.schedulerJobsFile(), reportJobOf, null);
		const workFile = host.workFile?.bind(host);
		this.work = workFile ? new WorkRecordsFile(workFile) : null;
		const evidencePaths = host.evidencePaths?.bind(host);
		this.evidence = evidencePaths ? new RolesEvidence(evidencePaths) : null;
	}

	private now(): number {
		return this.host.now?.() ?? Date.now();
	}

	async read(): Promise<UiRolesOverview> {
		const at = this.now();
		const defs = [...this.host.identities()].sort((a, b) => a.id.localeCompare(b.id));
		const live = this.host.asks();
		const asks = live.filter((a) => a.kind !== "stuck");
		// roles-answer: a stuck task's ask, so the page can answer it there (its id rides on the task's item).
		const stuck = live.filter((a) => a.kind === "stuck");
		const runs = await this.runs.get();
		const job = await this.job.get();
		const keep = new Set<string>();
		const roles: UiRoleOverview[] = [];
		let evidence: EvidenceView | undefined;
		try {
			evidence = this.evidence ? await this.evidence.load() : undefined;
		} catch {
			evidence = undefined;
		}
		// roles-sent: only roles on the page count, as senders and as receivers.
		const onPage = new Set(defs.map((d) => d.id));
		const listed = (id: string) => onPage.has(id);
		for (const def of defs) {
			const row = await this.role(def, at, asks, runs, job, keep, stuck, evidence);
			let sent: UiRoleSent | undefined;
			try {
				sent = this.host.openRequestsFrom?.(def.id, listed);
			} catch {
				sent = undefined;
			}
			// roles-config-history: what changed in its settings (the recorder's record; this only reads it).
			let configHistory: UiRoleConfigHistory | undefined;
			try {
				configHistory = this.host.configHistory?.(def.id);
			} catch {
				configHistory = undefined;
			}
			roles.push({ ...row, ...(sent ? { sent } : {}), ...(configHistory ? { configHistory } : {}) });
		}
		let openPairs: UiRoleOpenPair[] | undefined;
		try {
			openPairs = this.host.openPairs?.().filter((p) => p.from !== p.to && listed(p.from) && listed(p.to));
		} catch {
			openPairs = undefined;
		}
		this.scans.retain(keep);
		const work = this.work ? await this.work.get() : undefined;
		const all = roles.flatMap((r) => r.asks);
		let board: UiBoard | undefined;
		try {
			board = this.host.board?.();
		} catch {
			board = undefined;
		}
		let contacts: UiOwnerContact[] | undefined;
		try {
			contacts = this.host.ownerContacts?.();
		} catch {
			contacts = undefined;
		}
		let approvals: UiMessageApprovals | undefined;
		try {
			approvals = approvalsOf(this.host.messageApprovals?.());
		} catch {
			approvals = undefined;
		}
		return {
			at,
			roles,
			asks: sortAsks(all),
			paused: this.host.rolePaused(),
			reportTz: REPORT_TZ,
			...(board ? { board } : {}),
			...(work ? { work } : {}),
			...(contacts ? { contacts } : {}),
			...(openPairs ? { openPairs } : {}),
			...(approvals ? { approvals } : {}),
		};
	}

	private async role(
		def: IdentityDef,
		now: number,
		liveAsks: Ask[],
		runs: ReportRun[],
		job: { nextRunAt?: number } | null,
		keep: Set<string>,
		stuckAsks: Ask[] = [],
		evidence?: EvidenceView,
	): Promise<UiRoleOverview> {
		const problems: string[] = [];
		const mode = roleWorkMode(def.id, def.role.config, now);
		const home = def.homeChat ? await this.paths.check(def.homeChat) : null;
		if (def.homeChat && !home) problems.push("home chat");
		let homeLines: UiTldrLine[] = [];
		let tasks: UiTaskQueueTask[] = [];
		let running = false;
		let pausedReason: string | undefined;
		// queue-paused: the owner's pause on the whole queue.
		let queueHold: UiTaskQueueHold | undefined;
		// roles-lanes: lanes at once and in use, as the Queue panel counts them (only when the queue was read).
		let laneUse: UiRoleQueue["lanes"];
		let stuckAt = new Map<number, number>();
		let lastActivity: number | undefined;
		// roles-model: the home chat's newest recorded model change (used when the chat isn't open).
		let recordedModel: TranscriptScan["model"];
		if (home) {
			try {
				const s = await this.scans.read(home);
				keep.add(home);
				lastActivity = Math.round(s.mtimeMs);
				recordedModel = s.model;
				homeLines = tldrLinesFromEntries(s.tldr, TLDR_MAX_LINES);
				const q = taskQueueFromEntries(s.queue, true, Number.MAX_SAFE_INTEGER, undefined, s.sessionId);
				tasks = q.tasks;
				running = q.running;
				pausedReason = q.pausedReason;
				queueHold = q.hold;
				laneUse = taskQueueLaneUse(q);
				stuckAt = s.stuckAt;
			} catch {
				problems.push("home chat");
			}
		}

		// Started tasks' own chats: their latest lines (and whether they are working).
		const infos: RoleTaskInfo[] = [];
		let chats = 0;
		for (const task of tasks) {
			if (task.status === "done" || task.status === "dropped") continue;
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
		// queue-paused: the owner's pause a task is under (its own or its queue's); a paused task never
		// counts as needing him.
		const heldOf = (t: UiTaskQueueTask | undefined) => (t ? taskQueueHeld(t, { hold: queueHold }) : undefined);

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
			const quiet = !!heldOf(info.task);
			for (const l of info.lines) {
				own.add(`${info.file}\n${l.text}`);
				tldr.push(lineOf(l, taskRef(info.task), quiet));
			}
		}
		for (const l of homeLines) {
			const t = taskOfChat(l.chat?.file);
			if (t?.chat?.file && own.has(`${t.chat.file}\n${l.text}`)) continue;
			// A copy stays a home chat line (its id is there) that says which task it is about.
			const ref: UiRoleChatRef = t ? { file: homeRef.file, where: t.id } : homeRef;
			tldr.push(lineOf(l, ref, !!heldOf(t)));
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
			if (t.status !== "stuck" || heldOf(t)) continue;
			const since = stuckAt.get(t.id);
			const line = newestWaiting([
				...info.lines,
				...homeLines.filter((l) => t.chat?.file && samePath(l.chat?.file, t.chat.file)),
			]);
			// roles-answer: its ask is the one about this task number in the chat its answer goes into (the
			// queue's chat, or a lane task's own chat).
			const target = t.lane ? t.chat?.file : home;
			const matches = stuckAsks.filter(
				(a) => a.task?.id === t.id && !!target && !!a.sessionFile && samePath(a.sessionFile, target),
			);
			const live = matches.length === 1 ? matches[0] : undefined;
			asks.push({
				key: keyOf(`task:${t.id}`),
				role: def.id,
				kind: "task",
				text: t.question || line?.text || t.plan.title,
				...(since ? { since } : line && line.ts > 0 ? { since: line.ts } : {}),
				// Answered in the queue's chat (its Queue tab), not the task's own chat.
				chat: { file: homeRef.file, where: t.id },
				focus: `task:${t.id}`,
				...(live ? { askId: live.id } : {}),
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
				// queue-paused: a question in a paused task's chat doesn't count as needing the owner.
				if (info && !heldOf(info.task)) {
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
				// Keep unrecognised dialogs visible through Open chat, without a page-answer target.
				...(roleAnswerKindAllowed(a) ? { askId: a.id } : {}),
			});
		}

		// The queue in short.
		let queue: UiRoleQueue | undefined;
		if (tasks.length || pausedReason || running || queueHold) {
			const active: UiRoleTask[] = [];
			const queued: UiRoleTask[] = [];
			let ready = 0;
			let done = 0;
			// roles-links (Ops #222): every open task by where it belongs, the listed ones and the rest alike.
			const links: NonNullable<UiRoleQueue["links"]> = { project: 0, initiative: 0, standalone: 0, unrecorded: 0 };
			// queue-drop: the tasks its lead dropped, with why (newest first).
			const dropped = tasks
				.filter((t) => t.status === "dropped")
				.sort((a, b) => (b.dropped?.at ?? 0) - (a.dropped?.at ?? 0));
			for (const t of tasks) {
				if (t.status === "done") {
					done++;
					continue;
				}
				if (t.status === "dropped") continue;
				links[linkOf(t.parent)]++;
				const held = heldOf(t);
				if (t.status === "ready") {
					ready++;
					if (queued.length < ROLES_QUEUED_MAX) queued.push(taskOf(t, def.id, held));
					continue;
				}
				const info = infos.find((i) => i.task === t);
				const busy = info?.file ? this.host.chatState(info.file) === "working" : false;
				const latest = info?.lines.length ? info.lines[info.lines.length - 1] : undefined;
				// roles-evidence: its own chat's records only (a task with no chat yet has none). Past the
				// ROLES_TASK_CHATS_MAX chats read for TL;DR lines, its queue record still names its chat: only the
				// name is compared, no chat is read.
				let ev: UiRoleTask["evidence"];
				try {
					const file = info?.file ?? t.chat?.file;
					ev = evidence ? await evidence.of({ file, status: t.status, doneAt: t.doneAt }) : undefined;
				} catch {
					ev = undefined;
				}
				active.push({
					...taskOf(t, def.id, held),
					...(busy ? { busy: true } : {}),
					...(latest ? { latest: lineOf(latest, taskRef(t), !!held) } : {}),
					...(ev ? { evidence: ev } : {}),
				});
			}
			queue = {
				running,
				...(pausedReason ? { pausedReason } : {}),
				...(queueHold ? { hold: queueHold } : {}),
				active,
				queued,
				...(dropped.length ? { dropped: dropped.slice(0, ROLES_DROPPED_MAX).map((t) => taskOf(t, def.id)) } : {}),
				// dropped only when it has some, so a queue with none reads exactly as before.
				counts: { active: active.length, queued: ready, done, ...(dropped.length ? { dropped: dropped.length } : {}) },
				...(laneUse ? { lanes: laneUse } : {}),
				links,
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
		let boardOrders: UiRoleBoardOrder[] = [];
		try {
			boardOrders = this.host.boardOrdersOf?.(def.id) ?? [];
		} catch {
			problems.push("board");
		}
		const homeBusy = home ? this.host.chatState(home) === "working" : false;
		const model = home ? this.modelOf(home, recordedModel) : undefined;
		const sortedAsks = sortAsks(asks);
		const status = statusOf({
			asks: sortedAsks.length,
			// queue-paused: a paused task's record keeps saying working; only its chat at work counts then.
			busy: homeBusy || (queue?.active.some((t) => t.busy || (t.status === "working" && !t.paused)) ?? false),
			paused:
				(!!queue &&
					!queue.running &&
					(queue.pausedReason === "user" || queue.pausedReason === "stopped") &&
					tasks.some((t) => t.status === "ready" || t.status === "waiting" || t.status === "blocked")) ||
				// queue-paused: the owner paused the queue or one of its open tasks.
				tasks.some((t) => !!heldOf(t)),
			something: !!home && (homeLines.length > 0 || tasks.length > 0),
		});
		return {
			id: def.id,
			title: def.title,
			...(home ? { homeChat: { file: home } } : {}),
			...(model ? { model } : {}),
			...mode,
			status,
			...(lastActivity ? { lastActivity } : {}),
			...(homeBusy ? { homeBusy: true } : {}),
			asks: sortedAsks,
			tldr: tldr.slice(0, ROLES_TLDR_MAX),
			...(queue ? { queue } : {}),
			requests: { open: requests.open, ...(requests.newest ? { newest: requests.newest } : {}) },
			report,
			spend: await readRoleSpend(def.dir, now),
			...(this.host.agentsFile
				? { instructions: await readRoleInstructions(def.dir, home, this.host.agentsFile()) }
				: {}),
			...(boardOrders.length ? { boardOrders } : {}),
			...(problems.length ? { problems } : {}),
		};
	}

	/** roles-model: the home chat's model as its header shows it: the open chat's live model, else the newest
	 *  model change in its file named from the app's model list. Unknown: undefined ("Not recorded"). */
	private modelOf(home: string, recorded: TranscriptScan["model"]): string | undefined {
		try {
			const live = this.host.chatModel?.(home);
			if (live !== undefined) return roleModelLabel(live);
			return recorded ? roleModelLabel(this.host.modelName?.(recorded.provider, recorded.modelId)) : undefined;
		} catch {
			return undefined;
		}
	}

	/** roles-config-history (Ops #209): every role's settings as the page shows them, for the recorder
	 *  (roles-config-history.ts). Reads like read() (cached) and writes nothing; a part it can't read now is left
	 *  out, so the recorder keeps that part's last value. */
	async configSettings(): Promise<Map<string, RoleSettings>> {
		const out = new Map<string, RoleSettings>();
		const now = this.now();
		for (const def of this.host.identities()) {
			let queue: UiTaskQueue | undefined;
			let model: string | undefined;
			const home = def.homeChat ? await this.paths.check(def.homeChat) : null;
			if (home) {
				try {
					const s = await this.scans.read(home);
					queue = taskQueueFromEntries(s.queue, true, Number.MAX_SAFE_INTEGER, undefined, s.sessionId);
					model = this.modelOf(home, s.model);
				} catch {
					queue = undefined;
				}
			}
			out.set(
				def.id,
				roleSettingsOf({
					title: def.title,
					focus: focusPart(identityFilePath(def, "about")).focus,
					workMode: roleWorkMode(def.id, def.role.config, now).workMode,
					goals: def.role.config.goals ?? rulesGoals(def.id),
					homeChat: def.homeChat,
					queue,
					model,
				}),
			);
		}
		return out;
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

/** quiet (queue-paused): the line is from a task the owner paused: it doesn't say it needs him. */
function lineOf(l: UiTldrLine, chat: UiRoleChatRef, quiet = false): UiRoleTldrLine {
	return {
		id: l.id,
		text: l.text,
		ts: l.ts,
		...(l.needsYou && !l.answered && !quiet ? { needsYou: true } : {}),
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

/** roles-links (Ops #222): which count an open task goes into: the parent its queue entry names, as its row
 *  shows it (taskOf's parent); none recorded = unrecorded. */
function linkOf(parent: UiTaskParent | undefined): keyof NonNullable<UiRoleQueue["links"]> {
	if (!parent) return "unrecorded";
	if ("project" in parent) return "project";
	if ("initiative" in parent) return "initiative";
	return "standalone";
}

function taskOf(t: UiTaskQueueTask, department: string, held?: UiTaskQueueHold): UiRoleTask {
	const display = roleTaskNext(t, department, held);
	const requester = requesterOf(t.origin);
	const queued = t.status === "ready" ? roleTaskNext(t, department).next : undefined;
	let waitsOn: string | undefined;
	if (t.status === "waiting" && t.wait?.what) waitsOn = t.wait.what;
	else if (t.status === "blocked" && t.block) {
		const on = (t.block.on ?? []).map((r) => taskRefLabel(r)).join(", ");
		waitsOn = [on, t.block.need].filter(Boolean).join("; ") || undefined;
	} else if (queued?.after?.length) waitsOn = queued.after.join(", ");
	return {
		id: t.id,
		status: t.status,
		title: t.plan.title,
		...display,
		...(requester ? { requester } : {}),
		...(t.chat ? { chat: { file: t.chat.file, ...(t.chat.title ? { title: t.chat.title } : {}) } } : {}),
		...(t.status === "dropped" && t.dropped ? { dropped: { why: t.dropped.why, at: t.dropped.at } } : {}),
		...(waitsOn ? { waitsOn } : {}),
		...(t.status === "asking" && t.askOps ? { askOps: true, ...(t.askLead ? { askLead: t.askLead } : {}) } : {}),
		...(held ? { paused: { at: held.at, why: held.why } } : {}),
		// roles-panel: where it belongs (its queue entry), and a lead block's who, what, when and reminders.
		...(t.parent ? { parent: { ...t.parent } } : {}),
		...(t.status === "blocked" && t.block?.lead ? { owing: owingOf(t.block, t.block.lead) } : {}),
	};
}

/** roles-panel: a blocked task's lead block as the Roles page shows it. */
function owingOf(b: NonNullable<UiTaskQueueTask["block"]>, lead: string): UiRoleTaskOwing {
	return {
		lead,
		...(b.owes ? { owes: b.owes } : {}),
		...(b.checkpoint ? { due: b.checkpoint } : {}),
		reminders: b.reminders?.length ?? 0,
		// Recorded ([] too: then the owner is next); absent until the queue's chat records it.
		...(b.chain ? { chain: [...b.chain] } : {}),
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

/**
 * One window's watch. A full watcher's first overview may be the last one built (sent at once on watch); the window
 * counts its data as current only once a later check reaches it (pages-live, Ops #244), so the first look that
 * finishes after the watch confirms it even when nothing changed, instead of leaving it to the heartbeat.
 */
interface RolesWatcher {
	full: boolean;
	send: (msg: ServerMessage) => void;
	/** checkedAt of the first overview this window got; null until it got one. */
	firstAt: number | null;
	/** A newer check reached it after its first overview. */
	confirmed: boolean;
}

/** The windows watching the roles, keyed by their socket: looks again on a timer and on pokes. */
export class RolesWatch<K> {
	private readonly watchers = new Map<K, RolesWatcher>();
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
		const watcher: RolesWatcher = { full, send, firstAt: null, confirmed: false };
		this.watchers.set(key, watcher);
		const last = this.last;
		if (last) {
			const asks = last.overview.asks.length;
			send(
				full ? { type: "roles", overview: last.overview, asks, checkedAt: last.checkedAt } : { type: "roles", asks },
			);
			if (full) watcher.firstAt = last.checkedAt;
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
			const beat = now - prev.heard >= this.o.heartbeatMs;
			if (beat) prev.heard = now;
			for (const w of this.watchers.values()) {
				if (!w.full) continue;
				const confirms = !w.confirmed && w.firstAt !== null && now > w.firstAt;
				if (!beat && !confirms) continue;
				w.send({ type: "roles", asks, checkedAt: now });
				if (confirms) w.confirmed = true;
			}
			return;
		}
		const countChanged = !prev || prev.overview.asks.length !== asks;
		this.last = { overview, json, checkedAt: now, heard: now };
		for (const w of this.watchers.values()) {
			if (w.full) {
				w.send({ type: "roles", overview, asks, checkedAt: now });
				if (w.firstAt === null) w.firstAt = now;
				else if (now > w.firstAt) w.confirmed = true;
			} else if (countChanged) w.send({ type: "roles", asks });
		}
	}
}
