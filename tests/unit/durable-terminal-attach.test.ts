import { afterEach, describe, expect, it, vi } from "vitest";
import { TerminalManager } from "../../server/terminals.js";
import { terminalViewReply } from "../../server/ws-integration.js";
import type { ClientMessage, ServerMessage, TerminalInfo } from "../../server/protocol.js";

type AttachRequest = Extract<ClientMessage, { type: "terminal_attach" }>;
const request = (): AttachRequest => ({
	type: "terminal_attach",
	reqId: "request-a",
	viewId: "view-a",
	conversationId: "conversation-a",
	sessionId: "session-a",
	terminalId: "terminal-a",
	cols: 100,
	rows: 40,
});

const managers: TerminalManager[] = [];
afterEach(() => {
	for (const manager of managers.splice(0)) manager.killAll();
	vi.restoreAllMocks();
	vi.useRealTimers();
});

function fixture(exited = false) {
	const events: ServerMessage[] = [];
	const manager = new TerminalManager(
		(event) => events.push(event),
		"/synthetic/workspace",
		() => "en",
	);
	managers.push(manager);
	const resize = vi.fn();
	const kill = vi.fn();
	const entry = {
		id: "terminal-a",
		title: "Original",
		cwd: "/synthetic/workspace",
		cols: 80,
		rows: 24,
		exited,
		exitCode: exited ? 7 : null,
		output: "  retained Unicode λ\r\n",
		outputOffset: 17,
		pendingOut: "",
		flushTimer: null as ReturnType<typeof setTimeout> | null,
		waiters: new Set<() => void>(),
		watches: [],
		agentTouched: false,
		lastActivityAt: 0,
		idleTimer: null,
		pty: { resize, kill, write: vi.fn() },
	};
	const maps = manager as unknown as { terms: Map<string, typeof entry>; history: Map<string, typeof entry> };
	(exited ? maps.history : maps.terms).set(entry.id, entry);
	const create = vi.spyOn(manager, "create");
	const run = vi.spyOn(manager, "runCommand");
	const host = {
		sessionIdForConversation: vi.fn((id: string): string => (id === "conversation-a" ? "session-a" : "")),
		getTerminalManager: vi.fn((id: string) => (id === "conversation-a" ? manager : undefined)),
	};
	return { manager, entry, events, resize, kill, create, run, maps, host };
}

