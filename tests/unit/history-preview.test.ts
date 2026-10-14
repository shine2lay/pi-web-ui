import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { SessionInfo } from "@earendil-works/pi-coding-agent";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { ClientSession, queueTaskRows } from "../../server/agent-service.js";
import type { ConversationReadHost } from "../../server/conversation-read-tool.js";
import { displayPreview } from "../../server/display-preview.js";
import { sessionIndex } from "../../server/session-index.js";

const identityMocks = vi.hoisted(() => ({
	identities: [] as Array<{ id: string; title: string }>,
	scan: vi.fn<(...args: unknown[]) => Promise<Map<string, string | null>>>(),
}));
vi.mock("../../server/identities.js", async (importOriginal) => {
	const original = await importOriginal<typeof import("../../server/identities.js")>();
	return {
		...original,
		identityRegistry: () => ({ identities: identityMocks.identities }),
		fileIdentityIds: (...args: unknown[]) => identityMocks.scan(...args),
	};
});
import type { ConversationSummary, ServerMessage, SessionSummary } from "../../server/protocol.js";

// Synthetic metadata only: no SDK runtime, transcript, model request, port or real chat.
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const cwd = "/fixture/workspace";
// An owned, empty directory guarantees anchor fallback never reads another file.
const fixtureRoot = mkdtempSync(join(tmpdir(), "pi-history-preview-159-"));
afterAll(() => rmSync(fixtureRoot, { recursive: true, force: true }));
afterEach(() => {
	identityMocks.identities = [];
	identityMocks.scan.mockReset();
	vi.restoreAllMocks();
	vi.useRealTimers();
});
const makeInfo = (i: number, firstMessage = "a".repeat(8000) + `suffix-${i}`): SessionInfo => ({
	path: join(fixtureRoot, `session-${i}.jsonl`),
	id: `fixture-${i}`,
	cwd,
	created: new Date(1000),
	modified: new Date(10000 + i),
	messageCount: i + 1,
	firstMessage,
	allMessagesText: firstMessage + " full-index-only-marker",
});

interface WindowHarness {
	clientId: string;
	cwd: string;
	disposed: boolean;
	sessionsRequested: boolean;
	sessionsPushGen: number;
	recentSessions: SessionSummary[];
	sessionsByFile: ReadonlyMap<string, SessionSummary>;
	emitted: ServerMessage[];
	late: Array<{ rows: SessionSummary[]; resend: () => void }>;
	stateStore: { getRecentRemoved(): string[] };
	pushInFlight: Promise<void>;
	loadSessionInfos(): Promise<SessionInfo[]>;
	loadSessionInfosWithText(): Promise<SessionInfo[]>;
	attachIdentities(rows: SessionSummary[], resend: () => void): Promise<void>;
	emit(msg: ServerMessage): void;
	emitConversations(): void;
	pushSessions(): Promise<void>;
}
const proto = ClientSession.prototype as unknown as {
	pushSessions(this: WindowHarness): Promise<void>;
	pushHistoryAtAttach(this: WindowHarness): void;
	recentHistoryRows(this: WindowHarness, live: Set<string>, waiting: Set<string>): ConversationSummary[];
	searchSessions(this: WindowHarness, query: string, reqId: number): Promise<void>;
	attachIdentities(this: WindowHarness, rows: SessionSummary[], resend: () => void): Promise<void>;
	conversationReadHost(this: WindowHarness): ConversationReadHost;
};
let nextWindow = 0;
function windowFor(infos: SessionInfo[]): WindowHarness {
	const w: WindowHarness = {
		clientId: `fixture-preview-${++nextWindow}`,
		cwd,
		disposed: false,
		sessionsRequested: true,
		sessionsPushGen: 0,
		recentSessions: [],
		sessionsByFile: new Map(),
		emitted: [],
		late: [],
		stateStore: { getRecentRemoved: () => [] },
		pushInFlight: Promise.resolve(),
		loadSessionInfos: vi.fn(async () => infos),
		loadSessionInfosWithText: vi.fn(async () => infos),
		attachIdentities: async (rows, resend) => {
			w.late.push({ rows, resend });
		},
		emit: (msg) => w.emitted.push(msg),
		emitConversations: vi.fn(),
		pushSessions() {
			this.pushInFlight = proto.pushSessions.call(this);
			return this.pushInFlight;
		},
	};
	return w;
}
function historyRows(w: WindowHarness): SessionSummary[] {
	const message = w.emitted.findLast((m) => m.type === "sessions");
	return message?.type === "sessions" ? message.sessions : [];
}
const withoutPreview = (rows: SessionSummary[]) => rows.map(({ firstMessage, ...rest }) => rest);
const originalDisplayRows = (infos: SessionInfo[]): SessionSummary[] =>
	infos.map((s) => ({
		path: s.path,
		name: s.name,
		firstMessage: s.firstMessage,
		messageCount: s.messageCount,
		modified: s.modified.getTime(),
		source: "web",
		cwd: s.cwd,
	}));

