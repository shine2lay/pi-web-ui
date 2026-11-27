# Bridge runtime redirect restriction

Hypothesis before implementation: McpClient.call currently reaches authorizeGithubMcpCall, whose adapter invokes ownership classification rather than HTTP runtime authorization. Consequently an ordinary owned mutation can reach a native redirect-capable MCP server even though the configured transport denies it.

Change: require the canonical authorizeHttpRuntime export at the actual bridge execution boundary. Missing export fails closed; do not fall back to ownership-only authorize. No duplicated schemas, consumer override or transport-only assumption.

Expected measurement: real McpBridge with a local recording stdio child dispatches zero owned/external mutations for both github and github-read; exact external reads still dispatch. First run the owned-write rejection assertions against the existing adapter to establish RED, then change the adapter and run the completed suite and normal gates. No network or model traffic.

Dependency: agent-tools redirect policy commit 7509c30 must land before this bridge change deploys. The bridge must refuse even reads if that required runtime export is missing. Owned-write compatibility is deliberately restricted until consumers guarantee redirect safety. Git/wt and credential helper behavior are unchanged.

## Current proof status

Pre-deploy installed bridge status: FAIL (until parent deploys this change): ordinary owned-target redirects are IN SCOPE. The existing bridge invokes ownership-only authorization, and failing-first tests observed an owned mutation reaching the local native consumer on both github and github-read. Configured transport denial alone does not close this alternate supported execution route. No live redirect or external request was attempted.

Owned HTTP writes are UNSUPPORTED pending verified consumer redirect constraints; this is a deliberate compatibility restriction, never a claimed passing owned-write twin.

RED: sealed focused run of the owned/external mutation assertions failed 2/2 against the original adapter, receiving the child's dispatched result instead of rejection. The implementation now requires the runtime export. Sealed typecheck passed all five TypeScript projects. Final GREEN: after the parent installed canonical agent-tools master 5d63da8 (land 433-246f19), the sealed real-bridge suite passed 9/9. Both protected names dispatched zero owned/external mutations and forwarded exact external reads; ownership-only missing-export modules dispatched zero calls. Prettier check passed. Normal wt check passed (base 26d69f15e9c6, WORKTREE, 52236ms): types/lint, affected tests, AST/domain, size, fixture-branch, single-owner and delete/no-shim gates passed; dead-path skipped, spec cases not applicable.

Parent installed-export receipt: canonical 7509c30 plus credential-fields repairs landed as agent-tools master 5d63da8, land 433-246f19 succeeded and pushed origin. This satisfies the canonical dependency. The bridge patch is locally GREEN but not yet installed: parent owns combined UI deployment/restart. No bridge land or deploy performed by this worker.
