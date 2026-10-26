import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager, type SessionInfo } from "@earendil-works/pi-coding-agent";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ClientSession } from "../../server/agent-service.js";
import type { ServerMessage } from "../../server/protocol.js";
import { sessionIndex } from "../../server/session-index.js";

// Independently specified lifetime contract: three seconds from the original request, not a new
// search or a sliding hit. Synthetic SDK summaries only; never construct an SDK session or runtime.
const TTL = 3000;
const START = 1_700_000_000_000;
const fixtureRoot = mkdtempSync(join(tmpdir(), "pi-search-cache-lifetime-"));
const cwdA = join(fixtureRoot, "alpha");
const cwdB = join(fixtureRoot, "beta");

interface CacheSession {
	cwd: string;
	disposed: boolean;
	sessionInfosCache: { cwd: string; infos: SessionInfo[]; at: number } | null;
	sessionInfosCacheTimer: ReturnType<typeof setTimeout> | null;
	sessionInfosCacheGeneration: number;
	emitted: ServerMessage[];
	loadSessionInfosWithText(): Promise<SessionInfo[]>;
	invalidateSessionInfos(): void;
	searchSessions(query: string, reqId: number): Promise<void>;
	dispose(): Promise<void>;
}
const liveSessions = (ClientSession as unknown as { liveSessions: Set<CacheSession> }).liveSessions;
const sessions: CacheSession[] = [];
let originalLiveSessions: CacheSession[] = [];

function fakeSession(cwd = cwdA): CacheSession {
	const emitted: ServerMessage[] = [];
	const fields = {
		cwd,
		disposed: false,
		sessionInfosCache: null,
		sessionInfosCacheTimer: null,
		sessionInfosCacheGeneration: 0,
		emitted,
		emit: (message: ServerMessage) => emitted.push(message),
		// Only these inert lifecycle collaborators are needed by the real disposal paths.
		convs: new Map(),
		modelAdmin: { dispose: vi.fn() },
		files: { unwatchDir: vi.fn(), unwatchGit: vi.fn() },
		webUi: { dispose: vi.fn() },
		bg: { stop: vi.fn() },
		cancelPendingQuestions: vi.fn(),
		cancelPendingPageCalls: vi.fn(),
		cancelPendingApprovals: vi.fn(),
		snapshotTimer: null,
		sessionsTimer: null,
		widgetsTimer: null,
		stallTimer: null,
	};
	const session: CacheSession = Object.create(ClientSession.prototype, Object.getOwnPropertyDescriptors(fields));
	sessions.push(session);
	liveSessions.add(session);
	return session;
}

function summary(id: string, modified = 1000, cwd = cwdA): SessionInfo {
	return {
		path: join(fixtureRoot, `${id}.jsonl`),
		id,
		cwd,
		created: new Date(0),
		modified: new Date(modified),
		messageCount: 4,
		name: id,
		firstMessage: `first ${id}`,
		allMessagesText: `synthetic earlier text ${id}`,
	};
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason: Error) => void;
	const promise = new Promise<T>((ok, fail) => {
		resolve = ok;
		reject = fail;
	});
	return { promise, resolve, reject };
}

function lastExpiryCallback(spy: { mock: { calls: unknown[][] } }): () => void {
	const callback = spy.mock.calls.at(-1)?.[0];
	expect(typeof callback).toBe("function");
	return callback as () => void;
}

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(START);
	vi.stubEnv("PI_WEB_UI_HISTORY_SCOPE", "all");
	vi.stubEnv("PI_CODING_AGENT_SESSION_DIR", fixtureRoot);
	vi.spyOn(SessionManager, "listAll").mockResolvedValue([]);
	vi.spyOn(SessionManager, "list").mockResolvedValue([]);
	vi.spyOn(sessionIndex, "invalidate").mockImplementation(() => {});
	originalLiveSessions = [...liveSessions];
	liveSessions.clear();
});

