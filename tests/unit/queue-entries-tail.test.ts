/**
 * queue-entries-tail (Ops #635, H-INCREMENTAL-QUEUE-READS-1): queueEntriesOf reads only the bytes a chat file got since
 * the last read, and its answer is always the one a whole-file parse gives (the parse below is the code queueEntriesOf
 * ran before #635, over readFileSync(file).split("\n"), which is what its streamed reader saw).
 */

import {
	appendFileSync,
	closeSync,
	copyFileSync,
	existsSync,
	mkdtempSync,
	openSync,
	readFileSync,
	readSync,
	renameSync,
	rmSync,
	statSync,
	truncateSync,
	writeFileSync,
	writeSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HANG_GUARD_MS } from "./load-independent.js";
import {
	forgetAllQueueEntries,
	QUEUE_ENTRIES_IDLE_MS,
	queueEntriesKept,
	queueEntriesReadStats,
	readQueueEntries,
	setQueueEntriesChunkBytes,
} from "../../server/queue-entries-tail.js";
import { ownTaskOf, queueEntriesOf } from "../../server/role-messages.js";
import { type TaskQueueEntryLike, taskQueueAll, taskQueueFromEntries } from "../../server/task-queue.js";

/** queueEntriesOf before #635, over the whole file: the oracle. */
function fullParse(file: string, withHeader = false): TaskQueueEntryLike[] {
	const out: TaskQueueEntryLike[] = [];
	const needle = '"queue"';
	let header = withHeader;
	for (const line of readFileSync(file, "utf8").split("\n")) {
		if (header && line.trim()) {
			let h: { type?: unknown; id?: unknown } | undefined;
			try {
				h = JSON.parse(line) as typeof h;
			} catch {
				h = undefined;
			}
			if (h) {
				header = false;
				if (h.type === "session" && typeof h.id === "string") {
					out.push({ type: "session", id: h.id });
					continue;
				}
			}
		}
		if (!line.includes(needle)) continue;
		try {
			const e = JSON.parse(line) as TaskQueueEntryLike;
			if (e?.type === "custom" && e.customType === "queue") out.push(e);
		} catch {
			// half-written
		}
	}
	return out;
}

const q = (op: Record<string, unknown>) =>
	JSON.stringify({ type: "custom", customType: "queue", data: { v: 1, ...op } });
const header = (id: string) => JSON.stringify({ type: "session", version: 3, id, timestamp: "t", cwd: "/" });
const user = (text: string) => JSON.stringify({ type: "message", message: { role: "user", content: text } });

async function same(file: string): Promise<void> {
	expect(await readQueueEntries(file, true)).toEqual(fullParse(file, true));
	expect(await readQueueEntries(file, false)).toEqual(fullParse(file, false));
}

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "queue-entries-tail-"));
	forgetAllQueueEntries();
	setQueueEntriesChunkBytes();
});
afterEach(() => {
	forgetAllQueueEntries();
	setQueueEntriesChunkBytes();
	rmSync(dir, { recursive: true, force: true });
});

