/**
 * roles-panel (owner, 2026-10-16): the work registry's initiatives and projects, read for the Roles page.
 *
 * pi-work-management (the pi-queue repo, work-store.ts) keeps them in an append-only log, `events.jsonl` in
 * the work folder (PI_WORK_DIR, or "work" in pi's agent folder), one change per line. This replays only what
 * the page shows: each initiative's and project's name, lead, status, its project's initiative, and how many
 * of its done-when items are marked met. The store checks every change before it writes it, so the log here
 * is replayed as written; a change this reader doesn't know, or one the store could never have written (an id
 * or lead that isn't a short id, a name over the store's limit), is skipped and said ("unknown-change"), never
 * guessed at. Task links and task states (the store's index) are left to the queues, which own them.
 *
 * It only reads: one open and stat per look, of a regular file only (never a FIFO, a device or a folder), and
 * the file again only when it changed, at most WORK_LOG_MAX bytes of it.
 */

import { open, type FileHandle } from "node:fs/promises";
import { readUpTo, STATE_READ_FLAGS } from "./state-file-read.js";
import type { UiWorkRecord, UiWorkRecords } from "./protocol.js";

/** A log bigger than this isn't read (the page says so and shows the rest). */
export const WORK_LOG_MAX = 32 << 20;
/** At most this many initiatives and projects are sent (initiatives first); more says "too-big". */
export const WORK_RECORDS_SEND_MAX = 500;
/** The store's own limits (pi-work-management work-store.ts: WORK_ID_MAX, WORK_NAME_MAX, isWorkId). */
const WORK_ID_MAX = 60;
const WORK_NAME_MAX = 80;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
/** The log is read in pieces of this size, so one that grows while it is read stops at the limit. */
const READ_CHUNK = 1 << 20;

type Status = UiWorkRecord["status"];
const STATUSES: readonly Status[] = ["active", "done", "dropped"];

interface Rec {
	kind: "initiative" | "project";
	id: string;
	name: string;
	lead: string;
	status: Status;
	initiative: string | null;
	doneWhen: string[];
	/** The met items, by their key (pi-work-management's itemKey: trimmed, lower case). */
	met: Set<string>;
}

/** pi-work-management's itemKey: two done-when items are the same when their texts match, ignoring case and outer spaces. */
const itemKey = (item: string) => item.trim().toLowerCase();

/** An old single-text done when reads as its one item (pi-work-management's doneList). */
function doneList(value: unknown): string[] | undefined {
	if (typeof value === "string") return [value];
	return Array.isArray(value) && value.every((x) => typeof x === "string") ? (value as string[]) : undefined;
}

const text = (x: unknown): x is string => typeof x === "string" && x.trim().length > 0;
/** pi-work-management's isWorkId: ids and leads are short ids ("owner" is one too). */
const workId = (x: unknown): x is string => typeof x === "string" && x.length <= WORK_ID_MAX && SLUG.test(x);
/** A name as the store takes it: not empty, on one line, at most WORK_NAME_MAX characters. */
const workName = (x: unknown): x is string => text(x) && x.length <= WORK_NAME_MAX && !/[\r\n]/.test(x);
/** A project's initiative: none (null, or nothing given), a short id, or undefined when it is neither. */
function initiativeOf(x: unknown): string | null | undefined {
	if (x === null || x === undefined || x === "") return null;
	return workId(x) ? x : undefined;
}

/** pi-work-management's marksFor: the marks that still hold for this list (an item reworded loses its mark). */
function keepMarks(doneWhen: string[], met: Set<string>): Set<string> {
	return new Set(doneWhen.map(itemKey).filter((k) => met.has(k)));
}

// stall-wake (Ops #284): waits/resumes are known but change none of the Roles page's fields. The work page
// (work-page.ts) keeps and displays the wait; this reader must not call those valid changes unknown.
const KNOWN_SKIPPED = new Set([
	"task.link",
	"task.state",
	"project.wait",
	"project.resume",
	"initiative.wait",
	"initiative.resume",
]);

