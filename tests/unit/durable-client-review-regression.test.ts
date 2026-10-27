// @vitest-environment jsdom
// Ops #574 / H-CLIENT-STATE-PARITY-1. Independently specified, synthetic fixed inputs only.
// Hypothesis: binding pages to requests and drafts to conversations prevents invented history
// positions and lost/leaked drafts; recognizing Markdown code ranges prevents example actions.
// The oracle is exact visible text, message IDs/order/cursors and send counts, not new helpers.
import { act, createElement, Fragment, type ComponentProps, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseActionSuggestions, messageSuggestions } from "../../web/src/action-suggestions.js";
import { resetAppGlobals, setAppSend } from "../../web/src/app-globals.js";
import { ChatInput } from "../../web/src/components/ChatInput.js";
import { MessageList } from "../../web/src/components/MessageList.js";
import { composeToComposer, resetComposerSinks } from "../../web/src/composer-bridge.js";
import { createPendingRecoveryCoordinator } from "../../web/src/pending-recovery-coordinator.js";
import type { PendingRecoveryBackend, RecoveryRecord } from "../../web/src/pending-send-storage.js";
import { setNativeRecoveryCoordinatorFactory } from "../../web/src/recovery-client.js";
import { LanguageProvider } from "../../web/src/i18n.js";
import { formatQuote } from "../../web/src/quote-selection.js";
import type { UiMessage, UiState } from "../../web/src/types.js";
import { useChat } from "../../web/src/use-chat.js";

const T0 = 1_000_000;
const HISTORY_A = "synthetic-history-a";
const HISTORY_B = "synthetic-history-b";
const roots: Root[] = [];

function mount(node: ReactNode) {
	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = createRoot(host);
	roots.push(root);
	const render = (child: ReactNode) => {
		act(() => root.render(createElement(LanguageProvider, null, child)));
	};
	render(node);
	return { host, render };
}

function message(id: string, text = id, role: UiMessage["role"] = "assistant"): UiMessage {
	return { id, role, content: [{ type: "text", text }] };
}

function ids(from: number, until: number, prefix = "m"): string[] {
	return Array.from({ length: until - from }, (_, i) => `${prefix}${from + i}`);
}

function messages(from: number, until: number, prefix = "m"): UiMessage[] {
	return ids(from, until, prefix).map((id) => message(id));
}

// Deliberately minimal UI snapshots, never a real session or model. An undefined sessionId
// represents the async-init wire state even though the fully initialized UiState requires it.
function snapshot(overrides: Partial<UiState> = {}): UiState {
	return {
		clientId: "synthetic-client",
		conversationId: "synthetic-draft-a",
		sessionId: "synthetic-session-a",
		cwd: "/synthetic-client-review",
		rev: 1,
		isStreaming: false,
		model: null,
		pendingQuestion: null,
		queue: { steering: [], followUp: [] },
		messagesStart: 0,
		messages: [],
		...overrides,
	} as UiState;
}

type HistorySnapshot = UiState & {
	historyWindow: { hasEarlier: boolean; hiddenCount: number; earliestIndex: number };
};

function historySnapshot(start = 60, conversationId = HISTORY_A, prefix = "m", until = 62): HistorySnapshot {
	return {
		...snapshot({
			conversationId,
			sessionId: `synthetic-session-${conversationId}`,
			messagesStart: start,
			messages: messages(start, until, prefix),
		}),
		historyWindow: { hasEarlier: start > 0, hiddenCount: start, earliestIndex: start },
	};
}

interface PagingMetadata {
	type: "load_earlier_messages" | "load_older";
	conversationId?: string;
	beforeIndex?: number;
	limit?: number;
	count?: number;
}

// Not a vi.fn: mock-call histories would retain hello/model/app request bodies. Only the
// paging fields and synthetic prompt IDs/counts are retained, never prompt bodies.
class SyntheticSocket {
	static OPEN = 1;
	static CONNECTING = 0;
	static CLOSED = 3;
	static instances: SyntheticSocket[] = [];
	readyState = SyntheticSocket.CONNECTING;
	onopen: (() => void) | null = null;
	onmessage: ((event: { data: string }) => void) | null = null;
	onclose: ((event: { code: number; reason: string }) => void) | null = null;
	onerror: (() => void) | null = null;
	pages: PagingMetadata[] = [];
	promptCount = 0;
	promptIds: (string | undefined)[] = [];

	constructor() {
		SyntheticSocket.instances.push(this);
	}

	send(wire: string) {
		const data = JSON.parse(wire) as {
			type?: string;
			conversationId?: string;
			beforeIndex?: number;
			limit?: number;
			count?: number;
			id?: string;
		};
		if (data.type === "load_earlier_messages" || data.type === "load_older") {
			this.pages.push({
				type: data.type,
				conversationId: data.conversationId,
				beforeIndex: data.beforeIndex,
				limit: data.limit,
				count: data.count,
			});
		}
		if (data.type === "prompt") {
			this.promptCount++;
			this.promptIds.push(data.id);
		}
		if ("recovery" in data && data.recovery) {
			this.onmessage?.({
				data: JSON.stringify({
					type: "command_disposition",
					recovery: data.recovery,
					connectionGeneration: "synthetic-gen",
					commandType: data.type,
					status: "uncertain",
					retryable: false,
					reason: "dispatch-started",
					persistence: "unknown",
					releaseClientCopy: false,
				}),
			});
		}
	}

	open() {
		act(() => {
			this.readyState = SyntheticSocket.OPEN;
			this.onopen?.();
		});
	}

	// One call is one React act; separate calls guarantee a render between replies.
	receive(...frames: object[]) {
		act(() => {
			for (const frame of frames) this.onmessage?.({ data: JSON.stringify(frame) });
		});
	}

	close() {
		this.readyState = SyntheticSocket.CLOSED;
		this.onclose?.({ code: 1000, reason: "synthetic cleanup" });
	}
}

const inputProps: ComponentProps<typeof ChatInput> = {
	streaming: false,
	messages: [],
	slashCommands: [],
	modelState: null,
	models: [],
	modelsLoading: false,
	attachments: [],
	providerKeys: {},
	onRemoveAttachment() {},
	onAddImageFiles() {},
	onAddLocalFiles() {},
	onNotice() {},
	onSent() {},
	onManageModels() {},
};

