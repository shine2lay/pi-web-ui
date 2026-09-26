import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ClientSession } from "../../server/agent-service.js";
import { GoalService } from "../../server/goal-service.js";
import {
	describeError,
	errorMessage,
	guardCalls,
	installProcessGuards,
	logUnhandledRejection,
	planForLostActive,
} from "../../server/crash-guard.js";

/**
 * crash-guard：一个窗口出的错不能拖垮整个服务（2026-09-25 17:15、2026-09-26 09:11 两次整站崩溃，
 * 同一条栈：prompt → flushSnapshot → currentMessages → `get conv()` 抛 "no active conversation"，
 * `void cs.prompt(...)` 让它成了未处理的拒绝，Node 退出）。端到端复现见
 * tests/no-active-chat-crash-test.mjs；这里测三层各自的判断。
 */

afterEach(() => {
	vi.restoreAllMocks();
});

describe("describeError / errorMessage", () => {
	it("an Error gives its stack, which starts with the message", () => {
		const err = new Error("no active conversation");
		const text = describeError(err);
		expect(text).toContain("Error: no active conversation");
		expect(text).toContain("crash-guard.test.ts");
		expect(errorMessage(err)).toBe("no active conversation");
	});

	it("non-errors are still readable", () => {
		expect(describeError("plain words")).toBe("plain words");
		expect(describeError({ code: 413 })).toBe('{"code":413}');
		expect(errorMessage({ code: 413 })).toBe('{"code":413}');
		expect(describeError(undefined)).toBe("undefined");
	});
});

describe("guardCalls (level 2: the WebSocket dispatcher)", () => {
	it("a rejected call is reported with where it happened, and an awaiting caller still sees it", async () => {
		const reports: [string, unknown][] = [];
		const boom = new Error("no active conversation");
		const cs = guardCalls(
			{
				async prompt(_text: string): Promise<void> {
					throw boom;
				},
			},
			"prompt",
			(where, err) => reports.push([where, err]),
		);
		await expect(cs.prompt("hi")).rejects.toBe(boom);
		expect(reports).toEqual([["prompt → prompt", boom]]);
	});

	it("a fire-and-forget call that rejects leaves no unhandled rejection", async () => {
		const unhandled: unknown[] = [];
		const onUnhandled = (reason: unknown): void => {
			unhandled.push(reason);
		};
		process.on("unhandledRejection", onUnhandled);
		try {
			const reports: string[] = [];
			const cs = guardCalls(
				{
					async prompt(): Promise<void> {
						throw new Error("no active conversation");
					},
				},
				"prompt",
				(where) => reports.push(where),
			);
			void cs.prompt();
			await new Promise((resolve) => setTimeout(resolve, 20));
			expect(reports).toEqual(["prompt → prompt"]);
			expect(unhandled).toEqual([]);
		} finally {
			process.off("unhandledRejection", onUnhandled);
		}
	});

	it("a synchronous throw is reported and the call returns undefined instead of throwing", () => {
		const reports: [string, unknown][] = [];
		const cs = guardCalls(
			{
				flushSnapshot(): void {
					throw new Error("no active conversation");
				},
			},
			"get_state",
			(where, err) => reports.push([where, err]),
		);
		expect(() => cs.flushSnapshot()).not.toThrow();
		expect(reports).toHaveLength(1);
		expect(reports[0]?.[0]).toBe("get_state → flushSnapshot");
		expect(errorMessage(reports[0]?.[1])).toBe("no active conversation");
	});

	it("methods run on the real object (private fields work), values and results pass through", async () => {
		class Session {
			#count = 0;
			label = "win-A";
			get double(): number {
				return this.#count * 2;
			}
			bump(by: number): number {
				this.#count += by;
				return this.#count;
			}
			async later(): Promise<string> {
				return `done ${this.#count}`;
			}
		}
		const reports: string[] = [];
		const real = new Session();
		const cs = guardCalls(real, "x", (where) => reports.push(where));
		expect(cs.bump(2)).toBe(2);
		expect(cs.double).toBe(4);
		expect(cs.label).toBe("win-A");
		await expect(cs.later()).resolves.toBe("done 2");
		expect(real.bump(1)).toBe(3);
		expect(reports).toEqual([]);
	});
});

