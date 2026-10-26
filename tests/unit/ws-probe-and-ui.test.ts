// @vitest-environment jsdom
// Synthetic UI/connection fixtures only. No live chat, provider or model requests.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { act, createElement, createRef, type ComponentProps, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { listThemes } from "../../server/themes.js";
import {
	ConnHealth,
	DEAD_AFTER_MS,
	NOTE_AFTER_MS,
	QUIET_MS,
	REPING_MS,
	reconnectingNote,
} from "../../web/src/conn-health.js";
import {
	earlierRequest,
	hasEarlierMessages,
	mergeEarlierPage,
	normalizeHistoryState,
	readEarlierPage,
	scrollAfterPrepend,
	usesEarlierProtocol,
	type HistoryFields,
} from "../../web/src/history-paging.js";
import { keepLoadedHistory } from "../../web/src/message-window.js";
import { parseActionSuggestions, messageSuggestions } from "../../web/src/action-suggestions.js";
import { formatQuote, readQuoteSelection } from "../../web/src/quote-selection.js";
import { SelectionQuoteButton } from "../../web/src/components/SelectionQuoteButton.js";
import { SuggestionChips } from "../../web/src/components/SuggestionChips.js";
import { ChatInput } from "../../web/src/components/ChatInput.js";
import { composeToComposer, registerDraftSink, resetComposerSinks } from "../../web/src/composer-bridge.js";
import { resetAppGlobals, setAppGlobals, setAppSend } from "../../web/src/app-globals.js";
import { LanguageProvider } from "../../web/src/i18n.js";
import { useChat } from "../../web/src/use-chat.js";
import type { UiMessage, UiState } from "../../web/src/types.js";

