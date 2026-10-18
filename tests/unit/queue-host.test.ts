/**
 * queue-lanes: server/queue-host.ts, what pi-web-ui offers pi-queue for running queued tasks in chats
 * of their own. These tests cover the glue (checking what the extension hands in, keeping the order,
 * putting the host where pi-queue looks). The chats themselves are covered by tests/queue-lanes-test.mjs.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	chatStateFrom,
	cleanChatState,
	installQueueHost,
	isQueueCommand,
	isWakeNote,
	makeChain,
	parseQueueChatStart,
	QUEUE_HOST_KEY,
	queueCoordinator,
	type QueueHost,
	type QueueHostImpl,
	turnSinceFrom,
	WAKE_NOTE_MAX,
	waitUntil,
	wakeRefusal,
} from "../../server/queue-host.js";

const good = {
	cwd: "/tmp/qa-lane-a",
	name: "Queue #3: Fix the page",
	prompt: "[Queue] Task #3 ...",
	entries: [{ customType: "task-queue", data: { v: 1, op: "assigned", id: 3 } }],
	model: "anthropic/claude-opus-4-6",
	thinking: "high",
};

const hostOnGlobal = () => (globalThis as Record<symbol, unknown>)[QUEUE_HOST_KEY] as QueueHost | undefined;

describe("parseQueueChatStart", () => {
	it("keeps good options, cleaning the name", () => {
		expect(parseQueueChatStart({ ...good, name: "  Queue #3:\n Fix   the page " })).toEqual(good);
	});

	it("drops a model or thinking level it can't use, and keeps the rest", () => {
		const out = parseQueueChatStart({ ...good, model: "no-slash", thinking: "turbo" });
		expect(out).toEqual({ cwd: good.cwd, name: good.name, prompt: good.prompt, entries: good.entries });
	});

	it("says what's wrong instead of throwing", () => {
		expect(parseQueueChatStart(undefined)).toBe("no options");
		expect(parseQueueChatStart({ ...good, cwd: "relative/dir" })).toMatch(/absolute/);
		expect(parseQueueChatStart({ ...good, name: "  " })).toMatch(/name/);
		expect(parseQueueChatStart({ ...good, prompt: "" })).toMatch(/first message/);
		expect(parseQueueChatStart({ ...good, prompt: "x".repeat(200_001) })).toMatch(/too long/);
		expect(parseQueueChatStart({ ...good, entries: "task" })).toMatch(/list/);
		expect(parseQueueChatStart({ ...good, entries: [{ data: 1 }] })).toMatch(/customType/);
		expect(parseQueueChatStart({ ...good, entries: Array.from({ length: 21 }, () => good.entries[0]) })).toMatch(
			/too many/,
		);
	});

	it("allows no entries at all", () => {
		const { entries: _, ...rest } = good;
		expect(parseQueueChatStart(rest)).toMatchObject({ entries: [] });
	});
});

describe("isQueueCommand", () => {
	it("only lets one-line /queue commands through", () => {
		expect(isQueueCommand("/queue sync 3 /s/a.jsonl")).toBe(true);
		expect(isQueueCommand("/queue")).toBe(true);
		expect(isQueueCommand("/queuex")).toBe(false);
		expect(isQueueCommand("/model x")).toBe(false);
		expect(isQueueCommand("hello /queue")).toBe(false);
		expect(isQueueCommand("/queue go\nrm -rf /")).toBe(false);
		expect(isQueueCommand(`/queue ${"x".repeat(4000)}`)).toBe(false);
		expect(isQueueCommand(42)).toBe(false);
	});
});

describe("makeChain", () => {
	it("runs jobs one at a time, in order, and a failure doesn't stop the next", async () => {
		const chain = makeChain();
		const log: string[] = [];
		const job =
			(name: string, ms: number, fail = false) =>
			async () => {
				log.push(`${name}+`);
				await new Promise((r) => setTimeout(r, ms));
				log.push(`${name}-`);
				if (fail) throw new Error(name);
				return name;
			};
		const a = chain(job("a", 30));
		const b = chain(job("b", 5, true));
		const c = chain(job("c", 1));
		await expect(a).resolves.toBe("a");
		await expect(b).rejects.toThrow("b");
		await expect(c).resolves.toBe("c");
		expect(log).toEqual(["a+", "a-", "b+", "b-", "c+", "c-"]);
	});
});

describe("waitUntil", () => {
	it("returns true as soon as it's done, false after the time is up, and looks again after a throw", async () => {
		let n = 0;
		expect(await waitUntil(() => ++n >= 3, 1000, 1)).toBe(true);
		expect(n).toBe(3);
		expect(await waitUntil(() => false, 20, 5)).toBe(false);
		let m = 0;
		expect(
			await waitUntil(
				() => {
					if (++m < 2) throw new Error("being replaced");
					return true;
				},
				1000,
				1,
			),
		).toBe(true);
	});
});

describe("stall-watch: a chat's state, and when it may be woken", () => {
	it("working while a turn runs or a restart's carry-on is about to start one; idle when open; closed when not loaded", () => {
		// Open, a turn (or a compaction, or a message on its way) running.
		expect(chatStateFrom(true, { awaiting: false })).toBe("working");
		expect(chatStateFrom(true, undefined)).toBe("working");
		// Open, between the attempts of an automatic retry: its turn isn't over (it's in the running list).
		expect(chatStateFrom(false, {})).toBe("working");
		// Open, nothing running, its turn over.
		expect(chatStateFrom(false, undefined)).toBe("idle");
		// Not loaded, but the carry-on is about to reopen it.
		expect(chatStateFrom(undefined, { awaiting: true })).toBe("working");
		// Not loaded: closed (a leftover entry without awaiting can't be running anything).
		expect(chatStateFrom(undefined, undefined)).toBe("closed");
		expect(chatStateFrom(undefined, {})).toBe("closed");
	});

	it("never wakes a working chat, nor one the carry-on left alone at this start until it does something", () => {
		const LEFT = 5_000;
		expect(wakeRefusal({ state: "working", lastActiveAt: 1 })).toBe("the chat is working");
		expect(wakeRefusal({ state: "idle", lastActiveAt: 1 })).toBeUndefined();
		expect(wakeRefusal({ state: "closed" })).toBeUndefined();
		expect(wakeRefusal({ state: "closed", lastActiveAt: LEFT - 1 }, LEFT)).toMatch(/^the carry-on left it alone/);
		expect(wakeRefusal({ state: "closed" }, LEFT)).toMatch(/^the carry-on left it alone/);
		expect(wakeRefusal({ state: "idle", lastActiveAt: LEFT }, LEFT)).toMatch(/^the carry-on left it alone/);
		// The owner opened it and it did something since: it's a chat like any other again.
		expect(wakeRefusal({ state: "idle", lastActiveAt: LEFT + 1 }, LEFT)).toBeUndefined();
		expect(wakeRefusal({ state: "working", lastActiveAt: LEFT + 1 }, LEFT)).toBe("the chat is working");
	});

	it("checks what it hands pi-queue: a known state, and a time only when it is one", () => {
		expect(cleanChatState({ state: "idle", lastActiveAt: 1234.6 })).toEqual({ state: "idle", lastActiveAt: 1235 });
		expect(cleanChatState({ state: "working" })).toEqual({ state: "working" });
		expect(cleanChatState({ state: "busy", lastActiveAt: 5 })).toEqual({ state: "closed", lastActiveAt: 5 });
		expect(cleanChatState({ state: "idle", lastActiveAt: Number.NaN })).toEqual({ state: "idle" });
		expect(cleanChatState({ state: "idle", lastActiveAt: -1 })).toEqual({ state: "idle" });
		expect(cleanChatState({ state: "idle", lastActiveAt: "5" })).toEqual({ state: "idle" });
		expect(cleanChatState(null)).toEqual({ state: "closed" });
	});

	it("queue-turn-since: a working chat's turn start, only from a turn that runs, and checked on the way out", () => {
		// A turn runs: its running-list entry's start.
		expect(turnSinceFrom("working", { startedAt: 1000.4 })).toBe(1000);
		// A restart's carry-over whose turn hasn't started, a compaction alone (not listed), or not working: none.
		expect(turnSinceFrom("working", { startedAt: 1000, awaiting: true })).toBeUndefined();
		expect(turnSinceFrom("working", undefined)).toBeUndefined();
		expect(turnSinceFrom("idle", { startedAt: 1000 })).toBeUndefined();
		expect(turnSinceFrom("closed", { startedAt: 1000 })).toBeUndefined();
		expect(turnSinceFrom("working", { startedAt: Number.NaN })).toBeUndefined();
		expect(turnSinceFrom("working", { startedAt: 0 })).toBeUndefined();
		// pi-queue gets it only with a working chat, as a time.
		expect(cleanChatState({ state: "working", lastActiveAt: 7, turnSince: 5.6 })).toEqual({
			state: "working",
			lastActiveAt: 7,
			turnSince: 6,
		});
		expect(cleanChatState({ state: "idle", lastActiveAt: 7, turnSince: 5 })).toEqual({
			state: "idle",
			lastActiveAt: 7,
		});
		expect(cleanChatState({ state: "working", turnSince: "5" })).toEqual({ state: "working" });
		expect(cleanChatState({ state: "working", turnSince: -1 })).toEqual({ state: "working" });
	});

	it("a wake note is some text of a few lines", () => {
		expect(isWakeNote("[Queue] This chat stopped while its task was still being worked on.")).toBe(true);
		expect(isWakeNote("x".repeat(WAKE_NOTE_MAX))).toBe(true);
		expect(isWakeNote("x".repeat(WAKE_NOTE_MAX + 1))).toBe(false);
		expect(isWakeNote("  \n ")).toBe(false);
		expect(isWakeNote(42)).toBe(false);
		expect(isWakeNote(undefined)).toBe(false);
	});
});

describe("installQueueHost", () => {
	let uninstall: (() => void) | undefined;
	afterEach(() => {
		uninstall?.();
		uninstall = undefined;
	});

	const impl = (): QueueHostImpl & { [k: string]: ReturnType<typeof vi.fn> } => ({
		startChat: vi.fn(async () => ({ sessionFile: "/s/new.jsonl", conversationId: "c9" })),
		runCommand: vi.fn(async () => true),
		closeChat: vi.fn(async () => true),
		chatState: vi.fn(async () => ({ state: "idle" as const, lastActiveAt: 1234 })),
		wakeChat: vi.fn(async () => true),
	});

	it("puts version 1 where pi-queue looks, and passes checked options on", async () => {
		const i = impl();
		uninstall = installQueueHost(i);
		const host = hostOnGlobal();
		expect(host?.v).toBe(1);
		expect(Object.isFrozen(host)).toBe(true);
		await expect(host?.startChat({ ...good, name: " Queue #3:  Fix the page " })).resolves.toEqual({
			sessionFile: "/s/new.jsonl",
			conversationId: "c9",
		});
		expect(i.startChat).toHaveBeenCalledWith(good);
	});

	it("rejects bad options without bothering the server", async () => {
		const i = impl();
		uninstall = installQueueHost(i);
		await expect(hostOnGlobal()?.startChat({ ...good, cwd: "x" })).rejects.toThrow(/absolute/);
		expect(i.startChat).not.toHaveBeenCalled();
	});

	it("turns a throwing server into a rejection, and a failing command or close into false", async () => {
		uninstall = installQueueHost({
			startChat: () => {
				throw new Error("no runtime");
			},
			runCommand: async () => {
				throw new Error("gone");
			},
			closeChat: () => {
				throw new Error("gone");
			},
			chatState: () => {
				throw new Error("gone");
			},
			wakeChat: async () => {
				throw new Error("gone");
			},
		});
		const host = hostOnGlobal();
		await expect(host?.startChat(good)).rejects.toThrow("no runtime");
		await expect(host?.runCommand("/s/a.jsonl", "/queue go")).resolves.toBe(false);
		await expect(host?.closeChat("/s/a.jsonl")).resolves.toBe(false);
		// pi-queue skips a task whose chat it can't look at this time, and records a wake that failed.
		await expect(host?.chatState("/s/a.jsonl")).rejects.toThrow("gone");
		await expect(host?.wakeChat("/s/a.jsonl", "wake up")).resolves.toBe(false);
	});

	it("stall-watch: says how a chat is, checked, and wakes it with a note only", async () => {
		const i = impl();
		uninstall = installQueueHost(i);
		const host = hostOnGlobal();
		await expect(host?.chatState("/s/a.jsonl")).resolves.toEqual({ state: "idle", lastActiveAt: 1234 });
		expect(i.chatState).toHaveBeenCalledWith("/s/a.jsonl");
		await expect(host?.chatState(" ")).rejects.toThrow(/no chat/);
		vi.mocked(i.chatState).mockResolvedValueOnce({ state: "sleeping", lastActiveAt: "soon" } as never);
		await expect(host?.chatState("/s/a.jsonl")).resolves.toEqual({ state: "closed" });
		expect(await host?.wakeChat("/s/a.jsonl", "[Queue] carry on")).toBe(true);
		expect(i.wakeChat).toHaveBeenCalledWith("/s/a.jsonl", "[Queue] carry on");
		expect(await host?.wakeChat("/s/a.jsonl", " ")).toBe(false);
		expect(await host?.wakeChat("/s/a.jsonl", "x".repeat(WAKE_NOTE_MAX + 1))).toBe(false);
		expect(await host?.wakeChat("", "[Queue] carry on")).toBe(false);
		expect(i.wakeChat).toHaveBeenCalledTimes(1);
		// The server refusing (the chat is working) comes back as false.
		vi.mocked(i.wakeChat).mockResolvedValueOnce(false);
		expect(await host?.wakeChat("/s/a.jsonl", "[Queue] carry on")).toBe(false);
	});

	it("only runs /queue commands, for a real chat", async () => {
		const i = impl();
		uninstall = installQueueHost(i);
		const host = hostOnGlobal();
		expect(await host?.runCommand("/s/a.jsonl", "/queue sync 3 /s/b.jsonl")).toBe(true);
		expect(await host?.runCommand("/s/a.jsonl", "tell me a secret")).toBe(false);
		expect(await host?.runCommand("", "/queue go")).toBe(false);
		expect(await host?.closeChat("  ")).toBe(false);
		expect(i.runCommand).toHaveBeenCalledTimes(1);
		expect(i.closeChat).not.toHaveBeenCalled();
	});

	it("task-question decisions: hands pi-queue the coordinator as a fresh frozen copy; a bad or throwing one is none; no impl, no function", () => {
		uninstall = installQueueHost(impl());
		expect("coordinator" in (hostOnGlobal() as object)).toBe(false);
		uninstall();
		const coord = vi.fn(() => ({ id: "ops" as const, file: "/s/ops.jsonl", title: "Ops lead" }));
		uninstall = installQueueHost({ ...impl(), coordinator: coord });
		const host = hostOnGlobal() as QueueHost & { coordinator(): unknown };
		const a = host.coordinator();
		expect(a).toEqual({ id: "ops", file: "/s/ops.jsonl", title: "Ops lead" });
		expect(Object.isFrozen(a)).toBe(true);
		expect(host.coordinator()).not.toBe(a);
		coord.mockReturnValueOnce({ id: "qa", file: "/s/qa.jsonl" } as never);
		expect(host.coordinator()).toBeUndefined();
		coord.mockReturnValueOnce({ id: "ops", file: "relative.jsonl" } as never);
		expect(host.coordinator()).toBeUndefined();
		coord.mockReturnValueOnce(undefined as never);
		expect(host.coordinator()).toBeUndefined();
		coord.mockImplementationOnce(() => {
			throw new Error("registry gone");
		});
		expect(host.coordinator()).toBeUndefined();
		expect(host.coordinator()).toEqual({ id: "ops", file: "/s/ops.jsonl", title: "Ops lead" });
		// No Ops role on this machine at all: said so, for pi-queue's older flow.
		coord.mockReturnValueOnce("none" as never);
		expect(host.coordinator()).toBe("none");
	});

	it("takes down only its own host", () => {
		const first = installQueueHost(impl());
		const second = installQueueHost(impl());
		const current = hostOnGlobal();
		first();
		expect(hostOnGlobal()).toBe(current);
		second();
		expect(hostOnGlobal()).toBeUndefined();
	});
});

describe("queueCoordinator (rule 21: who decides queued tasks' questions)", () => {
	const on = (f: string) => f.startsWith("/home/");
	const ops = { id: "ops", title: " Ops lead ", homeChat: "/home/u/.pi/sessions/ops.jsonl" };
	it("is the role ops's home chat from the identity files, only when its transcript is on disk", () => {
		expect(queueCoordinator([{ id: "qa", homeChat: "/home/u/qa.jsonl" }, ops], on)).toEqual({
			id: "ops",
			file: "/home/u/.pi/sessions/ops.jsonl",
			title: "Ops lead",
		});
		expect(queueCoordinator([{ ...ops, title: undefined }], on)).toEqual({ id: "ops", file: ops.homeChat });
	});
	it("is none without role ops, without a home chat, with a relative, too long or missing transcript", () => {
		// Only the role id "ops" counts: a role titled Ops, or another role's home, never does.
		expect(queueCoordinator([{ id: "qa", title: "Ops", homeChat: "/home/u/qa.jsonl" }], on)).toBeUndefined();
		expect(queueCoordinator([{ ...ops, homeChat: null }], on)).toBeUndefined();
		expect(queueCoordinator([{ ...ops, homeChat: "ops.jsonl" }], on)).toBeUndefined();
		expect(queueCoordinator([{ ...ops, homeChat: `/home/${"x".repeat(1000)}` }], on)).toBeUndefined();
		expect(queueCoordinator([{ ...ops, homeChat: "/gone/ops.jsonl" }], on)).toBeUndefined();
		expect(queueCoordinator([], on)).toBeUndefined();
	});
	it('is "none" only with no Ops role and no identities/ops folder; a folder whose role didn\'t load still waits', () => {
		expect(queueCoordinator([{ id: "qa", homeChat: "/home/u/qa.jsonl" }], on, false)).toBe("none");
		expect(queueCoordinator([], on, false)).toBe("none");
		expect(queueCoordinator([], on, true)).toBeUndefined();
		expect(queueCoordinator([{ ...ops, homeChat: null }], on, false)).toBeUndefined();
		expect(queueCoordinator([ops], on, false)).toMatchObject({ id: "ops" });
	});
});
