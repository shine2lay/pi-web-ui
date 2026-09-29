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
 * Read-only by design: it never writes, never repairs, and never touches the SDK's
 * SessionManager. When anything looks off (old format, duplicate ids, a leftover
 * compaction marker, a parent cycle, a dangling tool call) it reports the defect and
 * the caller falls back to the old path — repair, heal and marker scan as before.
 */
import { readFileSync, statSync } from "node:fs";
import { buildSessionContext, CURRENT_SESSION_VERSION } from "@earendil-works/pi-coding-agent";
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
}

/**
 * The SDK skips lines it cannot parse (parseSessionEntryLine); so do we, identically.
 *
 * Line by line straight from the bytes: turning the whole file into one string first costs
 * twice as much (280 MB: 975 ms against 459 ms), because a huge string is decoded and kept
 * whole while each line is decoded, parsed and thrown away again.
 */
function parseEntries(buf: Buffer): Record<string, unknown>[] {
	const out: Record<string, unknown>[] = [];
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
				} catch {
					// A half-written last line (or a torn line from a crash): the SDK skips it too.
				}
			}
		}
		if (nl === -1) break;
		from = nl + 1;
	}
	return out;
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
	});
	let bytes = 0;
	let buf: Buffer;
	try {
		bytes = statSync(file).size;
		if (bytes > MAX_SCAN_BYTES) return { ...fail("too-big"), bytes };
		buf = readFileSync(file);
	} catch {
		return fail("unreadable");
	}
	const entries = parseEntries(buf);
	const scan: TranscriptScan = {
		file,
		bytes,
		entries,
		sessionId: "",
		cwd: "",
		leafId: null,
		problem: null,
		ms: 0,
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
