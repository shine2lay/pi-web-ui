// TopBarOverflowMenu — the top bar's "⋯" menu and its phone breakpoint. Moved unchanged out of TopBar.tsx (Ops #1090:
// room for the waiting-questions bell without growing that file; WT-SIZE-500's legacy ratchet).
import { useEffect, useLayoutEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useFloatingPanel } from "../use-floating-panel";

/**
 * 顶栏「⋯」溢出菜单（issue #162）：portal 到 document.body + `position: fixed`。
 *
 * 为什么：菜单的触发按钮坐在横滑容器里 —— 窄屏（≤768px）的 `.topbar-flow{overflow-x:auto}`
 * 会让纵向也变成裁剪（CSS Overflow 3 §3.1：只写一轴 auto，另一轴的 visible 也算 auto）。
 * 菜单往下展开（`top: 100%+6px`）正好落在被裁剪的轴上，`z-index` 再高也逃不出来。
 * 之前 `ContextMenu.tsx` 已经用同一招（portal + fixed + 实测钳制）解决过右键菜单的裁剪，
 * 这里照抄：视口坐标直接取触发按钮的 `getBoundingClientRect()`，先渲染再实测菜单尺寸后钳制。
 *
 * 行为：点外面 / Esc 关闭（与 Dropdown/ContextMenu 一致）；窗口缩放或滚动时重算锚点
 * （移动端横滑顶栏时菜单跟着走，而不是飘在原地）。
 */
export function TopbarOverflowMenu({
	anchorRef,
	open,
	onClose,
	children,
}: {
	anchorRef: React.RefObject<HTMLButtonElement | null>;
	open: boolean;
	onClose: () => void;
	children: ReactNode;
}) {
	const {
		panelRef: menuRef,
		style,
		measure,
	} = useFloatingPanel({
		open,
		anchor: anchorRef,
		onClose,
	});

	// 打开后、内容变化后：绘制前实测一次（layout effect，用户看不到中间态）。
	useLayoutEffect(() => {
		if (open) measure();
	}, [open, children, measure]);

	if (!open) return null;
	return createPortal(
		<div ref={menuRef} className="plugin-topbar-menu portal" role="menu" style={style}>
			{children}
		</div>,
		document.body,
	);
}

/**
 * 手机端断点（与 styles.css 的 mobile ≤768px 同口径）：matchMedia 监听，跨断点实时切换。
 * jsdom / SSR（无 matchMedia）回落 false —— 宁可全画，也不清空顶栏。
 */
export function useIsMobileTopbar(): boolean {
	const [isMobile, setIsMobile] = useState(
		() =>
			typeof window !== "undefined" &&
			typeof window.matchMedia !== "undefined" &&
			window.matchMedia("(max-width: 768px)").matches,
	);
	useEffect(() => {
		if (typeof window === "undefined" || typeof window.matchMedia === "undefined") return;
		const mq = window.matchMedia("(max-width: 768px)");
		const onChange = (e: MediaQueryListEvent) => setIsMobile(e.matches);
		if (typeof mq.addEventListener === "function") mq.addEventListener("change", onChange);
		else mq.addListener(onChange);
		return () => {
			if (typeof mq.removeEventListener === "function") mq.removeEventListener("change", onChange);
			else mq.removeListener(onChange);
		};
	}, []);
	return isMobile;
}
