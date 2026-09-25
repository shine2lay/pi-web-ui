/**
 * webui-context — 扩展 UI 桥：把扩展的 setWidget/setStatus/notify/select/
 * confirm/input 等调用桥接到浏览器（widgets/statuses/notice/dialog 消息）。
 * TUI 专属能力（终端输入、footer/header、自定义组件）为惰性 no-op；
 * select/confirm/input 弹窗经 dialog_response 回传，Esc 视为取消。
 * headless 实例（子代理会话）不接任何浏览器：见 WebUIContext.headless()。
 *
 * 从 agent-service.ts 抽出，行为保持不变。
 */
import type { ExtensionUIContext, Theme } from "@earendil-works/pi-coding-agent";
import type { ServerMessage } from "./protocol.js";

const WIDGET_WIDTH = 80;

/** Every browser dialog's id, window-level (below) and per-chat (chat-dialogs.ts) alike, comes from
 *  this one counter: the page answers by id alone, so no two waiting dialogs may share one. */
let lastDialogId = 0;
export function nextDialogId(): number {
	return ++lastDialogId;
}

/** ANSI 转义序列（CSI + OSC 两类）：扩展 widget/status 文本里常混有 TUI 颜色码
 *  （如 pi-powerline-footer），浏览器会把它渲染成字面 `[38;5;244m` 乱码（issue #16）。 */