describe("planForLostActive (level 1: where a window goes when its chat was closed)", () => {
	const chat = (id: string, cwd: string, lastActiveAt: number, isSubagent = false) => ({
		id,
		cwd,
		lastActiveAt,
		isSubagent,
	});

	it("an open active chat stays", () => {
		expect(planForLostActive({ activeOpen: true, cwd: "/p", open: [], hasSocket: true })).toEqual({ kind: "keep" });
	});

	it("goes back to the chat a finishing send went to, when it is still open", () => {
		const open = [chat("c1", "/p", 50), chat("c3", "/p", 10)];
		expect(planForLostActive({ activeOpen: false, preferId: "c3", cwd: "/p", open, hasSocket: false })).toEqual({
			kind: "move",
			to: "c3",
		});
	});

	it("else the project's most recently active chat, never a subagent's or another project's", () => {
		const open = [chat("c1", "/p", 10), chat("c2", "/p", 30), chat("sa-1", "/p", 99, true), chat("c9", "/other", 500)];
		expect(planForLostActive({ activeOpen: false, preferId: "gone", cwd: "/p", open, hasSocket: false })).toEqual({
			kind: "move",
			to: "c2",
		});
	});

	it("with nothing to move to: a new chat when someone is looking, else wait for the reconnect", () => {
		const open = [chat("sa-1", "/p", 99, true), chat("c9", "/other", 500)];
		expect(planForLostActive({ activeOpen: false, cwd: "/p", open, hasSocket: true })).toEqual({ kind: "new_chat" });
		expect(planForLostActive({ activeOpen: false, cwd: "/p", open, hasSocket: false })).toEqual({ kind: "wait" });
	});
});

describe("the goal bar (level 1, GoalService)", () => {
	it("a window whose chat was closed skips the goal status instead of throwing", () => {
		const sent: unknown[] = [];
		const host = {
			emit: (msg: unknown) => sent.push(msg),
			activeConvId: () => "c4",
			getConv: () => undefined,
			activeConv: (): never => {
				throw new Error("no active conversation");
			},
		};
		const goals = Object.create(GoalService.prototype) as GoalService;
		Object.assign(goals, { host });
		expect(() => goals.emitGoalStatus()).not.toThrow();
		expect(sent).toEqual([]);
	});
});

describe("process guards (level 3)", () => {
	it("an unhandled rejection is logged with its stack", () => {
		const lines: string[] = [];
		logUnhandledRejection(new Error("no active conversation"), (line) => lines.push(line));
		expect(lines).toHaveLength(1);
		expect(lines[0]).toContain("[crash-guard] unhandled promise rejection; the server keeps running");
		expect(lines[0]).toContain("Error: no active conversation");
		expect(lines[0]).toContain("crash-guard.test.ts");
	});

	it("installs one unhandledRejection handler (never uncaughtException), once", () => {
		const errors = vi.spyOn(console, "error").mockImplementation(() => {});
		const proc = new EventEmitter();
		expect(installProcessGuards(proc as unknown as NodeJS.Process)).toBe(true);
		expect(installProcessGuards(proc as unknown as NodeJS.Process)).toBe(false);
		expect(proc.listenerCount("unhandledRejection")).toBe(1);
		expect(proc.listenerCount("uncaughtException")).toBe(0);
		proc.emit("unhandledRejection", new Error("boom"), Promise.resolve());
		expect(errors).toHaveBeenCalledTimes(1);
		expect(String(errors.mock.calls[0]?.[0])).toContain("Error: boom");
	});
});

