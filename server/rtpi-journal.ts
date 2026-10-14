/** RTPI/1 serialized journal and checkpoint interface (Ops #136, unit C0 of the Roles rebuild).
 * OFF BY DEFAULT and INERT: no production importer, no default path, no instance, no timer. A journal does I/O only
 * with an explicit grant (rtpiJournalGrant({ enabled: true, directory })) that nothing in production makes in C0.
 * It OBSERVES only: it never dispatches, stops, holds, approves, deletes, repairs or resends, and it never truncates a
 * segment or the checkpoint (only its own single-link scratch file checkpoint.next is rewritten).
 * Files: fixed names inside the granted directory (segment-NNNNNN.rtpi, checkpoint.rtpi, checkpoint.next); record ids
 * are never path parts. Reads refuse symlinks, hard links, FIFOs and anything over the C05 caps (1 MiB per segment,
 * 10 MiB active reads): overflow makes the journal unavailable and deletes nothing.
 * Appends are serialized in-process, framed, fsynced before the ack, and deduplicated by the qualified key: the same
 * record returns the first sequence, another record under the same key is a conflict. Recovery quarantines a torn
 * tail, a corrupt or non-canonical frame, a duplicate or skipped sequence, a replayed key, a segment gap and a journal
 * behind its checkpoint (an old epoch). C01 residual: a same-UID process can still forge or delete these files.
 */
import { constants, type Stats } from "node:fs";
import { lstat, open, opendir, rename, type FileHandle } from "node:fs/promises";
import { isAbsolute, join, normalize } from "node:path";
import {
	RTPI_LIMITS,
	RtpiReject,
	isRtpiAccepted,
	rtpiByteLength,
	rtpiDedupDecision,
	rtpiEncodeFrame,
	rtpiLiveReferenceLost,
	rtpiInitiativesPublicationKey,
	rtpiParseCanonical,
	rtpiRecoverSegment,
	rtpiStructural,
	type RtpiAccepted,
	type RtpiDedupEntry,
	type RtpiLiveSet,
	type RtpiRecoveredFrame,
} from "./rtpi-core.js";

const READ_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
const APPEND_FLAGS = constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW | constants.O_NONBLOCK;
const CREATE_FLAGS = APPEND_FLAGS | constants.O_CREAT | constants.O_EXCL;
// No O_TRUNC: the scratch file is emptied only after fstat proves it is our own single-link regular file, so a hard
// link planted at checkpoint.next can never empty the file it points to.
const SCRATCH_FLAGS = constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK;
const SEGMENT_NAME = /^segment-([0-9]{6})\.rtpi$/;
const CHECKPOINT_FILE = "checkpoint.rtpi";
const CHECKPOINT_NEXT = "checkpoint.next";
const MAX_DIRECTORY_ENTRIES = 64;
const CHECKPOINT_MAX_BYTES = RTPI_LIMITS.rootBytes["rtpi/checkpoint/1"];

function segmentName(n: number): string {
	return `segment-${String(n).padStart(6, "0")}.rtpi`;
}

// ---------------------------------------------------------------- grant (off by default)

export interface RtpiJournalGrant {
	readonly directory: string;
}
const GRANTS = new WeakSet<object>();

/** Returns null unless `enabled` is exactly true. The directory must be an absolute, normalized path; the journal
 * never picks one itself. Nothing in production calls this in C0. */
export function rtpiJournalGrant(input: {
	readonly enabled: boolean;
	readonly directory: string;
}): RtpiJournalGrant | null {
	if (input.enabled !== true) return null;
	const d = input.directory;
	if (typeof d !== "string" || d.includes("\u0000") || !isAbsolute(d) || normalize(d) !== d)
		throw new RtpiReject("journal-directory-not-absolute");
	const grant: RtpiJournalGrant = Object.freeze({
		directory: d,
		toJSON(): never {
			throw new RtpiReject("journal-grant-not-serializable");
		},
	});
	GRANTS.add(grant);
	return grant;
}

// ---------------------------------------------------------------- pure recovery over all segments