let api: ReturnType<typeof useChat>;
function HookHarness({ composer, list, onSent }: { composer?: boolean; list?: boolean; onSent?: () => void }) {
	api = useChat();
	const state = api.chat.state;
	if (!state) return null;
	return createElement(
		Fragment,
		null,
		composer
			? createElement(ChatInput, {
					...inputProps,
					conversationId: state.conversationId,
					sessionId: state.sessionId || undefined,
					messages: state.messages,
					streaming: state.isStreaming,
					sessionDraft: state.draft ?? null,
					onSent: onSent ?? inputProps.onSent,
				})
			: null,
		list
			? createElement(MessageList, {
					state,
					liveOutputs: new Map(),
					toolStatuses: new Map(),
					onLoadOlder: (beforeIndex, count) => api.send({ type: "load_older", beforeIndex, count }),
				})
			: null,
	);
}

function startHook(
	initial: UiState,
	options: { composer?: boolean; list?: boolean; engine?: "pi" | "dsh"; onSent?: () => void } = {},
) {
	const view = mount(
		createElement(HookHarness, { composer: options.composer, list: options.list, onSent: options.onSent }),
	);
	const socket = SyntheticSocket.instances[0];
	expect(SyntheticSocket.instances).toHaveLength(1);
	socket.open();
	socket.receive({
		type: "ready",
		serverVersion: "synthetic",
		appVersion: "synthetic",
		engine: options.engine ?? "pi",
		managed: true,
		commandRecovery: 1,
		recoveryGeneration: "synthetic-gen",
	});
	socket.receive({ type: "snapshot", state: initial });
	socket.receive({ type: "session_initialized", connectionGeneration: "synthetic-gen" });
	return { ...view, socket };
}

function earlierPage(from: number, until: number, conversationId = HISTORY_A, prefix = "m") {
	return { type: "earlier_messages", conversationId, messages: messages(from, until, prefix) };
}

function requestEarlier(beforeIndex: number, repeat = 1) {
	act(() => {
		for (let i = 0; i < repeat; i++) api.send({ type: "load_older", beforeIndex, count: 30 });
	});
}

function expectedRequest(beforeIndex: number, conversationId = HISTORY_A): PagingMetadata {
	return { type: "load_earlier_messages", conversationId, beforeIndex, limit: 30, count: 30 };
}

function expectHistory(start: number, expectedIds: string[], conversationId = HISTORY_A) {
	const state = api.chat.state;
	expect(state?.conversationId).toBe(conversationId);
	expect(state?.messagesStart).toBe(start);
	const actualIds = state?.messages.map((item) => item.id);
	expect(actualIds).toEqual(expectedIds);
	expect(new Set(actualIds).size).toBe(expectedIds.length);
}

function expectHistoryWindow(start: number) {
	expect((api.chat.state as HistorySnapshot | null)?.historyWindow).toEqual({
		hasEarlier: start > 0,
		hiddenCount: start,
		earliestIndex: start,
	});
}

function textarea(host: HTMLElement): HTMLTextAreaElement {
	const input = host.querySelector<HTMLTextAreaElement>("textarea");
	if (!input) throw new Error("Synthetic composer textarea was not mounted");
	return input;
}

function sendButton(host: HTMLElement): HTMLButtonElement {
	const button = host.querySelector<HTMLButtonElement>(".btn.send");
	if (!button) throw new Error("Synthetic composer Send button was not mounted");
	return button;
}

function typeText(host: HTMLElement, value: string) {
	const input = textarea(host);
	const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
	act(() => {
		setter.call(input, value);
		input.dispatchEvent(new Event("input", { bubbles: true }));
	});
	expect(textarea(host).value).toBe(value);
}

function pressEnter(host: HTMLElement) {
	act(() => {
		textarea(host).dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
	});
}

function tick(ms: number) {
	act(() => vi.advanceTimersByTime(ms));
}

beforeEach(() => {
	vi.useFakeTimers({ now: T0 });
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	vi.stubGlobal("WebSocket", SyntheticSocket);
	vi.stubGlobal("fetch", () => {
		throw new Error("Synthetic client regression fixtures must not make HTTP requests");
	});
	vi.stubGlobal(
		"ResizeObserver",
		class {
			observe() {}
			unobserve() {}
			disconnect() {}
		},
	);
	vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
	SyntheticSocket.instances = [];
	localStorage.clear();
	sessionStorage.clear();
	localStorage.setItem("pi-web-ui:lang", "en");
	const records = new Map<string, RecoveryRecord>();
	const activeOwners = new Set<string>();
	const backend: PendingRecoveryBackend = {
		async read(ownerId) {
			return structuredClone([...records.values()].filter((r) => r.ownerId === ownerId));
		},
		async write(batch) {
			for (const r of batch) records.set(JSON.stringify(r.key), structuredClone(r));
		},
		async release(record) {
			records.set(JSON.stringify(record.key), structuredClone(record));
		},
	};
	setNativeRecoveryCoordinatorFactory((verifyReference) =>
		createPendingRecoveryCoordinator({
			backend,
			listOwners: async () => [...new Set([...records.values()].map((r) => r.ownerId))],
			ownership: {
				async acquire(ownerId) {
					if (activeOwners.has(ownerId)) return null;
					activeOwners.add(ownerId);
					return { release: () => activeOwners.delete(ownerId) };
				},
				async active() {
					return [...activeOwners];
				},
			},
			verifyReference,
		}),
	);
	resetAppGlobals();
	setAppSend(null);
	resetComposerSinks();
});

