/**
 * decision-records (task #83, Data rm-541b44a1; owner: "a more centralized way to see the initiative's
 * design decision being made"): every record a decision can hide in, kept as it happens and without the
 * 1,000-message limit of role-messages.json, so the decisions page has complete material.
 *
 * Store: <dataDir>/decisions/records.jsonl, append-only, one JSON line per record, deduped by
 * (source, ref). Text only, no cap. Four sources:
 *   - message: a role message, when it is sent (role-messages.ts);
 *   - board:   a Board post or order, when it is posted (role-board.ts);
 *   - answer:  the owner's answer to a question, a pop-up or a queued task that needed him (asks.ts);
 *   - plan:    a queue plan added, changed or done (pi-queue's "queue" entries in the chats' transcripts,
 *              read incrementally about once a minute; offsets in <dataDir>/decisions/scan-state.json).
 * A backfill reads the same things from what is kept (role-messages.json, role-board.json and the
 * transcripts) from a day on. Transcripts are only ever read here.
 */
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { open, readdir, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { Ask, AskFieldAnswer } from "./asks.js";
import type { UiBoardPost } from "./protocol.js";
import type { RoleMessageRecord } from "./role-messages.js";

export const DECISIONS_DIR = "decisions";
export const RECORDS_FILE = "records.jsonl";
export const SCAN_STATE_FILE = "scan-state.json";
/** How often the transcripts are read for new queue entries. */
export const PLAN_SCAN_MS = 60_000;
/** The backfill's default first day (local midnight). */
export const BACKFILL_FROM_DEFAULT = "2026-10-03";

// ---------------------------------------------------------------------------
// The initiative tag (same rule as pi-queue's task initiative, task #82)
// ---------------------------------------------------------------------------

export const INITIATIVE_MAX = 60;
export const INITIATIVE_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** undefined = left out; "" (or spaces) = none; else a short id or an error. */
export function checkInitiative(raw: unknown): { ok: true; value?: string } | { ok: false; error: string } {
	if (raw === undefined || raw === null) return { ok: true };
	if (typeof raw !== "string") return { ok: false, error: "initiative must be text: a short id" };
	const v = raw.trim();
	if (!v) return { ok: true, value: "" };
	if (v.length <= INITIATIVE_MAX && INITIATIVE_ID.test(v)) return { ok: true, value: v };
	const shown = v.length > 70 ? `${v.slice(0, 69)}…` : v;
	return {
		ok: false,
		error: `initiative: "${shown}" isn't a short id. Use lowercase letters and digits, with a dash between words (like "team-in-temper"), at most ${INITIATIVE_MAX} characters`,
	};
}

// ---------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------

export type DecisionSource = "message" | "board" | "answer" | "plan";

export interface AnswerQuestion {
	id: string;
	header?: string;
	question: string;
	detail?: string;
	options: { label: string; description?: string }[];
	/** The choices picked (their labels). */
	picked: string[];
	/** What was typed instead of (or as well as) a choice. */
	typed?: string;
}

export interface PlanFields {
	title?: string;
	goal?: string;
	doneWhen?: string;
	decided?: string;
	steps?: string;
	verify?: string;
	mustNot?: string;
}

export interface DecisionRecord {
	v: 1;
	/** "dr-" + a hash of source and ref: the same thing gets the same id, live or backfilled. */
	id: string;
	source: DecisionSource;
	/** When it happened (ms). */
	at: number;
	/** A role id, or "owner". */
	from: string;
	/** A role id, role ids, or "all". */
	to?: string | string[];
	initiative?: string;
	/** rm-…, bp-…, ask:<tool call id>, dlg:/stuck:<chat file>…, or <chat file>:<line> for plans. */
	ref: string;
	/** live = kept when it happened; backfill = read back later. */
	how: "live" | "backfill";
	/** When this line was written. */
	seen: number;

	// message
	kind?: string;
	text?: string;
	replyTo?: string;
	/** message: the sender's chat ("home chat", "Queue #N", …); answer/plan: the chat's title. */
	chat?: string;
	/** message, backfilled from a delivered copy: `at` is when it arrived, not when it was sent. */
	atIs?: "delivered";

	// board
	title?: string;
	ownerWords?: string;
	via?: string;

	// answer
	ask?: "question" | "dialog" | "stuck";
	body?: string;
	questions?: AnswerQuestion[];
	/** Where the owner answered: browser, telegram, … */
	answeredIn?: string;
	/** Chat transcript (basename) the record came from. */
	file?: string;
	/** answer, backfilled: "<ask line>-><answer line>" in `file`. */
	lines?: string;

	// plan
	task?: number;
	op?: "add" | "update" | "done";
	plan?: PlanFields;
	approval?: string;
	summary?: string;
	/** plan: the queue entry's id. */
	entry?: string;
}

export type NewDecisionRecord = Omit<DecisionRecord, "v" | "id" | "seen" | "how"> & { how?: DecisionRecord["how"] };

export function recordId(source: string, ref: string): string {
	return `dr-${createHash("sha1").update(`${source}\0${ref}`).digest("hex").slice(0, 12)}`;
}

const keyOf = (source: string, ref: string): string => `${source}\0${ref}`;

export interface RecordFilter {
	since?: number;
	until?: number;
	source?: DecisionSource;
	initiative?: string;
}

export class DecisionRecords {
	readonly dir: string;
	readonly file: string;
	private readonly keys = new Set<string>();
	/** message ref -> initiative (a reply without one takes its original's). */
	private readonly messageInitiative = new Map<string, string>();
	private loaded = false;

	constructor(
		dir: string,
		private readonly opts: { now?: () => number; log?: (line: string) => void } = {},
	) {
		this.dir = dir;
		this.file = join(dir, RECORDS_FILE);
	}

	private now(): number {
		return this.opts.now ? this.opts.now() : Date.now();
	}

	/** Read the keys of what is kept (once). A last line cut off by a crash is ended, not dropped. */
	load(): void {
		if (this.loaded) return;
		this.loaded = true;
		if (!existsSync(this.file)) return;
		const raw = readFileSync(this.file, "utf8");
		for (const r of parseLines(raw)) this.remember(r);
		if (raw.length > 0 && !raw.endsWith("\n")) appendFileSync(this.file, "\n");
	}

	private remember(r: DecisionRecord): void {
		this.keys.add(keyOf(r.source, r.ref));
		if (r.source === "message" && r.initiative) this.messageInitiative.set(r.ref, r.initiative);
	}

	has(source: DecisionSource, ref: string): boolean {
		this.load();
		return this.keys.has(keyOf(source, ref));
	}

	/** The initiative a kept role message carries. */
	messageInitiativeOf(ref: string): string | undefined {
		this.load();
		return this.messageInitiative.get(ref);
	}

	/** Keep it, unless the same (source, ref) is kept already. True when it was added. */
	append(rec: NewDecisionRecord): boolean {
		this.load();
		const key = keyOf(rec.source, rec.ref);
		if (this.keys.has(key)) return false;
		const full: DecisionRecord = {
			v: 1,
			id: recordId(rec.source, rec.ref),
			...stripEmpty(rec),
			how: rec.how ?? "live",
			seen: this.now(),
		} as DecisionRecord;
		mkdirSync(this.dir, { recursive: true });
		appendFileSync(this.file, JSON.stringify(full) + "\n");
		this.remember(full);
		return true;
	}

	/** Everything kept that fits, oldest first (by `at`). */
	list(filter: RecordFilter = {}): DecisionRecord[] {
		if (!existsSync(this.file)) return [];
		const seen = new Set<string>();
		const out: DecisionRecord[] = [];
		for (const r of parseLines(readFileSync(this.file, "utf8"))) {
			const k = keyOf(r.source, r.ref);
			if (seen.has(k)) continue;
			seen.add(k);
			if (filter.source && r.source !== filter.source) continue;
			if (filter.initiative && r.initiative !== filter.initiative) continue;
			if (filter.since !== undefined && r.at < filter.since) continue;
			if (filter.until !== undefined && r.at >= filter.until) continue;
			out.push(r);
		}
		return out.sort((a, b) => a.at - b.at);
	}

	/** Records per local day and source: { "2026-10-09": { message: 12, … } }. */
	counts(filter: RecordFilter = {}): Record<string, Partial<Record<DecisionSource, number>>> {
		const out: Record<string, Partial<Record<DecisionSource, number>>> = {};
		for (const r of this.list(filter)) {
			const day = localDay(r.at);
			const row = (out[day] ??= {});
			row[r.source] = (row[r.source] ?? 0) + 1;
		}
		return out;
	}
}

function parseLines(raw: string): DecisionRecord[] {
	const out: DecisionRecord[] = [];
	for (const line of raw.split("\n")) {
		if (!line.trim()) continue;
		try {
			const r = JSON.parse(line) as DecisionRecord;
			if (r && typeof r.source === "string" && typeof r.ref === "string") out.push(r);
		} catch {
			/* a line cut off by a crash: skipped */
		}
	}
	return out;
}

function stripEmpty<T extends object>(o: T): T {
	const out: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(o)) {
		if (v === undefined || v === null || v === "") continue;
		if (Array.isArray(v) && v.length === 0 && k !== "picked" && k !== "options") continue;
		out[k] = v;
	}
	return out as T;
}

