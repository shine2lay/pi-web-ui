import type { McpClient, McpToolDefinition } from "./mcp-bridge.js";
import type { PluginAgentTool } from "./plugins.js";

export const GH_OWN_REPO_RULE = "GH-OWN-REPO-ONLY";
const POLICY_MODULE = "file:///home/shinelay/projects/agent-tools/lib/github-policy/index.mjs";
const REFUSAL = `${GH_OWN_REPO_RULE}: GitHub MCP call refused`;

/** Canonical policy owns classification, ownership and resolver semantics. */
export interface GithubPolicyModule {
	authorizeHttpRuntime(
		invocation: { kind: "mcp"; tool: string; args: Record<string, unknown> },
		resolver: object,
	): Promise<{ allow: true } | { allow: false; rule: string; reason: string }>;
	defaultReadOnlyResolver: object;
}

/** Constructor injection is for callers/tests, never configuration or an environment override. */
export type GithubPolicyLoader = () => Promise<GithubPolicyModule>;
const loadInstalledPolicy: GithubPolicyLoader = () => import(POLICY_MODULE);

export async function authorizeGithubMcpCall(
	server: string,
	tool: string,
	args: Record<string, unknown>,
	loadPolicy: GithubPolicyLoader = loadInstalledPolicy,
): Promise<void> {
	if (server !== "github" && server !== "github-read") return;
	try {
		const policy = await loadPolicy();
		if (
			typeof policy.authorizeHttpRuntime !== "function" ||
			!policy.defaultReadOnlyResolver ||
			typeof policy.defaultReadOnlyResolver !== "object"
		)
			throw new Error(REFUSAL);
		const decision = await policy.authorizeHttpRuntime({ kind: "mcp", tool, args }, policy.defaultReadOnlyResolver);
		if (decision?.allow === true) return;
	} catch {
		// Missing/broken policy and resolver errors fail closed without exposing their contents.
	}
	throw new Error(REFUSAL);
}

/** Keep the original MCP name until McpClient.call authorizes the parsed invocation. */
export function adaptMcpTool(serverName: string, mcpTool: McpToolDefinition, client: McpClient): PluginAgentTool {
	return {
		name: (mcpTool.name || "").replace(/[^A-Za-z0-9_-]/g, "_") || "mcp_tool",
		label: `${serverName} · ${mcpTool.name}`,
		description: mcpTool.description ?? `Tool ${mcpTool.name} provided by MCP server "${serverName}"`,
		parameters: mcpTool.inputSchema ?? {},
		execute: async (_toolCallId: string, params: Record<string, unknown>, _signal?: AbortSignal) =>
			client.call(mcpTool.name, params ?? {}),
	};
}