export type RtpiJournalRecovery =
	| {
			readonly state: "clean";
			readonly frames: readonly RtpiRecoveredFrame[];
			readonly index: ReadonlyMap<string, RtpiDedupEntry>;
			readonly lastSequence: number;
			readonly lastSegmentBytes: number;
			readonly bytes: number;
	  }
	| { readonly state: "quarantine"; readonly reason: string; readonly lastSequence: number };

/** Pure: recover segments in order (each must end in LF), rebuild the dedup index and check the checkpoint. */
export function rtpiRecoverJournal(segments: readonly string[], checkpoint: RtpiAccepted | null): RtpiJournalRecovery {
	const frames: RtpiRecoveredFrame[] = [];
	const index = new Map<string, RtpiDedupEntry>();
	// I1-only publication heads; reconstructed before accepting further CAS writes. No C0 root uses this map.
	const publicationRevisions = new Map<string, number>();
	let last = 0;
	let bytes = 0;
	let lastSegmentBytes = 0;
	const quarantine = (reason: string): RtpiJournalRecovery => ({ state: "quarantine", reason, lastSequence: last });
	for (const text of segments) {
		const r = rtpiRecoverSegment(text, last);
		// Report the last good sequence before the fault (the segment's own good frames included).
		if (r.state === "quarantine") return { state: "quarantine", reason: r.reason, lastSequence: r.lastSequence };
		for (const f of r.frames) {
			const prior = index.get(f.record.dedupKey);
			if (prior !== undefined)
				return quarantine(prior.digest === f.record.digest ? "frame-dedup-replay" : "frame-dedup-conflict");
			const publicationKey = rtpiInitiativesPublicationKey(f.record);
			if (publicationKey !== null) {
				const revision = publicationRevisions.get(publicationKey) ?? 0;
				if (f.record.root.expectedRevision !== revision || f.record.root.publicationRevision !== revision + 1)
					return quarantine("initiatives-publication-cas-recovery");
				publicationRevisions.set(publicationKey, revision + 1);
			}
			index.set(
				f.record.dedupKey,
				Object.freeze({ key: f.record.dedupKey, digest: f.record.digest, sequence: f.sequence }),
			);
			frames.push(f);
		}
		last = r.lastSequence;
		bytes += r.bytes;
		lastSegmentBytes = r.bytes;
	}
	if (checkpoint !== null) {
		if (!isRtpiAccepted(checkpoint) || checkpoint.schema !== "rtpi/checkpoint/1")
			return quarantine("checkpoint-unverifiable");
		// A checkpoint ahead of the journal means the journal was rolled back to an older epoch.
		if ((checkpoint.root.sequence as number) > last) return quarantine("journal-behind-checkpoint");
	}
	return { state: "clean", frames: Object.freeze(frames), index, lastSequence: last, lastSegmentBytes, bytes };
}

// ---------------------------------------------------------------- file helpers

class JournalStop extends Error {
	constructor(
		readonly status: "quarantine" | "unavailable",
		readonly reason: string,
	) {
		super(reason);
	}
}

function regularSingleLink(st: Stats): boolean {
	return st.isFile() && st.nlink === 1;
}

async function readConfined(
	path: string,
	maxBytes: number,
	overCap: "quarantine" | "unavailable",
): Promise<Buffer | null> {
	let fh: FileHandle;
	try {
		fh = await open(path, READ_FLAGS);
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw new JournalStop("quarantine", "journal-file-not-regular");
	}
	try {
		const st = await fh.stat();
		if (!regularSingleLink(st)) throw new JournalStop("quarantine", "journal-file-not-regular");
		if (st.size > maxBytes) throw new JournalStop(overCap, "journal-read-cap");
		const buf = Buffer.alloc(st.size);
		const { bytesRead } = await fh.read(buf, 0, st.size, 0);
		if (bytesRead !== st.size) throw new JournalStop("quarantine", "journal-file-changed-while-read");
		return buf;
	} finally {
		await fh.close();
	}
}

function decodeText(buf: Buffer): string {
	try {
		return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(buf);
	} catch {
		throw new JournalStop("quarantine", "journal-invalid-utf8");
	}
}

async function writeAll(fh: FileHandle, data: Buffer): Promise<void> {
	let off = 0;
	while (off < data.length) {
		const { bytesWritten } = await fh.write(data, off, data.length - off);
		if (bytesWritten <= 0) throw new Error("short write");
		off += bytesWritten;
	}
}

