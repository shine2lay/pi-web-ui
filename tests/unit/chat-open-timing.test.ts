/**
 * chat-open-timing (Ops #690): one content-free "chatopen" row per chat open in the connection log
 * (server/chat-open-timing.ts joined with server/conn-events.ts). Fake clocks, fake timers, a temp data
 * folder: no sockets, no chats, no model. Checks the row's fields, that it holds no message text, title,
 * path or session id, loaded vs not-loaded opens, failed and unanswered opens, and the cost per open.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	chatKey,
	ChatOpenTracker,
	noteSnapshotFlush,
	PAGE_REPORT_WAIT_MS,
	sanitizeOpenReport,
	SERVER_WAIT_MS,
	type ChatOpenRow,
} from "../../server/chat-open-timing";
import { CONFIG_FILE, ConnEvents, hashClient, LOG_FILE } from "../../server/conn-events";
import type { ChatOpenReport, ClientMessage, ServerMessage, UiState } from "../../server/protocol";
import { threadCpuMs } from "./load-independent.js";

const DAY = 86_400_000;
const T0 = Math.floor(Date.now() / DAY) * DAY + 3_600_000;
const PATH = "/home/someone/.pi/agent/sessions/--home--someone--/2026-10-31T10-00-00_Secret-Title-Project.jsonl";
const SESSION_ID = "0199aaaa-bbbb-cccc-dddd-eeeeffff0000";
const SECRET = "the owner's private words about Secret Title Project";
const OPEN = "a1b2c3d4e5f60718";

let dir = "";
let made: ConnEvents[] = [];
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "chat-open-timing-"));
	writeFileSync(join(dir, CONFIG_FILE), JSON.stringify({ enabled: true, notices: false }));
});
afterEach(() => {
	for (const c of made) c.stop();
	made = [];
	rmSync(dir, { recursive: true, force: true });
});

// biome-ignore lint/suspicious/noExplicitAny: log lines are plain JSON
type Line = Record<string, any>;
const lines = (): Line[] => {
	let text = "";
	try {
		text = readFileSync(join(dir, LOG_FILE), "utf8");
	} catch {
		return [];
	}
	return text
		.split("\n")
		.filter(Boolean)
		.map((l) => JSON.parse(l) as Line);
};

function chatState(over: Partial<UiState> = {}): UiState {
	return {
		conversationId: "c7",
		sessionId: SESSION_ID,
		sessionFile: PATH,
		title: "Secret Title Project",
		cwd: "/home/someone/secret-project",
		messagesStart: 40,
		messages: [
			{ role: "user", content: SECRET },
			{ role: "assistant", content: `${SECRET} (answer)` },
		],
		...over,
	} as unknown as UiState;
}

function setup(opts: { loaded?: (path: string) => boolean | null } = {}) {
	const clock = { now: T0 };
	const timers: { fn: () => void; ms: number; live: boolean }[] = [];
	const ce = new ConnEvents({ dataDir: dir, now: () => clock.now, gc: false, stallWatch: false });
	made.push(ce);
	const tracker = new ChatOpenTracker({
		sink: ce,
		conn: "0123456789ab",
		clientId: () => "client-uuid-1",
		browser: true,
		now: () => clock.now,
		setTimer: (fn, ms) => {
			const t = { fn, ms, live: true };
			timers.push(t);
			return t as unknown as ReturnType<typeof setTimeout>;
		},
		clearTimer: (t) => {
			(t as unknown as { live: boolean }).live = false;
		},
	});
	const loaded = opts.loaded ?? (() => false);
	const fire = (ms: number) => {
		for (const t of timers) if (t.live && t.ms === ms) ((t.live = false), t.fn());
	};
	const switchSession = (open?: string): ClientMessage =>
		({ type: "switch_session", path: PATH, ...(open ? { open } : {}) }) as ClientMessage;
	const send = (msg: ServerMessage, chars = 100, serializeStartedAt = clock.now) =>
		tracker.sent(msg, chars, serializeStartedAt);
	return { clock, ce, tracker, loaded, fire, switchSession, send };
}

const report = (over: Partial<ChatOpenReport> = {}): ChatOpenReport => ({
	type: "chat_open",
	open: OPEN,
	outcome: "done",
	via: "click",
	startToRequestMs: 12,
	toFirstFrameMs: 300,
	toPaintMs: 340,
	toDoneMs: 900,
	device: "phone",
	visible: true,
	cached: false,
	automated: false,
	...over,
});

describe("one row per open", () => {
	it("joins the server's marks and the page's into one chatopen row", () => {
		const s = setup();
		s.tracker.requested(s.switchSession(OPEN), s.loaded);
		s.clock.now += 200;
		s.send({ type: "switch_preview", target: { kind: "session", path: PATH }, state: chatState() }, 5_000);
		s.clock.now += 400;
		noteSnapshotFlush(s.clock.now);
		s.clock.now += 50; // building the snapshot
		const serializeAt = s.clock.now;
		s.clock.now += 10; // serializing it
		s.send({ type: "snapshot", state: chatState() }, 80_000, serializeAt);
		s.send({ type: "switch_done", target: { kind: "session", path: PATH } }, 60);
		expect(lines()).toEqual([]); // waits for the page's report
		s.clock.now += 300;
		s.tracker.pageReport(report());
		const rows = lines();
		expect(rows).toHaveLength(1);
		const r = rows[0]!;
		expect(r).toMatchObject({
			t: T0 + 960,
			kind: "chatopen",
			at: T0,
			conn: "0123456789ab",
			client: hashClient("client-uuid-1"),
			browser: true,
			open: OPEN,
			target: "session",
			chat: chatKey(SESSION_ID),
			loadedBefore: false,
			ok: true,
			outcome: "done",
			msgs: 42,
			sentMsgs: 2,
			reuse: false,
			snapshotChars: 80_000,
			chars: 85_060,
			frames: 3,
			serverMs: 660,
			loadMs: 600,
			buildMs: 50,
			serializeMs: 10,
			previewMs: 200,
			via: "click",
			startToRequestMs: 12,
			toFirstFrameMs: 300,
			toPaintMs: 340,
			toCachePaintMs: null,
			toDoneMs: 900,
			device: "phone",
			visible: true,
			cached: false,
			automated: false,
		});
		expect(typeof r.load1).toBe("number");
		expect(r).toHaveProperty("loopMaxMs");
		expect(r.chat).toMatch(/^[a-f0-9]{12}$/);
	});

	it("holds no message text, title, path, folder or session id", () => {
		const s = setup();
		s.tracker.requested(s.switchSession(OPEN), s.loaded);
		s.send({ type: "switch_preview", target: { kind: "session", path: PATH }, state: chatState() });
		s.send({ type: "snapshot", state: chatState() });
		s.send({ type: "switch_done", target: { kind: "session", path: PATH } });
		s.tracker.pageReport(report());
		const text = readFileSync(join(dir, LOG_FILE), "utf8");
		expect(text).toContain('"chatopen"');
		for (const leak of [SECRET, "Secret", "secret", PATH, "/home/", "sessions", SESSION_ID, "client-uuid-1", "c7"])
			expect(text).not.toContain(leak);
		// Only numbers, booleans, null, and short fixed words or hex ids as values.
		for (const v of Object.values(lines()[0]!))
			if (typeof v === "string")
				expect(v).toMatch(/^(chatopen|session|conversation|done|click|phone|[a-f0-9]{12,16})$/);
	});

	it("refuses a page report with anything extra or malformed (the open is written as noreport)", () => {
		expect(sanitizeOpenReport({ ...report(), title: "Secret Title Project" })).toBeNull();
		expect(sanitizeOpenReport({ ...report(), open: "../../etc" })).toBeNull();
		expect(sanitizeOpenReport({ ...report(), toPaintMs: -1 })).toBeNull();
		expect(sanitizeOpenReport({ ...report(), device: "tablet" })).toBeNull();
		expect(sanitizeOpenReport(report())).toEqual(report());
		const s = setup();
		s.tracker.requested(s.switchSession(OPEN), s.loaded);
		s.send({ type: "snapshot", state: chatState() });
		s.send({ type: "switch_done", target: { kind: "session", path: PATH } });
		s.tracker.pageReport({ ...report(), title: "Secret Title Project" });
		expect(lines()).toEqual([]);
		s.fire(PAGE_REPORT_WAIT_MS);
		expect(lines()).toHaveLength(1);
		expect(lines()[0]).toMatchObject({ outcome: "noreport", ok: true, chat: chatKey(SESSION_ID) });
		expect(JSON.stringify(lines()[0])).not.toContain("Secret");
	});

	it("writes nothing when the connection log is switched off", () => {
		writeFileSync(join(dir, CONFIG_FILE), JSON.stringify({ enabled: false }));
		const s = setup();
		s.tracker.requested(s.switchSession(OPEN), s.loaded);
		s.send({ type: "switch_done", target: { kind: "session", path: PATH } });
		s.tracker.pageReport(report());
		s.tracker.closed();
		expect(lines()).toEqual([]);
		expect(s.tracker.busy).toBe(false);
	});
});

describe("server marks: loaded vs not loaded", () => {
	it("a chat already loaded answers with its snapshot (no preview, no build wait)", () => {
		const s = setup({ loaded: () => true });
		s.tracker.requested(s.switchSession(OPEN), s.loaded);
		s.clock.now += 5;
		noteSnapshotFlush(s.clock.now);
		s.clock.now += 3;
		s.send({ type: "snapshot", state: chatState() }, 1_000, s.clock.now - 1);
		// the reuse path tells the conversation first, then the session asked for
		s.send({ type: "switch_done", target: { kind: "conversation", id: "c7" } });
		s.send({ type: "switch_done", target: { kind: "session", path: PATH } });
		s.tracker.pageReport(report({ toFirstFrameMs: 40, toPaintMs: 60, toDoneMs: 50 }));
		expect(lines()[0]).toMatchObject({ loadedBefore: true, previewMs: null, loadMs: 5, buildMs: 2, serverMs: 8 });
	});

	it("a conversation target is a loaded chat; an unknown answer is null", () => {
		const s = setup({
			loaded: () => {
				throw new Error("not attached");
			},
		});
		s.tracker.requested({ type: "switch_conversation", id: "c7", open: OPEN } as ClientMessage, s.loaded);
		s.tracker.requested(s.switchSession("b1b2c3d4e5f60718"), s.loaded);
		s.tracker.closed();
		const rows = lines();
		expect(rows.map((r) => [r.target, r.loadedBefore, r.outcome, r.ok])).toEqual([
			["conversation", true, "noreport", null],
			["session", null, "noreport", null],
		]);
	});

	it("counts every message of a snapshot that reuses the page's cached window", () => {
		const s = setup({ loaded: () => true });
		s.tracker.requested(s.switchSession(OPEN), s.loaded);
		s.send({
			type: "snapshot",
			state: chatState({
				messagesStart: 0,
				messages: [{ role: "user", content: "x" }] as unknown as UiState["messages"],
			}),
			reuse: { sessionId: SESSION_ID, start: 100, count: 50, hash: "h" },
		});
		s.send({ type: "switch_done", target: { kind: "session", path: PATH } });
		s.tracker.pageReport(report());
		expect(lines()[0]).toMatchObject({ msgs: 151, sentMsgs: 1, reuse: true });
	});
});

describe("opens that don't end well", () => {
	it("a failed open keeps no chat or counts from the chat the window stayed on", () => {
		const s = setup();
		s.tracker.requested(s.switchSession(OPEN), s.loaded);
		s.send({ type: "snapshot", state: chatState() });
		s.send({ type: "switch_failed", target: { kind: "session", path: PATH }, error: `cannot read ${PATH}` });
		s.tracker.pageReport(report({ outcome: "failed", toPaintMs: undefined }));
		const r = lines()[0]!;
		expect(r).toMatchObject({ ok: false, outcome: "failed", chat: null, msgs: null, loadMs: null });
		expect(JSON.stringify(r)).not.toContain("cannot read");
	});

	it("an old page (no open id) gets a server-only row at once; a silent server is written after its wait", () => {
		const s = setup();
		s.tracker.requested(s.switchSession(), s.loaded);
		s.send({ type: "switch_done", target: { kind: "session", path: PATH } });
		expect(lines()).toHaveLength(1);
		expect(lines()[0]).toMatchObject({ open: null, outcome: "noreport", ok: true });
		s.tracker.requested(s.switchSession(OPEN), s.loaded);
		expect(s.tracker.busy).toBe(true);
		s.fire(SERVER_WAIT_MS);
		expect(lines()).toHaveLength(2);
		expect(lines()[1]).toMatchObject({ open: OPEN, ok: null, serverMs: null, outcome: "noreport" });
		expect(s.tracker.busy).toBe(false);
	});

	it("a report that comes before the server finishes waits for it (left: the page moved on)", () => {
		const s = setup();
		s.tracker.requested(s.switchSession(OPEN), s.loaded);
		s.tracker.pageReport(report({ outcome: "left", toPaintMs: undefined, toDoneMs: undefined }));
		expect(lines()).toEqual([]);
		s.send({ type: "switch_done", target: { kind: "session", path: PATH } });
		expect(lines()).toHaveLength(1);
		expect(lines()[0]).toMatchObject({ outcome: "left", ok: true, toPaintMs: null });
	});

	it("a closed socket writes every open in progress, once", () => {
		const s = setup();
		s.tracker.requested(s.switchSession(OPEN), s.loaded);
		s.tracker.requested({ type: "switch_conversation", id: "c9", open: "f0f0f0f0f0f0f0f0" } as ClientMessage, s.loaded);
		s.tracker.closed();
		s.tracker.closed();
		s.fire(SERVER_WAIT_MS);
		expect(lines()).toHaveLength(2);
	});
});

describe("cost", () => {
	it("an open costs well under 1 ms of main-thread CPU, its row included", () => {
		const s = setup();
		const N = 400;
		const state = chatState();
		const before = threadCpuMs();
		for (let i = 0; i < N; i++) {
			const open = (0x1000_0000_0000_0000n + BigInt(i)).toString(16);
			s.tracker.requested(s.switchSession(open), s.loaded);
			s.send({ type: "switch_preview", target: { kind: "session", path: PATH }, state });
			noteSnapshotFlush(s.clock.now);
			s.send({ type: "snapshot", state });
			s.send({ type: "switch_done", target: { kind: "session", path: PATH } });
			s.tracker.pageReport(report({ open }));
		}
		const perOpen = (threadCpuMs() - before) / N;
		expect(lines()).toHaveLength(N);
		expect(perOpen).toBeLessThan(1);
	});

	it("a frame while no open is in progress does nothing", () => {
		const s = setup();
		const rows: ChatOpenRow[] = [];
		const quiet = new ChatOpenTracker({
			sink: { enabled: () => true, chatOpened: (r) => rows.push(r) },
			conn: "0123456789ab",
			clientId: () => null,
			browser: true,
		});
		quiet.sent({ type: "snapshot", state: chatState() }, 10, 0);
		expect(quiet.busy).toBe(false);
		expect(rows).toEqual([]);
		expect(s.tracker.busy).toBe(false);
	});
});
