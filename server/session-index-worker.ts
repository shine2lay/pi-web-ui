/**
 * session-index (worker side): reads one transcript from a byte offset and folds its lines into the
 * fields History needs, exactly as pi's `buildSessionInfo` (session-manager.js) computes them — but
 * without the full text (`allMessagesText`), and resumable: the state after the last complete line is
 * returned with the offset, so the next read starts there (transcripts are append-only).
 *
 * This file runs inside a worker thread (server/session-index.ts starts it), so a giant line never
 * blocks the server. It must stay self-contained: node builtins only, erasable TypeScript only
 * (vitest loads the .ts file straight into the worker; production loads the compiled .js).
 * The same functions also run in-process when a worker can't start.
 *
 * When syncing pi: if `buildSessionInfo` changes what a field is made of, change `foldLine` here /
 * `toInfo` (server/session-index.ts) to match, and bump FOLD_VERSION.
 */
import { createHash } from "node:crypto";
import { open } from "node:fs/promises";
import { isMainThread, parentPort, workerData } from "node:worker_threads";

/** Bump when the fold changes: every saved state is then read again from the start. */
export const FOLD_VERSION = 1;

/** The header fields `buildSessionInfo` uses, as written in the file. */
export interface FoldHeader {
	id?: unknown;
	cwd?: unknown;
	parentSession?: unknown;
	timestamp?: unknown;
}

/** What `buildSessionInfo` has gathered after some lines. */
export interface Fold {
	header: FoldHeader | null;
	/** `buildSessionInfo` would return null: the first entry wasn't a session header, or a line made it throw. */
	bad: boolean;
	name?: string;
	messageCount: number;
	firstMessage: string;
	lastActivity?: number;
}

/** Bytes hashed at the start of the file and just before the read offset: a rewrite in place shows here. */
export const FP_BYTES = 4096;

export interface Fingerprint {
	headLen: number;
	head: string;
	tailLen: number;
	tail: string;
}

export interface ScanTask {
	file: string;
	/** Read from here (always the start of a line). 0 = from the start. */
	from: number;
	/** Read up to here (the size the caller saw). */
	to: number;
	/** The fold after `from` bytes (ignored when from = 0). */
	fold: Fold | null;
	/** The fingerprint taken when `from` was reached; a mismatch means the file was rewritten: read it all. */
	fp: Fingerprint | null;
	/** `custom` entries of these types are handed back (in file order), e.g. identity entries. */
	customTypes: string[];
}

export interface ScanResult {
	/** The fold after the last complete line. */
	committed: Fold;
	/** Bytes up to and including the last newline. */
	offset: number;
	/** The fold with the unfinished last line too (what a listing would show now); null = no such line. */
	view: Fold | null;
	fp: Fingerprint;
	/** Data of the matching `custom` entries among the complete lines read. */
	customs: { customType: string; data: unknown }[];
	/** The file was read from the start (asked for, or its start or the bytes before `from` changed). */
	full: boolean;
	bytesRead: number;
}

export function emptyFold(): Fold {
	return { header: null, bad: false, messageCount: 0, firstMessage: "" };
}

export function cloneFold(f: Fold): Fold {
	return { ...f, header: f.header ? { ...f.header } : null };
}

// ---------------------------------------------------------------------------
// The fold: pi's buildSessionInfo, line by line (same checks, same throws).
// ---------------------------------------------------------------------------

// Untyped on purpose: the checks below are pi's, written against whatever JSON the line holds.
type Loose = any;

function isMessageWithContent(message: Loose): boolean {
	return typeof message.role === "string" && "content" in message;
}

function extractTextContent(message: Loose): string {
	const content = message.content;
	if (typeof content === "string") return content;
	return content
		.filter((block: Loose) => block.type === "text")
		.map((block: Loose) => block.text)
		.join(" ");
}

function getMessageActivityTime(entry: Loose): number | undefined {
	const message = entry.message;
	if (!isMessageWithContent(message)) return undefined;
	if (message.role !== "user" && message.role !== "assistant") return undefined;
	const msgTimestamp = message.timestamp;
	if (typeof msgTimestamp === "number") return msgTimestamp;
	const t = new Date(entry.timestamp).getTime();
	return Number.isNaN(t) ? undefined : t;
}

/** One line, as readline hands it to buildSessionInfo. */
export function foldLine(f: Fold, line: string, customTypes: string[], customs: ScanResult["customs"] | null): void {
	if (!line.trim()) return;
	let entry: Loose;
	try {
		entry = JSON.parse(line);
	} catch {
		return;
	}
	if (!entry) return;
	if (
		customs &&
		typeof entry === "object" &&
		entry.type === "custom" &&
		typeof entry.customType === "string" &&
		customTypes.includes(entry.customType)
	) {
		customs.push({ customType: entry.customType, data: entry.data });
	}
	if (f.bad) return;
	try {
		if (!f.header) {
			if (entry.type !== "session") {
				f.bad = true;
				return;
			}
			f.header = { id: entry.id, cwd: entry.cwd, parentSession: entry.parentSession, timestamp: entry.timestamp };
			return;
		}
		if (entry.type === "session_info") {
			f.name = entry.name?.trim() || undefined;
		}
		if (entry.type !== "message") return;
		f.messageCount++;
		const activityTime = getMessageActivityTime(entry);
		if (typeof activityTime === "number") {
			f.lastActivity = Math.max(f.lastActivity ?? 0, activityTime);
		}
		const message = entry.message;
		if (!isMessageWithContent(message)) return;
		if (message.role !== "user" && message.role !== "assistant") return;
		// Called for every message as pi does (it builds the full text): a malformed content throws there.
		const textContent = extractTextContent(message);
		if (!textContent) return;
		if (!f.firstMessage && message.role === "user") f.firstMessage = textContent;
	} catch {
		// buildSessionInfo's own try/catch: the whole session is left out.
		f.bad = true;
	}
}

