/**
 * rewind 单测：「回到这里」的落点与保留条数、「对话太大」卡片的建议位置、报错识别、气泡 id 解析。
 * 纯逻辑零 token；E2E（真服务 + 假 provider + 浏览器）在 tests/rewind-to-here-test.mjs。
 */
import { describe, expect, it } from "vitest";
import {
	type ContextItem,
	droppedMessageCount,
	findItemIndex,
	formatMb,
	measureTooBig,
	planRewind,
	REQUEST_LIMIT_BYTES,
	sizeOf,
	suggestRewindIndex,
	tooBigKind,
} from "../../server/rewind.js";

const MB = 1024 * 1024;
let ts = 1000;
const user = (text: string, extra: Record<string, unknown> = {}): ContextItem => ({
	entryId: `e${ts}`,
	message: { role: "user", content: [{ type: "text", text }], timestamp: ts++, ...extra } as never,
});
const reply = (text: string): ContextItem => ({
	entryId: `e${ts}`,
	message: { role: "assistant", content: [{ type: "text", text }], stopReason: "stop", timestamp: ts++ } as never,
});
const call = (id: string): ContextItem => ({
	entryId: `e${ts}`,
	message: {
		role: "assistant",
		content: [{ type: "toolCall", id, name: "bash", arguments: {} }],
		stopReason: "toolUse",
		timestamp: ts++,
	} as never,
});
/** A tool result, optionally carrying a picture of about `mb` megabytes. */
const result = (id: string, mb = 0): ContextItem => ({
	entryId: `e${ts}`,
	message: {
		role: "toolResult",
		toolCallId: id,
		content: mb
			? [
					{ type: "text", text: "screenshot" },
					{ type: "image", mimeType: "image/png", data: "A".repeat(Math.round(mb * MB)) },
				]
			: [{ type: "text", text: "ok" }],
		timestamp: ts++,
	} as never,
});

describe("planRewind", () => {
	const items = [user("one"), reply("answer one"), user("two"), call("c1"), result("c1"), reply("answer two")];

	it("a question: go back to before it, and its text returns to the box", () => {
		expect(planRewind(items, 2)).toEqual({
			index: 2,
			navigateEntryId: items[2].entryId,
			keepCount: 2,
			toComposer: true,
			editorText: "two",
		});
	});

	it("an answer: keep it and everything before it", () => {
		expect(planRewind(items, 1)).toMatchObject({ navigateEntryId: items[1].entryId, keepCount: 2, toComposer: false });
	});

	it("an answer with tool calls keeps its own tool results", () => {
		expect(planRewind(items, 3)).toMatchObject({ navigateEntryId: items[4].entryId, keepCount: 5, toComposer: false });
	});

	it("out of range → null", () => {
		expect(planRewind(items, 99)).toBeNull();
	});
});

describe("droppedMessageCount", () => {
	it("counts questions and answers after the kept part, not tool results", () => {
		const items = [user("one"), reply("a"), user("two"), call("c1"), result("c1"), reply("b")];
		expect(droppedMessageCount(items, 2)).toBe(3);
		expect(droppedMessageCount(items, items.length)).toBe(0);
	});
});

describe("sizeOf", () => {
	it("counts pictures inside tool results and the JSON bytes", () => {
		const items = [user("hi"), call("c1"), result("c1", 1), result("c1", 1)];
		const s = sizeOf(items.map((i) => i.message));
		expect(s.images).toBe(2);
		expect(s.bytes).toBeGreaterThan(2 * MB);
		expect(s.bytes).toBeLessThan(2 * MB + 4096);
	});
});

