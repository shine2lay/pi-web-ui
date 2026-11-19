// @vitest-environment jsdom
/**
 * ops #1013 (Shine 2026-11-18: "lets remove initiative page since it doesnt do anything right now, and rename
 * file-text show&Tell on top right to just show&Tell").
 *
 * (a) The Initiatives page is gone: no top-bar item, `?view=initiatives` opens the default view, and a saved layout
 *     preference for the old tab still builds a top bar (without it).
 * (b) A plugin icon that is a host icon name ("file-text") and has no iconSvg is never drawn as text.
 * (c) A literal glyph icon (emoji) still is.
 */
import { afterEach, describe, expect, it } from "vitest";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react-dom/test-utils";
import { renderToStaticMarkup } from "react-dom/server";
import { ALL_TABS } from "../../server/tabs.js";
import { setAppSend } from "../../web/src/app-globals.js";
import { TopBar } from "../../web/src/components/TopBar.js";
import { LanguageProvider } from "../../web/src/i18n.js";
import { initChatLink, takeViewLink } from "../../web/src/open-chat-link.js";
import { isGlyphIcon, PluginIcon } from "../../web/src/plugin-icon.js";
import { BUILTIN_UI_ITEMS, buildUiSlots } from "../../web/src/ui-slots.js";
import type { ChatState } from "../../web/src/use-chat.js";

let root: Root | null = null;

afterEach(() => {
	setAppSend(null);
	if (root) act(() => root!.unmount());
	root = null;
	document.body.innerHTML = "";
	window.history.replaceState(null, "", "/");
});

describe("(a) the Initiatives page is gone", () => {
	it("no built-in top-bar item or tab name for it", () => {
		expect(BUILTIN_UI_ITEMS.map((i) => i.id)).not.toContain("host:initiatives");
		expect(BUILTIN_UI_ITEMS.some((i) => i.view === ("initiatives" as never))).toBe(false);
		expect(ALL_TABS as readonly string[]).not.toContain("initiatives");
		// Roles and Memory stay.
		expect(BUILTIN_UI_ITEMS.map((i) => i.id)).toEqual(expect.arrayContaining(["host:roles", "host:openviking"]));
	});

	it("?view=initiatives opens the default view and leaves the address bar clean", () => {
		window.history.replaceState(null, "", "/?view=initiatives");
		initChatLink();
		expect(takeViewLink()).toBeNull();
		expect(window.location.search).toBe("");
		// Control: a page that still exists is opened.
		window.history.replaceState(null, "", "/?view=roles");
		initChatLink();
		expect(takeViewLink()).toEqual({ view: "roles" });
	});

	it("a saved preference for the old tab still builds a top bar, without it", () => {
		const slots = buildUiSlots([], {
			locale: "en",
			t: (k) => k,
			layout: {
				shown: ["host:initiatives"],
				order: ["host:initiatives", "host:roles"],
				labels: { "host:initiatives": "Initiatives" },
			},
		});
		const ids = slots["topbar.primary"].map((e) => e.id);
		expect(ids).not.toContain("host:initiatives");
		expect(ids).toContain("host:roles");
	});
});

describe("(b)/(c) plugin icons: names are never drawn as text, glyphs still are", () => {
	it("isGlyphIcon: names out, glyphs in", () => {
		expect(isGlyphIcon("file-text")).toBe(false);
		expect(isGlyphIcon("folder")).toBe(false);
		expect(isGlyphIcon("")).toBe(false);
		expect(isGlyphIcon("📄")).toBe(true);
		expect(isGlyphIcon("★")).toBe(true);
	});

	it("PluginIcon draws nothing for a name without iconSvg, and the glyph for an emoji", () => {
		expect(renderToStaticMarkup(createElement(PluginIcon, { icon: "file-text" }))).toBe("");
		expect(renderToStaticMarkup(createElement(PluginIcon, { icon: "📄" }))).toContain("📄");
	});

	const chatStub = {
		status: "open",
		ready: true,
		state: null,
		activeConversationId: "",
		terminals: [],
		bgServers: [],
		tabs: undefined,
		update: null,
		updatesAll: [],
	} as unknown as ChatState;

	const pluginTab = (icon: string) => ({
		id: "show-and-tell:__view",
		source: "plugin:show-and-tell",
		slot: "topbar.primary" as const,
		label: "Show&Tell",
		icon,
		kind: "view" as const,
		view: "plugin:show-and-tell",
		order: 100,
		align: "start" as const,
		hidden: false,
		userOverrides: [],
		arrangedBy: [],
	});

	function mountTopBar(icon: string): HTMLElement {
		const container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
		act(() => {
			root!.render(
				createElement(
					LanguageProvider,
					null,
					createElement(TopBar, {
						chat: chatStub,
						uiPrimary: [pluginTab(icon)],
						terminal: {
							create: () => {},
							close: () => {},
							register: () => () => {},
							restart: () => {},
							select: () => {},
						},
						view: "chat",
						plugins: [{ id: "show-and-tell", name: "Show&Tell", icon, view: true }],
						onViewChange: () => {},
						onOpenPanel: () => {},
						onOpenSettings: () => {},
						onOpenBgTasks: () => {},
						onOpenGlobalSearch: () => {},
						sound: { enabled: false, volume: 0.5, kinds: {} },
						onSoundChange: () => {},
						onSoundPreview: () => {},
						themes: [],
						theme: null,
						onThemeChange: () => {},
						reloadThemes: () => {},
					} as unknown as Parameters<typeof TopBar>[0]),
				),
			);
		});
		return container;
	}

	it("the Show&Tell tab reads just 'Show&Tell' when its icon is 'file-text'", () => {
		const tab = mountTopBar("file-text").querySelector(".tb-tab.plugin-tab");
		expect(tab).toBeTruthy();
		expect(tab!.textContent).toBe("Show&Tell");
	});

	it("an emoji icon is still drawn before the label", () => {
		const tab = mountTopBar("📄").querySelector(".tb-tab.plugin-tab");
		expect(tab).toBeTruthy();
		expect(tab!.textContent).toBe("📄Show&Tell");
	});
});
