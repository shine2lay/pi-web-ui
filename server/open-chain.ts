// open-chain (Ops #641, H-OPEN-CHAIN-1): the one queue every chat open goes through (ClientSession.create for a
// new window, New chat, opening a past chat, a folder switch). It runs them one at a time, as before, so two opens
// never run on top of each other. What is new: every job says what it is and whose it is, a job still running after
// a minute says so in the log (once a minute), and a job that passes its bound stops holding the queue up.
//
// Why: on 2026-10-29 one open never finished (14:44, a New chat for a look-only window) and, the queue being plain
// `tail.then(job)` with no bound, no window could open a new chat or an old one for 78 minutes, with nothing in the
// log, until a restart.
//
// Giving way is not cancelling. JavaScript can't stop a job that is waiting on something; the stuck job keeps
// running and may still finish. So it is only stepped around, and what it may still touch stays its own until it
// ends ("held"):
//   - its window (owner): a later job of the same window waits for it, so one window's state is never changed by
//     two opens at once;
//   - the transcript it may be opening from disk (disk): a later job that may open the same transcript waits for it,
//     so one transcript never gets two runtimes (two writers). A job that opens a folder's most recent chat (a new
//     window, a folder switch) names that folder's chats folder; it holds all of it, and when it is the later job,
//     it asks which file it would open now (only then, so an ordinary open pays nothing). "any" = can't tell:
//     conflicts with every disk job.
// A later job that has to wait for a held job steps out of the line while it waits (so it never holds up anyone
// else's open), then takes its place at the end of the line again. If the held job hasn't ended within the later
// job's own bound, the later job gives way without ever having started (nothing of it ran). Jobs that finish
// normally keep the queue's order exactly as before. Nothing here reads or writes a transcript.

/** What a queued open is, for the log and for what it holds if it gives way. */
export interface OpenJob {
	/** What it is, e.g. "new chat", "open /path/to/chat.jsonl", "folder switch to /x", "client create (blank)". */
	label: string;
	/** The window (client id) it belongs to. */
	owner: string;
	/** The transcript it may open from disk: its path; a folder's most recent chat (OpenRecent); "any" when it
	 *  can't be told; null for none. */
	disk: string | OpenRecent | null;
}

/** A job that opens the most recent chat of a chats folder, unless it lands elsewhere (an open chat, a blank one). */
export interface OpenRecent {
	/** The chats folder (absolute). */
	dir: string;
	/** The file it would open from disk if it started now, or null when it would open none. */
	newest: () => string | null;
}

const dirOf = (file: string) => file.slice(0, Math.max(0, file.lastIndexOf("/")));
const diskText = (d: OpenJob["disk"]) =>
	d === null ? "" : d === "any" ? "any chat from disk" : typeof d === "string" ? d : `the chats in ${d.dir}`;

export interface OpenChainTiming {
	/** How long a started job may hold the queue before the next job goes ahead. */
	boundMs: number;
	/** A job still running after this gets its first log line. */
	slowAfterMs: number;
	/** Then one line per this, until it ends. */
	slowEveryMs: number;
}

/** The bound (Ops #641): measured honest opens of the biggest home chats took at most ~53 s of wall time (ops
 *  234 MB at load 164, before the one-parse open of #638; 29 s after it), so five minutes is well above any honest
 *  open, and it is the time pi-web-deploy's big-chat check already allows one open. */
export const OPEN_CHAIN_TIMING: OpenChainTiming = { boundMs: 300_000, slowAfterMs: 60_000, slowEveryMs: 60_000 };

/** The caller of a job that gave way (or never got to start) gets this: an honest failure it can show. */
export class OpenGaveWayError extends Error {
	readonly code = "open_gave_way";
	constructor(
		readonly job: OpenJob,
		readonly started: boolean,
		message: string,
	) {
		super(message);
		this.name = "OpenGaveWayError";
	}
}

export const isOpenGaveWay = (err: unknown): err is OpenGaveWayError =>
	err instanceof OpenGaveWayError || (err as { code?: unknown } | null)?.code === "open_gave_way";

interface Held {
	job: OpenJob;
	since: number;
	done: Promise<void>;
	end: () => void;
}

export interface OpenChain {
	<T>(job: OpenJob, run: () => Promise<T>, onLate?: (value: T) => void): Promise<T>;
	/** Jobs that gave way and haven't ended yet (for the log and tests). */
	held(): readonly { job: OpenJob; since: number }[];
}

const secs = (ms: number) => `${Math.round(ms / 1000)} s`;
const who = (j: OpenJob) => `${j.label} (window ${j.owner})`;

/** A later job can't start while a held (gave way, not ended) job belongs to the same window, or may hold the
 *  transcript the later job may open. */
export function openJobsConflict(held: OpenJob, later: OpenJob): boolean {
	if (held.owner === later.owner) return true;
	const h = held.disk;
	const l = later.disk;
	if (h === null || l === null) return false;
	if (h === "any" || l === "any") return true;
	if (typeof h === "string" && typeof l === "string") return h === l;
	if (typeof h !== "string" && typeof l === "string") return dirOf(l) === h.dir;
	// The later job opens a folder's most recent chat: which file would it be now?
	const lr = l as OpenRecent;
	let file: string | null;
	try {
		file = lr.newest();
	} catch {
		return true; // can't tell: wait
	}
	if (file === null) return false;
	return typeof h === "string" ? file === h : dirOf(file) === h.dir || lr.dir === h.dir;
}

