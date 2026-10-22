/** W3: inert, worker-private native intake. No default paths, timers, watchers or runtime registration. */
import { createHash } from "node:crypto";
import { constants, closeSync, fstatSync, lstatSync, openSync, readSync, type Stats } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { parseAccountingInput, type AccountingInput, type UsageFact } from "./usage-accounting-contract.js";
import {
	mapUsageMembership,
	projectMembershipConversation,
	projectMembershipDelegate,
	projectMembershipRegistryEvent,
	projectMembershipSessionEntry,
	type MembershipMap,
	type MembershipSources,
} from "./usage-accounting-membership.js";
import { METER_LIMITS } from "./usage-accounting-meter-contract.js";
import { PiSessionUsageReader, type PiSessionReadResult } from "./usage-accounting-pi-sessions.js";

export const PI_SOURCE_LIMITS = Object.freeze({
	pageBytes: 262_144,
	pageRows: 256,
	scanRows: 32,
	lineBytes: 65_536,
	readerBytes: 131_072,
	unitWorkMs: 100,
	sliceMs: 25,
	sources: METER_LIMITS.sources,
	dependencies: 64,
});
type Rows = Pick<
	AccountingInput,
	"facts" | "aliases" | "allocations" | "roots" | "policies" | "memberships" | "snapshots"
>;
type Batch = NonNullable<PiSessionReadResult["batch"]>;
type Cursor = NonNullable<PiSessionReadResult["cursor"]>;
export type PiSourceKind = "session" | "registry" | "conversation" | "delegate";
export type PiSourceGap =
	| "inventory-pending"
	| "inventory-unavailable"
	| "inventory-limit"
	| "inventory-changed"
	| "source-missing"
	| "unsafe-path"
	| "source-unreadable"
	| "source-truncated"
	| "source-replaced"
	| "anchor-changed"
	| "invalid-record"
	| "partial-last-line"
	| "line-limit"
	| "work-limit"
	| "dependency-limit"
	| "missing-parent"
	| "parent-cycle"
	| "registry-sequence"
	| "event-time-order"
	| "identity-conflict"
	| "copy-pending"
	| "index-unavailable"
	| "unsupported-acp"
	| "fileless-calls"
	| "unreported-failures"
	| "aggregate-provenance";
export interface PiCatalogEntry {
	file: string;
	kind: PiSourceKind;
	producer: "pi" | "acp";
}
/** A native, approved catalog cursor, NOT a usage cursor or a timestamp-sorted listing. */
export interface PiSourceCatalog {
	page(
		after: string | null,
		limits: { bytes: number; rows: number },
	): Promise<{
		generation: string;
		entries: readonly PiCatalogEntry[];
		next: string | null;
		status: "complete" | "partial" | "unavailable";
	}>;
}
export interface PiSourcePrefix {
	v: "pi-source-index/1";
	storeMajor: 1;
	sequence: number;
	sha256: string;
	/** W1 verifies the synced journal/index binding, not just this flag's JSON spelling. */
	verified: true;
}
/** W1 port. Values are private allowlisted numeric/identity/parent JSON, never transcript JSON.
 * commit is one durable CAS transaction: accepted numeric evidence/staging BEFORE index/cursors.
 * A batch must be committed to #300 (or retained in its durable staging lane) before publishing the
 * returned prefix. Uncertain writes require reopen. get/scan may read ONLY that committed prefix. */
export interface PiSourceIndex {
	head(): Promise<PiSourcePrefix>;
	get(key: string): Promise<string | null>;
	scan(
		prefix: string,
		after: string | null,
		limits: { bytes: number; rows: number },
	): Promise<{
		entries: { key: string; value: string }[];
		next: string | null;
	}>;
	commit(
		expected: PiSourcePrefix,
		unit: {
			puts: { key: string; value: string }[];
			/** Exact #304 receipt for durable native-cursor binding; audit/staging ONLY, never ingest its raw rows. */
			native: Batch | null;
			/** The one resolved partial collector batch; accepting this, not native.rows, binds its cursor. */
			batch: Batch | null;
			/** Resolved rows only. Staged old occurrences keep their immutable native source stamps. */
			rows: Rows;
		},
	): Promise<PiSourcePrefix>;
}
interface Anchor {
	line: number;
	end: number;
	start: number;
	bytes: number;
	sha: string;
}
interface Header {
	id: string;
	timestamp: string;
	parentSession?: string;
	sha: string;
}
interface FileStamp {
	dev: number;
	ino: number;
	size: number;
	mtime: number;
	ctime: number;
}
interface Source {
	id: string;
	file: string;
	/** Canonical original queue/file reference is retained across a proved rename. */
	original: string;
	kind: PiSourceKind;
	producer: "pi" | "acp";
	owner: "pi" | "temper";
	seen: number;
	stamp: FileStamp;
	header: Header | null;
	anchor: Anchor | null;
	reader: Cursor | null;
	retainedFrom: string | null;
	scanDone: boolean;
	readDone: boolean;
	verifyAfter: string | null;
	verifyStamp: FileStamp | null;
	verifying: boolean;
	dirty: boolean;
	gaps: PiSourceGap[];
	observedAt: string | null;
}
interface Inventory {
	epoch: number;
	generation: string | null;
	after: string | null;
	sweep: string | null;
	phase: "catalog" | "sweep" | "done";
	count: number;
	gaps: PiSourceGap[];
}
interface Occurrence {
	line: number;
	at: string;
	entry: string | null;
	entryAt: string | null;
	response: string | null;
	provider: string | null;
	fingerprint: string;
}
interface Original {
	fact: UsageFact;
	fingerprint: string;
	entryAt: string | null;
	/** Original native file; not the file in which a copied observation was found. */
	file: string;
}
interface NativeEvent {
	fingerprint: string;
	response: string | null;
	entryAt: string | null;
	fact: UsageFact | null;
	alias: AccountingInput["aliases"][number] | null;
}
interface Meta {
	line: number;
	record: unknown;
}
export interface PiSourceUnit {
	id: string;
	action: "scan" | "verify" | "usage" | "excluded" | "blocked" | "idle";
	/** A parent must be scheduled in this same lane before retrying this source. */
	promote: string | null;
	rows: Rows;
	batch: Batch | null;
	current: UsageFact[];
	staged: UsageFact[];
	gaps: PiSourceGap[];
	readerFaults: PiSessionReadResult["faults"];
	bytes: number;
	records: number;
}
export interface PiRequiredSource {
	id: string;
	kind: PiSourceKind | "gap";
	required: boolean;
	coverageOwner: "pi:W3" | "temper:T0" | "unsupported";
	excluded: boolean;
	state: "complete-recorded" | "pending" | "terminal-gap" | "excluded";
	/** Inventory completion is NOT all-call usage completeness. */
	usageCoverage: "partial" | "unknown";
	collector: {
		stream: string;
		incarnation: string;
		adapterRef: "pi-source-index/1";
		producer: "pi";
		occurrenceStreams: string[];
		retainedFrom: string | null;
		grants: ["facts", "aliases"];
	} | null;
	gaps: PiSourceGap[];
}
const GAP_CODES = new Set<PiSourceGap>([
	"inventory-pending",
	"inventory-unavailable",
	"inventory-limit",
	"inventory-changed",
	"source-missing",
	"unsafe-path",
	"source-unreadable",
	"source-truncated",
	"source-replaced",
	"anchor-changed",
	"invalid-record",
	"partial-last-line",
	"line-limit",
	"work-limit",
	"dependency-limit",
	"missing-parent",
	"parent-cycle",
	"registry-sequence",
	"event-time-order",
	"identity-conflict",
	"copy-pending",
	"index-unavailable",
	"unsupported-acp",
	"fileless-calls",
	"unreported-failures",
	"aggregate-provenance",
]);
const SHA = /^[a-f0-9]{64}$/;
const REF = /^[A-Za-z0-9_./:@+-]{1,256}$/;
const KINDS = new Set(["session", "registry", "conversation", "delegate"]);
const digest = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const pad = (n: number) => String(n).padStart(16, "0");
const empty = (): Rows => ({
	facts: [],
	aliases: [],
	allocations: [],
	roots: [],
	policies: [],
	memberships: [],
	snapshots: [],
});
const uint = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n >= 0;
const iso = (s: unknown): s is string =>
	typeof s === "string" &&
	/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(s) &&
	Number.isFinite(Date.parse(s)) &&
	new Date(s).toISOString() === s;
