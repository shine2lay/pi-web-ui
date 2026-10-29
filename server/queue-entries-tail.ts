/**
 * queue-entries-tail (Ops #635, H-INCREMENTAL-QUEUE-READS-1): pi-queue's entries in a chat file, reading only the
 * bytes the file got since the last read.
 *
 * Background checks (QueueBlocks.readQueue, taskChatPaused, queueOwesBack, taskChatFinished; all through
 * role-messages.ts queueEntriesOf) read whole chat files from byte 0 each time. Home chats are 87-223 MB and change all
 * the time: on 2026-10-29 that was about 20% of the main thread (decoding and splitting) and 11-20 MB/s of reads.
 *
 * Kept per file: the queue entries of its complete lines, in file order, and whether its session header was found
 * (the SDK's rule, as queueEntriesOf had it: the first non-blank line that parses to a value). The next read starts
 * where the last complete line ended. An unfinished last line is looked at for this answer only, as the whole-file
 * parse did with it, and never kept. So the answer is the one a whole-file parse gives.
 *
 * It starts over from byte 0 when the file is replaced (another device or inode: an atomic rewrite, the ACP prune's
 * swap), shorter than what was read, or changed in its first 4 KB or in the 4 KB before where the last read stopped (a
 * sha1 of each), as pi-queue's transcript-tail.ts does. Known limit, the same as there: an in-place rewrite that keeps
 * both windows and leaves the file at least as long goes unnoticed; nothing that writes chat files does that.
 *
 * Why not pi-queue's readers.v1 readFold: it reads synchronously (a first read of a 200 MB file would hold the main
 * thread for seconds), hands out a structuredClone of its state per call (about 90 ms for the Ops home chat's 8,500
 * entries), and isn't there until a chat has loaded pi-queue, so this repo would need its own reader anyway.
 *
 * It holds parsed entries only, never file text; a file's entry goes after 30 min unused. The entries are shared with
 * callers, as roles-overview.ts's TranscriptScans shares its own: nothing changes them (a test replays deep-frozen
 * copies through every reader).
 */

import { createHash } from "node:crypto";
import { type FileHandle, open } from "node:fs/promises";
import { resolve } from "node:path";
import { TASK_QUEUE_ENTRY_TYPE, type TaskQueueEntryLike } from "./task-queue.js";

/** A file's entry goes after this long unused. */
export const QUEUE_ENTRIES_IDLE_MS = 30 * 60_000;
/** The size of each fingerprinted window. */
const PRINT = 4096;
/** Bytes read at a time (an await between reads, so a first read of a big file lets other work in). */
const CHUNK = 1024 * 1024;
let chunkBytes = CHUNK;

/** Tests: read `n` bytes at a time, so lines and characters cross reads. */
export function setQueueEntriesChunkBytes(n = CHUNK): void {
	chunkBytes = n;
}

/** A line holding a queue entry holds this (Pi writes lines with JSON.stringify). */
const NEEDLE = Buffer.from(`"${TASK_QUEUE_ENTRY_TYPE}"`);
const NL = 10;

/** The session header, as queueEntriesOf looks for it: undefined while no non-blank line has parsed to a value yet. */
type Header = { id?: string } | undefined;

interface Kept {
	dev: number;
	ino: number;
	/** Bytes parsed: up to just after the last "\n" read. */
	at: number;
	/** sha1 of the bytes [0, min(PRINT, at)) and of the bytes [max(0, at - PRINT), at). */
	head: string;
	tail: string;
	/** The queue entries of the lines before `at`, in file order. */
	entries: TaskQueueEntryLike[];
	header: Header;
	used: number;
}

const kept = new Map<string, Kept>();
/** One read at a time per file (the next one reads only what the one before left). */
const busy = new Map<string, Promise<unknown>>();
let sweepTimer: ReturnType<typeof setTimeout> | undefined;

/** Counts since start: bytes read past the kept point, and reads that started over from byte 0 (tests, measures). */
export const queueEntriesReadStats = { bytes: 0, starts: 0 };

const sha1 = (b: Uint8Array): string => createHash("sha1").update(b).digest("hex");
const NONE = Buffer.alloc(0);
const NONE_PRINT = sha1(NONE);

/** How many files are kept (tests). */
export function queueEntriesKept(): number {
	return kept.size;
}