type Outcome<T> = { ok: true; value: T } | { ok: false; error: unknown };

export function makeOpenChain(opts: {
	timing: () => OpenChainTiming;
	log?: (line: string) => void;
	now?: () => number;
}): OpenChain {
	const log = opts.log ?? ((line: string) => console.warn(line));
	const now = opts.now ?? Date.now;
	let tail: Promise<void> = Promise.resolve();
	let waiting = 0;
	const held = new Set<Held>();

	/** A place in the line: resolves with the function that lets the next job go. */
	const turn = (): Promise<() => void> => {
		const prev = tail;
		let release!: () => void;
		tail = new Promise<void>((r) => {
			release = r;
		});
		waiting++;
		return prev.then(() => {
			waiting--;
			return release;
		});
	};

	/** Resolves true when `p` settles, false when `ms` passes first. */
	const within = (p: Promise<unknown>, ms: number): Promise<boolean> =>
		new Promise<boolean>((resolve) => {
			const timer = setTimeout(() => resolve(false), Math.max(0, ms));
			timer.unref?.();
			void p.then(() => {
				clearTimeout(timer);
				resolve(true);
			});
		});

	const chain = async <T>(job: OpenJob, run: () => Promise<T>, onLate?: (value: T) => void): Promise<T> => {
		let release = await turn();
		const t = opts.timing();
		const firstTurnAt = now();

		// 1. Wait (out of the line) for held jobs it can't run beside.
		for (;;) {
			const blockers = [...held].filter((h) => openJobsConflict(h.job, job));
			if (!blockers.length) break;
			release();
			log(
				`[open-chain] ${who(job)} waits for ${blockers.map((b) => who(b.job)).join(", ")}, which gave way earlier and hasn't ended; other opens go ahead meanwhile`,
			);
			const ended = await within(Promise.all(blockers.map((b) => b.done)), t.boundMs - (now() - firstTurnAt));
			if (!ended) {
				log(`[open-chain] gave way after ${secs(now() - firstTurnAt)} without starting: ${who(job)}`);
				throw new OpenGaveWayError(
					job,
					false,
					`Opening timed out: "${job.label}" waited ${secs(t.boundMs)} on an earlier open of the same window or chat that never finished. Try again in a new tab; the server log names the stuck open ([open-chain]).`,
				);
			}
			release = await turn();
		}

		// 2. Run it, bounded.
		const startedAt = now();
		let ended = false;
		let gaveWay = false;
		let slowTimer: ReturnType<typeof setTimeout> | null = null;
		let lastHeldLog = 0;
		const slow = () => {
			if (ended) return;
			const ran = now() - startedAt;
			if (!gaveWay) {
				log(
					`[open-chain] still running after ${secs(ran)}: ${who(job)}; ${waiting} open(s) waiting behind it; it gives way at ${secs(t.boundMs)}`,
				);
			} else if (now() - lastHeldLog >= 15 * t.slowEveryMs) {
				// After giving way it only holds its window (and transcript): a line every quarter hour is enough.
				lastHeldLog = now();
				log(`[open-chain] still not ended after ${secs(ran)} (gave way at ${secs(t.boundMs)}): ${who(job)}`);
			}
			slowTimer = setTimeout(slow, t.slowEveryMs);
			slowTimer.unref?.();
		};
		slowTimer = setTimeout(slow, t.slowAfterMs);
		slowTimer.unref?.();

		const running: Promise<Outcome<T>> = (async () => {
			try {
				return { ok: true as const, value: await run() };
			} catch (error) {
				return { ok: false as const, error };
			}
		})().then((outcome) => {
			ended = true;
			if (slowTimer) clearTimeout(slowTimer);
			slowTimer = null;
			return outcome;
		});

		const inTime = await within(running, t.boundMs);
		if (inTime) {
			release();
			const outcome = await running;
			if (outcome.ok) return outcome.value;
			throw outcome.error;
		}

		// 3. It gave way: the line goes on; it keeps its window (and transcript) until it ends.
		gaveWay = true;
		lastHeldLog = now();
		let end!: () => void;
		const done = new Promise<void>((r) => {
			end = r;
		});
		const mine: Held = { job, since: now(), done, end };
		held.add(mine);
		log(
			`[open-chain] gave way after ${secs(now() - startedAt)}: ${who(job)} is still running; the next open goes ahead, its caller gets an error, and it keeps window ${job.owner}${job.disk ? ` and ${diskText(job.disk)}` : ""} until it ends`,
		);
		release();
		void running.then((outcome) => {
			held.delete(mine);
			mine.end();
			log(
				`[open-chain] ${who(job)} ended ${secs(now() - startedAt)} after it started (${outcome.ok ? "finished" : `failed: ${outcome.error instanceof Error ? outcome.error.message : String(outcome.error)}`}), after giving way; its caller had already been told it failed`,
			);
			if (outcome.ok && onLate) {
				try {
					onLate(outcome.value);
				} catch (err) {
					log(`[open-chain] cleaning up after ${who(job)} failed: ${err instanceof Error ? err.message : String(err)}`);
				}
			}
		});
		throw new OpenGaveWayError(
			job,
			true,
			`Opening timed out: "${job.label}" was still running after ${secs(t.boundMs)}, so other windows' opens went ahead without it. Try again; if it keeps happening, the server log names the stuck open ([open-chain]).`,
		);
	};
	const out = chain as OpenChain;
	out.held = () => [...held].map((h) => ({ job: h.job, since: h.since }));
	return out;
}