async function syncDirectory(dir: string): Promise<void> {
	const fh = await open(dir, constants.O_RDONLY | constants.O_DIRECTORY);
	try {
		await fh.sync();
	} finally {
		await fh.close();
	}
}

function liveSetOf(checkpoint: RtpiAccepted): RtpiLiveSet {
	return checkpoint.root as unknown as RtpiLiveSet;
}

// ---------------------------------------------------------------- the journal

export type RtpiJournalStatus = "clean" | "quarantine" | "unavailable";
export interface RtpiJournalState {
	readonly status: RtpiJournalStatus;
	readonly reason: string;
	readonly lastSequence: number;
	readonly segments: number;
	readonly bytes: number;
	readonly checkpointSequence: number | null;
}
export type RtpiAppendResult =
	| { readonly status: "appended" | "duplicate"; readonly sequence: number }
	| { readonly status: "conflict"; readonly sequence: number; readonly reason: "dedup-key-conflict" }
	| { readonly status: "rejected" | "quarantine" | "unavailable"; readonly reason: string };
export type RtpiCheckpointResult =
	| { readonly status: "written"; readonly sequence: number }
	| { readonly status: "rejected" | "quarantine" | "unavailable"; readonly reason: string };

export class RtpiJournal {
	private status: RtpiJournalStatus;
	private reason: string;
	private lastSequence = 0;
	private segment = 0;
	private segmentBytes = 0;
	private bytes = 0;
	private frames: RtpiRecoveredFrame[] = [];
	private index = new Map<string, RtpiDedupEntry>();
	private latest: RtpiAccepted | null = null;
	private publicationRevisions = new Map<string, number>();
	private chain: Promise<unknown> = Promise.resolve();

	private constructor(
		private readonly directory: string | null,
		status: RtpiJournalStatus,
		reason: string,
	) {
		this.status = status;
		this.reason = reason;
	}

	/** Without a grant the journal is off: unavailable, and it touches no file. */
	static async open(grant: RtpiJournalGrant | null): Promise<RtpiJournal> {
		if (grant === null || !GRANTS.has(grant)) return new RtpiJournal(null, "unavailable", "journal-off");
		const j = new RtpiJournal(grant.directory, "clean", "recovered");
		try {
			await j.recover();
		} catch (e) {
			if (!(e instanceof JournalStop)) throw e;
			j.stop(e.status, e.reason);
		}
		return j;
	}

	get state(): RtpiJournalState {
		return Object.freeze({
			status: this.status,
			reason: this.reason,
			lastSequence: this.lastSequence,
			segments: this.segment,
			bytes: this.bytes,
			checkpointSequence: this.latest === null ? null : (this.latest.root.sequence as number),
		});
	}

	/** Recovered and appended frames of a clean journal (at most the 10 MiB active-read cap); none otherwise. */
	records(): readonly RtpiRecoveredFrame[] {
		return this.status === "clean" ? Object.freeze([...this.frames]) : Object.freeze([]);
	}

	/** The latest verified checkpoint of a clean journal, or null. */
	checkpoint(): RtpiAccepted | null {
		return this.status === "clean" ? this.latest : null;
	}

	private stop(status: "quarantine" | "unavailable", reason: string): void {
		this.status = status;
		this.reason = reason;
		this.frames = [];
		this.index = new Map();
		this.latest = null;
		this.publicationRevisions = new Map();
	}

	private serial<T>(fn: () => Promise<T>): Promise<T> {
		const run = this.chain.then(fn, fn);
		this.chain = run.catch(() => undefined);
		return run;
	}

	private path(name: string): string {
		if (this.directory === null) throw new JournalStop("unavailable", "journal-off");
		return join(this.directory, name);
	}