export function localDay(ms: number): string {
	const d = new Date(ms);
	return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** "YYYY-MM-DD" -> local midnight (ms), or undefined. */
export function dayStart(day: string): number | undefined {
	const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day.trim());
	if (!m) return undefined;
	const t = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime();
	return Number.isFinite(t) ? t : undefined;
}

// ---------------------------------------------------------------------------
// Builders (live and backfill share them, so both write the same record)
// ---------------------------------------------------------------------------

export function messageRecord(r: RoleMessageRecord, how: DecisionRecord["how"] = "live"): NewDecisionRecord {
	return {
		source: "message",
		at: r.at,
		from: r.from.role,
		to: r.to.role,
		ref: r.id,
		how,
		kind: r.kind,
		text: r.text,
		...(r.replyTo ? { replyTo: r.replyTo } : {}),
		...(r.from.chat ? { chat: r.from.chat } : {}),
		...(r.initiative ? { initiative: r.initiative } : {}),
	};
}

export function boardRecord(p: UiBoardPost, how: DecisionRecord["how"] = "live"): NewDecisionRecord {
	return {
		source: "board",
		at: p.at,
		from: p.from,
		to: p.to,
		ref: p.id,
		how,
		kind: p.kind,
		title: p.title,
		text: p.text,
		...(p.ownerWords ? { ownerWords: p.ownerWords } : {}),
		...(p.via ? { via: p.via } : {}),
		...(p.initiative ? { initiative: p.initiative } : {}),
	};
}

