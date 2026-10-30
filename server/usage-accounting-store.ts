/** Inert, worker-private durable I/O. Numeric journal is authority; the index is disposable. */
import {
	closeSync,
	constants,
	fstatSync,
	fsyncSync,
	ftruncateSync,
	lstatSync,
	mkdirSync,
	openSync,
	opendirSync,
	readSync,
	renameSync,
	writeSync,
	type Stats,
} from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { resolve, sep } from "node:path";
import { setImmediate as pause } from "node:timers/promises";
import { isMainThread } from "node:worker_threads";
import { GuardFileLock } from "./role-message-guard-lock.js";
import { threadCpuMs } from "./thread-cpu-clock.js";
import type {
	CollectorIndexEntry,
	CollectorIndexPage,
	CollectorIndexValue,
	CollectorNumericIndex,
	JournalPosition,
	PagedCollectorCheckpoint,
	PagedCollectorIO,
} from "./usage-accounting-collector.js";
import {
	METER_LIMITS,
	validateMeterIndexCheckpoint,
	type MeterIndexCheckpoint,
	type MeterNativeCursor,
} from "./usage-accounting-meter-contract.js";

export const USAGE_STORE_LIMITS = Object.freeze({
	journalBytes: METER_LIMITS.journalBytes,
	segments: METER_LIMITS.segments,
	indexBytes: METER_LIMITS.indexBytes,
	indexEntries: METER_LIMITS.indexEntries,
	metadataBytes: 16 * 1024 * 1024,
	directoryEntries: 8192,
	indexKeyBytes: 2048,
	indexSliceNodes: 256,
});
const STORE_CODES = [
	"worker-required",
	"unsafe-path",
	"permission-denied",
	"newer-store-major",
	"store-version",
	"waiting-for-previous-writer",
	"writer-lost",
	"io-failure",
	"journal-tail",
	"journal-corrupt",
	"checkpoint-corrupt",
	"index-unavailable",
	"native-unavailable",
	"store-capacity",
	"migration-prepared",
	"closed",
] as const;
export type UsageStoreCode = (typeof STORE_CODES)[number];
export type UsageStorePoint =
	| "journal-write"
	| "after-append"
	| "journal-sync"
	| "after-journal-sync"
	| "checkpoint-write"
	| "checkpoint-sync"
	| "checkpoint-rename"
	| "after-checkpoint-rename"
	| "checkpoint-dir-sync"
	| "index-write"
	| "index-sync"
	| "native-write"
	| "reopen";
export interface UsageStoreOptions {
	dataDir: string;
	/** One host-owned process-lifetime cell, shared by EVERY worker for this dataDir. Never clear on uncertain death. */
	lease: SharedArrayBuffer;
	/** Smaller operational capacities for fixed fixtures/admission; never greater than W0's limits. */
	limits?: Partial<{ [K in "journalBytes" | "segments" | "indexBytes" | "indexEntries" | "metadataBytes"]: number }>;
	/** Private deterministic crash seam. A number injects a short write at a *-write point. */
	fault?: (point: UsageStorePoint) => number | void;
}
export class UsageStoreError extends Error {
	constructor(readonly code: UsageStoreCode) {
		super(code);
	}
}
const fail = (code: UsageStoreCode): never => {
	throw new UsageStoreError(code);
};
function check(ok: unknown, code: UsageStoreCode = "io-failure"): asserts ok {
	if (!ok) fail(code);
}
const size = (text: string) => Buffer.byteLength(text);
const sha = (data: string | Uint8Array) => createHash("sha256").update(data).digest("hex");
const hex = () => randomBytes(32).toString("hex");
const ZERO = "0".repeat(64);
const PAGE: { maxBytes: number; maxRows: number } = {
	maxBytes: METER_LIMITS.pageBytes,
	maxRows: METER_LIMITS.pageRows,
};
function canonical(raw: unknown): string {
	if (Array.isArray(raw)) return `[${raw.map(canonical).join(",")}]`;
	if (raw !== null && typeof raw === "object")
		return `{${Object.keys(raw)
			.sort()
			.map((k) => `${JSON.stringify(k)}:${canonical((raw as Record<string, unknown>)[k])}`)
			.join(",")}}`;
	return JSON.stringify(raw) ?? "null";
}
function prefix(text: string): PagedCollectorCheckpoint | null {
	try {
		if (size(text) > METER_LIMITS.checkpointBytes) return null;
		const p = JSON.parse(text) as PagedCollectorCheckpoint;
		if (
			Object.keys(p).sort().join() !== "end,sequence,sha256,v" ||
			p.v !== "usage-paged-checkpoint/1" ||
			!Number.isSafeInteger(p.sequence) ||
			p.sequence < 0 ||
			p.sequence > METER_LIMITS.frames ||
			!/^[a-f0-9]{64}$/.test(p.sha256) ||
			!p.end ||
			Object.keys(p.end).sort().join() !== "offset,segment" ||
			!Number.isSafeInteger(p.end.segment) ||
			p.end.segment < 1 ||
			p.end.segment > METER_LIMITS.segments ||
			!Number.isSafeInteger(p.end.offset) ||
			p.end.offset < 0 ||
			p.end.offset > METER_LIMITS.segmentBytes
		)
			return null;
		return p;
	} catch {
		return null;
	}
}
function samePrefix(a: PagedCollectorCheckpoint | null, b: PagedCollectorCheckpoint): boolean {
	return (
		a !== null &&
		a.sequence === b.sequence &&
		a.sha256 === b.sha256 &&
		a.end.segment === b.end.segment &&
		a.end.offset === b.end.offset
	);
}
const initialPrefix = (): PagedCollectorCheckpoint => ({
	v: "usage-paged-checkpoint/1",
	sequence: 0,
	end: { segment: 1, offset: 0 },
	sha256: ZERO,
});
const segmentName = (n: number) => `journal-${String(n).padStart(6, "0")}.numeric`;
const uid = () => process.getuid?.() ?? fail("unsafe-path");
const missing = (e: unknown) => (e as NodeJS.ErrnoException).code === "ENOENT";
const identity = (a: Stats, b: Stats) => a.dev === b.dev && a.ino === b.ino;
const fdPath = (fd: number, name?: string) => `/proc/self/fd/${fd}${name === undefined ? "" : `/${name}`}`;
function privateFile(st: Stats): void {
	check(st.isFile() && st.nlink === 1 && st.uid === uid(), "unsafe-path");
	check((st.mode & 0o777) === 0o600, "permission-denied");
}
function directory(path: string, mode?: number): number {
	const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
	try {
		const st = fstatSync(fd);
		check(st.isDirectory(), "unsafe-path");
		if (mode !== undefined) {
			check(st.uid === uid(), "unsafe-path");
			check(mode === 0o700 ? (st.mode & 0o777) === mode : (st.mode & 0o022) === 0, "permission-denied");
		}
		return fd;
	} catch (e) {
		closeSync(fd);
		throw e;
	}
}
/** Walk every component with O_NOFOLLOW; pin the final trusted parent, not a string realpath. */
function dataDirectory(path: string): number {
	const absolute = resolve(path);
	let fd = directory(sep);
	try {
		for (const part of absolute.split(sep).filter(Boolean)) {
			const next = directory(fdPath(fd, part));
			closeSync(fd);
			fd = next;
		}
		const st = fstatSync(fd);
		check(st.uid === uid(), "unsafe-path");
		check((st.mode & 0o022) === 0, "permission-denied");
		return fd;
	} catch (e) {
		closeSync(fd);
		throw e;
	}
}
interface StoreHeader {
	v: "usage-accounting-store";
	major: number;
	minor: number;
	generation: string;
}
interface OpenFile {
	fd: number;
	stat: Stats;
}
type MetadataName = "checkpoint.numeric" | "native.numeric" | "checkpoint.previous.numeric" | "native.previous.numeric";

