import { act, createElement, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { vi } from "vitest";
import { RightPanel } from "../../web/src/components/RightPanel.js";
import { LanguageProvider } from "../../web/src/i18n.js";
import { resetAppGlobals, setAppGlobals } from "../../web/src/app-globals.js";
import type { ClientMessage, FileListing } from "../../web/src/types.js";

export type ListRequest = Extract<ClientMessage, { type: "list_files" }>;
const roots: Root[] = [];

export function prepareFilesPanel() {
	const storage = new Map<string, string>([["pi-web-ui:lang", "en"]]);
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	vi.stubGlobal("localStorage", {
		getItem: (key: string) => storage.get(key) ?? null,
		setItem: (key: string, value: string) => void storage.set(key, value),
		removeItem: (key: string) => void storage.delete(key),
	});
	vi.stubGlobal(
		"ResizeObserver",
		class {
			observe() {}
			unobserve() {}
			disconnect() {}
		},
	);
	Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
	setAppGlobals({
		cwd: "/workspace/a",
		ready: true,
		status: "open",
		homeDir: "/home/test",
		desktopDir: "/home/test/Desktop",
	});
}

export function cleanupFilesPanels() {
	act(() => {
		for (const root of roots.splice(0)) root.unmount();
	});
	resetAppGlobals();
	vi.unstubAllGlobals();
	vi.useRealTimers();
	document.body.innerHTML = "";
}

export function mountFilesPanel(overrides: Partial<ComponentProps<typeof RightPanel>> = {}) {
	const container = document.createElement("div");
	document.body.appendChild(container);
	const root = createRoot(container);
	roots.push(root);
	const sent: ClientMessage[] = [];
	let props: ComponentProps<typeof RightPanel> = {
		files: null,
		fileChanged: null,
		widgets: [],
		statuses: [],
		panelSend: (msg) => {
			sent.push(msg);
			return true;
		},
		onAttach: vi.fn(),
		onPreview: vi.fn(),
		onNotice: vi.fn(),
		...overrides,
	};
	const render = (patch: Partial<typeof props> = {}) => {
		props = { ...props, ...patch };
		act(() => root.render(createElement(LanguageProvider, null, createElement(RightPanel, props))));
	};
	render();
	return {
		container,
		sent,
		render,
		lists: () => sent.filter((msg): msg is ListRequest => msg.type === "list_files"),
		clickCrumb: (text: string) => {
			const button = [...container.querySelectorAll<HTMLButtonElement>(".panel-crumbs .crumb")].find(
				(b) => b.textContent?.trim() === text,
			);
			if (!button) throw new Error(`Missing crumb ${text}`);
			act(() => button.click());
		},
	};
}

export function listing(request: ListRequest, name: string): FileListing {
	return {
		...request,
		path: request.path ?? "",
		parent: null,
		entries: [{ name, path: name, type: "file" }],
		truncated: false,
	};
}
