import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { characterCounts, emptyCharacterCounts } from "../../server/agent-text-classes.js";
import { agentTextSummary, boardPostSizes, roleMessageSizes, sizesInWindow } from "../../server/agent-text-stats.js";

const row = (text: string, at = 1, extra: object = {}) => ({
	text,
	at,
	kind: "request",
	from: { role: "ops" },
	to: { role: "qa" },
	...extra,
});
const repeated = "The quick brown fox jumps over the lazy dog.";

function expectCounts(text: string, counts: Partial<ReturnType<typeof emptyCharacterCounts>>) {
	const actual = characterCounts(text);
	expect(actual).toEqual({ ...emptyCharacterCounts(), ...counts });
	expect(Object.values(actual).reduce((a, b) => a + b, 0)).toBe(text.length);
}

describe("exclusive character accounting", () => {
	it("uses exact UTF-16 counts, including whitespace and surrogate pairs", () => {
		expectCounts("hello 😀\n", { plainProse: 9 });
		expectCounts("", {});
	});
	it("recognises each native identifier and the 7..64 hex boundaries", () => {
		const ids = [
			"abcdef0",
			"a".repeat(64),
			"rm-deadbeef",
			"bp-1234abcd",
			"dr-abc",
			"cr-abc",
			"#728",
			"n526",
			"d290",
			"k1234abcd",
			"l1234abcde",
		];
		for (const id of ids) expectCounts(id, { hashesAndIds: id.length });
		for (const notId of ["abcdef", "a".repeat(65), "wordn526", "k1234567"])
			expectCounts(notId, { plainProse: notId.length });
	});
	it("recognises paths and URLs, while IDs win inside them", () => {
		for (const path of ["/home/alice/file.ts", "~/file.md", "server/file.ts", "https://example.org/a"])
			expectCounts(path, { pathsAndUrls: path.length });
		expectCounts("`src/abcdef0.ts`", { hashesAndIds: 7, pathsAndUrls: 7, codeAndMarkup: 2 });
	});
	it("counts fenced/inline code and markup punctuation before quotes", () => {
		expectCounts("```js\nhi\n```", { codeAndMarkup: 12 });
		expectCounts("~~~\nhi\n~~~", { codeAndMarkup: 10 });
		expectCounts("`hello`", { codeAndMarkup: 7 });
		expectCounts("## Title\n- item\n1. item", { codeAndMarkup: 5, plainProse: 18 });
		expectCounts("{key=value}|[x]:", { codeAndMarkup: 7, plainProse: 9 });
		expectCounts('"long quoted words"', { quotes: 19 });
		expectCounts('"short"', { plainProse: 7 });
		expectCounts("> hello\nend", { quotes: 7, plainProse: 4 });
	});
});

