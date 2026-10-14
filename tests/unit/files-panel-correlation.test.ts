// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { setAppGlobals } from "../../web/src/app-globals.js";
import { cleanupFilesPanels, listing, mountFilesPanel, prepareFilesPanel } from "./files-panel-harness.js";

beforeEach(() => {
	prepareFilesPanel();
	vi.useFakeTimers();
});
afterEach(cleanupFilesPanels);
function mountReadyFilesPanel() {
	const panel = mountFilesPanel();
	act(() => vi.advanceTimersByTime(0));
	return panel;
}

describe("file-list-correlation: current token AND folder binding", () => {
	it("rejects an old cwd's root reply although both wire paths are empty", () => {
		const panel = mountReadyFilesPanel();
		const old = panel.lists().at(-1)!;
		act(() => setAppGlobals({ cwd: "/workspace/b" }));
		act(() => vi.advanceTimersByTime(0));
		const current = panel.lists().at(-1)!;
		panel.render({ files: listing(current, "current-root") });
		expect(panel.container.textContent).toContain("current-root");
		panel.render({ files: listing(old, "stale-root") });
		expect(panel.container.textContent).toContain("current-root");
		expect(panel.container.textContent).not.toContain("stale-root");
	});

	it("rejects A→B→A's late first A reply", () => {
		const panel = mountReadyFilesPanel();
		panel.clickCrumb("🏠");
		const oldA = panel.lists().at(-1)!;
		panel.clickCrumb("🖥️");
		panel.clickCrumb("🏠");
		const newA = panel.lists().at(-1)!;
		panel.render({ files: listing(newA, "current-a") });
		panel.render({ files: listing(oldA, "stale-a") });
		expect(panel.container.textContent).toContain("current-a");
		expect(panel.container.textContent).not.toContain("stale-a");
	});

	it("rejects another window's same-folder reply", () => {
		const first = mountReadyFilesPanel();
		const second = mountReadyFilesPanel();
		second.render({ files: listing(second.lists().at(-1)!, "own-window") });
		second.render({ files: listing(first.lists().at(-1)!, "other-window") });
		expect(second.container.textContent).toContain("own-window");
		expect(second.container.textContent).not.toContain("other-window");
	});

	it("rejects an old different-folder reply and an untagged unsolicited listing", () => {
		const panel = mountReadyFilesPanel();
		const oldRoot = panel.lists().at(-1)!;
		panel.clickCrumb("🏠");
		const home = panel.lists().at(-1)!;
		panel.render({ files: listing(home, "home-current") });
		panel.render({ files: listing(oldRoot, "old-root") });
		panel.render({ files: listing({ type: "list_files", path: home.path }, "untagged") });
		expect(panel.container.textContent).toContain("home-current");
		expect(panel.container.textContent).not.toContain("untagged");
	});
});