/** All filesystem/hash work stays in this lifetime-locked worker; no libuv pool jobs are submitted. */
export class UsageAccountingStore implements PagedCollectorIO {
	readonly v = "usage-collector-paged-io/1" as const;
	readonly index: CollectorNumericIndex;
	readonly limits: { -readonly [K in keyof typeof USAGE_STORE_LIMITS]: number };
	private phase: "ready" | "waiting-for-previous-writer" | "unavailable" | "closed" = "unavailable";
	private code: UsageStoreCode | null = null;
	private alarms = new Set<UsageStoreCode>();
	private parent = -1;
	private root = -1;
	private rootStat: Stats | null = null;
	private lock: GuardFileLock | null = null;
	private lease: Int32Array | null = null;
	private heldLease = false;
	private header: StoreHeader | null = null;
	private serial: Promise<unknown> = Promise.resolve();
	private outstanding = 0;
	private cache: NumericDiskIndex;
	private sizes: number[] = [];
	private segmentIds: Stats[] = [];
	private synced: boolean[] = [];
	private headed = false;
	private proven = initialPrefix();
	private durable = initialPrefix();
	private published: PagedCollectorCheckpoint | null = null;
	private candidate: PagedCollectorCheckpoint | null = null;
	private checkpointText: string | null = null;
	private candidateMatched = true;
	private unanchored = false;
	private verificationBroken = false;
	private carry = Buffer.alloc(0);
	private readSegment = 1;
	private readOffset = 0;
	private lineOffset = 0;
	private pending: PagedCollectorCheckpoint | null = null;
	private nativeCandidate: MeterIndexCheckpoint | null = null;
	private nativeText: string | null = null;
	private nativeTrusted = false;
	private recoveryBytes = 0;
	private recoveryReadBytes = 0;
	private recovered = false;
	private metadataBytes = 0;
	private counters = { reads: 0, maxReadBytes: 0, maxStagingBytes: 0, journalBytes: 0, yields: 0, maxOutstanding: 0 };
	private constructor(private readonly o: UsageStoreOptions) {
		this.limits = { ...USAGE_STORE_LIMITS };
		for (const [k, value] of Object.entries(o.limits ?? {})) {
			check(
				Object.hasOwn(USAGE_STORE_LIMITS, k) &&
					Number.isSafeInteger(value) &&
					value! > 0 &&
					value! <= USAGE_STORE_LIMITS[k as keyof typeof USAGE_STORE_LIMITS],
				"store-capacity",
			);
			this.limits[k as keyof typeof USAGE_STORE_LIMITS] = value!;
		}
		Object.freeze(this.limits);
		this.cache = new NumericDiskIndex(this);
		this.index = this.cache;
	}
	static async open(o: UsageStoreOptions): Promise<UsageAccountingStore> {
		const store = new UsageAccountingStore(o);
		try {
			await store.start();
		} catch (e) {
			store.unavailable(e);
		}
		return store;
	}
	status(): {
		state: UsageAccountingStore["phase"];
		code: UsageStoreCode | null;
		alarms: { code: UsageStoreCode; count: number }[];
	} {
		if (this.phase === "ready") {
			try {
				this.owned();
			} catch (e) {
				this.unavailable(e);
			}
		}
		return { state: this.phase, code: this.code, alarms: [...this.alarms].sort().map((code) => ({ code, count: 1 })) };
	}
	metrics() {
		return { ...this.counters, metadataBytes: this.metadataBytes, index: this.cache.metrics() };
	}
	private unavailable(e: unknown): void {
		this.code = e instanceof UsageStoreError ? e.code : "io-failure";
		const wasReady = this.phase === "ready";
		this.phase = "unavailable";
		this.alarms.add(this.code);
		if (wasReady) {
			try {
				this.owned();
				this.fault(this.code);
			} catch {
				/* Never write after ownership loss. */
			}
		}
	}
	private waiting(): void {
		this.phase = "waiting-for-previous-writer";
		this.code = "waiting-for-previous-writer";
	}
	private async start(): Promise<void> {
		check(!isMainThread, "worker-required");
		check(this.o.lease instanceof SharedArrayBuffer && this.o.lease.byteLength === 4, "unsafe-path");
		this.lease = new Int32Array(this.o.lease);
		if (Atomics.compareExchange(this.lease, 0, 0, 1) !== 0) {
			this.waiting();
			return;
		}
		this.heldLease = true;
		this.parent = dataDirectory(this.o.dataDir);
		try {
			mkdirSync(fdPath(this.parent, "usage-accounting"), { mode: 0o700 });
			fsyncSync(this.parent);
		} catch (e) {
			if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
		}
		this.root = directory(fdPath(this.parent, "usage-accounting"), 0o700);
		this.rootStat = fstatSync(this.root);
		// Refuse an unknown major BEFORE the lock helper can move even a stale lock.
		const oldHeader = this.small("header.numeric", 1024);
		if (oldHeader !== null) this.header = this.parseHeader(oldHeader);
		this.lock = new GuardFileLock({ dir: fdPath(this.root), log: () => undefined });
		const lockPath = fdPath(this.root, "lock");
		try {
			const st = lstatSync(lockPath);
			privateFile(st);
			const text = this.small("lock", 32)!;
			const pid = Number(text.trim());
			check(Number.isSafeInteger(pid) && pid > 0, "unsafe-path");
			let alive = true;
			try {
				process.kill(pid, 0);
			} catch (e) {
				alive = (e as NodeJS.ErrnoException).code !== "ESRCH";
			}
			if (alive) {
				this.waiting();
				return;
			}
		} catch (e) {
			if (!missing(e)) throw e;
		}
		if (this.lock.check() !== null || this.lock.takeLock() !== null) {
			this.waiting();
			return;
		}
		// No sweeping: the reviewed helper owns its own transient lock files, not accounting evidence.
		privateFile(lstatSync(lockPath));
		if (this.header === null) {
			check(
				this.names().every((n) => n === "lock" || /^lock\.(?:tmp|stale)-\d+$/.test(n)),
				"store-version",
			);
			this.header = { v: "usage-accounting-store", major: 1, minor: 0, generation: hex() };
			const text = canonical(this.header) + "\n";
			this.capacityMetadata(size(text));
			this.create("header.numeric", text);
		}
		this.o.fault?.("reopen");
		this.phase = "ready";
		this.code = null;
	}
	private parseHeader(text: string): StoreHeader {
		let h: StoreHeader;
		try {
			h = JSON.parse(text) as StoreHeader;
		} catch {
			return fail("store-version");
		}
		check(h !== null && typeof h === "object" && Number.isSafeInteger(h.major), "store-version");
		check(h.major <= 1, "newer-store-major");
		check(
			h.v === "usage-accounting-store" &&
				h.major === 1 &&
				h.minor === 0 &&
				/^[a-f0-9]{64}$/.test(h.generation) &&
				Object.keys(h).sort().join() === "generation,major,minor,v",
			"store-version",
		);
		return h;
	}
	private anchored(): void {
		check(this.root >= 0 && this.parent >= 0 && this.rootStat, "unsafe-path");
		check(identity(lstatSync(fdPath(this.parent, "usage-accounting")), this.rootStat), "unsafe-path");
		const st = fstatSync(this.root);
		check(st.uid === uid() && (st.mode & 0o777) === 0o700, "permission-denied");
	}
	private owned(): void {
		this.anchored();
		check(
			this.heldLease && this.lease && Atomics.load(this.lease, 0) === 1 && this.lock?.lockLost() === null,
			"writer-lost",
		);
	}
	/** Bounded queue: one active synchronous/worker operation and at most one waiting caller. */
	operation<T>(fn: () => T | Promise<T>): Promise<T> {
		if (this.phase !== "ready") return Promise.reject(new UsageStoreError(this.code ?? "closed"));
		if (this.outstanding >= 2) return Promise.reject(new UsageStoreError("store-capacity"));
		this.outstanding++;
		this.counters.maxOutstanding = Math.max(this.counters.maxOutstanding, this.outstanding);
		const run = this.serial.then(async () => {
			try {
				check(this.phase === "ready", this.code ?? "closed");
				this.owned();
				return await fn();
			} catch (e) {
				this.unavailable(e);
				throw new UsageStoreError(this.code!);
			} finally {
				this.outstanding--;
			}
		});
		this.serial = run.catch(() => undefined);
		return run;
	}
	private names(fd = this.root): string[] {
		const dir = opendirSync(fdPath(fd)),
			result: string[] = [];
		try {
			for (;;) {
				const e = dir.readSync();
				if (e === null) break;
				check(result.length < this.limits.directoryEntries, "store-capacity");
				result.push(e.name);
			}
		} finally {
			dir.closeSync();
		}
		return result;
	}
	file(name: string, create = false, at = this.root): OpenFile {
		check(/^[a-z0-9.-]+$/.test(name), "unsafe-path");
		const path = fdPath(at, name);
		if (!create) privateFile(lstatSync(path));
		const fd = openSync(
			path,
			constants.O_RDWR |
				constants.O_NOFOLLOW |
				constants.O_NONBLOCK |
				(create ? constants.O_CREAT | constants.O_EXCL : 0),
			0o600,
		);
		try {
			const stat = fstatSync(fd);
			privateFile(stat);
			const after = lstatSync(path);
			privateFile(after);
			check(identity(stat, after), "unsafe-path");
			return { fd, stat };
		} catch (e) {
			closeSync(fd);
			throw e;
		}
	}
	private small(name: string, cap: number): string | null {
		let f: OpenFile;
		try {
			f = this.file(name);
		} catch (e) {
			if (missing(e)) return null;
			throw e;
		}
		try {
			check(f.stat.size <= cap, "store-capacity");
			const pages: Buffer[] = [];
			for (let at = 0; at < f.stat.size; at += METER_LIMITS.pageBytes)
				pages.push(this.read(f.fd, at, Math.min(METER_LIMITS.pageBytes, f.stat.size - at)));
			return new TextDecoder("utf8", { fatal: true }).decode(Buffer.concat(pages));
		} finally {
			closeSync(f.fd);
		}
	}
	/** W0's newBytes is a conservative upper bound >= its frame; keep disk's fault reserve too. */
	admitJournal(newBytes: number): boolean {
		return (
			this.counters.journalBytes + newBytes + 1024 <= this.limits.journalBytes &&
			this.sizes.length + 1 <= this.limits.segments - 1
		);
	}
	checkFile(name: string, fd: number): Stats {
		const pathStat = lstatSync(fdPath(this.root, name)),
			st = fstatSync(fd);
		privateFile(pathStat);
		privateFile(st);
		check(identity(pathStat, st), "unsafe-path");
		return st;
	}
	syncRoot(): void {
		fsyncSync(this.root);
	}
	inject(point: UsageStorePoint): void {
		this.o.fault?.(point);
	}
	read(fd: number, offset: number, length: number): Buffer {
		check(Number.isSafeInteger(length) && length >= 0 && length <= METER_LIMITS.pageBytes, "store-capacity");
		const b = Buffer.alloc(length);
		check(readSync(fd, b, 0, length, offset) === length, "io-failure");
		this.counters.reads++;
		this.counters.maxReadBytes = Math.max(this.counters.maxReadBytes, length);
		return b;
	}
	write(fd: number, buffer: Uint8Array, offset: number, point?: UsageStorePoint): void {
		const injected = point === undefined ? undefined : this.o.fault?.(point);
		this.owned();
		const length =
			typeof injected === "number" ? Math.max(0, Math.min(buffer.byteLength - 1, injected)) : buffer.byteLength;
		check(writeSync(fd, buffer, 0, length, offset) === buffer.byteLength, "io-failure");
	}
	private create(name: string, text: string): void {
		const f = this.file(name, true);
		try {
			this.write(f.fd, Buffer.from(text), 0);
			fsyncSync(f.fd);
		} finally {
			closeSync(f.fd);
		}
		fsyncSync(this.root);
	}
	private fault(code: UsageStoreCode): void {
		this.alarms.add(code);
		// A separate bounded fixed receipt can survive a corrupt journal; failure is NOT durability.
		try {
			const name = `fault-${code}.numeric`,
				text = canonical({ v: "usage-store-fault/1", code }) + "\n";
			if (this.small(name, 1024) === null) {
				this.capacityMetadata(size(text));
				this.create(name, text);
				this.metadataBytes += size(text);
			}
		} catch {
			/* the original bytes stay; the caller's failure remains unavailable */
		}
	}
	private capacityMetadata(add: number): void {
		check(this.metadataBytes + add <= this.limits.metadataBytes, "store-capacity");
	}
	private preserve(name: "checkpoint.numeric" | "native.numeric", text: string): void {
		const saved = `evidence-${name.slice(0, -8)}-${sha(text)}.numeric`;
		const previous = this.small(saved, METER_LIMITS.checkpointBytes);
		if (previous !== null) {
			check(previous === text, "checkpoint-corrupt");
			return;
		}
		this.capacityMetadata(size(text));
		this.create(saved, text);
		this.metadataBytes += size(text);
	}
	private atomic(name: MetadataName, text: string, point: "checkpoint" | "native" | "backup"): void {
		check(size(text) <= METER_LIMITS.checkpointBytes, "store-capacity");
		let previous: Stats | null = null;
		try {
			previous = lstatSync(fdPath(this.root, name));
			privateFile(previous);
		} catch (e) {
			if (!missing(e)) throw e;
		}
		const priorText = previous === null ? null : this.small(name, METER_LIMITS.checkpointBytes);
		// An untrusted primary must NEVER replace the last valid previous state.
		let trusted = false;
		if (point === "checkpoint") {
			trusted =
				priorText === this.checkpointText && this.candidateMatched && !this.unanchored && !this.verificationBroken;
		} else if (point === "native") {
			trusted = priorText === this.nativeText && this.nativeTrusted;
		}
		if (priorText !== null && (name === "checkpoint.numeric" || name === "native.numeric")) {
			if (trusted) {
				this.atomic(
					point === "checkpoint" ? "checkpoint.previous.numeric" : "native.previous.numeric",
					priorText,
					"backup",
				);
			} else {
				this.preserve(name, priorText);
			}
		}
		// Reserve both the scratch and a failure-only compatible evidence copy before replacement.
		this.capacityMetadata(size(text) + (previous?.size ?? 0));
		const scratch = `${name}.next-${hex()}`,
			f = this.file(scratch, true);
		let accounted = false;
		try {
			const bytes = Buffer.from(text);
			for (let at = 0; at < bytes.length; at += METER_LIMITS.pageBytes)
				this.write(
					f.fd,
					bytes.subarray(at, at + METER_LIMITS.pageBytes),
					at,
					point === "native" ? "native-write" : point === "checkpoint" ? "checkpoint-write" : undefined,
				);
			if (point === "checkpoint") this.o.fault?.("checkpoint-sync");
			this.owned();
			this.checkFile(scratch, f.fd);
			fsyncSync(f.fd);
			this.metadataBytes += fstatSync(f.fd).size;
			accounted = true;
			if (point === "checkpoint") this.o.fault?.("checkpoint-rename");
			this.owned();
			this.checkFile(scratch, f.fd);
			let target: Stats | null = null;
			try {
				target = lstatSync(fdPath(this.root, name));
				privateFile(target);
			} catch (e) {
				if (!missing(e)) throw e;
			}
			check(previous === null ? target === null : target !== null && identity(previous, target), "unsafe-path");
			renameSync(fdPath(this.root, scratch), fdPath(this.root, name));
			if (point === "checkpoint") this.o.fault?.("after-checkpoint-rename");
			this.owned();
			this.checkFile(name, f.fd);
			if (point === "checkpoint") this.o.fault?.("checkpoint-dir-sync");
			this.owned();
			this.checkFile(name, f.fd);
			fsyncSync(this.root);
			this.checkFile(name, f.fd);
			this.metadataBytes -= previous?.size ?? 0;
		} catch (e) {
			if (priorText !== null && (name === "checkpoint.numeric" || name === "native.numeric")) {
				try {
					this.owned();
					this.preserve(name, priorText);
				} catch {
					/* Prior state was already durable before replacement; never write after ownership loss. */
				}
			}
			throw e;
		} finally {
			if (!accounted) this.metadataBytes += fstatSync(f.fd).size;
			closeSync(f.fd);
		}
	}
	async head(_limits: typeof METER_LIMITS): Promise<{ sizes: number[]; checkpoint: string | null }> {
		return this.operation(async () => {
			check(!this.headed, "journal-corrupt");
			const names = this.names(),
				segments: string[] = [];
			this.metadataBytes = 0;
			for (const name of names) {
				if (name === "compatible-1") {
					const fd = directory(fdPath(this.root, name), 0o700);
					closeSync(fd);
					continue;
				}
				if (/^journal-\d{6}\.numeric$/.test(name)) {
					segments.push(name);
					continue;
				}
				check(
					name === "copy.numeric" ||
						name === "lock" ||
						/^lock\.(?:tmp|stale)-\d+$/.test(name) ||
						name === "header.numeric" ||
						name === "index.nodes" ||
						name === "index.values" ||
						name === "checkpoint.numeric" ||
						name === "native.numeric" ||
						name === "checkpoint.previous.numeric" ||
						name === "native.previous.numeric" ||
						/^(?:checkpoint|native)(?:\.previous)?\.numeric\.next-[a-f0-9]{64}$/.test(name) ||
						/^evidence-(?:checkpoint|native)-[a-f0-9]{64}\.numeric$/.test(name) ||
						/^fault-[a-z-]+\.numeric$/.test(name),
					"unsafe-path",
				);
				const f = this.file(name);
				try {
					if (!name.startsWith("index.")) this.metadataBytes += f.stat.size;
					else check(f.stat.size <= this.limits.indexBytes, "store-capacity");
				} finally {
					closeSync(f.fd);
				}
				if (name.startsWith("fault-")) {
					const code = name.slice(6, -8) as UsageStoreCode;
					check(
						STORE_CODES.includes(code) &&
							this.small(name, 1024) === canonical({ v: "usage-store-fault/1", code }) + "\n",
						"io-failure",
					);
					this.alarms.add(code);
				}
				await this.yield();
			}
			check(
				this.metadataBytes <= this.limits.metadataBytes && segments.length <= this.limits.segments,
				"store-capacity",
			);
			segments.sort();
			for (const [i, name] of segments.entries()) {
				check(name === segmentName(i + 1), "journal-corrupt");
				const f = this.file(name);
				try {
					check(f.stat.size <= METER_LIMITS.segmentBytes, "store-capacity");
					this.sizes.push(f.stat.size);
					this.segmentIds.push(f.stat);
					this.synced.push(false);
					this.counters.journalBytes += f.stat.size;
				} finally {
					closeSync(f.fd);
				}
				await this.yield();
			}
			check(this.counters.journalBytes <= this.limits.journalBytes, "store-capacity");
			this.recoveryBytes = this.counters.journalBytes;
			this.recovered = this.recoveryBytes === 0;
			this.checkpointText = this.small("checkpoint.numeric", METER_LIMITS.checkpointBytes);
			this.candidate = this.checkpointText === null ? null : prefix(this.checkpointText);
			this.candidateMatched =
				this.candidate === null ? this.checkpointText === null : samePrefix(this.candidate, initialPrefix());
			const last = this.sizes.length;
			this.unanchored =
				last > 0 &&
				(this.candidate === null ||
					this.candidate.end.segment !== last ||
					this.candidate.end.offset !== this.sizes[last - 1]);
			if ((this.checkpointText !== null && this.candidate === null) || this.unanchored)
				this.fault("checkpoint-corrupt");
			this.nativeText = this.small("native.numeric", METER_LIMITS.checkpointBytes);
			if (this.nativeText !== null) {
				try {
					const envelope = JSON.parse(this.nativeText);
					check(
						Object.keys(envelope).sort().join() === "checkpoint,sha256,v" &&
							envelope.v === "usage-store-native/1" &&
							sha(canonical(envelope.checkpoint)) === envelope.sha256,
						"native-unavailable",
					);
					this.nativeCandidate = validateMeterIndexCheckpoint(envelope.checkpoint);
					check(this.nativeCandidate?.generation === this.header!.generation, "native-unavailable");
				} catch {
					this.nativeCandidate = null;
					this.fault("native-unavailable");
				}
			}
			this.headed = true;
			// A complete but unpublished suffix can be replayed, never silently called anchored/clean.
			// This transport-only invalid marker makes W0 carry its fixed UNKNOWN fault; evidence is untouched.
			return { sizes: [...this.sizes], checkpoint: this.unanchored ? "null" : this.checkpointText };
		});
	}
	readPage(position: JournalPosition, maxBytes: number): Promise<Uint8Array> {
		return this.operation(() => {
			check(
				this.headed && Number.isSafeInteger(maxBytes) && maxBytes > 0 && maxBytes <= METER_LIMITS.pageBytes,
				"store-capacity",
			);
			while (this.readSegment <= this.sizes.length && this.readOffset === this.sizes[this.readSegment - 1]) {
				if (this.carry.length) {
					this.fault("journal-tail");
					this.carry = Buffer.alloc(0);
				}
				this.readSegment++;
				this.readOffset = this.lineOffset = 0;
			}
			check(
				position.segment === this.readSegment &&
					position.offset === this.readOffset &&
					position.segment <= this.sizes.length,
				"journal-corrupt",
			);
			const f = this.file(segmentName(position.segment));
			try {
				check(
					identity(f.stat, this.segmentIds[position.segment - 1]) && f.stat.size === this.sizes[position.segment - 1],
					"journal-corrupt",
				);
				const b = this.read(f.fd, position.offset, Math.min(maxBytes, f.stat.size - position.offset));
				this.readOffset += b.length;
				this.recoveryReadBytes += b.length;
				this.observe(b, position.segment);
				if (this.readOffset === f.stat.size && this.carry.length) {
					this.fault("journal-tail");
					this.proven.end = { segment: position.segment + 1, offset: 0 };
				}
				return b;
			} finally {
				closeSync(f.fd);
			}
		});
	}
	private observe(b: Buffer, segment: number): void {
		const combined = Buffer.concat([this.carry, b]);
		this.counters.maxStagingBytes = Math.max(this.counters.maxStagingBytes, combined.length);
		check(combined.length <= METER_LIMITS.stagingBytes, "store-capacity");
		let start = 0,
			end: number;
		while ((end = combined.indexOf(10, start)) >= 0) {
			const line = combined.subarray(start, end),
				length = line.length + 1;
			this.lineOffset += length;
			start = end + 1;
			if (!this.verificationBroken) {
				try {
					check(length <= METER_LIMITS.pageBytes + 1024, "journal-corrupt");
					const text = new TextDecoder("utf8", { fatal: true }).decode(line),
						raw = JSON.parse(text);
					check(
						canonical(raw) === text &&
							raw.v === "usage-journal/1" &&
							raw.sequence === this.proven.sequence + 1 &&
							raw.sequence <= METER_LIMITS.frames,
						"journal-corrupt",
					);
					this.proven = {
						v: "usage-paged-checkpoint/1",
						sequence: raw.sequence,
						end: { segment, offset: this.lineOffset },
						sha256: sha(this.proven.sha256 + text + "\n"),
					};
					if (this.candidate?.sequence === this.proven.sequence)
						this.candidateMatched = samePrefix(this.candidate, this.proven);
				} catch {
					this.verificationBroken = true;
					this.fault("journal-corrupt");
				}
			}
		}
		this.carry = Buffer.from(combined.subarray(start));
		check(this.carry.length <= METER_LIMITS.pageBytes + 1024, "journal-corrupt");
	}
	append(segment: number, expectedBytes: number, line: string): Promise<void> {
		return this.operation(() => {
			check(
				this.headed &&
					this.recovered &&
					this.synced.every(Boolean) &&
					!this.verificationBroken &&
					this.pending === null,
				"journal-corrupt",
			);
			const length = size(line);
			check(
				Number.isSafeInteger(segment) &&
					segment >= 1 &&
					segment <= this.limits.segments &&
					Number.isSafeInteger(expectedBytes) &&
					expectedBytes >= 0 &&
					length > 0 &&
					length <= METER_LIMITS.pageBytes + 1024 &&
					expectedBytes + length <= METER_LIMITS.segmentBytes,
				"store-capacity",
			);
			check(this.counters.journalBytes + length <= this.limits.journalBytes, "store-capacity");
			check(line.endsWith("\n") && !line.slice(0, -1).includes("\n"), "journal-corrupt");
			const raw = JSON.parse(line);
			check(
				canonical(raw) + "\n" === line &&
					raw.v === "usage-journal/1" &&
					raw.sequence === this.proven.sequence + 1 &&
					raw.sequence <= METER_LIMITS.frames,
				"journal-corrupt",
			);
			check(segment === this.sizes.length || segment === this.sizes.length + 1, "journal-corrupt");
			const fresh = segment === this.sizes.length + 1;
			check(!fresh || expectedBytes === 0, "journal-corrupt");
			if (!fresh)
				check(this.proven.end.segment === segment && this.proven.end.offset === expectedBytes, "journal-corrupt");
			const f = this.file(segmentName(segment), fresh);
			try {
				check(
					f.stat.size === expectedBytes && (fresh || identity(f.stat, this.segmentIds[segment - 1])),
					"journal-corrupt",
				);
				this.write(f.fd, Buffer.from(line), expectedBytes, "journal-write");
				check(fstatSync(f.fd).size === expectedBytes + length, "journal-corrupt");
				this.pending = {
					v: "usage-paged-checkpoint/1",
					sequence: raw.sequence,
					end: { segment, offset: expectedBytes + length },
					sha256: sha(this.proven.sha256 + line),
				};
				this.sizes[segment - 1] = expectedBytes + length;
				this.segmentIds[segment - 1] = f.stat;
				this.synced[segment - 1] = false;
				this.counters.journalBytes += length;
				this.o.fault?.("after-append");
			} finally {
				closeSync(f.fd);
			}
		});
	}
	sync(segment: number): Promise<void> {
		return this.operation(() => {
			check(Number.isSafeInteger(segment) && segment > 0 && segment <= this.sizes.length, "journal-corrupt");
			const f = this.file(segmentName(segment));
			try {
				check(
					identity(f.stat, this.segmentIds[segment - 1]) && f.stat.size === this.sizes[segment - 1],
					"journal-corrupt",
				);
				this.o.fault?.("journal-sync");
				fsyncSync(f.fd);
				fsyncSync(this.root);
				this.o.fault?.("after-journal-sync");
				this.synced[segment - 1] = true;
				if (this.pending?.end.segment === segment) {
					this.proven = this.pending;
					this.pending = null;
				}
				if (this.synced.every(Boolean) && !this.verificationBroken) {
					check(this.recoveryReadBytes === this.recoveryBytes, "journal-corrupt");
					this.recovered = true;
					if (this.sizes[this.sizes.length - 1] === 0) this.proven.end = { segment: this.sizes.length, offset: 0 };
					this.durable = structuredClone(this.proven);
					if (!this.candidateMatched) this.fault("checkpoint-corrupt");
				}
			} finally {
				closeSync(f.fd);
			}
		});
	}
	checkpoint(text: string): Promise<void> {
		return this.operation(() => {
			const p = prefix(text);
			check(
				p && samePrefix(p, this.durable) && this.pending === null && this.synced.every(Boolean),
				"checkpoint-corrupt",
			);
			if (this.checkpointText !== null && (!this.candidateMatched || this.unanchored))
				this.preserve("checkpoint.numeric", this.checkpointText);
			this.cache.sync();
			this.atomic("checkpoint.numeric", text, "checkpoint");
			this.checkpointText = text;
			this.candidate = p;
			this.candidateMatched = true;
			this.unanchored = false;
			this.published = p;
		});
	}
	/** Worker-private adapter anchor; null until a successful durable collector publication. */
	committedPrefix(): PagedCollectorCheckpoint | null {
		return this.published === null ? null : structuredClone(this.published);
	}
	/** The adapter supplies verified native metadata only after its collector commit. No cursor arithmetic here. */
	commitNative(cursors: MeterNativeCursor[], anchor: PagedCollectorCheckpoint): Promise<MeterIndexCheckpoint> {
		return this.operation(() => {
			check(
				this.published && samePrefix(anchor, this.published) && samePrefix(anchor, this.durable),
				"native-unavailable",
			);
			return this.publishNative(cursors, anchor);
		});
	}
	private publishNative(cursors: MeterNativeCursor[], anchor: PagedCollectorCheckpoint): MeterIndexCheckpoint {
		const index = this.cache.anchor();
		const cp = validateMeterIndexCheckpoint({
			v: "usage-meter-index/1",
			storeMajor: 1,
			generation: this.header!.generation,
			sequence: anchor.sequence,
			journal: { segment: anchor.end.segment, byte: anchor.end.offset, sha256: anchor.sha256 },
			index: { generation: index.generation, sequence: anchor.sequence, sha256: index.sha256 },
			cursors,
		});
		check(cp, "native-unavailable");
		if (this.nativeText !== null && !this.nativeTrusted) this.preserve("native.numeric", this.nativeText);
		this.cache.sync();
		const text = canonical({ v: "usage-store-native/1", checkpoint: cp, sha256: sha(canonical(cp)) }) + "\n";
		this.atomic("native.numeric", text, "native");
		this.nativeCandidate = cp;
		this.nativeText = text;
		this.nativeTrusted = true;
		return structuredClone(cp);
	}
	/** UNKNOWN/retained is not a usable seek cursor. Rebuild must prove the exact prefix AND numeric generation. */
	nativeCheckpoint(): Promise<{ state: "available" | "unavailable"; checkpoint: MeterIndexCheckpoint | null }> {
		return this.operation(() => {
			const cp = this.nativeCandidate,
				index = this.cache.anchor();
			const p = cp && {
				v: "usage-paged-checkpoint/1" as const,
				sequence: cp.sequence,
				end: { segment: cp.journal.segment, offset: cp.journal.byte },
				sha256: cp.journal.sha256,
			};
			if (
				!cp ||
				!p ||
				this.verificationBroken ||
				this.unanchored ||
				!this.synced.every(Boolean) ||
				!this.candidateMatched ||
				!samePrefix(p, this.durable) ||
				cp.index.sha256 !== index.sha256
			) {
				this.fault("native-unavailable");
				return { state: "unavailable", checkpoint: cp === null ? null : structuredClone(cp) };
			}
			// Rebinding a DERIVED generation keeps token/epoch bytes and sequence unchanged.
			this.nativeTrusted = true;
			return { state: "available", checkpoint: this.publishNative(cp.cursors, p) };
		});
	}
	async yield(): Promise<void> {
		this.counters.yields++;
		await pause();
		this.owned();
	}
	/** Compatible evidence copy only, not a migrator. Exclusive target; no overwrite/downgrade API. */
	prepareMigration(): Promise<{
		v: "usage-store-compatible-copy/1";
		storeMajor: 1;
		files: number;
		bytes: number;
		generation: string;
	}> {
		return this.operation(async () => {
			check(this.headed && this.pending === null && this.synced.every(Boolean), "io-failure");
			mkdirSync(fdPath(this.root, "compatible-1"), { mode: 0o700 });
			fsyncSync(this.root);
			const target = directory(fdPath(this.root, "compatible-1"), 0o700);
			let total = 0,
				count = 0;
			try {
				for (const name of this.names()) {
					if (name === "compatible-1" || name === "lock" || name.startsWith("lock.") || name.startsWith("index."))
						continue;
					const source = this.file(name);
					let dest: OpenFile | null = null;
					try {
						dest = this.file(name, true, target);
						check(
							source.stat.size <= METER_LIMITS.segmentBytes &&
								total + source.stat.size <= this.limits.journalBytes + this.limits.metadataBytes,
							"store-capacity",
						);
						for (let at = 0; at < source.stat.size; at += METER_LIMITS.pageBytes) {
							const b = this.read(source.fd, at, Math.min(METER_LIMITS.pageBytes, source.stat.size - at));
							this.write(dest.fd, b, at);
							await this.yield();
							this.owned();
						}
						fsyncSync(source.fd);
						fsyncSync(dest.fd);
						total += source.stat.size;
						count++;
					} finally {
						closeSync(source.fd);
						if (dest !== null) closeSync(dest.fd);
					}
				}
				const receipt = {
					v: "usage-store-compatible-copy/1" as const,
					storeMajor: 1 as const,
					files: count,
					bytes: total,
					generation: this.header!.generation,
				};
				const f = this.file("copy.numeric", true, target);
				try {
					this.write(f.fd, Buffer.from(canonical(receipt) + "\n"), 0);
					fsyncSync(f.fd);
				} finally {
					closeSync(f.fd);
				}
				fsyncSync(target);
				fsyncSync(this.root);
				this.phase = "unavailable";
				this.code = "migration-prepared";
				return receipt;
			} finally {
				closeSync(target);
			}
		});
	}
	async close(): Promise<void> {
		this.phase = "closed";
		this.code = "closed"; // Admit no new work while the already-active operation drains.
		await this.serial;
		try {
			this.cache.close();
		} finally {
			try {
				this.lock?.stop();
			} finally {
				if (this.root >= 0) {
					closeSync(this.root);
					this.root = -1;
				}
				if (this.parent >= 0) {
					closeSync(this.parent);
					this.parent = -1;
				}
				if (this.heldLease && this.lease) {
					Atomics.compareExchange(this.lease, 0, 1, 0);
					this.heldLease = false;
				}
				this.phase = "closed";
				this.code = "closed";
			}
		}
	}
}

