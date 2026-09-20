/**
 * 提问导航条（qn-rail）的滑动窗口——纯函数部分（零 React 依赖，可单测）。
 *
 * 长会话里问题数轻易过 40，把每个问题都画成一个刻度会把导航条挤成一团
 * （行距被压到 4px，逐刻度的文字气泡也被迫换成列表面板）。这里改为只显示
 * 一个固定大小的窗口：以当前阅读中的问题为中心，向上（更早）多留一格；
 * 位于会话末尾时就是最后 SIZE 个。窗口外的问题在导航条两端折叠成「+N」计数，
 * 点击跳到最近的一个被折叠问题，窗口随之重新居中。
 *
 * 刻度的编号始终是全局序号（第 35 问永远显示「35.」），与消息上的问题标签一致。
 */

/** 导航条同时显示的刻度上限。 */
export const QN_WINDOW = 10;

export interface QnWindow {
	/** 首个可见问题下标（含）。 */
	start: number;
	/** 末个可见问题下标（不含）。 */
	end: number;
}

/**
 * 计算可见问题区间 [start, end)。
 *
 * @param total  问题总数
 * @param active 当前阅读中的问题下标；-1（尚未定位）视为位于末尾——初始加载时
 *               列表钉在底部，这样首帧就是最终形态，不会先画开头再跳到结尾
 * @param size   窗口大小（≤0 视为不限）
 */
export function planQnWindow(total: number, active: number, size = QN_WINDOW): QnWindow {
	if (size <= 0 || total <= size) return { start: 0, end: Math.max(0, total) };
	if (active < 0 || active >= total) return { start: total - size, end: total };
	// 居中，奇数余量偏向更早一侧：size=10 → 上 5 / 当前 / 下 4
	const above = Math.ceil((size - 1) / 2);
	let start = Math.max(0, active - above);
	let end = start + size;
	if (end > total) {
		end = total;
		start = end - size;
	}
	return { start, end };
}
