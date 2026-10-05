/**
 * tldr-panel：右栏 TL;DR tab 的渲染（web/src/components/TldrPanel.tsx）。
 * renderToStaticMarkup 在 node 里渲染；断言只看结构，不看文案语言。
 */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import {
	TLDR_COLLAPSED_LINES,
	TldrPanel,
	tldrLineClass,
	tldrRows,
	tldrSubClass,
} from "../../web/src/components/TldrPanel.js";
import { LanguageProvider } from "../../web/src/i18n.js";
import type { UiTldrLine } from "../../server/protocol.js";

const render = (
	lines: UiTldrLine[] | undefined,
	defaultShowAll = false,
	onCollapse?: (ids: string[], collapsed: boolean) => void,
) =>
	renderToStaticMarkup(
		createElement(LanguageProvider, null, createElement(TldrPanel, { lines, defaultShowAll, onCollapse })),
	);

const mk = (n: number, needsYouAt: number[] = []): UiTldrLine[] =>
	Array.from({ length: n }, (_, i) => ({
		id: `t${i + 1}`,
		text: `step ${i + 1}`,
		needsYou: needsYouAt.includes(i + 1),
		ts: Date.parse("2026-09-24T12:00:00Z") + i * 60_000,
	}));

const items = (html: string) => [...html.matchAll(/<span class="tldr-text">([^<]*)<\/span>/g)].map((m) => m[1]);

describe("TldrPanel", () => {
	it("shows the empty state with no lines", () => {
		expect(render(undefined)).toContain('class="tldr-empty"');
		expect(render([])).toContain('class="tldr-empty"');
	});

	it("lists newest first and shows only the latest few until expanded", () => {
		const html = render(mk(7));
		expect(TLDR_COLLAPSED_LINES).toBe(5);
		expect(items(html)).toEqual(["step 7", "step 6", "step 5", "step 4", "step 3"]);
		const more = html.match(/<button type="button" class="tldr-more">([^<]*)<\/button>/);
		expect(more?.[1]).toMatch(/7/);

		expect(items(render(mk(7), true))).toEqual(["step 7", "step 6", "step 5", "step 4", "step 3", "step 2", "step 1"]);
	});

	it("has no expand button when everything fits", () => {
		const html = render(mk(TLDR_COLLAPSED_LINES));
		expect(items(html)).toHaveLength(TLDR_COLLAPSED_LINES);
		expect(html).not.toContain("tldr-more");
	});

	it("highlights needs-you lines with a badge", () => {
		const html = render(mk(3, [2]));
		expect(html.match(/class="tldr-line needs-you"/g)).toHaveLength(1);
		expect(html.match(/class="tldr-badge"/g)).toHaveLength(1);
		expect(html).toMatch(
			/class="tldr-line needs-you"><span class="tldr-badge">[^<]+<\/span><span class="tldr-text">step 2</,
		);
		expect(html).toContain('dateTime="2026-09-24T12:01:00.000Z"');
	});

	it("an answered needs-you line is a plain line: no highlight, no badge (tldr-answered)", () => {
		const lines = mk(3, [1, 3]).map((l) => (l.id === "t1" ? { ...l, answered: true } : l));
		const html = render(lines);
		expect(html.match(/class="tldr-line needs-you"/g)).toHaveLength(1);
		expect(html.match(/class="tldr-badge"/g)).toHaveLength(1);
		expect(html).toMatch(
			/class="tldr-line needs-you"><span class="tldr-badge">[^<]+<\/span><span class="tldr-text">step 3</,
		);
		expect(html).toMatch(/class="tldr-line"><span class="tldr-text">step 1</);
	});

	const liClasses = (html: string) => [...html.matchAll(/<li class="([^"]+)"/g)].map((m) => m[1]);

	it("queue-main-chat: the main chat's answer to a task's question is blue (class answered), with no badge", () => {
		const answer = "Task #4 asked: Which port?; the main chat answered: Use 8080";
		const lines: UiTldrLine[] = mk(3, [1]).map((l) => (l.id === "t2" ? { ...l, text: answer, kind: "answered" } : l));
		const html = render(lines);
		// Newest first: a plain line, the blue answer, the amber needs-you line.
		expect(liClasses(html)).toEqual(["tldr-line", "tldr-line answered", "tldr-line needs-you"]);
		expect(html.match(/class="tldr-badge"/g)).toHaveLength(1);
		expect(html).toContain(`class="tldr-line answered"><span class="tldr-text">${answer}</span>`);
	});

	it("queue-main-chat: the newest line can be blue too, and an answered line folds like any other", () => {
		const lines: UiTldrLine[] = mk(2).map((l) => (l.id === "t2" ? { ...l, kind: "answered" } : l));
		expect(liClasses(render(lines))).toEqual(["tldr-line answered", "tldr-line"]);
		const folded = lines.map((l) => (l.id === "t2" ? { ...l, collapsed: true } : l));
		expect(liClasses(render(folded))).toEqual(["tldr-folded", "tldr-line"]);
	});
});

