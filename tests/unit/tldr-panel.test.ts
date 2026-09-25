/**
 * tldr-panel：右栏 TL;DR tab 的渲染（web/src/components/TldrPanel.tsx）。
 * renderToStaticMarkup 在 node 里渲染；断言只看结构，不看文案语言。
 */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { TLDR_COLLAPSED_LINES, TldrPanel } from "../../web/src/components/TldrPanel.js";
import { LanguageProvider } from "../../web/src/i18n.js";
import type { UiTldrLine } from "../../server/protocol.js";

const render = (lines: UiTldrLine[] | undefined, defaultShowAll = false) =>
	renderToStaticMarkup(createElement(LanguageProvider, null, createElement(TldrPanel, { lines, defaultShowAll })));

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
});
