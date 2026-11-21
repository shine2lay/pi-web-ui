/**
 * work-registry-reader (Ops #1055/#1056; Q-STALL-1, docs/stall-watch-whole-list.md): the one reader of the work
 * registry (pi-work-management's events.jsonl) for the watches. The stall watch and the dead-end answer get
 * registry tasks only through it.
 *
 * It has no task-count or size ceiling: it streams the file a piece at a time and hands each parsed line to the
 * replay (work-page.ts replayEvent) and the stall times (work-registry-times.ts) in one pass. A read is either
 * complete (every whole line read and replayed; a half-written last line is left out) or incomplete, with its
 * reason. A watch that gets an incomplete read raises the owner alarm (`RegistryWatchHooks.alarm`, the lane
 * watchdog's owner Telegram route) in that same round and shows no earlier findings as current; the dead-end
 * answer on it is "unknown". `WORK_PAGE_TASKS_MAX` (work-page.ts) only limits what a display page sends.
 *
 * H-STALL-WHOLE-2 (Ops #1064, docs/stall-watch-registry-missing.md): a missing file is complete and empty only
 * when nothing says the registry ever had tasks; a file that shrank while it was read is incomplete.
 * H-STALL-WHOLE-3 (Ops #1065, same doc): a complete read with no tasks where the last known count was above 0
 * tells the owner once (`RegistryDrop`), and stays complete.
 */

import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import type { OwnerTelegramNotice, OwnerTelegramResult, OwnerTelegramSender } from "./owner-telegram.js";
import type { UiWorkPage } from "./protocol.js";
import { STATE_READ_FLAGS } from "./state-file-read.js";
import type { StallInputs } from "./stall-watch.js";
import {
	newReplay,
	replayEnd,
	replayEvent,
	WORK_PAGE_WHOLE,
	workPageOf,
	type WorkQueueFacts,
	type WorkReplay,
} from "./work-page.js";
import { RegistryDrop, type RegistryDropHooks } from "./work-registry-drop.js";
import { StallTimesBuilder, type StallTimes } from "./work-registry-times.js";

/**
 * Why a read isn't complete: a line that isn't JSON; the file couldn't be read whole (an error, not a file, it
 * shrank while read); or it is missing though the registry had tasks (or the heartbeat can't show it never did).
 */
export type RegistryIncompleteReason = "unreadable-line" | "read-error" | "missing";

/** Every line read and replayed. */
export interface RegistryComplete {
	complete: true;
	/** When it was read (ms). */
	at: number;
	replay: WorkReplay;
	/** The extra times the stall rules need (by `${kind}:${id}`), from the same read. */
	times: Map<string, StallTimes>;
	/** Linked tasks read (each (queue, task, added) once). */
	tasksRead: number;
	bytes: number;
	tookMs: number;
}

/** Not all of it could be read: nothing in it may be taken as the whole registry. */
export interface RegistryIncomplete {
	complete: false;
	at: number;
	reason: RegistryIncompleteReason;
	/** What went wrong, in plain words (a line number, an error code). */
	detail: string;
	/** Linked tasks read before it stopped. */
	tasksRead: number;
}

export type RegistryRead = RegistryComplete | RegistryIncomplete;

/** What a complete round records (Q-STALL-1): when, and how many linked tasks it read. */
export interface RegistryHeartbeat {
	at: number;
	tasksRead: number;
}

/** What a watch gets besides its read (StallWatchOptions has these). */
export interface RegistryWatchHooks {
	/** The owner alarm route the lane watchdog uses (owner-telegram.ts ownerTelegramSender). */
	alarm?: OwnerTelegramSender;
	/** Called after each complete round, never after an incomplete one. */
	heartbeat?: (beat: RegistryHeartbeat) => void;
}

/** A round's inputs with the read they came from. */
export interface RegistryWatchInputs extends StallInputs {
	registry: RegistryRead;
}