describe("queue-entries-tail", () => {
	it("an appended file: only the new bytes are read, and the answer equals a full parse", async () => {
		const f = join(dir, "a.jsonl");
		writeFileSync(f, `${[header("s1"), q({ op: "run", queueId: "s1", ts: 1 }), user("hi")].join("\n")}\n`);
		await same(f);
		const before = { ...queueEntriesReadStats };
		const add = `${[q({ op: "add", id: 1, plan: { title: "t" }, ts: 2 }), user('"queue" in text'), q({ op: "pause", reason: "user" })].join("\n")}\n`;
		appendFileSync(f, add);
		await same(f);
		// Two reads (with and without the header) share one kept state: the appended bytes are read once.
		expect(queueEntriesReadStats.bytes - before.bytes).toBe(Buffer.byteLength(add));
		expect(queueEntriesReadStats.starts).toBe(before.starts);
		expect(queueEntriesKept()).toBe(1);
		// Nothing new: nothing read.
		const mid = queueEntriesReadStats.bytes;
		await same(f);
		expect(queueEntriesReadStats.bytes).toBe(mid);
	});

	it("a file replaced by another (new inode, atomic rewrite) is read again from the start", async () => {
		const f = join(dir, "b.jsonl");
		writeFileSync(f, `${[header("s1"), q({ op: "run", queueId: "s1" })].join("\n")}\n`);
		await same(f);
		const tmp = join(dir, "b.tmp");
		writeFileSync(
			tmp,
			`${[header("s2"), q({ op: "add", id: 7 }), q({ op: "run", queueId: "s2" }), user("x")].join("\n")}\n`,
		);
		renameSync(tmp, f);
		const starts = queueEntriesReadStats.starts;
		await same(f);
		expect(queueEntriesReadStats.starts).toBe(starts + 1);
		expect((await readQueueEntries(f, true))[0]).toEqual({ type: "session", id: "s2" });
	});

	it("a truncated file, and one rewritten in place at the same length or longer, are read again", async () => {
		const f = join(dir, "c.jsonl");
		// Over 8 KB, so the 4 KB head and tail windows don't overlap.
		const pad = user("x".repeat(10_000));
		writeFileSync(
			f,
			`${[header("s1"), pad, q({ op: "add", id: 1 }), q({ op: "add", id: 2 }), q({ op: "add", id: 3 })].join("\n")}\n`,
		);
		await same(f);
		truncateSync(f, statSync(f).size - 20);
		let starts = queueEntriesReadStats.starts;
		await same(f);
		expect(queueEntriesReadStats.starts).toBe(starts + 1);
		// Same inode, first bytes changed, file longer: the head window catches it.
		const fd = openSync(f, "r+");
		writeSync(fd, header("s9"), 0);
		closeSync(fd);
		appendFileSync(f, `\n${q({ op: "add", id: 4 })}\n`);
		starts = queueEntriesReadStats.starts;
		await same(f);
		expect(queueEntriesReadStats.starts).toBe(starts + 1);
		// Same inode, the bytes just before where the last read stopped changed: the tail window catches it.
		const size = statSync(f).size;
		const fd2 = openSync(f, "r+");
		writeSync(fd2, q({ op: "add", id: 5 }).slice(0, 10), size - 30);
		closeSync(fd2);
		appendFileSync(f, `${q({ op: "add", id: 6 })}\n`);
		starts = queueEntriesReadStats.starts;
		await same(f);
		expect(queueEntriesReadStats.starts).toBe(starts + 1);
	});

	it("a partial last line: a half-written entry is skipped, a complete one without its newline counts, as before", async () => {
		const f = join(dir, "d.jsonl");
		const add = q({ op: "add", id: 1, plan: { title: "naïve — ünïcode ✓" } });
		writeFileSync(f, `${header("s1")}\n${add.slice(0, 25)}`);
		await same(f);
		expect(await readQueueEntries(f)).toEqual([]);
		appendFileSync(f, add.slice(25));
		await same(f);
		expect((await readQueueEntries(f)).length).toBe(1);
		appendFileSync(f, `\n${q({ op: "run" })}`);
		await same(f);
		appendFileSync(f, "\n");
		await same(f);
		expect((await readQueueEntries(f)).length).toBe(2);
	});

	it("lines and multi-byte characters split across reads give the same answer", async () => {
		setQueueEntriesChunkBytes(7);
		const f = join(dir, "e.jsonl");
		const lines = [
			header("s1"),
			q({ op: "add", id: 1, plan: { title: "日本語 ✓ émoji 🎉" } }),
			user("ü"),
			q({ op: "run", queueId: "s1" }),
		];
		writeFileSync(f, `${lines.join("\n")}\n`);
		await same(f);
		appendFileSync(f, `${q({ op: "add", id: 2, plan: { title: "🎉🎉" } })}\n`);
		await same(f);
	});

	it("a header that comes later: blank or half-written first lines keep it pending, as the SDK's rule", async () => {
		const f = join(dir, "h.jsonl");
		writeFileSync(f, "");
		await same(f);
		appendFileSync(f, "\n\n");
		await same(f);
		const h = header("late-1");
		appendFileSync(f, h.slice(0, 12));
		await same(f);
		expect(await readQueueEntries(f, true)).toEqual([]);
		appendFileSync(f, h.slice(12));
		await same(f);
		expect(await readQueueEntries(f, true)).toEqual([{ type: "session", id: "late-1" }]);
		appendFileSync(f, `\n${q({ op: "run", queueId: "late-1" })}\n`);
		await same(f);
		// A first line that parses to a falsy value ("null") keeps looking, as before.
		const g = join(dir, "g.jsonl");
		writeFileSync(g, "null\n");
		await same(g);
		appendFileSync(g, `${header("after-null")}\n${q({ op: "run" })}\n`);
		await same(g);
		expect((await readQueueEntries(g, true))[0]).toEqual({ type: "session", id: "after-null" });
		// A first line that parses but isn't a session: no header, ever.
		const k = join(dir, "k.jsonl");
		writeFileSync(k, `${q({ op: "run" })}\n`);
		await same(k);
		appendFileSync(k, `${header("too-late")}\n`);
		await same(k);
		expect((await readQueueEntries(k, true)).some((e) => e.type === "session")).toBe(false);
	});

	it("a missing file has no entries and keeps nothing; reads at once of a growing file each equal a full parse of it at some point", async () => {
		const f = join(dir, "missing.jsonl");
		expect(await readQueueEntries(f, true)).toEqual([]);
		expect(queueEntriesKept()).toBe(0);
		const g = join(dir, "grow.jsonl");
		writeFileSync(g, `${header("s1")}\n`);
		setQueueEntriesChunkBytes(64);
		const snapshots = new Set<string>();
		const reads: Promise<TaskQueueEntryLike[]>[] = [];
		for (let i = 1; i <= 20; i++) {
			appendFileSync(g, `${q({ op: "add", id: i })}\n`);
			snapshots.add(JSON.stringify(fullParse(g, true)));
			reads.push(readQueueEntries(g, i % 2 === 0));
			if (i % 5 === 0) await reads[reads.length - 1];
		}
		const got = await Promise.all(reads);
		for (const [i, r] of got.entries()) {
			const withHeader = (i + 1) % 2 === 0;
			const full = withHeader ? r : [{ type: "session", id: "s1" }, ...r];
			expect(snapshots.has(JSON.stringify(full))).toBe(true);
		}
		expect(got[got.length - 1]).toEqual(fullParse(g, true));
	});

	it("an entry unused for 30 min goes", async () => {
		const f = join(dir, "i.jsonl");
		writeFileSync(f, `${header("s1")}\n${q({ op: "run" })}\n`);
		await readQueueEntries(f, true, 1_000);
		expect(queueEntriesKept()).toBe(1);
		await readQueueEntries(join(dir, "other.jsonl"), true, 1_000 + QUEUE_ENTRIES_IDLE_MS);
		expect(queueEntriesKept()).toBe(0);
	});

	it("queueEntriesOf reads through it", async () => {
		const f = join(dir, "j.jsonl");
		writeFileSync(f, `${header("s1")}\n${q({ op: "run", queueId: "s1" })}\n`);
		expect(await queueEntriesOf(f, true)).toEqual(fullParse(f, true));
		expect(queueEntriesKept()).toBe(1);
		appendFileSync(f, `${q({ op: "add", id: 3 })}\n`);
		expect(await queueEntriesOf(f)).toEqual(fullParse(f));
	});
});

