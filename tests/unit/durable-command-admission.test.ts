// @vitest-environment jsdom
// #594 / H-COMMAND-OWNERSHIP-1: actual callers, fake transport/PTY boundary only.
// The native companion mounts these components and the genuine pinned old source.
import { act, createElement, type ComponentProps, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ScmPanel, type CommandIntent } from "../../web/src/components/SCMPanel.js";
import { TerminalPanel } from "../../web/src/components/TerminalPanel.js";
import { TermXterm, type OnAttachTerminal, type TerminalAttachIntent } from "../../web/src/components/TermXterm.js";
import { LanguageProvider } from "../../web/src/i18n.js";
import { resetAppGlobals, setAppSend } from "../../web/src/app-globals.js";
import { SCM_COMMIT_HISTORY_KEY } from "../../web/src/scm-commit-history.js";
import type { ChatState, TerminalMeta } from "../../web/src/use-chat.js";
import type { ClientMessage, CommandDef } from "../../web/src/types.js";

const ptys = vi.hoisted(
	() =>
		[] as Array<{
			write: ReturnType<typeof vi.fn>;
			reset: ReturnType<typeof vi.fn>;
			options: { disableStdin?: boolean };
			input?: (data: string) => void;
			dispose: ReturnType<typeof vi.fn>;
		}>,
);
vi.mock("@xterm/xterm", () => ({
	Terminal: class {
		cols = 91;
		rows = 29;
		options: { disableStdin?: boolean } = {};
		element = document.createElement("div");
		textarea = document.createElement("textarea");
		write = vi.fn();
		reset = vi.fn();
		dispose = vi.fn();
		input?: (data: string) => void;
		constructor(options: { disableStdin?: boolean }) {
			this.options = options;
			ptys.push(this);
		}
		loadAddon() {}
		open(container: HTMLElement) {
			container.append(this.element);
		}
		focus() {}
		attachCustomKeyEventHandler() {}
		hasSelection() {
			return false;
		}
		onData(callback: (data: string) => void) {
			this.input = callback;
			return { dispose() {} };
		}
	},
}));
vi.mock("@xterm/addon-fit", () => ({
	FitAddon: class {
		fit() {}
	},
}));

const roots: Root[] = [];
const RAW = '  Synthetic \\"commit\\" `tag` $cash \\ path  ';
const CMD: CommandDef = { name: "  Synthetic task  ", command: "  printf 'synthetic only'  ", cwd: "${pwd}/fixture" };
let sent: ClientMessage[];
let transport: boolean;

