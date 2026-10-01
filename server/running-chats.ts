/**
 * carry-on: the live list of chats that are working, and the note each of them gets after
 * pi-web-ui comes back from a restart (planned or a crash).
 *
 * The list lives in <dataDir>/running-chats.json and is written as turns start and end and as
 * tools start and stop, so it is right even after a kill -9. At a graceful shutdown it is frozen
 * first (with a shutdown mark): the runs that the shutdown itself aborts stay in the list.
 *
 * At startup the server reads the list of the process before it and plans the carry-on:
 *   - every chat in it is reopened and sent the carry-on note (a normal user message), so it
 *     checks where it stopped and carries on by itself;
 *   - cut-offs are counted per chat until it finishes a turn, crashes and planned stops apart: a
 *     chat cut off by its LOOP_GUARD_CUTOFFS-th crash (no shutdown mark) gets no note, only a notice
 *     for the user (so a chat that brings the server down can't loop); planned stops (installs,
 *     pi-web-deploy restarts) don't count towards that, only towards PLANNED_CUTOFF_CEILING;
 *   - why the server restarted: the reason pi-web-deploy left in restart-reason.json, "a restart"
 *     for any other planned stop, and "it crashed or was killed" when the old process left no
 *     shutdown mark.
 * Chats that were idle, or that the user stopped (their turn ended), are not in the list.
 *
 * Everything here is plain file handling and text; agent-service.ts feeds the events and does the
 * reopening.
 */
