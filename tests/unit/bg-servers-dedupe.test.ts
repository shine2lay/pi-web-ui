import { describe, expect, it } from "vitest";

import { BgServerTracker } from "../../server/bg-servers.js";
import type { BgServer, ServerMessage } from "../../server/protocol.js";

/**
 * 回归：插件后台任务的重复推送必须被吃掉。
 *
 * 背景（2026-09-22 实测）：temper 插件每 10s 轮询一次，对每条盯梢的运行都无条件调一次
 * task.update()，20 条运行 ≈ 120 次/分；每次 update() 都会让宿主把**整份** bg_servers
 * 列表推给每个客户端（实测 ~16KB/次，≈1.6MB/分钟的纯噪音），而内容常常一字未变。
 * 慢链路（手机/流量）上这足以把 ws.bufferedAmount 顶到背压阈值之上，于是快照被丢弃、
 * 消息列表停更——表现就是「不刷新就看不到更新」。
 */
function makeBg(tasks: () => BgServer[]) {
	const sent: ServerMessage[] = [];
	const bg = new BgServerTracker({
		emit: (m) => sent.push(m),
		flushSnapshot: () => {},
		isDisposed: () => false,
		pluginTasks: tasks,
	});
	return { bg, sent };
}

describe("BgServers.push dedupe", () => {
	it("skipIfUnchanged 时，内容没变就不推第二次", () => {
		const task: BgServer = { taskId: "t1", label: "temper", status: "running", since: 1 } as BgServer;
		const { bg, sent } = makeBg(() => [task]);

		bg.push({ skipIfUnchanged: true });
		bg.push({ skipIfUnchanged: true });
		bg.push({ skipIfUnchanged: true });

		expect(sent).toHaveLength(1);
	});

	it("状态真的变了就必须推", () => {
		let status = "running";
		const { bg, sent } = makeBg(() => [{ taskId: "t1", label: "temper", status, since: 1 } as BgServer]);

		bg.push({ skipIfUnchanged: true });
		status = "waiting gate";
		bg.push({ skipIfUnchanged: true });

		expect(sent).toHaveLength(2);
		expect((sent[1] as { servers: BgServer[] }).servers[0].status).toBe("waiting gate");
	});

	it("默认（无 skipIfUnchanged）永远推——新 socket 接入必须拿到一份", () => {
		const { bg, sent } = makeBg(() => [{ taskId: "t1", label: "temper", status: "running", since: 1 } as BgServer]);

		bg.push({ skipIfUnchanged: true });
		bg.push(); // 新 socket attach
		bg.push();

		expect(sent).toHaveLength(3);
	});

	it("无条件推送会刷新去重基线，避免拿陈旧基线比对", () => {
		let status = "running";
		const { bg, sent } = makeBg(() => [{ taskId: "t1", label: "temper", status, since: 1 } as BgServer]);

		bg.push({ skipIfUnchanged: true }); // 基线 = running
		status = "done";
		bg.push(); // 无条件推 done —— 基线必须更新成 done
		bg.push({ skipIfUnchanged: true }); // 还是 done：不该再推

		expect(sent).toHaveLength(2);
	});
});
