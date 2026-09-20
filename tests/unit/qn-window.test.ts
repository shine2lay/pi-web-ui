import { describe, expect, it } from "vitest";
import { planQnWindow, QN_WINDOW } from "../../web/src/qn-window.js";

describe("planQnWindow", () => {
	it("问题数不超过窗口时全部可见", () => {
		expect(planQnWindow(0, -1)).toEqual({ start: 0, end: 0 });
		expect(planQnWindow(7, 3)).toEqual({ start: 0, end: 7 });
		expect(planQnWindow(QN_WINDOW, QN_WINDOW - 1)).toEqual({ start: 0, end: QN_WINDOW });
	});

	it("位于末尾（或尚未定位 -1）时显示最后 SIZE 个", () => {
		expect(planQnWindow(40, 39)).toEqual({ start: 30, end: 40 });
		expect(planQnWindow(40, -1)).toEqual({ start: 30, end: 40 });
		// 越界的 active 同样按末尾处理，绝不产生空窗口
		expect(planQnWindow(40, 40)).toEqual({ start: 30, end: 40 });
	});

	it("居中：size=10 时当前问题上方 5 个、下方 4 个", () => {
		expect(planQnWindow(40, 21)).toEqual({ start: 16, end: 26 });
		// 奇数窗口严格居中
		expect(planQnWindow(40, 21, 9)).toEqual({ start: 17, end: 26 });
	});

	it("靠近开头 / 结尾时贴边而不是缩窗", () => {
		expect(planQnWindow(40, 0)).toEqual({ start: 0, end: 10 });
		expect(planQnWindow(40, 3)).toEqual({ start: 0, end: 10 });
		expect(planQnWindow(40, 36)).toEqual({ start: 30, end: 40 });
	});

	it("total > size 时窗口宽度恒等于 size", () => {
		for (let active = -1; active <= 60; active++) {
			const w = planQnWindow(60, active);
			expect(w.end - w.start).toBe(QN_WINDOW);
			expect(w.start).toBeGreaterThanOrEqual(0);
			expect(w.end).toBeLessThanOrEqual(60);
			// 当前问题必在窗口内（-1 / 越界除外）
			if (active >= 0 && active < 60) {
				expect(active).toBeGreaterThanOrEqual(w.start);
				expect(active).toBeLessThan(w.end);
			}
		}
	});

	it("向上滚动（active 递减）时窗口单步下滑，两端各换一个刻度", () => {
		const a = planQnWindow(40, 25);
		const b = planQnWindow(40, 24);
		expect(a).toEqual({ start: 20, end: 30 });
		expect(b).toEqual({ start: 19, end: 29 });
	});

	it("size<=0 视为不限", () => {
		expect(planQnWindow(40, 5, 0)).toEqual({ start: 0, end: 40 });
	});
});
