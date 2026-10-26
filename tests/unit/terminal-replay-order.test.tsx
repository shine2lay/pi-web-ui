// @vitest-environment jsdom
// #597: actual TermXterm; only the transport and parser-completion boundary are inert.
// Native companion proves exact buffers using real xterm and the genuine pinned old component.
import { act, createElement, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TermXterm, type OnAttachTerminal, type TerminalAttachIntent } from "../../web/src/components/TermXterm.js";
import { LanguageProvider } from "../../web/src/i18n.js";
import { resetAppGlobals, setAppSend } from "../../web/src/app-globals.js";
import type { ClientMessage } from "../../web/src/types.js";

type Write = { data: string; done?: () => void };
interface Renderer {
	options: { disableStdin?: boolean };
	writes: Write[];
	reset: ReturnType<typeof vi.fn>;
	dispose: ReturnType<typeof vi.fn>;
	input?: (data: string) => void;
}
const renderers = vi.hoisted(() => [] as Renderer[]);
vi.mock("@xterm/xterm", () => ({
	Terminal: class {
		cols = 93;
		rows = 27;
		options: { disableStdin?: boolean };
		element = document.createElement("div");
		writes: Write[] = [];
		reset = vi.fn();
		dispose = vi.fn();
		input?: (data: string) => void;
		constructor(options: { disableStdin?: boolean }) {
			this.options = options;
			renderers.push(this);
		}
		write(data: string, done?: () => void) {
			this.writes.push({ data, done });
		}
		loadAddon() {}
		open(container: HTMLElement) {
			container.append(this.element);
		}
		focus() {}
		attachCustomKeyEventHandler() {}
		onData(fn: (data: string) => void) {
			this.input = fn;
			return { dispose() {} };
		}
	},
}));
vi.mock("@xterm/addon-fit", () => ({
	FitAddon: class {
		fit() {}
	},
}));

type Props = ComponentProps<typeof TermXterm>;
type Writer = Parameters<Props["register"]>[2];
const roots: Root[] = [];
let frames: Map<number, FrameRequestCallback>;
let frameId: number;
let wire: ClientMessage[];
function host() {
	const pending: Array<{
		intent: TerminalAttachIntent;
		replace(data: string): void;
		resolve(value: unknown): void;
		reject(error: Error): void;
	}> = [];
	const writers: Writer[] = [];
	const unregister = vi.fn();
	const register = vi.fn((_cid: string, _tid: string, writer: Writer) => {
		writers.push(writer);
		return unregister;
	});
	const onAttachTerminal: OnAttachTerminal = (intent, replace) =>
		new Promise((resolve, reject) =>
			pending.push({ intent, replace, resolve: resolve as (v: unknown) => void, reject }),
		);
	return { pending, writers, register, unregister, onAttachTerminal };
}
function mount(extra: Partial<Props> = {}) {
	const h = host();
	let props: Props = {
		conversationId: "fixture-conversation-a",
		sessionId: "fixture-session-a",
		terminalId: "fixture-terminal-a",
		cwd: "/synthetic/workspace",
		active: true,
		running: true,
		register: h.register,
		onAttachTerminal: h.onAttachTerminal,
		...extra,
	};
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	roots.push(root);
	const render = () => act(() => root.render(createElement(LanguageProvider, null, createElement(TermXterm, props))));
	render();
	return {
		...h,
		container,
		state: () => container.querySelector<HTMLElement>(".term-xterm")?.dataset.attachState,
		patch(overrides: Partial<Props>) {
			props = { ...props, ...overrides };
			render();
		},
		unmount: () => act(() => root.render(null)),
		remount: render,
	};
}
function frame() {
	act(() => {
		const callbacks = [...frames.values()];
		frames.clear();
		for (const callback of callbacks) callback(0);
	});
}
async function settle(action: () => void) {
	await act(async () => action());
}
function completion(renderer = renderers[0]) {
	const callbacks = renderer.writes.filter((w) => w.done);
	expect(callbacks).toHaveLength(1);
	return callbacks[0].done!;
}
function readonly(p: ReturnType<typeof mount>, index = 0, state = "pending") {
	expect(p.state()).toBe(state);
	expect(renderers[index].options.disableStdin).toBe(true);
	renderers[index].input?.("synthetic blocked input");
	expect(wire).toEqual([]);
}