// ---------------------------------------------------------------------------
// Real transcripts (copies only), grown in random steps
// ---------------------------------------------------------------------------

/**
 * The real home only when the run has one: the sealed gate (scripts/sealed.sh) gives every step a temp HOME, so
 * homedir() finds no identities there and the real-transcript tests below skip. They are for a run outside the gate
 * (`npx vitest run tests/unit/queue-entries-tail.test.ts`), which reads copies of real chats, never the chats.
 */
const home = homedir();
function realQueueChats(): string[] {
	const ids = join(home, ".pi", "agent", "memory", "identities");
	const out: string[] = [];
	try {
		for (const id of ["ops", "temper", "design", "qa", "product", "rollcall"]) {
			const p = join(ids, id, "identity.json");
			if (!existsSync(p)) continue;
			const chat = (JSON.parse(readFileSync(p, "utf8")) as { homeChat?: string }).homeChat;
			if (chat && existsSync(chat)) out.push(chat);
		}
	} catch {
		// none
	}
	return out;
}
const REAL = realQueueChats();
const PREFIX = 24 * 1024 * 1024;

/** A copy of the file's first `max` bytes (a chat's start: its header and its first queue entries). */
function prefixOf(src: string, max: number): Buffer {
	const fd = openSync(src, "r");
	try {
		const buf = Buffer.allocUnsafe(Math.min(max, statSync(src).size));
		let got = 0;
		while (got < buf.length) {
			const n = readSync(fd, buf, got, buf.length - got, got);
			if (!n) break;
			got += n;
		}
		return buf.subarray(0, got);
	} finally {
		closeSync(fd);
	}
}