import {
	closeSync,
	existsSync,
	fstatSync,
	openSync,
	readFileSync,
	readSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";

export const RUNNING_CHATS_FILE = "running-chats.json";
/** Written by pi-web-deploy just before it restarts the service: { reason, at }. */
export const RESTART_REASON_FILE = "restart-reason.json";
/** Every carry-on note starts with this (pi-queue keys on it to pick its queue back up). */
export const CARRY_ON_PREFIX = "pi-web-ui restarted at";
/** The crash cut-off that gets a notice instead of a note (the 3rd without a turn finishing in between). */
export const LOOP_GUARD_CUTOFFS = 3;
/**
 * The planned cut-off (a stop that left its shutdown mark) that gets a notice instead of a note (the
 * 10th without a turn finishing in between). Installs restart the server often, and a queued task's
 * whole job is one long turn, so planned stops only stop a chat that keeps restarting the server itself.
 */
export const PLANNED_CUTOFF_CEILING = 10;
/** A restart reason older than this belongs to some earlier restart. */
export const REASON_FRESH_MS = 15 * 60_000;

export interface RunningTool {
	id: string;
	name: string;
	/** What it works on, one line: the bash command, the path, the pattern… */
	detail?: string;
}

export interface RunningChat {
	sessionFile: string;
	title: string;
	cwd: string;
	/** When this turn started (ms). */
	startedAt: number;
	/** Restarts that cut this chat off in a row, without a turn finishing in between (both kinds). */
	cutoffs: number;
	/** Of those, the crashes (no shutdown mark). Missing in a list an older build wrote. */
	crashes?: number;
	/** Of those, the planned stops (shutdown mark). Missing in a list an older build wrote. */
	planned?: number;
	/** Tools running now. Empty = the model is writing (or thinking about) its reply. */
	tools: RunningTool[];
	/** The step as text, when it came from the transcript rather than live events. */
	step?: string;
	/** Carried over from the last restart; its carry-on turn hasn't started yet. */
	awaiting?: boolean;
}

export interface RunningChatsFile {
	v: 1;
	pid: number;
	/** Set when the process stopped on purpose (SIGTERM/SIGINT/restart_service). */
	shutdown?: { at: number; signal: string };
	chats: RunningChat[];
}

/** A chat's cut-offs without a turn finishing in between: all of them, and the two kinds. */
export interface CutoffCounts {
	cutoffs: number;
	crashes: number;
	planned: number;
}

/** A chat that gets the carry-on note, with its counts including this cut-off. */
export interface CarryOnItem extends CutoffCounts {
	chat: RunningChat;
	note: string;
}

/** A chat left alone (a notice instead of a note), with its counts including this cut-off. */
export interface GuardedItem extends CutoffCounts {
	chat: RunningChat;
	/** The limit it reached: LOOP_GUARD_CUTOFFS crashes, or PLANNED_CUTOFF_CEILING planned stops. */
	why: "crashes" | "planned";
}

export interface CarryOnPlan {
	/** Why the server restarted, as the note says it. */
	reason: string;
	/** "planned" or "crash": whether the old process stopped on purpose. */
	kind: "planned" | "crash";
	at: number;
	carry: CarryOnItem[];
	/** At a limit (LOOP_GUARD_CUTOFFS crashes, PLANNED_CUTOFF_CEILING planned stops): a notice instead of a note. */
	guarded: GuardedItem[];
}

// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------

function oneLine(text: string, max: number): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** The one-line detail of a tool call: what a person would want to know it was doing. */
export function toolDetail(name: string, args: unknown): string | undefined {
	if (!args || typeof args !== "object") return undefined;
	const a = args as Record<string, unknown>;
	const keys =
		name === "bash"
			? ["command"]
			: ["command", "path", "file_path", "pattern", "url", "query", "agent", "action", "method", "workflow"];
	for (const k of keys) {
		const v = a[k];
		if (typeof v === "string" && v.trim()) return oneLine(v, 160);
	}
	return undefined;
}

const ASK_TOOL = "ask_user_question";

function describeTool(t: RunningTool): string {
	if (t.name === ASK_TOOL) return "asking the user a question (ask_user_question)";
	if (t.name === "bash") return t.detail ? `the bash command \`${t.detail}\`` : "a bash command";
	return t.detail ? `the ${t.name} tool (${t.detail})` : `the ${t.name} tool`;
}

/** What the chat was doing, to finish "You were in the middle of …". */
export function describeStep(tools: readonly RunningTool[]): string {
	if (tools.length === 0) return "writing a reply";
	const ask = tools.some((t) => t.name === ASK_TOOL);
	const askHint = " (they hadn't answered yet, so ask it again)";
	if (tools.length === 1) {
		const t = tools[0];
		return t.name === ASK_TOOL ? `${describeTool(t)}${askHint}` : `running ${describeTool(t)}`;
	}
	const parts = tools.slice(0, 4).map(describeTool);
	const more = tools.length > 4 ? ` and ${tools.length - 4} more` : "";
	return `running ${tools.length} tools at once: ${parts.join("; ")}${more}${ask ? askHint : ""}`;
}

function hhmm(d: Date): string {
	return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** The note a cut-off chat gets after the restart. */
export function carryOnNote(at: Date, reason: string, step: string): string {
	return `${CARRY_ON_PREFIX} ${hhmm(at)} (${reason}). You were in the middle of ${step}; it was cut off. Check where it stopped and carry on.`;
}

/**
 * A chat's cut-offs in a row, for the log: "cut off 1x", "cut off 1x: a crash", "cut off 4x in a row: all
 * planned", "cut off 3x in a row: 2 planned, 1 crash", "cut off 3x in a row: all crashes".
 */
export function cutoffWords(c: CutoffCounts): string {
	if (c.cutoffs <= 1) return c.crashes ? "cut off 1x: a crash" : "cut off 1x";
	const crashes = c.crashes === 1 ? "1 crash" : `${c.crashes} crashes`;
	const kinds = c.crashes && c.planned ? `${c.planned} planned, ${crashes}` : c.crashes ? "all crashes" : "all planned";
	return `cut off ${c.cutoffs}x in a row: ${kinds}`;
}

/** The server log's line about a restart's carry-on: every chat with its own count of cut-offs. */
export function carryOnLogLine(plan: CarryOnPlan): string {
	const one = (i: CutoffCounts & { chat: RunningChat }) => `"${i.chat.title}" (${cutoffWords(i)})`;
	return (
		`[carry-on] restarted (${plan.reason}): carrying on ${plan.carry.length} chat(s)` +
		(plan.carry.length ? `: ${plan.carry.map(one).join(", ")}` : "") +
		(plan.guarded.length ? `; left alone: ${plan.guarded.map(one).join(", ")}` : "")
	);
}

/** The notice the user gets about a chat the carry-on left alone. */
export function guardNotice(g: GuardedItem): string {
	const why =
		g.why === "crashes"
			? `${g.crashes} crashes without finishing a turn in between (pi-web-ui may be crashing because of it)`
			: `${g.planned} planned restarts without finishing a turn in between`;
	return `"${g.chat.title}" was cut off by ${why}, so it wasn't told to carry on this time. Open it and tell it what to do.`;
}

// ---------------------------------------------------------------------------
// Planning the carry-on (pure)
// ---------------------------------------------------------------------------

export interface RestartReason {
	reason: string;
	at: number;
}

/**
 * A chat's cut-offs as the list has them. A list an older build wrote has one count of both kinds:
 * it is read as crashes, which keeps the crash guard as strict as it was.
 */
export function cutoffCounts(chat: Partial<Pick<RunningChat, "cutoffs" | "crashes" | "planned">>): CutoffCounts {
	const n = (x: unknown) => (typeof x === "number" && Number.isFinite(x) ? Math.max(0, Math.floor(x)) : undefined);
	let crashes = n(chat.crashes);
	let planned = n(chat.planned);
	if (crashes === undefined && planned === undefined) crashes = n(chat.cutoffs);
	crashes ??= 0;
	planned ??= 0;
	return { cutoffs: crashes + planned, crashes, planned };
}

/**
 * What to do after a restart, from the list the old process left.
 * `reasonRec`: pi-web-deploy's restart-reason.json, if any (used only when it is fresh and the
 * old process stopped on purpose).
 * A planned stop (the old process left its shutdown mark) counts towards PLANNED_CUTOFF_CEILING, a
 * crash towards LOOP_GUARD_CUTOFFS; a chat at either limit gets a notice instead of a note.
 */
export function planCarryOn(prev: RunningChatsFile | null, reasonRec: RestartReason | null, now: number): CarryOnPlan {
	const planned = Boolean(prev?.shutdown);
	const fresh =
		reasonRec &&
		typeof reasonRec.reason === "string" &&
		reasonRec.reason.trim() &&
		now - reasonRec.at < REASON_FRESH_MS;
	const reason = planned ? (fresh ? oneLine(reasonRec.reason, 120) : "a restart") : "it crashed or was killed";
	const plan: CarryOnPlan = { reason, kind: planned ? "planned" : "crash", at: now, carry: [], guarded: [] };
	const seen = new Set<string>();
	for (const chat of prev?.chats ?? []) {
		if (!chat || typeof chat.sessionFile !== "string" || !chat.sessionFile || seen.has(chat.sessionFile)) continue;
		seen.add(chat.sessionFile);
		const before = cutoffCounts(chat);
		const counts: CutoffCounts = {
			cutoffs: before.cutoffs + 1,
			crashes: before.crashes + (planned ? 0 : 1),
			planned: before.planned + (planned ? 1 : 0),
		};
		if (counts.crashes >= LOOP_GUARD_CUTOFFS || counts.planned >= PLANNED_CUTOFF_CEILING) {
			plan.guarded.push({ chat, ...counts, why: counts.crashes >= LOOP_GUARD_CUTOFFS ? "crashes" : "planned" });
			continue;
		}
		const step = chat.step ?? describeStep(Array.isArray(chat.tools) ? chat.tools : []);
		plan.carry.push({ chat, ...counts, note: carryOnNote(new Date(now), reason, step) });
	}
	return plan;
}

/**
 * Transition from the old record (client-state.json `interrupted`, kept per browser window):
 * only the newest shutdown's records, each chat once. `max` is the newest record's time; records
 * more than a minute older belong to earlier restarts. Records older than REASON_FRESH_MS count
 * as stale: that shutdown wasn't the one just now.
 */
export function newestInterrupted(
	records: readonly { title: string; cwd: string; at: number; sessionFile?: string }[],
	now: number,
): { title: string; cwd: string; at: number; sessionFile: string }[] {
	const withFile = records.filter(
		(r): r is { title: string; cwd: string; at: number; sessionFile: string } =>
			Boolean(r?.sessionFile) && Number.isFinite(r.at),
	);
	if (withFile.length === 0) return [];
	const max = Math.max(...withFile.map((r) => r.at));
	if (now - max > REASON_FRESH_MS) return [];
	const seen = new Set<string>();
	const out: { title: string; cwd: string; at: number; sessionFile: string }[] = [];
	for (const r of withFile) {
		if (max - r.at > 60_000 || seen.has(r.sessionFile)) continue;
		seen.add(r.sessionFile);
		out.push(r);
	}
	return out;
}

/**
 * The step a transcript was cut off in, from its last lines (transition only: the old process
 * kept no live list). The last assistant message's tool calls that have no result, or an error
 * result (an aborted tool), were running; none of them means it was writing.
 */
export function stepFromTranscriptTail(tail: string): string {
	const lines = tail.split("\n");
	const results = new Map<string, boolean>();
	for (let i = lines.length - 1; i >= 0; i--) {
		const line = lines[i].trim();
		if (!line.startsWith("{")) continue;
		let entry: { type?: string; message?: Record<string, unknown> };
		try {
			entry = JSON.parse(line);
		} catch {
			continue;
		}
		if (entry.type !== "message" || !entry.message) continue;
		const m = entry.message;
		if (m.role === "toolResult" && typeof m.toolCallId === "string") {
			results.set(m.toolCallId, m.isError === true);
			continue;
		}
		if (m.role === "user") return "writing a reply";
		if (m.role !== "assistant") continue;
		const content = Array.isArray(m.content) ? (m.content as Record<string, unknown>[]) : [];
		const tools: RunningTool[] = [];
		for (const c of content) {
			if (c?.type !== "toolCall" || typeof c.id !== "string" || typeof c.name !== "string") continue;
			const failed = results.get(c.id);
			if (failed === false) continue; // it finished
			tools.push({ id: c.id, name: c.name, detail: toolDetail(c.name, c.arguments) });
		}
		return describeStep(tools);
	}
	return "writing a reply";
}

/** The last `bytes` of a file as text (best effort; "" when it can't be read). */
export function readTail(file: string, bytes = 256 * 1024): string {
	let fd: number | null = null;
	try {
		fd = openSync(file, "r");
		const size = fstatSync(fd).size;
		const len = Math.min(size, bytes);
		const buf = Buffer.alloc(len);
		readSync(fd, buf, 0, len, size - len);
		return buf.toString("utf8");
	} catch {
		return "";
	} finally {
		if (fd !== null) closeSync(fd);
	}
}

// ---------------------------------------------------------------------------
// The live list
// ---------------------------------------------------------------------------

export function readRunningChatsFile(file: string): RunningChatsFile | null {
	try {
		const data = JSON.parse(readFileSync(file, "utf8")) as RunningChatsFile;
		if (!data || data.v !== 1 || !Array.isArray(data.chats)) return null;
		return data;
	} catch {
		return null;
	}
}

/** Read and delete pi-web-deploy's restart-reason.json (null when there is none or it's bad). */
export function takeRestartReason(file: string): RestartReason | null {
	if (!existsSync(file)) return null;
	let rec: RestartReason | null = null;
	try {
		const data = JSON.parse(readFileSync(file, "utf8")) as Partial<RestartReason> & { at?: unknown };
		const at = typeof data.at === "string" ? Date.parse(data.at) : Number(data.at);
		if (typeof data.reason === "string" && Number.isFinite(at)) rec = { reason: data.reason, at };
	} catch {
		rec = null;
	}
	try {
		unlinkSync(file);
	} catch {
		/* gone already */
	}
	return rec;
}

/** Who the chat is, as the events see it. */
export interface ChatRef {
	sessionFile: string;
	title: string;
	cwd: string;
}

export class RunningChats {
	private chats = new Map<string, RunningChat>();
	private frozen = false;
	private warned = false;

	constructor(
		readonly file: string,
		private readonly now: () => number = Date.now,
	) {}

	/** Put the chats being carried on into the list: they count as working until their turn ends. */
	seed(chats: readonly RunningChat[]): void {
		for (const c of chats) this.chats.set(c.sessionFile, { ...c, tools: [...(c.tools ?? [])] });
		this.write();
	}

	/** A turn started. A chat carried over from the restart keeps its cut-off counts. */
	start(ref: ChatRef): void {
		if (this.frozen) return;
		const old = this.chats.get(ref.sessionFile);
		this.chats.set(ref.sessionFile, {
			sessionFile: ref.sessionFile,
			title: ref.title,
			cwd: ref.cwd,
			startedAt: this.now(),
			...(old ? cutoffCounts(old) : { cutoffs: 0, crashes: 0, planned: 0 }),
			tools: [],
		});
		this.write();
	}

	toolStart(ref: ChatRef, tool: RunningTool): void {
		if (this.frozen) return;
		let c = this.chats.get(ref.sessionFile);
		if (!c || c.awaiting) {
			// A tool without a turn start we saw (or the carried-over entry): the chat works now.
			this.start(ref);
			c = this.chats.get(ref.sessionFile);
			if (!c) return;
		}
		c.title = ref.title;
		c.tools = [...c.tools.filter((t) => t.id !== tool.id), tool];
		c.step = undefined;
		this.write();
	}

	toolEnd(ref: ChatRef, toolCallId: string): void {
		if (this.frozen) return;
		const c = this.chats.get(ref.sessionFile);
		if (!c || !c.tools.some((t) => t.id === toolCallId)) return;
		c.tools = c.tools.filter((t) => t.id !== toolCallId);
		this.write();
	}

	/** The turn ended (finished, failed or stopped by the user), or the chat was closed. */
	finish(sessionFile: string): void {
		if (this.frozen) return;
		if (this.chats.delete(sessionFile)) this.write();
	}

	/** Shutdown: keep the list as it is now, marked as a planned stop. Later events are ignored. */
	freeze(signal: string): void {
		if (this.frozen) return;
		this.write({ at: this.now(), signal });
		this.frozen = true;
	}

	get isFrozen(): boolean {
		return this.frozen;
	}

	list(): RunningChat[] {
		return [...this.chats.values()].map((c) => ({ ...c, tools: [...c.tools] }));
	}

	has(sessionFile: string): boolean {
		return this.chats.has(sessionFile);
	}

	/** The chat with this transcript, if it is in the list (a copy). */
	get(sessionFile: string): RunningChat | undefined {
		const c = this.chats.get(sessionFile);
		return c ? { ...c, tools: [...c.tools] } : undefined;
	}

	private write(shutdown?: { at: number; signal: string }): void {
		const data: RunningChatsFile = { v: 1, pid: process.pid, chats: this.list() };
		if (shutdown) data.shutdown = shutdown;
		const tmp = `${this.file}.${process.pid}.tmp`;
		try {
			writeFileSync(tmp, `${JSON.stringify(data, null, 1)}\n`);
			renameSync(tmp, this.file);
		} catch (err) {
			if (!this.warned) {
				this.warned = true;
				console.error(`[carry-on] couldn't write ${this.file}: ${(err as Error).message}`);
			}
		}
	}
}
