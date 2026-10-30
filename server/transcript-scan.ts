/**
 * chat-open-speed: one read + parse of a session transcript, shared by everything the
 * open path used to read the file for.
 *
 * Opening a big chat from history used to read and parse the whole transcript FOUR
 * times before anything showed up (measured on a 280 MB copy, 6.0 s in total):
 *   repairSessionFile        1.7 s   (read + JSON.parse every line)
 *   healDanglingToolCallFile 1.5 s   (read + JSON.parse every line)
 *   SessionManager.open      1.3 s   (the SDK's own load)
 *   noticeInterruptedCompaction 1.1 s (read + substring scan)
 *
 * This module does ONE read + parse (0.53 s for the same file) and answers all the
 * questions the first, second and fourth pass asked:
 *   - is the file healthy? (repair/heal/marker scan can then be skipped entirely)
 *   - what is the newest window of the current branch? (the preview, sent before the
 *     SDK has even opened the file — see ClientSession.emitSwitchPreview)
 *
 * Read-only by design: it never writes and never repairs. When anything looks off (old
 * format, duplicate ids, a leftover compaction marker, a parent cycle, a dangling tool
 * call) it reports the defect and the caller falls back to the old path — repair, heal
 * and marker scan as before.
 *
 * open-scan (Ops #638): the SDK's own load was the one remaining second parse of the
 * whole file (SessionManager.open → loadEntriesFromFile). openScannedSession hands the
 * scan's entries to the SDK instead, through the same constructor argument
 * SessionManager.open itself uses for a preloaded file, when — and only when — they are
 * exactly what the SDK would have loaded and loading them writes nothing: a healthy scan,
 * a file that ends in a newline (the SDK appends one otherwise), no line that parses to a
 * bare number/string/true (the SDK keeps those, the scan doesn't), and the file unchanged
 * since it was read (same device, inode, size and mtime). Otherwise SessionManager.open
 * reads the file again, as before.
 */
import { readFileSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { buildSessionContext, CURRENT_SESSION_VERSION, SessionManager } from "@earendil-works/pi-coding-agent";
import { transcriptDefectOf } from "./compaction-markers.js";
import { tailDanglingToolCallsOf } from "./dangling-tools.js";

/** Transcripts bigger than this are left to the old path (a string that big is a risk of its own). */
export const MAX_SCAN_BYTES = 512 * 1024 * 1024;

/** Why the fast path is off for this file. null = healthy. */
export type TranscriptProblem =
	| "unreadable"
	| "too-big"
	| "empty"
	| "no-header"
	| "old-version"
	| "pending-marker"
	| "duplicate-id"
	| "parent-cycle"
	| "dangling-tool-call";

export interface TranscriptScan {
	file: string;
	bytes: number;
	/** Parsed entries in file order, unparseable lines skipped (exactly what the SDK loads). */
	entries: Record<string, unknown>[];
	/** Session id from the header (the page's list key — the preview must carry it). */
	sessionId: string;
	/** cwd from the header, "" when the header has none. */
	cwd: string;
	/** The SDK's leaf: the last entry in file order that is not the header. */
	leafId: string | null;
	problem: TranscriptProblem | null;
	/** How long the read + parse took (ms), for the timing log. */
	ms: number;
	/** open-scan: the file as it was read (null when it wasn't), to tell whether it has changed since. */
	stamp: FileStamp | null;
	/** open-scan: `entries` are exactly what the SDK's loadEntriesFromFile returns for these bytes, and
	 *  loading them writes nothing (see openScannedSession). */
	sdkEquivalent: boolean;
}

/** What identifies the bytes read: a write, a rename over it or a truncation changes one of these. */
export interface FileStamp {
	dev: number;
	ino: number;
	size: number;
	mtimeMs: number;
}

const stampOf = (file: string): FileStamp | null => {
	try {
		const st = statSync(file);
		return { dev: st.dev, ino: st.ino, size: st.size, mtimeMs: st.mtimeMs };
	} catch {
		return null;
	}
};

const sameStamp = (a: FileStamp | null, b: FileStamp | null): boolean =>
	!!a && !!b && a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs;

/**
 * The SDK skips lines it cannot parse (parseSessionEntryLine); so do we, identically.
 *
 * Line by line straight from the bytes: turning the whole file into one string first costs
 * twice as much (280 MB: 975 ms against 459 ms), because a huge string is decoded and kept
 * whole while each line is decoded, parsed and thrown away again.
 */
function parseEntries(buf: Buffer): { entries: Record<string, unknown>[]; bareValues: number } {
	const out: Record<string, unknown>[] = [];
	// Lines that parse to a bare truthy value (5, "x", true): the SDK keeps them as entries, the scan
	// doesn't — so such a file is never handed to the SDK from the scan.
	let bareValues = 0;
	let from = 0;
	for (;;) {
		const nl = buf.indexOf(10, from);
		const end = nl === -1 ? buf.length : nl;
		if (end > from) {
			const line = buf.toString("utf8", from, end);
			if (line.trim()) {
				try {
					const parsed: unknown = JSON.parse(line);
					if (typeof parsed === "object" && parsed !== null) out.push(parsed as Record<string, unknown>);
					else if (parsed) bareValues++;
				} catch {
					// A half-written last line (or a torn line from a crash): the SDK skips it too.
				}
			}
		}
		if (nl === -1) break;
		from = nl + 1;
	}
	return { entries: out, bareValues };
}

/**
 * Read + parse a transcript once and judge whether the fast open path may be used.
 * Returns null only when the file cannot be read at all (caller keeps the old path).
 */
export function scanTranscriptFile(file: string): TranscriptScan {
	const t0 = Date.now();
	const fail = (problem: TranscriptProblem): TranscriptScan => ({
		file,
		bytes: 0,
		entries: [],
		sessionId: "",
		cwd: "",
		leafId: null,
		problem,
		ms: Date.now() - t0,
		stamp: null,
		sdkEquivalent: false,
	});
	let bytes = 0;
	let buf: Buffer;
	let stamp: FileStamp | null;
	try {
		stamp = stampOf(file);
		if (!stamp) return fail("unreadable");
		bytes = stamp.size;
		if (bytes > MAX_SCAN_BYTES) return { ...fail("too-big"), bytes };
		buf = readFileSync(file);
	} catch {
		return fail("unreadable");
	}
	const { entries, bareValues } = parseEntries(buf);
	const scan: TranscriptScan = {
		file,
		bytes,
		entries,
		sessionId: "",
		cwd: "",
		leafId: null,
		problem: null,
		ms: 0,
		stamp,
		// The bytes read are the bytes stamped (nothing was written while reading), the SDK would not
		// append a newline (it does when the last line has none), and every entry it keeps we keep.
		sdkEquivalent: buf.length === bytes && (bytes === 0 || buf[bytes - 1] === 10) && bareValues === 0,
	};
	const header = entries[0];
	// Same rule as loadEntriesFromFile: no leading session header → the SDK treats the
	// file as empty and starts a new session. Never preview that.
	if (!header) return { ...scan, problem: "empty", ms: Date.now() - t0 };
	if (header.type !== "session" || typeof header.id !== "string") {
		return { ...scan, problem: "no-header", ms: Date.now() - t0 };
	}
	scan.sessionId = header.id;
	scan.cwd = typeof header.cwd === "string" ? header.cwd : "";
	// An older file version makes the SDK migrate and REWRITE the file on open; the
	// entries we parsed would not be what ends up in memory. Leave it to the old path.
	const version = typeof header.version === "number" ? header.version : 1;
	if (version < CURRENT_SESSION_VERSION) return { ...scan, problem: "old-version", ms: Date.now() - t0 };
	// The SDK's leaf: last non-header entry in file order (_buildIndex).
	for (let i = entries.length - 1; i > 0; i--) {
		const id = entries[i].id;
		if (typeof id === "string") {
			scan.leafId = id;
			break;
		}
	}
	const defect = transcriptDefectOf(entries);
	if (defect) return { ...scan, problem: defect, ms: Date.now() - t0 };
	if (tailDanglingToolCallsOf(entries, scan.leafId).length > 0) {
		return { ...scan, problem: "dangling-tool-call", ms: Date.now() - t0 };
	}
	scan.ms = Date.now() - t0;
	return scan;
}

/**
 * The messages the SDK would put in agent.state.messages for this transcript — built by
 * the SDK's own buildSessionContext over the entries we already parsed, so compaction,
 * branches, rewinds and context edits behave exactly as they do after a real open.
 */
export function contextMessagesOf(scan: TranscriptScan): unknown[] {
	const ctx = buildSessionContext(scan.entries as never, scan.leafId as never);
	return ctx.messages as unknown[];
}

/** SessionManager's constructor, which TypeScript calls private; SessionManager.open uses it with the
 *  same arguments (cwd, sessionDir, file, persist, newSessionOptions, preloadedFileEntries). */
type SessionManagerCtor = new (
	cwd: string,
	sessionDir: string,
	sessionFile: string,
	persist: boolean,
	newSessionOptions: undefined,
	preloadedFileEntries: Record<string, unknown>[],
) => SessionManager;

/**
 * open-scan (Ops #638): open the scanned file with the pi SDK without reading it again.
 *
 * Returns the SDK's SessionManager built from `scan.entries` — the very array, which the manager then
 * owns (the caller must not empty it) — or null when the scan can't stand in for the SDK's own load:
 * the file has a problem, its bytes aren't loadable as they are (see `sdkEquivalent`), or it changed
 * since it was read. Null means: call SessionManager.open(file), as before.
 *
 * What SessionManager.open(file) does, step for step: the header is the first parsed entry (its
 * readSessionHeader skips blank and unparseable lines the same way), cwd is the header's cwd when it
 * is a string and process.cwd() otherwise, the session folder is the file's folder, and the constructor
 * gets the file and its entries. The file is an existing current-version one with entries, so none of
 * the SDK's rewrite paths (version migration, empty-file init) can run, and it is marked flushed:
 * later writes append.
 */
export function openScannedSession(scan: TranscriptScan): SessionManager | null {
	if (scan.problem !== null || !scan.sdkEquivalent || scan.entries.length === 0) return null;
	if (!sameStamp(scan.stamp, stampOf(scan.file))) return null;
	const header = scan.entries[0];
	const cwd = typeof header.cwd === "string" ? header.cwd : process.cwd();
	const Ctor = SessionManager as unknown as SessionManagerCtor;
	return new Ctor(cwd, dirname(scan.file), scan.file, true, undefined, scan.entries);
}