beforeEach(() => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	frames = new Map();
	frameId = 0;
	vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
		frames.set(++frameId, callback);
		return frameId;
	});
	vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
	vi.stubGlobal(
		"ResizeObserver",
		class {
			observe() {}
			disconnect() {}
		},
	);
	renderers.length = 0;
	wire = [];
	resetAppGlobals();
	setAppSend((message) => {
		wire.push(structuredClone(message));
		return true;
	});
});
afterEach(() => {
	act(() => roots.splice(0).forEach((root) => root.unmount()));
	document.body.replaceChildren();
	resetAppGlobals();
	vi.unstubAllGlobals();
});

describe("TermXterm ordered replacement acknowledgements", () => {
	it.each(["host-first", "parser-first"])("requires both independent acknowledgements (%s)", async (order) => {
		const p = mount();
		frame();
		const a = p.pending[0];
		expect(Object.isFrozen(a.intent)).toBe(true);
		expect(a.intent).toMatchObject({
			conversationId: "fixture-conversation-a",
			sessionId: "fixture-session-a",
			terminalId: "fixture-terminal-a",
			cols: 93,
			rows: 27,
		});
		act(() => {
			p.writers[0].write("PRE");
			a.replace("HISTORY\r\nPRE");
			p.writers[0].write("\r\nTAIL-1");
			p.writers[0].write("\r\nTAIL-2");
		});
		expect(renderers[0].reset).not.toHaveBeenCalled();
		expect(renderers[0].writes.map((w) => w.data)).toEqual([
			"PRE",
			"\x18\x1bcHISTORY\r\nPRE",
			"\r\nTAIL-1",
			"\r\nTAIL-2",
		]);
		const done = completion();
		if (order === "host-first") await settle(() => a.resolve(true));
		else await settle(done);
		readonly(p);
		p.patch({ active: false });
		p.patch({ active: true });
		frame();
		readonly(p);
		if (order === "host-first") await settle(done);
		else await settle(() => a.resolve(true));
		expect(p.state()).toBe("attached");
		expect(renderers[0].options.disableStdin).toBe(false);
		expect(wire.map((m) => m.type)).toEqual(["terminal_resize"]);
		renderers[0].input!("synthetic live input");
		expect(wire.at(-1)).toMatchObject({
			type: "terminal_input",
			conversationId: a.intent.conversationId,
			terminalId: a.intent.terminalId,
			data: "synthetic live input",
		});
		const count = wire.length;
		await settle(done); // Defensive callback idempotence, not a simulated success shortcut.
		expect(wire).toHaveLength(count);
	});

	it("a never-completed empty snapshot remains pending; duplicates cannot reset or replace it", async () => {
		const p = mount();
		frame();
		const a = p.pending[0];
		act(() => {
			a.replace("");
			a.replace("WRONG");
		});
		await settle(() => a.resolve(true));
		readonly(p);
		expect(renderers[0].writes.map((w) => w.data)).toEqual(["\x18\x1bc"]);
		act(() => a.replace("LATE"));
		readonly(p);
		expect(renderers[0].writes).toHaveLength(1);
	});

	it.each([false, undefined, null, 1, "true", { attached: true }, "reject"])(
		"completed replay alone cannot attach (%j)",
		async (value) => {
			const p = mount();
			frame();
			act(() => p.pending[0].replace("RETAINED"));
			await settle(completion());
			readonly(p);
			await settle(() =>
				value === "reject" ? p.pending[0].reject(new Error("synthetic refusal")) : p.pending[0].resolve(value),
			);
			readonly(p, 0, "unavailable");
		},
	);

	it("false may settle before parsing; a late parser callback cannot rehabilitate it", async () => {
		const p = mount();
		frame();
		act(() => p.pending[0].replace("RETAINED"));
		await settle(() => p.pending[0].resolve(false));
		readonly(p, 0, "unavailable");
		await settle(completion());
		readonly(p, 0, "unavailable");
	});

	it("strict true without replacement cannot accept a later replacement", async () => {
		const p = mount();
		frame();
		await settle(() => p.pending[0].resolve(true));
		act(() => p.pending[0].replace("TOO-LATE"));
		expect(renderers[0].writes).toEqual([]);
		readonly(p, 0, "unavailable");
	});

	it.each(["conversation", "session", "terminal", "callback", "register", "remount", "aba"])(
		"fences queued completion, writer and result across %s",
		async (kind) => {
			const p = mount();
			frame();
			const old = p.pending[0];
			act(() => old.replace("OLD-RETAINED"));
			const oldDone = completion();
			await settle(() => old.resolve(true));
			readonly(p);
			if (kind === "remount") {
				p.unmount();
				p.remount();
			} else if (kind === "callback")
				p.patch({ onAttachTerminal: (intent, replace) => p.onAttachTerminal(intent, replace) });
			else if (kind === "register") p.patch({ register: (cid, tid, writer) => p.register(cid, tid, writer) });
			else {
				p.patch(
					kind === "session"
						? { sessionId: "fixture-session-b" }
						: kind === "terminal"
							? { terminalId: "fixture-terminal-b" }
							: { conversationId: "fixture-conversation-b" },
				);
				if (kind === "aba") p.patch({ conversationId: "fixture-conversation-a" });
			}
			frame();
			const index = renderers.length - 1;
			const fresh = p.pending.at(-1)!;
			expect(fresh.intent.viewId).not.toBe(old.intent.viewId);
			const count = renderers[0].writes.length;
			await settle(() => {
				oldDone();
				old.replace("STALE");
				p.writers[0].write("STALE-TAIL");
				p.writers[0].dispose();
			});
			expect(renderers[0].writes).toHaveLength(count);
			expect(renderers[index].writes).toEqual([]);
			readonly(p, index);
			act(() => fresh.replace("NEW"));
			await settle(() => fresh.resolve(true));
			readonly(p, index);
			await settle(completion(renderers[index]));
			expect(p.state()).toBe("attached");
			expect(renderers[0].dispose).toHaveBeenCalledTimes(1);
			expect(wire.some((m) => ["terminal_create", "run_command", "terminal_kill"].includes(m.type))).toBe(false);
		},
	);

	it.each(["before-result", "after-result"])(
		"registered disposal fences completion (%s) without waiting for it",
		async (when) => {
			const p = mount();
			frame();
			act(() => p.pending[0].replace("OLD"));
			const done = completion();
			if (when === "after-result") await settle(() => p.pending[0].resolve(true));
			act(() => p.writers[0].dispose());
			await settle(() => {
				done();
				p.pending[0].replace("LATE");
				p.pending[0].resolve(true);
				p.writers[0].write("LATE");
			});
			readonly(p, 0, "unavailable");
			expect(renderers[0].writes).toHaveLength(1);
			p.unmount();
			expect(renderers[0].dispose).toHaveBeenCalledTimes(1);
		},
	);

	it.each([
		"missing-callback",
		"missing-session",
		"missing-conversation",
		"missing-terminal",
		"sync-true",
		"void",
		"throw",
	])("never creates a fallback (%s)", async (kind) => {
		const callback = vi.fn((_intent: TerminalAttachIntent, replace: (data: string) => void) => {
			if (kind === "throw") throw new Error("synthetic unavailable");
			if (kind === "sync-true") {
				replace("NOT-A-RECEIPT");
				return true as unknown as Promise<boolean>;
			}
			return undefined as unknown as Promise<boolean>;
		});
		const p = mount({
			onAttachTerminal: kind === "missing-callback" ? undefined : callback,
			...(kind === "missing-session"
				? { sessionId: "" }
				: kind === "missing-conversation"
					? { conversationId: "" }
					: kind === "missing-terminal"
						? { terminalId: "" }
						: {}),
		});
		await settle(frame);
		readonly(p, 0, "unavailable");
		if (kind.startsWith("missing-")) expect(callback).not.toHaveBeenCalled();
		if (kind === "sync-true") {
			await settle(completion());
			readonly(p, 0, "unavailable");
		}
	});

	it.each(["already-stopped", "exit-during-replay", "exit-before-replay"])(
		"queues exactly one surviving banner in order (%s)",
		async (kind) => {
			const p = mount({ running: kind === "already-stopped" ? false : true, exitCode: 7 });
			frame();
			if (kind === "exit-before-replay") p.patch({ running: false });
			act(() => p.pending[0].replace("HISTORY"));
			act(() => p.writers[0].write("\r\nTAIL"));
			if (kind === "exit-during-replay") p.patch({ running: false });
			p.patch({ running: false, title: "metadata only" });
			await settle(() => p.pending[0].resolve(true));
			readonly(p);
			const replacementIndex = renderers[0].writes.findIndex((w) => !!w.done);
			const surviving = renderers[0].writes
				.slice(replacementIndex)
				.map((w) => w.data)
				.join("");
			expect(surviving.match(/\[Process exited with code 7\]/g)).toHaveLength(1);
			if (kind === "exit-during-replay")
				expect(surviving.indexOf("TAIL")).toBeLessThan(surviving.indexOf("[Process exited"));
			await settle(completion());
			expect(p.state()).toBe("attached");
		},
	);
});