function chat(extra: Partial<ChatState> = {}): ChatState {
	return {
		ready: true,
		status: "open",
		activeConversationId: "fixture-conversation-a",
		state: { conversationId: "fixture-conversation-a", sessionId: "fixture-session-a", cwd: "/synthetic/workspace-a" },
		terminals: [],
		commands: [{ ...CMD }],
		scmDirty: 0,
		scmData: null,
		...extra,
	} as ChatState;
}
function tab(extra: Partial<TerminalMeta> = {}): TerminalMeta {
	return {
		id: "fixture-terminal-a",
		conversationId: "fixture-conversation-a",
		title: "git commit",
		cwd: "/synthetic/workspace-a",
		cols: 117,
		rows: 37,
		running: true,
		exitCode: null,
		command: { name: "old synthetic command", command: "synthetic-old", cwd: "old" },
		...extra,
	};
}
function bridge() {
	return {
		create: vi.fn(),
		restart: vi.fn(),
		select: vi.fn(),
		close: vi.fn(),
		register: vi.fn((_conversationId: string, _id: string, _writer: { write(data: string): void; dispose(): void }) =>
			vi.fn(),
		),
	};
}
function deferred() {
	let resolve!: (result: unknown) => void;
	let reject!: (error: Error) => void;
	const promise = new Promise<unknown>((yes, no) => {
		resolve = yes;
		reject = no;
	});
	const callback = vi.fn((_intent: CommandIntent) => promise as Promise<boolean>);
	return { callback, resolve, reject };
}
function mount(node: ReactNode) {
	const host = document.createElement("div");
	document.body.append(host);
	const root = createRoot(host);
	roots.push(root);
	const render = (child: ReactNode) => act(() => root.render(createElement(LanguageProvider, null, child)));
	render(node);
	return { host, render, unmount: () => render(null) };
}
function scm(extra: Partial<ComponentProps<typeof ScmPanel>> = {}) {
	const props = { chat: chat(), terminal: bridge(), active: false, onSwitchToTerminal: vi.fn(), ...extra };
	const p = mount(createElement(ScmPanel, props));
	return {
		...p,
		props,
		rerender: (overrides: Partial<typeof props>) => p.render(createElement(ScmPanel, { ...props, ...overrides })),
	};
}
const attach: OnAttachTerminal = async (_intent, replaceOutput) => {
	replaceOutput("");
	return true;
};
function terminal(extra: Partial<ComponentProps<typeof TerminalPanel>> = {}) {
	const props = { chat: chat(), terminal: bridge(), onAttachTerminal: attach, ...extra };
	const p = mount(createElement(TerminalPanel, props));
	return {
		...p,
		props,
		rerender: (overrides: Partial<typeof props>) => p.render(createElement(TerminalPanel, { ...props, ...overrides })),
	};
}
function input(host: HTMLElement) {
	return host.querySelector<HTMLInputElement>(".scm-commit-input")!;
}
function type(host: HTMLElement, value: string) {
	act(() => {
		Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input(host), value);
		input(host).dispatchEvent(new Event("input", { bubbles: true }));
	});
}
function key(host: HTMLElement, value: string) {
	act(() => input(host).dispatchEvent(new KeyboardEvent("keydown", { key: value, bubbles: true, cancelable: true })));
}
function click(host: HTMLElement, selector: string, times = 1) {
	act(() => {
		for (let i = 0; i < times; i++) host.querySelector<HTMLButtonElement>(selector)!.click();
	});
}
function commit(host: HTMLElement, times = 1) {
	click(host, ".btn.primary", times);
}
async function settle(action: () => void) {
	await act(async () => action());
}
function writes() {
	return sent.filter((m) => m.type === "run_command" || m.type === "terminal_create" || m.type === "terminal_kill");
}
function noProcessSideEffects(p: ReturnType<typeof scm>) {
	expect(p.props.terminal.restart).not.toHaveBeenCalled();
	expect(p.props.terminal.create).not.toHaveBeenCalled();
	expect(p.props.terminal.select).not.toHaveBeenCalled();
	expect(p.props.onSwitchToTerminal).not.toHaveBeenCalled();
	expect(writes()).toEqual([]);
}

