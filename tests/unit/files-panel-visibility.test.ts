// @vitest-environment jsdom
import { act, type ComponentProps } from "react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setAppGlobals } from "../../web/src/app-globals.js";
import { filesPanelVisible } from "../../web/src/files-visibility.js";
import { getContextMenu, resetContextMenu } from "../../web/src/context-menu-state.js";
import { downloadFile } from "../../web/src/download.js";
import type { RightPanel } from "../../web/src/components/RightPanel.js";
import type { UiSlotEntry } from "../../web/src/ui-slots.js";
import { cleanupFilesPanels, listing, mountFilesPanel, prepareFilesPanel } from "./files-panel-harness.js";

vi.mock("../../web/src/download.js", () => ({
	downloadFile: vi.fn(async () => ({ ok: true })),
	DOWNLOAD_FILE_NOT_FOUND: "not-found",
}));
beforeEach(() => {
	prepareFilesPanel();
	resetContextMenu();
	vi.clearAllMocks();
	vi.useFakeTimers();
});
afterEach(cleanupFilesPanels);
const tick = (ms = 0) => act(() => vi.advanceTimersByTime(ms));
function panel(props: Partial<ComponentProps<typeof RightPanel>> = {}) {
	const p = mountFilesPanel(props);
	tick();
	return p;
}
function documentVisible(visible: boolean) {
	act(() => {
		Object.defineProperty(document, "visibilityState", { value: visible ? "visible" : "hidden", configurable: true });
		document.dispatchEvent(new Event("visibilitychange"));
	});
}
const hiddenFiles: UiSlotEntry = {
	id: "host:right-files",
	slot: "rightpanel.tabs",
	source: "host",
	label: "Files",
	kind: "action",
	order: 0,
	align: "start",
	hidden: true,
	userOverrides: [],
	arrangedBy: [],
};

const fileActions: UiSlotEntry[] = ["refresh", "upload", "cut", "paste", "duplicate"].map((action) => ({
	...hiddenFiles,
	id: `host:file-${action}`,
	label: action,
	slot: "contextmenu.file",
	hidden: false,
}));
function fileMenu(p: ReturnType<typeof panel>, selector = ".panel-body") {
	const target = p.container.querySelector<HTMLElement>(selector)!;
	act(() => target.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true })));
	const menu = getContextMenu()!;
	expect(menu?.onHostAction).toBeTypeOf("function");
	return (action: string) =>
		act(() => {
			menu.onHostAction!(
				fileActions.find((e) => e.id === `host:file-${action}`)!,
				menu.target,
			);
		});
}

