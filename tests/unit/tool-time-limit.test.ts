/** Ops #863: the owner's 2-minute limit on google_search and queue_reply (server/tool-time-limit.ts). */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TOOL_TIME_LIMITS, toolTimeLimitMs, toolTimeLimitSpecs, withTimeLimit } from "../../server/tool-time-limit.js";
import { installToolOverrides, type AnyToolDefinition, type OverrideSessionLike } from "../../server/tool-overrides.js";

type Exec = (id: string, params: unknown, signal?: AbortSignal, onUpdate?: unknown, ctx?: unknown) => Promise<unknown>;
const tool = (name: string, execute: Exec) =>
	({
		name,
		label: name,
		description: name,
		parameters: { type: "object", properties: {} },
		execute,
	}) as unknown as AnyToolDefinition;
const run = (t: AnyToolDefinition, signal?: AbortSignal, onUpdate?: unknown) =>
	(t.execute as Exec)("call-1", {}, signal, onUpdate, {}) as Promise<{
		isError?: boolean;
		content: Array<{ text: string }>;
		details?: unknown;
	}>;
const never: Exec = () => new Promise(() => {});

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("the limits", () => {
	it("are 120 s for exactly google_search and queue_reply, with the owner-approved words", () => {
		expect(Object.keys(TOOL_TIME_LIMITS).sort()).toEqual(["google_search", "queue_reply"]);
		expect(toolTimeLimitMs("google_search", {})).toBe(120_000);
		expect(toolTimeLimitMs("queue_reply", {})).toBe(120_000);
		expect(toolTimeLimitMs("bash", {})).toBeUndefined();
		expect(TOOL_TIME_LIMITS.google_search!.words).toBe(
			"Search gave no answer within 2 minutes; try again or use another search tool.",
		);
		expect(TOOL_TIME_LIMITS.queue_reply!.words).toBe(
			"No answer within 2 minutes. It may still have gone through: check the task (queue list / roles_overview) before replying again.",
		);
	});

	it("PI_WEB_TOOL_TIME_LIMIT_MS sets them for tests; nonsense is ignored", () => {
		expect(toolTimeLimitMs("queue_reply", { PI_WEB_TOOL_TIME_LIMIT_MS: "3000" })).toBe(3000);
		expect(toolTimeLimitMs("queue_reply", { PI_WEB_TOOL_TIME_LIMIT_MS: "x" })).toBe(120_000);
		expect(toolTimeLimitMs("queue_reply", { PI_WEB_TOOL_TIME_LIMIT_MS: "0" })).toBe(120_000);
		expect(toolTimeLimitMs("bash", { PI_WEB_TOOL_TIME_LIMIT_MS: "3000" })).toBeUndefined();
	});
});

describe("withTimeLimit", () => {
	it("a tool that never settles returns an error result at the limit, and its own abort signal fires", async () => {
		let seen: AbortSignal | undefined;
		const limited = withTimeLimit(
			tool("google_search", (_i, _p, s) => ((seen = s), never("", {}))),
			1000,
			"too slow",
		);
		let result: Awaited<ReturnType<typeof run>> | undefined;
		void run(limited).then((r) => (result = r));
		await vi.advanceTimersByTimeAsync(999);
		expect(result).toBeUndefined();
		expect(seen?.aborted).toBe(false);
		await vi.advanceTimersByTimeAsync(1);
		expect(result).toEqual({
			content: [{ type: "text", text: "too slow" }],
			details: { timedOut: true, limitMs: 1000 },
			isError: true,
		});
		expect(seen?.aborted).toBe(true);
	});

	it("a tool that answers in time is untouched: its result, its error, no abort", async () => {
		let seen: AbortSignal | undefined;
		const ok = withTimeLimit(
			tool("t", async (_i, _p, s) => ((seen = s), { content: [{ type: "text", text: "hi" }] })),
			1000,
			"x",
		);
		await expect(run(ok)).resolves.toEqual({ content: [{ type: "text", text: "hi" }] });
		await vi.advanceTimersByTimeAsync(5000);
		expect(seen?.aborted).toBe(false);
		const bad = withTimeLimit(
			tool("t", async () => {
				throw new Error("boom");
			}),
			1000,
			"x",
		);
		await expect(run(bad)).rejects.toThrow("boom");
		expect(vi.getTimerCount()).toBe(0);
	});

	it("Stop still reaches the tool: the turn's abort is passed on", async () => {
		const stop = new AbortController();
		let seen: AbortSignal | undefined;
		const limited = withTimeLimit(
			tool(
				"t",
				(_i, _p, s) =>
					new Promise((_r, reject) => ((seen = s), s?.addEventListener("abort", () => reject(new Error("aborted"))))),
			),
			1000,
			"x",
		);
		const p = run(limited, stop.signal);
		stop.abort();
		await expect(p).rejects.toThrow("aborted");
		expect(seen?.aborted).toBe(true);
	});

	it("a run that fails after the limit is swallowed, and late progress is dropped", async () => {
		const updates: unknown[] = [];
		let late: ((v: unknown) => void) | undefined;
		let fail: ((e: Error) => void) | undefined;
		let update: ((u: unknown) => void) | undefined;
		const limited = withTimeLimit(
			tool(
				"t",
				(_i, _p, _s, onUpdate) =>
					new Promise((res, rej) => ((late = res), (fail = rej), (update = onUpdate as typeof update))),
			),
			1000,
			"x",
		);
		const p = run(limited, undefined, (u: unknown) => updates.push(u));
		update?.("early");
		await vi.advanceTimersByTimeAsync(1000);
		expect((await p).isError).toBe(true);
		update?.("late");
		fail?.(new Error("after the limit"));
		late?.("ignored");
		await vi.advanceTimersByTimeAsync(0);
		expect(updates).toEqual(["early"]);
	});
});

describe("toolTimeLimitSpecs through installToolOverrides", () => {
	it("is laid over the add-on's own tool of that name, and adds or removes nothing where there is none", async () => {
		const search = tool("google_search", never);
		const session: OverrideSessionLike = {
			extensionRunner: { getAllRegisteredTools: () => [{ definition: search }] },
			_customTools: [tool("bash", never), tool("queue_reply", never)],
			_refreshToolRegistry() {},
		};
		const names = installToolOverrides(session, toolTimeLimitSpecs({ PI_WEB_TOOL_TIME_LIMIT_MS: "50" }));
		expect(names).toEqual(["google_search"]);
		const custom = session._customTools ?? [];
		expect(custom.map((t) => t.name)).toEqual(["google_search", "bash", "queue_reply"]);
		const limited = custom[0]!;
		expect(limited).not.toBe(search);
		expect(limited.description).toBe(search.description);
		const p = run(limited);
		await vi.advanceTimersByTimeAsync(50);
		expect((await p).content[0]!.text).toBe(TOOL_TIME_LIMITS.google_search!.words);
	});
});