beforeEach(() => {
	vi.useFakeTimers();
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	vi.stubGlobal(
		"ResizeObserver",
		class {
			observe() {}
			disconnect() {}
		},
	);
	vi.stubGlobal("requestAnimationFrame", (fn: FrameRequestCallback) => setTimeout(() => fn(0), 0));
	vi.stubGlobal("cancelAnimationFrame", (id: number) => clearTimeout(id));
	localStorage.clear();
	sessionStorage.clear();
	resetAppGlobals();
	ptys.length = 0;
	sent = [];
	transport = false;
	setAppSend((msg) => {
		sent.push(structuredClone(msg));
		return transport;
	});
});
afterEach(() => {
	act(() => roots.splice(0).forEach((r) => r.unmount()));
	document.body.replaceChildren();
	setAppSend(null);
	resetAppGlobals();
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

describe("SCMPanel: authored command owner precedes all mutation", () => {
	it("commit-all preserves raw source and records only an unchanged admitted revision", async () => {
		const d = deferred();
		const p = scm({ onCommandIntent: d.callback });
		type(p.host, RAW);
		const all = [...p.host.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === "Commit All")!;
		act(() => all.click());
		expect(d.callback.mock.calls[0][0].command.command).toMatch(/^git add -A && git commit -m /);
		expect(d.callback.mock.calls[0][0].commitSource?.text).toBe(RAW);
		noProcessSideEffects(p);
		await settle(() => d.resolve(true));
		expect(input(p.host).value).toBe("");
		expect(JSON.parse(localStorage.getItem(SCM_COMMIT_HISTORY_KEY)!)).toEqual([RAW.trim()]);
	});
	it("keeps branch/push/pull/stage/unstage behind the same explicit owner", async () => {
		const callback = vi.fn((_request: CommandIntent) => Promise.resolve(false));
		transport = true;
		const p = scm({ active: true, onCommandIntent: callback });
		const request = sent.findLast((m) => m.type === "scm_status")!;
		p.rerender({
			chat: chat({
				scmData: {
					type: "scm_data",
					reqId: "reqId" in request ? request.reqId : -1,
					kind: "status",
					ok: true,
					branch: "main",
					files: [{ path: "synthetic file", x: "M", y: "M" }],
					branches: [
						{ name: "main", current: true },
						{ name: "synthetic-branch", current: false },
					],
				},
			}),
		});
		const select = p.host.querySelector<HTMLSelectElement>(".scm-select")!;
		act(() => {
			select.value = "synthetic-branch";
			select.dispatchEvent(new Event("change", { bubbles: true }));
		});
		for (const label of ["Switch", "Push", "Pull", "+", "−"]) {
			const button = [...p.host.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === label)!;
			await settle(() => button.click());
		}
		expect(callback.mock.calls.map(([r]) => r.command.command)).toEqual([
			"git checkout synthetic-branch",
			"git push",
			"git pull",
			"git add -- 'synthetic file'",
			"git reset HEAD -- 'synthetic file'",
		]);
		for (const [r] of callback.mock.calls) expect(r.commitSource).toBeUndefined();
		noProcessSideEffects(p);
		expect(localStorage.getItem(SCM_COMMIT_HISTORY_KEY)).toBeNull();
	});
	it.each([true, false])("captures complete frozen existing terminal and raw source; running=%s", async (running) => {
		const d = deferred();
		const original = tab({ running, exitCode: running ? null : 7 });
		const p = scm({ chat: chat({ terminals: [original] }), onCommandIntent: d.callback });
		type(p.host, RAW);
		commit(p.host, 3);
		key(p.host, "Enter");
		expect(d.callback).toHaveBeenCalledTimes(1);
		const intent = d.callback.mock.calls[0][0];
		expect(intent).toMatchObject({
			source: "scm",
			conversationId: "fixture-conversation-a",
			sessionId: "fixture-session-a",
			workspaceCwd: "/synthetic/workspace-a",
			command: { name: "git commit", cwd: "${pwd}" },
			commitSource: { text: RAW, revision: 1 },
			terminal: {
				id: original.id,
				title: "git commit",
				cwd: original.cwd,
				cols: 117,
				rows: 37,
				mode: "existing",
				running,
				exitCode: running ? null : 7,
			},
		});
		expect(intent.command.command).toBe(
			`git commit -m "${RAW.trim().replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/`/g, "\\`").replace(/\$/g, "\\$")}"`,
		);
		expect(intent.requestId).not.toBe("");
		for (const obj of [intent, intent.command, intent.terminal, intent.commitSource])
			expect(Object.isFrozen(obj)).toBe(true);
		original.cwd = "/synthetic/mutated";
		original.cols = 5;
		expect(intent.terminal.cwd).toBe("/synthetic/workspace-a");
		expect(intent.terminal.cols).toBe(117);
		noProcessSideEffects(p);
		expect(input(p.host).value).toBe(RAW);
		expect(localStorage.getItem(SCM_COMMIT_HISTORY_KEY)).toBeNull();
		await settle(() => d.resolve(false));
		noProcessSideEffects(p);
		expect(input(p.host).value).toBe(RAW);
		expect(localStorage.getItem(SCM_COMMIT_HISTORY_KEY)).toBeNull();
	});

	it.each(["none", "conversation", "workspace"])(
		"new terminal identity, never foreign title reuse (%s)",
		async (foreign) => {
			const d = deferred();
			const terminals =
				foreign === "none"
					? []
					: [tab(foreign === "conversation" ? { conversationId: "fixture-foreign" } : { cwd: "/synthetic/foreign" })];
			const p = scm({ chat: chat({ terminals }), onCommandIntent: d.callback });
			type(p.host, RAW);
			commit(p.host);
			const intent = d.callback.mock.calls[0][0];
			expect(intent.terminal).toMatchObject({ mode: "new", cwd: "/synthetic/workspace-a", cols: 80, rows: 24 });
			expect(intent.terminal.id).not.toBe("fixture-terminal-a");
			noProcessSideEffects(p);
			await settle(() => d.resolve(true));
			expect(input(p.host).value).toBe("");
			expect(JSON.parse(localStorage.getItem(SCM_COMMIT_HISTORY_KEY)!)).toEqual([RAW.trim()]);
			expect(p.props.terminal.create).not.toHaveBeenCalled();
			expect(p.props.terminal.restart).not.toHaveBeenCalled();
			expect(writes()).toEqual([]);
			expect(p.props.terminal.select).toHaveBeenCalledExactlyOnceWith(intent.terminal.id);
			expect(p.props.onSwitchToTerminal).toHaveBeenCalledTimes(1);
		},
	);

	it.each([false, undefined, null, 1, "true", { owned: true }])(
		"nontrue admission %j retains exact source/history/process",
		async (result) => {
			const d = deferred();
			const p = scm({ chat: chat({ terminals: [tab()] }), onCommandIntent: d.callback });
			type(p.host, RAW);
			commit(p.host);
			await settle(() => d.resolve(result));
			noProcessSideEffects(p);
			expect(input(p.host).value).toBe(RAW);
			expect(localStorage.getItem(SCM_COMMIT_HISTORY_KEY)).toBeNull();
		},
	);
	it.each(["absent", "void", "sync", "throw", "reject"])(
		"unsupported/failed callback %s has no legacy fallback",
		async (kind) => {
			const d = deferred();
			const callback =
				kind === "absent"
					? undefined
					: kind === "reject"
						? d.callback
						: vi.fn(() => {
								if (kind === "throw") throw new Error("synthetic unavailable");
								return (kind === "sync" ? true : undefined) as unknown as Promise<boolean>;
							});
			const p = scm({ chat: chat({ terminals: [tab()] }), onCommandIntent: callback });
			type(p.host, RAW);
			commit(p.host);
			if (kind === "reject") await settle(() => d.reject(new Error("synthetic unavailable")));
			else await settle(() => {});
			noProcessSideEffects(p);
			expect(input(p.host).value).toBe(RAW);
			expect(localStorage.getItem(SCM_COMMIT_HISTORY_KEY)).toBeNull();
		},
	);
	it("unresolved admission has no elapsed-time success or destructive action", () => {
		const d = deferred();
		const p = scm({ onCommandIntent: d.callback });
		type(p.host, RAW);
		commit(p.host);
		act(() => vi.advanceTimersByTime(120_000));
		noProcessSideEffects(p);
		expect(input(p.host).value).toBe(RAW);
		expect(input(p.host).disabled).toBe(false);
		expect(d.callback).toHaveBeenCalledTimes(1);
	});
	it.each(["edit", "aba", "recall", "generated"])(
		"newer editor revision (%s) survives admitted completion",
		async (kind) => {
			localStorage.setItem(SCM_COMMIT_HISTORY_KEY, JSON.stringify(["synthetic remembered"]));
			const d = deferred();
			const p = scm({ onCommandIntent: d.callback });
			type(p.host, RAW);
			commit(p.host);
			let expected = RAW;
			if (kind === "edit" || kind === "aba") {
				type(p.host, "synthetic newer");
				expected = "synthetic newer";
			}
			if (kind === "aba") {
				type(p.host, RAW);
				expected = RAW;
			}
			if (kind === "recall") {
				key(p.host, "ArrowUp");
				expected = "synthetic remembered";
			}
			if (kind === "generated") {
				transport = true;
				p.rerender({ active: true });
				const req = sent.findLast((m) => m.type === "scm_status")!;
				p.rerender({
					active: true,
					chat: chat({
						scmData: {
							type: "scm_data",
							reqId: "reqId" in req ? req.reqId : -1,
							kind: "status",
							ok: true,
							files: [{ path: "synthetic.txt", x: "M", y: " " }],
						},
					}),
				});
				const gen = [...p.host.querySelectorAll<HTMLButtonElement>("button")].find((b) =>
					b.title.includes("Generate"),
				)!;
				act(() => gen.click());
				const request = sent.findLast((m) => m.type === "scm_commitmsg")!;
				p.rerender({
					chat: chat({
						scmData: {
							type: "scm_data",
							reqId: "reqId" in request ? request.reqId : -1,
							kind: "commitmsg",
							ok: true,
							text: RAW,
						},
					}),
				});
			}
			await settle(() => d.resolve(true));
			expect(input(p.host).value).toBe(expected);
			expect(JSON.parse(localStorage.getItem(SCM_COMMIT_HISTORY_KEY)!)).toEqual(["synthetic remembered"]);
		},
	);
	it.each(["conversation", "workspace", "session", "aba", "remount"])(
		"late result cannot mutate switched target (%s)",
		async (kind) => {
			const d = deferred();
			const p = scm({ onCommandIntent: d.callback });
			type(p.host, RAW);
			commit(p.host);
			const next = chat();
			if (kind === "conversation" || kind === "aba") {
				next.activeConversationId = "fixture-b";
				next.state = { ...next.state!, conversationId: "fixture-b" };
			}
			if (kind === "workspace") next.state = { ...next.state!, cwd: "/synthetic/workspace-b" };
			if (kind === "session") next.state = { ...next.state!, sessionId: "fixture-session-b" };
			if (kind === "remount") {
				p.unmount();
				p.rerender({});
				type(p.host, "synthetic new mount");
			} else {
				p.rerender({ chat: next });
				if (kind === "aba") p.rerender({ chat: chat() });
			}
			await settle(() => d.resolve(true));
			expect(input(p.host).value).toBe(kind === "remount" ? "synthetic new mount" : RAW);
			noProcessSideEffects(p);
			expect(localStorage.getItem(SCM_COMMIT_HISTORY_KEY)).toBeNull();
		},
	);
	it.each(["mismatch", "session", "cwd", "conversation", "offline"])(
		"refuses incomplete/incoherent target %s",
		(kind) => {
			const d = deferred();
			const c = chat();
			if (kind === "mismatch") c.activeConversationId = "fixture-b";
			if (kind === "session") c.state = { ...c.state!, sessionId: "" };
			if (kind === "cwd") c.state = { ...c.state!, cwd: "" };
			if (kind === "conversation") c.state = { ...c.state!, conversationId: "" };
			if (kind === "offline") c.ready = false;
			const p = scm({ chat: c, onCommandIntent: d.callback });
			type(p.host, RAW);
			commit(p.host);
			expect(d.callback).not.toHaveBeenCalled();
			noProcessSideEffects(p);
			expect(input(p.host).value).toBe(RAW);
		},
	);
});