// Node/data format and authenticated scan rules are specified in docs/usage-accounting-store.md.
const NODE = 192,
	INDEX_HEADER = 96,
	KEY_BITS = USAGE_STORE_LIMITS.indexKeyBytes * 9 + 1;
const CACHE_CHARGE = NODE + 512,
	FLUSH_NODES = 64,
	FLUSH_PAGE = FLUSH_NODES * NODE,
	// Charge IDs/sort scratch and the read-modify-write buffers, not only persistent nodes.
	WORKSPACE =
		KEY_BITS * 40 +
		Math.ceil(METER_LIMITS.indexCacheBytes / CACHE_CHARGE) * 24 +
		2 * FLUSH_PAGE +
		3 * PAGE.maxBytes +
		PAGE.maxRows * 512 +
		1024; // Fixed aggregate diagnostic counters/histogram and their returned snapshot.
interface Ref {
	id: number;
	hash: Buffer;
}
interface DiskNode {
	bytes: Buffer;
	id: number;
	type: number;
	bit: number;
	left: Ref;
	right: Ref;
	offset: number;
	length: number;
	hash: Buffer;
}
const emptyRef = (): Ref => ({ id: 0, hash: Buffer.alloc(32) });
/** Nine-bit symbols: 1 + eight byte bits; the complete-key terminator is 0. */
function keyBit(key: string, bit: number): number {
	const i = Math.floor(bit / 9),
		digit = bit % 9;
	return i >= key.length ? 0 : digit === 0 ? 1 : (key.charCodeAt(i) >> (8 - digit)) & 1;
}
function differentBit(a: string, b: string): number {
	let i = 0;
	while (i < a.length && i < b.length && a[i] === b[i]) i++;
	if (i === Math.min(a.length, b.length)) return i * 9;
	return i * 9 + 1 + Math.clz32(a.charCodeAt(i) ^ b.charCodeAt(i)) - 24;
}
function indexKey(key: string): void {
	check(
		typeof key === "string" && key.length <= USAGE_STORE_LIMITS.indexKeyBytes && /^[\x20-\x7e]*$/.test(key),
		"index-unavailable",
	);
}
function pageLimits(l: typeof PAGE): void {
	check(
		Number.isSafeInteger(l.maxBytes) &&
			l.maxBytes >= 128 &&
			l.maxBytes <= PAGE.maxBytes &&
			Number.isSafeInteger(l.maxRows) &&
			l.maxRows > 0 &&
			l.maxRows <= PAGE.maxRows,
		"store-capacity",
	);
}

