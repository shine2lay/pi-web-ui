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
	type QueueHost,
	type QueueHostImpl,
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
