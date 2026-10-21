import { afterEach, describe, expect, it, vi } from "vitest";
import { ClientSession } from "../../server/agent-service.js";
import { invalidateSessionStats } from "../../server/session-stats.js";

interface Stats {
	sequence: number;
}
interface Session {
	sessionManager?: {
		fileEntries: unknown[];
		getLeafId(): string | null;
		getEntries(): never;
	};
	model?: { contextWindow: number };
	routedModel?: { model: { contextWindow: number } };
	getSessionStats(): Stats;
}
interface Window {
	session: Session;
	// Only the old implementation reads this: proves the new regressions fail on the old method.
	sessionStatsCache: WeakMap<Session, { at: number; value: Stats }>;
}
const methods = ClientSession.prototype as unknown as {
	sessionStats(this: Window, session?: Session): Stats;
	latestConversationForPlugins(this: object): unknown;
	conversationIdForPlugins(this: object): string | undefined;
	readConversationForPlugins(this: object): { conversationId: string } | null;
};
const readStats = methods.sessionStats;
const windowFor = (session: Session): Window => ({ session, sessionStatsCache: new WeakMap() });

function fixture() {
	let leaf: string | null = "a";
	let sequence = 0;
	const getStats = vi.fn(() => ({ sequence: ++sequence }));
	const manager = {
		fileEntries: [{ type: "message" }],
		getLeafId: () => leaf,
		getEntries: (): never => {
			throw new Error("a cache revision must not walk/copy the entries");
		},
	};
	const session: Session = { sessionManager: manager, model: { contextWindow: 200000 }, getSessionStats: getStats };
	return {
		session,
		manager,
		getStats,
		move: (next: string | null) => {
			leaf = next;
		},
	};
}

function pluginsFixture() {
	const f = fixture();
	const session = Object.assign(f.session, { agent: { state: {} }, isStreaming: false });
	const window = {
		...windowFor(session),
		convs: new Map([
			["older", { id: "older", title: "older", lastActiveAt: 1, session }],
			["latest", { id: "latest", title: "latest", lastActiveAt: 2, session }],
		]),
		latestConversationForPlugins: methods.latestConversationForPlugins,
		sessionStats: readStats,
		messagesOf: vi.fn(() => []),
	};
	return { ...f, window };
}

afterEach(() => vi.useRealTimers());

