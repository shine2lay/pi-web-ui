// @vitest-environment jsdom
// Synthetic handshake/state metadata only: no provider, model, prompt or transcript fixture.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useChat } from "../../web/src/use-chat.js";
import { cleanupFilesPanels, prepareFilesPanel } from "./files-panel-harness.js";

class MetadataSocket {
	static OPEN = 1;
	static CONNECTING = 0;
	static CLOSED = 3;
	static instances: MetadataSocket[] = [];
	readyState = 0;
	onopen: (() => void) | null = null;
	onmessage: ((e: { data: string }) => void) | null = null;
	onclose: ((e: { code: number }) => void) | null = null;
	onerror: (() => void) | null = null;
	types: string[] = [];
	constructor() {
		MetadataSocket.instances.push(this);
	}
	send(wire: string) {
		this.types.push(String(JSON.parse(wire).type));
	}
	open() {
		this.readyState = 1;
		act(() => this.onopen?.());
	}
	receive(metadata: object) {
		act(() => this.onmessage?.({ data: JSON.stringify(metadata) }));
	}
	close() {
		this.readyState = 3;
		this.onclose?.({ code: 1000 });
	}
}
let root: Root;
let api: ReturnType<typeof useChat>;
function Harness() {
	api = useChat();
	return null;
}
const ready = { type: "ready", serverVersion: "synthetic", appVersion: "synthetic", engine: "pi", managed: true };
const snapshot = (cwd: string) => ({
	type: "snapshot",
	state: {
		conversationId: "synthetic-files",
		sessionId: "synthetic-files",
		cwd,
		messages: [],
		rev: 1,
		isStreaming: false,
		model: null,
		pendingQuestion: null,
	},
});

beforeEach(() => {
	prepareFilesPanel();
	vi.useFakeTimers();
	MetadataSocket.instances = [];
	vi.stubGlobal("WebSocket", MetadataSocket);
	const host = document.createElement("div");
	document.body.appendChild(host);
	root = createRoot(host);
	act(() => root.render(createElement(Harness)));
});
afterEach(() => {
	act(() => root.unmount());
	cleanupFilesPanels();
});

describe("lazy-files-visibility: Files-only readiness", () => {
	it("ready has no Files bootstrap; an accepted snapshot alone opens the separate gate", () => {
		const socket = MetadataSocket.instances[0];
		socket.open();
		socket.receive(ready);
		expect(api.chat.ready).toBe(true);
		expect(api.filesReady).toBe(false);
		expect(socket.types.filter((t) => t === "list_files")).toHaveLength(0);
		socket.receive(snapshot("/synthetic/a"));
		expect(api.filesReady).toBe(true);
		expect(api.chat.state?.cwd).toBe("/synthetic/a");
		expect(api.chat.state?.messages).toEqual([]);
	});

	it("reconnect keeps Files gated through ready until the new cwd's authoritative snapshot", () => {
		const first = MetadataSocket.instances[0];
		first.open();
		first.receive(ready);
		first.receive(snapshot("/synthetic/a"));
		act(() => first.close());
		expect(api.filesReady).toBe(false);
		act(() => vi.advanceTimersByTime(1000));
		const second = MetadataSocket.instances.at(-1)!;
		expect(second).not.toBe(first);
		second.open();
		second.receive(ready);
		expect(api.chat.ready).toBe(true);
		expect(api.chat.state?.cwd).toBe("/synthetic/a");
		expect(api.filesReady).toBe(false);
		second.receive(snapshot("/synthetic/b"));
		expect(api.filesReady).toBe(true);
		expect(api.chat.state?.cwd).toBe("/synthetic/b");
		expect(second.types.filter((t) => t === "list_files")).toHaveLength(0);
	});

	it("leaves an explicit general API listing usable even before Files becomes visible/ready", () => {
		const socket = MetadataSocket.instances[0];
		socket.open();
		socket.receive(ready);
		let sent = false;
		act(() => {
			sent = api.send({ type: "list_files", path: "explicit" });
		});
		expect(sent).toBe(true);
		expect(api.filesReady).toBe(false);
		expect(socket.types.filter((t) => t === "list_files")).toHaveLength(1);
	});
});