const ref = (s: unknown): s is string => typeof s === "string" && REF.test(s);
function time(s: unknown): string | null {
	if (iso(s)) return s;
	return uint(s) && s <= 253402300799999 ? new Date(s).toISOString() : null;
}
/** Do not enumerate/clone/stringify a raw native record or invoke an allowed-field getter. */
function field(raw: unknown, key: string): unknown {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
	const d = Object.getOwnPropertyDescriptor(raw, key);
	if (d && !("value" in d)) throw new Error("pi-source-metadata");
	return d?.value;
}
function scalar(raw: unknown): string | number | boolean | null {
	return typeof raw === "string" && raw.length <= 256
		? raw
		: typeof raw === "number" && Number.isFinite(raw)
			? raw
			: typeof raw === "boolean"
				? raw
				: null;
}
/** Only the occurrence/identity/numeric witness is retained. Payload properties are never opened. */
export function projectPiSourceOccurrence(raw: unknown): Omit<Occurrence, "line"> | null {
	const type = field(raw, "type");
	let value = raw;
	if (type === "message") {
		value = field(raw, "message");
		if (field(value, "role") !== "assistant") return null;
	} else if (typeof type !== "string" || !["usage", "compaction", "branch_summary"].includes(type)) return null;
	const usage = field(value, "usage");
	if (usage === undefined) return null;
	const entryAt = time(field(raw, "timestamp"));
	const at = type === "message" && field(value, "timestamp") !== undefined ? time(field(value, "timestamp")) : entryAt;
	if (!at || !entryAt) throw new Error("pi-source-occurrence");
	const entry = field(raw, "id");
	const response = field(value, "responseId");
	const provider = field(value, "provider");
	const numeric = ["input", "output", "cacheRead", "cacheWrite"].map((key) => scalar(field(usage, key)));
	return {
		at,
		entry: ref(entry) ? entry : null,
		entryAt,
		response: ref(response) ? response : null,
		provider: ref(provider) ? provider : null,
		fingerprint: digest(
			JSON.stringify([
				at,
				scalar(provider),
				scalar(field(value, "model")),
				type === "usage" ? scalar(field(raw, "kind")) : type === "message" ? "assistant" : "compaction",
				numeric,
				scalar(field(field(usage, "cost"), "total")),
			]),
		),
	};
}
function under(file: string, root: string): boolean {
	const rel = relative(root, file);
	return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}
function prefix(raw: PiSourcePrefix): boolean {
	return (
		raw.v === "pi-source-index/1" &&
		raw.storeMajor === 1 &&
		uint(raw.sequence) &&
		SHA.test(raw.sha256) &&
		raw.verified === true
	);
}
function stamp(stat: Stats): FileStamp {
	return { dev: stat.dev, ino: stat.ino, size: stat.size, mtime: stat.mtimeMs, ctime: stat.ctimeMs };
}
const sameIdentity = (a: FileStamp, b: FileStamp) => a.dev === b.dev && a.ino === b.ino;
const sameStamp = (a: FileStamp, b: FileStamp) =>
	sameIdentity(a, b) && a.size === b.size && a.mtime === b.mtime && a.ctime === b.ctime;
class NativeFault extends Error {
	constructor(readonly code: PiSourceGap) {
		super(code);
	}
}
/** Check every component, then O_NOFOLLOW + fstat. No directory symlink/hardlink escape. */
function native(file: string, roots: readonly string[]): { fd: number; stamp: FileStamp } {
	if (!isAbsolute(file) || resolve(file) !== file || !ref(file) || !roots.some((root) => under(file, root)))
		throw new NativeFault("unsafe-path");
	let path = dirname(file);
	for (;;) {
		const st = lstatSync(path);
		if (!st.isDirectory() || st.isSymbolicLink()) throw new NativeFault("unsafe-path");
		const parent = dirname(path);
		if (parent === path) break;
		path = parent;
	}
	const before = lstatSync(file);
	if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) throw new NativeFault("unsafe-path");
	const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
	try {
		const st = fstatSync(fd);
		if (!st.isFile() || st.nlink !== 1 || st.dev !== before.dev || st.ino !== before.ino || !uint(st.size))
			throw new NativeFault("unsafe-path");
		return { fd, stamp: stamp(st) };
	} catch (e) {
		closeSync(fd);
		throw e;
	}
}
function freshSource(
	id: string,
	file: string,
	kind: PiSourceKind,
	producer: "pi" | "acp",
	owner: "pi" | "temper",
	seen: number,
	st: FileStamp,
	gaps: PiSourceGap[] = [],
): Source {
	return {
		id,
		file,
		original: file,
		kind,
		producer,
		owner,
		seen,
		stamp: st,
		header: null,
		anchor: null,
		reader: null,
		retainedFrom: null,
		scanDone: false,
		readDone: kind !== "session",
		verifyAfter: null,
		verifyStamp: null,
		verifying: false,
		dirty: false,
		gaps,
		observedAt: null,
	};
}
function addGap(source: { gaps: PiSourceGap[] }, gap: PiSourceGap): void {
	if (!source.gaps.includes(gap)) source.gaps.push(gap);
}
function sourceValid(s: Source, id: string): boolean {
	return (
		s.id === id &&
		SHA.test(id) &&
		ref(s.file) &&
		isAbsolute(s.file) &&
		ref(s.original) &&
		KINDS.has(s.kind) &&
		["pi", "acp"].includes(s.producer) &&
		["pi", "temper"].includes(s.owner) &&
		uint(s.seen) &&
		[s.stamp.dev, s.stamp.ino, s.stamp.size].every(uint) &&
		[s.stamp.mtime, s.stamp.ctime].every(Number.isFinite) &&
		Array.isArray(s.gaps) &&
		s.gaps.length <= 32 &&
		s.gaps.every((g) => GAP_CODES.has(g)) &&
		(s.header === null ||
			(ref(s.header.id) &&
				iso(s.header.timestamp) &&
				SHA.test(s.header.sha) &&
				(s.header.parentSession === undefined || ref(s.header.parentSession)))) &&
		(s.anchor === null ||
			(uint(s.anchor.line) &&
				uint(s.anchor.end) &&
				uint(s.anchor.start) &&
				uint(s.anchor.bytes) &&
				s.anchor.start + s.anchor.bytes === s.anchor.end &&
				s.anchor.bytes <= PI_SOURCE_LIMITS.lineBytes &&
				SHA.test(s.anchor.sha))) &&
		(s.reader === null ||
			(uint(s.reader.ordinal) && /^pi1:\d+:\d+:\d+:[a-f0-9]{64}:[a-f0-9]{64}$/.test(s.reader.token))) &&
		[s.scanDone, s.readDone, s.verifying, s.dirty].every((v) => typeof v === "boolean") &&
		(s.retainedFrom === null || iso(s.retainedFrom)) &&
		(s.observedAt === null || iso(s.observedAt))
	);
}

