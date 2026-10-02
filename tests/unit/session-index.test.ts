/**
 * session-index: the server's saved chat index gives exactly the rows pi's SessionManager.listAll /
 * SessionManager.list give (allMessagesText aside), reads only what changed, shares one walk between
 * windows asking at once, survives a restart without reading any file in full, rebuilds a broken saved
 * file, and never blocks the event loop on a big transcript.
 */
import {
	appendFileSync,
	mkdirSync,
	openSync,
	closeSync,
	writeSync,
	renameSync,
	rmSync,
	writeFileSync,
	readFileSync,
	statSync,
} from "node:fs";
import { join } from "node:path";
import { getAgentDir, SessionManager, type SessionInfo } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defaultSessionDirPath, SessionIndex } from "../../server/session-index.js";
import { IDENTITY_ENTRY_TYPE, IdentityFileIndex, identityIdOfEntry } from "../../server/identities.js";

const T0 = Date.parse("2026-09-01T10:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();

let n = 0;
const uid = () => `e${(++n).toString(36)}`;

function header(id: string, cwd: string, ts: number, parentSession?: string): string {
	return JSON.stringify({
		type: "session",
		version: 3,
		id,
		timestamp: iso(ts),
		cwd,
		...(parentSession ? { parentSession } : {}),
	});
}

function message(
	role: "user" | "assistant" | "toolResult",
	content: unknown,
	ts: number,
	parentId: string | null = null,
	withMsgTs = true,
): string {
	return JSON.stringify({
		type: "message",
		id: uid(),
		parentId,
		timestamp: iso(ts),
		message: { role, content, ...(withMsgTs ? { timestamp: ts } : {}) },
	});
}

const sessionInfo = (name: string, ts: number) =>
	JSON.stringify({ type: "session_info", id: uid(), parentId: null, timestamp: iso(ts), name });

const identity = (id: string | null, ts: number) =>
	JSON.stringify({
		type: "custom",
		id: uid(),
		parentId: null,
		timestamp: iso(ts),
		customType: IDENTITY_ENTRY_TYPE,
		data: { id, via: "test" },
	});

const lines = (...ls: string[]) => `${ls.join("\n")}\n`;

/** Every field the list uses (allMessagesText is the one the index leaves out). */
function norm(rows: SessionInfo[]) {
	return rows.map((r) => ({
		path: r.path,
		id: r.id,
		cwd: r.cwd,
		name: r.name,
		parentSessionPath: r.parentSessionPath,
		created: r.created.getTime(),
		modified: r.modified.getTime(),
		messageCount: r.messageCount,
		firstMessage: r.firstMessage,
	}));
}

const CWD_A = "/work/alpha";
const CWD_B = "/work/beta";
let dirA: string;
let dirB: string;
let custom: string;
let saveFile: string;

function newIndex(opts: { workers?: number; file?: string | null } = {}) {
	return new SessionIndex({
		workers: opts.workers ?? 2,
		file: opts.file === null ? undefined : (opts.file ?? saveFile),
		identity: { customType: IDENTITY_ENTRY_TYPE, idOf: (e) => identityIdOfEntry(e) },
	});
}

/** The index's rows equal pi's for every way the server lists. */
async function expectSameAsPi(idx: SessionIndex): Promise<number> {
	const piAll = await SessionManager.listAll();
	expect(norm(await idx.listAll())).toEqual(norm(piAll));
	expect(norm(await idx.listProject(CWD_A))).toEqual(norm(await SessionManager.list(CWD_A)));
	expect(norm(await idx.listProject(CWD_B))).toEqual(norm(await SessionManager.list(CWD_B)));
	expect(norm(await idx.listAll(custom))).toEqual(norm(await SessionManager.listAll(custom)));
	expect(norm(await idx.listProject(CWD_A, custom))).toEqual(norm(await SessionManager.list(CWD_A, custom)));
	return piAll.length;
}

/** A varied set of chats: branches, names set later and cleared, forks, odd lines, broken files. */
function writeChats() {
	mkdirSync(dirA, { recursive: true });
	mkdirSync(dirB, { recursive: true });
	mkdirSync(custom, { recursive: true });
	let t = T0;
	const step = () => (t += 60_000);

	// Plain chat with two branches off the first reply.
	const u1 = uid();
	writeFileSync(
		join(dirA, "2026-09-01T10-00-00-000Z_aaaa.jsonl"),
		lines(
			header("aaaa", CWD_A, step()),
			JSON.stringify({
				type: "model_change",
				id: u1,
				parentId: null,
				timestamp: iso(step()),
				provider: "x",
				modelId: "y",
			}),
			message("user", "first question about branches", step(), u1),
			message(
				"assistant",
				[
					{ type: "text", text: "an answer" },
					{ type: "thinking", thinking: "hmm" },
				],
				step(),
			),
			message(
				"user",
				[
					{ type: "text", text: "branch one" },
					{ type: "image", data: "AAAA", mimeType: "image/png" },
				],
				step(),
			),
			message("user", "branch two", step()),
			message("toolResult", [{ type: "text", text: "tool output" }], step()),
		),
	);
	// Named later, renamed, then the name cleared (pi: name undefined).
	writeFileSync(
		join(dirA, "2026-09-01T11-00-00-000Z_bbbb.jsonl"),
		lines(
			header("bbbb", CWD_A, step()),
			message("assistant", "assistant speaks first", step()),
			message("user", "   ", step()),
			message("user", "the real first message", step()),
			sessionInfo("A name", step()),
			sessionInfo("  Better name  ", step()),
		),
	);
	writeFileSync(
		join(dirA, "2026-09-01T11-30-00-000Z_bbcc.jsonl"),
		lines(
			header("bbcc", CWD_A, step()),
			message("user", "named then cleared", step()),
			sessionInfo("Gone", step()),
			sessionInfo("  ", step()),
		),
	);
	// A fork of the first chat, messages without their own timestamp (entry timestamp is used).
	writeFileSync(
		join(dirB, "2026-09-01T12-00-00-000Z_cccc.jsonl"),
		lines(
			header("cccc", CWD_B, step(), join(dirA, "2026-09-01T10-00-00-000Z_aaaa.jsonl")),
			message("user", "forked question", step(), null, false),
			message("assistant", "forked answer", step(), null, false),
		),
	);
	// Header only (no messages): modified = header time, "(no messages)".
	writeFileSync(join(dirB, "2026-09-01T12-30-00-000Z_dddd.jsonl"), lines(header("dddd", CWD_B, step())));
	// Two chats with the same times (ties keep pi's order).
	const tie = step();
	writeFileSync(join(dirB, "2026-09-01T13-00-00-000Z_ee01.jsonl"), lines(header("ee01", CWD_B, tie)));
	writeFileSync(join(dirB, "2026-09-01T13-00-00-000Z_ee02.jsonl"), lines(header("ee02", CWD_B, tie)));
	// Broken JSON in the middle, a blank line, CRLF line ends, and no newline at the end.
	writeFileSync(
		join(dirB, "2026-09-01T14-00-00-000Z_ffff.jsonl"),
		`${header("ffff", CWD_B, step())}\r\n{not json\r\n\r\n${message("user", "after the broken line", step())}\r\n${message("assistant", "last, unfinished", step())}`,
	);
	// Not a session file: first line isn't a header (pi leaves it out).
	writeFileSync(
		join(dirB, "2026-09-01T15-00-00-000Z_gggg.jsonl"),
		lines(message("user", "orphan", step()), header("gggg", CWD_B, step())),
	);
	// Malformed content throws in pi's builder: the whole chat is left out.
	writeFileSync(
		join(dirB, "2026-09-01T15-30-00-000Z_hhhh.jsonl"),
		lines(header("hhhh", CWD_B, step()), message("user", "fine", step()), message("assistant", 42, step())),
	);
	// Empty file and a non-transcript next to them.
	writeFileSync(join(dirB, "2026-09-01T16-00-00-000Z_iiii.jsonl"), "");
	writeFileSync(join(dirB, "notes.txt"), "not a chat");
	// Identity entries (followed for History's labels).
	writeFileSync(
		join(dirA, "2026-09-01T16-30-00-000Z_jjjj.jsonl"),
		lines(header("jjjj", CWD_A, step()), identity("ops", step()), message("user", "with a role", step())),
	);
	// The custom folder holds chats of both projects (list(cwd, custom) filters by cwd).
	writeFileSync(
		join(custom, "2026-09-01T17-00-00-000Z_kkkk.jsonl"),
		lines(header("kkkk", CWD_A, step()), message("user", "custom a", step())),
	);
	writeFileSync(
		join(custom, "2026-09-01T17-30-00-000Z_llll.jsonl"),
		lines(header("llll", CWD_B, step()), message("user", "custom b", step())),
	);
	return t;
}

beforeEach(() => {
	const sessions = join(getAgentDir(), "sessions");
	rmSync(sessions, { recursive: true, force: true });
	dirA = defaultSessionDirPath(CWD_A);
	dirB = defaultSessionDirPath(CWD_B);
	custom = join(getAgentDir(), "custom-sessions");
	rmSync(custom, { recursive: true, force: true });
	saveFile = join(getAgentDir(), "web", `session-index-${n}.json`);
});

afterEach(() => {
	rmSync(join(getAgentDir(), "web"), { recursive: true, force: true });
});

describe("session-index: same rows as pi", () => {
	it("matches listAll / list on a varied set of chats (in workers and in-process)", async () => {
		writeChats();
		const count = await expectSameAsPi(newIndex());
		// 12 transcripts under sessions/: the header-less, the malformed and the empty one are left out.
		expect(count).toBe(9);
		await expectSameAsPi(newIndex({ workers: 0 }));
	}, 30_000);

	it("reads a file that grew only from where it stopped, also when its last line was unfinished", async () => {
		let t = writeChats();
		const idx = newIndex();
		await expectSameAsPi(idx);
		const full0 = idx.stats.fullReads;
		const part0 = idx.stats.partialReads;

		// A chat gets new messages and a name.
		const grown = join(dirA, "2026-09-01T10-00-00-000Z_aaaa.jsonl");
		appendFileSync(
			grown,
			lines(message("user", "a later message", (t += 60_000)), sessionInfo("Named late", (t += 60_000))),
		);
		// The unfinished last line is finished, and more follows.
		const unfinished = join(dirB, "2026-09-01T14-00-00-000Z_ffff.jsonl");
		appendFileSync(unfinished, `\n${message("user", "after the finished line", (t += 60_000))}\n`);
		// A line written in two parts: the listing in between shows what pi would show.
		const halves = message("assistant", "written in two parts", (t += 60_000));
		appendFileSync(grown, halves.slice(0, 20));
		await expectSameAsPi(idx);
		appendFileSync(grown, `${halves.slice(20)}\n`);
		await expectSameAsPi(idx);

		expect(idx.stats.fullReads).toBe(full0);
		expect(idx.stats.partialReads).toBeGreaterThan(part0);
	}, 30_000);

	it("reads a shrunk, replaced or rewritten file again from the start, and drops a removed one", async () => {
		let t = writeChats();
		const idx = newIndex();
		await expectSameAsPi(idx);

		// Repair: rewritten shorter, in place.
		const shrunk = join(dirA, "2026-09-01T10-00-00-000Z_aaaa.jsonl");
		writeFileSync(shrunk, lines(header("aaaa", CWD_A, T0 + 60_000), message("user", "repaired", (t += 60_000))));
		// Replaced by rename (new inode), longer than before.
		const replaced = join(dirA, "2026-09-01T11-00-00-000Z_bbbb.jsonl");
		const old = readFileSync(replaced, "utf8");
		writeFileSync(
			`${replaced}.tmp`,
			old.replace("the real first message", "swapped first message") + lines(message("user", "more", (t += 60_000))),
		);
		renameSync(`${replaced}.tmp`, replaced);
		// Rewritten in place, same inode, grown, with the earlier bytes changed (fingerprint).
		const rewritten = join(dirB, "2026-09-01T12-00-00-000Z_cccc.jsonl");
		const ino = statSync(rewritten).ino;
		const before = readFileSync(rewritten, "utf8");
		const fd = openSync(rewritten, "r+");
		writeSync(
			fd,
			`${before.replace("forked question", "FORKED QUESTION")}${lines(message("user", "and more", (t += 60_000)))}`,
			0,
		);
		closeSync(fd);
		expect(statSync(rewritten).ino).toBe(ino);
		// Removed.
		rmSync(join(dirB, "2026-09-01T12-30-00-000Z_dddd.jsonl"));
		// Removed folder.
		rmSync(custom, { recursive: true, force: true });

		const full0 = idx.stats.fullReads;
		await expectSameAsPi(idx);
		expect(idx.stats.fullReads - full0).toBe(3);
		expect((await idx.listAll()).some((r) => r.id === "dddd")).toBe(false);
	}, 30_000);
});

describe("session-index: one read for every window", () => {
	it("windows asking at the same time share one walk; a later ask after invalidate() walks again", async () => {
		writeChats();
		const idx = newIndex();
		const [a, b, c] = await Promise.all([idx.listAll(), idx.listAll(), idx.listAll()]);
		expect(idx.stats.refreshes).toBe(1);
		expect(idx.stats.joined).toBe(2);
		expect(norm(a)).toEqual(norm(b));
		expect(norm(b)).toEqual(norm(c));
		// Each file was read once.
		expect(idx.stats.fullReads).toBe(12);

		const running = idx.listAll();
		idx.invalidate();
		const after = idx.listAll();
		await Promise.all([running, after]);
		expect(idx.stats.refreshes).toBe(3);
	}, 30_000);

	it("a restart with nothing changed reads no chat file", async () => {
		writeChats();
		const first = newIndex();
		const rows = await first.listAll();
		await first.listProject(CWD_A);
		await first.flush();

		const second = newIndex();
		expect(norm(await second.listAll())).toEqual(norm(rows));
		await expectSameAsPi(second);
		expect(second.stats.loadedFromDisk).toBe(12);
		expect(second.stats.fullReads).toBe(2); // the custom folder's two chats were never listed before
		expect(second.stats.partialReads).toBe(0);

		await second.flush();
		const third = newIndex();
		await expectSameAsPi(third);
		expect(third.stats.fullReads).toBe(0);
		expect(third.stats.partialReads).toBe(0);
		expect(third.stats.bytesRead).toBe(0);
	}, 30_000);

	it("a broken or old-version saved file is rebuilt", async () => {
		writeChats();
		const first = newIndex();
		await first.listAll();
		await first.flush();
		const good = readFileSync(saveFile, "utf8");

		for (const bad of [
			"{ not json",
			JSON.stringify({ ...JSON.parse(good), version: 0 }),
			JSON.stringify({ ...JSON.parse(good), fold: -1 }),
			"[]",
		]) {
			writeFileSync(saveFile, bad);
			const idx = newIndex();
			await expectSameAsPi(idx);
			expect(idx.stats.rejectedSaves).toBe(1);
			expect(idx.stats.loadedFromDisk).toBe(0);
			await idx.flush();
			const again = newIndex();
			await again.listAll();
			expect(again.stats.rejectedSaves).toBe(0);
			expect(again.stats.fullReads).toBe(0);
		}

		// One damaged entry is read again; the rest come from the file.
		const saved = JSON.parse(good);
		const somePath = Object.keys(saved.files)[0];
		saved.files[somePath].offset = "x";
		writeFileSync(saveFile, JSON.stringify(saved));
		const idx = newIndex();
		await expectSameAsPi(idx);
		expect(idx.stats.loadedFromDisk).toBe(11);
	}, 30_000);
});

describe("session-index: identity labels", () => {
	it("answers a file it knows as it is now, and nothing for a file that changed since", async () => {
		let t = writeChats();
		const idx = newIndex();
		await idx.listAll();
		const file = join(dirA, "2026-09-01T16-30-00-000Z_jjjj.jsonl");
		const st = statSync(file);
		expect(idx.identityOf(file, st)).toEqual({ id: "ops" });
		const plain = join(dirA, "2026-09-01T10-00-00-000Z_aaaa.jsonl");
		expect(idx.identityOf(plain, statSync(plain))).toEqual({ id: undefined });

		appendFileSync(file, lines(identity(null, (t += 60_000))));
		expect(idx.identityOf(file, statSync(file))).toBeNull();
		await idx.listAll();
		expect(idx.identityOf(file, statSync(file))).toEqual({ id: null });

		// The identity reader uses it: same answers as reading the file itself.
		const viaIndex = new IdentityFileIndex();
		viaIndex.useSource((f, s) => idx.identityOf(f, s));
		const reading = new IdentityFileIndex();
		for (const f of [file, plain]) expect(await viaIndex.lastEntry(f)).toBe(await reading.lastEntry(f));
	}, 30_000);
});

describe("session-index: never blocks the server", () => {
	it("a big transcript (one 48 MB line among 40 MB of others) keeps every event-loop pause under 200 ms", async () => {
		mkdirSync(dirA, { recursive: true });
		const big = join(dirA, "2026-09-02T00-00-00-000Z_big0.jsonl");
		let t = T0;
		writeFileSync(big, lines(header("big0", CWD_A, t), message("user", "a big one", (t += 1000))));
		appendFileSync(
			big,
			lines(message("user", [{ type: "image", data: "A".repeat(48 << 20), mimeType: "image/png" }], (t += 1000))),
		);
		const chunk: string[] = [];
		const text = "x".repeat(2000);
		for (let i = 0; i < 20_000; i++) {
			chunk.push(message(i % 2 ? "assistant" : "user", text, (t += 1000)));
			if (chunk.length === 2000) appendFileSync(big, lines(...chunk.splice(0)));
		}

		const idx = newIndex({ file: null });
		let maxGap = 0;
		let last = performance.now();
		const timer = setInterval(() => {
			const now = performance.now();
			maxGap = Math.max(maxGap, now - last);
			last = now;
		}, 5);
		try {
			const rows = await idx.listAll();
			expect(rows).toHaveLength(1);
			expect(rows[0].messageCount).toBe(20_002);
			// It grew: only the new part is read.
			appendFileSync(big, lines(message("user", "one more", (t += 1000))));
			const again = await idx.listAll();
			expect(again[0].messageCount).toBe(20_003);
			expect(idx.stats.partialReads).toBe(1);
		} finally {
			clearInterval(timer);
		}
		expect(maxGap).toBeLessThan(200);
	}, 120_000);
});
