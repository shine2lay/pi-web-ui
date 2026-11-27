import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
	authorizeGithubMcpCall,
	GH_OWN_REPO_RULE,
	type GithubPolicyLoader,
} from "../../server/github-mcp-write-guard.js";
import { McpBridge } from "../../server/mcp-bridge.js";

// External canonical implementation; no duplicated ownership rules in this suite.
const canonicalUrl = "file:///home/shinelay/projects/agent-tools-ops-task-1130/lib/github-policy/index.mjs";
const canonical: GithubPolicyLoader = () => import(canonicalUrl);
const fixture = `
import { createInterface } from 'node:readline';
import { appendFileSync } from 'node:fs';
const tools = ['create_issue', 'list_issues', 'create_repository', 'unknown_mutation'];
createInterface({input: process.stdin}).on('line', line => {
 const msg = JSON.parse(line);
 let result;
 if (msg.method === 'initialize') result = {protocolVersion:'2025-03-26',capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}};
 if (msg.method === 'tools/list') result = {tools:tools.map(name=>({name,inputSchema:{type:'object'}}))};
 if (msg.method === 'tools/call') {
  appendFileSync(process.argv[1], JSON.stringify(msg.params) + '\\n');
  result = {content:[{type:'text',text:'dispatched'}]};
 }
 if (msg.id !== undefined) process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:msg.id,result})+'\\n');
});`;

async function withBridge(
	server: string,
	loader: GithubPolicyLoader,
	run: (bridge: McpBridge, calls: () => unknown[]) => Promise<void>,
) {
	const dir = mkdtempSync(join(tmpdir(), "github-policy-"));
	const log = join(dir, "calls.jsonl");
	const bridge = new McpBridge(dir, () => {}, {
		specOverride: [
			{ name: server, spec: { command: process.execPath, args: ["--input-type=module", "-e", fixture, log] } },
		],
		policyLoader: loader,
	});
	try {
		await bridge.load();
		expect(bridge.getTools()).toHaveLength(4);
		await run(bridge, () => {
			try {
				return readFileSync(log, "utf8")
					.trim()
					.split("\n")
					.filter(Boolean)
					.map((line) => JSON.parse(line));
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
				throw error;
			}
		});
	} finally {
		bridge.dispose();
		rmSync(dir, { recursive: true, force: true });
	}
}

function call(bridge: McpBridge, name: string, args: Record<string, unknown>) {
	return bridge
		.getTools()
		.find((tool) => tool.name === name)!
		.execute("fixture-call", args);
}

describe("parsed McpBridge GitHub dispatch", () => {
	it.each(["github", "github-read"])(
		"%s: canonical negative calls dispatch zero; own write and external read twins dispatch",
		async (server) => {
			await withBridge(server, canonical, async (bridge, calls) => {
				for (const [tool, args] of [
					["create_issue", { owner: "upstream", repo: "repo", title: "blocked" }],
					["create_issue", { owner: "shine2lay/../upstream", repo: "repo", title: "blocked" }],
					["create_issue", { repo: "repo", title: "unknown destination" }],
					["create_issue", { owner: "shine2lay", repo: "repo", title: "blocked", unexpected: true }],
					["unknown_mutation", { owner: "shine2lay", repo: "repo" }],
					["create_repository", { name: "unproven-account" }],
				] as Array<[string, Record<string, unknown>]>) {
					await expect(call(bridge, tool, args)).rejects.toThrow(GH_OWN_REPO_RULE);
					expect(calls()).toEqual([]);
				}
				await call(bridge, "create_issue", { owner: "Shine2Lay", repo: "repo", title: "allowed" });
				await call(bridge, "list_issues", { owner: "upstream", repo: "repo" });
				expect(calls()).toEqual([
					{ name: "create_issue", arguments: { owner: "Shine2Lay", repo: "repo", title: "allowed" } },
					{ name: "list_issues", arguments: { owner: "upstream", repo: "repo" } },
				]);
			});
		},
	);

	it.each(["github", "github-read"])("%s: missing policy blocks even reads with zero child calls", async (server) => {
		await withBridge(
			server,
			async () => {
				throw new Error("sensitive import detail");
			},
			async (bridge, calls) => {
				await expect(call(bridge, "list_issues", { owner: "upstream", repo: "repo" })).rejects.toThrow(
					`${GH_OWN_REPO_RULE}: GitHub MCP call refused`,
				);
				expect(calls()).toEqual([]);
			},
		);
	});

	it("passes the exact canonical invocation and resolver, awaiting authorization before dispatch", async () => {
		const policy = await canonical();
		let finish!: () => void;
		let entered!: () => void;
		const waiting = new Promise<void>((resolve) => {
			entered = resolve;
		});
		const gate = new Promise<void>((resolve) => {
			finish = resolve;
		});
		const authorize = vi.fn(async (request: Parameters<typeof policy.authorize>[0], resolver: object) => {
			entered();
			await gate;
			return policy.authorize(request, resolver);
		});
		await withBridge(
			"github",
			async () => ({ ...policy, authorize }),
			async (bridge, calls) => {
				const args = { owner: "shine2lay", repo: "repo", title: "allowed" };
				const pending = call(bridge, "create_issue", args);
				await waiting;
				args.owner = "upstream";
				expect(calls()).toEqual([]);
				expect(authorize).toHaveBeenCalledWith(
					{ kind: "mcp", tool: "create_issue", args: { owner: "shine2lay", repo: "repo", title: "allowed" } },
					policy.defaultReadOnlyResolver,
				);
				finish();
				await pending;
				expect(calls()).toEqual([
					{ name: "create_issue", arguments: { owner: "shine2lay", repo: "repo", title: "allowed" } },
				]);
			},
		);
	});

	it("non-GitHub connections do not load the policy", async () => {
		const loader = vi.fn(async () => {
			throw new Error("must not load");
		});
		await withBridge("other", loader, async (bridge, calls) => {
			await call(bridge, "unknown_mutation", { arbitrary: true });
			expect(calls()).toHaveLength(1);
			expect(loader).not.toHaveBeenCalled();
		});
	});

	it("fails closed on broken policy exports, invalid decisions, and resolver exceptions", async () => {
		const policy = await canonical();
		for (const loader of [
			async () => ({}),
			async () => ({ ...policy, authorize: async () => ({ allow: "true" }) }),
			async () => ({
				...policy,
				authorize: async () => {
					throw new Error("secret");
				},
			}),
		]) {
			await expect(
				authorizeGithubMcpCall(
					"github",
					"list_issues",
					{ owner: "upstream", repo: "repo" },
					loader as GithubPolicyLoader,
				),
			).rejects.toThrow(`${GH_OWN_REPO_RULE}: GitHub MCP call refused`);
		}
	});
});
