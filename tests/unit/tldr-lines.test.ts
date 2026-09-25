/**
 * tldr-panel：会话分支条目 → 右栏 TL;DR 行（server/tldr-lines.ts）。
 * 条目格式是和 pi-tldr 扩展的约定：{ type: "custom", customType: "tldr", data: { v, text, needsYou, ts } }。
 */
import { describe, expect, it } from "vitest";
import { TLDR_MAX_LINES, tldrLinesFromEntries, type TldrEntryLike } from "../../server/tldr-lines.js";

const line = (id: string, text: string, extra: Record<string, unknown> = {}): TldrEntryLike => ({
	type: "custom",
	id,
	customType: "tldr",
	data: { v: 1, text, needsYou: false, ts: 1000 + Number(id.replace(/\D/g, "") || 0), ...extra },
	timestamp: "2026-09-24T12:00:00.000Z",
});

describe("tldrLinesFromEntries", () => {
	it("keeps only tldr custom entries, in branch order", () => {
		const entries: TldrEntryLike[] = [
			{ type: "message", id: "m1" },
			line("t1", "Looking into why the page loads twice"),
			{ type: "custom", id: "c1", customType: "manual-retry", data: { text: "not a tldr" } },
			{ type: "compaction", id: "k1" },
			line("t2", "Found it: two version numbers never match", { needsYou: true }),
		];
		expect(tldrLinesFromEntries(entries)).toEqual([
			{ id: "t1", text: "Looking into why the page loads twice", needsYou: false, ts: 1001 },
			{ id: "t2", text: "Found it: two version numbers never match", needsYou: true, ts: 1002 },
		]);
	});

	it("skips bad data instead of throwing", () => {
		const entries: TldrEntryLike[] = [
			{ type: "custom", id: "a", customType: "tldr" },
			{ type: "custom", id: "b", customType: "tldr", data: { text: "   " } },
			{ type: "custom", id: "c", customType: "tldr", data: { text: 42 } },
			{ type: "custom", customType: "tldr", data: { text: "no id" } },
			{ type: "custom", id: "d", customType: "tldr", data: "just a string" },
			line("t9", "  ok  ", { needsYou: "yes" }),
		];
		expect(tldrLinesFromEntries(entries)).toEqual([{ id: "t9", text: "ok", needsYou: false, ts: 1009 }]);
	});

	it("falls back to the entry timestamp when data.ts is missing", () => {
		const [l] = tldrLinesFromEntries([
			{ type: "custom", id: "x", customType: "tldr", data: { text: "hi" }, timestamp: "2026-09-24T12:00:00.000Z" },
		]);
		expect(l.ts).toBe(Date.parse("2026-09-24T12:00:00.000Z"));
	});

	it("keeps the newest lines when over the cap, and trims runaway text", () => {
		const many = Array.from({ length: TLDR_MAX_LINES + 3 }, (_, i) => line(`t${i}`, `line ${i}`));
		const out = tldrLinesFromEntries(many);
		expect(out).toHaveLength(TLDR_MAX_LINES);
		expect(out[0].text).toBe("line 3");
		expect(out.at(-1)?.text).toBe(`line ${TLDR_MAX_LINES + 2}`);

		const [long] = tldrLinesFromEntries([line("t1", "x".repeat(1000))]);
		expect(long.text.length).toBe(401);
		expect(long.text.endsWith("…")).toBe(true);
	});
});