/** The ref of an answered ask: the tool call for a question, else the chat, the ask and when it came. */
export function answerRef(ask: Ask): string {
	const file = ask.sessionFile ? basename(ask.sessionFile) : "?";
	if (ask.kind === "question")
		return ask.toolCallId ? `ask:${ask.toolCallId}` : `ask:${file}:${ask.id}@${ask.createdAt}`;
	if (ask.kind === "stuck") return `stuck:${file}#${ask.task?.id ?? "?"}@${ask.createdAt}`;
	return `dlg:${file}:${ask.id}@${ask.createdAt}`;
}

/** The owner's answer to an ask (approvals are not decisions here: undefined). Without per-field answers,
 *  a one-field ask's summary is matched against its choices: a choice = picked, else typed. */
export function answerRecord(
	ask: Ask,
	outcome: { summary: string; from: string; answers?: AskFieldAnswer[] },
	at: number,
	role?: string | null,
): NewDecisionRecord | undefined {
	if (ask.kind === "approval") return undefined;
	const questions: AnswerQuestion[] = ask.fields.map((f) => {
		const labelOf = (v: string): string =>
			[...f.options, ...Object.values(f.optionsMap ?? {}).flat()].find((o) => o.value === v)?.label ?? v;
		let picked: string[] = [];
		let typed: string | undefined;
		const a = outcome.answers?.find((x) => x.id === f.id);
		if (a) {
			picked = a.selected.map(labelOf);
			typed = a.text?.trim() || undefined;
		} else if (!outcome.answers && ask.fields.length === 1) {
			const s = outcome.summary.trim();
			if (f.options.some((o) => o.label === s)) picked = [s];
			else if (s) typed = s;
		}
		return {
			id: f.id,
			...(f.header ? { header: f.header } : {}),
			question: f.text,
			...(f.detail ? { detail: f.detail } : {}),
			options: f.options.map((o) => ({ label: o.label, ...(o.description ? { description: o.description } : {}) })),
			picked,
			...(typed ? { typed } : {}),
		};
	});
	return {
		source: "answer",
		at,
		from: "owner",
		...(role ? { to: role } : {}),
		ref: answerRef(ask),
		ask: ask.kind,
		title: ask.title,
		...(ask.body ? { body: ask.body } : {}),
		questions,
		summary: outcome.summary,
		answeredIn: outcome.from,
		...(ask.conversationTitle ? { chat: ask.conversationTitle } : {}),
		...(ask.sessionFile ? { file: basename(ask.sessionFile) } : {}),
		...(ask.task ? { task: ask.task.id } : {}),
	};
}