describe("thread history, never text in returned values", () => {
	it("counts only an earlier related message, never itself, same-depth chains or an unrelated pair", () => {
		const rows = roleMessageSizes([
			row(repeated, 1, { id: "one", chain: 1 }),
			row("An entirely different sentence never seen before.", 2, { id: "two", replyTo: "one" }),
			row(repeated, 3, { id: "three", chain: 1, from: { role: "coo" } }),
		]);
		expect(rows.map((s) => s.classes!.repeatedInThread)).toEqual([0, 0, 0]);
		expect(roleMessageSizes([row(`${repeated}\n${repeated}`)])[0]!.classes!.repeatedInThread).toBe(0);
	});
	it("uses reply ancestry/root/parent and prior context outside the selected window", () => {
		const rows = roleMessageSizes([
			row(repeated, 30, { id: "c", parent: "b", from: { role: "coo" } }),
			row(repeated, 10, { id: "a", root: "root-one" }),
			row("unrelated fresh text", 20, { id: "b", replyTo: "a" }),
			row(repeated, 40, { id: "d", root: "root-one", from: { role: "design" } }),
		]);
		expect(sizesInWindow(rows, 30, 41).map((s) => s.classes!.repeatedInThread)).toEqual([
			repeated.length,
			repeated.length,
		]);
	});
	it("separates explicit links from the pair heuristic, without double counting", () => {
		const rows = roleMessageSizes([
			row(repeated, 1, { id: "a" }),
			row(repeated, 2, { id: "b" }),
			row(repeated, 3, { id: "c", replyTo: "a" }),
		]);
		expect(rows.map((s) => s.repetition)).toEqual([
			{ explicitlyLinkedChars: 0, pairFallbackOnlyChars: 0 },
			{ explicitlyLinkedChars: 0, pairFallbackOnlyChars: repeated.length },
			{ explicitlyLinkedChars: repeated.length, pairFallbackOnlyChars: 0 },
		]);
		for (const r of rows)
			expect(Object.values(r.repetition!).reduce((a, b) => a + b, 0)).toBe(r.classes!.repeatedInThread);
		const summary = agentTextSummary(rows, []).messages.characterClasses;
		expect(summary.repetition).toEqual({
			explicitlyLinkedChars: repeated.length,
			pairFallbackOnlyChars: repeated.length,
		});
		expect(summary.byKind.request!.repetition).toEqual(summary.repetition);
		expect(summary.bySender.ops!.repetition).toEqual(summary.repetition);
	});
	it("matches 40+ substrings within changed lines; unions overlap, not adjacent messages", () => {
		const rows = roleMessageSizes([row(`old ${repeated} ending`, 1), row(`new ${repeated} final`, 2)]);
		expect(rows[1]!.classes!.repeatedInThread).toBe(repeated.length + 2); // surrounding spaces also match
		const split = roleMessageSizes([row(repeated.slice(0, 20), 1), row(repeated.slice(20), 2), row(repeated, 3)]);
		expect(split[2]!.classes!.repeatedInThread).toBe(0);
	});
	it("matches short exact nonblank lines, but pair context expires after 24h", () => {
		const day = 86_400_000;
		const rows = roleMessageSizes([
			row("short\n\n", 1),
			row("short\n\n", day + 1, { from: { role: "qa" }, to: { role: "ops" } }),
			row("short\n\n", 2 * day + 2),
		]);
		expect(rows.map((s) => s.classes!.repeatedInThread)).toEqual([0, 5, 0]);
	});
	it("does not count IDs, paths or quotes a second time as repetition", () => {
		const text = `rm-abc /home/alice/file "long quoted words" ${repeated}`;
		const rows = roleMessageSizes([row(text, 1), row(text, 2)]);
		expect(rows[1]!.classes!.plainProse).toBe(0);
		for (const r of rows) expect(Object.values(r.classes!).reduce((a, b) => a + b, 0)).toBe(r.chars);
		expect(rows[1]!.classes!.hashesAndIds).toBe(6);
		expect(JSON.stringify(rows)).not.toContain(repeated);
	});
	it("excludes app/invalid records; missing endpoints and cyclic links are safe", () => {
		const rows = roleMessageSizes([
			row(repeated, 0, { from: { role: "app" } }),
			row(repeated, NaN),
			null,
			{ text: repeated },
			row(repeated, 1, { from: undefined, id: "a", replyTo: "b" }),
			row(repeated, 2, { from: undefined, id: "b", replyTo: "a" }),
		]);
		expect(rows).toHaveLength(2);
		expect(rows.map((s) => s.classes!.repeatedInThread)).toEqual([0, 0]);
	});
});

describe("class summaries and CLI privacy", () => {
	it("reports totals, per-message nearest-rank medians and character-weighted shares by kind/sender", () => {
		const summary = agentTextSummary(
			roleMessageSizes([row("#123 abc", 1), row("hello", 2, { kind: "reply", from: { role: "qa" } })]),
			boardPostSizes([{ text: "news", at: 1, kind: "news", from: "owner", via: "coo", title: "excluded" }]),
		);
		const s = summary.messages.characterClasses;
		expect(s).toMatchObject({ n: 2, totalChars: 13 });
		expect(s.classes.hashesAndIds).toEqual({ chars: 4, median: 0, share: 4 / 13 });
		expect(s.byKind.request!.classes.hashesAndIds.share).toBe(0.5);
		expect(s.bySender.qa!.classes.plainProse.chars).toBe(5);
		expect(summary.board.characterClasses.bySender.coo!.totalChars).toBe(4);
		expect(Object.values(s.classes).reduce((a, b) => a + b.chars, 0)).toBe(s.totalChars);
		expect(Object.values(s.classes).reduce((a, b) => a + b.share!, 0)).toBeCloseTo(1);
		expect(agentTextSummary([], []).messages.characterClasses.classes.plainProse.share).toBeNull();
	});
	it("CLI emits only counts/metadata and sanitizes malformed-JSON errors", () => {
		const dir = mkdtempSync(join(tmpdir(), "agent-text-classes-"));
		const secret = "SYNTHETIC_PRIVATE_MESSAGE_CONTENT";
		try {
			writeFileSync(join(dir, "role-messages.json"), JSON.stringify({ messages: [row(secret)] }));
			writeFileSync(join(dir, "role-board.json"), '{"posts":[]}');
			const args = [
				"--import",
				"tsx",
				"scripts/agent-text-stats.mts",
				"--data",
				dir,
				"--since",
				"1970-01-01T00:00:00Z",
				"--until",
				"1970-01-02T00:00:00Z",
			];
			const output = execFileSync(process.execPath, args, { encoding: "utf8" });
			expect(output).not.toContain(secret);
			expect(JSON.parse(output).messages.characterClasses.totalChars).toBe(secret.length);
			writeFileSync(join(dir, "role-messages.json"), secret);
			const bad = spawnSync(process.execPath, args, { encoding: "utf8" });
			expect(bad.status).toBe(2);
			expect(bad.stderr).toContain("invalid JSON");
			expect(bad.stderr + bad.stdout).not.toContain(secret);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
