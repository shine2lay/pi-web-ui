/**
 * tldr-panel：右栏 TL;DR tab 的渲染（web/src/components/TldrPanel.tsx）。
 * renderToStaticMarkup 在 node 里渲染；断言只看结构，不看文案语言。
 */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { TLDR_COLLAPSED_LINES, TldrPanel, tldrRows } from "../../web/src/components/TldrPanel.js";
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