/** The file is read in pieces of this size. */
const READ_CHUNK = 1 << 20;
const NEWLINE = 0x0a;

const EMPTY_PAGE = (at: number, problem: UiWorkPage["problem"]): UiWorkPage => ({
	at,
	initiatives: [],
	projects: [],
	tasks: [],
	activity: [],
	...(problem ? { problem } : {}),
});

/** The one reader of the registry file for the watches. A complete read is kept while the file is unchanged. */
export class WorkRegistryReader {
	private seen: { ino: number; mtimeMs: number; size: number; read: RegistryComplete } | undefined;
	/** The last known count (this process's last complete read, else the heartbeat) and the drop-to-none alarm. */
	private readonly drop: RegistryDrop;

	/**
	 * `lastBeat`: the last complete round's heartbeat on disk (`readRegistryHeartbeat`); undefined when there is
	 * none, throws when it can't be read. Production passes it and the hooks through `registryWatchOf`.
	 */
	constructor(
		private readonly file: () => string,
		private readonly lastBeat: () => RegistryHeartbeat | undefined = () => undefined,
		hooks: RegistryDropHooks = {},
	) {
		this.drop = new RegistryDrop(file, lastBeat, hooks);
	}

	/**
	 * The whole registry, streamed (no ceiling). No file: complete and empty only when nothing says it ever had
	 * tasks (the last complete read in this process, else the heartbeat, absent or 0); otherwise incomplete,
	 * "missing". A complete read with no tasks after a count above 0 tells the owner first (H-STALL-WHOLE-3).
	 */
	async read(now = Date.now()): Promise<RegistryRead> {
		const read = await this.readFile(now);
		if (read.complete) await this.drop.complete(read);
		else if (read.reason === "missing") this.drop.missing();
		return read;
	}

	private async readFile(now: number): Promise<RegistryRead> {
		const started = performance.now();
		const failed = (detail: string): RegistryIncomplete => {
			this.seen = undefined;
			return { complete: false, at: now, reason: "read-error", detail, tasksRead: 0 };
		};
		let fh: FileHandle;
		try {
			// Non-blocking, so a FIFO in the file's place can't stall the round: it is refused below.
			fh = await open(this.file(), STATE_READ_FLAGS);
		} catch (err) {
			const code = (err as NodeJS.ErrnoException)?.code;
			if (code !== "ENOENT") return failed(code ?? String(err));
			this.seen = undefined;
			const had = this.hadTasks();
			if (had) return { complete: false, at: now, reason: "missing", detail: had, tasksRead: 0 };
			const replay = replayEnd(newReplay());
			return { complete: true, at: now, replay, times: new Map(), tasksRead: 0, bytes: 0, tookMs: 0 };
		}
		try {
			const st = await fh.stat();
			if (!st.isFile()) return failed("not a regular file");
			const kept = this.seen;
			if (kept && kept.ino === st.ino && kept.mtimeMs === st.mtimeMs && kept.size === st.size) {
				return { ...kept.read, at: now, tookMs: Math.round(performance.now() - started) };
			}
			const read = await this.stream(fh, now, started);
			if (read.complete) {
				const shrank = readShrank(st.size, read.bytes, (await fh.stat()).size);
				if (shrank) return failed(shrank);
			}
			this.seen = read.complete ? { ino: st.ino, mtimeMs: st.mtimeMs, size: st.size, read } : undefined;
			return read;
		} catch (err) {
			return failed((err as NodeJS.ErrnoException)?.code ?? (err as Error)?.message ?? String(err));
		} finally {
			await fh.close().catch(() => undefined);
		}
	}