describe.runIf(REAL.length > 0)("queue-entries-tail on real transcripts (copies)", () => {
	it(
		"grown in random steps (mid-line, mid-character), every read equals a full parse; reads only the new bytes",
		async () => {
			let seed = 635;
			const rand = () => {
				seed = (seed * 1103515245 + 12345) % 2 ** 31;
				return seed / 2 ** 31;
			};
			let found = 0;
			for (const src of REAL) {
				const bytes = prefixOf(src, PREFIX);
				const f = join(dir, "real.jsonl");
				writeFileSync(f, "");
				forgetAllQueueEntries();
				const cuts = Array.from({ length: 6 }, () => Math.floor(rand() * bytes.length)).sort((a, b) => a - b);
				cuts.push(bytes.length);
				let at = 0;
				const start = { ...queueEntriesReadStats };
				for (const cut of cuts) {
					appendFileSync(f, bytes.subarray(at, cut));
					at = cut;
					await same(f);
				}
				// Every byte once, plus each step's unfinished last line again (it's never kept); a whole-file read per
				// call would have been about 7 times the file here.
				const read = queueEntriesReadStats.bytes - start.bytes;
				expect(read).toBeGreaterThanOrEqual(bytes.length);
				expect(read).toBeLessThan(bytes.length * 1.5);
				expect(queueEntriesReadStats.starts - start.starts).toBe(1);
				found += (await readQueueEntries(f)).length;
			}
			// Some chats' first 24 MB hold no queue entry; together they hold plenty.
			expect(found).toBeGreaterThan(0);
		},
		HANG_GUARD_MS,
	); // Ops #639: a hang guard, not 120 s of a busy machine

	it(
		"callers never change the entries it keeps (deep-frozen, every reader gives the same answer)",
		async () => {
			const deepFreeze = (x: unknown): void => {
				if (x && typeof x === "object" && !Object.isFrozen(x)) {
					Object.freeze(x);
					for (const v of Object.values(x)) deepFreeze(v);
				}
			};
			const run = (entries: TaskQueueEntryLike[]) =>
				JSON.stringify([
					taskQueueAll(entries),
					taskQueueFromEntries(entries, true, Number.POSITIVE_INFINITY),
					taskQueueFromEntries(entries, true, 50),
					ownTaskOf(entries),
				]);
			const check = async () => {
				for (const src of REAL) {
					const f = join(dir, "frozen.jsonl");
					copyFileSync(src, f);
					forgetAllQueueEntries();
					const plain = run(fullParse(f, true));
					const kept = await readQueueEntries(f, true);
					for (const e of kept) deepFreeze(e);
					expect(run(kept)).toBe(plain);
				}
			};
			// With this repo's mirror (apply), then with pi-queue's own replay, as in the server once a chat loaded it.
			await check();
			const readers = join(process.env.PI_QUEUE_PKG ?? join(home, "projects", "pi-queue"), "readers.ts");
			if (existsSync(readers)) {
				await import(/* @vite-ignore */ pathToFileURL(readers).href);
				await check();
			}
		},
		HANG_GUARD_MS,
	); // Ops #639: a hang guard, its whole limit
});