const PLAN_KEYS: (keyof PlanFields)[] = ["title", "goal", "doneWhen", "decided", "steps", "verify", "mustNot"];

function planFields(raw: unknown): PlanFields | undefined {
	if (!raw || typeof raw !== "object") return undefined;
	const out: PlanFields = {};
	for (const k of PLAN_KEYS) {
		const v = (raw as Record<string, unknown>)[k];
		if (typeof v === "string" && v.trim()) out[k] = v;
	}
	return Object.keys(out).length ? out : undefined;
}

/** A queue entry's data (pi-queue: { v, op, id, ts, … }). */
export interface QueueEntryData {
	op?: unknown;
	id?: unknown;
	ts?: unknown;
	plan?: unknown;
	approval?: unknown;
	initiative?: unknown;
	summary?: unknown;
}

/** Per chat file: each task's initiative so far (an add sets it, an update changes or clears it). */
export type TaskInitiatives = Record<string, string>;

/** A queue entry -> a plan record (add, update, done only; others: undefined). Updates `inits`. */
export function planRecord(
	entry: { id?: unknown; timestamp?: unknown; data?: QueueEntryData },
	ctx: { file: string; line: number; role?: string | null; chat?: string; inits: TaskInitiatives },
	how: DecisionRecord["how"] = "live",
): NewDecisionRecord | undefined {
	const d = entry.data ?? {};
	const op = d.op;
	if (op !== "add" && op !== "update" && op !== "done") return undefined;
	const task = typeof d.id === "number" ? d.id : Number(d.id);
	if (!Number.isFinite(task)) return undefined;
	const key = String(task);
	if (op === "add") {
		if (typeof d.initiative === "string" && d.initiative.trim()) ctx.inits[key] = d.initiative.trim();
		else delete ctx.inits[key];
	} else if (op === "update" && typeof d.initiative === "string") {
		if (d.initiative.trim()) ctx.inits[key] = d.initiative.trim();
		else delete ctx.inits[key];
	}
	const at =
		typeof d.ts === "number"
			? d.ts
			: typeof entry.timestamp === "string"
				? Date.parse(entry.timestamp)
				: Number(entry.timestamp);
	const plan = op === "done" ? undefined : planFields(d.plan);
	const file = basename(ctx.file);
	return {
		source: "plan",
		at: Number.isFinite(at) ? at : 0,
		from: ctx.role || "unknown",
		ref: `${file}:${ctx.line}`,
		how,
		file,
		...(ctx.chat ? { chat: ctx.chat } : {}),
		task,
		op,
		...(plan ? { plan } : {}),
		...(op !== "done" && typeof d.approval === "string" ? { approval: d.approval } : {}),
		...(ctx.inits[key] ? { initiative: ctx.inits[key] } : {}),
		...(op === "done" && typeof d.summary === "string" ? { summary: d.summary } : {}),
		...(typeof entry.id === "string" ? { entry: entry.id } : {}),
	};
}

// ---------------------------------------------------------------------------
// Reading transcripts (read only, from an offset)
// ---------------------------------------------------------------------------

const CHUNK = 1 << 20;
const NL = 10;

/** Read `file` from `offset` (the start of line `line` + 1) to its last complete line; call `onLine` for
 *  each line holding one of `markers`. Returns where the next read starts. */