describe("the snapshot guard (level 1, ClientSession)", () => {
	type FakeConv = { id: string; cwd: string; lastActiveAt: number; isSubagent: boolean };
	const proto = ClientSession.prototype as unknown as {
		emitSnapshotNow(this: FakeWindow, forceFull?: boolean): void;
		recoverLostActive(this: FakeWindow, reason: string, prefer?: FakeConv, allowNewChat?: boolean): boolean;
	};
	type FakeWindow = ReturnType<typeof fakeWindow>;

	function fakeWindow(convs: FakeConv[], sockets: number) {
		const calls: string[] = [];
		return {
			calls,
			disposed: false,
			clientId: "win-A",
			activeId: "c4",
			cwd: "/p",
			convs: new Map(convs.map((c) => [c.id, c])),
			lostActiveLogged: null as string | null,
			sinkCount: () => sockets,
			currentMessages: (): never => {
				calls.push("currentMessages");
				throw new Error("snapshot built");
			},
			markRecentSeen: () => calls.push("markRecentSeen"),
			webUi: { refresh: () => calls.push("refresh") },
			emitConversations: () => calls.push("emitConversations"),
			goalSvc: { emitGoalStatus: () => calls.push("goal") },
			pushTerminals: () => calls.push("terminals"),
			pushSlashCommands: async () => {
				calls.push("slash");
			},
			openRecoveryChat: async () => {
				calls.push("openRecoveryChat");
				return true;
			},
			recoverLostActive: proto.recoverLostActive,
		};
	}

	it("a window whose chat was closed, with nowhere to go, skips the snapshot instead of throwing", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const win = fakeWindow([], 0);
		expect(() => proto.emitSnapshotNow.call(win)).not.toThrow();
		expect(win.calls).not.toContain("currentMessages");
		expect(win.activeId).toBe("c4");
		// One log line per lost chat, not one per snapshot.
		proto.emitSnapshotNow.call(win);
		expect(warn).toHaveBeenCalledTimes(1);
		expect(String(warn.mock.calls[0]?.[0])).toContain("[crash-guard] window win-A: its chat c4 was closed (snapshot)");
	});

	it("with an open chat in its project, the window moves there and the snapshot goes on", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const win = fakeWindow(
			[
				{ id: "c1", cwd: "/p", lastActiveAt: 5, isSubagent: false },
				{ id: "c3", cwd: "/p", lastActiveAt: 9, isSubagent: false },
			],
			1,
		);
		expect(() => proto.emitSnapshotNow.call(win)).toThrow("snapshot built");
		expect(win.activeId).toBe("c3");
		expect(win.calls).toEqual([
			"markRecentSeen",
			"refresh",
			"emitConversations",
			"goal",
			"terminals",
			"slash",
			"currentMessages",
		]);
		expect(String(warn.mock.calls[0]?.[0])).toContain("its chat c4 was closed (snapshot); moved it to c3");
	});

	it("the end of a send brings the window back to the chat it went to", () => {
		vi.spyOn(console, "warn").mockImplementation(() => {});
		const x = { id: "c3", cwd: "/p", lastActiveAt: 1, isSubagent: false };
		const win = fakeWindow([x, { id: "c1", cwd: "/p", lastActiveAt: 9, isSubagent: false }], 0);
		expect(proto.recoverLostActive.call(win, "its send finished", x)).toBe(true);
		expect(win.activeId).toBe("c3");
	});

	it("an SDK event handler that throws is logged with its stack (once a minute per error), not rethrown", () => {
		const errors = vi.spyOn(console, "error").mockImplementation(() => {});
		const events = ClientSession.prototype as unknown as {
			onEvent(this: object, conv: { id: string }, event: { type: string }): void;
		};
		const win = {
			clientId: "win-A",
			eventErrorLoggedAt: new Map<string, number>(),
			onEventNow: (): never => {
				throw new Error("no active conversation");
			},
		};
		for (let i = 0; i < 50; i++) {
			expect(() => events.onEvent.call(win, { id: "c3" }, { type: "message_update" })).not.toThrow();
		}
		expect(errors).toHaveBeenCalledTimes(1);
		const line = String(errors.mock.calls[0]?.[0]);
		expect(line).toContain("[crash-guard] window win-A: handling message_update in chat c3 failed");
		expect(line).toContain("Error: no active conversation");
		// A different event (or chat) is its own error and is logged too.
		events.onEvent.call(win, { id: "c3" }, { type: "agent_end" });
		expect(errors).toHaveBeenCalledTimes(2);
	});

	it("with nothing open and someone looking, a new chat is opened (only when allowed)", () => {
		vi.spyOn(console, "warn").mockImplementation(() => {});
		const win = fakeWindow([], 1);
		expect(proto.recoverLostActive.call(win, "closed by window win-B", undefined, false)).toBe(false);
		expect(win.calls).not.toContain("openRecoveryChat");
		expect(proto.recoverLostActive.call(win, "snapshot")).toBe(false);
		expect(win.calls).toContain("openRecoveryChat");
	});
});