class NumericDiskIndex implements CollectorNumericIndex {
	private nodes = -1;
	private values = -1;
	private generation = Buffer.alloc(32);
	private root = emptyRef();
	private allocated = 0;
	private valueBytes = INDEX_HEADER;
	private nodeBytes = INDEX_HEADER;
	private entries = 0;
	private liveBytes = 0;
	private content = Buffer.alloc(32);
	private healthy = false;
	private cache = new Map<number, DiskNode>();
	private dirty = new Set<number>();
	private ids = new Uint32Array(KEY_BITS);
	private bits = new Int32Array(KEY_BITS);
	private hashes = Buffer.alloc(KEY_BITS * 32);
	// Ops #643: the slice and its 100 ms unit guard count this thread's CPU work, not wall-clock time: on a busy
	// machine the wall clock runs on while the thread waits for a core, which cut slices short and refused healthy
	// units with store-capacity.
	private sliceAt = threadCpuMs();
	private sliceNodes = 0;
	private maxWorkMs = 0;
	private maxWorkNodes = 0;
	private maxCacheBytes = WORKSPACE;
	private payloadWrites = 0;
	private maxPayloadBytes = 0;
	private readonly density = Array<number>(8).fill(0);
	private readonly work = {
		flushGroups: 0,
		dirtySlots: 0,
		writtenSlots: 0,
		trimmedSlots: 0,
		exactRuns: 0,
		retainedReadBytes: 0,
		trimmedRetainedBytes: 0,
		cacheMisses: 0,
		cacheMissReadBytes: 0,
		dirtyEvictions: 0,
		payloadReads: 0,
		payloadReadBytes: 0,
		headerReads: 0,
		headerReadBytes: 0,
		finalYields: 0,
		flushQuantumYields: 0,
		otherQuantumYields: 0,
		clockYields: 0,
	};
	constructor(private readonly store: UsageAccountingStore) {}
	metrics() {
		return {
			entries: this.entries,
			liveBytes: this.liveBytes,
			allocatedBytes: this.nodeBytes + this.valueBytes,
			maxCacheBytes: this.maxCacheBytes,
			maxWorkMs: this.maxWorkMs,
			maxWorkNodes: this.maxWorkNodes,
			payloadWrites: this.payloadWrites,
			maxPayloadBytes: this.maxPayloadBytes,
			work: { ...this.work, density: this.density.slice() },
		};
	}
	private ref(node: DiskNode): Ref {
		return { id: node.id, hash: node.hash };
	}
	private header(kind: "N" | "V"): Buffer {
		const b = Buffer.alloc(INDEX_HEADER);
		b.write(`UMIDX1${kind}\n`);
		this.generation.copy(b, 8);
		Buffer.from(sha(b.subarray(0, 64)), "hex").copy(b, 64);
		return b;
	}
	private verify(): void {
		check(this.healthy && this.nodes >= 0 && this.values >= 0, "index-unavailable");
		check(
			this.store.checkFile("index.nodes", this.nodes).size === this.nodeBytes &&
				this.store.checkFile("index.values", this.values).size === this.valueBytes,
			"index-unavailable",
		);
		for (const [fd, kind] of [
			[this.nodes, "N"],
			[this.values, "V"],
		] as const) {
			this.work.headerReads++;
			this.work.headerReadBytes += INDEX_HEADER;
			check(this.store.read(fd, 0, INDEX_HEADER).equals(this.header(kind)), "index-unavailable");
		}
		this.sliceAt = threadCpuMs();
		this.sliceNodes = 0;
	}
	private async step(force = false, nodes = 1, reason: "final" | "flush" | "other" = "other"): Promise<void> {
		if (!force) this.sliceNodes += nodes;
		this.maxWorkNodes = Math.max(this.maxWorkNodes, this.sliceNodes);
		if (
			!force &&
			this.sliceNodes < USAGE_STORE_LIMITS.indexSliceNodes &&
			threadCpuMs() - this.sliceAt < METER_LIMITS.sliceMs
		)
			return;
		const elapsed = threadCpuMs() - this.sliceAt;
		this.maxWorkMs = Math.max(this.maxWorkMs, elapsed);
		check(elapsed <= METER_LIMITS.unitWorkMs, "store-capacity");
		if (force && reason === "final") this.work.finalYields++;
		else if (force || this.sliceNodes >= USAGE_STORE_LIMITS.indexSliceNodes) {
			if (reason === "flush") this.work.flushQuantumYields++;
			else this.work.otherQuantumYields++;
		} else this.work.clockYields++;
		await this.store.yield();
		this.sliceAt = threadCpuMs();
		this.sliceNodes = 0;
	}
	private async invoke<T>(fn: () => T | Promise<T>): Promise<T> {
		return this.store.operation(async () => {
			try {
				this.verify();
				const answer = await fn();
				await this.flush();
				await this.step(true, 0, "final");
				return answer;
			} catch (e) {
				this.healthy = false;
				throw e instanceof UsageStoreError ? e : new UsageStoreError("index-unavailable");
			}
		});
	}
	reset(): Promise<void> {
		return this.store.operation(() => {
			check(this.store.limits.indexBytes >= 2 * INDEX_HEADER, "store-capacity");
			this.close();
			this.healthy = false;
			try {
				for (const name of ["index.nodes", "index.values"]) {
					let f: OpenFile;
					try {
						f = this.store.file(name);
					} catch (e) {
						if (!missing(e)) throw e;
						f = this.store.file(name, true);
					}
					if (name === "index.nodes") this.nodes = f.fd;
					else this.values = f.fd;
					// These two files are derived caches ONLY. Validate before truncate; never touch journal/native bytes.
					ftruncateSync(f.fd, 0);
				}
				this.generation = randomBytes(32);
				this.root = emptyRef();
				this.allocated = this.entries = this.liveBytes = 0;
				this.valueBytes = this.nodeBytes = INDEX_HEADER;
				this.content = Buffer.alloc(32);
				this.store.write(this.nodes, this.header("N"), 0, "index-write");
				this.store.write(this.values, this.header("V"), 0, "index-write");
				fsyncSync(this.nodes);
				fsyncSync(this.values);
				this.store.syncRoot();
				this.healthy = true;
			} catch (e) {
				this.close();
				throw e;
			}
		});
	}
	reserve(newEntries: number, newBytes: number): Promise<boolean> {
		return this.invoke(() => {
			check(
				Number.isSafeInteger(newEntries) && newEntries >= 0 && Number.isSafeInteger(newBytes) && newBytes >= 0,
				"store-capacity",
			);
			// Include worst-case node growth and a physical two-entry/1KiB final-fault reserve.
			return (
				this.store.admitJournal(newBytes) &&
				this.entries + newEntries <= this.store.limits.indexEntries - 2 &&
				this.nodeBytes + this.valueBytes + newBytes + newEntries * 2 * NODE <=
					this.store.limits.indexBytes - 4 * NODE - 1024
			);
		});
	}
	private remember(n: DiskNode, dirty = false): void {
		this.cache.delete(n.id);
		this.cache.set(n.id, n);
		if (dirty) this.dirty.add(n.id);
		while (WORKSPACE + this.cache.size * CACHE_CHARGE > METER_LIMITS.indexCacheBytes) {
			const id = this.cache.keys().next().value!;
			this.flushOne(id);
			this.cache.delete(id);
		}
		this.maxCacheBytes = Math.max(this.maxCacheBytes, WORKSPACE + this.cache.size * CACHE_CHARGE);
	}
	private flushOne(id: number): void {
		if (!this.dirty.has(id)) return;
		const n = this.cache.get(id)!;
		const offset = INDEX_HEADER + (id - 1) * NODE;
		this.store.write(this.nodes, n.bytes, offset, "index-write");
		this.work.dirtyEvictions++;
		this.nodeBytes = Math.max(this.nodeBytes, offset + NODE);
		this.dirty.delete(id);
	}
	private async flush(): Promise<void> {
		const ids = Uint32Array.from(this.dirty).sort();
		for (let at = 0; at < ids.length;) {
			const bucket = Math.floor((ids[at] - 1) / FLUSH_NODES) * FLUSH_NODES;
			let end = at,
				runs = 0;
			while (end < ids.length && ids[end] <= bucket + FLUSH_NODES) {
				if (end === at || ids[end] !== ids[end - 1] + 1) runs++;
				end++;
			}
			const first = ids[at] - 1,
				dirty = end - at,
				slots = ids[end - 1] - first,
				span = slots;
			const offset = INDEX_HEADER + first * NODE,
				length = slots * NODE;
			if (this.sliceNodes + slots > USAGE_STORE_LIMITS.indexSliceNodes) await this.step(true, 0, "flush");
			const bytes = Buffer.alloc(length);
			const retained = dirty === slots ? 0 : Math.min(length, Math.max(0, this.nodeBytes - offset));
			if (retained) this.store.read(this.nodes, offset, retained).copy(bytes);
			for (let i = at; i < end; i++) {
				const id = ids[i],
					n = this.cache.get(id);
				check(n && this.dirty.has(id), "index-unavailable");
				n.bytes.copy(bytes, (id - first - 1) * NODE);
			}
			this.store.write(this.nodes, bytes, offset, "index-write");
			this.work.flushGroups++;
			this.work.dirtySlots += dirty;
			this.work.writtenSlots += slots;
			this.work.trimmedSlots += span;
			this.work.exactRuns += runs;
			this.work.retainedReadBytes += retained;
			if (span !== dirty)
				this.work.trimmedRetainedBytes += Math.min(
					span * NODE,
					Math.max(0, this.nodeBytes - (INDEX_HEADER + (ids[at] - 1) * NODE)),
				);
			this.density[Math.min(7, Math.floor((dirty * 8) / slots))]++;
			this.nodeBytes = Math.max(this.nodeBytes, offset + length);
			for (; at < end; at++) this.dirty.delete(ids[at]);
			await this.step(false, slots, "flush");
		}
	}
	private node(ref: Ref, previous = -1): DiskNode {
		check(ref.id > 0 && ref.id <= this.allocated && ref.hash.length === 32, "index-unavailable");
		let n = this.cache.get(ref.id);
		if (!n) {
			this.work.cacheMisses++;
			this.work.cacheMissReadBytes += NODE;
			const b = this.store.read(this.nodes, INDEX_HEADER + (ref.id - 1) * NODE, NODE);
			check(
				b.subarray(0, 4).toString() === "UMN1" &&
					b.readUInt32BE(8) === ref.id &&
					b.subarray(36, 68).equals(this.generation) &&
					b.subarray(5, 8).equals(Buffer.alloc(3)) &&
					b.subarray(132, 160).equals(Buffer.alloc(28)) &&
					sha(b.subarray(0, 160)) === b.subarray(160).toString("hex"),
				"index-unavailable",
			);
			n = {
				bytes: b,
				id: ref.id,
				type: b[4],
				bit: b.readUInt32BE(12),
				left: { id: b.readUInt32BE(16), hash: b.subarray(68, 100) },
				right: { id: b.readUInt32BE(20), hash: b.subarray(100, 132) },
				offset: Number(b.readBigUInt64BE(24)),
				length: b.readUInt32BE(32),
				hash: b.subarray(160),
			};
			check(
				(n.type === 0 && n.bit === 0 && n.left.id === 0 && n.right.id === 0 && n.right.hash.equals(Buffer.alloc(32))) ||
					(n.type === 1 &&
						n.bit < KEY_BITS &&
						n.left.id > 0 &&
						n.right.id > 0 &&
						n.left.id !== n.right.id &&
						n.offset === 0 &&
						n.length === 0),
				"index-unavailable",
			);
			this.remember(n);
		} else {
			this.cache.delete(n.id);
			this.cache.set(n.id, n);
		}
		check(n.hash.equals(ref.hash) && (n.type === 0 || n.bit > previous), "index-unavailable");
		return n;
	}
	private payload(n: DiskNode): { entry: CollectorIndexEntry; bytes: number; hash: Buffer } {
		check(
			n.type === 0 &&
				Number.isSafeInteger(n.offset) &&
				n.offset >= INDEX_HEADER &&
				n.length > 0 &&
				n.length <= PAGE.maxBytes &&
				n.offset + n.length <= this.valueBytes,
			"index-unavailable",
		);
		this.work.payloadReads++;
		this.work.payloadReadBytes += n.length;
		const b = this.store.read(this.values, n.offset, n.length);
		check(sha(b) === n.left.hash.toString("hex"), "index-unavailable");
		try {
			const text = new TextDecoder("utf8", { fatal: true }).decode(b),
				e = JSON.parse(text) as CollectorIndexEntry;
			check(
				canonical(e) === text && Object.keys(e).sort().join() === "key,value" && e.value && typeof e.value === "object",
				"index-unavailable",
			);
			indexKey(e.key);
			return { entry: e, bytes: b.length, hash: n.left.hash };
		} catch {
			return fail("index-unavailable");
		}
	}
	private put(type: number, id: number, bit: number, left: Ref, right: Ref, offset = 0, length = 0): Ref {
		const b = Buffer.alloc(NODE);
		b.write("UMN1");
		b[4] = type;
		b.writeUInt32BE(id, 8);
		b.writeUInt32BE(bit, 12);
		b.writeUInt32BE(left.id, 16);
		b.writeUInt32BE(right.id, 20);
		b.writeBigUInt64BE(BigInt(offset), 24);
		b.writeUInt32BE(length, 32);
		this.generation.copy(b, 36);
		left.hash.copy(b, 68);
		right.hash.copy(b, 100);
		Buffer.from(sha(b.subarray(0, 160)), "hex").copy(b, 160);
		const n = { bytes: b, id, type, bit, left, right, offset, length, hash: b.subarray(160) };
		this.remember(n, true);
		return this.ref(n);
	}
	private save(i: number, ref: Ref, previous = -1): void {
		check(i < KEY_BITS, "index-unavailable");
		this.ids[i] = ref.id;
		this.bits[i] = previous;
		ref.hash.copy(this.hashes, i * 32);
	}
	private saved(i: number): Ref {
		return { id: this.ids[i], hash: this.hashes.subarray(i * 32, i * 32 + 32) };
	}
	private async find(key: string): Promise<{ node: DiskNode; depth: number } | null> {
		if (this.root.id === 0) return null;
		let ref = this.root,
			previous = -1,
			depth = 0;
		for (;;) {
			const n = this.node(ref, previous);
			if (n.type === 0) return { node: n, depth };
			this.save(depth++, ref, previous);
			previous = n.bit;
			ref = keyBit(key, n.bit) ? n.right : n.left;
			await this.step();
		}
	}
	private xor(hash: Buffer): void {
		for (let i = 0; i < 32; i++) this.content[i] ^= hash[i];
	}
	private async propagate(ref: Ref, child: number, depth: number): Promise<Ref> {
		for (let i = depth - 1; i >= 0; i--) {
			const n = this.node(this.saved(i), this.bits[i]);
			check(n.type === 1 && (n.left.id === child || n.right.id === child), "index-unavailable");
			const next = this.put(1, n.id, n.bit, n.left.id === child ? ref : n.left, n.right.id === child ? ref : n.right);
			child = n.id;
			ref = next;
			await this.step();
		}
		return ref;
	}
	get(keys: string[], limits: typeof PAGE): Promise<CollectorIndexEntry[]> {
		return this.invoke(async () => {
			pageLimits(limits);
			check(keys.length <= limits.maxRows && size(JSON.stringify(keys)) <= limits.maxBytes, "store-capacity");
			const result: CollectorIndexEntry[] = [];
			let bytes = 2;
			for (const key of keys) {
				indexKey(key);
				const found = await this.find(key);
				if (found) {
					const p = this.payload(found.node);
					if (p.entry.key === key) {
						bytes += p.bytes + 1;
						check(bytes <= limits.maxBytes, "store-capacity");
						result.push(p.entry);
					}
				}
				await this.step();
			}
			return result;
		});
	}
	scan(prefix: string, after: string | null, limits: typeof PAGE): Promise<CollectorIndexPage> {
		return this.invoke(async () => {
			pageLimits(limits);
			indexKey(prefix);
			if (after !== null) indexKey(after);
			if (this.root.id === 0) return { entries: [], after: null };
			const lower = after !== null && after > prefix ? after : prefix;
			const probe = await this.find(lower);
			check(probe, "index-unavailable");
			const terminal = this.payload(probe.node).entry.key;
			const diff = terminal === lower ? KEY_BITS : differentBit(terminal, lower);
			let depth = 0,
				ref = this.root,
				previous = -1;
			// Seek an authenticated lower bound, including skipped-bit divergence; never filter a whole cold history.
			for (;;) {
				const n = this.node(ref, previous);
				if (n.type === 0 || n.bit >= diff) {
					if (terminal >= lower) this.save(depth++, ref, previous);
					break;
				}
				if (!keyBit(lower, n.bit)) {
					this.save(depth++, n.right, n.bit);
					ref = n.left;
				} else ref = n.right;
				previous = n.bit;
				await this.step();
			}
			const result: CollectorIndexEntry[] = [];
			let total = 64;
			while (depth) {
				ref = this.saved(--depth);
				previous = this.bits[depth];
				let n = this.node(ref, previous);
				while (n.type === 1) {
					this.save(depth++, n.right, n.bit);
					n = this.node(n.left, n.bit);
					await this.step();
				}
				const p = this.payload(n),
					key = p.entry.key;
				if (key >= prefix && !key.startsWith(prefix)) break;
				if (key.startsWith(prefix) && (after === null || key > after)) {
					const next = total + p.bytes + size(JSON.stringify(key)) + 1;
					if (result.length >= limits.maxRows || next > limits.maxBytes) {
						check(result.length > 0, "store-capacity");
						return { entries: result, after: result[result.length - 1].key };
					}
					result.push(p.entry);
					total += p.bytes + 1;
				}
				await this.step();
			}
			return { entries: result, after: null };
		});
	}
	private async admitPayload(
		entries: { key: string; value: CollectorIndexValue | null }[],
		bytes: number,
	): Promise<void> {
		const count = entries.reduce((n, e) => n + Number(e.value !== null), 0),
			baseBytes = INDEX_HEADER + this.valueBytes + bytes;
		// The ordinary case needs no second trie walk. This bounds every transient insertion.
		if (
			(this.allocated + 2 * count) * NODE + baseBytes <= this.store.limits.indexBytes &&
			this.entries + count <= this.store.limits.indexEntries
		)
			return;
		const present = new Map<string, boolean>();
		let allocated = this.allocated,
			live = this.entries;
		for (const entry of entries) {
			if (!present.has(entry.key)) {
				const found = await this.find(entry.key);
				present.set(entry.key, !!found && this.payload(found.node).entry.key === entry.key);
			}
			const exists = present.get(entry.key)!;
			if (entry.value === null) {
				if (exists) live--;
				present.set(entry.key, false);
			} else {
				if (!exists) {
					allocated += live === 0 ? 1 : 2;
					live++;
				}
				present.set(entry.key, true);
			}
			check(
				allocated * NODE + baseBytes <= this.store.limits.indexBytes && live <= this.store.limits.indexEntries,
				"store-capacity",
			);
			await this.step();
		}
	}
	write(entries: { key: string; value: CollectorIndexValue | null }[], limits: typeof PAGE): Promise<void> {
		return this.invoke(async () => {
			pageLimits(limits);
			check(entries.length <= limits.maxRows && size(JSON.stringify(entries)) <= limits.maxBytes, "store-capacity");
			const payload = Buffer.alloc(limits.maxBytes),
				prepared: ({ offset: number; length: number; hash: Buffer } | null)[] = [];
			let payloadBytes = 0;
			for (const entry of entries) {
				indexKey(entry.key);
				if (entry.value === null) prepared.push(null);
				else {
					const text = canonical({ key: entry.key, value: entry.value }),
						length = size(text);
					check(payloadBytes + length <= limits.maxBytes, "store-capacity");
					prepared.push({ offset: this.valueBytes + payloadBytes, length, hash: Buffer.from(sha(text), "hex") });
					check(payload.write(text, payloadBytes, "utf8") === length, "index-unavailable");
					payloadBytes += length;
				}
				await this.step();
			}
			await this.admitPayload(entries, payloadBytes);
			if (payloadBytes) {
				this.store.write(this.values, payload.subarray(0, payloadBytes), this.valueBytes, "index-write");
				this.valueBytes += payloadBytes;
				this.payloadWrites++;
				this.maxPayloadBytes = Math.max(this.maxPayloadBytes, payloadBytes);
				await this.step();
			}
			for (let i = 0; i < entries.length; i++) {
				const entry = entries[i];
				const found = await this.find(entry.key),
					old = found && this.payload(found.node);
				const matches = old?.entry.key === entry.key;
				if (entry.value === null) {
					if (!matches || !found) continue;
					this.xor(old.hash);
					this.liveBytes -= old.bytes;
					this.entries--;
					if (found.depth === 0) this.root = emptyRef();
					else {
						const parent = this.node(this.saved(found.depth - 1), this.bits[found.depth - 1]);
						this.root = await this.propagate(
							parent.left.id === found.node.id ? parent.right : parent.left,
							parent.id,
							found.depth - 1,
						);
					}
					continue;
				}
				const p = prepared[i];
				check(p, "index-unavailable");
				const { offset, length, hash } = p,
					additionalNodes = matches ? 0 : found ? 2 : 1;
				check(
					(this.allocated + additionalNodes) * NODE + INDEX_HEADER + this.valueBytes <= this.store.limits.indexBytes &&
						this.entries + (matches ? 0 : 1) <= this.store.limits.indexEntries,
					"store-capacity",
				);
				const leafId = matches && found ? found.node.id : ++this.allocated;
				let replacement = this.put(0, leafId, 0, { id: 0, hash }, emptyRef(), offset, length);
				if (matches && found && old) {
					this.xor(old.hash);
					this.liveBytes -= old.bytes;
					this.root = await this.propagate(replacement, found.node.id, found.depth);
				} else if (found && old) {
					const bit = differentBit(entry.key, old.entry.key);
					let current = this.root,
						depth = 0,
						previous = -1;
					for (;;) {
						const n = this.node(current, previous);
						if (n.type === 0 || n.bit >= bit) break;
						this.save(depth++, current, previous);
						previous = n.bit;
						current = keyBit(entry.key, n.bit) ? n.right : n.left;
						await this.step();
					}
					replacement = this.put(
						1,
						++this.allocated,
						bit,
						keyBit(entry.key, bit) ? current : replacement,
						keyBit(entry.key, bit) ? replacement : current,
					);
					this.root = await this.propagate(replacement, current.id, depth);
					this.entries++;
				} else {
					this.root = replacement;
					this.entries++;
				}
				this.xor(hash);
				this.liveBytes += length;
				await this.step();
			}
		});
	}
	anchor(): { generation: string; sha256: string } {
		this.verify();
		return {
			generation: this.generation.toString("hex"),
			sha256: sha(`usage-store-index-content/1:${this.entries}:${this.liveBytes}:${this.content.toString("hex")}`),
		};
	}
	sync(): void {
		try {
			this.verify();
			// Every mutating operation drains cooperatively before it acknowledges.
			check(this.dirty.size === 0, "index-unavailable");
			this.store.inject("index-sync");
			fsyncSync(this.nodes);
			fsyncSync(this.values);
			this.store.syncRoot();
		} catch (e) {
			this.healthy = false;
			throw e;
		}
	}
	close(): void {
		this.healthy = false;
		this.cache.clear();
		this.dirty.clear();
		if (this.nodes >= 0) {
			closeSync(this.nodes);
			this.nodes = -1;
		}
		if (this.values >= 0) {
			closeSync(this.values);
			this.values = -1;
		}
	}
}