describe("bigchat-stats shared revision cache through ClientSession", () => {
	it("16 unchanged reads beyond the old TTL do one walk, not 16", () => {
		vi.useFakeTimers();
		const f = fixture();
		const window = windowFor(f.session);
		const first = readStats.call(window);
		for (let i = 1; i < 16; i++) {
			vi.advanceTimersByTime(300);
			expect(readStats.call(window)).toBe(first);
		}
		expect(f.getStats).toHaveBeenCalledTimes(1);
	});

	it("shares the same manager's result across windows and SDK wrappers", () => {
		const f = fixture();
		const first = readStats.call(windowFor(f.session));
		expect(readStats.call(windowFor(f.session))).toBe(first);
		expect(readStats.call(windowFor({ ...f.session }))).toBe(first);
		expect(f.getStats).toHaveBeenCalledTimes(1);
	});

	it("a slow compute does not expire its own cache", () => {
		vi.useFakeTimers();
		const f = fixture();
		f.getStats.mockImplementation(() => {
			vi.advanceTimersByTime(350);
			return { sequence: 1 };
		});
		const window = windowFor(f.session);
		const first = readStats.call(window);
		expect(readStats.call(window)).toBe(first);
		expect(f.getStats).toHaveBeenCalledTimes(1);
	});

	it("invalidates immediately on append even if the leaf has not moved", () => {
		const f = fixture();
		const window = windowFor(f.session);
		const first = readStats.call(window);
		f.manager.fileEntries.push({ type: "usage" });
		expect(readStats.call(window)).not.toBe(first);
		expect(f.getStats).toHaveBeenCalledTimes(2);
	});

	it("invalidates on branch move, including moving to an empty branch", () => {
		const f = fixture();
		const window = windowFor(f.session);
		const first = readStats.call(window);
		f.move("b");
		const branch = readStats.call(window);
		expect(branch).not.toBe(first);
		f.move(null);
		expect(readStats.call(window)).not.toBe(branch);
		expect(f.getStats).toHaveBeenCalledTimes(3);
	});

	it("invalidates on reload with the same length and leaf", () => {
		const f = fixture();
		const window = windowFor(f.session);
		const first = readStats.call(window);
		f.manager.fileEntries = [...f.manager.fileEntries];
		expect(readStats.call(window)).not.toBe(first);
	});

	it("invalidates on effective limit or model-presence changes without a new entry", () => {
		const f = fixture();
		const window = windowFor(f.session);
		const first = readStats.call(window);
		f.session.model = { contextWindow: 100000 };
		const second = readStats.call(window);
		expect(second).not.toBe(first);
		f.session.model.contextWindow = 400000;
		const third = readStats.call(window);
		expect(third).not.toBe(second);
		f.session.model = undefined;
		expect(readStats.call(window)).not.toBe(third);
	});

	it("keys routed limits by value, not equivalent model or getter identities", () => {
		const f = fixture();
		let model = { contextWindow: 100000 };
		Object.defineProperty(f.session, "routedModel", { get: () => ({ model }) });
		const window = windowFor(f.session);
		const first = readStats.call(window);
		expect(readStats.call(window)).toBe(first);
		model.contextWindow = 150000;
		const second = readStats.call(window);
		expect(second).not.toBe(first);
		model = { contextWindow: 150000 };
		expect(readStats.call(window)).toBe(second);
	});

	it("fresh equal routed models and an unused selected model do not rewalk", () => {
		vi.useFakeTimers();
		const f = fixture();
		Object.defineProperty(f.session, "routedModel", { get: () => ({ model: { contextWindow: 150000 } }) });
		const window = windowFor(f.session);
		const first = readStats.call(window);
		for (let i = 0; i < 16; i++) {
			vi.advanceTimersByTime(300);
			f.session.model = { contextWindow: 1000 + i };
			expect(readStats.call(window)).toBe(first);
		}
		expect(f.getStats).toHaveBeenCalledTimes(1);
	});

	it("plugin scheduler polls share the cache beyond the old TTL and refresh on append", () => {
		vi.useFakeTimers();
		const f = pluginsFixture();
		for (let i = 0; i < 16; i++) {
			vi.advanceTimersByTime(2000);
			expect(methods.readConversationForPlugins.call(f.window)?.conversationId).toBe("latest");
		}
		expect(f.getStats).toHaveBeenCalledTimes(1);
		f.manager.fileEntries.push({ type: "usage" });
		methods.readConversationForPlugins.call(f.window);
		expect(f.getStats).toHaveBeenCalledTimes(2);
	});

	it("id-only plugin routing selects the same latest conversation with no derived reads", () => {
		const f = pluginsFixture();
		expect(methods.conversationIdForPlugins.call(f.window)).toBe("latest");
		expect(f.getStats).not.toHaveBeenCalled();
		expect(f.window.messagesOf).not.toHaveBeenCalled();
		f.window.convs.clear();
		expect(methods.conversationIdForPlugins.call(f.window)).toBeUndefined();
	});

	it("preserves explicit tool/preset invalidation across windows", () => {
		const f = fixture();
		const a = windowFor(f.session);
		const b = windowFor(f.session);
		const first = readStats.call(a);
		expect(readStats.call(b)).toBe(first);
		invalidateSessionStats(f.session);
		const second = readStats.call(a);
		expect(second).not.toBe(first);
		expect(readStats.call(b)).toBe(second);
	});

	it("never shares results between different managers", () => {
		const a = fixture();
		const b = fixture();
		expect(readStats.call(windowFor(a.session))).not.toBe(readStats.call(windowFor(b.session)));
		expect(a.getStats).toHaveBeenCalledTimes(1);
		expect(b.getStats).toHaveBeenCalledTimes(1);
	});

	it("does not cache errors", () => {
		const f = fixture();
		const window = windowFor(f.session);
		f.getStats.mockImplementationOnce(() => {
			throw new Error("not ready");
		});
		expect(() => readStats.call(window)).toThrow("not ready");
		expect(readStats.call(window)).toEqual({ sequence: 1 });
	});

	it("retains a completion-timed short cache for unsupported manager shapes", () => {
		vi.useFakeTimers();
		const getStats = vi.fn(() => {
			vi.advanceTimersByTime(350);
			return { sequence: 1 };
		});
		const window = windowFor({ getSessionStats: getStats });
		const first = readStats.call(window);
		vi.advanceTimersByTime(249);
		expect(readStats.call(window)).toBe(first);
		vi.advanceTimersByTime(1);
		readStats.call(window);
		expect(getStats).toHaveBeenCalledTimes(2);
	});
});