describe("TerminalPanel and TermXterm: one explicit owner; rendering never runs commands", () => {
	it("new user-shell creation is explicit M, never a mount/recovery side effect", () => {
		transport = true;
		const p = terminal();
		const button = [...p.host.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.title === "New terminal")!;
		act(() => button.click());
		expect(sent).toContainEqual(
			expect.objectContaining({
				type: "terminal_create",
				conversationId: "fixture-conversation-a",
				locale: "en",
				agentBash: undefined,
				cwd: "/synthetic/workspace-a",
			}),
		);
		expect(p.props.terminal.create).toHaveBeenCalledTimes(1);
		expect(sent.some((m) => m.type === "run_command")).toBe(false);
	});
	it("manual retry after refusal has a fresh request, not automatic replay", async () => {
		const d = deferred();
		const p = terminal({ onCommandIntent: d.callback });
		click(p.host, ".cmd-main");
		const first = d.callback.mock.calls[0][0].requestId;
		await settle(() => d.resolve(false));
		expect(d.callback).toHaveBeenCalledTimes(1);
		click(p.host, ".cmd-main");
		expect(d.callback).toHaveBeenCalledTimes(2);
		expect(d.callback.mock.calls[1][0].requestId).not.toBe(first);
		expect(writes()).toEqual([]);
	});
	it.each([undefined, "", "${pwd}/fixture"])("captures exact complete CommandDef cwd=%s", async (cwd) => {
		const command = { name: CMD.name, command: CMD.command, ...(cwd === undefined ? {} : { cwd }) };
		const d = deferred();
		const p = terminal({ chat: chat({ commands: [command] }), onCommandIntent: d.callback });
		click(p.host, ".cmd-run", 3);
		click(p.host, ".cmd-main");
		expect(d.callback).toHaveBeenCalledTimes(1);
		const intent = d.callback.mock.calls[0][0];
		expect(intent.command).toEqual(command);
		expect(intent.source).toBe("terminal");
		expect(intent.commitSource).toBeUndefined();
		expect(Object.isFrozen(intent.command)).toBe(true);
		command.command = "synthetic changed";
		expect(intent.command.command).toBe(CMD.command);
		expect(writes()).toEqual([]);
		expect(p.props.terminal.create).not.toHaveBeenCalled();
		await settle(() => d.resolve(false));
		expect(writes()).toEqual([]);
	});
	it.each([true, false])(
		"existing live/dead terminal is not restarted before or after caller admission: %s",
		async (running) => {
			const d = deferred();
			const p = terminal({
				chat: chat({ terminals: [tab({ title: CMD.name, running })] }),
				onCommandIntent: d.callback,
			});
			act(() => vi.advanceTimersByTime(32));
			sent = [];
			click(p.host, ".cmd-main");
			expect(p.props.terminal.restart).not.toHaveBeenCalled();
			expect(writes()).toEqual([]);
			await settle(() => d.resolve(true));
			expect(p.props.terminal.restart).not.toHaveBeenCalled();
			expect(writes()).toEqual([]);
			expect(d.callback.mock.calls[0][0].terminal).toMatchObject({
				id: "fixture-terminal-a",
				mode: "existing",
				running,
			});
		},
	);
	it.each([true, false])("command mount/remount/recovery dispatches nothing; running=%s", (running) => {
		const b = bridge();
		const props = {
			conversationId: "fixture-a",
			sessionId: "fixture-sid",
			onAttachTerminal: attach,
			terminalId: "fixture-term",
			cwd: "/synthetic/a",
			command: { ...CMD },
			active: true,
			running,
			register: b.register,
		};
		const p = mount(createElement(TermXterm, props));
		act(() => vi.advanceTimersByTime(32));
		p.render(createElement(TermXterm, { ...props, command: { ...CMD }, exitCode: 5 }));
		act(() => vi.advanceTimersByTime(32));
		p.unmount();
		p.render(createElement(TermXterm, props));
		act(() => vi.advanceTimersByTime(32));
		expect(b.register).toHaveBeenCalledTimes(2);
		expect(writes()).toEqual([]);
	});
	it("preserves attached shell live input/resize/output and non-killing unmount", async () => {
		const b = bridge();
		const p = mount(
			createElement(TermXterm, {
				conversationId: "fixture-a",
				sessionId: "fixture-sid",
				onAttachTerminal: attach,
				terminalId: "fixture-shell",
				cwd: "/synthetic/a",
				title: "Synthetic shell",
				active: true,
				running: true,
				register: b.register,
			}),
		);
		await settle(() => vi.advanceTimersByTime(32));
		expect(sent.some((m) => m.type === "terminal_create")).toBe(false);
		ptys[0].input!("synthetic PTY bytes\r");
		expect(sent).toContainEqual({
			type: "terminal_input",
			terminalId: "fixture-shell",
			conversationId: "fixture-a",
			data: "synthetic PTY bytes\r",
		});
		const writer = b.register.mock.calls[0][2] as { write(data: string): void };
		writer.write("synthetic output");
		expect(ptys[0].write).toHaveBeenCalledWith("synthetic output");
		expect(sent.some((m) => m.type === "terminal_resize")).toBe(true);
		p.unmount();
		expect(sent.some((m) => m.type === "terminal_kill" || m.type === "run_command")).toBe(false);
		expect(localStorage.length).toBe(0);
		expect(sessionStorage.length).toBe(0);
	});
	it("keeps explicit rename/close live, without command admission or a byte journal", () => {
		const d = deferred();
		const p = terminal({ chat: chat({ terminals: [tab()] }), onCommandIntent: d.callback });
		click(p.host, ".term-tab-rename");
		const rename = p.host.querySelector<HTMLInputElement>(".term-tab-rename-input")!;
		act(() => {
			Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(rename, "Synthetic rename");
			rename.dispatchEvent(new Event("input", { bubbles: true }));
		});
		act(() => rename.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
		click(p.host, ".term-tab-close:not(.term-tab-rename)");
		expect(sent).toContainEqual({
			type: "rename_terminal",
			terminalId: "fixture-terminal-a",
			conversationId: "fixture-conversation-a",
			title: "Synthetic rename",
		});
		expect(sent).toContainEqual({
			type: "terminal_kill",
			terminalId: "fixture-terminal-a",
			conversationId: "fixture-conversation-a",
		});
		expect(d.callback).not.toHaveBeenCalled();
		expect(localStorage.length).toBe(0);
		expect(sessionStorage.length).toBe(0);
	});
});

describe("TermXterm: exact existing-only attachment and renderer lifetime", () => {
	const props = () => ({
		conversationId: "fixture-attach-conversation",
		sessionId: "fixture-attach-session",
		terminalId: "fixture-attach-terminal",
		cwd: "/synthetic/attach",
		active: true,
		running: true,
		register: bridge().register,
	});
	it("freezes real original identity + fitted size; true needs output replacement before enabling input", async () => {
		let replace!: (data: string) => void;
		let resolve!: (result: boolean) => void;
		const callback = vi.fn((request: TerminalAttachIntent, output: (data: string) => void) => {
			replace = output;
			return new Promise<boolean>((done) => {
				resolve = done;
			});
		});
		const original = props();
		const p = mount(createElement(TermXterm, { ...original, onAttachTerminal: callback }));
		act(() => vi.advanceTimersByTime(32));
		expect(callback).toHaveBeenCalledTimes(1);
		const request = callback.mock.calls[0][0];
		expect(request).toEqual({
			conversationId: original.conversationId,
			sessionId: original.sessionId,
			terminalId: original.terminalId,
			cols: 91,
			rows: 29,
			viewId: expect.any(String),
		});
		expect(Object.isFrozen(request)).toBe(true);
		expect(ptys[0].options.disableStdin).toBe(true);
		ptys[0].input!("synthetic blocked input");
		expect(sent).toEqual([]);
		act(() => replace("synthetic retained output\n[pi-term-exit:4]\n"));
		expect(ptys[0].reset).toHaveBeenCalledTimes(1);
		expect(ptys[0].write).toHaveBeenCalledWith("synthetic retained output\r\n");
		await settle(() => resolve(true));
		expect(ptys[0].options.disableStdin).toBe(false);
		expect(p.host.querySelector(".term-xterm")?.getAttribute("data-attach-state")).toBe("attached");
		ptys[0].input!("synthetic live input");
		expect(sent).toContainEqual({
			type: "terminal_input",
			conversationId: original.conversationId,
			terminalId: original.terminalId,
			data: "synthetic live input",
		});
		act(() => replace("synthetic late replacement"));
		expect(ptys[0].reset).toHaveBeenCalledTimes(1);
		p.render(
			createElement(TermXterm, {
				...original,
				onAttachTerminal: callback,
				active: false,
				command: { ...CMD },
				running: false,
				exitCode: 4,
			}),
		);
		expect(callback).toHaveBeenCalledTimes(1);
		expect(writes()).toEqual([]);
	});
	it.each(["missing", "session", "conversation", "terminal", "false", "void", "sync", "reject", "throw", "no-replay"])(
		"%s is read-only/unavailable, never a create/run fallback",
		async (kind) => {
			const original = props();
			if (kind === "session") original.sessionId = "";
			if (kind === "conversation") original.conversationId = "";
			if (kind === "terminal") original.terminalId = "";
			const callback = vi.fn((_request: TerminalAttachIntent, output: (data: string) => void) => {
				if (kind === "throw") throw new Error("synthetic attach unavailable");
				if (kind === "reject") return Promise.reject(new Error("synthetic attach unavailable"));
				if (kind === "void") return undefined as unknown as Promise<boolean>;
				if (kind === "sync") return true as unknown as Promise<boolean>;
				if (kind === "false") {
					output("synthetic partial output");
					return Promise.resolve(false);
				}
				return Promise.resolve(true); // no retained output is not a genuine attachment
			});
			const p = mount(
				createElement(TermXterm, { ...original, onAttachTerminal: kind === "missing" ? undefined : callback }),
			);
			await settle(() => vi.advanceTimersByTime(32));
			expect(p.host.querySelector(".term-xterm")?.getAttribute("data-attach-state")).toBe("unavailable");
			expect(ptys[0].options.disableStdin).toBe(true);
			ptys[0].input!("synthetic no-send");
			expect(sent).toEqual([]);
			if (["missing", "session", "conversation", "terminal"].includes(kind)) expect(callback).not.toHaveBeenCalled();
		},
	);
	it.each(["conversation", "session", "terminal", "remount"])(
		"late replacement/result cannot touch another renderer (%s)",
		async (kind) => {
			const pending: Array<{
				request: TerminalAttachIntent;
				output(data: string): void;
				resolve(value: boolean): void;
			}> = [];
			const callback: OnAttachTerminal = (request, output) =>
				new Promise((resolve) => {
					pending.push({ request, output, resolve });
				});
			const original = props();
			const p = mount(createElement(TermXterm, { ...original, onAttachTerminal: callback }));
			act(() => vi.advanceTimersByTime(32));
			if (kind === "remount") p.unmount();
			p.render(
				createElement(TermXterm, {
					...original,
					onAttachTerminal: callback,
					...(kind === "conversation"
						? { conversationId: "fixture-b" }
						: kind === "session"
							? { sessionId: "fixture-b" }
							: kind === "terminal"
								? { terminalId: "fixture-b" }
								: {}),
				}),
			);
			act(() => vi.advanceTimersByTime(32));
			expect(pending).toHaveLength(2);
			expect(pending[0].request.viewId).not.toBe(pending[1].request.viewId);
			await settle(() => {
				pending[0].output("synthetic stale output");
				pending[0].resolve(true);
			});
			expect(ptys[0].reset).not.toHaveBeenCalled();
			expect(ptys[1].reset).not.toHaveBeenCalled();
			expect(sent).toEqual([]);
			await settle(() => {
				pending[1].output("");
				pending[1].resolve(true);
			});
			expect(ptys[1].reset).toHaveBeenCalledTimes(1);
			expect(ptys[1].options.disableStdin).toBe(false);
			expect(writes()).toEqual([]);
		},
	);
});