/** Forget every file and stop the sweep (tests). */
export function forgetAllQueueEntries(): void {
	kept.clear();
	if (sweepTimer) clearTimeout(sweepTimer);
	sweepTimer = undefined;
}

function forgetIdle(now: number): void {
	for (const [key, k] of kept) if (now - k.used >= QUEUE_ENTRIES_IDLE_MS) kept.delete(key);
}

/** While anything is kept, look again when the oldest entry turns idle. */
function armSweep(): void {
	if (sweepTimer || kept.size === 0) return;
	let oldest = Number.POSITIVE_INFINITY;
	for (const k of kept.values()) oldest = Math.min(oldest, k.used);
	const wait = Math.min(QUEUE_ENTRIES_IDLE_MS, Math.max(1_000, oldest + QUEUE_ENTRIES_IDLE_MS - Date.now() + 1_000));
	const timer = setTimeout(() => {
		if (sweepTimer === timer) sweepTimer = undefined;
		forgetIdle(Date.now());
		armSweep();
	}, wait);
	timer.unref?.();
	sweepTimer = timer;
}

/** `len` bytes of the file at `pos`; fewer when it ends first. */
async function readAt(fh: FileHandle, pos: number, len: number): Promise<Buffer> {
	const buf = Buffer.allocUnsafe(len);
	let got = 0;
	while (got < len) {
		const { bytesRead } = await fh.read(buf, got, len - got, pos + got);
		if (!bytesRead) break;
		got += bytesRead;
	}
	return buf.subarray(0, got);
}

/** k's two windows' bytes when the file still holds them as they were read, else undefined. */
async function windows(fh: FileHandle, k: Kept): Promise<{ head: Buffer; tail: Buffer } | undefined> {
	const headLen = Math.min(PRINT, k.at);
	const tailFrom = Math.max(0, k.at - PRINT);
	const head = await readAt(fh, 0, headLen);
	const tail = tailFrom === 0 ? head : await readAt(fh, tailFrom, k.at - tailFrom);
	if (head.length !== headLen || tail.length !== k.at - tailFrom) return undefined;
	if (sha1(head) !== k.head || sha1(tail) !== k.tail) return undefined;
	return { head, tail };
}

/** One line (without its "\n") into the header search: the first non-blank line that parses to a value decides. */
function headerLine(line: string): Header {
	if (!line.trim()) return undefined;
	let h: { type?: unknown; id?: unknown } | undefined;
	try {
		h = JSON.parse(line) as typeof h;
	} catch {
		return undefined; // unparsable: keep looking, as the SDK does
	}
	if (!h) return undefined;
	return h.type === "session" && typeof h.id === "string" ? { id: h.id } : {};
}

/** The queue entry a line holds, if any. */
function entryOf(line: string): TaskQueueEntryLike | undefined {
	try {
		const e = JSON.parse(line) as TaskQueueEntryLike;
		if (e?.type === "custom" && e.customType === TASK_QUEUE_ENTRY_TYPE) return e;
	} catch {
		// a half-written last line: skip it
	}
	return undefined;
}

/**
 * Lines `bytes` holds (complete lines, or the unfinished last one), in order: the header search while it's open, and
 * every line holding the needle into `out`. Only those lines are decoded: "\n" and the needle are ASCII, so they're
 * found in the bytes as in the text.
 */
function scan(bytes: Buffer, header: Header, out: TaskQueueEntryLike[]): Header {
	let pos = 0;
	while (header === undefined && pos <= bytes.length) {
		let end = bytes.indexOf(NL, pos);
		if (end < 0) end = bytes.length;
		header = headerLine(bytes.toString("utf8", pos, end));
		pos = end + 1;
	}
	// The header line itself is looked at for the needle too: a session line is never a queue entry, and any other
	// first line went on to that look in queueEntriesOf as well.
	pos = 0;
	for (;;) {
		const hit = bytes.indexOf(NEEDLE, pos);
		if (hit < 0) break;
		const start = bytes.lastIndexOf(NL, hit) + 1;
		let end = bytes.indexOf(NL, hit);
		if (end < 0) end = bytes.length;
		const e = entryOf(bytes.toString("utf8", start, end));
		if (e) out.push(e);
		pos = end + 1;
		if (pos > bytes.length) break;
	}
	return header;
}

