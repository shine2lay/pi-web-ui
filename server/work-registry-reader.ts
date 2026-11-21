/**
 * work-registry-reader (Ops #1055 step 1 of 2; Q-STALL-1, docs/stall-watch-whole-list.md): the one reader of the
 * work registry (pi-work-management's events.jsonl) for the watches. The stall watch, the dead-end answer and the
 * later silence watch get registry tasks only through it.
 *
 * It has no task-count ceiling: a read is either complete (every line read and replayed) or incomplete, with
 * its reason. A watch that gets an incomplete read raises the owner alarm (`RegistryWatchHooks.alarm`, the lane
 * watchdog's owner Telegram route) in that same round and shows no earlier findings as current; the dead-end
 * answer on it is "unknown". `WORK_PAGE_TASKS_MAX` (work-page.ts) only limits what a page sends for display.
 *
 * Step 1 lands the types and signatures with stub bodies: nothing live calls them yet, and the watches still read
 * through work-page.ts's WorkPageFile. Step 2 builds them (streamed or paged, no ceiling) and wires the watches in;
 * the acceptance cases are tests/acceptance/stall-watch-whole-list.test.ts.
 */

import { readFile } from "node:fs/promises";
import type { OwnerTelegramNotice, OwnerTelegramSender } from "./owner-telegram.js";
import type { UiWorkPage } from "./protocol.js";
import { stallTimesFrom, type StallInputs, type StallTimes } from "./stall-watch.js";
import { replayWork, workPageOf, type WorkQueueFacts, type WorkReplay } from "./work-page.js";

/** Why a read isn't complete: a line that isn't JSON, or the file couldn't be read (an error, not a file). */
export type RegistryIncompleteReason = "unreadable-line" | "read-error";

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

/** What a watch gets besides its read (StallWatchOptions gains these in step 2). */
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

const EMPTY_PAGE = (at: number, problem: UiWorkPage["problem"]): UiWorkPage => ({
	at,
	initiatives: [],
	projects: [],
	tasks: [],
	activity: [],
	...(problem ? { problem } : {}),
});

/** The one reader of the registry file for the watches. */
export class WorkRegistryReader {
	constructor(private readonly file: () => string) {}

	/** Step 1 stub: the whole file at once (step 2: streamed or paged, no ceiling). No file yet: complete, empty. */
	async read(now = Date.now()): Promise<RegistryRead> {
		const started = performance.now();
		let text: string;
		try {
			text = await readFile(this.file(), "utf8");
		} catch (err) {
			const code = (err as NodeJS.ErrnoException)?.code;
			if (code === "ENOENT") text = "";
			else return { complete: false, at: now, reason: "read-error", detail: code ?? String(err), tasksRead: 0 };
		}
		const replay = replayWork(text);
		if (replay.problem) {
			return { complete: false, at: now, reason: "unreadable-line", detail: "a line isn't JSON", tasksRead: 0 };
		}
		return {
			complete: true,
			at: now,
			replay,
			times: stallTimesFrom(text),
			tasksRead: replay.links.size,
			bytes: Buffer.byteLength(text),
			tookMs: Math.round(performance.now() - started),
		};
	}
}

/**
 * A round's inputs from a read: the page (every linked task, for the watches) and the extra times. Step 1 stub:
 * today's page (at most WORK_PAGE_TASKS_MAX tasks, "too-big" past it; "unreadable" for an incomplete read).
 */
export function watchInputsOf(
	read: RegistryRead,
	facts: readonly WorkQueueFacts[],
	leadUpdates: ReadonlyMap<string, number>,
	at: number,
	gone: ReadonlySet<string> = new Set(),
): RegistryWatchInputs {
	const page = read.complete ? workPageOf(read.replay, facts, at, gone) : EMPTY_PAGE(at, "unreadable");
	const times = read.complete ? read.times : new Map<string, StallTimes>();
	return { page, extra: { times, leadUpdates }, registry: read };
}

/** The owner's alarm for an incomplete read (Rule 26: telegram_send, never a question dialog). */
export function registryIncompleteAlarm(watch: string, read: RegistryIncomplete): OwnerTelegramNotice {
	const what = read.reason === "unreadable-line" ? "has a line it can't read" : "couldn't be read";
	return {
		text:
			`The ${watch} can't see all the work: the work registry ${what} (${read.detail}). ` +
			"It found nothing this round and shows no older findings as current. " +
			"Action: look at ~/.pi/agent/work/events.jsonl; the alarm comes again only after it recovers and breaks again.",
		from: "ops",
		url: "/",
		linkLabel: "Open pi-web-ui",
	};
}