/** The log's text -> the records the page shows. A half-written last line is left out. */
export function workRecordsFrom(log: string): UiWorkRecords {
	const recs = new Map<string, Rec>();
	let unknown = false;
	const lines = log.split("\n");
	lines.pop();
	for (const line of lines) {
		if (!line.trim()) continue;
		let e: Record<string, unknown>;
		try {
			const parsed: unknown = JSON.parse(line);
			if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
			e = parsed as Record<string, unknown>;
		} catch {
			// The store refuses to work with a log it can't read: so does the page.
			return { initiatives: [], projects: [], problem: "unreadable" };
		}
		if (e.v !== 1 || typeof e.op !== "string") {
			unknown = true;
			continue;
		}
		if (KNOWN_SKIPPED.has(e.op)) continue;
		const [kind, act] = e.op.split(".") as [string, string | undefined];
		if ((kind !== "initiative" && kind !== "project") || !workId(e.id)) {
			unknown = true;
			continue;
		}
		const key = `${kind}\u0000${e.id}`;
		const cur = recs.get(key);
		if (act === "create") {
			const doneWhen = doneList(e.doneWhen);
			const initiative = kind === "project" ? initiativeOf(e.initiative) : null;
			if (cur || !workName(e.name) || !workId(e.lead) || !doneWhen || initiative === undefined) {
				unknown = true;
				continue;
			}
			recs.set(key, {
				kind,
				id: e.id,
				name: e.name,
				lead: e.lead,
				status: "active",
				initiative,
				doneWhen: [...doneWhen],
				met: new Set(),
			});
			continue;
		}
		if (!cur) {
			unknown = true;
			continue;
		}
		if (act === "change") {
			const ch = e.changes && typeof e.changes === "object" ? (e.changes as Record<string, unknown>) : {};
			// A field the store couldn't have written is left as it was, and said.
			if (ch.name !== undefined) {
				if (workName(ch.name)) cur.name = ch.name;
				else unknown = true;
			}
			if (ch.lead !== undefined) {
				if (workId(ch.lead)) cur.lead = ch.lead;
				else unknown = true;
			}
			if (ch.status !== undefined) {
				if (STATUSES.includes(ch.status as Status)) cur.status = ch.status as Status;
				else unknown = true;
			}
			if (kind === "project" && ch.initiative !== undefined) {
				const initiative = initiativeOf(ch.initiative);
				if (initiative === undefined) unknown = true;
				else cur.initiative = initiative;
			}
			const doneWhen = ch.doneWhen === undefined ? undefined : doneList(ch.doneWhen);
			if (doneWhen) {
				cur.doneWhen = [...doneWhen];
				cur.met = keepMarks(cur.doneWhen, cur.met);
			}
			continue;
		}
		if ((act === "met" || act === "unmet") && typeof e.item === "string") {
			const k = itemKey(e.item);
			if (!cur.doneWhen.some((item) => itemKey(item) === k)) {
				unknown = true;
				continue;
			}
			if (act === "met") cur.met.add(k);
			else cur.met.delete(k);
			continue;
		}
		unknown = true;
	}
	const out = (r: Rec): UiWorkRecord => ({
		id: r.id,
		name: r.name,
		lead: r.lead,
		status: r.status,
		...(r.kind === "project" ? { initiative: r.initiative } : {}),
		items: r.doneWhen.length,
		met: r.met.size,
	});
	const all = [...recs.values()];
	const initiatives = all.filter((r) => r.kind === "initiative");
	const projects = all.filter((r) => r.kind === "project");
	// A bloated log never enlarges every Roles look past this many records.
	const tooMany = initiatives.length + projects.length > WORK_RECORDS_SEND_MAX;
	const sentInitiatives = initiatives.slice(0, WORK_RECORDS_SEND_MAX);
	const sentProjects = projects.slice(0, WORK_RECORDS_SEND_MAX - sentInitiatives.length);
	const problem = tooMany ? ("too-big" as const) : unknown ? ("unknown-change" as const) : undefined;
	return {
		initiatives: sentInitiatives.map(out),
		projects: sentProjects.map(out),
		...(problem ? { problem } : {}),
	};
}

const NONE: UiWorkRecords = { initiatives: [], projects: [] };
const unreadable = (): UiWorkRecords => ({ initiatives: [], projects: [], problem: "unreadable" });
const tooBig = (): UiWorkRecords => ({ initiatives: [], projects: [], problem: "too-big" });

/** The registry's records, read again only when its log changed. */
export class WorkRecordsFile {
	private seen: { mtimeMs: number; size: number; value: UiWorkRecords } | null = null;

	constructor(private readonly path: () => string) {}

	async get(): Promise<UiWorkRecords> {
		const p = this.path();
		let fh: FileHandle;
		try {
			// Non-blocking, so a FIFO in the log's place can't stall the Roles look: it is refused below.
			fh = await open(p, STATE_READ_FLAGS);
		} catch (err) {
			this.seen = null;
			// No log yet: nothing was ever recorded.
			if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return { ...NONE };
			return unreadable();
		}
		try {
			const st = await fh.stat();
			// Only a regular file: never a FIFO, a device or a folder (a link is followed to what it names).
			if (!st.isFile()) {
				this.seen = null;
				return unreadable();
			}
			if (st.size > WORK_LOG_MAX) {
				this.seen = null;
				return tooBig();
			}
			if (this.seen && this.seen.mtimeMs === st.mtimeMs && this.seen.size === st.size) return this.seen.value;
			const bytes = await readUpTo(fh, WORK_LOG_MAX, READ_CHUNK);
			// It grew past the limit while being read.
			if (bytes === null) {
				this.seen = null;
				return tooBig();
			}
			const value = workRecordsFrom(bytes.toString("utf8"));
			this.seen = { mtimeMs: st.mtimeMs, size: st.size, value };
			return value;
		} catch {
			this.seen = null;
			return unreadable();
		} finally {
			await fh.close().catch(() => undefined);
		}
	}
}