/** queue-main-chat: the classes that colour a line: amber needs-you, blue main-chat answer, else plain. */
describe("queue-main-chat: line classes", () => {
	const base: UiTldrLine = { id: "t1", text: "step", needsYou: false, ts: 0 };

	it("tldrLineClass: needs-you is amber, answered is blue, the rest plain; needs-you wins", () => {
		expect(tldrLineClass(base)).toBe("tldr-line");
		expect(tldrLineClass({ ...base, kind: "answered" })).toBe("tldr-line answered");
		expect(tldrLineClass({ ...base, needsYou: true })).toBe("tldr-line needs-you");
		expect(tldrLineClass({ ...base, needsYou: true, answered: true })).toBe("tldr-line");
		expect(tldrLineClass({ ...base, needsYou: true, kind: "answered" })).toBe("tldr-line needs-you");
		// queue-blocked: its own colour (cyan), needs-you still wins.
		expect(tldrLineClass({ ...base, kind: "blocked" })).toBe("tldr-line blocked");
		expect(tldrLineClass({ ...base, needsYou: true, kind: "blocked" })).toBe("tldr-line needs-you");
	});

	it("tldrSubClass: the left list's line gets the same colours", () => {
		expect(tldrSubClass({ needsYou: false })).toBe("session-sub tldr-sub");
		expect(tldrSubClass({ needsYou: false, kind: "answered" })).toBe("session-sub tldr-sub answered");
		expect(tldrSubClass({ needsYou: true })).toBe("session-sub tldr-sub needs-you");
		expect(tldrSubClass({ needsYou: true, kind: "answered" })).toBe("session-sub tldr-sub needs-you");
		// queue-blocked: a blocked task's line, in the Blocked colour; needs-you still wins.
		expect(tldrSubClass({ needsYou: false, kind: "blocked" })).toBe("session-sub tldr-sub blocked");
		expect(tldrSubClass({ needsYou: true, kind: "blocked" })).toBe("session-sub tldr-sub needs-you");
	});
});

/** tldr-collapse：看过的行折叠起来，连着的并成一行「N 行已读」。 */
describe("TldrPanel folding", () => {
	const noop = () => {};
	const unfoldRows = (html: string) =>
		[...html.matchAll(/class="tldr-unfold"[^>]*>([^<]*)<\/button>/g)].map((m) => m[1]);

	it("tldrRows merges each run of folded lines into one row", () => {
		const folded = new Set(["t5", "t4", "t2", "t1"]);
		const rows = tldrRows([...mk(6)].reverse(), (l) => folded.has(l.id));
		expect(rows.map((r) => (r.kind === "line" ? r.line.id : r.lines.map((l) => l.id).join("+")))).toEqual([
			"t6",
			"t5+t4",
			"t3",
			"t2+t1",
		]);
	});

	it("shows folded lines as one count row, and the row limit counts that row once", () => {
		const lines = mk(9).map((l, i) => (i < 6 ? { ...l, collapsed: true } : l));
		const html = render(lines);
		expect(items(html)).toEqual(["step 9", "step 8", "step 7"]);
		const rows = unfoldRows(html);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatch(/^6 /);
		// 4 行（3 条 + 1 行已读）放得下，不出「显示全部」
		expect(html).not.toContain("tldr-more");
	});

	it("a folded line between open ones splits the runs", () => {
		const lines = mk(4).map((l) => (l.id === "t2" || l.id === "t4" ? { ...l, collapsed: true } : l));
		const html = render(lines);
		expect(items(html)).toEqual(["step 3", "step 1"]);
		expect(unfoldRows(html)).toHaveLength(2);
	});

	it("offers the fold buttons and Collapse all only when it can send", () => {
		const lines = mk(3);
		const readOnly = render(lines);
		expect(readOnly).not.toContain("tldr-fold");
		expect(readOnly).not.toContain("tldr-collapse-all");

		const html = render(lines, false, noop);
		expect(html.match(/class="tldr-fold"/g)).toHaveLength(3);
		expect(html).toContain('class="tldr-collapse-all"');
		// 折叠按钮加在行尾：徽章和文字的位置不变
		expect(render(mk(1, [1]), false, noop)).toMatch(
			/class="tldr-line needs-you"><span class="tldr-badge">[^<]+<\/span><span class="tldr-text">step 1</,
		);

		const allFolded = render(
			lines.map((l) => ({ ...l, collapsed: true })),
			false,
			noop,
		);
		expect(allFolded).not.toContain("tldr-collapse-all");
		expect(allFolded).not.toContain('class="tldr-fold"');
		expect(unfoldRows(allFolded)).toEqual([expect.stringMatching(/^3 /)]);
		expect(allFolded).not.toContain("disabled");
		// 发不出去时「N 行已读」还在，只是点不了
		expect(render(lines.map((l) => ({ ...l, collapsed: true })))).toContain("disabled");
	});
});
