/**
 * queue-lanes: server/queue-host.ts, what pi-web-ui offers pi-queue for running queued tasks in chats
 * of their own. These tests cover the glue (checking what the extension hands in, keeping the order,
 * putting the host where pi-queue looks). The chats themselves are covered by tests/queue-lanes-test.mjs.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	installQueueHost,
	isQueueCommand,
	makeChain,
	parseQueueChatStart,
	QUEUE_HOST_KEY,
	type QueueHost,
	type QueueHostImpl,
	waitUntil,
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
		});
		const host = hostOnGlobal();
		await expect(host?.startChat(good)).rejects.toThrow("no runtime");
		await expect(host?.runCommand("/s/a.jsonl", "/queue go")).resolves.toBe(false);
		await expect(host?.closeChat("/s/a.jsonl")).resolves.toBe(false);
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