afterEach(() => {
	act(() => {
		for (const root of roots.splice(0)) root.unmount();
	});
	setNativeRecoveryCoordinatorFactory(undefined);
	resetComposerSinks();
	resetAppGlobals();
	setAppSend(null);
	window.getSelection()?.removeAllRanges();
	document.body.innerHTML = "";
	vi.clearAllTimers();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

describe("Ops #574 MessageList manual paging", () => {
	it("preserves the latest user-adjusted scroll offset when the requested page prepends", () => {
		const onLoadOlder = vi.fn();
		const list = (state: UiState) =>
			createElement(MessageList, { state, liveOutputs: new Map(), toolStatuses: new Map(), onLoadOlder });
		const { host, render } = mount(list(historySnapshot(2, HISTORY_A, "m", 4)));
		const scroll = host.querySelector<HTMLDivElement>(".messages")!;
		let height = 300;
		Object.defineProperties(scroll, {
			scrollHeight: { configurable: true, get: () => height },
			clientHeight: { configurable: true, value: 100 },
		});
		scroll.scrollTop = 40;
		act(() => host.querySelector<HTMLButtonElement>(".load-older button")!.click());
		scroll.scrollTop = 55;
		act(() => scroll.dispatchEvent(new Event("scroll", { bubbles: true })));
		height = 600;
		render(list(historySnapshot(1, HISTORY_A, "m", 4)));
		expect(onLoadOlder.mock.calls).toEqual([[2, 30]]);
		expect(scroll.scrollTop).toBe(355);
	});

	it("releases the old session's pending anchor when a replacement has the same conversation and cursor", () => {
		const onLoadOlder = vi.fn();
		const list = (state: UiState) =>
			createElement(MessageList, { state, liveOutputs: new Map(), toolStatuses: new Map(), onLoadOlder });
		const a = historySnapshot();
		const { host, render } = mount(list(a));
		const clickOlder = () => host.querySelector<HTMLButtonElement>(".load-older button")!.click();
		act(clickOlder);
		expect(onLoadOlder.mock.calls).toEqual([[60, 30]]);
		render(list({ ...a, sessionId: "synthetic-replacement-session", rev: 2 }));
		act(() => {
			clickOlder();
			clickOlder();
		});
		expect(onLoadOlder.mock.calls).toEqual([
			[60, 30],
			[60, 30],
		]);
	});

	it("coalesces rapid manual clicks at one cursor, then permits exactly one request at the next cursor", () => {
		const onLoadOlder = vi.fn();
		const list = (state: UiState) =>
			createElement(MessageList, { state, liveOutputs: new Map(), toolStatuses: new Map(), onLoadOlder });
		const { host, render } = mount(list(historySnapshot(2, HISTORY_A, "m", 4)));
		const clickOlder = () => {
			const button = host.querySelector<HTMLButtonElement>(".load-older button");
			if (!button) throw new Error("Synthetic older-history button was not mounted");
			button.click();
		};

		act(() => {
			clickOlder();
			clickOlder();
			clickOlder();
		});
		expect(onLoadOlder.mock.calls).toEqual([[2, 30]]);
		// A new render without a prepend must not unlock that same pending cursor.
		render(list({ ...historySnapshot(2, HISTORY_A, "m", 4), rev: 2 }));
		act(clickOlder);
		expect(onLoadOlder.mock.calls).toEqual([[2, 30]]);

		render(list(historySnapshot(1, HISTORY_A, "m", 4)));
		act(() => {
			clickOlder();
			clickOlder();
		});
		expect(onLoadOlder.mock.calls).toEqual([
			[2, 30],
			[1, 30],
		]);
		render(list(historySnapshot(0, HISTORY_A, "m", 4)));
		expect(host.querySelector(".load-older button")).toBeNull();
		expect(onLoadOlder).toHaveBeenCalledTimes(2);
	});
});

describe("Ops #574 real useChat request-bound paging", () => {
	it("anchors an accepted prepend when its reply and same-scope reconnect commit together", () => {
		const initial = historySnapshot(2, HISTORY_A, "m", 4);
		const { host, socket } = startHook(initial, { list: true });
		const scroll = host.querySelector<HTMLDivElement>(".messages")!;
		let height = 300;
		Object.defineProperties(scroll, {
			scrollHeight: { configurable: true, get: () => height },
			clientHeight: { configurable: true, value: 100 },
		});
		scroll.scrollTop = 55;
		act(() => host.querySelector<HTMLButtonElement>(".load-older button")!.click());
		height = 600;
		act(() => {
			socket.receive(earlierPage(1, 2));
			socket.close();
			vi.advanceTimersByTime(1_000);
			expect(SyntheticSocket.instances).toHaveLength(2);
			const next = SyntheticSocket.instances[1];
			next.open();
			next.receive({ type: "ready", engine: "pi", managed: true }, { type: "snapshot", state: { ...initial, rev: 2 } });
		});
		expectHistory(1, ids(1, 4));
		expect(scroll.scrollTop).toBe(355);
		act(() => host.querySelector<HTMLButtonElement>(".load-older button")!.click());
		expect(SyntheticSocket.instances[1].pages).toEqual([expectedRequest(1)]);
	});

	it.each([false, true])("unlocks manual paging after same-session reconnect (batched lifecycle: %s)", (batched) => {
		const initial = historySnapshot();
		const { host, socket } = startHook(initial, { list: true });
		const clickOlder = () => host.querySelector<HTMLButtonElement>(".load-older button")!.click();
		act(() => {
			clickOlder();
			clickOlder();
		});
		expect(socket.pages).toEqual([expectedRequest(60)]);
		const finishReconnect = () => {
			vi.advanceTimersByTime(1_000);
			expect(SyntheticSocket.instances).toHaveLength(2);
			const next = SyntheticSocket.instances[1];
			next.open();
			next.receive({ type: "ready", engine: "pi", managed: true }, { type: "snapshot", state: { ...initial, rev: 2 } });
		};
		if (batched) {
			act(() => {
				socket.close();
				finishReconnect();
			});
		} else {
			act(() => socket.close());
			act(finishReconnect);
		}
		const next = SyntheticSocket.instances[1];
		act(() => {
			clickOlder();
			clickOlder();
		});
		expect(next.pages).toEqual([expectedRequest(60)]);
		next.receive(earlierPage(30, 60));
		expectHistory(30, ids(30, 62));
		expectHistoryWindow(30);
	});

	it.each(["historyWindow", "historyStart"] as const)(
		"normalizes %s and deduplicates repeated hook requests before and after a render",
		(dialect) => {
			const state = historySnapshot();
			const { historyWindow, ...withoutWindow } = state;
			const initial =
				dialect === "historyWindow"
					? state
					: { ...withoutWindow, messagesStart: 0, historyStart: historyWindow.earliestIndex };
			const { socket, render } = startHook(initial);
			expectHistory(60, ["m60", "m61"]);
			requestEarlier(60, 4);
			expect(socket.pages).toEqual([expectedRequest(60)]);
			render(createElement(HookHarness));
			requestEarlier(60, 2);
			expect(socket.pages).toEqual([expectedRequest(60)]);
			socket.receive({ ...earlierPage(30, 60), historyStart: 30 });
			expectHistory(30, ids(30, 62));
			requestEarlier(30, 3);
			expect(socket.pages).toEqual([expectedRequest(60), expectedRequest(30)]);
		},
	);

	it("does not invent a new position for an unpositioned duplicate delivered after a render", () => {
		const { socket } = startHook(historySnapshot());
		requestEarlier(60);
		socket.receive(earlierPage(30, 60));
		expectHistory(30, ids(30, 62));
		expectHistoryWindow(30);
		// This is a separate act: the hook now visibly holds cursor 30, not cursor 60.
		socket.receive(earlierPage(30, 60));
		expectHistory(30, ids(30, 62));
		expectHistoryWindow(30);
		expect(socket.pages).toEqual([expectedRequest(60)]);
	});

	it("keeps the second request pending when a stale unpositioned first-page reply arrives", () => {
		const { socket } = startHook(historySnapshot());
		requestEarlier(60);
		socket.receive(earlierPage(30, 60));
		expectHistory(30, ids(30, 62));
		requestEarlier(30, 3);
		expect(socket.pages).toEqual([expectedRequest(60), expectedRequest(30)]);

		socket.receive(earlierPage(30, 60));
		expectHistory(30, ids(30, 62));
		// An explicit stale duplicate is no more eligible than the unpositioned copy.
		socket.receive({ ...earlierPage(30, 60), historyStart: 30 });
		expectHistory(30, ids(30, 62));
		requestEarlier(30, 2);
		expect(socket.pages).toEqual([expectedRequest(60), expectedRequest(30)]);

		socket.receive(earlierPage(0, 30));
		expectHistory(0, ids(0, 62));
		expectHistoryWindow(0);
		expect(socket.pages).toEqual([expectedRequest(60), expectedRequest(30)]);
	});

	it("handles duplicate replies and a stale/current reply burst inside single React acts", () => {
		const { socket } = startHook(historySnapshot());
		requestEarlier(60, 3);
		socket.receive(earlierPage(30, 60), earlierPage(30, 60));
		expectHistory(30, ids(30, 62));
		expectHistoryWindow(30);
		requestEarlier(30, 3);
		// The stale first page must not consume the second request before its real reply.
		socket.receive(earlierPage(30, 60), earlierPage(0, 30), earlierPage(0, 30));
		expectHistory(0, ids(0, 62));
		expectHistoryWindow(0);
		expect(socket.pages).toEqual([expectedRequest(60), expectedRequest(30)]);
	});

	it.each([
		{ name: "another conversation", fields: { conversationId: HISTORY_B, historyStart: 30 } },
		{ name: "a gap before the current window", fields: { historyStart: 29 } },
		{ name: "an overlapping explicit range", fields: { historyStart: 31 } },
		{ name: "a stale later range", fields: { historyStart: 60 } },
		{ name: "a negative historyStart", fields: { historyStart: -1 } },
		{ name: "a fractional historyStart", fields: { historyStart: 30.5 } },
		{ name: "an unsafe historyStart", fields: { historyStart: Number.MAX_SAFE_INTEGER + 1 } },
		{ name: "a negative start", fields: { start: -1 } },
		{
			name: "a malformed historyWindow cursor",
			fields: { historyWindow: { earliestIndex: -1, hasEarlier: true, hiddenCount: 30 } },
		},
	])("ignores $name without spending or duplicating the pending request", ({ fields }) => {
		const { socket } = startHook(historySnapshot());
		requestEarlier(60);
		socket.receive({ ...earlierPage(30, 60), ...fields });
		expectHistory(60, ["m60", "m61"]);
		expectHistoryWindow(60);
		requestEarlier(60, 2);
		expect(socket.pages).toEqual([expectedRequest(60)]);
		socket.receive(earlierPage(30, 60));
		expectHistory(30, ids(30, 62));
		expectHistoryWindow(30);
		expect(socket.pages).toEqual([expectedRequest(60)]);
	});

	it.each([
		{ name: "start", fields: { start: 30 } },
		{ name: "historyStart", fields: { historyStart: 30 } },
		{
			name: "historyWindow.earliestIndex",
			fields: { historyWindow: { earliestIndex: 30, hasEarlier: true, hiddenCount: 30 } },
		},
	])("honors a contiguous explicit $name rather than inventing a position", ({ fields }) => {
		const { socket } = startHook(historySnapshot());
		requestEarlier(60);
		socket.receive({ ...earlierPage(30, 60), ...fields });
		expectHistory(30, ids(30, 62));
		expectHistoryWindow(30);
		socket.receive({ ...earlierPage(30, 60), ...fields });
		expectHistory(30, ids(30, 62));
		requestEarlier(30, 2);
		expect(socket.pages).toEqual([expectedRequest(60), expectedRequest(30)]);
	});

	it("rejects a completed old-session page replayed after replacement, before assigning any new position", () => {
		const s1 = { ...historySnapshot(), sessionId: "synthetic-completed-s1" };
		const s2 = { ...historySnapshot(60, HISTORY_A, "s2-"), sessionId: "synthetic-completed-s2", rev: 2 };
		const { socket } = startHook(s1);
		requestEarlier(60);
		socket.receive(earlierPage(30, 60));
		expectHistory(30, ids(30, 62));
		socket.receive({ type: "snapshot", state: s2 });
		requestEarlier(60);
		socket.receive(earlierPage(30, 60));
		expectHistory(60, ["s2-60", "s2-61"]);
		socket.receive({ ...earlierPage(30, 60), start: 30 });
		expectHistory(60, ["s2-60", "s2-61"]);
		socket.receive({ ...earlierPage(30, 60, HISTORY_A, "s2-"), start: 30, sessionId: s2.sessionId });
		expectHistory(30, ids(30, 62, "s2-"));
		expectHistoryWindow(30);
		expect(socket.pages).toEqual([expectedRequest(60), expectedRequest(60)]);
	});

	it("does not guess an ambiguous page after the same conversation switches from session s1 to s2", () => {
		const s1 = { ...historySnapshot(), sessionId: "synthetic-bound-s1" };
		const s2 = { ...historySnapshot(60, HISTORY_A, "s2-"), sessionId: "synthetic-bound-s2", rev: 2 };
		const { socket } = startHook(s1);
		requestEarlier(60);
		socket.receive({ type: "snapshot", state: s2 });
		requestEarlier(60, 3);
		expect(api.chat.state?.sessionId).toBe("synthetic-bound-s2");
		expectHistory(60, ["s2-60", "s2-61"]);
		expect(socket.pages).toEqual([expectedRequest(60), expectedRequest(60)]);

		// Position and conversation match both outstanding generations: without a session
		// or wire request id, these novel IDs cannot safely be assigned to s2.
		socket.receive({ ...earlierPage(30, 60, HISTORY_A, "ambiguous-"), historyStart: 30 });
		expectHistory(60, ["s2-60", "s2-61"]);
		expectHistoryWindow(60);
		requestEarlier(60, 2);
		expect(socket.pages).toEqual([expectedRequest(60), expectedRequest(60)]);
		socket.receive({
			...earlierPage(30, 60),
			historyStart: 30,
			sessionId: "synthetic-bound-s1",
		});
		expectHistory(60, ["s2-60", "s2-61"]);
		expect(api.chat.state?.sessionId).toBe("synthetic-bound-s2");
		requestEarlier(60);
		expect(socket.pages).toEqual([expectedRequest(60), expectedRequest(60)]);

		// Optional existing wire metadata is sufficient to disambiguate the s2 response;
		// no production helper or new request-correlation mechanism is assumed here.
		socket.receive({
			...earlierPage(30, 60, HISTORY_A, "s2-"),
			historyStart: 30,
			sessionId: "synthetic-bound-s2",
		});
		expectHistory(30, ids(30, 62, "s2-"));
		expectHistoryWindow(30);
		requestEarlier(30, 2);
		expect(socket.pages).toEqual([expectedRequest(60), expectedRequest(60), expectedRequest(30)]);
		socket.receive({
			...earlierPage(0, 30),
			historyStart: 0,
			sessionId: "synthetic-bound-s1",
		});
		expectHistory(30, ids(30, 62, "s2-"));
		socket.receive({
			...earlierPage(0, 30, HISTORY_A, "s2-"),
			historyStart: 0,
			sessionId: "synthetic-bound-s2",
		});
		expectHistory(0, ids(0, 62, "s2-"));
		expectHistoryWindow(0);
		expect(api.chat.state?.sessionId).toBe("synthetic-bound-s2");
		expect(socket.pages).toEqual([expectedRequest(60), expectedRequest(60), expectedRequest(30)]);
	});

	it("requires an explicit position after abandoning a request and returning to the same conversation", () => {
		const a = historySnapshot();
		const { socket } = startHook(a);
		requestEarlier(60);
		socket.receive({ type: "snapshot", state: historySnapshot(60, HISTORY_B, "b") });
		socket.receive({ type: "snapshot", state: { ...a, rev: 2 } });
		requestEarlier(60);
		expect(socket.pages).toEqual([expectedRequest(60), expectedRequest(60)]);
		socket.receive(earlierPage(30, 60));
		expectHistory(60, ["m60", "m61"]);
		socket.receive({ ...earlierPage(30, 60), start: 30 });
		expectHistory(30, ids(30, 62));
		expectHistoryWindow(30);
	});

	it("isolates a new conversation from late unpositioned replies for the previous conversation", () => {
		const { socket } = startHook(historySnapshot());
		requestEarlier(60);
		socket.receive({ type: "snapshot", state: historySnapshot(60, HISTORY_B, "b") });
		requestEarlier(60, 2);
		expect(socket.pages).toEqual([expectedRequest(60), expectedRequest(60, HISTORY_B)]);
		socket.receive(earlierPage(30, 60));
		expectHistory(60, ["b60", "b61"], HISTORY_B);
		requestEarlier(60);
		expect(socket.pages).toEqual([expectedRequest(60), expectedRequest(60, HISTORY_B)]);
		socket.receive(earlierPage(30, 60, HISTORY_B, "b"));
		expectHistory(30, ids(30, 62, "b"), HISTORY_B);
		socket.receive(earlierPage(30, 60));
		expectHistory(30, ids(30, 62, "b"), HISTORY_B);
		expect(socket.pages).toEqual([expectedRequest(60), expectedRequest(60, HISTORY_B)]);
	});
});

describe("Ops #574 composer identity and initialization", () => {
	it("preserves a typed plus quoted Pi draft through initialization and sends it exactly once via useChat", async () => {
		const initial = snapshot({ sessionId: undefined }); // conversationId is already known.
		const onSent = vi.fn();
		const { host, socket } = startHook(initial, { composer: true, onSent });
		expect(textarea(host).disabled).toBe(false);
		expect(textarea(host).placeholder).toContain("initializing");
		typeText(host, "Synthetic typed draft.");
		act(() => {
			expect(composeToComposer({ text: formatQuote("Synthetic quote.\n\nAnother line.") })).toBe(true);
		});
		const expected = "Synthetic typed draft.\n> Synthetic quote.\n>\n> Another line.\n\n";
		expect(textarea(host).value).toBe(expected);
		expect(sendButton(host).disabled).toBe(true);
		pressEnter(host);
		act(() => sendButton(host).click());
		tick(2_500);
		expect(textarea(host).value).toBe(expected);
		expect(socket.promptCount).toBe(0);
		expect(api.chat.pendingSends).toEqual([]);
		expect(onSent).not.toHaveBeenCalled();

		socket.receive({ type: "snapshot", state: snapshot({ rev: 2 }) });
		expect(textarea(host).value).toBe(expected);
		expect(textarea(host).placeholder).not.toContain("initializing");
		expect(sendButton(host).disabled).toBe(false);
		expect(socket.promptCount).toBe(0); // Binding is not an implicit submit.
		await act(async () => {
			for (let i = 0; i < 6; i++) await crypto.subtle.digest("SHA-256", new Uint8Array(0));
			textarea(host).dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
			for (let i = 0; i < 8; i++) await crypto.subtle.digest("SHA-256", new Uint8Array(0));
		});
		expect(socket.promptCount).toBe(1);
		expect(socket.promptIds).toEqual([expect.any(String)]);
		expect(
			api.chat.pendingSends.map(({ id, text, conversationId, sessionId, status }) => ({
				id,
				text,
				conversationId,
				sessionId,
				status,
			})),
		).toEqual([
			{
				id: socket.promptIds[0],
				text: expected,
				conversationId: initial.conversationId,
				sessionId: "synthetic-session-a",
				status: "sending",
			},
		]);
		expect(api.chat.state?.isStreaming).toBe(false);
		expect(textarea(host).value).toBe("");
		expect(onSent).toHaveBeenCalledTimes(1);
		// Empty Enter/clicks and a late pre-submit draft snapshot cannot replay that send.
		pressEnter(host);
		act(() => sendButton(host).click());
		socket.receive({ type: "snapshot", state: snapshot({ rev: 3, draft: { text: expected, ts: T0 } }) });
		tick(2_500);
		expect(textarea(host).value).toBe("");
		expect(socket.promptCount).toBe(1);
		expect(api.chat.pendingSends).toHaveLength(1);
		expect(onSent).toHaveBeenCalledTimes(1);
	});

	it("keeps a raw host-quoted draft at first Pi binding instead of replacing it with late saved text", () => {
		const initial = snapshot({ sessionId: undefined });
		const { host, socket } = startHook(initial, { composer: true });
		tick(20);
		// Already-quoted host text enters through the public draft bridge, not a keyboard
		// event or the quote-formatting helper. Its trailing blank line is intentional.
		const expected = "> Synthetic raw host quote.\n>\n>     Preserve these literal spaces.\n\n";
		act(() => {
			expect(composeToComposer({ text: expected })).toBe(true);
		});
		expect(textarea(host).value).toBe(expected);
		expect(sendButton(host).disabled).toBe(true);
		expect(socket.promptCount).toBe(0);

		socket.receive({
			type: "snapshot",
			state: snapshot({ rev: 2, draft: { text: "Synthetic saved text predating the host quote.", ts: T0 + 5 } }),
		});
		expect(textarea(host).value).toBe(expected);
		expect(sendButton(host).disabled).toBe(false);
		socket.receive({
			type: "snapshot",
			state: snapshot({
				rev: 3,
				draft: { text: "Synthetic delayed saved text, still older than the quote.", ts: T0 + 10 },
			}),
		});
		expect(textarea(host).value).toBe(expected);
		tick(2_500);
		expect(textarea(host).value).toBe(expected);
		expect(socket.promptCount).toBe(0);
		expect(api.chat.pendingSends).toEqual([]);
	});

	it("does not give another provisional Pi conversation the previous initialization draft", () => {
		const initial = snapshot({ sessionId: undefined });
		const { host, socket } = startHook(initial, { composer: true });
		typeText(host, "Synthetic provisional A draft.");
		const next = snapshot({ conversationId: "synthetic-draft-b", sessionId: undefined });
		socket.receive({ type: "snapshot", state: next });
		expect(textarea(host).value).toBe("");
		expect(sendButton(host).disabled).toBe(true);
		typeText(host, "Synthetic provisional B draft.");
		socket.receive({ type: "snapshot", state: { ...next, sessionId: "synthetic-session-b", rev: 2 } });
		expect(textarea(host).value).toBe("Synthetic provisional B draft.");
		expect(sendButton(host).disabled).toBe(false);
		expect(socket.promptCount).toBe(0);
		expect(api.chat.pendingSends).toEqual([]);
	});

	it("restores each bound Pi session's own locally edited draft when switching back and forth", () => {
		const a = snapshot();
		const b = snapshot({ conversationId: "synthetic-draft-b", sessionId: "synthetic-session-b" });
		const { host, socket } = startHook(a, { composer: true });
		typeText(host, "Synthetic bound A draft.");
		socket.receive({ type: "snapshot", state: b });
		expect(textarea(host).value).toBe("");
		typeText(host, "Synthetic bound B draft.");
		socket.receive({ type: "snapshot", state: { ...a, rev: 2 } });
		expect(textarea(host).value).toBe("Synthetic bound A draft.");
		socket.receive({ type: "snapshot", state: { ...b, rev: 2 } });
		expect(textarea(host).value).toBe("Synthetic bound B draft.");
		tick(2_500);
		expect(textarea(host).value).toBe("Synthetic bound B draft.");
		expect(socket.promptCount).toBe(0);
		expect(api.chat.pendingSends).toEqual([]);
	});

	it("retains text and edits across a transient same-conversation no-session gap and return to the same session", () => {
		const a = snapshot();
		const { host, socket } = startHook(a, { composer: true });
		typeText(host, "Synthetic draft before the session gap.");
		socket.receive({ type: "snapshot", state: { ...a, sessionId: undefined, rev: 2 } });
		expect(textarea(host).value).toBe("Synthetic draft before the session gap.");
		expect(textarea(host).disabled).toBe(false);
		expect(sendButton(host).disabled).toBe(true);
		const expected = "Synthetic draft before the session gap.\nEdited while the session was absent.";
		typeText(host, expected);
		pressEnter(host);
		expect(socket.promptCount).toBe(0);
		socket.receive({ type: "snapshot", state: { ...a, rev: 3 } });
		expect(textarea(host).value).toBe(expected);
		expect(sendButton(host).disabled).toBe(false);
		expect(socket.promptCount).toBe(0);
		expect(api.chat.pendingSends).toEqual([]);
	});

	it("does not carry a bound session draft into its same-slot replacement after a no-session gap", () => {
		const a = snapshot();
		const { host, socket } = startHook(a, { composer: true });
		typeText(host, "Synthetic old bound-session draft.");
		socket.receive({ type: "snapshot", state: { ...a, sessionId: undefined, rev: 2 } });
		expect(textarea(host).value).toBe("Synthetic old bound-session draft.");
		socket.receive({
			type: "snapshot",
			state: {
				...a,
				sessionId: "synthetic-replacement-session",
				rev: 3,
				draft: { text: "Synthetic replacement draft.", ts: T0 + 1 },
			},
		});
		expect(textarea(host).value).toBe("Synthetic replacement draft.");
		expect(socket.promptCount).toBe(0);
		expect(api.chat.pendingSends).toEqual([]);
	});

	it("keeps DSH no-session sending functional through the real pending-send path", async () => {
		const a = snapshot({ conversationId: "synthetic-dsh-a", sessionId: undefined });
		const onSent = vi.fn();
		const { host, socket } = startHook(a, { engine: "dsh", composer: true, onSent });
		expect(textarea(host).placeholder).not.toContain("initializing");
		typeText(host, "Synthetic DSH no-session send.");
		expect(sendButton(host).disabled).toBe(false);
		await act(async () => {
			for (let i = 0; i < 6; i++) await crypto.subtle.digest("SHA-256", new Uint8Array(0));
			sendButton(host).click();
			for (let i = 0; i < 8; i++) await crypto.subtle.digest("SHA-256", new Uint8Array(0));
		});
		expect(socket.promptCount).toBe(1);
		expect(socket.promptIds).toEqual([expect.any(String)]);
		expect(api.chat.pendingSends).toHaveLength(1);
		expect(api.chat.pendingSends[0]).toMatchObject({
			id: socket.promptIds[0],
			conversationId: "synthetic-dsh-a",
			text: "Synthetic DSH no-session send.",
			status: "sending",
		});
		expect(api.chat.pendingSends[0].sessionId).toBeUndefined();
		expect(textarea(host).value).toBe("");
		expect(onSent).toHaveBeenCalledTimes(1);
	});

	it("isolates DSH drafts on a conversation change even when both conversations have no session", async () => {
		const a = snapshot({ conversationId: "synthetic-dsh-a", sessionId: undefined });
		const b = snapshot({ conversationId: "synthetic-dsh-b", sessionId: undefined });
		const { host, socket } = startHook(a, { engine: "dsh", composer: true });
		typeText(host, "Synthetic DSH A unsent draft.");
		socket.receive({ type: "snapshot", state: b });
		expect(textarea(host).value).toBe("");
		expect(socket.promptCount).toBe(0);
		typeText(host, "Synthetic DSH B only.");
		await act(async () => {
			for (let i = 0; i < 6; i++) await crypto.subtle.digest("SHA-256", new Uint8Array(0));
			textarea(host).dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
			for (let i = 0; i < 8; i++) await crypto.subtle.digest("SHA-256", new Uint8Array(0));
		});
		expect(socket.promptCount).toBe(1);
		expect(socket.promptIds).toEqual([expect.any(String)]);
		expect(api.chat.pendingSends).toHaveLength(1);
		expect(api.chat.pendingSends[0].conversationId).toBe("synthetic-dsh-b");
		expect(api.chat.pendingSends[0].text).toBe("Synthetic DSH B only.");
		expect(textarea(host).value).toBe("");
	});
});

const CODE_MARKER = "[[action:suggest:Review|Review the synthetic change]]";
const CODE_PROMPT_MARKER = '[[action:suggest:label="Inspect",prompt="Inspect the synthetic change"]]';
const VISIBLE_ACTION = { label: "Review", prompt: "Review the synthetic change" };

// These are valid Markdown blocks/spans, not parser-derived ranges. Every closed-code fixture
// is followed by the SAME marker in prose: code must stay byte-for-byte and not claim dedup.
const closedCodeCases = [
	{ name: "four-space indented block", code: `    ${CODE_MARKER}\n    ${CODE_PROMPT_MARKER}` },
	{ name: "tab-indented block", code: `\t${CODE_MARKER}\n\t${CODE_PROMPT_MARKER}` },
	{ name: "mixed space/tab indentation reaching column four", code: `  \t${CODE_MARKER}\n \t${CODE_PROMPT_MARKER}` },
	{
		name: "space-indented block continuing across an unindented blank line",
		code: `    ${CODE_MARKER}\n\n    ${CODE_PROMPT_MARKER}`,
	},
	{
		name: "tab-indented block continuing across blank and whitespace-only lines",
		code: `\t${CODE_MARKER}\n\n\t\n\t${CODE_PROMPT_MARKER}`,
	},
	{ name: "triple-backtick fence", code: `\`\`\`text\n${CODE_MARKER}\n${CODE_PROMPT_MARKER}\n\`\`\`` },
	{ name: "triple-tilde fence", code: `~~~text\n${CODE_MARKER}\n${CODE_PROMPT_MARKER}\n~~~` },
	{
		name: "four-backtick fence with a shorter triple fence inside",
		code: `\`\`\`\`text\n\`\`\`\n${CODE_MARKER}\n${CODE_PROMPT_MARKER}\n\`\`\`\``,
	},
	{
		name: "five-backtick opening and longer closing fence",
		code: `\`\`\`\`\`text\n\`\`\`\`\n${CODE_MARKER}\n\`\`\`\`\`\`\``,
	},
	{
		name: "four-tilde fence with a shorter triple fence inside",
		code: `~~~~text\n~~~\n${CODE_MARKER}\n${CODE_PROMPT_MARKER}\n~~~~`,
	},
	{ name: "five-tilde opening and longer closing fence", code: `~~~~~text\n~~~~\n${CODE_MARKER}\n~~~~~~~` },
	{
		name: "fences indented by up to three spaces and a whitespace-suffixed closer",
		code: `   \`\`\`\`text\n${CODE_MARKER}\n  \`\`\`\`\` \t`,
	},
	{
		name: "backtick fence containing an opposite-character fence",
		code: `\`\`\`\`text\n~~~~~~\n${CODE_MARKER}\n\`\`\`\``,
	},
	{ name: "tilde fence containing an opposite-character fence", code: `~~~~text\n\`\`\`\`\`\`\n${CODE_MARKER}\n~~~~` },
	{
		name: "a fence-like line with trailing prose is not a closer",
		code: `~~~~text\n~~~~ not a closer\n${CODE_MARKER}\n~~~~`,
	},
	{ name: "single-backtick inline span", code: `Example \`${CODE_MARKER}\` stays literal.` },
	{
		name: "double-backtick inline span containing a single backtick",
		code: `Example \`\`one \` ${CODE_MARKER} two\`\` stays literal.`,
	},
	{
		name: "single-backtick inline span containing a double backtick",
		code: `Example \`one \`\` ${CODE_MARKER} two\` stays literal.`,
	},
	{
		name: "triple-backtick inline span with shorter interior delimiters",
		code: `Example \`\`\`one \`\` ${CODE_MARKER} \` two\`\`\` stays literal.`,
	},
	{
		name: "matching inline delimiters across a newline",
		code: `Example \`\`one\n${CODE_MARKER}\ntwo\`\` stays literal.`,
	},
];

describe("Ops #574 Markdown code-safe action suggestions", () => {
	it("extracts a prose suggestion whose prompt contains inline code", () => {
		expect(parseActionSuggestions("Next [[action:suggest:Fix|Fix `foo()`]] please.")).toEqual({
			text: "Next  please.",
			actions: [{ label: "Fix", prompt: "Fix `foo()`" }],
		});
	});

	it.each([
		{ name: "fenced", code: "```text\n[[action:suggest:unfinished\n```" },
		{ name: "indented", code: "    [[action:suggest:unfinished" },
		{ name: "inline", code: "`[[action:suggest:unfinished`" },
	])("does not let an incomplete $name code marker consume a later prose action", ({ code }) => {
		const source = `${code}\n\nProse ${CODE_MARKER}.`;
		expect(parseActionSuggestions(source)).toEqual({ text: `${code}\n\nProse .`, actions: [VISIBLE_ACTION] });
	});

	it.each(closedCodeCases)(
		"preserves $name literally while still extracting the following prose action",
		({ code }) => {
			const source = `Synthetic introduction.\n\n${code}\n\nVisible ${CODE_MARKER} then ${CODE_MARKER}.`;
			expect(parseActionSuggestions(source)).toEqual({
				text: `Synthetic introduction.\n\n${code}\n\nVisible  then .`,
				actions: [VISIBLE_ACTION],
			});
		},
	);

	it.each([
		{ name: "unmatched triple-backtick fence", code: `\`\`\`text\n${CODE_MARKER}\n${CODE_PROMPT_MARKER}` },
		{ name: "unmatched triple-tilde fence", code: `~~~text\n${CODE_MARKER}\n${CODE_PROMPT_MARKER}` },
		{
			name: "long backtick fence with only a shorter closing candidate",
			code: `\`\`\`\`\`text\n\`\`\`\n${CODE_MARKER}`,
		},
		{ name: "long tilde fence with only a shorter closing candidate", code: `~~~~~text\n~~~\n${CODE_MARKER}` },
		{
			name: "backtick fence with only an opposite-character closing candidate",
			code: `\`\`\`\`text\n~~~~~~\n${CODE_MARKER}`,
		},
		{
			name: "tilde fence with only an opposite-character closing candidate",
			code: `~~~~text\n\`\`\`\`\`\`\n${CODE_MARKER}`,
		},
	])("protects the remainder of an $name through end of input", ({ code }) => {
		const source = `Synthetic introduction.\n\n${code}\nStill inside ${CODE_MARKER}`;
		expect(parseActionSuggestions(source)).toEqual({ text: source, actions: [] });
	});

	it("keeps ordinary prose extraction, quote stripping, ordering and pair-based deduplication unchanged", () => {
		const source =
			"Start [[action:suggest:Review|Review the synthetic change]] / " +
			'[[action:suggest:label="Inspect",prompt="Inspect the synthetic change"]] / ' +
			"[[action:suggest:Review|Review the synthetic change]] / " +
			"[[action:suggest:'Review'|'Review another synthetic change']] / " +
			"[[action:suggest:Inspect|Inspect the synthetic change]] end.";
		expect(parseActionSuggestions(source)).toEqual({
			text: "Start  /  /  /  /  end.",
			actions: [
				VISIBLE_ACTION,
				{ label: "Inspect", prompt: "Inspect the synthetic change" },
				{ label: "Review", prompt: "Review another synthetic change" },
			],
		});
	});

	it("does not mistake a three-space prose line or an unmatched inline backtick for a code block/span", () => {
		const source = `Synthetic paragraph.\n\n   ${CODE_MARKER}\n\nUnmatched \` before ${CODE_PROMPT_MARKER}.`;
		expect(parseActionSuggestions(source)).toEqual({
			text: "Synthetic paragraph.\n\n   \n\nUnmatched ` before .",
			actions: [VISIBLE_ACTION, { label: "Inspect", prompt: "Inspect the synthetic change" }],
		});
	});

	it("retains existing streaming-tail and empty-prompt behavior outside code", () => {
		expect(parseActionSuggestions("Synthetic prose [[action:suggest:unfinished")).toEqual({
			text: "Synthetic prose ",
			actions: [],
		});
		expect(parseActionSuggestions("[[action:suggest:Label|]]")).toEqual({
			text: "[[action:suggest:Label|]]",
			actions: [],
		});
	});

	it("exposes only prose suggestions from assistant messages, never actions from user/tool examples", () => {
		const text = `    ${CODE_MARKER}\n\nProse ${CODE_PROMPT_MARKER}`;
		expect(messageSuggestions(message("synthetic-assistant", text))).toEqual([
			{ label: "Inspect", prompt: "Inspect the synthetic change" },
		]);
		expect(messageSuggestions(message("synthetic-user", text, "user"))).toEqual([]);
		expect(messageSuggestions(message("synthetic-tool", text, "toolResult"))).toEqual([]);
	});
});
