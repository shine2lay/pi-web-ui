import { describe, expect, it } from "vitest";
import { codeRanges, parseMarkers, stripMarkers } from "../../server/markers/marker.js";

/**
 * markers-skip-code：代码块、行内代码里的标记只是文字，不执行。
 *
 * 2026-09-24 实际遇到：AI 把系统提示词贴进回答（放在代码块里），里面的标记示例照样执行了——
 * 对话被改名成「…」，还多了一条空任务。
 */
const raws = (text: string) => parseMarkers(text).map((t) => t.raw);

describe("parseMarkers skips code", () => {
	it("still runs a marker in plain text", () => {
		const [t] = parseMarkers("Done. [[todo:new:alpha task]]");
		expect(t).toMatchObject({ tool: "todo", op: "new", args: ["alpha task"] });
	});

	it("skips a marker inside a ``` block and runs the one after it", () => {
		const text = "Example:\n```\n[[conv:rename:<new title>]]\n```\nReal one [[todo:new:y]]";
		expect(raws(text)).toEqual(["[[todo:new:y]]"]);
	});

	it("skips a marker inside a ~~~ block", () => {
		expect(raws("~~~text\n[[todo:new:x]]\n~~~\n")).toEqual([]);
	});

	it("treats an unclosed fence as code to the end", () => {
		expect(raws("before\n```\n[[todo:new:x]]\nmore [[notify:info:hi]]")).toEqual([]);
	});

	it("allows up to 3 spaces before a fence", () => {
		expect(raws("   ```\n[[todo:new:x]]\n   ```")).toEqual([]);
	});

	it("closes a fence only with the same character, at least as long, and nothing else on the line", () => {
		const text = "````\n```\n[[todo:new:x]]\n~~~~\n``` not a close\n````\n[[todo:new:y]]";
		expect(raws(text)).toEqual(["[[todo:new:y]]"]);
	});

	it("skips a marker inside inline code", () => {
		expect(raws("Use `[[todo:new:x]]` to add one. [[todo:new:real]]")).toEqual(["[[todo:new:real]]"]);
	});

	it("matches inline code by backtick count", () => {
		expect(raws("``a ` [[todo:new:x]]`` then [[todo:new:y]]")).toEqual(["[[todo:new:y]]"]);
	});

	it("ignores a stray backtick", () => {
		expect(raws("it's a ` stray [[todo:new:x]]")).toEqual(["[[todo:new:x]]"]);
	});

	it("does not let inline code run across a blank line", () => {
		expect(raws("`open\n\n[[todo:new:x]] `")).toEqual(["[[todo:new:x]]"]);
	});

	it("runs a marker whose own text contains inline code", () => {
		const [t] = parseMarkers("[[todo:new:fix `foo` now]]");
		expect(t).toMatchObject({ tool: "todo", op: "new", args: ["fix `foo` now"] });
	});

	it("skips the pasted system-prompt lines that fired before", () => {
		const text = [
			"Here it is:",
			"```",
			"- Marker syntax: [[todo:new:<subject>]] to create; [[todo:set:<id>,completed|in_progress|pending]] for status",
			"- Rename the current conversation: [[conv:rename:<new title>]]",
			"```",
		].join("\n");
		expect(raws(text)).toEqual([]);
	});
});

describe("codeRanges", () => {
	it("covers a whole fenced block including its fence lines", () => {
		const text = "a\n```\nb\n```\nc";
		expect(codeRanges(text)).toEqual([[2, 12]]);
		expect(text.slice(2, 12)).toBe("```\nb\n```\n");
	});

	it("returns nothing for text without code", () => {
		expect(codeRanges("no code [[todo:new:x]] here")).toEqual([]);
	});
});

describe("stripMarkers keeps markers inside code", () => {
	it("strips only the marker outside code", () => {
		expect(stripMarkers("a [[todo:new:x]] `[[todo:new:y]]`")).toBe("a  `[[todo:new:y]]`");
	});
});