// Old-source negative controls and paired timing are separately source-bound in task #159's harness.
describe("History display-only projection", () => {
	it("projects cold/fresh metadata without mutating full index text or adding full hydration", async () => {
		const infos = [makeInfo(1), makeInfo(2, "short"), { ...makeInfo(3), name: "n".repeat(701) }];
		const before = digest(infos);
		for (const row of infos) Object.freeze(row);
		Object.freeze(infos);
		const w = windowFor(infos);
		w.sessionsRequested = false;
		proto.pushHistoryAtAttach.call(w);
		await w.pushInFlight;
		const rows = historyRows(w);
		expect(rows.length).toBe(3);
		for (const row of rows) expect(Array.from(row.firstMessage).length).toBeLessThanOrEqual(301);
		expect(rows.find((s) => s.path === infos[1].path)?.firstMessage === "short").toBe(true);
		expect(rows.find((s) => s.path === infos[2].path)?.name === infos[2].name).toBe(true);
		const expected = originalDisplayRows(infos).sort((a, b) => b.modified - a.modified);
		expect(digest(withoutPreview(rows))).toBe(digest(withoutPreview(expected)));
		expect(digest(infos)).toBe(before);
		expect(w.loadSessionInfos).toHaveBeenCalledTimes(1);
		expect(w.loadSessionInfosWithText).not.toHaveBeenCalled();
	});

	it("keeps cached attach, fresh listing, repeated warm listing and two windows equal", async () => {
		const infos = [makeInfo(10), makeInfo(11, "🧪".repeat(700))];
		const first = windowFor(infos);
		await first.pushSessions();
		const expected = digest(historyRows(first));
		const second = windowFor(infos);
		second.sessionsRequested = false;
		proto.pushHistoryAtAttach.call(second);
		const immediate = second.emitted[0];
		expect(immediate?.type).toBe("sessions");
		expect(digest(immediate?.type === "sessions" ? immediate.sessions : [])).toBe(expected);
		await second.pushInFlight;
		expect(digest(historyRows(second))).toBe(expected);
		await first.pushSessions();
		expect(digest(historyRows(first))).toBe(expected);
		expect(first.loadSessionInfosWithText).not.toHaveBeenCalled();
		expect(second.loadSessionInfosWithText).not.toHaveBeenCalled();
	});

	it("late identity labels resend the same bounded rows; stale generations and disposed windows do not resend", async () => {
		const w = windowFor([makeInfo(20)]);
		await w.pushSessions();
		const late = w.late[0];
		const title = historyRows(w)[0].firstMessage;
		late.rows[0].identity = { id: "fixture-role", title: "Fixture role" };
		late.resend();
		expect(historyRows(w)[0].firstMessage === title).toBe(true);
		expect(historyRows(w)[0].identity?.id).toBe("fixture-role");
		await w.pushSessions();
		let sent = w.emitted.length;
		late.resend();
		expect(w.emitted.length).toBe(sent);
		w.disposed = true;
		sent = w.emitted.length;
		w.late.at(-1)!.resend();
		expect(w.emitted.length).toBe(sent);
	});

	it("the real delayed-identity method labels both windows without replacing their display or identity keys", async () => {
		vi.useFakeTimers();
		identityMocks.identities = [{ id: "fixture-role", title: "Fixture role" }];
		let release!: (ids: Map<string, string | null>) => void;
		const pending = new Promise<Map<string, string | null>>((resolve) => {
			release = resolve;
		});
		identityMocks.scan.mockReturnValue(pending);
		const infos = [makeInfo(21)];
		const first = windowFor(infos);
		first.attachIdentities = (rows, resend) => proto.attachIdentities.call(first, rows, resend);
		const firstPush = first.pushSessions();
		await vi.advanceTimersByTimeAsync(401);
		await firstPush;
		const second = windowFor(infos);
		second.attachIdentities = (rows, resend) => proto.attachIdentities.call(second, rows, resend);
		proto.pushHistoryAtAttach.call(second);
		await vi.advanceTimersByTimeAsync(401);
		await second.pushInFlight;
		const before = digest(historyRows(first).map((s) => [s.path, s.firstMessage]));
		release(new Map([[infos[0].path, "fixture-role"]]));
		await vi.advanceTimersByTimeAsync(0);
		for (const w of [first, second]) {
			expect(historyRows(w)[0].identity?.id).toBe("fixture-role");
			expect(digest(historyRows(w).map((s) => [s.path, s.firstMessage]))).toBe(before);
			expect(Array.from(historyRows(w)[0].firstMessage).length).toBe(301);
			expect(w.loadSessionInfosWithText).not.toHaveBeenCalled();
		}
	});

	it("retains fork filtering, ordering, counts, metadata and all-saved labels beyond the top 200", async () => {
		const infos = Array.from({ length: 205 }, (_, i) => makeInfo(i));
		infos[204].parentSessionPath = infos[203].path;
		const before = digest(infos);
		const w = windowFor(infos);
		await w.pushSessions();
		const rows = historyRows(w);
		expect(rows.length).toBe(200);
		expect(rows.some((r) => r.path === infos[203].path)).toBe(false);
		const expected = originalDisplayRows(infos.filter((s) => s !== infos[203]))
			.sort((a, b) => b.modified - a.modified)
			.slice(0, 200);
		expect(digest(withoutPreview(rows))).toBe(digest(withoutPreview(expected)));
		const saved = queueTaskRows(
			[{ file: infos[0].path, home: "/fixture/home.jsonl" }],
			(file) => w.sessionsByFile.get(resolve(file)),
			new Set(),
			cwd,
		);
		expect(saved.length).toBe(1);
		expect(saved[0].sessionPath === infos[0].path).toBe(true);
		expect(Array.from(saved[0].title).length).toBe(301);
		expect(w.sessionsByFile.size).toBe(204);
		expect(digest(infos)).toBe(before);
	});

	it("bounds uncached Recent/queue fallbacks while preserving names and identity metadata", () => {
		const infos = [{ ...makeInfo(30), name: "n".repeat(701) }, makeInfo(31)];
		const w = windowFor(infos);
		w.recentSessions = originalDisplayRows(infos);
		w.recentSessions[1].identity = { id: "fixture-role", title: "Fixture role" };
		const rows = proto.recentHistoryRows.call(w, new Set(), new Set([resolve(infos[1].path)]));
		expect(rows[0].title === infos[0].name).toBe(true);
		expect(Array.from(rows[1].title).length).toBe(301);
		expect(rows[1].identity?.id).toBe("fixture-role");
		expect(rows[1].waiting).toBe(true);
		const saved = queueTaskRows(
			infos.map((s) => ({ file: s.path, home: "/fixture/home" })),
			(file) => w.recentSessions.find((s) => s.path === file),
			new Set(),
			cwd,
		);
		expect(saved[0].title === infos[0].name).toBe(true);
		expect(saved[1].title === displayPreview(infos[1].firstMessage)).toBe(true);
	});

	it("full search after scalar 300 still matches and returns the complete indexed metadata", async () => {
		const infos = [makeInfo(40, "a".repeat(8000) + "suffix-only-needle"), makeInfo(41, "short")];
		const before = digest(infos);
		const w = windowFor(infos);
		await w.pushSessions();
		expect(historyRows(w).some((r) => r.firstMessage.includes("suffix-only-needle"))).toBe(false);
		await proto.searchSessions.call(w, "suffix-only-needle", 159);
		const result = w.emitted.at(-1);
		expect(result?.type).toBe("session_search_results");
		if (result?.type !== "session_search_results") return;
		expect(result.ok).toBe(true);
		expect(result.reqId).toBe(159);
		expect(result.results.length).toBe(1);
		expect(digest(result.results[0].firstMessage)).toBe(digest(infos[0].firstMessage));
		expect(digest(infos)).toBe(before);
		expect(w.loadSessionInfosWithText).toHaveBeenCalledTimes(1);
		await proto.searchSessions.call(w, "missing-metadata-needle", 160);
		const clean = w.emitted.at(-1);
		expect(clean?.type).toBe("session_search_results");
		if (clean?.type === "session_search_results") {
			expect(clean.ok).toBe(true);
			expect(clean.results.length).toBe(0);
		}
		expect(digest(infos)).toBe(before);
		expect(w.loadSessionInfosWithText).toHaveBeenCalledTimes(2);
	});

	it("explicit history-read metadata retains full first text and index/context text after display projection", async () => {
		const infos = [makeInfo(45, "a".repeat(8000) + "full-read-suffix")];
		const before = digest(infos);
		const w = windowFor(infos);
		await w.pushSessions();
		const list = vi.spyOn(sessionIndex, "listAll").mockResolvedValue(infos);
		const full = await proto.conversationReadHost.call(w).listHistorySessions("all", cwd);
		expect(full.length).toBe(1);
		expect(digest(full[0].firstMessage)).toBe(digest(infos[0].firstMessage));
		expect(full[0].firstMessage.includes("full-read-suffix")).toBe(true);
		expect(digest(infos)).toBe(before);
		expect(list).toHaveBeenCalledTimes(1);
		expect(historyRows(w)[0].firstMessage.includes("full-read-suffix")).toBe(false);
	});

	it("cuts long200 raw JSON by at least 90%, without changing short frames or named labels", async () => {
		const infos = Array.from({ length: 200 }, (_, i) => makeInfo(i));
		const w = windowFor(infos);
		await w.pushSessions();
		const oldRows = originalDisplayRows(infos).sort((a, b) => b.modified - a.modified);
		const oldBytes = Buffer.byteLength(JSON.stringify({ type: "sessions", sessions: oldRows }));
		const newBytes = Buffer.byteLength(JSON.stringify({ type: "sessions", sessions: historyRows(w) }));
		expect(oldBytes).toBeGreaterThan(1_000_000);
		expect(1 - newBytes / oldBytes).toBeGreaterThanOrEqual(0.9);
		const short = [makeInfo(50, "short"), { ...makeInfo(51, "short"), name: "n".repeat(701) }];
		const other = windowFor(short);
		await other.pushSessions();
		const original = originalDisplayRows(short).sort((a, b) => b.modified - a.modified);
		expect(digest(historyRows(other))).toBe(digest(original));
	});
});