export async function readLinesFrom(
	file: string,
	offset: number,
	line: number,
	markers: readonly string[],
	onLine: (text: string, lineNo: number) => void | Promise<void>,
): Promise<{ offset: number; line: number }> {
	const marks = markers.map((m) => Buffer.from(m));
	const fh = await open(file, "r");
	try {
		const size = (await fh.stat()).size;
		let pos = offset;
		let carry: Buffer[] = [];
		let carryLen = 0;
		let lineStart = offset;
		let lineNo = line;
		let done = { offset, line };
		const buf = Buffer.allocUnsafe(CHUNK);
		while (pos < size) {
			const { bytesRead } = await fh.read(buf, 0, Math.min(CHUNK, size - pos), pos);
			if (bytesRead <= 0) break;
			const chunk = buf.subarray(0, bytesRead);
			let start = 0;
			for (;;) {
				const nl = chunk.indexOf(NL, start);
				if (nl < 0) break;
				const piece = chunk.subarray(start, nl);
				const whole = carryLen ? Buffer.concat([...carry, piece], carryLen + piece.length) : piece;
				carry = [];
				carryLen = 0;
				lineNo++;
				if (marks.some((m) => whole.indexOf(m) >= 0)) await onLine(whole.toString("utf8"), lineNo);
				start = nl + 1;
				lineStart = pos + start;
				done = { offset: lineStart, line: lineNo };
			}
			if (start < bytesRead) {
				const rest = Buffer.from(chunk.subarray(start));
				carry.push(rest);
				carryLen += rest.length;
			}
			pos += bytesRead;
		}
		return done;
	} finally {
		await fh.close();
	}
}

/** The chats' transcripts: <root>/<project dir>/*.jsonl, or <root>/*.jsonl (PI_CODING_AGENT_SESSION_DIR's flat
 *  layout); not deeper (subagent artifacts). */
export async function transcriptFiles(root: string): Promise<string[]> {
	const out: string[] = [];
	let entries: import("node:fs").Dirent[];
	try {
		entries = await readdir(root, { withFileTypes: true });
	} catch {
		return out;
	}
	for (const ent of entries) {
		if (ent.isFile() && ent.name.endsWith(".jsonl")) {
			out.push(join(root, ent.name));
			continue;
		}
		if (!ent.isDirectory()) continue;
		const dir = join(root, ent.name);
		let names: string[];
		try {
			names = await readdir(dir);
		} catch {
			continue;
		}
		for (const n of names) if (n.endsWith(".jsonl")) out.push(join(dir, n));
	}
	return out.sort();
}

const QUEUE_MARK = '"customType":"queue"';

// ---------------------------------------------------------------------------
// Live: the queue scanner
// ---------------------------------------------------------------------------

interface FileScan {
	ino: number;
	offset: number;
	line: number;
	inits: TaskInitiatives;
}

interface ScanState {
	v: 1;
	/** Entries before this were for the backfill (set at the first scan). */
	floor: number;
	files: Record<string, FileScan>;
}

export interface ChatLookup {
	/** The role each chat file belongs to (null = none). */
	roleOf(files: string[]): Promise<Map<string, string | null>>;
	/** The chat's title, when known. */
	chatOf?(file: string): string | undefined;
}

export class QueueScanner {
	private state: ScanState | undefined;
	private running: Promise<number> | undefined;
	private timer: ReturnType<typeof setInterval> | undefined;

	constructor(
		private readonly store: DecisionRecords,
		private readonly opts: ChatLookup & {
			root: () => string;
			statePath: string;
			now?: () => number;
			log?: (line: string) => void;
		},
	) {}

	private now(): number {
		return this.opts.now ? this.opts.now() : Date.now();
	}

	private loadState(): ScanState {
		if (this.state) return this.state;
		try {
			const s = JSON.parse(readFileSync(this.opts.statePath, "utf8")) as ScanState;
			if (s && s.v === 1 && typeof s.floor === "number" && s.files) return (this.state = s);
		} catch {
			/* first run */
		}
		return (this.state = { v: 1, floor: this.now(), files: {} });
	}

	private saveState(): void {
		if (!this.state) return;
		mkdirSync(dirname(this.opts.statePath), { recursive: true });
		const tmp = `${this.opts.statePath}.tmp`;
		writeFileSync(tmp, JSON.stringify(this.state));
		renameSync(tmp, this.opts.statePath);
	}

	/** Every minute (unref'd). */
	start(everyMs = PLAN_SCAN_MS): void {
		if (this.timer) return;
		void this.scan();
		this.timer = setInterval(() => void this.scan(), everyMs);
		this.timer.unref?.();
	}