function answer(entries: readonly TaskQueueEntryLike[], header: Header, withHeader: boolean): TaskQueueEntryLike[] {
	return withHeader && header?.id !== undefined ? [{ type: "session", id: header.id }, ...entries] : [...entries];
}

/**
 * queueEntriesOf(file, withHeader): pi-queue's entries in the file (file order), the session header first when asked
 * for and the file starts with one; reading only what the file got since the last read. A file that can't be opened
 * has none; one that can't be read to its end gives what was read before that, as the streamed whole-file read did.
 */
export function readQueueEntries(file: string, withHeader = false, now = Date.now()): Promise<TaskQueueEntryLike[]> {
	const key = resolve(file);
	const prev = busy.get(key) ?? Promise.resolve();
	const p = prev.then(
		() => update(key, withHeader, now),
		() => update(key, withHeader, now),
	);
	busy.set(key, p);
	p.finally(() => {
		if (busy.get(key) === p) busy.delete(key);
	}).catch(() => {});
	return p;
}

async function update(key: string, withHeader: boolean, now: number): Promise<TaskQueueEntryLike[]> {
	forgetIdle(now);
	let fh: FileHandle;
	try {
		fh = await open(key, "r");
	} catch {
		kept.delete(key);
		return [];
	}
	// Back in only once the new lines are in: a failure on the way leaves nothing half done.
	const was = kept.get(key);
	kept.delete(key);
	try {
		const st = await fh.stat();
		const regular = st.isFile();
		const win =
			regular && was && was.dev === st.dev && was.ino === st.ino && st.size >= was.at
				? await windows(fh, was)
				: undefined;
		const k: Kept =
			was && win
				? was
				: {
						dev: st.dev,
						ino: st.ino,
						at: 0,
						head: NONE_PRINT,
						tail: NONE_PRINT,
						entries: [],
						header: undefined,
						used: now,
					};
		if (k !== was) queueEntriesReadStats.starts++;
		let head = win?.head ?? NONE; // the file's bytes [0, min(PRINT, k.at))
		let tail = win?.tail ?? NONE; // the PRINT bytes before k.at
		let rest: Buffer[] = []; // bytes after the last "\n" read so far
		let pos = k.at;
		const buf = Buffer.allocUnsafe(chunkBytes);
		try {
			for (;;) {
				const { bytesRead } = await fh.read(buf, 0, buf.length, pos);
				if (!bytesRead) break;
				pos += bytesRead;
				queueEntriesReadStats.bytes += bytesRead;
				const chunk = buf.subarray(0, bytesRead);
				const nl = chunk.lastIndexOf(NL);
				if (nl < 0) {
					rest.push(Buffer.from(chunk));
					continue;
				}
				const lines = rest.length ? Buffer.concat([...rest, chunk.subarray(0, nl + 1)]) : chunk.subarray(0, nl + 1);
				k.header = scan(lines.subarray(0, lines.length - 1), k.header, k.entries);
				if (head.length < PRINT) head = Buffer.concat([head, lines.subarray(0, PRINT - head.length)]);
				tail = lines.length >= PRINT ? Buffer.from(lines.subarray(lines.length - PRINT)) : Buffer.concat([tail, lines]);
				if (tail.length > PRINT) tail = tail.subarray(tail.length - PRINT);
				k.at += lines.length;
				rest = nl + 1 < bytesRead ? [Buffer.from(chunk.subarray(nl + 1))] : [];
			}
		} catch {
			// Unreadable on the way: what was read so far, as before; nothing kept.
			return answer(k.entries, k.header, withHeader);
		}
		// The unfinished last line ("" when the file ends with "\n"): this answer only.
		const last: TaskQueueEntryLike[] = [];
		const lastHeader = rest.length ? scan(Buffer.concat(rest), k.header, last) : k.header;
		if (regular) {
			k.head = sha1(head);
			k.tail = sha1(tail);
			k.used = now;
			kept.set(key, k);
			armSweep();
		}
		const out = answer(k.entries, lastHeader, withHeader);
		for (const e of last) out.push(e);
		return out;
	} catch {
		return []; // can't stat it: as an unreadable file before, nothing
	} finally {
		await fh.close().catch(() => {});
	}
}