afterEach(() => {
	for (const session of sessions.splice(0)) session.invalidateSessionInfos();
	liveSessions.clear();
	for (const session of originalLiveSessions) liveSessions.add(session);
	vi.clearAllTimers();
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	vi.useRealTimers();
});
afterAll(() => rmSync(fixtureRoot, { recursive: true, force: true }));

describe("full-text session cache lifetime (H-SESSION-TTL-RELEASE-1)", () => {
	it("hits until 2999 ms, then releases its array without another request or a sliding deadline", async () => {
		const infos = [summary("one")];
		vi.mocked(SessionManager.listAll).mockResolvedValue(infos);
		const session = fakeSession();
		expect(await session.loadSessionInfosWithText()).toBe(infos);
		const originalCache = session.sessionInfosCache;
		vi.advanceTimersByTime(TTL - 1);
		expect(await session.loadSessionInfosWithText()).toBe(infos);
		expect(session.sessionInfosCache).toBe(originalCache);
		expect(SessionManager.listAll).toHaveBeenCalledTimes(1);
		vi.advanceTimersByTime(1);
		expect(session.sessionInfosCache).toBeNull();
		expect(session.sessionInfosCacheTimer).toBeNull();
		expect(vi.getTimerCount()).toBe(0);
		expect(SessionManager.listAll).toHaveBeenCalledTimes(1);
	});

	it("unrefs the expiry timer so this cache cannot keep the process alive", async () => {
		const session = fakeSession();
		await session.loadSessionInfosWithText();
		expect(session.sessionInfosCacheTimer?.hasRef()).toBe(false);
	});

	it("charges a delayed parse against the original request's three seconds", async () => {
		const pending = deferred<SessionInfo[]>();
		vi.mocked(SessionManager.listAll).mockReturnValue(pending.promise);
		const session = fakeSession();
		const read = session.loadSessionInfosWithText();
		vi.advanceTimersByTime(1000);
		const infos = [summary("slow")];
		pending.resolve(infos);
		expect(await read).toBe(infos);
		expect(session.sessionInfosCache?.at).toBe(START);
		vi.advanceTimersByTime(1999);
		expect(session.sessionInfosCache?.infos).toBe(infos);
		vi.advanceTimersByTime(1);
		expect(session.sessionInfosCache).toBeNull();
		expect(vi.getTimerCount()).toBe(0);
	});

	it.each([TTL, TTL + 1])("does not cache an already expired parse at %i ms", async (elapsed) => {
		const pending = deferred<SessionInfo[]>();
		vi.mocked(SessionManager.listAll).mockReturnValue(pending.promise);
		const session = fakeSession();
		const read = session.loadSessionInfosWithText();
		vi.advanceTimersByTime(elapsed);
		const infos = [summary("expired-before-finish")];
		pending.resolve(infos);
		expect(await read).toBe(infos);
		expect(session.sessionInfosCache).toBeNull();
		expect(vi.getTimerCount()).toBe(0);
	});

	it("invalidation immediately drops the array and timer and still invalidates the metadata index", async () => {
		const session = fakeSession();
		vi.mocked(SessionManager.listAll).mockResolvedValue([summary("invalidated")]);
		await session.loadSessionInfosWithText();
		session.invalidateSessionInfos();
		expect(session.sessionInfosCache).toBeNull();
		expect(session.sessionInfosCacheTimer).toBeNull();
		expect(vi.getTimerCount()).toBe(0);
		expect(sessionIndex.invalidate).toHaveBeenCalledTimes(1);
	});

	it("a cancelled older callback cannot clear a newer replacement, even if invoked directly", async () => {
		const spy = vi.spyOn(globalThis, "setTimeout");
		const first = [summary("first")];
		const second = [summary("second")];
		vi.mocked(SessionManager.listAll).mockResolvedValueOnce(first).mockResolvedValueOnce(second);
		const session = fakeSession();
		await session.loadSessionInfosWithText();
		const oldCallback = lastExpiryCallback(spy);
		vi.advanceTimersByTime(1000);
		session.invalidateSessionInfos();
		await session.loadSessionInfosWithText();
		const replacement = session.sessionInfosCache;
		expect(vi.getTimerCount()).toBe(1);
		oldCallback();
		expect(session.sessionInfosCache).toBe(replacement);
		vi.advanceTimersByTime(2000);
		expect(session.sessionInfosCache?.infos).toBe(second);
		vi.advanceTimersByTime(1000);
		expect(session.sessionInfosCache).toBeNull();
	});

	it("global-scope hits survive cwd changes", async () => {
		const infos = [summary("all-projects")];
		vi.mocked(SessionManager.listAll).mockResolvedValue(infos);
		const session = fakeSession();
		await session.loadSessionInfosWithText();
		session.cwd = cwdB;
		expect(await session.loadSessionInfosWithText()).toBe(infos);
		expect(session.sessionInfosCache?.cwd).toBe("*");
		expect(SessionManager.listAll).toHaveBeenCalledTimes(1);
		expect(SessionManager.list).not.toHaveBeenCalled();
	});

	it("project-scope changes replace the cached scope and its deadline", async () => {
		vi.stubEnv("PI_WEB_UI_HISTORY_SCOPE", "project");
		const spy = vi.spyOn(globalThis, "setTimeout");
		const alpha = [summary("alpha")];
		const beta = [summary("beta", 2000, cwdB)];
		vi.mocked(SessionManager.list).mockResolvedValueOnce(alpha).mockResolvedValueOnce(beta);
		const session = fakeSession();
		expect(await session.loadSessionInfosWithText()).toBe(alpha);
		const oldCallback = lastExpiryCallback(spy);
		vi.advanceTimersByTime(1000);
		session.cwd = cwdB;
		expect(await session.loadSessionInfosWithText()).toBe(beta);
		oldCallback();
		expect(session.sessionInfosCache?.cwd).toBe(cwdB);
		expect(session.sessionInfosCache?.infos).toBe(beta);
		expect(SessionManager.list).toHaveBeenNthCalledWith(1, cwdA, expect.anything());
		expect(SessionManager.list).toHaveBeenNthCalledWith(2, cwdB, expect.anything());
		vi.advanceTimersByTime(2000);
		expect(session.sessionInfosCache?.infos).toBe(beta);
		vi.advanceTimersByTime(1000);
		expect(session.sessionInfosCache).toBeNull();
	});

	it("history-scope changes miss, while subsequent requests in the same scope hit", async () => {
		const global = [summary("global")];
		const project = [summary("project")];
		vi.mocked(SessionManager.listAll).mockResolvedValue(global);
		vi.mocked(SessionManager.list).mockResolvedValue(project);
		const session = fakeSession();
		expect(await session.loadSessionInfosWithText()).toBe(global);
		vi.stubEnv("PI_WEB_UI_HISTORY_SCOPE", "project");
		expect(await session.loadSessionInfosWithText()).toBe(project);
		expect(await session.loadSessionInfosWithText()).toBe(project);
		expect(session.sessionInfosCache?.cwd).toBe(cwdA);
		expect(SessionManager.listAll).toHaveBeenCalledTimes(1);
		expect(SessionManager.list).toHaveBeenCalledTimes(1);
	});

	it.each(["older-first", "newer-first"])("overlapping loads keep the latest (%s)", async (order) => {
		const first = deferred<SessionInfo[]>();
		const second = deferred<SessionInfo[]>();
		vi.mocked(SessionManager.listAll).mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
		const session = fakeSession();
		const firstRead = session.loadSessionInfosWithText();
		vi.advanceTimersByTime(100);
		const secondRead = session.loadSessionInfosWithText();
		const older = [summary("older")];
		const newer = [summary("newer")];
		if (order === "older-first") {
			first.resolve(older);
			expect(await firstRead).toBe(older);
			expect(session.sessionInfosCache).toBeNull();
			second.resolve(newer);
			expect(await secondRead).toBe(newer);
		} else {
			second.resolve(newer);
			expect(await secondRead).toBe(newer);
			first.resolve(older);
			expect(await firstRead).toBe(older);
		}
		expect(session.sessionInfosCache?.infos).toBe(newer);
		expect(session.sessionInfosCache?.at).toBe(START + 100);
		expect(vi.getTimerCount()).toBe(1);
		vi.advanceTimersByTime(TTL);
		expect(session.sessionInfosCache).toBeNull();
	});

	it("a late old-project load cannot replace a newer project's cache", async () => {
		vi.stubEnv("PI_WEB_UI_HISTORY_SCOPE", "project");
		const alpha = deferred<SessionInfo[]>();
		const beta = [summary("beta", 2000, cwdB)];
		vi.mocked(SessionManager.list).mockReturnValueOnce(alpha.promise).mockResolvedValueOnce(beta);
		const session = fakeSession();
		const oldRead = session.loadSessionInfosWithText();
		session.cwd = cwdB;
		await session.loadSessionInfosWithText();
		const older = [summary("alpha")];
		alpha.resolve(older);
		expect(await oldRead).toBe(older);
		expect(session.sessionInfosCache?.cwd).toBe(cwdB);
		expect(session.sessionInfosCache?.infos).toBe(beta);
	});

	it.each(["cwd", "history-scope"])("fences delayed reads after a %s change", async (change) => {
		vi.stubEnv("PI_WEB_UI_HISTORY_SCOPE", "project");
		const pending = deferred<SessionInfo[]>();
		vi.mocked(SessionManager.list).mockReturnValueOnce(pending.promise);
		const session = fakeSession();
		const read = session.loadSessionInfosWithText();
		if (change === "cwd") session.cwd = cwdB;
		else vi.stubEnv("PI_WEB_UI_HISTORY_SCOPE", "all");
		const infos = [summary("previous-scope")];
		pending.resolve(infos);
		expect(await read).toBe(infos);
		expect(session.sessionInfosCache).toBeNull();
		expect(vi.getTimerCount()).toBe(0);
	});

	it("an invalidated in-flight result is still returned but cannot repopulate the cache", async () => {
		const pending = deferred<SessionInfo[]>();
		const fresh = [summary("fresh")];
		vi.mocked(SessionManager.listAll).mockReturnValueOnce(pending.promise).mockResolvedValueOnce(fresh);
		const session = fakeSession();
		const read = session.loadSessionInfosWithText();
		session.invalidateSessionInfos();
		const old = [summary("deleted-before-load-finished")];
		pending.resolve(old);
		expect(await read).toBe(old);
		expect(session.sessionInfosCache).toBeNull();
		expect(vi.getTimerCount()).toBe(0);
		expect(await session.loadSessionInfosWithText()).toBe(fresh);
		expect(session.sessionInfosCache?.infos).toBe(fresh);
	});

	it.each([false, true])("dispose clears cached text (other client: %s)", async (otherClient) => {
		const session = fakeSession();
		vi.mocked(SessionManager.listAll).mockResolvedValue([summary("disposed")]);
		await session.loadSessionInfosWithText();
		const other = otherClient ? fakeSession(cwdB) : null;
		if (other) await other.loadSessionInfosWithText();
		await session.dispose();
		expect(session.disposed).toBe(true);
		expect(liveSessions.has(session)).toBe(false);
		expect(session.sessionInfosCache).toBeNull();
		expect(session.sessionInfosCacheTimer).toBeNull();
		expect(vi.getTimerCount()).toBe(otherClient ? 1 : 0);
		if (other) expect(other.sessionInfosCache).not.toBeNull();
		// Per-window teardown must not invalidate the shared metadata index.
		expect(sessionIndex.invalidate).not.toHaveBeenCalled();
	});

	it.each([false, true])("dispose fences pending and subsequent loads (other client: %s)", async (otherClient) => {
		const pending = deferred<SessionInfo[]>();
		const infos = [summary("finished-after-disposal")];
		vi.mocked(SessionManager.listAll).mockReturnValueOnce(pending.promise).mockResolvedValue(infos);
		const session = fakeSession();
		const read = session.loadSessionInfosWithText();
		if (otherClient) fakeSession(cwdB);
		await session.dispose();
		pending.resolve(infos);
		expect(await read).toBe(infos);
		expect(session.sessionInfosCache).toBeNull();
		expect(await session.loadSessionInfosWithText()).toBe(infos);
		expect(session.sessionInfosCache).toBeNull();
		expect(vi.getTimerCount()).toBe(0);
	});

	it("a rejected scope refresh leaves neither the old array nor a timer and permits a fresh retry", async () => {
		const session = fakeSession();
		await session.loadSessionInfosWithText();
		vi.stubEnv("PI_WEB_UI_HISTORY_SCOPE", "project");
		vi.mocked(SessionManager.list).mockRejectedValueOnce(new Error("synthetic directory failure"));
		await expect(session.loadSessionInfosWithText()).rejects.toThrow("synthetic directory failure");
		expect(session.sessionInfosCache).toBeNull();
		expect(vi.getTimerCount()).toBe(0);
		const fresh = [summary("recovered")];
		vi.mocked(SessionManager.list).mockResolvedValue(fresh);
		expect(await session.loadSessionInfosWithText()).toBe(fresh);
		expect(session.sessionInfosCache?.infos).toBe(fresh);
	});

	it("full-text search, long previews, ordering and the existing 50-result limit are unchanged across expiry", async () => {
		const infos = Array.from({ length: 55 }, (_, i) => ({
			...summary(`row-${i}`, 1000 + i),
			firstMessage: "synthetic preview ".repeat(100) + i,
			allMessagesText: "synthetic history ".repeat(1000) + " Deep-Needle",
		}));
		const order = infos.map((info) => info.path);
		vi.mocked(SessionManager.listAll).mockResolvedValue(infos);
		const session = fakeSession();
		await session.searchSessions("  DEEP-NEEDLE  ", 71);
		await session.searchSessions("deep-needle", 72);
		const first = session.emitted[0];
		const second = session.emitted[1];
		expect(first.type).toBe("session_search_results");
		expect(second.type).toBe("session_search_results");
		if (first.type !== "session_search_results" || second.type !== "session_search_results") return;
		expect(first.ok).toBe(true);
		expect(first.reqId).toBe(71);
		expect(first.query).toBe("  DEEP-NEEDLE  ");
		expect(first.results).toHaveLength(50);
		expect(first.results.map((row) => row.path)).toEqual(order.toReversed().slice(0, 50));
		expect(first.results[0].firstMessage).toBe(infos[54].firstMessage);
		expect(second.results).toEqual(first.results);
		expect(SessionManager.listAll).toHaveBeenCalledTimes(1);
		vi.advanceTimersByTime(TTL);
		expect(session.sessionInfosCache).toBeNull();
		await session.searchSessions("deep-needle", 73);
		const third = session.emitted[2];
		expect(third.type === "session_search_results" && third.results).toEqual(first.results);
		expect(SessionManager.listAll).toHaveBeenCalledTimes(2);
		expect(infos.map((info) => info.path)).toEqual(order);
		expect(session.sessionInfosCache?.infos).toBe(infos);
	});

	it.each(["display-needle", "file-needle", "first-needle", "deep-needle"])("continues matching %s", async (query) => {
		const info = {
			...summary("file-needle"),
			name: "DISPLAY-NEEDLE",
			firstMessage: "FIRST-NEEDLE",
			allMessagesText: "synthetic historical content DEEP-NEEDLE",
		};
		vi.mocked(SessionManager.listAll).mockResolvedValue([info]);
		const session = fakeSession();
		await session.searchSessions(query, 80);
		const message = session.emitted[0];
		expect(message.type).toBe("session_search_results");
		if (message.type !== "session_search_results") return;
		expect(message.ok).toBe(true);
		expect(message.results.map((row) => row.path)).toEqual([info.path]);
	});
});
