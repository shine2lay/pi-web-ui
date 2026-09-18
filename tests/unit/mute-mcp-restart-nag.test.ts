/**
 * no-mcp-restart-nag：上游 pi-mcp-adapter 每次启动都可能重弹
 * 「MCP: direct tools for … will be available after restart」。
 *
 * 只屏蔽这一条 info。真正要紧的 warning / error（连不上、工具被跳过、需要授权）
 * 必须照常弹 —— 这几条是本测试的主要断言。
 */
import { describe, expect, it } from "vitest";
import { WebUIContext } from "../../server/webui-context.js";
import type { ServerMessage } from "../../server/protocol.js";

function collect(): { ctx: WebUIContext; seen: ServerMessage[] } {
	const seen: ServerMessage[] = [];
	const ctx = new WebUIContext((msg) => seen.push(msg));
	return { ctx, seen };
}

const notices = (seen: ServerMessage[]) => seen.filter((m) => m.type === "notice");

describe("notify: 屏蔽 MCP 重启提示", () => {
	it("丢掉 direct-tools 重启提示（单个 server）", () => {
		const { ctx, seen } = collect();
		ctx.notify("MCP: direct tools for github will be available after restart", "info");
		expect(notices(seen)).toHaveLength(0);
	});

	it("丢掉 direct-tools 重启提示（多个 server，逗号分隔）", () => {
		const { ctx, seen } = collect();
		ctx.notify("MCP: direct tools for github, github-read will be available after restart", "info");
		expect(notices(seen)).toHaveLength(0);
	});

	it("level 省略时按 info 处理，同样丢掉", () => {
		const { ctx, seen } = collect();
		ctx.notify("MCP: direct tools for github, github-read will be available after restart");
		expect(notices(seen)).toHaveLength(0);
	});

	it("warning / error 一律照常弹 —— 连不上、工具被跳过不能被静音", () => {
		const { ctx, seen } = collect();
		ctx.notify("MCP: Failed to connect to github: 500", "error");
		ctx.notify("MCP: github - 3 tools skipped", "warning");
		expect(notices(seen)).toHaveLength(2);
		expect(seen.map((m) => (m as { level: string }).level).sort()).toEqual(["error", "warning"]);
	});

	it("其他 MCP info 不受影响（只掐这一条，不是把 MCP 整个静音）", () => {
		const { ctx, seen } = collect();
		ctx.notify("MCP: 3 servers connected (158 tools)", "info");
		expect(notices(seen)).toHaveLength(1);
	});

	it("只匹配整条、不误伤把这句话当正文的消息", () => {
		const { ctx, seen } = collect();
		ctx.notify('用户问：为什么一直提示 "MCP: direct tools for github will be available after restart"？', "info");
		expect(notices(seen)).toHaveLength(1);
	});
});