	/** Why a missing file isn't a new machine's, in plain words; undefined when nothing says it had tasks. */
	private hadTasks(): string | undefined {
		const where = `not found at ${this.file()}`;
		let beat: RegistryHeartbeat | undefined;
		try {
			beat = this.drop.lastKnown();
		} catch (err) {
			const why = (err as Error)?.message || String(err);
			return `${where}, and the heartbeat can't show it never had tasks (${why})`;
		}
		if (!beat?.tasksRead) return undefined;
		const when = new Date(beat.at).toISOString();
		return `${where}; the last complete read (${when}) had ${beat.tasksRead} linked tasks`;
	}

	private async stream(fh: FileHandle, now: number, started: number): Promise<RegistryRead> {
		const replay = newReplay();
		const times = new StallTimesBuilder();
		const buf = Buffer.allocUnsafe(READ_CHUNK);
		let rest: Buffer = Buffer.alloc(0);
		let pos = 0;
		let lineNo = 0;
		for (;;) {
			const { bytesRead } = await fh.read(buf, 0, buf.length, pos);
			if (!bytesRead) break;
			pos += bytesRead;
			const chunk = rest.length ? Buffer.concat([rest, buf.subarray(0, bytesRead)]) : buf.subarray(0, bytesRead);
			let start = 0;
			for (let nl = chunk.indexOf(NEWLINE); nl >= 0; nl = chunk.indexOf(NEWLINE, start)) {
				lineNo++;
				const bad = lineInto(chunk.toString("utf8", start, nl), replay, times);
				start = nl + 1;
				if (!bad) continue;
				const detail = `line ${lineNo} ${bad}`;
				return { complete: false, at: now, reason: "unreadable-line", detail, tasksRead: replay.links.size };
			}
			// A line not ended yet waits for the next piece (the buffer is reused: copy it).
			rest = Buffer.from(chunk.subarray(start));
		}
		// What is left without its newline is a half-written last line: left out, as the store does.
		return {
			complete: true,
			at: now,
			replay: replayEnd(replay),
			times: times.times,
			tasksRead: replay.links.size,
			bytes: pos,
			tookMs: Math.round(performance.now() - started),
		};
	}
}

/**
 * O1: whether a read missed part of the file: it read less than the size at open, or the file is now smaller
 * than what was read (cut while read). Lines appended during the read are fine. Plain words, or undefined.
 */
export function readShrank(sizeAtOpen: number, bytesRead: number, sizeAfter: number): string | undefined {
	if (bytesRead >= sizeAtOpen && sizeAfter >= bytesRead) return undefined;
	return `the file shrank while it was read (read ${bytesRead} of ${sizeAtOpen} bytes)`;
}

/** One whole line into the replay and the times; what is wrong with it, or undefined when it's fine. */
function lineInto(text: string, replay: WorkReplay, times: StallTimesBuilder): string | undefined {
	if (!text.trim()) return undefined;
	let e: unknown;
	try {
		e = JSON.parse(text);
	} catch {
		return "isn't JSON";
	}
	if (!replayEvent(replay, e)) return "isn't a JSON object";
	times.event(e);
	return undefined;
}

/**
 * A round's inputs from a read: the page with every record and linked task (no display cap), the extra times
 * and the read itself. An incomplete read gives an empty "unreadable" page and no times.
 */
export function watchInputsOf(
	read: RegistryRead,
	facts: readonly WorkQueueFacts[],
	leadUpdates: ReadonlyMap<string, number>,
	at: number,
	gone: ReadonlySet<string> = new Set(),
): RegistryWatchInputs {
	const page = read.complete ? workPageOf(read.replay, facts, at, gone, WORK_PAGE_WHOLE) : EMPTY_PAGE(at, "unreadable");
	const times = read.complete ? read.times : new Map<string, StallTimes>();
	return { page, extra: { times, leadUpdates }, registry: read };
}

/** Whether a page lacks part of the registry: unreadable, or capped for display (dead-end says "unknown"). */
export const pageMissesTasks = (page: Pick<UiWorkPage, "problem">): boolean =>
	page.problem === "unreadable" || page.problem === "too-big";

