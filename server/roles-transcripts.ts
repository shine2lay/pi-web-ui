/**
 * roles-transcripts: what the Roles page reads from chat transcripts: their TL;DR entries (and the owner's replies
 * between them), their pi-queue entries and their newest model change. A file is read once and then only the
 * bytes added since (an unchanged file costs one stat), and only a plain .jsonl file inside the session folders is
 * read (no "..", no symlinks). Split out of roles-overview.ts (Backend #15), which still exports these names.
 */

import { lstat, open, realpath, stat } from "node:fs/promises";
import { isAbsolute, resolve, sep } from "node:path";
import { stuckRouteOf, type StuckRoute } from "./live-progress.js";
import { TASK_QUEUE_ENTRY_TYPE, type TaskQueueEntryLike } from "./task-queue.js";
import {
	isTldrReply,
	TLDR_ENTRY_TYPE,
	TLDR_MAX_LINES,
	tldrLinesFromEntries,
	type TldrEntryLike,
} from "./tldr-lines.js";

/** The first bytes of a transcript line, enough to tell what it is. */
const HEAD = 512;
/** A longer line is read no further (a user message that long still counts as the owner's reply). */
const LINE_MAX = 1 << 20;
const CHUNK = 1 << 20;
/** Past this many kept TL;DR entries, a file's list is folded down to its newest lines. */
const KEEP_TLDR = 4000;

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
	/** live-progress: task id -> where its latest "stuck" entry says the question went (absent: no route). */
	stuckRoute: Map<number, StuckRoute | undefined>;
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
				stuckRoute: new Map(),
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
			const op = (e.data ?? {}) as { op?: unknown; id?: unknown; ts?: unknown; ask?: unknown };
			if (op.op === "stuck" && typeof op.id === "number" && typeof op.ts === "number" && op.ts > 0) {
				s.stuckAt.set(op.id, op.ts);
			}
			// live-progress: the newest stuck record's route decides whether its question reached the owner.
			if (op.op === "stuck" && typeof op.id === "number") s.stuckRoute.set(op.id, stuckRouteOf(op.ask));
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
