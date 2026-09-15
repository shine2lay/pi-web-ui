/**
 * server-owned-chats × 上游 v0.94 的手动过户（take_over_conversation → takeOverConversation）。
 *
 * 上游口径：一条对话只属于一个客户端，过户 = 把 runtime 从 owner 摘下来（detach）再塞进
 * 目标（insert）。server-owned-chats 之后对话表进程共享（ClientSession.sharedConvs）：
 * 目标手里本来就有这条对话，detach 却会把它从**所有**窗口摘掉再塞回来 —— 别的窗口当场
 * 丢失正在看的对话，源窗口还会收到「已过户到另一处」的假通知。
 * 所以：目标已持有这条对话 → 一律退化为普通切换。入口本来就不会出现（listExternalRunning
 * 恒为空），这是防御；上游单 owner 口径（目标不持有）保持原样。
 */
import { describe, expect, it } from "vitest";
import { AgentService } from "../../server/agent-service.js";

const takeOver = AgentService.prototype.takeOverConversation as unknown as (
	this: unknown,
	targetId: string,
	ownerId: string,
	convId: string,
) => Promise<void>;

interface Brief {
	id: string;
	title: string;
	cwd: string;
	parentId?: string;
	isSubagent: boolean;
}

function brief(id: string, extra: Partial<Brief> = {}): Brief {
	return { id, title: `title-${id}`, cwd: "/p", isSubagent: false, ...extra };
}

function fakeClient(briefs: Brief[]) {
	const calls = {
		switched: [] as string[],
		detached: [] as string[][],
		inserted: 0,
		notices: [] as string[],
	};
	const cs = {
		calls,
		sendNotice: (n: { text: string }) => {
			calls.notices.push(n.text);
		},
		switchConversation: async (id: string) => {
			calls.switched.push(id);
		},
		takeoverBriefs: () => briefs,
		detachTakeoverConversations: async (ids: string[]) => {
			calls.detached.push(ids);
			return { ok: true as const, payload: { ids } };
		},
		insertTakeoverConvs: () => {
			calls.inserted++;
			return "moved-id";
		},
		refreshExternalRunning: () => {},
	};
	return cs;
}

function service(entries: [string, ReturnType<typeof fakeClient>][]) {
	return { clients: new Map(entries) };
}

describe("takeOverConversation（共享对话表）", () => {
	it("目标已持有这条对话（共享表）：只切过去，不 detach、不给源窗口发假通知", async () => {
		const shared = [brief("c1")];
		const owner = fakeClient(shared);
		const target = fakeClient(shared);
		await takeOver.call(
			service([
				["owner", owner],
				["target", target],
			]),
			"target",
			"owner",
			"c1",
		);
		expect(target.calls.switched).toEqual(["c1"]);
		expect(owner.calls.detached).toEqual([]);
		expect(target.calls.inserted).toBe(0);
		expect(owner.calls.notices).toEqual([]);
		expect(target.calls.notices).toEqual([]);
	});

	it("owner 是插件/调度伪客户端、目标已持有：也是切过去，而不是报「不支持过户」", async () => {
		const shared = [brief("c1")];
		const owner = fakeClient(shared);
		const target = fakeClient(shared);
		await takeOver.call(
			service([
				["scheduler:job-1", owner],
				["target", target],
			]),
			"target",
			"scheduler:job-1",
			"c1",
		);
		expect(target.calls.switched).toEqual(["c1"]);
		expect(target.calls.notices).toEqual([]);
		expect(owner.calls.detached).toEqual([]);
	});

	it("上游单 owner 口径（目标不持有）保持原样：detach → insert → 切到新 id", async () => {
		const owner = fakeClient([brief("c1")]);
		const target = fakeClient([brief("mine")]);
		await takeOver.call(
			service([
				["owner", owner],
				["target", target],
			]),
			"target",
			"owner",
			"c1",
		);
		expect(owner.calls.detached).toEqual([["c1"]]);
		expect(target.calls.inserted).toBe(1);
		expect(target.calls.switched).toEqual(["moved-id"]);
	});

	it("自己的对话：照旧退化为普通切换", async () => {
		const me = fakeClient([brief("c1")]);
		await takeOver.call(service([["me", me]]), "me", "me", "c1");
		expect(me.calls.switched).toEqual(["c1"]);
		expect(me.calls.detached).toEqual([]);
	});
});