/** A complete line's bytes (without its "\n"): readline also ends a line at "\r" ("\r\n" is one end). */
function foldBytes(f: Fold, bytes: Buffer, customTypes: string[], customs: ScanResult["customs"] | null): void {
	let text = bytes.toString("utf8");
	if (text.endsWith("\r")) text = text.slice(0, -1);
	if (text.includes("\r")) {
		for (const part of text.split("\r")) foldLine(f, part, customTypes, customs);
	} else {
		foldLine(f, text, customTypes, customs);
	}
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

const CHUNK = 4 << 20;

type Handle = Awaited<ReturnType<typeof open>>;

async function readRange(fh: Handle, start: number, end: number): Promise<Buffer> {
	const len = Math.max(0, end - start);
	const buf = Buffer.allocUnsafe(len);
	let got = 0;
	while (got < len) {
		const { bytesRead } = await fh.read(buf, got, len - got, start + got);
		if (bytesRead <= 0) break;
		got += bytesRead;
	}
	return got === len ? buf : buf.subarray(0, got);
}

const hash = (b: Buffer): string => createHash("sha1").update(b).digest("hex");

async function fingerprint(fh: Handle, offset: number): Promise<Fingerprint> {
	const headLen = Math.min(FP_BYTES, offset);
	const tailLen = Math.min(FP_BYTES, offset);
	const head = await readRange(fh, 0, headLen);
	const tail = await readRange(fh, offset - tailLen, offset);
	return { headLen, head: hash(head), tailLen, tail: hash(tail) };
}

async function fingerprintMatches(fh: Handle, fp: Fingerprint, offset: number): Promise<boolean> {
	if (fp.headLen > offset || fp.tailLen > offset) return false;
	const head = await readRange(fh, 0, fp.headLen);
	if (head.length !== fp.headLen || hash(head) !== fp.head) return false;
	const tail = await readRange(fh, offset - fp.tailLen, offset);
	return tail.length === fp.tailLen && hash(tail) === fp.tail;
}

/** Read [from, to) of a transcript and fold it on top of `task.fold`. Throws when the file can't be opened. */
export async function scanTranscriptRange(task: ScanTask): Promise<ScanResult> {
	const fh = await open(task.file, "r");
	try {
		let from = task.from;
		let fold = from > 0 && task.fold ? cloneFold(task.fold) : emptyFold();
		if (from > 0 && (!task.fold || !task.fp || !(await fingerprintMatches(fh, task.fp, from)))) {
			from = 0;
			fold = emptyFold();
		}
		if (from === 0) fold = emptyFold();
		const customs: ScanResult["customs"] = [];
		let pos = from;
		let offset = from;
		/** Bytes of the line being read that came in earlier chunks. */
		let pending: Buffer[] = [];
		const buf = Buffer.allocUnsafe(CHUNK);
		while (pos < task.to) {
			const { bytesRead } = await fh.read(buf, 0, Math.min(CHUNK, task.to - pos), pos);
			if (bytesRead <= 0) break;
			const chunk = buf.subarray(0, bytesRead);
			let start = 0;
			let nl = chunk.indexOf(10, start);
			while (nl !== -1) {
				const piece = chunk.subarray(start, nl);
				const line = pending.length > 0 ? Buffer.concat([...pending, piece]) : piece;
				pending = [];
				foldBytes(fold, line, task.customTypes, customs);
				start = nl + 1;
				nl = chunk.indexOf(10, start);
			}
			offset = pos + start;
			if (start < bytesRead) pending.push(Buffer.from(chunk.subarray(start, bytesRead)));
			pos += bytesRead;
		}
		let view: Fold | null = null;
		if (pending.length > 0) {
			// The last line has no newline yet (still being written, or the file just ends there):
			// readline hands it to buildSessionInfo anyway, so the listing shows it; the next read redoes it.
			view = cloneFold(fold);
			foldBytes(view, Buffer.concat(pending), task.customTypes, null);
		}
		const fp = await fingerprint(fh, offset);
		return { committed: fold, offset, view, fp, customs, full: from === 0, bytesRead: pos - from };
	} finally {
		await fh.close().catch(() => {});
	}
}

// ---------------------------------------------------------------------------
// Worker entry
// ---------------------------------------------------------------------------

export const WORKER_MARK = "pi-web-session-index";

if (!isMainThread && parentPort && (workerData as { kind?: string } | undefined)?.kind === WORKER_MARK) {
	const port = parentPort;
	port.on("message", (msg: { id: number; task: ScanTask }) => {
		scanTranscriptRange(msg.task).then(
			(result) => port.postMessage({ id: msg.id, result }),
			(err: unknown) => port.postMessage({ id: msg.id, error: String((err as Error)?.message ?? err) }),
		);
	});
}