const ANSI_RE = /\[[0-9:;<=>?]*[ -/]*[@-~]|\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g;

/** Strip all ANSI escape sequences (CSI/OSC) from a string. */
export function stripAnsi(s: string): string {
	return s.replace(ANSI_RE, "");
}

/** Mock theme: TUI color functions degrade to identity so widget text survives. */
export const mockThemeProxy = new Proxy(
	{
		fg: (_color: string, text: string) => text,
		bold: (text: string) => text,
		strikethrough: (text: string) => text,
		dim: (text: string) => text,
	},
	{
		get(target, prop) {
			if (prop in target) return (target as Record<string, unknown>)[prop as string];
			// Unknown theme methods → no-op passthrough.
			return (_arg: unknown, text?: unknown) => (text !== undefined ? text : "");
		},
	},
) as unknown as Theme;

/** Mock TUI: any method call is a safe no-op. */
const mockTui = new Proxy(
	{
		requestRender: () => {},
		render: () => {},
	},
	{
		get(target, prop) {
			if (prop in target) return (target as Record<string, unknown>)[prop as string];
			return () => {};
		},
	},
);

interface WidgetEntry {
	/** Renders the widget to plain text lines, or undefined when empty. */
	render: (width: number) => string[] | undefined;
	/** Whether the widget can be disposed. */
	dispose?: () => void;
}

/**
 * Implements the subset of ExtensionUIContext that makes sense for a web UI.
 * widgets/statuses/notices/dialogs are bridged to the browser (a dialog nobody
 * answers resolves to cancellation); TUI-only affordances (terminal input,
 * footer/header, custom components, editor hooks) are inert.
 *
 * 两种实例：挂浏览器的（构造时给真 emitter）与 headless 的（`WebUIContext.headless()`，
 * 子代理会话用——见该方法的说明）。
 */
export class WebUIContext {
	readonly theme = mockThemeProxy;
	private widgets = new Map<string, WidgetEntry>();
	private lastLines = new Map<string, string[]>();
	private emit: (msg: ServerMessage) => void;
	/** headless 实例没有浏览器面板：输出全部丢弃、弹窗直接按取消返回。 */
	private headless: boolean;

	constructor(emit: (msg: ServerMessage) => void, options: { headless?: boolean } = {}) {
		this.headless = options.headless === true;
		this.emit = this.headless ? () => {} : emit;
	}

	/** 子代理会话用的上下文：方法面与挂浏览器的那个完全一致（扩展调用任何
	 *  ExtensionUIContext 方法都不会因方法缺失而崩），但没有面板接收输出，因此
	 *
	 *   - widgets/status/notice 一律丢弃（不会与主对话的 widget/status 串台）；
	 *   - widget 组件工厂不调用（没人 dispose 的组件会一直挂着）；
	 *   - select/confirm/input 直接按「取消」resolve —— 关键：这里没有浏览器应答，
	 *     照常挂 Promise 会让扩展永久 await（只有 20 分钟的工具看门狗兜底）。
	 */
	static headless(): WebUIContext {
		return new WebUIContext(() => {}, { headless: true });
	}

	// -- widgets -------------------------------------------------------------

	/** Register a widget whose lines come from a plain getter, re-evaluated on
	 *  every render/refresh (no SDK Component required). Used for
	 *  conversation-scoped overlays (e.g. markers) so switching conversations
	 *  re-renders them without re-registering. */
	setDynamicWidget(key: string, lines: () => string[]): void {
		this.widgets.set(key, { render: () => lines() });
		this.lastLines.delete(key);
		this.push();
	}

	/** Matches ExtensionUIContext's overloaded setWidget exactly. */
	setWidget: ExtensionUIContext["setWidget"] = (key, content, options) => {
		void options;
		// headless：没有面板可渲染，连组件工厂都不调用。
		if (this.headless) return;
		if (content === undefined) {
			this.widgets.delete(key);
			this.lastLines.delete(key);
			this.push();
			return;
		}
		if (typeof content === "function") {
			let comp: { render?: (w: number) => string[] | undefined; dispose?: () => void } | undefined;
			try {
				// Mock TUI/theme: extensions only read a handful of theme helpers;
				// everything else is a no-op, so the widget renders to plain text.
				comp = content(mockTui as never, mockThemeProxy as never) as typeof comp;
			} catch {
				comp = undefined;
			}
			this.widgets.set(key, {
				render: (w) => comp?.render?.(w),
				dispose: comp?.dispose,
			});
		} else {
			this.widgets.set(key, { render: () => content });
		}
		this.push();
	};

	/** Whether any widgets are mounted — the 2s poll skips refresh when false. */
	hasWidgets(): boolean {
		return this.widgets.size > 0;
	}

	/** Re-render all widgets and push when content changed (polled + on demand). */
	refresh(): void {
		let changed = false;
		for (const [key, w] of this.widgets) {
			let lines: string[] | undefined;
			try {
				lines = w.render(WIDGET_WIDTH);
			} catch {
				lines = undefined;
			}
			const prev = this.lastLines.get(key);
			if (JSON.stringify(lines ?? null) !== JSON.stringify(prev ?? null)) {
				this.lastLines.set(key, lines ?? []);
				changed = true;
			}
		}
		if (changed) this.push();
	}

	private push(): void {
		const widgets = this.snapshot();
		this.emit({ type: "widgets", widgets });
	}

	/** Render all widgets to their current text lines (without emitting). */
	snapshot(): { key: string; lines: string[] }[] {
		return [...this.widgets.entries()].map(([key, w]) => {
			let lines: string[] | undefined;
			try {
				lines = w.render(WIDGET_WIDTH);
			} catch {
				lines = undefined;
			}
			// 浏览器不是终端：ANSI 颜色码剥掉再下发/比对（issue #16）。
			const clean = lines?.map(stripAnsi) ?? undefined;
			this.lastLines.set(key, clean ?? []);
			return { key, lines: clean ?? [] };
		});
	}

	// -- notifications --------------------------------------------------------

	/**
	 * 上游 pi-mcp-adapter 每次启动都可能重新 bootstrap direct tools 并弹这条 info。
	 * 它只在服务器的缓存元数据“缺失”时才弹，而缓存是否有效看 configHash；
	 * configHash 把 headers / bearerToken 做环境变量插值后也算进去（metadata-cache.ts
	 * computeServerHash）。令牌一轮换 hash 就变 → 缓存判定失效 → 重新 bootstrap →
	 * 再弹一次。但此时工具已经注册好了（github_* 在当前会话里直接能调），
	 * “重启后才能用”对用户是假的。
	 *
	 * 上游这行（init.ts 里的 bootstrap 通知）是整个启动流程里唯一没带开关的：
	 * 旁边的「N servers connected」受 settings.notifyOnStartupConnect 控制，它不受。
	 * 所以在这里丢掉。只屏蔽 info：warning / error（连不上、工具被跳过、
	 * 需要授权）照常弹。
	 */
	private static readonly MUTED_INFO_NOTICES: RegExp[] = [/^MCP: direct tools for .+ will be available after restart$/];

	notify = (message: string, type?: "info" | "warning" | "error", messageEn?: string): void => {
		const level = type ?? "info";
		if (level === "info" && WebUIContext.MUTED_INFO_NOTICES.some((re: RegExp) => re.test(message.trim()))) {
			return;
		}
		this.emit({ type: "notice", level, text: message, textEn: messageEn });
	};

	// -- footer status (pi-lens "LSP Inactive", pi-cache-optimizer cache stats) --

	private statuses = new Map<string, string>();

	setStatus = (key: string, text: string | undefined): void => {
		if (text === undefined || text === "") {
			this.statuses.delete(key);
		} else {
			// 入口处剥 ANSI：pushStatuses / statusSnapshot 两条路径都拿到干净文本。
			const clean = stripAnsi(text);
			if (clean === "") this.statuses.delete(key);
			else this.statuses.set(key, clean);
		}
		this.pushStatuses();
	};

	private pushStatuses(): void {
		this.emit({
			type: "statuses",
			statuses: [...this.statuses.entries()].map(([k, v]) => ({
				key: k,
				text: v,
			})),
		});
	}

	/** Current footer status entries (for replay on socket attach). */
	statusSnapshot(): { key: string; text: string | undefined }[] {
		return [...this.statuses.entries()].map(([k, v]) => ({ key: k, text: v }));
	}

	// -- dialogs (select/confirm/input bridged to the browser) ---------------
	// 对话自己的扩展弹窗不走这里（per-chat-dialogs，见 chat-dialogs.ts）；这里只剩窗口自己的（目标向导）。

	private pendingDialogs = new Map<number, (value: string | boolean | null) => void>();

	select = (title: string, options: string[]): Promise<string | undefined> =>
		this.openDialog("select", title, [options]) as Promise<string | undefined>;
	confirm = (title: string, message: string): Promise<boolean> =>
		this.openDialog("confirm", title, [message]) as Promise<boolean>;
	input = (title: string, placeholder?: string): Promise<string | undefined> =>
		this.openDialog("input", title, [placeholder ?? ""]) as Promise<string | undefined>;

	private openDialog(
		kind: "select" | "confirm" | "input",
		title: string,
		args: unknown[],
	): Promise<string | boolean | null> {
		// headless：没人能应答，立刻按「取消」结束（与 cancelPendingDialogs 同值）。
		if (this.headless) return Promise.resolve(null);
		return new Promise((resolve) => {
			const id = nextDialogId();
			this.pendingDialogs.set(id, resolve);
			this.emit({ type: "dialog", id, kind, title, args });
		});
	}

	/** Resolve a pending dialog with the user's choice (called from the client). */
	resolveDialog(id: number, value: string | boolean | null): void {
		const resolve = this.pendingDialogs.get(id);
		if (resolve) {
			this.pendingDialogs.delete(id);
			resolve(value);
			this.emit({ type: "dialog_closed", id });
		}
	}

	/** Close every pending dialog as cancelled (used when a goal wizard aborts —
	 *  its unanswered browser dialogs must vanish, not linger). */
	cancelPendingDialogs(): void {
		for (const [id, resolve] of this.pendingDialogs) {
			this.pendingDialogs.delete(id);
			resolve(null);
			this.emit({ type: "dialog_closed", id });
		}
	}

	// -- inert TUI-only affordances ------------------------------------------

	onTerminalInput = (): (() => void) => () => {};
	setWorkingMessage = (): void => {};
	setWorkingVisible = (): void => {};
	setWorkingIndicator = (): void => {};
	setHiddenThinkingLabel = (): void => {};
	setFooter = (): void => {};
	setHeader = (): void => {};
	setTitle = (): void => {};
	custom = <T>(_factory: unknown, _done?: unknown): Promise<T> => new Promise<T>(() => {});
	pasteToEditor = (): void => {};
	setEditorText = (): void => {};
	getEditorText = (): string => "";
	editor = async (): Promise<string | undefined> => undefined;
	addAutocompleteProvider = (): void => {};
	setEditorComponent = (): void => {};
	getEditorComponent = (): undefined => undefined;
	getAllThemes = (): { name: string; path: string | undefined }[] => [];
	getTheme = (): undefined => undefined;
	setTheme = (): { success: boolean; error?: string } => ({ success: false });
	getToolsExpanded = (): boolean => false;
	setToolsExpanded = (): void => {};

	/** Dispose all widgets (extension reload / session teardown). */
	dispose(): void {
		for (const w of this.widgets.values()) {
			try {
				w.dispose?.();
			} catch {
				// best effort
			}
		}
		this.widgets.clear();
		this.lastLines.clear();
		// Cancel any pending dialogs.
		for (const [id, resolve] of this.pendingDialogs) {
			resolve(null);
			this.emit({ type: "dialog_closed", id });
		}
		this.pendingDialogs.clear();
	}
}
