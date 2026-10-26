import { useEffect, useRef, useState } from "react";
import { randomUuid } from "../uuid";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import type { CommandDef } from "../types";
import { buildTermTheme, THEME_CHANGE_EVENT } from "../theme";
import { shouldStartTouchScroll, touchWheelDeltaY } from "../term-touch";
import { useI18n } from "../i18n";
import { appSend } from "../app-globals";

/** Strip exit sentinels/baked banners; the banner itself renders on terminal_exit. */
export function stripExitBanner(data: string): { clean: string; exitCode: number | null } {
	let exitCode: number | null = null;
	const clean = data
		.replace(/\r?\n?\[pi-term-exit:(-?\d+)\]\r?\n?/g, (_, c: string) => {
			exitCode = Number(c);
			return "\r\n";
		})
		.replace(/\r?\n?\x1b\[90m\[(?:进程已退出，退出码 |Process exited with code )-?\d+\]\x1b\[0m\r?\n?/g, "\r\n");
	return { clean, exitCode };
}

/** Existing-only renderer attach. viewId identifies this display occurrence, never authority. */
export interface TerminalAttachIntent {
	readonly conversationId: string;
	readonly sessionId: string;
	readonly terminalId: string;
	readonly cols: number;
	readonly rows: number;
	readonly viewId: string;
}
export type OnAttachTerminal = (
	intent: TerminalAttachIntent,
	replaceOutput: (data: string) => void,
) => Promise<boolean>;

interface TermXtermProps {
	conversationId: string;
	/** Only the coherent snapshot's genuine SID; absence makes this view read-only. */
	sessionId?: string;
	onAttachTerminal?: OnAttachTerminal;
	terminalId: string;
	/** Metadata only. Mounting a stored command NEVER requests execution. */
	command?: CommandDef;
	/** Original display metadata; never spawn/attach authority. */
	cwd: string;
	/** Display title only. */
	title?: string;
	/** Agent-bash display metadata; mounting never rebuilds its process. */
	agentBash?: boolean;
	/** Whether this terminal is the visible one. */
	active: boolean;
	/** Live running flag (banner renders when this flips false). */
	running?: boolean;
	/** Exit code (banner text). */
	exitCode?: number | null;
	register: (conversationId: string, id: string, writer: { write(data: string): void; dispose(): void }) => () => void;
}

/**
 * One xterm renderer per terminal tab. Mount/restore only attaches to an
 * already-owned PTY/output snapshot; it never creates/restarts a process.
 * The host owns command dispatch, and TerminalPanel's explicit new-shell action
 * owns plain-shell creation. Input/resize remain live and unjournaled after attach.
 */
export function TermXterm({
	conversationId,
	sessionId,
	onAttachTerminal,
	terminalId,
	active,
	running,
	exitCode,
	register,
}: TermXtermProps) {
	const containerRef = useRef<HTMLDivElement>(null);
	const termRef = useRef<{ term: Terminal; fit: FitAddon; writeExit(): void } | null>(null);
	const { t } = useI18n();
	const live = useRef({ running, exitCode, t });
	live.current = { running, exitCode, t };
	const attachedRef = useRef(false);
	const [attachState, setAttachState] = useState<"pending" | "attached" | "unavailable">("pending");

	// Render lifetime, not execution identity. Metadata/locale/tab visibility
	// changes must not recreate the renderer or replay an authored command.
	useEffect(() => {
		const container = containerRef.current;
		if (!container) return;

		let disposed = false;
		let settled = false;
		let replaced = false;
		let accepted = false;
		let replayComplete = false;
		let lastRunning: boolean | undefined;
		attachedRef.current = false;
		setAttachState("pending");
		const term = new Terminal({
			disableStdin: true,
			theme: buildTermTheme(),
			fontFamily: '"SF Mono", "JetBrains Mono", ui-monospace, Menlo, Consolas, monospace',
			fontSize: 13,
			cursorBlink: true,
			scrollback: 8000,
		});
		const fit = new FitAddon();
		term.loadAddon(fit);
		term.open(container);
		const isCurrent = () => !disposed && termRef.current?.term === term;
		const exitBanner = () => {
			const current = live.current;
			// An exited process may have left an unfinished OSC/CSI/DCS sequence.
			return `\x18\r\n\x1b[90m${current.t("exitBanner", { code: current.exitCode ?? "" })}\x1b[0m\r\n`;
		};
		const writeExit = () => {
			if (!isCurrent() || lastRunning === live.current.running) return;
			lastRunning = live.current.running;
			if (lastRunning === false) term.write(exitBanner());
		};
		const disposeRenderer = (announce = false) => {
			if (disposed) return;
			disposed = true;
			term.options.disableStdin = true;
			if (termRef.current?.term === term) {
				attachedRef.current = false;
				termRef.current = null;
				if (announce) setAttachState("unavailable");
			}
			term.dispose();
		};
		termRef.current = { term, fit, writeExit };
		if (active) term.focus();

		// Re-theme the canvas when the active theme changes (the injected <link>
		// fires THEME_CHANGE_EVENT after its stylesheet has applied).
		const onThemeChange = () => {
			if (isCurrent()) term.options.theme = buildTermTheme();
		};
		window.addEventListener(THEME_CHANGE_EVENT, onThemeChange);

		// xterm maps Ctrl+V to ^V (0x16, readline quoted-insert) and Ctrl+C to
		// ^C, preventDefault()ing both, so the browser's native copy/paste never
		// fires. Returning false skips xterm's key handling entirely:
		//   · Ctrl+V / Cmd+V → browser-native paste (event lands on xterm's
		//     helper textarea and is forwarded to the shell)
		//   · Ctrl+C with a selection → copy instead of ^C (text staged in the
		//     helper textarea, same trick as xterm's own right-click copy; no
		//     clipboard-API permission needed, works over plain http)
		term.attachCustomKeyEventHandler((event) => {
			if (event.type !== "keydown") return true;
			const key = event.key?.toLowerCase();
			if ((event.ctrlKey || event.metaKey) && key === "v") {
				return false;
			}
			if (event.ctrlKey && !event.shiftKey && !event.altKey && key === "c") {
				if (term.hasSelection()) {
					const ta = term.textarea;
					if (ta) {
						ta.value = term.getSelection();
						ta.select();
					}
					return false;
				}
			}
			return true;
		});

		const unregister = register(conversationId, terminalId, {
			write: (data) => {
				if (!disposed) term.write(stripExitBanner(data).clean);
			},
			dispose: () => disposeRenderer(true),
		});

		const sendDims = () => {
			if (!attachedRef.current || disposed) return;
			try {
				fit.fit();
				appSend({
					type: "terminal_resize",
					terminalId,
					conversationId,
					cols: term.cols,
					rows: term.rows,
				});
			} catch {
				// Container hidden — will re-fit when shown.
			}
		};

		const finishAttach = () => {
			if (!isCurrent() || !settled) return;
			// Host ownership and renderer parsing are independent acknowledgements.
			if (accepted && replaced && !replayComplete) return;
			const attached = accepted && replaced && replayComplete;
			attachedRef.current = attached;
			term.options.disableStdin = !attached;
			setAttachState(attached ? "attached" : "unavailable");
			if (attached) sendDims();
		};

		const raf = requestAnimationFrame(() => {
			if (!isCurrent()) return;
			try {
				fit.fit();
			} catch {
				/* hidden container */
			}
			if (!onAttachTerminal || !conversationId || !sessionId || !terminalId) {
				setAttachState("unavailable");
				return;
			}
			const intent = Object.freeze({
				conversationId,
				sessionId,
				terminalId,
				cols: term.cols,
				rows: term.rows,
				viewId: randomUuid(),
			});
			const replaceOutput = (data: string) => {
				if (!isCurrent() || settled || replaced || typeof data !== "string") return;
				replaced = true;
				lastRunning = live.current.running;
				// reset() is synchronous and does NOT clear xterm's pending writes.
				// CAN cancels a partial parser sequence; RIS resets at this exact place
				// in xterm's own queue. No separate/unbounded live-output backlog.
				term.write(`\x18\x1bc${stripExitBanner(data).clean}${lastRunning === false ? exitBanner() : ""}`, () => {
					if (!isCurrent() || replayComplete) return;
					replayComplete = true;
					finishAttach();
				});
			};
			void (async () => {
				try {
					const result = onAttachTerminal(intent, replaceOutput);
					if (result && typeof result.then === "function") accepted = (await result) === true;
				} catch {
					/* unavailable: keep output visible and read-only */
				}
				settled = true;
				finishAttach();
			})();
		});

		const onData = term.onData((data) => {
			if (attachedRef.current && !disposed) appSend({ type: "terminal_input", terminalId, conversationId, data });
		});

		// 手机端触摸滚动兜底（issue #218）：xterm 6.0.0 自身无任何 touch
		// 处理，手指竖拖看不到历史输出。把单指竖直拖动合成 WheelEvent
		// 派发到 .xterm-viewport，复用 xterm 自己的滚轮链路（含
		// scrollSensitivity、alt 缓冲/鼠标协议分发）。阈值 + 主轴判定保证
		// 轻点/长按选择/横向拖动不受影响；多指（缩放）直接忽略。
		// 上游 #5685 已把触摸滚动做进内核，升级到带该修复的
		// 版本后即可删掉本段。
		// term.open 之后 element 才存在；typing 上是可选的，监听全部可选链。
		const termEl = term.element;
		let touchId: number | null = null;
		let touchStartX = 0;
		let touchStartY = 0;
		let touchLastY = 0;
		let touchScrolling = false;
		const onTouchStart = (e: TouchEvent) => {
			if (e.touches.length !== 1) {
				touchId = null;
				touchScrolling = false;
				return;
			}
			const t = e.touches[0];
			touchId = t.identifier;
			touchStartX = t.clientX;
			touchStartY = t.clientY;
			touchLastY = t.clientY;
			touchScrolling = false;
		};
		const onTouchMove = (e: TouchEvent) => {
			if (touchId === null || e.touches.length !== 1) return;
			const t = e.touches[0];
			if (t.identifier !== touchId) return;
			if (!touchScrolling) {
				if (!shouldStartTouchScroll(t.clientX - touchStartX, t.clientY - touchStartY)) return;
				touchScrolling = true;
			}
			// 劫持后阻止下拉刷新/页面手势，手指跟着内容走。
			e.preventDefault();
			const deltaY = touchWheelDeltaY(touchLastY, t.clientY);
			touchLastY = t.clientY;
			if (deltaY === 0) return;
			if (typeof WheelEvent === "undefined") return;
			const wheelTarget = container.querySelector(".xterm-viewport") ?? termEl;
			wheelTarget?.dispatchEvent(
				new WheelEvent("wheel", {
					bubbles: true,
					cancelable: true,
					deltaY,
					deltaMode: 0,
					clientX: t.clientX,
					clientY: t.clientY,
				}),
			);
		};
		const onTouchEnd = (e: TouchEvent) => {
			if (touchId === null) return;
			// 仍有别的触点在（多指中的一指抬起）→ 整个手势作废。
			if (e.touches.length > 0) {
				touchId = null;
				touchScrolling = false;
				return;
			}
			touchId = null;
			touchScrolling = false;
		};
		// touchmove 必须是非 passive 才能 preventDefault（阻止下拉刷新）。
		termEl?.addEventListener("touchstart", onTouchStart, { passive: true });
		termEl?.addEventListener("touchmove", onTouchMove, { passive: false });
		termEl?.addEventListener("touchend", onTouchEnd);
		termEl?.addEventListener("touchcancel", onTouchEnd);

		let ro: ResizeObserver | null = null;
		if (typeof ResizeObserver !== "undefined") {
			ro = new ResizeObserver(() => {
				if (container.offsetWidth > 0 && container.offsetHeight > 0) {
					sendDims();
				}
			});
			ro.observe(container);
		}

		return () => {
			// Fence before unregistering: that boundary may synchronously call back.
			disposeRenderer();
			cancelAnimationFrame(raf);
			onData.dispose();
			termEl?.removeEventListener("touchstart", onTouchStart);
			termEl?.removeEventListener("touchmove", onTouchMove);
			termEl?.removeEventListener("touchend", onTouchEnd);
			termEl?.removeEventListener("touchcancel", onTouchEnd);
			window.removeEventListener(THEME_CHANGE_EVENT, onThemeChange);
			ro?.disconnect();
			unregister();
			// Unmounting happens when switching conversations/views; the PTY is
			// persistent and is killed only by an explicit close action or agent tool.
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [conversationId, sessionId, terminalId, register, onAttachTerminal]);

	// Becoming visible: re-fit (size may have changed while hidden) and focus.
	useEffect(() => {
		if (!active) return;
		const raf = requestAnimationFrame(() => {
			const inst = termRef.current;
			if (!inst || !attachedRef.current) return;
			try {
				inst.fit.fit();
				appSend({
					type: "terminal_resize",
					terminalId,
					conversationId,
					cols: inst.term.cols,
					rows: inst.term.rows,
				});
			} catch {
				// ignore
			}
			inst.term.focus();
		});
		return () => cancelAnimationFrame(raf);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [active]);

	// Exit banner in the LIVE locale (reads t() at effect time, not at
	// PTY-creation time). Guarded by the running-state edge: the banner is
	// written once per running→stopped transition, so reruns in the SAME tab
	// (TerminalPanel reuses the component instance) and remounts of already-
	// stopped terminals each render their banner without duplicates.
	useEffect(() => {
		termRef.current?.writeExit();
	}, [running, exitCode, conversationId, sessionId, terminalId, register, onAttachTerminal]);

	return (
		<div
			className={`term-xterm ${active ? "" : "hidden"}`}
			data-attach-state={attachState}
			style={{ display: active ? "flex" : "none", flexDirection: "column" }}
		>
			<div ref={containerRef} style={{ flex: 1, minHeight: 0 }} />
			{attachState !== "attached" && (
				<div role="status">
					{t("terminal")}: {attachState === "pending" ? t("sendingTag") : t("queueProfileUnavailable")}
				</div>
			)}
		</div>
	);
}