	private async recover(): Promise<void> {
		const dir = this.directory as string;
		let st: Stats;
		try {
			st = await lstat(dir);
		} catch {
			throw new JournalStop("unavailable", "journal-missing");
		}
		const uid = typeof process.getuid === "function" ? process.getuid() : st.uid;
		if (!st.isDirectory() || (st.mode & 0o077) !== 0 || st.uid !== uid)
			throw new JournalStop("unavailable", "journal-directory-not-confined");
		const numbers: number[] = [];
		let entries = 0;
		const handle = await opendir(dir);
		for await (const entry of handle) {
			if (++entries > MAX_DIRECTORY_ENTRIES) throw new JournalStop("unavailable", "journal-directory-crowded");
			const m = SEGMENT_NAME.exec(entry.name);
			if (m !== null) numbers.push(Number(m[1]));
		}
		numbers.sort((a, b) => a - b);
		if (numbers.some((n, i) => n !== i + 1)) throw new JournalStop("quarantine", "segment-gap");
		if (numbers.length > RTPI_LIMITS.segments) throw new JournalStop("unavailable", "journal-active-read-cap");
		const texts: string[] = [];
		let total = 0;
		for (const n of numbers) {
			const buf = await readConfined(this.path(segmentName(n)), RTPI_LIMITS.segmentBytes, "unavailable");
			if (buf === null) throw new JournalStop("quarantine", "segment-gap");
			total += buf.length;
			if (total > RTPI_LIMITS.activeReadBytes) throw new JournalStop("unavailable", "journal-active-read-cap");
			texts.push(decodeText(buf));
		}
		const cpBuf = await readConfined(this.path(CHECKPOINT_FILE), CHECKPOINT_MAX_BYTES + 1, "quarantine");
		let checkpoint: RtpiAccepted | null = null;
		if (cpBuf !== null) {
			const text = decodeText(cpBuf);
			let verdict: ReturnType<typeof rtpiStructural>;
			try {
				if (!text.endsWith("\n")) throw new RtpiReject("torn-checkpoint");
				verdict = rtpiStructural(rtpiParseCanonical(text.slice(0, -1), CHECKPOINT_MAX_BYTES));
			} catch {
				throw new JournalStop("quarantine", "checkpoint-corrupt");
			}
			if (verdict.status !== "accepted" || verdict.schema !== "rtpi/checkpoint/1")
				throw new JournalStop("quarantine", "checkpoint-corrupt");
			checkpoint = verdict;
		}
		const r = rtpiRecoverJournal(texts, checkpoint);
		if (r.state === "quarantine") {
			this.lastSequence = r.lastSequence;
			throw new JournalStop("quarantine", r.reason);
		}
		this.frames = [...r.frames];
		this.publicationRevisions = new Map();
		for (const f of r.frames) {
			const key = rtpiInitiativesPublicationKey(f.record);
			if (key !== null) this.publicationRevisions.set(key, f.record.root.publicationRevision as number);
		}
		this.index = new Map(r.index);
		this.lastSequence = r.lastSequence;
		this.segment = numbers.length;
		this.segmentBytes = r.lastSegmentBytes;
		this.bytes = r.bytes;
		this.latest = checkpoint;
	}