describe("existing-only terminal render attach", () => {
	it("returns exact live retained output and metadata without create/run/kill", () => {
		const f = fixture();
		const result = terminalViewReply(f.host, request());
		expect(result).toMatchObject({
			type: "terminal_view",
			available: true,
			reqId: "request-a",
			viewId: "view-a",
			conversationId: "conversation-a",
			sessionId: "session-a",
			terminalId: "terminal-a",
			data: f.entry.output,
			offset: 17,
			terminal: { id: "terminal-a", running: true, cols: 100, rows: 40 },
		});
		expect(f.resize).toHaveBeenCalledExactlyOnceWith(100, 40);
		expect(f.create).not.toHaveBeenCalled();
		expect(f.run).not.toHaveBeenCalled();
		expect(f.kill).not.toHaveBeenCalled();
	});

	it("attaches exited history without restart, resize, output loss or status fabrication", () => {
		const f = fixture(true);
		expect(terminalViewReply(f.host, request())).toMatchObject({
			available: true,
			data: f.entry.output,
			offset: 17,
			terminal: { running: false, exitCode: 7, cols: 80, rows: 24 },
		});
		expect(f.resize).not.toHaveBeenCalled();
		expect(f.create).not.toHaveBeenCalled();
		expect(f.run).not.toHaveBeenCalled();
		expect(f.kill).not.toHaveBeenCalled();
	});

	it.each(["unknown-user-terminal", "ai-bash-123", "invalid/id"])(
		"missing/invalid %s never creates a shell or emits a fake replay",
		(terminalId) => {
			const f = fixture();
			const before = f.entry.output;
			expect(terminalViewReply(f.host, { ...request(), terminalId })).toMatchObject({
				available: false,
				reason: "missing",
			});
			expect(f.entry.output).toBe(before);
			expect(f.create).not.toHaveBeenCalled();
			expect(f.run).not.toHaveBeenCalled();
			expect(f.kill).not.toHaveBeenCalled();
			expect(f.events).toEqual([]);
		},
	);

	it("contrasts actual legacy openView creation with the strict missing-view path", () => {
		const f = fixture();
		f.create.mockReturnValue(null);
		f.manager.openView("unknown-user-terminal", "/synthetic/workspace", 80, 24, "/synthetic/workspace");
		expect(f.create).toHaveBeenCalledTimes(1);
		f.create.mockClear();
		expect(f.manager.attachExistingView("unknown-user-terminal", 80, 24)).toBeNull();
		expect(f.create).not.toHaveBeenCalled();
	});

	it("flushes the pending suffix BEFORE the exact replacement snapshot and cancels its timer", () => {
		vi.useFakeTimers();
		const f = fixture();
		f.entry.output += "pending\r\n";
		f.entry.pendingOut = "pending\r\n";
		f.entry.flushTimer = setTimeout(() => {
			throw new Error("old flush must be cancelled");
		}, 100);
		const result = terminalViewReply(f.host, request());
		expect(f.events).toEqual([{ type: "terminal_output", terminalId: "terminal-a", data: "pending\r\n" }]);
		expect(result).toMatchObject({ available: true, data: "  retained Unicode λ\r\npending\r\n" });
		expect(f.entry.pendingOut).toBe("");
		expect(f.entry.flushTimer).toBeNull();
		vi.runAllTimers();
		expect(f.events).toHaveLength(1);
	});

	it("does not broadcast a replacement snapshot to unrelated viewers", () => {
		const f = fixture();
		expect(terminalViewReply(f.host, request()).available).toBe(true);
		expect(f.events.some((event) => event.type === "terminal_view")).toBe(false);
	});

	it("accepts genuinely empty retained output, not a fabricated nonempty success", () => {
		const f = fixture();
		f.entry.output = "";
		f.entry.outputOffset = 0;
		expect(terminalViewReply(f.host, request())).toMatchObject({ available: true, data: "", offset: 0 });
	});

	it("reentrant process replacement during flush cannot attach the replacement by accident", () => {
		let replace = () => {};
		const manager = new TerminalManager(() => replace(), "/synthetic/workspace");
		managers.push(manager);
		const f = fixture();
		const maps = manager as unknown as { terms: Map<string, typeof f.entry> };
		maps.terms.set(f.entry.id, f.entry);
		f.entry.pendingOut = "pending";
		replace = () => maps.terms.set(f.entry.id, { ...f.entry, output: "DIFFERENT PROCESS" });
		expect(manager.attachExistingView(f.entry.id, 80, 24)).toBeNull();
		expect(f.resize).not.toHaveBeenCalled();
		replace = () => {};
	});

	it.each(["conversationId", "sessionId"] as const)("stale %s cannot resize/read an unrelated original", (field) => {
		const f = fixture();
		expect(terminalViewReply(f.host, { ...request(), [field]: "other" })).toMatchObject({
			available: false,
			reason: "target-changed",
		});
		expect(f.host.getTerminalManager).not.toHaveBeenCalled();
		expect(f.resize).not.toHaveBeenCalled();
	});

	it("legacy host without exact source identity is unsupported, never active-tab fallback", () => {
		const f = fixture();
		expect(terminalViewReply({ getTerminalManager: f.host.getTerminalManager }, request())).toMatchObject({
			available: false,
			reason: "unsupported",
		});
		expect(f.host.getTerminalManager).not.toHaveBeenCalled();
	});

	it("legacy manager without existing-only operation is not openView/create fallback", () => {
		const openView = vi.fn();
		const create = vi.fn();
		const host = {
			sessionIdForConversation: () => "session-a",
			getTerminalManager: () => ({ attachExistingView: undefined, openView, create }),
		};
		expect(terminalViewReply(host, request())).toMatchObject({ available: false, reason: "unsupported" });
		expect(openView).not.toHaveBeenCalled();
		expect(create).not.toHaveBeenCalled();
	});

	it("rechecks genuine identity and manager after snapshot callbacks", () => {
		const f = fixture();
		f.host.sessionIdForConversation.mockReturnValueOnce("session-a").mockReturnValue("session-b");
		expect(terminalViewReply(f.host, request())).toMatchObject({ available: false, reason: "target-changed" });
	});

	it("rejects a replaced manager after snapshot, without claiming its replay", () => {
		const f = fixture();
		f.host.getTerminalManager.mockReturnValueOnce(f.manager).mockReturnValue(undefined);
		expect(terminalViewReply(f.host, request())).toMatchObject({ available: false, reason: "target-changed" });
	});

	it.each(["", undefined, 3, null])("malformed original occurrence %s does not access managers", (reqId) => {
		const f = fixture();
		expect(terminalViewReply(f.host, { ...request(), reqId } as AttachRequest)).toMatchObject({
			available: false,
			reason: "invalid",
		});
		expect(f.host.getTerminalManager).not.toHaveBeenCalled();
	});

	it("a thrown backend read is unavailable, not fake persisted/executed success", () => {
		const f = fixture();
		f.host.getTerminalManager.mockImplementation(() => {
			throw new Error("synthetic read error");
		});
		const result = terminalViewReply(f.host, request());
		expect(result).toMatchObject({ available: false, reason: "failed" });
		expect(result).not.toHaveProperty("persistence");
		expect(result).not.toHaveProperty("releaseClientCopy");
	});

	it("cannot let unexpected snapshot fields replace the genuine request identity", () => {
		const f = fixture();
		vi.spyOn(f.manager, "attachExistingView").mockReturnValue({
			terminal: { id: "terminal-a" } as TerminalInfo,
			data: "exact",
			offset: 0,
			reqId: "wrong",
			viewId: "wrong",
			sessionId: "wrong",
		} as ReturnType<TerminalManager["attachExistingView"]>);
		expect(terminalViewReply(f.host, request())).toMatchObject({
			available: true,
			reqId: "request-a",
			viewId: "view-a",
			sessionId: "session-a",
			data: "exact",
		});
	});

	it("does not relabel a different terminal's output as the requested one", () => {
		const f = fixture();
		vi.spyOn(f.manager, "attachExistingView").mockReturnValue({
			terminal: { id: "other" } as TerminalInfo,
			data: "not ours",
			offset: 0,
		});
		expect(terminalViewReply(f.host, request())).toMatchObject({ available: false, reason: "failed" });
	});
});