	stop(): void {
		if (this.timer) clearInterval(this.timer);
		this.timer = undefined;
	}

	/** One pass over the transcripts (one at a time). Returns how many records it added. */
	scan(): Promise<number> {
		if (this.running) return this.running;
		this.running = this.scanOnce()
			.catch((err) => {
				this.opts.log?.(`[decisions] queue scan failed: ${(err as Error).message}`);
				return 0;
			})
			.finally(() => {
				this.running = undefined;
			});
		return this.running;
	}

	private async scanOnce(): Promise<number> {
		const state = this.loadState();
		const files = await transcriptFiles(this.opts.root());
		const work: { file: string; prev: FileScan | undefined; ino: number; size: number }[] = [];
		for (const file of files) {
			let st;
			try {
				st = await stat(file);
			} catch {
				continue;
			}
			const prev = state.files[file];
			if (prev && prev.ino === st.ino && prev.offset === st.size) continue;
			work.push({ file, prev, ino: st.ino, size: st.size });
		}
		if (!work.length) return 0;
		const roles = await this.opts.roleOf(work.map((w) => w.file)).catch(() => new Map<string, string | null>());
		let added = 0;
		for (const w of work) {
			const fresh = !w.prev || w.prev.ino !== w.ino || w.prev.offset > w.size;
			const fs: FileScan = fresh
				? { ino: w.ino, offset: 0, line: 0, inits: {} }
				: { ...w.prev!, inits: { ...w.prev!.inits } };
			try {
				const next = await readLinesFrom(w.file, fs.offset, fs.line, [QUEUE_MARK], (text, lineNo) => {
					const e = parseEntry(text);
					if (!e || e.type !== "custom" || e.customType !== "queue") return;
					const rec = planRecord(
						e,
						{ file: w.file, line: lineNo, role: roles.get(w.file), chat: this.opts.chatOf?.(w.file), inits: fs.inits },
						"live",
					);
					if (rec && rec.at >= state.floor && this.store.append(rec)) added++;
				});
				fs.offset = next.offset;
				fs.line = next.line;
				state.files[w.file] = fs;
			} catch (err) {
				this.opts.log?.(`[decisions] couldn't read ${basename(w.file)}: ${(err as Error).message}`);
			}
		}
		this.saveState();
		if (added) this.opts.log?.(`[decisions] ${added} queue plan record(s) kept`);
		return added;
	}
}

function parseEntry(text: string): Record<string, any> | undefined {
	try {
		const e = JSON.parse(text);
		return e && typeof e === "object" ? e : undefined;
	} catch {
		return undefined;
	}
}

// ---------------------------------------------------------------------------
// Backfill
// ---------------------------------------------------------------------------

export const ROLE_MESSAGE_HEADER =
	/^\[Role message (rm-[0-9a-f]{8}) from ([a-z][a-z0-9-]*) \((.*?)\), sent from its (.*?) · (.+?)\]$/;

export interface BackfillCounts {
	message: number;
	board: number;
	answer: number;
	plan: number;
	files: number;
}

export interface BackfillProgress {
	running: boolean;
	from: string;
	startedAt?: number;
	endedAt?: number;
	filesDone: number;
	filesTotal: number;
	added: BackfillCounts;
	error?: string;
}

/** The role message a delivered copy carries (header, text, and no hint line), or undefined. */
export function parseDeliveredRoleMessage(
	text: string,
): { id: string; from: string; chat: string; kind: string; replyTo?: string; text: string } | undefined {
	const nl = text.indexOf("\n");
	const head = (nl < 0 ? text : text.slice(0, nl)).trim();
	const m = ROLE_MESSAGE_HEADER.exec(head);
	if (!m) return undefined;
	const what = m[5]!;
	const reply = /^reply to (rm-[0-9a-f]{8})$/.exec(what);
	let body = nl < 0 ? "" : text.slice(nl + 1).replace(/^\n/, "");
	const hint = body.lastIndexOf("\n\n(");
	if (hint >= 0 && body.trimEnd().endsWith(")")) body = body.slice(0, hint);
	return {
		id: m[1]!,
		from: m[2]!,
		chat: m[4]!,
		kind: reply ? "reply" : what,
		...(reply ? { replyTo: reply[1] } : {}),
		text: body.trim(),
	};
}

