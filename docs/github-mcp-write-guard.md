# GitHub MCP write protection (Ops 1130)

## Hypothesis and scope

Problem: the frozen tests assumed an outer tool hook could classify script source. Actual dynamic calls are resolved inside pi-mcp-adapter, and direct executors have a separate path. An outer-script regex cannot prove destination ownership.

Change: authorize parsed McpClient calls with the single agent-tools policy before restart or tools/call dispatch. The configured github-mcp transport separately authorizes the live extension's actual JSON-RPC requests. Expected result: denied bridge calls produce zero child tools/call requests, while an allowed own-repository write and external read each produce exactly one. Any forbidden dispatch or rejected positive twin disproves this hypothesis.

## Server contract

`server/github-mcp-write-guard.ts` exports `authorizeGithubMcpCall(server, tool, args, loadPolicy?)`. For connections named exactly `github` or `github-read`, it imports the fixed module `file:///home/shinelay/projects/agent-tools/lib/github-policy/index.mjs` and awaits:

`authorize({kind: 'mcp', tool, args}, defaultReadOnlyResolver)`

Only `{allow: true}` permits dispatch. Import failure, invalid exports, policy denial or exceptions refuse with the fixed message `GH-OWN-REPO-ONLY: GitHub MCP call refused`. No exception details or arguments are included. There is no environment/configuration switch to disable the policy. Constructor-level module loading injection permits isolated tests using the canonical worktree implementation, not another policy.

`McpClient.call(name, args, timeoutMs = 60000)` snapshots arguments before awaiting authorization and sends that checked snapshot. `McpBridge` passes its optional constructor loader to every client, including reload clients. `adaptMcpTool` preserves the original remote tool name and calls this boundary. Initialization and discovery may already have run, but a denied invocation sends zero tools/call requests and does not trigger a restart.

The policy currently supports a conservative enumerated MCP schema. Unknown tools/keys deny. `create_repository` without proven authenticated identity denies; the default resolver supplies no same-connection identity proof. Opaque-node and GraphQL operations deny rather than guessing. External reads are allowed only for supported schemas. This trades availability for fail-closed safety.

## Actual live extension routes: transport protection, NOT this server hook

The inspected installation is `/home/shinelay/.pi/agent/npm/node_modules/pi-mcp-adapter/`:

| Surface                           | Actual execution route                                                                                                                                                    |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Direct tool                       | `direct-tools.ts:createDirectToolExecutor` -> resolved `spec.originalName` / `normalizedParams` -> task-session or ordinary client call                                   |
| Gateway `mcp({tool,args,server})` | `index.ts` -> `proxy-modes.ts:executeCall` -> resolved `toolMeta.originalName` / `normalizedArgs` -> task-session or ordinary client call                                 |
| Dynamic script inner call         | `mcp-code.ts:runMcpScript` -> local `callTool(path,args,server)` -> `executeCall`; computed names and arguments are checked at transport, not by parsing the outer script |
| Runtime call event                | `index.ts` runtime tool-call event -> `executeCall`                                                                                                                       |
| Host-managed direct tool          | `host-managed.ts` local `executeTool` -> `connection.client.callTool`                                                                                                     |
| Embedded MCP UI                   | `ui-server.ts` local `callTool(conn)` -> task-session or ordinary client call                                                                                             |

The normal calls use `elicitation-handler.ts:callToolPausingForElicitation`; task-backed calls use `mcp-tasks.ts:callToolViaTaskSession`. Neither is changed here. No npm adapter, agent-service or outer session hook is changed.

All these routes are protected by the companion transport change **only when the actual connection uses the fenced `~/.local/bin/github-mcp` launcher**. At research time that launcher inherited stdin and only filtered stdout list-cache TTLs: it was not yet an authorization fence. Transport implementation is owned by worker `conv-270c3c95`; this commit neither installs it nor claims it is deployed.

## Transport responsibilities and unsupported channels

Complete JSON parsing, escaped names/arguments, batches, notifications, method allowlisting, malformed messages and zero forwarding on denial belong to the companion transport tests. Bridge tests do not claim coverage of those raw-wire cases. The transport must check every call before forwarding; the full security ruling in `/home/shinelay/ops-checks/block-upstream-gh-1130/security-ruling.md` remains binding.

Not a same-UID isolation boundary: raw HTTP, gh.real, direct server binary execution, alternate/unfenced MCP connections, renamed server connections that avoid both protections, browser writes, credential/configuration replacement and other direct credential use remain unsupported. A protected server name is a configured scope, not proof that arbitrary endpoints are GitHub.com. The companion transport must constrain its actual destination; the bridge adapter alone cannot prove a custom server executable's network behavior.

## Verification and delivery

Follow-up hypothesis (2026-11-27): canonical review removed obsolete issue tool names, so the original positive fixtures no longer represent the configured MCP server. Change only the fixtures to actual `issue_write` create/update, `create_pull_request`, and `issue_read` get shapes. Expect external writes to dispatch zero and own create/update/PR plus external read to dispatch once each on both protected connections; any mismatch disproves the update. The server authorization API and implementation are unchanged. Follow-up result: HIT; sealed focused tests passed 7/7 with the updated canonical schemas and sealed full typecheck passed all five projects.

`tests/unit/github-mcp-write-guard.test.ts` uses the real canonical policy from `/home/shinelay/projects/agent-tools/lib/github-policy/index.mjs`, injected explicitly, with a local synthetic stdio child and a request ledger. It exercises both protected connection names, external/unknown/ambiguous mutation negatives, own-write and external-read positives, missing policy, invalid policy decisions, resolver exceptions, async ordering and caller-argument mutation during authorization. No external mutation or model request is made.

Verification (2026-11-27): `bash scripts/sealed.sh npx vitest run tests/unit/github-mcp-write-guard.test.ts` passed all 7 tests; `bash scripts/sealed.sh npm run typecheck` passed all five TypeScript projects. `wt check` passed including WT-SIZE-500, WT-NO-FIXTURE-BRANCH, types/lint and affected tests (dead-path check skipped by the standard checker). Hypothesis: HIT for the parsed bridge boundary; transport/deployment protection remains separate and is not proved by these results. The canonical installed module intentionally remains absent until the owning installation task runs: default GitHub bridge calls fail closed meanwhile.

The existing oversized bridge was reduced by extracting its tool adapter into the small guard module; no unrelated lifecycle rewrite was attempted. Source-only delivery: no install, deployment or landing.