describe("lazy-files-visibility: fixed clock, metadata-only sink", () => {
	it("makes zero hidden-tab polls over 120 seconds (old code makes exactly 12)", () => {
		const p = panel();
		p.clickCrumb("🏠");
		p.clickTab("TL;DR");
		const before = p.lists().length;
		tick(120_000);
		expect(p.lists().length - before).toBe(0);
	});

	it("makes zero initial/ready listings while the outer panel is hidden", () => {
		setAppGlobals({ ready: false, status: "connecting" });
		const p = panel({ visible: false });
		act(() => setAppGlobals({ ready: true, status: "open" }));
		tick(120_000);
		expect(p.lists()).toHaveLength(0);
	});

	it("restores a non-Files saved tab without an initial listing", () => {
		localStorage.setItem("pi-web-ui:rightpanel:tab", "tldr");
		const p = panel();
		tick(120_000);
		expect(p.lists()).toHaveLength(0);
	});

	it("reveals exactly once at the root, then polls at ten-second intervals", () => {
		const p = panel({ visible: false });
		const revealAt = Date.now();
		p.render({ visible: true });
		tick();
		expect(p.lists()).toHaveLength(1);
		expect(p.lists()[0].path ?? "").toBe("");
		expect(p.listTimes.at(-1)! - revealAt).toBeLessThanOrEqual(100);
		tick(9_999);
		expect(p.lists()).toHaveLength(1);
		tick(1);
		// Fake timers give a timer nested in the polling callback a 1ms floor.
		tick(1);
		expect(p.lists()).toHaveLength(2);
		expect(p.listTimes[1] - revealAt).toBe(10_001);
	});

	it("defers hidden cwd/watch changes and coalesces reveal to exactly one new-root request", () => {
		const p = panel({ visible: false });
		act(() => setAppGlobals({ cwd: "/workspace/b" }));
		p.render({ fileChanged: { path: "" } });
		p.render({ fileChanged: { path: "" } });
		tick(120_000);
		expect(p.lists()).toHaveLength(0);
		p.render({ visible: true });
		tick();
		expect(p.lists()).toHaveLength(1);
		expect(p.lists()[0].path ?? "").toBe("");
	});

	it("preserves the current folder and scroll while hidden, refreshing it once on return", () => {
		const p = panel();
		p.clickCrumb("🏠");
		p.render({ files: listing(p.lists().at(-1)!, "kept-file") });
		const body = p.container.querySelector<HTMLElement>(".panel-body")!;
		body.scrollTop = 37;
		act(() => body.dispatchEvent(new Event("scroll", { bubbles: true })));
		p.clickTab("TL;DR");
		p.render({ fileChanged: { path: "/home/test" } });
		const before = p.lists().length;
		tick(120_000);
		expect(p.lists()).toHaveLength(before);
		p.clickTab("Files");
		tick();
		expect(p.lists()).toHaveLength(before + 1);
		expect(p.lists().at(-1)?.path).toBe("/home/test");
		expect(p.container.querySelector<HTMLElement>(".panel-body")?.scrollTop).toBe(37);
	});

	it("suppresses document-hidden initial/poll/watch work and refreshes once when visible", () => {
		documentVisible(false);
		const p = panel();
		p.render({ fileChanged: { path: "" } });
		tick(120_000);
		expect(p.lists()).toHaveLength(0);
		documentVisible(true);
		tick();
		expect(p.lists()).toHaveLength(1);
	});

	it("suppresses user/plugin-hidden Files and refreshes once when restored", () => {
		const p = panel({ uiRightPanelTabs: [hiddenFiles] });
		tick(120_000);
		expect(p.lists()).toHaveLength(0);
		p.render({ uiRightPanelTabs: [] });
		p.clickTab("Files");
		tick();
		expect(p.lists()).toHaveLength(1);
	});

	it("coalesces rapid hide/show before dispatch into one reveal", () => {
		const p = panel({ visible: false });
		p.render({ visible: true });
		p.render({ visible: false });
		p.render({ visible: true });
		tick();
		expect(p.lists()).toHaveLength(1);
	});

	it("does not list offline; hidden reconnect plus reveal requests once, not twice", () => {
		const p = panel({ visible: false });
		act(() => setAppGlobals({ status: "closed", ready: false }));
		tick(120_000);
		act(() => setAppGlobals({ status: "open", ready: true }));
		tick();
		expect(p.lists()).toHaveLength(0);
		p.render({ visible: true });
		tick();
		expect(p.lists()).toHaveLength(1);
		act(() => setAppGlobals({ status: "closed", ready: false }));
		tick(20_000);
		expect(p.lists()).toHaveLength(1);
		act(() => setAppGlobals({ status: "open", ready: true }));
		tick();
		expect(p.lists()).toHaveLength(2);
	});

	it("waits for the reconnect snapshot instead of listing the retained old cwd on ready", () => {
		const p = panel({ filesReady: false });
		tick(500);
		expect(p.lists()).toHaveLength(0);
		act(() => setAppGlobals({ cwd: "/workspace/reconnected" }));
		p.render({ filesReady: true });
		tick();
		expect(p.lists()).toHaveLength(1);
		expect(p.lists()[0].path ?? "").toBe("");
	});

	it("derives visibility per window without waking its hidden peer", () => {
		const hidden = panel({ visible: false });
		const shown = panel();
		tick(120_000);
		expect(hidden.lists()).toHaveLength(0);
		expect(shown.lists().length).toBeGreaterThanOrEqual(12);
		hidden.render({ visible: true });
		tick();
		expect(hidden.lists()).toHaveLength(1);
	});

	it("coalesces a matching watch burst, ignores another folder, and refreshes within 100 ms", () => {
		const p = panel();
		const before = p.lists().length;
		p.render({ fileChanged: { path: "not-current" } });
		tick(100);
		expect(p.lists()).toHaveLength(before);
		const changedAt = Date.now();
		for (let i = 0; i < 8; i++) p.render({ fileChanged: { path: "" } });
		tick(100);
		expect(p.lists()).toHaveLength(before + 1);
		expect(p.listTimes.at(-1)! - changedAt).toBeLessThanOrEqual(100);
		expect(p.listTimes.at(-1)! - changedAt).toBe(40);
	});

	it("leaves explicit navigation, preview and attachment live even with automatic work hidden", () => {
		const onPreview = vi.fn();
		const onAttach = vi.fn();
		const p = panel({ visible: false, onPreview, onAttach });
		p.clickCrumb("🏠");
		expect(p.lists()).toHaveLength(1);
		p.render({ files: listing(p.lists()[0], "explicit.txt") });
		const open = p.container.querySelector<HTMLButtonElement>(".file-item.file .file-name")!;
		act(() => open.click());
		expect(onPreview).toHaveBeenCalledWith("explicit.txt", "explicit.txt");
		const attach = p.container.querySelector<HTMLButtonElement>(".file-item.file .file-attach.ref")!;
		act(() => attach.click());
		expect(onAttach).toHaveBeenCalled();
		tick(120_000);
		expect(p.lists()).toHaveLength(1);
	});

	it("keeps an explicit refresh and a started picker upload alive after hiding", () => {
		let reader: { result: string; onload: (() => void) | null };
		vi.stubGlobal(
			"FileReader",
			class {
				result = "data:text/plain;base64,Zml4ZWQ=";
				onload: (() => void) | null = null;
				constructor() {
					reader = this;
				}
				readAsDataURL() {
					/* held until after the panel hides */
				}
			},
		);
		const p = panel({ uiContextFile: fileActions });
		const action = fileMenu(p);
		const input = p.container.querySelector<HTMLInputElement>('input[type="file"]')!;
		const picker = vi.spyOn(input, "click").mockImplementation(() => {});
		action("upload");
		expect(picker).toHaveBeenCalledOnce();
		Object.defineProperty(input, "files", { value: [new File(["fixed"], "upload.txt")] });
		act(() => input.dispatchEvent(new Event("change", { bubbles: true })));
		p.render({ visible: false });
		const before = p.lists().length;
		action("refresh");
		act(() => reader!.onload?.());
		expect(p.lists()).toHaveLength(before + 1);
		expect(p.operations.filter((type) => type === "upload_file")).toHaveLength(1);
		tick(120_000);
		expect(p.lists()).toHaveLength(before + 1);
	});

	it("keeps clipboard selection across hiding and an explicit paste/duplicate unblocked", () => {
		const p = panel({ uiContextFile: fileActions });
		p.render({ files: listing(p.lists()[0], "kept.txt") });
		fileMenu(p, ".file-item.file")("cut");
		expect(p.container.querySelector(".file-item.cut")).not.toBeNull();
		p.render({ visible: false });
		tick(120_000);
		expect(p.container.querySelector(".file-item.cut")).not.toBeNull();
		fileMenu(p)("paste");
		fileMenu(p, ".file-item.file")("duplicate");
		expect(p.operations.filter((type) => type === "file_copy")).toHaveLength(2);
	});

	it("keeps the explicit download action independent of automatic visibility", async () => {
		const p = panel({ visible: false });
		p.clickCrumb("🏠");
		p.render({ files: listing(p.lists()[0], "download.txt") });
		await act(async () => p.container.querySelector<HTMLButtonElement>(".file-attach.download")!.click());
		expect(downloadFile).toHaveBeenCalledWith("download.txt", "download.txt");
		expect(p.lists()).toHaveLength(1);
	});

	it("removes only built-in ready bootstrap and binds App geometry to the mounted panel", () => {
		const source = (path: string) => readFileSync(join(process.cwd(), "web/src", path), "utf8");
		const chat = source("use-chat.ts");
		const ready = chat.slice(
			chat.indexOf('case "ready":', chat.indexOf("new WebSocket")),
			chat.indexOf('case "snapshot":', chat.indexOf("new WebSocket")),
		);
		expect(ready).not.toContain('type: "list_files"');
		expect(chat).toContain('case "files":');
		expect(source("App.tsx")).toContain("visible={filesPanelVisible(view, isMobile, drawer, rightCollapsed)}");
	});
});

describe("lazy-files-visibility: app geometry", () => {
	it.each([
		["chat", false, null, false, true],
		["chat", false, null, true, false],
		["roles", false, null, false, false],
		["initiatives", false, null, false, false],
		["terminal", false, null, false, false],
		["git", false, null, false, false],
		["plugin:sample", false, null, false, false],
		["chat", true, null, false, false],
		["chat", true, "left", false, false],
		["chat", true, "right", true, true],
		["roles", true, "right", false, false],
	] as const)("view=%s mobile=%s drawer=%s collapsed=%s -> %s", (view, mobile, drawer, collapsed, expected) => {
		expect(filesPanelVisible(view, mobile, drawer, collapsed)).toBe(expected);
	});
});
