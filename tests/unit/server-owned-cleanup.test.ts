import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DshAgentService, DshClientSession } from "../../server/dsh/dsh-agent-service.js";

// Deletion guard, not a compatibility shim. Keep obsolete names out of production source.
const removed = new Set([
	"resumeSkipped",
	"takeOverConversation",
	"peekElsewhereQuestion",
	"findAdoptableOrphan",
	"pickAdoptableOrphan",
	"take_over_conversation",
	"peek_elsewhere_question",
	"elsewhere_question",
	"takeoverBriefs",
	"detachTakeoverConversations",
	"insertTakeoverConvs",
	"hasAdoptableContent",
	"noteAdopted",
	"remoteQuestion",
	"remote_question",
]);
function obsoleteTokens(source: string): string[] {
	return [...new Set(source.match(/\b[A-Za-z_]\w*\b/g) ?? [])].filter((token) => removed.has(token));
}
const source = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");

describe("server-owned-chats dead ownership cleanup", () => {
	it("detects a planted old route and method (negative control)", () => {
		expect(obsoleteTokens('case "take_over_conversation": service.takeOverConversation();')).toEqual([
			"take_over_conversation",
			"takeOverConversation",
		]);
		expect(obsoleteTokens("const live = true;")).toEqual([]);
	});
	it.each([
		"server/agent-service.ts",
		"server/index.ts",
		"server/protocol.ts",
		"web/src/components/LeftPanel.tsx",
		"web/src/use-chat.ts",
		"web/src/App.tsx",
	])("has no obsolete ownership tokens in %s", (path) => {
		expect(obsoleteTokens(source(path))).toEqual([]);
	});
	it("pi no longer builds an external list, but keeps delete ownership and scheduler release", () => {
		const pi = source("server/agent-service.ts");
		expect(pi).not.toContain("listExternalRunning");
		expect(pi).toContain("findSessionOwner(");
		expect(pi).toContain("releaseSchedulerClient(taskId: string)");
	});
	it("DSH still lists other clients' streaming chats as read-only rows", () => {
		const own = { title: "Own", cwd: "/own", isStreaming: true };
		const remote = { title: "Remote", cwd: "/other", isStreaming: true };
		const rows = DshClientSession.prototype.streamingSummariesAll.call({
			convs: new Map([
				["running", remote],
				["idle", { title: "Idle", cwd: "/other", isStreaming: false }],
			]),
		} as unknown as DshClientSession);
		expect(rows).toEqual([remote]);
		const clients = new Map([
			["self", { streamingSummariesAll: () => [own] }],
			["other", { streamingSummariesAll: () => rows }],
		]);
		expect(
			DshAgentService.prototype.listExternalRunning.call({ clients } as unknown as DshAgentService, "self"),
		).toEqual([remote]);
		expect(source("server/dsh/dsh-agent-service.ts")).toContain(
			"cs.listExternalRunning = () => this.listExternalRunning(clientId)",
		);
		expect(source("web/src/components/LeftPanel.tsx")).toContain(
			'className="session-item elsewhere-item elsewhere-static"',
		);
	});
});