/** All retained history is in the injected bounded index, not a process-local all-chat Map. */
export class PiSourceAdapter {
	private sealed = false;
	private busy = false;
	private started = 0;
	private constructor(
		private readonly options: {
			index: PiSourceIndex;
			catalog: PiSourceCatalog;
			roots: Record<PiSourceKind, readonly string[]>;
			/** Native, source-owned Temper worker roots. A filename/title is never an ownership witness. */
			temperRoots: readonly string[];
			current: { from: string; through: string };
			clock?: () => number;
			yield?: () => Promise<void>;
		},
		private committed: PiSourcePrefix,
	) {}
	static async open(options: PiSourceAdapter["options"]): Promise<PiSourceAdapter> {
		const head = await options.index.head();
		if (
			!prefix(head) ||
			!iso(options.current.from) ||
			!iso(options.current.through) ||
			options.current.from > options.current.through ||
			Date.parse(options.current.through) - Date.parse(options.current.from) > 169 * 3_600_000
		)
			throw new Error("pi-source-index-unavailable");
		for (const roots of [...Object.values(options.roots), options.temperRoots])
			if (!Array.isArray(roots) || roots.some((root) => !isAbsolute(root) || resolve(root) !== root))
				throw new Error("pi-source-roots");
		return new PiSourceAdapter(options, head);
	}
	private clock(): number {
		return this.options.clock?.() ?? performance.now();
	}
	private tick(): void {
		const elapsed = this.clock() - this.started;
		if (!Number.isFinite(elapsed) || elapsed < 0 || elapsed > PI_SOURCE_LIMITS.unitWorkMs)
			throw new Error("pi-source-work-limit");
	}
	private async unit<T>(run: () => Promise<T>): Promise<T> {
		if (this.sealed || this.busy) throw new Error("pi-source-index-unavailable");
		this.busy = true;
		this.started = this.clock();
		try {
			return await run();
		} catch {
			this.sealed = true;
			throw new Error("pi-source-index-unavailable");
		} finally {
			this.busy = false;
			await (this.options.yield?.() ?? new Promise<void>((done) => setImmediate(done)));
		}
	}
	private async get<T>(key: string): Promise<T | null> {
		const text = await this.options.index.get(key);
		this.tick();
		if (text === null) return null;
		if (typeof text !== "string" || Buffer.byteLength(text) > PI_SOURCE_LIMITS.pageBytes)
			throw new Error("pi-source-index");
		return JSON.parse(text) as T;
	}
	private async original(key: string): Promise<Original | null> {
		const value = await this.get<Original>(key);
		if (!value) return null;
		if (
			Object.keys(value).sort().join(",") !== "entryAt,fact,file,fingerprint" ||
			!SHA.test(value.fingerprint) ||
			!iso(value.entryAt) ||
			!ref(value.file) ||
			!isAbsolute(value.file)
		)
			throw new Error("pi-source-index");
		const parsed = parseAccountingInput({
			v: 1,
			...empty(),
			facts: [value.fact],
			coverage: [],
			requiredStreams: ["pi-source-index:receipt"],
		});
		if (
			!parsed.ok ||
			parsed.value.facts[0].identity.producer !== "pi" ||
			parsed.value.facts[0].identityStatus !== "verified"
		)
			throw new Error("pi-source-index");
		return { ...value, fact: parsed.value.facts[0] };
	}
	private async scan<T>(
		key: string,
		after: string | null = null,
		rows: number = PI_SOURCE_LIMITS.scanRows,
	): Promise<{ entries: { key: string; value: T }[]; next: string | null }> {
		const page = await this.options.index.scan(key, after, { bytes: PI_SOURCE_LIMITS.pageBytes, rows });
		this.tick();
		if (
			!Array.isArray(page.entries) ||
			page.entries.length > rows ||
			Buffer.byteLength(JSON.stringify(page)) > PI_SOURCE_LIMITS.pageBytes ||
			(page.next !== null && (page.entries.length === 0 || page.next !== page.entries.at(-1)!.key))
		)
			throw new Error("pi-source-index");
		let previous = after ?? "";
		return {
			entries: page.entries.map((entry) => {
				if (!entry.key.startsWith(key) || entry.key <= previous || typeof entry.value !== "string")
					throw new Error("pi-source-index");
				previous = entry.key;
				return { key: entry.key, value: JSON.parse(entry.value) as T };
			}),
			next: page.next,
		};
	}
	private async commit(
		values: { key: string; value: unknown }[],
		rows = empty(),
		batch: Batch | null = null,
	): Promise<void> {
		const puts = [...new Map(values.map(({ key, value }) => [key, { key, value: JSON.stringify(value) }])).values()];
		const unit = { puts, rows, native: batch, batch: this.resolved(batch, rows) };
		if (
			puts.length + rows.facts.length + rows.aliases.length + rows.memberships.length > PI_SOURCE_LIMITS.pageRows ||
			Buffer.byteLength(JSON.stringify(unit)) > PI_SOURCE_LIMITS.pageBytes
		)
			throw new Error("pi-source-unit-limit");
		this.tick();
		const head = await this.options.index.commit(this.committed, unit);
		if (!prefix(head) || head.sequence !== this.committed.sequence + 1 || head.sha256 === this.committed.sha256)
			throw new Error("pi-source-index");
		this.committed = head;
	}
	private async source(id: string): Promise<Source> {
		const s = await this.get<Source>(`source:${id}`);
		if (!s || !sourceValid(s, id)) throw new Error("pi-source-index");
		return s;
	}
	private async inventory(): Promise<Inventory> {
		return (
			(await this.get<Inventory>("inventory")) ?? {
				epoch: 1,
				generation: null,
				after: null,
				sweep: null,
				phase: "catalog",
				count: 0,
				gaps: ["inventory-pending"],
			}
		);
	}
	/** One bounded catalog/sweep page. EOF is meaningful only in a stable generation. */
	async discover(): Promise<{ done: boolean; gaps: PiSourceGap[] }> {
		return this.unit(async () => {
			const inv = await this.inventory();
			if (inv.phase === "done") return { done: true, gaps: [...inv.gaps] };
			const puts: { key: string; value: unknown }[] = [];
			if (inv.phase === "sweep") {
				const page = await this.scan<Source>("source:", inv.sweep, 32);
				for (const { value: s } of page.entries) {
					if (!sourceValid(s, s.id)) throw new Error("pi-source-index");
					if (s.seen !== inv.epoch) {
						addGap(s, "source-missing");
						puts.push({ key: `source:${s.id}`, value: s });
					}
				}
				inv.sweep = page.next;
				if (page.next === null) {
					inv.phase = "done";
					inv.gaps = inv.gaps.filter((g) => !["inventory-pending", "inventory-changed"].includes(g));
				}
			} else {
				let page: Awaited<ReturnType<PiSourceCatalog["page"]>>;
				try {
					page = await this.options.catalog.page(inv.after, { bytes: 32_768, rows: 24 });
				} catch {
					addGap(inv, "inventory-unavailable");
					await this.commit([{ key: "inventory", value: inv }]);
					return { done: false, gaps: inv.gaps };
				}
				// Project catalog scalars before serializing; raw objects may have planted payload getters.
				if (!Array.isArray(page.entries) || page.entries.length > 24) throw new Error("pi-source-catalog");
				const entries = page.entries.map((raw) => {
					const file = field(raw, "file"),
						kind = field(raw, "kind"),
						producer = field(raw, "producer");
					if (typeof file !== "string" || typeof kind !== "string" || typeof producer !== "string")
						throw new Error("pi-source-catalog");
					return { file, kind, producer };
				});
				if (
					Buffer.byteLength(JSON.stringify(entries)) > 32_768 ||
					!ref(page.generation) ||
					(page.next !== null && (!ref(page.next) || page.next === inv.after)) ||
					!["complete", "partial", "unavailable"].includes(page.status)
				)
					throw new Error("pi-source-catalog");
				if (inv.generation !== null && inv.generation !== page.generation) {
					inv.epoch++;
					inv.generation = null;
					inv.after = null;
					inv.count = 0;
					inv.gaps = ["inventory-pending", "inventory-changed"];
					await this.commit([{ key: "inventory", value: inv }]);
					return { done: false, gaps: inv.gaps };
				}
				inv.generation = page.generation;
				if (page.status !== "complete") addGap(inv, "inventory-unavailable");
				for (const e of entries) {
					if (
						!ref(e.file) ||
						!isAbsolute(e.file) ||
						!KINDS.has(String(e.kind)) ||
						!["pi", "acp"].includes(String(e.producer))
					) {
						addGap(inv, "unsafe-path");
						continue;
					}
					const file = resolve(e.file),
						kind = e.kind as PiSourceKind,
						producer = e.producer as "pi" | "acp";
					const owner = this.options.temperRoots.some((root) => under(file, root)) ? "temper" : "pi";
					let st: FileStamp;
					try {
						const f = native(file, owner === "temper" ? this.options.temperRoots : this.options.roots[kind]);
						st = f.stamp;
						closeSync(f.fd);
					} catch (error) {
						const gap = error instanceof NativeFault ? error.code : "source-unreadable";
						const pathKey = `path:${digest(file)}`;
						const known = await this.get<string>(pathKey);
						const id = known ?? digest(file);
						const failed = known
							? await this.source(id)
							: freshSource(id, file, kind, producer, owner, inv.epoch, {
									dev: 0,
									ino: 0,
									size: 0,
									mtime: 0,
									ctime: 0,
								});
						if (!known || failed.seen !== inv.epoch) {
							if (inv.count >= PI_SOURCE_LIMITS.sources) {
								addGap(inv, "inventory-limit");
								break;
							}
							inv.count++;
						}
						failed.seen = inv.epoch;
						addGap(failed, gap);
						puts.push({ key: `source:${id}`, value: failed }, { key: pathKey, value: id });
						continue;
					}
					const pathKey = `path:${digest(file)}`;
					const inodeKey = `inode:${st.dev}:${st.ino}`;
					const localPath = puts.findLast((p) => p.key === pathKey)?.value;
					const localInode = puts.findLast((p) => p.key === inodeKey)?.value;
					const known =
						typeof localPath === "string"
							? localPath
							: typeof localInode === "string"
								? localInode
								: ((await this.get<string>(pathKey)) ?? (await this.get<string>(inodeKey)));
					const id = known ?? digest(file);
					let s =
						(puts.findLast((p) => p.key === `source:${id}`)?.value as Source | undefined) ??
						(known ? await this.source(id) : null);
					if (!s || s.seen !== inv.epoch) {
						if (inv.count >= PI_SOURCE_LIMITS.sources) {
							addGap(inv, "inventory-limit");
							break;
						}
						inv.count++;
					}
					if (s && !s.header && !s.anchor && !s.reader && s.stamp.ino === 0) s = null;
					if (s && (s.kind !== kind || s.producer !== producer || s.owner !== owner)) {
						addGap(s, "source-replaced");
					}
					if (!s) s = freshSource(id, file, kind, producer, owner, inv.epoch, st);
					else {
						if (!sameIdentity(s.stamp, st)) addGap(s, "source-replaced");
						else if (!sameStamp(s.stamp, st)) {
							s.verifying = !!s.anchor;
							s.verifyAfter = null;
							s.verifyStamp = null;
							s.scanDone = false;
							s.readDone = kind !== "session";
						}
						s.file = file;
						s.seen = inv.epoch;
						s.dirty = false;
						s.gaps = s.gaps.filter((g) => g !== "source-missing");
					}
					if (producer === "acp" && owner !== "temper") addGap(s, "unsupported-acp");
					for (const p of [
						{ key: `source:${id}`, value: s },
						{ key: pathKey, value: id },
						{ key: inodeKey, value: id },
					]) {
						const prior = puts.findIndex((old) => old.key === p.key);
						if (prior >= 0) puts.splice(prior, 1);
						puts.push(p);
					}
				}
				inv.after = page.next;
				if (page.next === null && page.status === "complete" && !inv.gaps.includes("inventory-limit"))
					inv.phase = "sweep";
			}
			puts.push({ key: "inventory", value: inv });
			await this.commit(puts);
			return { done: inv.phase === "done", gaps: [...inv.gaps] };
		});
	}
	/** Native lifecycle + directory events use this seam; no watcher is installed here.
	 * Unknown/new/rename/overflow events force a complete catalog reconciliation, not all-chat polling. */
	async notify(event: { kind: "dirty"; file: string } | { kind: "directory" | "overflow" }): Promise<void> {
		return this.unit(async () => {
			if (event.kind === "dirty") {
				const id = await this.get<string>(`path:${digest(resolve(event.file))}`);
				if (id) {
					const s = await this.source(id);
					s.dirty = true;
					s.verifying = !!s.anchor;
					s.verifyAfter = null;
					s.verifyStamp = null;
					s.scanDone = false;
					s.readDone = s.kind !== "session";
					await this.commit([{ key: `source:${id}`, value: s }]);
					return;
				}
			}
			const inv = await this.inventory();
			inv.epoch++;
			inv.generation = null;
			inv.after = null;
			inv.sweep = null;
			inv.count = 0;
			inv.phase = "catalog";
			inv.gaps = ["inventory-pending"];
			await this.commit([{ key: "inventory", value: inv }]);
		});
	}
	/** Required inventory is paged in full; unsupported obligations are never cleared by a clean page. */
	async required(after: string | null = null): Promise<{
		entries: PiRequiredSource[];
		next: string | null;
		inventory: "complete" | "partial";
		gaps: PiSourceGap[];
	}> {
		return this.unit(async () => {
			const inv = await this.inventory();
			const page = await this.scan<Source>("source:", after, after === null ? 60 : 64);
			const entries: PiRequiredSource[] = page.entries.map(({ value: s }) => {
				if (!sourceValid(s, s.id)) throw new Error("pi-source-index");
				const excluded = s.owner === "temper";
				return {
					id: s.id,
					kind: s.kind,
					required: !excluded,
					coverageOwner: excluded ? "temper:T0" : "pi:W3",
					excluded,
					state: excluded
						? "excluded"
						: s.gaps.length
							? "terminal-gap"
							: s.scanDone && s.readDone && !s.dirty && !s.verifying
								? "complete-recorded"
								: "pending",
					usageCoverage: excluded ? "unknown" : "partial",
					collector:
						!excluded && s.kind === "session" && s.producer === "pi" && s.header
							? {
									stream: `pi-session:${digest(s.file)}`,
									incarnation: s.header.id,
									adapterRef: "pi-source-index/1",
									producer: "pi",
									occurrenceStreams: [...new Set([`pi-session:${digest(s.original)}`, `pi-session:${digest(s.file)}`])],
									retainedFrom: s.retainedFrom,
									grants: ["facts", "aliases"],
								}
							: null,
					gaps: [...s.gaps],
				};
			});
			if (after === null)
				for (const code of [
					"unsupported-acp",
					"fileless-calls",
					"unreported-failures",
					"aggregate-provenance",
				] as const)
					entries.push({
						id: code,
						kind: "gap",
						required: true,
						coverageOwner: "unsupported",
						excluded: true,
						state: "terminal-gap",
						usageCoverage: "unknown",
						collector: null,
						gaps: [code],
					});
			return {
				entries,
				next: page.next,
				inventory: inv.phase === "done" && inv.gaps.length === 0 ? "complete" : "partial",
				gaps: inv.gaps,
			};
		});
	}
	private resolved(native: Batch | null, rows: Rows): Batch | null {
		return native
			? { ...native, adapterRef: "pi-source-index/1", status: "partial", reason: "reported-gap", rows }
			: null;
	}
	private result(s: Source, action: PiSourceUnit["action"]): PiSourceUnit {
		return {
			id: s.id,
			action,
			promote: null,
			rows: empty(),
			batch: null,
			current: [],
			staged: [],
			gaps: [...s.gaps],
			readerFaults: [],
			bytes: 0,
			records: 0,
		};
	}
	async step(id: string, lane: "current" | "history", observedAt: string): Promise<PiSourceUnit> {
		if (!SHA.test(id) || !iso(observedAt) || observedAt < this.options.current.through)
			throw new Error("pi-source-request");
		return this.unit(async () => {
			const s = await this.source(id);
			if (s.owner === "temper") return this.result(s, "excluded");
			if (s.gaps.some((g) => !["copy-pending", "partial-last-line", "work-limit"].includes(g)))
				return this.result(s, "blocked");
			if (s.verifying) return this.verify(s);
			// Even a missed dirty event cannot authorize appending to a changed indexed prefix.
			try {
				const checked = native(s.file, this.options.roots[s.kind]);
				closeSync(checked.fd);
				if (!sameIdentity(checked.stamp, s.stamp)) throw new NativeFault("source-replaced");
				if (checked.stamp.size < (s.anchor?.end ?? 0)) throw new NativeFault("source-truncated");
				if (s.anchor && !sameStamp(checked.stamp, s.stamp)) {
					s.verifying = true;
					s.verifyStamp = null;
					s.verifyAfter = null;
					s.scanDone = false;
					s.readDone = s.kind !== "session";
					await this.commit([{ key: `source:${s.id}`, value: s }]);
					return this.result(s, "verify");
				}
			} catch (error) {
				addGap(s, error instanceof NativeFault ? error.code : "source-unreadable");
				await this.commit([{ key: `source:${s.id}`, value: s }]);
				return this.result(s, "blocked");
			}
			if (!s.scanDone) return this.scanNative(s, observedAt);
			if (s.kind !== "session" || s.readDone) return this.result(s, "idle");
			return this.readUsage(s, lane, observedAt);
		});
	}
	private finish(s: Source, fd: number, expected: FileStamp): void {
		const checked = native(s.file, this.options.roots[s.kind]);
		try {
			if (!sameStamp(expected, checked.stamp) || !sameStamp(expected, stamp(fstatSync(fd))))
				throw new NativeFault("anchor-changed");
		} finally {
			closeSync(checked.fd);
		}
	}
	private async verify(s: Source): Promise<PiSourceUnit> {
		const before = structuredClone(s);
		const out = this.result(s, "verify");
		let fd: number | null = null;
		try {
			const f = native(s.file, this.options.roots[s.kind]);
			fd = f.fd;
			if (!sameIdentity(f.stamp, s.stamp)) throw new NativeFault("source-replaced");
			if (f.stamp.size < (s.anchor?.end ?? 0)) throw new NativeFault("source-truncated");
			if (s.verifyStamp && !sameStamp(s.verifyStamp, f.stamp)) throw new NativeFault("anchor-changed");
			s.verifyStamp ??= f.stamp;
			const page = await this.scan<{ start: number; bytes: number; sha: string }>(`prefix:${s.id}:`, s.verifyAfter, 1);
			if (page.entries.length) {
				const { value: a } = page.entries[0];
				if (!uint(a.start) || !uint(a.bytes) || a.bytes > PI_SOURCE_LIMITS.pageBytes || !SHA.test(a.sha))
					throw new Error("pi-source-index");
				const bytes = Buffer.alloc(a.bytes);
				out.bytes = readSync(fd, bytes, 0, bytes.length, a.start);
				if (out.bytes !== a.bytes || digest(bytes) !== a.sha) throw new NativeFault("anchor-changed");
				s.verifyAfter = page.entries[0].key;
			}
			this.finish(s, fd, f.stamp);
			if (page.next === null) {
				s.stamp = f.stamp;
				s.verifying = false;
				s.dirty = false;
				s.verifyAfter = null;
				s.verifyStamp = null;
				s.gaps = s.gaps.filter((g) => !["partial-last-line", "work-limit"].includes(g));
			}
		} catch (error) {
			Object.assign(s, before);
			addGap(s, error instanceof NativeFault ? error.code : "source-unreadable");
		} finally {
			if (fd !== null) closeSync(fd);
		}
		out.gaps = [...s.gaps];
		await this.commit([{ key: `source:${s.id}`, value: s }]);
		return out;
	}
	/** #305 predates native source-tag immutability. Filter only native-rejected edits here;
	 * retain the original projected event plus its accepted/rejected witness in the private index. */
	private async queueEvent(raw: unknown, s: Source, puts: { key: string; value: unknown }[]): Promise<unknown> {
		const projected = projectMembershipSessionEntry(raw);
		if (!projected || field(projected, "type") !== "custom") return projected;
		const data = field(projected, "data"),
			op = field(data, "op"),
			id = field(data, "id");
		if (!uint(id) || id === 0 || field(data, "v") !== 1) return projected;
		const bound = field(data, "queueId");
		if (bound !== undefined && bound !== s.header?.id) return projected;
		const key = `task:${s.id}:${pad(id)}`;
		let prior = puts.findLast((p) => p.key === key)?.value as { immutable: boolean } | undefined;
		prior ??= (await this.get<{ immutable: boolean }>(key)) ?? undefined;
		let accepted = true;
		if ((op === "add" || op === "assigned") && !prior) {
			const source = field(field(raw, "data"), "source");
			const immutable = Boolean(source);
			if (
				immutable &&
				!["key", "configuration", "sessionId"].every((k) => {
					const v = field(source, k);
					return typeof v === "string" && v.length > 0 && v.length <= 256;
				})
			)
				accepted = false;
			else puts.push({ key, value: { immutable } });
		} else if ((op === "update" || op === "requeue") && prior?.immutable) accepted = false;
		// Native chain records alter dependency ordering, not task/parent identity. The original
		// numeric event stays indexed; it must not become an unknown-op #305 parent mutation.
		puts.push({ key: `queue-event:${s.id}:${pad((s.anchor?.line ?? 0) + 1)}`, value: { record: projected, accepted } });
		return accepted && op !== "chain" ? projected : null;
	}
	private async scanNative(s: Source, observedAt: string): Promise<PiSourceUnit> {
		const before = structuredClone(s);
		s.gaps = s.gaps.filter((g) => !["partial-last-line", "work-limit"].includes(g));
		const out = this.result(s, "scan"),
			puts: { key: string; value: unknown }[] = [];
		const startClock = this.clock();
		let fd: number | null = null;
		try {
			const f = native(s.file, this.options.roots[s.kind]);
			fd = f.fd;
			if (!sameIdentity(f.stamp, s.stamp)) throw new NativeFault("source-replaced");
			if (f.stamp.size < (s.anchor?.end ?? 0)) throw new NativeFault("source-truncated");
			if (s.anchor) {
				const a = s.anchor,
					check = Buffer.alloc(a.bytes);
				out.bytes += readSync(fd, check, 0, check.length, a.start);
				if (out.bytes !== a.bytes || digest(check) !== a.sha) throw new NativeFault("anchor-changed");
			}
			const begin = s.anchor?.end ?? 0;
			const length = Math.min(
				PI_SOURCE_LIMITS.readerBytes,
				PI_SOURCE_LIMITS.pageBytes - out.bytes,
				f.stamp.size - begin,
			);
			const bytes = Buffer.alloc(length);
			const n = readSync(fd, bytes, 0, length, begin);
			out.bytes += n;
			if (n !== length) throw new NativeFault("source-truncated");
			let at = 0;
			while (at < n && out.records < PI_SOURCE_LIMITS.scanRows) {
				const elapsed = this.clock() - startClock;
				if (!Number.isFinite(elapsed) || elapsed < 0 || elapsed > PI_SOURCE_LIMITS.unitWorkMs)
					throw new NativeFault("work-limit");
				if (elapsed >= PI_SOURCE_LIMITS.sliceMs && out.records) break;
				const end = bytes.indexOf(10, at);
				if (end < 0) {
					if (n - at >= PI_SOURCE_LIMITS.lineBytes) addGap(s, "line-limit");
					else if (begin + n === f.stamp.size) addGap(s, "partial-last-line");
					break;
				}
				if (end + 1 - at > PI_SOURCE_LIMITS.lineBytes) {
					addGap(s, "line-limit");
					break;
				}
				const line = (s.anchor?.line ?? 0) + 1;
				let raw: unknown;
				try {
					raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(at, end + 1)));
				} catch {
					addGap(s, "invalid-record");
					break;
				}
				let record: unknown = null;
				if (s.kind === "session") {
					if (line === 1) {
						const id = field(raw, "id"),
							timestamp = field(raw, "timestamp"),
							parent = field(raw, "parentSession");
						if (
							field(raw, "type") !== "session" ||
							field(raw, "version") !== 3 ||
							!ref(id) ||
							!iso(timestamp) ||
							timestamp > observedAt ||
							(parent !== undefined && !ref(parent))
						)
							throw new NativeFault("invalid-record");
						const parentFile = typeof parent === "string" ? resolve(dirname(s.original), parent) : undefined;
						s.header = {
							id,
							timestamp,
							...(parentFile ? { parentSession: parentFile } : {}),
							sha: digest(bytes.subarray(at, end + 1)),
						};
						record = { type: "session", id, timestamp, ...(parentFile ? { parentSession: parentFile } : {}) };
						puts.push({ key: `session:${digest(id)}:${s.id}`, value: s.id });
					} else {
						record = await this.queueEvent(raw, s, puts);
						const occurrence = projectPiSourceOccurrence(raw);
						if (occurrence) {
							puts.push({ key: `occ:${s.id}:${pad(line)}`, value: { ...occurrence, line } });
							if (s.retainedFrom === null || occurrence.at < s.retainedFrom) s.retainedFrom = occurrence.at;
						}
					}
				} else if (s.kind === "registry") {
					record = projectMembershipRegistryEvent(raw);
					const seq = field(record, "seq"),
						ts = time(field(record, "ts"));
					const last = (await this.get<{ seq: number; at: string }>(`registry:${s.id}`)) ?? { seq: 0, at: "" };
					// The local page's predecessor takes precedence over the previous committed page.
					const local = puts.findLast((p) => p.key === `registry:${s.id}`)?.value as typeof last | undefined;
					const prior = local ?? last;
					if (field(record, "v") !== 1 || seq !== prior.seq + 1) {
						addGap(s, "registry-sequence");
						break;
					}
					if (!ts || ts < prior.at) {
						addGap(s, "event-time-order");
						break;
					}
					// One cursor update per unit, with every original event retained separately.
					const old = puts.findIndex((p) => p.key === `registry:${s.id}`);
					if (old >= 0) puts.splice(old, 1);
					puts.push({ key: `registry:${s.id}`, value: { seq, at: ts } });
				} else record = s.kind === "conversation" ? projectMembershipConversation(raw) : projectMembershipDelegate(raw);
				if (record !== null) puts.push({ key: `meta:${s.id}:${pad(line)}`, value: { line, record } });
				s.anchor = {
					line,
					start: begin + at,
					end: begin + end + 1,
					bytes: end + 1 - at,
					sha: digest(bytes.subarray(at, end + 1)),
				};
				at = end + 1;
				out.records++;
			}
			if (at)
				puts.push({
					key: `prefix:${s.id}:${pad(begin)}`,
					value: { start: begin, bytes: at, sha: digest(bytes.subarray(0, at)) },
				});
			this.finish(s, fd, f.stamp);
			if (s.kind === "session" && !s.header) addGap(s, "invalid-record");
			s.stamp = f.stamp;
			s.scanDone = (s.anchor?.end ?? 0) === f.stamp.size && s.gaps.every((g) => g === "copy-pending");
			s.observedAt = observedAt;
		} catch (error) {
			puts.length = 0;
			out.records = 0;
			Object.assign(s, before);
			addGap(s, error instanceof NativeFault ? error.code : "invalid-record");
		} finally {
			if (fd !== null) closeSync(fd);
		}
		out.gaps = [...s.gaps];
		puts.push({ key: `source:${s.id}`, value: s });
		await this.commit(puts);
		return out;
	}
	private async readUsage(s: Source, lane: "current" | "history", observedAt: string): Promise<PiSourceUnit> {
		const out = this.result(s, "usage");
		if (!s.header) throw new Error("pi-source-index");
		// Bounded numeric-only cycle check, including parents not yet processed by this lane.
		const ancestry = new Set([s.id]),
			parents: Source[] = [];
		let ancestor: Source | null = s;
		for (let depth = 0; ancestor?.header?.parentSession; depth++) {
			if (depth >= PI_SOURCE_LIMITS.dependencies) {
				addGap(s, "dependency-limit");
				break;
			}
			const nextId = await this.get<string>(`path:${digest(ancestor.header.parentSession)}`);
			if (!nextId) {
				addGap(s, "missing-parent");
				break;
			}
			if (ancestry.has(nextId)) {
				addGap(s, "parent-cycle");
				break;
			}
			ancestry.add(nextId);
			ancestor = await this.source(nextId);
			parents.push(ancestor);
		}
		const parentPuts: { key: string; value: Source }[] = [];
		// Re-stat every ancestor before trusting persisted absence/completion. A missed parent
		// append promotes its prefix before a new child can mint a fallback charge.
		for (const parent of parents) {
			if (s.gaps.some((g) => ["parent-cycle", "dependency-limit", "missing-parent"].includes(g))) break;
			if (parent.owner !== "pi") {
				addGap(s, "missing-parent");
				break;
			}
			try {
				const checked = native(parent.file, this.options.roots[parent.kind]);
				closeSync(checked.fd);
				if (!sameIdentity(checked.stamp, parent.stamp)) throw new NativeFault("source-replaced");
				if (checked.stamp.size < (parent.anchor?.end ?? 0)) throw new NativeFault("source-truncated");
				if (!sameStamp(checked.stamp, parent.stamp) && !parent.verifying) {
					parent.dirty = true;
					parent.scanDone = false;
					parent.readDone = false;
					parent.verifying = !!parent.anchor;
					parent.verifyAfter = null;
					parent.verifyStamp = null;
					parentPuts.push({ key: `source:${parent.id}`, value: parent });
				}
			} catch (error) {
				addGap(parent, error instanceof NativeFault ? error.code : "source-unreadable");
				parentPuts.push({ key: `source:${parent.id}`, value: parent });
			}
			if (parent.gaps.some((g) => !["copy-pending", "partial-last-line", "work-limit"].includes(g))) {
				addGap(s, "missing-parent");
				break;
			}
			if (!parent.scanDone || !parent.readDone || parent.verifying || parent.dirty) {
				addGap(s, "copy-pending");
				out.promote = parent.id;
				break;
			}
		}
		if (out.promote || s.gaps.some((g) => ["parent-cycle", "dependency-limit", "missing-parent"].includes(g))) {
			out.action = "blocked";
			out.gaps = [...s.gaps];
			await this.commit([...parentPuts, { key: `source:${s.id}`, value: s }]);
			return out;
		}
		s.gaps = s.gaps.filter((g) => g !== "copy-pending");
		const next = await this.scan<Occurrence>(
			`occ:${s.id}:`,
			s.reader ? `occ:${s.id}:${pad(s.reader.ordinal)}` : null,
			1,
		);
		const occurrence = next.entries[0]?.value;
		const from = occurrence?.at ?? this.options.current.from;
		if (!iso(from) || from > observedAt) {
			addGap(s, "event-time-order");
			out.action = "blocked";
			out.gaps = s.gaps;
			await this.commit([{ key: `source:${s.id}`, value: s }]);
			return out;
		}
		const through = new Date(Math.min(Date.parse(from) + 169 * 3_600_000, Date.parse(observedAt))).toISOString();
		// Fresh bounded #304 instance: W3's durable index, not its 64-file process cache, owns continuity.
		const read = await new PiSessionUsageReader({ readBytes: PI_SOURCE_LIMITS.readerBytes, batchRows: 8 }).read({
			file: s.file,
			producer: s.producer,
			from,
			through,
			observedAt,
			cursor: s.reader,
		});
		out.bytes = PI_SOURCE_LIMITS.readerBytes; // conservative full reader allowance, including anchors/header
		out.readerFaults = read.faults;
		// #304 does not re-stat at its return boundary. No numeric/cursor candidate survives a
		// replacement, rewrite or root-permission escape while its bounded async read was running.
		try {
			const checked = native(s.file, this.options.roots[s.kind]);
			try {
				if (!sameStamp(checked.stamp, s.stamp)) throw new NativeFault("anchor-changed");
			} finally {
				closeSync(checked.fd);
			}
		} catch (error) {
			addGap(s, error instanceof NativeFault ? error.code : "source-unreadable");
			out.action = "blocked";
			out.gaps = [...s.gaps];
			await this.commit([{ key: `source:${s.id}`, value: s }]);
			return out;
		}
		const puts: { key: string; value: unknown }[] = [];
		const nativeReceipt = read.batch ? structuredClone(read.batch) : null;
		if (!read.batch || !read.cursor) {
			if (read.endOfFile && s.reader) s.readDone = true;
			else if (
				read.faults.some((f) => f.code !== "window-mismatch" && f.code !== "read-limit" && f.code !== "batch-limit")
			)
				addGap(s, "source-unreadable");
		} else {
			for (const observation of read.observations) {
				const o = await this.get<Occurrence>(`occ:${s.id}:${pad(observation.line)}`);
				const numeric = read.batch.rows.facts.find((f) => f.id === observation.factId);
				const fact = numeric ? structuredClone(numeric) : null;
				if (!o || !fact || !o.entry) {
					addGap(s, "identity-conflict");
					continue;
				}
				const responseKey =
					o.response && o.provider ? `response:${digest(JSON.stringify([s.producer, o.provider, o.response]))}` : null;
				const ownKey = `identity:${digest(JSON.stringify([s.producer, s.header.id, o.entry]))}`;
				let original = responseKey ? await this.original(responseKey) : await this.original(ownKey);
				if (!original && s.header.parentSession) {
					const parentId = await this.get<string>(`path:${digest(s.header.parentSession)}`);
					original = parentId
						? await this.original(`entry:${parentId}:${digest(JSON.stringify([o.entry, o.entryAt]))}`)
						: null;
				}
				// Read-your-writes within this bounded page; no cross-page process cache.
				if (!original)
					original = (puts.findLast((p) => p.key === (responseKey ?? ownKey))?.value as Original | undefined) ?? null;
				if (original && (original.fingerprint !== o.fingerprint || (!o.response && original.entryAt !== o.entryAt))) {
					addGap(s, "identity-conflict");
					continue;
				}
				const eventKey = `native-event:${s.id}:${digest(o.entry)}`;
				const priorEvent =
					(puts.findLast((p) => p.key === eventKey)?.value as NativeEvent | undefined) ??
					(await this.get<NativeEvent>(eventKey));
				if (
					priorEvent &&
					(priorEvent.fingerprint !== o.fingerprint ||
						priorEvent.response !== o.response ||
						priorEvent.entryAt !== o.entryAt)
				) {
					addGap(s, "identity-conflict");
					continue;
				}
				if (priorEvent) {
					if (priorEvent.fact === null) continue; // same-ID foreign-stream resume is identity evidence only
					if (
						priorEvent.fact.source.stream !== `pi-session:${digest(s.file)}` &&
						priorEvent.fact.source.stream !== `pi-session:${digest(s.original)}`
					)
						continue;
					const replay = parseAccountingInput({
						v: 1,
						...empty(),
						facts: [priorEvent.fact],
						aliases: priorEvent.alias ? [priorEvent.alias] : [],
						coverage: [],
						requiredStreams: ["pi-source-index:receipt"],
					});
					if (!replay.ok || replay.value.facts[0].identityStatus !== "verified") throw new Error("pi-source-index");
					out.rows.facts.push(replay.value.facts[0]);
					out.rows.aliases.push(...replay.value.aliases);
					if (
						priorEvent.fact.occurredAt >= this.options.current.from &&
						priorEvent.fact.occurredAt <= this.options.current.through
					)
						out.current.push(priorEvent.fact);
					else out.staged.push(priorEvent.fact);
					continue;
				}
				const copy = !!original;
				if (!original) {
					fact.identityStatus = "verified"; // parent absence has now been proved by its complete numeric index
					original = { fact, fingerprint: o.fingerprint, entryAt: o.entryAt, file: s.original };
					puts.push({ key: responseKey ?? ownKey, value: original });
				}
				puts.push({ key: `entry:${s.id}:${digest(JSON.stringify([o.entry, o.entryAt]))}`, value: original });
				// Same-session resumes reuse the exact immutable original, not rewritten source stamps.
				let alias: NativeEvent["alias"] = null;
				if (copy && fact.id !== original.fact.id) {
					fact.identityStatus = "verified";
					fact.links.session = original.fact.links.session;
					alias = {
						aliasFactId: fact.id,
						canonicalFactId: original.fact.id,
						provenance: "native-call-map/1",
						evidenceRef: `pi-source-map:${digest(JSON.stringify([s.id, o.entry, original.fact.id]))}`,
					};
				}
				const emitted = alias ? fact : original.fact;
				const ownStream =
					emitted.source.stream === `pi-session:${digest(s.file)}` ||
					emitted.source.stream === `pi-session:${digest(s.original)}`;
				puts.push({
					key: eventKey,
					value: {
						fingerprint: o.fingerprint,
						response: o.response,
						entryAt: o.entryAt,
						fact: ownStream ? emitted : null,
						alias,
					} satisfies NativeEvent,
				});
				// Same-ID resume in a different file retains canonical identity internally, but
				// cannot emit its foreign-stream fact under this file's collector descriptor.
				if (!ownStream) continue;
				out.rows.facts.push(emitted);
				if (alias) out.rows.aliases.push(alias);
				if (emitted.occurredAt >= this.options.current.from && emitted.occurredAt <= this.options.current.through)
					out.current.push(emitted);
				else out.staged.push(emitted);
			}
			s.reader = read.cursor;
			s.retainedFrom ??= from;
			s.readDone = read.endOfFile;
			// Native structural failures remain faults even if #304 reached an EOF later.
			if (
				read.faults.some(
					(f) =>
						![
							"window-mismatch",
							"read-limit",
							"batch-limit",
							"identity-unverified",
							"tokens-invalid",
							"model-unverified",
							"price-missing",
							"price-invalid",
						].includes(f.code),
				)
			)
				addGap(s, "source-unreadable");
			out.records = read.observations.length;
		}
		// lane is scheduling context only; it cannot rewrite occurrence/identity or promote old rows to today.
		void lane;
		out.gaps = [...s.gaps];
		out.batch = this.resolved(nativeReceipt, out.rows);
		puts.push({ key: `source:${s.id}`, value: s });
		await this.commit(puts, out.rows, nativeReceipt);
		return out;
	}
	/** Build one complete bounded dependency closure, never a filtered latest-state substitute.
	 * Oversized closures remain explicit #305 gaps; original indexed pages remain retained for continuation. */
	async membership(ids: readonly string[]): Promise<MembershipMap> {
		return this.unit(async () => {
			if (ids.length > PI_SOURCE_LIMITS.dependencies || ids.some((id) => !SHA.test(id)))
				throw new Error("pi-source-membership-request");
			const sources: MembershipSources = {
				sessions: [],
				registry: { status: "missing", bytesRead: 0, records: [] },
				conversations: { status: "missing", bytesRead: 0, records: [] },
				delegates: { status: "unsupported", bytesRead: 0, records: [] },
			};
			const queue = [...ids],
				seen = new Set<string>();
			const sessions: { file: string; status: "complete" | "partial"; bytesRead: number; records: unknown[] }[] = [];
			let bytes = 0,
				limited = false,
				conflict = false;
			while (queue.length) {
				const id = queue.shift()!;
				if (seen.has(id)) continue;
				if (seen.size === PI_SOURCE_LIMITS.dependencies) {
					limited = true;
					break;
				}
				seen.add(id);
				const s = await this.source(id);
				if (s.owner === "temper") continue;
				const page = await this.scan<Meta>(`meta:${id}:`, null, 256);
				const records = page.entries.map(({ value }) => value.record);
				const size = Buffer.byteLength(JSON.stringify(records));
				bytes += size;
				if (bytes > PI_SOURCE_LIMITS.pageBytes) {
					limited = true;
					break;
				}
				const status = !page.next && s.scanDone && !s.verifying && !s.dirty && !s.gaps.length ? "complete" : "partial";
				if (s.kind === "session") {
					sessions.push({ file: s.original, status, bytesRead: size, records });
					const files: string[] = s.header?.parentSession ? [s.header.parentSession] : [];
					for (const r of records) {
						const data = field(r, "data"),
							op = field(data, "op");
						if (op === "assigned") {
							const f = field(field(data, "from"), "file");
							if (ref(f)) files.push(f);
						}
						if (op === "chat") {
							const f = field(data, "file");
							if (ref(f)) files.push(f);
						}
					}
					for (const file of files) {
						const dep = await this.get<string>(`path:${digest(file)}`);
						if (dep) queue.push(dep);
					}
					if (s.header) {
						const copies = await this.scan<string>(`session:${digest(s.header.id)}:`, null, 64);
						for (const copy of copies.entries) queue.push(copy.value);
						if (copies.next) limited = true;
					}
				} else {
					const kind = s.kind === "registry" ? "registry" : s.kind === "conversation" ? "conversations" : "delegates";
					const prior = sources[kind];
					if (kind === "registry" && prior.status !== "missing") conflict = true;
					if (prior.records.length + records.length > 256) {
						limited = true;
						break;
					}
					sources[kind] = {
						status: prior.status === "partial" ? "partial" : status,
						bytesRead: prior.bytesRead + size,
						records: [...prior.records, ...records],
					};
					const files: string[] = [];
					for (const r of records)
						for (const key of s.kind === "registry"
							? ["queue"]
							: s.kind === "conversation"
								? ["sessionFile"]
								: ["file", "parentFile"]) {
							const file = field(r, key);
							if (ref(file)) files.push(file);
						}
					for (const file of files) {
						const dep = await this.get<string>(`path:${digest(file)}`);
						if (dep) queue.push(dep);
					}
				}
			}
			sources.sessions = sessions;
			const map = mapUsageMembership(sources, () => this.clock());
			if (limited) map.gaps.push({ code: "record-limit", file: null, task: null });
			if (conflict) map.gaps.push({ code: "conflicting-file", file: null, task: null });
			const puts = map.parentHistory.slice(0, 120).map((row) => ({
				key: `parent:${digest(JSON.stringify([row.queue, row.task, row.addedAt]))}:${row.effectiveAt}`,
				value: row,
			}));
			if (map.parentHistory.length > 120) map.gaps.push({ code: "record-limit", file: null, task: null });
			// Persist only a proved closure; never turn a partial map into canonical parent evidence.
			if (!map.gaps.length) await this.commit(puts, { ...empty(), memberships: map.parentHistory });
			return map;
		});
	}
}
