/**
 * about-drafts: the line diff behind a role draft's "What changes" view (web/src/line-diff.ts).
 */
import { describe, expect, it } from "vitest";
import { diffCounts, foldDiff, lineDiff } from "../../web/src/line-diff.js";

const kinds = (before: string, after: string) => lineDiff(before, after).map((l) => `${l.kind}:${l.text}`);

describe("lineDiff", () => {
	it("marks each line same, removed or added, in order", () => {
		expect(kinds("a\nb\nc\n", "a\nB\nc\n")).toEqual(["same:a", "del:b", "add:B", "same:c"]);
		expect(kinds("a\nc\n", "a\nb\nc\n")).toEqual(["same:a", "add:b", "same:c"]);
		expect(kinds("a\nb\nc\n", "a\nc\n")).toEqual(["same:a", "del:b", "same:c"]);
	});

	it("keeps the common lines when the changes are spread out", () => {
		expect(kinds("x\na\ny\nb\nz", "a\nq\nb\nz\nw")).toEqual([
			"del:x",
			"same:a",
			"del:y",
			"add:q",
			"same:b",
			"same:z",
			"add:w",
		]);
	});

	it("a page from nothing is all added; to nothing, all removed; the same text, no change", () => {
		expect(kinds("", "x\ny\n")).toEqual(["add:x", "add:y"]);
		expect(kinds("x\n", "")).toEqual(["del:x"]);
		const same = lineDiff("a\nb\n", "a\nb");
		expect(diffCounts(same)).toEqual({ added: 0, removed: 0 });
		// Windows line ends don't count as changes.
		expect(diffCounts(lineDiff("a\r\nb\r\n", "a\nb\n"))).toEqual({ added: 0, removed: 0 });
	});

	it("past its size limit it still shows every change (all removed, then all added)", () => {
		const before = Array.from({ length: 2100 }, (_, i) => `old ${i}`).join("\n");
		const after = Array.from({ length: 2100 }, (_, i) => `new ${i}`).join("\n");
		const lines = lineDiff(`head\n${before}\ntail`, `head\n${after}\ntail`);
		expect(diffCounts(lines)).toEqual({ added: 2100, removed: 2100 });
		expect(lines[0]).toEqual({ kind: "same", text: "head" });
		expect(lines.at(-1)).toEqual({ kind: "same", text: "tail" });
	});
});

describe("foldDiff", () => {
	it("folds long unchanged stretches, keeping 3 lines around each change", () => {
		const before = Array.from({ length: 20 }, (_, i) => `line ${i}`);
		const after = [...before];
		after[10] = "changed";
		const rows = foldDiff(lineDiff(before.join("\n"), after.join("\n")));
		expect(rows.map((r) => (r.kind === "skip" ? `skip:${r.count}` : `${r.kind}:${r.text}`))).toEqual([
			"skip:7",
			"same:line 7",
			"same:line 8",
			"same:line 9",
			"del:line 10",
			"add:changed",
			"same:line 11",
			"same:line 12",
			"same:line 13",
			"skip:6",
		]);
	});

	it("an unchanged text folds into one stretch", () => {
		expect(foldDiff(lineDiff("a\nb\n", "a\nb\n"))).toEqual([{ kind: "skip", count: 2 }]);
	});
});
