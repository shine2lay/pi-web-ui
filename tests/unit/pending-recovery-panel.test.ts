// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { PendingRecoveryPanel } from "../../web/src/components/PendingRecoveryPanel.js";
import { LanguageProvider } from "../../web/src/i18n.js";
import type { RecoveryView } from "../../web/src/recovery-client.js";

let root: Root;
let container: HTMLDivElement;
let urls: Mock<(object: Blob | MediaSource) => string>;
let downloads: { href: string; name: string }[];
const view = (): RecoveryView => ({
	state: "ready",
	ownerId: "fixture-owner",
	issues: [],
	problem: null,
	items: [
		{
			complete: true,
			delivery: "uncertain",
			issues: [],
			prepared: {
				ownerId: "fixture-owner",
				kind: "prompt",
				id: "fixture-prompt",
				sessionId: "fixture-session",
				contentDigest: "digest",
				work: {
					kind: "prompt",
					pending: {
						id: "fixture-prompt",
						conversationId: "fixture-conversation",
						sessionId: "fixture-session",
						text: "raw-fixture-body",
						queue: false,
						status: "sending",
						createdAt: 1,
						sameTextBefore: [],
						queueBase: 0,
					},
				},
			},
		},
	],
});
function render(state: RecoveryView, exporter = vi.fn(async () => "complete-fixture-artifact")) {
	act(() =>
		root.render(
			createElement(
				LanguageProvider,
				null,
				createElement(PendingRecoveryPanel, { view: state, exportArtifact: exporter }),
			),
		),
	);
	return exporter;
}
function clickExport() {
	act(() => container.querySelector<HTMLButtonElement>("button")!.click());
}
beforeEach(() => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	vi.useFakeTimers();
	urls = vi.fn((_object: Blob | MediaSource) => "blob:fixture");
	vi.stubGlobal(
		"URL",
		class extends URL {
			static override createObjectURL = urls;
			static override revokeObjectURL = vi.fn((_url: string) => undefined);
		},
	);
	downloads = [];
	vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
		downloads.push({ href: this.href, name: this.download });
	});
	container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
});
afterEach(() => {
	act(() => root.unmount());
	container.remove();
	vi.runOnlyPendingTimers();
	vi.useRealTimers();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});
describe("retained original read-only reachability", () => {
	it("does not fetch/export by mounting or render raw body bytes", () => {
		const exporter = render(view());
		expect(container.querySelector('[data-recovery-id="fixture-prompt"]')?.getAttribute("data-recovery-complete")).toBe(
			"true",
		);
		expect(container.textContent?.includes("raw-fixture-body")).toBe(false);
		expect(exporter).not.toHaveBeenCalled();
		expect(urls).not.toHaveBeenCalled();
	});
	it("awaits one explicit complete export and does not consume source originals", async () => {
		let resolve!: (value: string) => void;
		const exporter = vi.fn(
			() =>
				new Promise<string>((done) => {
					resolve = done;
				}),
		);
		const original = view();
		const before = JSON.stringify(original);
		render(original, exporter);
		clickExport();
		clickExport();
		expect(exporter).toHaveBeenCalledTimes(1);
		expect(downloads).toEqual([]);
		expect(container.querySelector<HTMLButtonElement>("button")?.disabled).toBe(true);
		await act(async () => {
			resolve("full original 雪\n");
		});
		expect(urls).toHaveBeenCalledTimes(1);
		expect(downloads).toEqual([{ href: "blob:fixture", name: "pi-web-pending-recovery.json" }]);
		expect((urls.mock.calls[0][0] as Blob).size).toBe(Buffer.byteLength("full original 雪\n"));
		expect(JSON.stringify(original)).toBe(before);
		expect(container.querySelector<HTMLButtonElement>("button")?.disabled).toBe(false);
	});
	it("export rejection is visible and never hides/deletes the last source", async () => {
		const original = view();
		const before = JSON.stringify(original);
		const exporter = vi.fn(async (): Promise<string> => {
			throw new Error("fixture read failed");
		});
		render(original, exporter);
		await act(async () => container.querySelector<HTMLButtonElement>("button")!.click());
		expect(container.querySelector('[role="alert"]')?.textContent).toContain("All original records remain retained");
		expect(JSON.stringify(original)).toBe(before);
		expect(urls).not.toHaveBeenCalled();
		expect(downloads).toEqual([]);
		expect(container.querySelector('[data-recovery-id="fixture-prompt"]')).not.toBeNull();
	});
	it("incomplete/conflicting owner remains visible without fabricating a complete item", () => {
		const original = view();
		original.state = "incomplete";
		original.items[0].complete = false;
		original.problem = "Retain unresolved fixture source";
		original.issues = ["Reference needs actual bytes"];
		render(original);
		expect(container.querySelector('[data-recovery-id="fixture-prompt"]')?.getAttribute("data-recovery-complete")).toBe(
			"false",
		);
		expect(container.textContent).toContain("Source repair required");
		expect(container.textContent).toContain("Retain unresolved fixture source");
		expect(urls).not.toHaveBeenCalled();
	});
});
