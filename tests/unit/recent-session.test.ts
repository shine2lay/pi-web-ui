// recent-chat-pick (server/recent-session.ts): which chat a new connection to a project reopens. The SDK's
// continueRecent stats each .jsonl following links, so a link in the sessions folder to a file elsewhere can
// win and the shell then writes into that file (Security rm-885a66f3). The pick here takes only regular
// files sitting directly in the folder, newest first, and opens the pick as continueRecent would.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CURRENT_SESSION_VERSION, SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	continueRecentRegular,
	hasSessionHeader,
	newestSessionFile,
	openPickedRegular,
	recentRegularFile,
} from "../../server/recent-session.js";
import { defaultSessionDirPath } from "../../server/session-index.js";

const CWD = "/home/u/project";
let root = "";
let saved: string | undefined;

const header = (id: string, cwd = CWD) =>
	`${JSON.stringify({ type: "session", version: CURRENT_SESSION_VERSION, id, timestamp: "2026-10-17T00:00:00.000Z", cwd })}\n`;
/** A chat file with a header, its modification time `t` seconds after 2026-10-17. */
function chat(path: string, id: string, t: number, body = ""): string {
	writeFileSync(path, header(id) + body);
	const at = Date.parse("2026-10-17T00:00:00Z") / 1000 + t;
	utimesSync(path, at, at);
	return path;
}

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "recent-session-"));
	saved = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = join(root, "agent");
});
afterEach(() => {
	if (saved === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = saved;
	rmSync(root, { recursive: true, force: true });
});

/** The project's sessions folder, made, and a file outside it with the same cwd. */
function setup() {
	const dir = defaultSessionDirPath(CWD);
	mkdirSync(dir, { recursive: true });
	const outside = join(root, "outside");
	mkdirSync(outside);
	return { dir, outside };
}

describe("newestSessionFile", () => {
	it("a link to a newer file outside the folder never wins: the newest regular file does", () => {
		const { dir, outside } = setup();
		const own = chat(join(dir, "own.jsonl"), "own", 10);
		const privateFile = chat(join(outside, "private.jsonl"), "private", 100);
		symlinkSync(privateFile, join(dir, "linked.jsonl"));
		expect(newestSessionFile(dir)).toBe(own);
		expect(recentRegularFile(CWD)).toBe(own);
	});

	it("the SDK's own pick follows that link (why this patch exists; drop it once this fails)", () => {
		const { dir, outside } = setup();
		chat(join(dir, "own.jsonl"), "own", 10);
		const privateFile = chat(join(outside, "private.jsonl"), "private", 100);
		symlinkSync(privateFile, join(dir, "linked.jsonl"));
		expect(SessionManager.continueRecent(CWD).getSessionFile()).toBe(join(dir, "linked.jsonl"));
	});

	it("newest modification time first, among files whose header reads", () => {
		const { dir } = setup();
		chat(join(dir, "old.jsonl"), "old", 10);
		const mid = chat(join(dir, "mid.jsonl"), "mid", 20);
		const noHeader = join(dir, "notes.jsonl");
		writeFileSync(noHeader, `${JSON.stringify({ type: "message", id: "m" })}\n`);
		utimesSync(noHeader, 2e9, 2e9);
		writeFileSync(join(dir, "newest.txt"), header("txt"));
		expect(newestSessionFile(dir)).toBe(mid);
	});

	it("a FIFO, a folder or a link to a folder named .jsonl is skipped, never opened", () => {
		const { dir, outside } = setup();
		const own = chat(join(dir, "own.jsonl"), "own", 10);
		execFileSync("mkfifo", [join(dir, "fifo.jsonl")]);
		mkdirSync(join(dir, "folder.jsonl"));
		symlinkSync(outside, join(dir, "dirlink.jsonl"));
		expect(newestSessionFile(dir)).toBe(own);
	});

	it("nothing to reopen: no folder, an empty folder, or only links", () => {
		const { dir, outside } = setup();
		expect(newestSessionFile(join(root, "missing"))).toBeUndefined();
		expect(newestSessionFile(dir)).toBeUndefined();
		symlinkSync(chat(join(outside, "private.jsonl"), "private", 100), join(dir, "linked.jsonl"));
		expect(newestSessionFile(dir)).toBeUndefined();
	});
});

describe("hasSessionHeader (the SDK's header rule)", () => {
	it("the first line that parses is the header: blank and broken lines before it are passed over", () => {
		const { dir } = setup();
		const file = join(dir, "a.jsonl");
		writeFileSync(file, `\n{broken\n${header("a")}`);
		expect(hasSessionHeader(file)).toBe(true);
	});

	it("a first entry that isn't a session header: not a chat", () => {
		const { dir } = setup();
		const file = join(dir, "a.jsonl");
		writeFileSync(file, `${JSON.stringify({ type: "message", id: "m" })}\n${header("a")}`);
		expect(hasSessionHeader(file)).toBe(false);
		writeFileSync(file, `${JSON.stringify({ type: "session", id: 7 })}\n`);
		expect(hasSessionHeader(file)).toBe(false);
	});

	it("a header without a final newline counts; one past the first MiB doesn't", () => {
		const { dir } = setup();
		const file = join(dir, "a.jsonl");
		writeFileSync(file, header("a").trimEnd());
		expect(hasSessionHeader(file)).toBe(true);
		writeFileSync(file, `${" ".repeat(1024 * 1024)}\n${header("a")}`);
		expect(hasSessionHeader(file)).toBe(false);
	});

	it("a link is never followed, even when named directly", () => {
		const { dir, outside } = setup();
		const link = join(dir, "linked.jsonl");
		symlinkSync(chat(join(outside, "private.jsonl"), "private", 100), link);
		expect(hasSessionHeader(link)).toBe(false);
	});
});

describe("continueRecentRegular", () => {
	it("reopens the newest regular chat as continueRecent would, and leaves the linked file untouched", () => {
		const { dir, outside } = setup();
		const own = chat(join(dir, "own.jsonl"), "own", 10);
		const privateFile = chat(join(outside, "private.jsonl"), "private", 100);
		symlinkSync(privateFile, join(dir, "linked.jsonl"));
		const before = readFileSync(privateFile, "utf8");
		const m = continueRecentRegular(CWD);
		expect(m.getSessionFile()).toBe(own);
		expect(m.getSessionDir()).toBe(dir);
		expect(m.getCwd()).toBe(CWD);
		expect(m.getSessionId()).toBe("own");
		m.appendModelChange("anthropic", "claude-x");
		m.appendThinkingLevelChange("high");
		expect(readFileSync(privateFile, "utf8")).toBe(before);
	});

	it("with no chat to reopen, a new one in the project's folder (made on the first visit)", () => {
		const m = continueRecentRegular(CWD);
		const dir = defaultSessionDirPath(CWD);
		expect(m.getSessionDir()).toBe(dir);
		expect(m.getCwd()).toBe(CWD);
		expect(m.getSessionFile()?.startsWith(`${dir}/`)).toBe(true);
	});
});

describe("openPickedRegular (queue-back-owed, Ops #393)", () => {
	it("opens exactly the file picked and checked, even when a newer one turned up since", () => {
		const { dir } = setup();
		const picked = chat(join(dir, "picked.jsonl"), "picked", 10);
		expect(recentRegularFile(CWD)).toBe(picked);
		chat(join(dir, "newer.jsonl"), "newer", 100);
		const m = openPickedRegular(CWD, picked);
		expect(m.getSessionFile()).toBe(picked);
		expect(m.getSessionId()).toBe("picked");
		expect(m.getSessionDir()).toBe(dir);
		expect(continueRecentRegular(CWD).getSessionId()).toBe("newer");
	});

	it("none picked: a new chat in the project's folder, even when one turned up since", () => {
		const { dir } = setup();
		const later = chat(join(dir, "later.jsonl"), "later", 100);
		const m = openPickedRegular(CWD, undefined);
		expect(m.getSessionDir()).toBe(dir);
		expect(m.getSessionFile()?.startsWith(`${dir}/`)).toBe(true);
		expect(m.getSessionFile()).not.toBe(later);
	});
});