	/** Append one validated record. The ack comes only after the frame is fsynced. */
	append(record: RtpiAccepted): Promise<RtpiAppendResult> {
		return this.serial(async (): Promise<RtpiAppendResult> => {
			if (this.status !== "clean") return { status: this.status, reason: this.reason };
			if (!isRtpiAccepted(record)) return { status: "rejected", reason: "frame-record-not-validated" };
			// Only a record qualified by rtpiValidate (capability + native state) may be appended; structural verdicts
			// (recovery) never enter the journal. In C0 only rtpi-fixture records can qualify (no native registry, T05).
			if (!record.qualified) return { status: "rejected", reason: "record-not-qualified" };
			const d = rtpiDedupDecision(this.index.get(record.dedupKey), { key: record.dedupKey, digest: record.digest });
			if (d.decision === "duplicate") return { status: "duplicate", sequence: d.prior.sequence };
			if (d.decision === "conflict")
				return { status: "conflict", sequence: d.prior.sequence, reason: "dedup-key-conflict" };
			const publicationKey = rtpiInitiativesPublicationKey(record);
			if (publicationKey !== null) {
				const revision = this.publicationRevisions.get(publicationKey) ?? 0;
				if (record.root.expectedRevision !== revision || record.root.publicationRevision !== revision + 1)
					return { status: "rejected", reason: "initiatives-publication-cas" };
			}
			const sequence = this.lastSequence + 1;
			const line = Buffer.from(rtpiEncodeFrame(sequence, record), "utf8");
			if (this.bytes + line.length > RTPI_LIMITS.activeReadBytes) {
				this.stop("unavailable", "journal-active-read-cap");
				return { status: "unavailable", reason: this.reason };
			}
			const fresh = this.segment === 0 || this.segmentBytes + line.length > RTPI_LIMITS.segmentBytes;
			if (fresh && this.segment >= RTPI_LIMITS.segments) {
				this.stop("unavailable", "journal-active-read-cap");
				return { status: "unavailable", reason: this.reason };
			}
			const segment = fresh ? this.segment + 1 : this.segment;
			const expected = fresh ? 0 : this.segmentBytes;
			try {
				const fh = await open(this.path(segmentName(segment)), fresh ? CREATE_FLAGS : APPEND_FLAGS, 0o600);
				try {
					const st = await fh.stat();
					if (!regularSingleLink(st) || st.size !== expected)
						throw new JournalStop("quarantine", "journal-foreign-write");
					await writeAll(fh, line);
					await fh.sync();
				} finally {
					await fh.close();
				}
				if (fresh) await syncDirectory(this.directory as string);
			} catch (e) {
				this.stop("quarantine", e instanceof JournalStop ? e.reason : "journal-append-failed");
				return { status: "quarantine", reason: this.reason };
			}
			if (publicationKey !== null)
				this.publicationRevisions.set(publicationKey, record.root.publicationRevision as number);
			this.lastSequence = sequence;
			this.segment = segment;
			this.segmentBytes = expected + line.length;
			this.bytes += line.length;
			this.index.set(record.dedupKey, Object.freeze({ key: record.dedupKey, digest: record.digest, sequence }));
			this.frames.push(Object.freeze({ sequence, record, bytes: line.length }));
			return { status: "appended", sequence };
		});
	}

	/** Replace the checkpoint atomically (write checkpoint.next, fsync, rename, fsync the directory). The checkpoint
	 * must cover only appended frames, never go backwards and keep every live reference of the previous one. */
	writeCheckpoint(checkpoint: RtpiAccepted): Promise<RtpiCheckpointResult> {
		return this.serial(async (): Promise<RtpiCheckpointResult> => {
			if (this.status !== "clean") return { status: this.status, reason: this.reason };
			if (!isRtpiAccepted(checkpoint) || checkpoint.schema !== "rtpi/checkpoint/1" || !checkpoint.qualified)
				return { status: "rejected", reason: "checkpoint-not-validated" };
			const sequence = checkpoint.root.sequence as number;
			if (sequence > this.lastSequence) return { status: "rejected", reason: "checkpoint-ahead-of-journal" };
			const prev = this.latest;
			if (prev !== null) {
				if (sequence < (prev.root.sequence as number)) return { status: "rejected", reason: "checkpoint-regression" };
				const lost = rtpiLiveReferenceLost(liveSetOf(prev), liveSetOf(checkpoint));
				if (lost !== null) return { status: "rejected", reason: "checkpoint-live-reference-lost-" + lost };
			}
			const next = this.path(CHECKPOINT_NEXT);
			try {
				const fh = await open(next, SCRATCH_FLAGS, 0o600);
				try {
					const st = await fh.stat();
					if (!regularSingleLink(st)) throw new JournalStop("quarantine", "journal-file-not-regular");
					await fh.truncate(0);
					await writeAll(fh, Buffer.from(checkpoint.canonical + "\n", "utf8"));
					await fh.sync();
				} finally {
					await fh.close();
				}
				await rename(next, this.path(CHECKPOINT_FILE));
				await syncDirectory(this.directory as string);
			} catch (e) {
				this.stop("quarantine", e instanceof JournalStop ? e.reason : "checkpoint-write-failed");
				return { status: "quarantine", reason: this.reason };
			}
			this.latest = checkpoint;
			return { status: "written", sequence };
		});
	}
}

/** Canonical byte length of a framed line (for capacity planning; Architecture condition E). */
export function rtpiFrameBytes(sequence: number, record: RtpiAccepted): number {
	return rtpiByteLength(rtpiEncodeFrame(sequence, record));
}