const T0 = 1_000_000;
const roots: Root[] = [];
function mount(node: ReactNode) {
	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = createRoot(host);
	roots.push(root);
	const render = (child: ReactNode) => act(() => root.render(createElement(LanguageProvider, null, child)));
	render(node);
	return { host, render };
}
function message(id: string, role: UiMessage["role"] = "assistant", text = id): UiMessage {
	return { id, role, content: [{ type: "text", text }] } as UiMessage;
}
function state(start = 60, messages = [message("m60"), message("m61")]): UiState {
	return {
		conversationId: "synthetic",
		sessionId: "synthetic-session",
		cwd: "/synthetic",
		rev: 1,
		isStreaming: false,
		model: null,
		pendingQuestion: null,
		messagesStart: start,
		messages,
	} as UiState;
}
beforeEach(() => {
	// Start at the fixture epoch: moving Date backwards after installation skews
	// fake-timers' animation-frame epoch and makes a 20 ms frame check nondeterministic.
	vi.useFakeTimers({ now: T0 });
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	vi.stubGlobal(
		"ResizeObserver",
		class {
			observe() {}
			unobserve() {}
			disconnect() {}
		},
	);
	localStorage.clear();
	sessionStorage.clear();
	localStorage.setItem("pi-web-ui:lang", "en");
	Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
	resetAppGlobals();
	resetComposerSinks();
});
afterEach(() => {
	act(() => {
		for (const root of roots.splice(0)) root.unmount();
	});
	resetComposerSinks();
	resetAppGlobals();
	setAppSend(null);
	window.getSelection()?.removeAllRanges();
	document.body.innerHTML = "";
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

describe("W1-E calm probe state machine", () => {
	it("uses the approved thresholds, re-pings, and never mistakes a late pong for a close", () => {
		expect(QUIET_MS).toBe(10_000);
		expect(NOTE_AFTER_MS).toBe(2_500);
		const health = new ConnHealth();
		health.opened(T0);
		for (const silence of [5_000, 9_999, 10_000, 12_500]) {
			health.pingDue(T0 + silence);
			expect(health.verdict(T0 + silence)).toBe("ok");
		}
		const id = health.pingDue(T0 + QUIET_MS + REPING_MS);
		expect(id).not.toBeNull();
		expect(health.verdict(T0 + 15_000)).toBe("doubt");
		expect(health.verdict(T0 + DEAD_AFTER_MS)).not.toBe("dead");
		health.heard(T0 + 30_000);
		health.answered(id!);
		expect(health.verdict(T0 + 30_000)).toBe("ok");
	});
	it("network hints and repeat pings cannot extend the 30 s failure clock", () => {
		const health = new ConnHealth();
		health.opened(T0);
		health.cameBack(T0);
		for (let t = 5_000; t <= 30_000; t += 5_000) {
			health.cameBack(T0 + t);
			health.pingDue(T0 + t);
		}
		expect(health.verdict(T0 + 30_001)).toBe("dead");
	});
	it("actual sleep starts fresh and only the new matching pong proves the wake probe", () => {
		const health = new ConnHealth();
		health.opened(T0);
		const old = health.cameBack(T0);
		const fresh = health.cameBack(T0 + 120_000, true);
		health.heard(T0 + 120_001); // buffered ordinary data is not the new pong
		health.answered(old);
		expect(health.checking).toBe(true);
		expect(health.verdict(T0 + 130_000)).toBe("ok");
		health.answered(fresh);
		expect(health.checking).toBe(false);
	});
});

// Retain connection/paging metadata only, never hello bodies or arbitrary outbound payloads.
class UiSocket {
	static OPEN = 1;
	static CONNECTING = 0;
	static CLOSED = 3;
	static instances: UiSocket[] = [];
	readyState = 0;
	closeCalls = 0;
	onopen: (() => void) | null = null;
	onmessage: ((e: { data: string }) => void) | null = null;
	onclose: ((e: { code: number; reason: string }) => void) | null = null;
	onerror: (() => void) | null = null;
	pings: number[] = [];
	pages: ReturnType<typeof earlierRequest>[] = [];
	constructor() {
		UiSocket.instances.push(this);
	}
	send(wire: string) {
		const data = JSON.parse(wire);
		if (data.type === "ping") this.pings.push(data.id);
		if (data.type === "load_earlier_messages")
			this.pages.push({
				type: data.type,
				conversationId: data.conversationId,
				beforeIndex: data.beforeIndex,
				limit: data.limit,
				count: data.count,
			});
	}
	open() {
		this.readyState = 1;
		act(() => this.onopen?.());
	}
	receive(data: object) {
		act(() => this.onmessage?.({ data: JSON.stringify(data) }));
	}
	close() {
		this.closeCalls++;
		this.remoteClose();
	}
	remoteClose() {
		this.readyState = 3;
		this.onclose?.({ code: 1000, reason: "synthetic" });
	}
}
let api: ReturnType<typeof useChat>;
function ChatHarness() {
	api = useChat();
	return null;
}
function socketHarness() {
	UiSocket.instances = [];
	vi.stubGlobal("WebSocket", UiSocket);
	mount(createElement(ChatHarness));
	const socket = UiSocket.instances[0];
	socket.open();
	return socket;
}
const tick = (ms: number) => act(() => vi.advanceTimersByTime(ms));

describe("W1-E actual useChat watchdog and protocol boundary", () => {
	it.each([5_000, 10_000, 12_500])("keeps the socket and hides the banner during a %i ms server freeze", (duration) => {
		const socket = socketHarness();
		tick(duration);
		expect(socket.closeCalls).toBe(0);
		expect(UiSocket.instances).toHaveLength(1);
		expect(reconnectingNote()).toBe(false);
		socket.receive({ type: "pong", id: socket.pings.at(-1) });
		tick(500);
		expect(socket.closeCalls).toBe(0);
	});
	it("shows the calm note, re-pings, then replaces only after sustained failure >30 s", () => {
		const socket = socketHarness();
		tick(13_000);
		expect(reconnectingNote()).toBe(true);
		expect(socket.closeCalls).toBe(0);
		tick(17_000);
		expect(socket.pings.length).toBeGreaterThan(2);
		expect(socket.closeCalls).toBe(0);
		tick(500);
		expect(socket.closeCalls).toBe(1);
		expect(UiSocket.instances).toHaveLength(2);
	});
	it.each(["pageshow", "visibilitychange"])("%s probes an OPEN tab immediately, without closing it", (event) => {
		const socket = socketHarness();
		act(() => (event === "pageshow" ? window : document).dispatchEvent(new Event(event)));
		expect(socket.pings).toHaveLength(1);
		tick(10_000);
		expect(socket.closeCalls).toBe(0);
		expect(reconnectingNote()).toBe(false);
	});
	it("coalesces paired wake events without cancelling a fresh handshake, but retries an old attempt", () => {
		UiSocket.instances = [];
		vi.stubGlobal("WebSocket", UiSocket);
		mount(createElement(ChatHarness));
		const connecting = UiSocket.instances[0];
		act(() => {
			window.dispatchEvent(new Event("pageshow"));
			document.dispatchEvent(new Event("visibilitychange"));
		});
		expect(UiSocket.instances).toHaveLength(1);
		expect(connecting.closeCalls).toBe(0);
		tick(2_000);
		act(() => window.dispatchEvent(new Event("pageshow")));
		expect(connecting.closeCalls).toBe(1);
		expect(UiSocket.instances).toHaveLength(2);
		act(() => document.dispatchEvent(new Event("visibilitychange")));
		expect(UiSocket.instances).toHaveLength(2);
		expect(UiSocket.instances[1].closeCalls).toBe(0);
	});
	it("a real close still reconnects; waking during backoff skips the timer", () => {
		const socket = socketHarness();
		act(() => socket.remoteClose());
		act(() => window.dispatchEvent(new Event("pageshow")));
		expect(UiSocket.instances).toHaveLength(2);
		expect(socket.closeCalls).toBe(0);
	});
	it("normalizes historyWindow, sends 30-item requests and prepends only matching contiguous pages", () => {
		const socket = socketHarness();
		socket.receive({ type: "ready", serverVersion: "synthetic", appVersion: "synthetic", engine: "pi", managed: true });
		socket.receive({
			type: "snapshot",
			state: { ...state(), historyWindow: { earliestIndex: 60, hasEarlier: true, hiddenCount: 60 } },
		});
		expect(api.chat.state?.messagesStart).toBe(60);
		act(() => {
			api.send({ type: "load_older", beforeIndex: 60, count: 30 });
		});
		expect(socket.pages).toEqual([earlierRequest("synthetic", 60)]);
		socket.receive({
			type: "earlier_messages",
			conversationId: "other",
			historyStart: 30,
			messages: Array.from({ length: 30 }, (_, i) => message(`m${i + 30}`)),
		});
		expect(api.chat.state?.messagesStart).toBe(60);
		socket.receive({
			type: "earlier_messages",
			conversationId: "synthetic",
			historyStart: 30,
			messages: Array.from({ length: 30 }, (_, i) => message(`m${i + 30}`)),
		});
		expect(api.chat.state?.messagesStart).toBe(30);
		expect(api.chat.state?.messages.map((m) => m.id)).toEqual(Array.from({ length: 32 }, (_, i) => `m${i + 30}`));
		socket.receive({
			type: "earlier_messages",
			conversationId: "synthetic",
			historyStart: 30,
			messages: Array.from({ length: 30 }, (_, i) => message(`m${i + 30}`)),
		});
		expect(api.chat.state?.messages).toHaveLength(32);
	});
});

describe("history merge and scroll invariants", () => {
	it("supports both the approved historyWindow and upstream historyStart spellings", () => {
		const raw = { ...state(), historyWindow: { hasEarlier: true, hiddenCount: 60, earliestIndex: 60 } };
		expect(usesEarlierProtocol(raw)).toBe(true);
		expect(normalizeHistoryState({ ...state(0), historyStart: 60 }).messagesStart).toBe(60);
		expect(normalizeHistoryState(raw).messagesStart).toBe(60);
		expect(hasEarlierMessages({ ...raw, historyWindow: { ...raw.historyWindow, hasEarlier: false } })).toBe(false);
		expect(
			readEarlierPage({ type: "earlier_messages", conversationId: "synthetic", messages: [message("m59")] }, 60)?.start,
		).toBe(59);
	});
	it("rejects gaps, stale chats and malformed positions, and retains loaded history on resync", () => {
		const ui = state();
		const page = readEarlierPage(
			{ type: "earlier_messages", conversationId: "synthetic", start: 59, messages: [message("m59")] },
			60,
		)!;
		const next = mergeEarlierPage(ui, page)!;
		expect(next.messagesStart).toBe(59);
		expect(mergeEarlierPage(ui, { ...page, start: 58 })).toBeNull();
		expect(mergeEarlierPage(ui, { ...page, conversationId: "other" })).toBeNull();
		expect(
			readEarlierPage({ type: "earlier_messages", conversationId: "synthetic", start: -1, messages: [] }, 60),
		).toBeNull();
		expect(keepLoadedHistory(next, ui).messages.map((m) => m.id)).toEqual(["m59", "m60", "m61"]);
		expect(scrollAfterPrepend(48, 800, 1400)).toBe(648);
		expect(scrollAfterPrepend(25, 800, 700)).toBe(25);
	});
	it("updates hasEarlier and hiddenCount after the final page", () => {
		const ui = { ...state(1), historyWindow: { hasEarlier: true, hiddenCount: 1, earliestIndex: 1 } };
		const page = readEarlierPage(
			{
				type: "earlier_messages",
				conversationId: "synthetic",
				historyWindow: { hasEarlier: false, hiddenCount: 0, earliestIndex: 0 },
				messages: [message("m0")],
			},
			1,
		)!;
		const next = mergeEarlierPage(ui, page) as UiState & HistoryFields;
		expect(hasEarlierMessages(next)).toBe(false);
		expect(next.historyWindow).toEqual({ hasEarlier: false, hiddenCount: 0, earliestIndex: 0 });
	});
});

function selectText(node: Node) {
	const selection = window.getSelection()!;
	selection.removeAllRanges();
	const range = document.createRange();
	range.selectNodeContents(node);
	selection.addRange(range);
	return selection;
}
function quoteHost() {
	const host = document.createElement("div");
	host.innerHTML =
		'<article class="msg" data-role="assistant" data-msg-id="a"><div class="msg-text">Line one\nLine two</div></article><article class="msg" data-role="user" data-msg-id="u"><div class="msg-text">User text</div></article>';
	document.body.appendChild(host);
	return host;
}
describe("Select-to-quote", () => {
	it("formats multiline Markdown and accepts only a single assistant's content", () => {
		expect(formatQuote("  one\r\n\r\ntwo  ")).toBe("> one\n>\n> two\n\n");
		const host = quoteHost();
		expect(readQuoteSelection(host, selectText(host.querySelector(".msg-text")!))).toBe("Line one\nLine two");
		expect(readQuoteSelection(host, selectText(host.querySelector('[data-role="user"] .msg-text')!))).toBeNull();
		expect(readQuoteSelection(host, selectText(host))).toBeNull();
	});
	it("renders the pill and Enter quotes into a draft, never sends the chat", () => {
		const host = quoteHost();
		const rootRef = createRef<HTMLDivElement>();
		Object.defineProperty(rootRef, "current", { value: host });
		Object.defineProperty(Range.prototype, "getBoundingClientRect", {
			configurable: true,
			value: () => ({
				x: 50,
				y: 100,
				top: 100,
				left: 50,
				right: 250,
				bottom: 120,
				width: 200,
				height: 20,
				toJSON() {},
			}),
		});
		const inserted = vi.fn();
		const sent = vi.fn();
		registerDraftSink(inserted);
		setAppSend(sent);
		mount(createElement(SelectionQuoteButton, { rootRef, sessionId: "synthetic" }));
		const selected = host.querySelector(".msg-text")!;
		act(() => selected.dispatchEvent(new MouseEvent("pointerdown", { button: 0, bubbles: true })));
		selectText(selected);
		act(() => document.dispatchEvent(new Event("selectionchange")));
		tick(20);
		expect(document.querySelector(".quote-selection-button")).toBeNull();
		act(() => document.dispatchEvent(new Event("pointercancel")));
		tick(20);
		expect(document.querySelector(".quote-selection-button")?.textContent).toContain("Quote");
		const unrelated = document.createElement("input");
		document.body.appendChild(unrelated);
		const otherEnter = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
		act(() => unrelated.dispatchEvent(otherEnter));
		expect(otherEnter.defaultPrevented).toBe(false);
		expect(inserted).not.toHaveBeenCalled();
		const enter = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
		act(() => document.dispatchEvent(enter));
		expect(enter.defaultPrevented).toBe(true);
		expect(inserted).toHaveBeenCalledWith("> Line one\n> Line two\n\n");
		expect(sent).not.toHaveBeenCalled();
		expect(document.querySelector(".quote-selection-button")).toBeNull();
	});
});

describe("follow-up chips", () => {
	it("supports pipe and upstream prompt= markers, quotes, deduplication and partial streaming", () => {
		const parsed = parseActionSuggestions(
			'Done [[action:suggest:Explain|Explain the change]] [[action:suggest:label="Review",prompt="Review it"]] [[action:suggest:Explain|Explain the change]]',
		);
		expect(parsed.actions).toEqual([
			{ label: "Explain", prompt: "Explain the change" },
			{ label: "Review", prompt: "Review it" },
		]);
		expect(parsed.text.trim()).toBe("Done");
		expect(parseActionSuggestions("Done [[action:suggest:Not fin")).toEqual({ text: "Done ", actions: [] });
		expect(parseActionSuggestions("[[action:suggest:Label|]]").actions).toEqual([]);
	});
	it("keeps code examples literal and never treats user content as suggestions", () => {
		const code = "`[[action:suggest:Example|Not a button]]`\n```text\n[[action:suggest:Example|Not a button]]\n```";
		expect(parseActionSuggestions(code)).toEqual({ text: code, actions: [] });
		expect(messageSuggestions(message("u", "user", "[[action:suggest:No|No]]"))).toEqual([]);
	});
	it("renders safe text, sends the normal prompt on click, and stays disabled until initialization", () => {
		const sent: unknown[] = [];
		setAppSend((value) => {
			sent.push(value);
			return true;
		});
		setAppGlobals({ ready: true });
		const actions = [{ label: '<img src=x onerror="alert(1)">', prompt: "Explain the synthetic change" }];
		const { host, render } = mount(createElement(SuggestionChips, { actions }));
		expect(host.querySelector("img")).toBeNull();
		const button = host.querySelector("button")!;
		expect(button.disabled).toBe(true);
		act(() => button.click());
		expect(sent).toEqual([]);
		render(createElement(SuggestionChips, { actions, sessionId: "synthetic" }));
		act(() => host.querySelector<HTMLButtonElement>("button")!.click());
		expect(sent).toEqual([
			expect.objectContaining({ type: "prompt", text: "Explain the synthetic change", id: expect.any(String) }),
		]);
	});
	it("registers a clicked chip in the real optimistic-send path before a server streaming update", () => {
		const socket = socketHarness();
		socket.receive({ type: "ready", serverVersion: "synthetic", appVersion: "synthetic", engine: "pi", managed: true });
		socket.receive({ type: "snapshot", state: state(0) });
		setAppGlobals({ ready: true, engine: "pi" });
		setAppSend(api.send);
		const { host } = mount(
			createElement(SuggestionChips, {
				actions: [{ label: "Explain", prompt: "Explain the synthetic change" }],
				sessionId: "synthetic-session",
			}),
		);
		act(() => host.querySelector<HTMLButtonElement>("button")!.click());
		expect(api.chat.pendingSends).toEqual([
			expect.objectContaining({ text: "Explain the synthetic change", id: expect.any(String) }),
		]);
		expect(api.chat.state?.isStreaming).toBe(false);
	});
});

describe("async initialization and flow-light discovery", () => {
	it("keeps a draft editable but unsendable until the Pi session exists", () => {
		setAppGlobals({ ready: true, engine: "pi" });
		const sent: string[] = [];
		setAppSend((value) => {
			sent.push(value.type);
			return true;
		});
		const props: ComponentProps<typeof ChatInput> = {
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
		const { host, render } = mount(createElement(ChatInput, props));
		const input = host.querySelector("textarea")!;
		expect(input.placeholder).toBe("Session is initializing, please wait…");
		expect(input.disabled).toBe(false);
		act(() => {
			composeToComposer({ text: "Synthetic draft" });
		});
		act(() => input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })));
		expect(sent).not.toContain("prompt");
		expect(input.value).toBe("Synthetic draft");
		render(createElement(ChatInput, { ...props, sessionId: "synthetic", conversationId: "synthetic" }));
		expect(input.placeholder).not.toContain("initializing");
	});
	it("discovers flow-light through the existing dynamic selector without hiding fork tool cards", () => {
		expect(listThemes(join(process.cwd(), "themes"), "/nonexistent-themes")).toContainEqual(
			expect.objectContaining({ id: "flow-light", nameEn: "Pure Flow Light", scheme: "light", builtin: true }),
		);
		const css = readFileSync(join(process.cwd(), "themes/flow-light.css"), "utf8");
		expect(css).toContain("--bg: #ffffff");
		expect(css).toContain("--term-bg: #f8f9fa");
		expect(css).not.toMatch(/\.card-body\s*\{[^}]*display:\s*none/);
	});
});