/** The owner's alarm for an incomplete read (Rule 26: telegram_send, never a question dialog). */
export function registryIncompleteAlarm(watch: string, read: RegistryIncomplete): OwnerTelegramNotice {
	const what = {
		"unreadable-line": "work registry has a line it can't read",
		"read-error": "work registry couldn't be read",
		missing: "work registry file is missing",
	}[read.reason];
	const look =
		read.reason === "missing"
			? "Creating the file (even empty) or fixing the work-folder setting ends this. "
			: `Look at ~/.pi/agent/work/events.jsonl and the pi-web-ui log line "stall: registry not read whole". `;
	return {
		text:
			`The ${watch} can't see all the work: the ${what} (${read.detail}). ` +
			`It is not watching for stuck work until this is fixed, and shows no older findings as current. ` +
			look +
			"This alarm comes once; it comes again only after the watch recovers and then breaks again.",
		from: "ops",
		url: "/",
		linkLabel: "Open pi-web-ui",
	};
}

/** Q-STALL-1: written in the server's data folder after each complete round (the dead man's switch reads it). */
export const STALL_HEARTBEAT_FILE = "stall-watch-heartbeat.json";

/** The heartbeat file's text (Q-STALL-1): `at` as an ISO time, for the scheduled-jobs dead man's switch. */
export function writeRegistryHeartbeat(file: string, beat: RegistryHeartbeat): void {
	const text = `${JSON.stringify({ at: new Date(beat.at).toISOString(), tasksRead: beat.tasksRead })}\n`;
	writeFileSync(`${file}.tmp`, text);
	renameSync(`${file}.tmp`, file);
}

/**
 * The heartbeat file read back (the one reader of what `writeRegistryHeartbeat` writes): undefined when there is
 * no file; throws, in plain words, when it is there but isn't a heartbeat.
 */
export function readRegistryHeartbeat(file: string): RegistryHeartbeat | undefined {
	let text: string;
	try {
		text = readFileSync(file, "utf8");
	} catch (err) {
		if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return undefined;
		throw err;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		parsed = undefined; // Said below.
	}
	const beat = (parsed ?? {}) as { at?: unknown; tasksRead?: unknown };
	const at = typeof beat.at === "string" ? Date.parse(beat.at) : NaN;
	const n = beat.tasksRead;
	if (Number.isFinite(at) && typeof n === "number" && Number.isInteger(n) && n >= 0) return { at, tasksRead: n };
	throw new Error(`${file} isn't a heartbeat`);
}

/** The owner alarm route a watch is given; undefined when there is none yet. */
export type RegistryAlarmRoute = (notice: OwnerTelegramNotice) => Promise<OwnerTelegramResult> | undefined;

/**
 * The registry reader, the owner alarm and the heartbeat writer production uses, over the same heartbeat file in
 * `dataDir`, so a restarted server still knows the registry had tasks (H-STALL-WHOLE-2). `hooks` (a watch's
 * `alarm` and `heartbeat`) and the reader's drop-to-none alarm (H-STALL-WHOLE-3) share the one `alarm` route.
 */
export function registryWatchOf(
	dataDir: string,
	registryFile: () => string,
	route: { alarm?: RegistryAlarmRoute; log?: (line: string) => void } = {},
) {
	const heartbeatFile = join(dataDir, STALL_HEARTBEAT_FILE);
	const given = route.alarm;
	const alarm: OwnerTelegramSender | undefined = given
		? (n) => given(n) ?? Promise.resolve({ ok: false, error: "no owner alarm route" })
		: undefined;
	const heartbeat = (beat: RegistryHeartbeat) => writeRegistryHeartbeat(heartbeatFile, beat);
	const lastBeat = () => readRegistryHeartbeat(heartbeatFile);
	const hooks: RegistryWatchHooks = { alarm, heartbeat };
	return { reader: new WorkRegistryReader(registryFile, lastBeat, { alarm, log: route.log }), heartbeat, hooks };
}