function firstText(content: unknown): string | undefined {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return undefined;
	for (const c of content) if (c && c.type === "text" && typeof c.text === "string") return c.text;
	return undefined;
}

function entryTime(e: Record<string, any>): number {
	const m = e.message?.timestamp;
	if (typeof m === "number") return m;
	const t = typeof e.timestamp === "string" ? Date.parse(e.timestamp) : Number(e.timestamp);
	return Number.isFinite(t) ? t : 0;
}

export interface BackfillSources extends ChatLookup {
	root: string;
	/** role-messages.json and role-board.json (missing = skipped). */
	roleMessagesFile: string;
	roleBoardFile: string;
	onProgress?(p: BackfillProgress): void;
}

const BACKFILL_MARKS = [
	QUEUE_MARK,
	'"name":"message_role"',
	'"toolName":"message_role"',
	'"name":"ask_user_question"',
	'"toolName":"ask_user_question"',
	"[Role message rm-",
];

/**
 * Fill the store from `from` (ms) on, from what is kept: role-messages.json (report requests skipped),
 * role-board.json, and the transcripts changed since then: queue plans, ask_user_question answers,
 * message_role calls (sender's side), then delivered copies of role messages for any the others lack.
 * Idempotent: everything is deduped by ref.
 */
export async function backfill(
	store: DecisionRecords,
	src: BackfillSources,
	from: number,
	fromDay: string,
): Promise<BackfillProgress> {
	const p: BackfillProgress = {
		running: true,
		from: fromDay,
		startedAt: Date.now(),
		filesDone: 0,
		filesTotal: 0,
		added: { message: 0, board: 0, answer: 0, plan: 0, files: 0 },
	};
	const add = (rec: NewDecisionRecord | undefined): void => {
		if (rec && rec.at >= from && store.append({ ...rec, how: "backfill" })) p.added[rec.source]++;
	};
	try {
		for (const r of readJson<{ messages?: RoleMessageRecord[] }>(src.roleMessagesFile)?.messages ?? []) {
			if (r && r.kind !== "report" && typeof r.id === "string") add(messageRecord(r, "backfill"));
		}
		for (const post of readJson<{ posts?: UiBoardPost[] }>(src.roleBoardFile)?.posts ?? []) {
			if (post && typeof post.id === "string") add(boardRecord(post, "backfill"));
		}
		src.onProgress?.(p);

		const files: string[] = [];
		for (const f of await transcriptFiles(src.root)) {
			try {
				if ((await stat(f)).mtimeMs >= from) files.push(f);
			} catch {
				/* gone */
			}
		}
		p.filesTotal = files.length;
		const roles = await src.roleOf(files).catch(() => new Map<string, string | null>());
		/** Delivered copies, kept for after every sender's side was read. */
		const delivered: NewDecisionRecord[] = [];
		for (const file of files) {
			const role = roles.get(file) ?? null;
			const base = basename(file);
			const chat = src.chatOf?.(file);
			const inits: TaskInitiatives = {};
			const calls = new Map<string, { name: string; args: any; line: number }>();
			try {
				await readLinesFrom(file, 0, 0, BACKFILL_MARKS, (text, lineNo) => {
					const e = parseEntry(text);
					if (!e) return;
					if (e.type === "custom" && e.customType === "queue") {
						add(planRecord(e, { file, line: lineNo, role, chat, inits }, "backfill"));
						return;
					}
					const m = e.message;
					// An fyi added without a turn: { type: "custom_message", customType: "role-message", content }.
					if (e.customType === "role-message") {
						const d = parseDeliveredRoleMessage(firstText(e.content) ?? "");
						if (d) delivered.push(deliveredRecord(d, entryTime(e), role));
						return;
					}
					if (!m || typeof m !== "object") return;
					if (m.role === "assistant" && Array.isArray(m.content)) {
						for (const c of m.content) {
							if (c?.type === "toolCall" && (c.name === "message_role" || c.name === "ask_user_question"))
								calls.set(String(c.id), { name: c.name, args: c.arguments ?? {}, line: lineNo });
						}
						return;
					}
					if (m.role === "user") {
						const d = parseDeliveredRoleMessage(firstText(m.content) ?? "");
						if (d) delivered.push(deliveredRecord(d, entryTime(e), role));
						return;
					}
					if (m.role !== "toolResult" || m.isError) return;
					const call = calls.get(String(m.toolCallId));
					if (!call) return;
					if (m.toolName === "message_role" && call.name === "message_role") {
						const det = m.details ?? {};
						if (typeof det.id !== "string") return;
						const a = call.args;
						add({
							source: "message",
							at: entryTime(e),
							from: role || "unknown",
							to: String(det.to ?? a.to ?? ""),
							ref: det.id,
							kind: String(det.kind ?? a.kind ?? ""),
							text: typeof a.text === "string" ? a.text.trim() : "",
							...(typeof a.replyTo === "string" && a.replyTo.trim() ? { replyTo: a.replyTo.trim() } : {}),
							...(typeof a.initiative === "string" && a.initiative.trim() ? { initiative: a.initiative.trim() } : {}),
							file: base,
						});
					} else if (m.toolName === "ask_user_question" && call.name === "ask_user_question") {
						add(
							questionRecordFromTranscript(call.args, m.details, String(m.toolCallId), entryTime(e), {
								role,
								chat,
								file: base,
								lines: `${call.line}->${lineNo}`,
							}),
						);
					}
				});
				p.added.files++;
			} catch (err) {
				src.onProgress?.({ ...p, error: `couldn't read ${base}: ${(err as Error).message}` });
			}
			p.filesDone++;
			if (p.filesDone % 10 === 0) src.onProgress?.(p);
		}
		// A message whose sender's side wasn't found: its delivered copy (the earliest one).
		delivered.sort((a, b) => a.at - b.at);
		for (const d of delivered) add(d);
	} catch (err) {
		p.error = (err as Error).message;
	}
	p.running = false;
	p.endedAt = Date.now();
	src.onProgress?.(p);
	return p;
}

