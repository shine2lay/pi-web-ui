import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	checkGithubMcpCall,
	GH_OWN_REPO_RULE,
	installGithubMcpWriteGuard,
} from "../../server/github-mcp-write-guard.js";
import { McpBridge } from "../../server/mcp-bridge.js";

describe("github-mcp-write-guard (GH-OWN-REPO-ONLY)", () => {
	it("blocks mutating github MCP calls targeting non-shine2lay across direct, namespace, gateway, and mcpScript forms", () => {
		const blockedCases: Array<[string, Record<string, unknown>]> = [
			[
				"github_issue_write",
				{ method: "create", owner: "ranxianglei", repo: "billion-context-pi", title: "accidental" },
			],
			[
				"github_add_issue_comment",
				{ owner: "ranxianglei", repo: "billion-context-pi", issue_number: 699, body: "hi" },
			],
			[
				"github_create_pull_request",
				{ owner: "xing-shuyin", repo: "pi-web-ui", title: "pr", head: "mine", base: "main" },
			],
			[
				"github_push_files",
				{ owner: "hjanuschka", repo: "pi-multi-pass", branch: "main", files: [], message: "x" },
			],
			["github_fork_repository", { owner: "ranxianglei", repo: "billion-context-pi" }],
			["github_create_repository", { name: "x", organization: "other-org" }],
			["github_create_gist", { filename: "a.txt", content: "secret" }],
			[
				"github_issue_write",
				{ method: "create", owner: "shine2lay/../../ranxianglei", repo: "billion-context-pi", title: "bad" },
			],
			[
				"github_issue_write",
				{
					method: "create",
					owner: "shine2lay",
					repo: "billion-context-pi",
					parent_owner: "ranxianglei",
					title: "cross-parent",
				},
			],
			[
				"mcp__github",
				{
					tool: "issue_write",
					args: { method: "create", owner: "ranxianglei", repo: "billion-context-pi", title: "via-ns" },
				},
			],
			[
				"mcp",
				{
					tool: "github_issue_write",
					args: { method: "create", owner: "ranxianglei", repo: "billion-context-pi", title: "via-gateway" },
				},
			],
			[
				"mcp",
				{
					server: "github",
					tool: "issue_write",
					args: JSON.stringify({
						method: "create",
						owner: "ranxianglei",
						repo: "billion-context-pi",
						title: "json-string-args",
					}),
				},
			],
			["mcp", { server: "github", tool: "issue_write", args: "{malformed-json" }],
			[
				"mcpScript",
				{
					code: 'await tools.call("github_issue_write", { method: "create", owner: "ranxianglei", repo: "billion-context-pi", title: "script" });',
				},
			],
			[
				"mcpScript",
				{
					code: 'await tools.github_add_issue_comment({ owner: "ranxianglei", repo: "billion-context-pi", issue_number: 699, body: "script" });',
				},
			],
		];

		for (const [toolName, input] of blockedCases) {
			const verdict = checkGithubMcpCall(toolName, input);
			expect(verdict.block, `expected block for ${toolName} ${JSON.stringify(input)}`).toBe(true);
			expect(verdict.reason).toContain(GH_OWN_REPO_RULE);
		}
	});

	it("allows read-only github/github-read tools on any repo, metadata mcp calls, and mutating calls on shine2lay/*", () => {
		const allowedCases: Array<[string, Record<string, unknown>]> = [
			["github_issue_read", { owner: "ranxianglei", repo: "billion-context-pi", issue_number: 699 }],
			["github_list_issues", { owner: "ranxianglei", repo: "billion-context-pi" }],
			["github_pull_request_read", { owner: "xing-shuyin", repo: "pi-web-ui", pullNumber: 1 }],
			["github_search_code", { q: "repo:ranxianglei/billion-context-pi compress" }],
			["github_actions_get", { owner: "ranxianglei", repo: "billion-context-pi" }],
			["github_read_issue_read", { owner: "ranxianglei", repo: "billion-context-pi", issue_number: 699 }],
			["mcp__github_read", { tool: "issue_read", args: { owner: "ranxianglei", repo: "billion-context-pi" } }],
			["mcp", { search: "issue_write", server: "github" }],
			["mcp", { describe: "github_issue_write" }],
			["mcp", { server: "github" }],
			["mcp", {}],
			[
				"github_issue_write",
				{ method: "create", owner: "shine2lay", repo: "billion-context-pi", title: "local issue" },
			],
			["github_create_repository", { name: "new-private-repo", private: true }],
			[
				"mcp__github",
				{
					tool: "issue_write",
					args: { method: "create", owner: "Shine2Lay", repo: "pi-worktree", title: "case-insensitive" },
				},
			],
			[
				"mcp",
				{
					tool: "github_create_pull_request",
					args: { owner: "shine2lay", repo: "pi-web-ui", title: "ok", head: "feat", base: "mine" },
				},
			],
			[
				"mcpScript",
				{
					code: 'const r = await tools.call("github_list_issues", { owner: "ranxianglei", repo: "billion-context-pi" }); emit(r);',
				},
			],
			[
				"mcpScript",
				{
					code: 'await tools.call("github_issue_write", { method: "create", owner: "shine2lay", repo: "pi-worktree", title: "ok" });',
				},
			],
			["mcp__temper", { tool: "start_run", args: { workflow: "x" } }],
		];

		for (const [toolName, input] of allowedCases) {
			const verdict = checkGithubMcpCall(toolName, input);
			expect(verdict, `expected allow for ${toolName} ${JSON.stringify(input)}`).toEqual({ block: false });
		}
	});

	it("installGithubMcpWriteGuard intercepts session.agent.beforeToolCall before any extension tool executes", async () => {
		let delegatedCalls = 0;
		const session = {
			agent: {
				beforeToolCall: async () => {
					delegatedCalls += 1;
					return undefined;
				},
			},
		};
		installGithubMcpWriteGuard(session);
		// Idempotent second install
		installGithubMcpWriteGuard(session);

		const blocked = await session.agent.beforeToolCall!({
			toolCall: { id: "tc-1", name: "github_issue_write" },
			args: { method: "create", owner: "ranxianglei", repo: "billion-context-pi", title: "blocked" },
		} as never);
		expect(blocked?.block).toBe(true);
		expect(blocked?.reason).toContain(GH_OWN_REPO_RULE);
		expect(delegatedCalls).toBe(0);

		const allowed = await session.agent.beforeToolCall!({
			toolCall: { id: "tc-2", name: "github_issue_read" },
			args: { owner: "ranxianglei", repo: "billion-context-pi", issue_number: 699 },
		} as never);
		expect(allowed).toBeUndefined();
		expect(delegatedCalls).toBe(1);
	});

	it("McpBridge refuses non-shine2lay github server writes before sending tools/call to child process", async () => {
		const dir = mkdtempSync(join(tmpdir(), "mcp-gh-fence-"));
		try {
			const serverScript = join(dir, "fake-github-mcp.mjs");
			writeFileSync(
				serverScript,
				[
					'import { createInterface } from "node:readline";',
					"const rl = createInterface({ input: process.stdin });",
					'rl.on("line", (line) => {',
					"  const msg = JSON.parse(line);",
					'  if (msg.method === "initialize") {',
					'    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "github", version: "1.0" } } }) + "\\n");',
					'  } else if (msg.method === "tools/list") {',
					'    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { tools: [',
					'      { name: "issue_write", description: "Create/update issue", inputSchema: { type: "object" } },',
					'      { name: "issue_read", description: "Read issue", inputSchema: { type: "object" } }',
					'    ] } }) + "\\n");',
					'  } else if (msg.method === "tools/call") {',
					'    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: "CALLED:" + msg.params.name + ":" + msg.params.arguments.owner }] } }) + "\\n");',
					"  }",
					"});",
				].join("\n"),
			);

			const bridge = new McpBridge(dir, () => {}, {
				specOverride: [{ name: "github", spec: { command: process.execPath, args: [serverScript] } }],
			});
			await bridge.load();
			const tools = bridge.getTools();
			const writeTool = tools.find((t) => t.name === "issue_write")!;
			const readTool = tools.find((t) => t.name === "issue_read")!;

			const readRes = (await readTool.execute("c1", {
				owner: "ranxianglei",
				repo: "billion-context-pi",
				issue_number: 699,
			})) as { content: Array<{ text: string }> };
			expect(readRes.content[0]?.text).toBe("CALLED:issue_read:ranxianglei");

			await expect(
				writeTool.execute("c2", {
					method: "create",
					owner: "ranxianglei",
					repo: "billion-context-pi",
					title: "no",
				}),
			).rejects.toThrow(GH_OWN_REPO_RULE);

			const ownWriteRes = (await writeTool.execute("c3", {
				method: "create",
				owner: "shine2lay",
				repo: "billion-context-pi",
				title: "ok",
			})) as { content: Array<{ text: string }> };
			expect(ownWriteRes.content[0]?.text).toBe("CALLED:issue_write:shine2lay");

			bridge.dispose();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