describe("suggestRewindIndex", () => {
	it("picks the newest finished answer whose kept part fits", () => {
		const items = [
			user("start"),
			call("c1"),
			result("c1", 6),
			reply("done one"), // kept ≈ 6 MB
			user("next"),
			call("c2"),
			result("c2", 6),
			reply("done two"), // kept ≈ 12 MB
			user("more"),
			call("c3"),
			result("c3", 6),
			call("c4"),
			result("c4", 6), // ≈ 24 MB+ from here on
			reply("done three"),
		];
		expect(suggestRewindIndex(items, 13 * MB)).toBe(7);
		expect(suggestRewindIndex(items, 7 * MB)).toBe(3);
	});

	it("falls back to a mid-task answer, then to a question", () => {
		const midTask = [user("start"), call("c1"), result("c1", 1), call("c2"), result("c2", 6)];
		expect(suggestRewindIndex(midTask, 2 * MB)).toBe(1);
		const onlyQuestions = [user("first"), user("second", { content: [{ type: "text", text: "x".repeat(3 * MB) }] })];
		expect(suggestRewindIndex(onlyQuestions, 2 * MB)).toBe(1);
	});

	it("never suggests a place that skips nothing, and gives up when nothing fits", () => {
		expect(suggestRewindIndex([reply("a")], 24 * MB)).toBeNull();
		expect(suggestRewindIndex([user("q"), reply("a")], 24 * MB)).toBe(0);
		const huge = [user("q", { content: [{ type: "text", text: "x".repeat(3 * MB) }] }), reply("a"), user("b")];
		expect(suggestRewindIndex(huge, 1 * MB)).toBe(0);
		expect(suggestRewindIndex([call("c1"), result("c1", 3), reply("a")], 1 * MB)).toBeNull();
	});
});

describe("tooBigKind", () => {
	it("recognises a request that is too big", () => {
		expect(
			tooBigKind(
				'413 {"type":"error","error":{"type":"request_too_large","message":"Request exceeds the maximum size"}}',
			),
		).toBe("bytes");
		expect(tooBigKind("Payload Too Large")).toBe("bytes");
	});
	it("recognises a context window overflow", () => {
		expect(tooBigKind("prompt is too long: 250000 tokens > 200000 maximum")).toBe("tokens");
		expect(tooBigKind("This model's maximum context length is 128000 tokens")).toBe("tokens");
	});
	it("leaves other errors alone", () => {
		expect(tooBigKind("529 overloaded_error")).toBeNull();
		expect(tooBigKind("rate limit: 413 requests left")).toBeNull();
		expect(tooBigKind(undefined)).toBeNull();
	});
});

describe("findItemIndex", () => {
	const q1 = user("same time one");
	const q2 = { ...user("same time two") };
	(q2.message as { timestamp: number }).timestamp = (q1.message as { timestamp: number }).timestamp;
	const a = reply("answer");
	const c = call("tc-9");
	const r = result("tc-9");
	const items = [q1, q2, a, c, r];
	const at = (i: ContextItem) => (i.message as { timestamp: number }).timestamp;

	it("finds questions by time and order", () => {
		expect(findItemIndex(items, `u-${at(q1)}`)).toBe(0);
		expect(findItemIndex(items, `u-${at(q1)}-2`)).toBe(1);
		expect(findItemIndex(items, `u-${at(q1)}-3`)).toBeNull();
	});
	it("finds answers and tool results", () => {
		expect(findItemIndex(items, `a-${at(a)}-7`)).toBe(2);
		expect(findItemIndex(items, "t-tc-9")).toBe(4);
	});
	it("returns null for streaming or unknown ids", () => {
		expect(findItemIndex(items, "stream-1")).toBeNull();
		expect(findItemIndex(items, "a-1-1")).toBeNull();
	});
});

describe("measureTooBig", () => {
	it("gives the card its size, picture count, limit and a place to go back to", () => {
		const items = [
			user("start"),
			call("c1"),
			result("c1", 2),
			reply("first part done"),
			user("go on"),
			call("c2"),
			result("c2", 2),
		];
		const card = measureTooBig(items, "bytes", "413 request_too_large", { now: 5, fitBytes: 3 * MB });
		expect(card).toMatchObject({ kind: "bytes", images: 2, limitBytes: REQUEST_LIMIT_BYTES, at: 5 });
		expect(card.bytes).toBeGreaterThan(4 * MB);
		expect(card.suggest).toMatchObject({ role: "assistant", text: "first part done", dropCount: 2, keepImages: 1 });
		expect(card.suggest?.keepBytes).toBeLessThanOrEqual(3 * MB);
	});
});

describe("formatMb", () => {
	it("rounds big sizes and keeps one decimal for small ones", () => {
		expect(formatMb(42.4 * MB)).toBe("42 MB");
		expect(formatMb(1.26 * MB)).toBe("1.3 MB");
	});
});