function deliveredRecord(
	d: NonNullable<ReturnType<typeof parseDeliveredRoleMessage>>,
	at: number,
	role: string | null,
): NewDecisionRecord {
	return {
		source: "message",
		at,
		atIs: "delivered",
		from: d.from,
		...(role ? { to: role } : {}),
		ref: d.id,
		kind: d.kind,
		text: d.text,
		...(d.replyTo ? { replyTo: d.replyTo } : {}),
		chat: d.chat,
	};
}

/** An ask_user_question call and its result in a transcript -> an answer record. */
export function questionRecordFromTranscript(
	args: any,
	details: any,
	toolCallId: string,
	at: number,
	ctx: { role: string | null; chat?: string; file: string; lines?: string },
): NewDecisionRecord | undefined {
	const qs: any[] = Array.isArray(args?.questions) ? args.questions : [];
	const answers: any[] = Array.isArray(details?.answers) ? details.answers : [];
	if (!qs.length || !answers.length) return undefined;
	const questions: AnswerQuestion[] = qs.map((q, i) => {
		const id = typeof q?.id === "string" ? q.id : String(i);
		const a = answers.find((x) => x?.id === id);
		const typed = typeof a?.custom === "string" && a.custom.trim() ? a.custom.trim() : undefined;
		return {
			id,
			...(typeof q?.header === "string" && q.header ? { header: q.header } : {}),
			question: String(q?.question ?? ""),
			...(typeof q?.detail === "string" && q.detail ? { detail: q.detail } : {}),
			options: (Array.isArray(q?.options) ? q.options : []).map((o: any) => ({
				label: String(o?.label ?? ""),
				...(typeof o?.description === "string" && o.description ? { description: o.description } : {}),
			})),
			picked: Array.isArray(a?.selected) ? a.selected.map(String) : [],
			...(typeof typed === "string" ? { typed } : {}),
		};
	});
	const summary = questions
		.map((q) => [...q.picked, ...(q.typed ? [q.typed] : [])].join(", "))
		.filter(Boolean)
		.join("; ");
	return {
		source: "answer",
		at,
		from: "owner",
		...(ctx.role ? { to: ctx.role } : {}),
		ref: `ask:${toolCallId}`,
		ask: "question",
		questions,
		summary,
		...(ctx.chat ? { chat: ctx.chat } : {}),
		file: ctx.file,
		...(ctx.lines ? { lines: ctx.lines } : {}),
	};
}

function readJson<T>(file: string): T | undefined {
	try {
		return JSON.parse(readFileSync(file, "utf8")) as T;
	} catch {
		return undefined;
	}
}
