# Ten local Vitest workers

Ops #746, accountable lead Ops; project local-test-throughput. Source-only change.
Owner m84920 requested ten workers for local tests; m84932 chose local settings only
and ten for the quick lane too. Remote CI, one normal land slot and the inactive
shared CPU ceiling are unchanged. The shared wt defaults are a separate task.

## H-LOCAL-WORKERS-WEB (before implementation)

- Wrong: `scripts/sealed.sh` accepts only inherited ASCII 1–4; `vitest.config.ts`
  specifies no local worker default, so normal npm tests defer to Vitest's machine
  default. Neither implements the owner's local ten-worker choice.
- Change: use the existing Vitest configuration to select ten only when both CI and
  the explicit worker override are absent. Validate the override as canonical
  ASCII 1–10, and widen the seal's existing allowlist to the same values.
- Expected: resolved local `maxWorkers` is exactly 10, overrides 1–10 survive,
  CI keeps its previous default, and all isolation assertions remain true. Measure
  configuration resolution, not elapsed time or machine-wide CPU use.
- Falsifier: any wrong selected count, changed CI default, lost diagnostic setting,
  admitted malformed worker value, secret/live environment leak or broken fence.
- First focused run: 175/177 passed, including all 68 seal/fence cases. Two new
  probe assertions failed: the default `fileParallelism` is absent (not literal
  `true`), and a probe passed Vite's `configFile` instead of Vitest's `config`, so
  it loaded the normal config instead of the coupled one. The corrected probe
  passed all 50 cases. H-LOCAL-WORKERS-WEB: **HIT** for configuration and isolation;
  no performance claim.

### H-WORKER-PROBE-CONFIG (fixture repair)

The two failures are probe mistakes, not evidence that the coupled proof changed:
installed Vitest's `resolveConfigPath` reads `options.config`, and its normal
resolved config leaves default file parallelism absent. Correct the probe option,
type it as `CliOptions` to catch future spelling errors, and assert the actual raw
normal config. Expect the coupled config to resolve one with file parallelism
false and the no-config CI control to remain unchanged. Any other resolved count
or CI drift falsifies this repair. Result: **HIT**, corrected probe 50/50; typecheck
also passed. No runner implementation change was needed.

## Contract

`npm test`, `npm run test:unit`, direct Vitest and those commands inside
`scripts/sealed.sh` or `scripts/check.sh` use the same `vitest.config.ts`.
`scripts/vitest-workers.mjs` chooses:

1. Explicit `VITEST_MAX_WORKERS`: exactly ASCII `1` through `10`, or a fixed error
   which never prints the supplied value. Empty, padded, signed, decimal,
   percentage, Unicode and out-of-range values are rejected.
2. Any defined `CI` (including empty, `0` or `false`): no new default. Vitest keeps
   its baseline behavior. Remote workflow files and runner counts are untouched.
3. Otherwise: 10. This is a default, not a minimum or a promise of ten active files.

Vitest's existing CLI override and environment precedence are unchanged. With no
worker environment override, `--maxWorkers=1` still selects one; an explicit
`VITEST_MAX_WORKERS` retains Vitest's existing precedence over that flag.

The seal preserves only that one runner variable, validates it before temporary
home allocation and never exports a synthetic default. All other `VITEST_*`
variables, caller hooks, provider keys and live app paths remain scrubbed. Nested
sealing keeps its existing fast path: same home, fence and environment, no second
allocation. Vitest still validates its override when invoked in a nested seal or
through an explicit `env` command after sealing.

`vitest.question-coupled.config.ts` is independent, not an extension of the normal
configuration. Its deliberate `fileParallelism: false` stays intact: these native
queue proofs are serial, not an invitation to parallelize state-dependent checks.
The browser suite's `tests/run-sealed.mjs --jobs` is a separate suite scheduler;
this patch changes Vitest workers, not browser-suite scheduling or fixed ports.

## Checks and source-only receipt

- `tests/unit/vitest-workers.test.ts`: pure selection and strict validation;
  installed Vitest resolution against a baseline with no worker setting, CLI
  precedence, both npm aliases, and the coupled configuration's serial setting.
- `tests/unit/sealed-fence.test.ts`: resolved local/CI/override counts, all ten
  accepted values, invalid values before allocation, nested-seal reuse, plus
  existing dummy-model, secret/live environment, fence and cleanup checks.
- Build, typecheck, scoped formatting and the ordinary sealed landing gate stay
  required. No real chat, provider/model request, deployment or restart.
- Focused receipts (2026-11-01 Pacific): seal/fence 68/68, launcher and notes
  guards 59/59; corrected installed-configuration/selection probe 50/50. Build,
  typecheck and scoped formatting passed. The initial probe errors above are
  retained rather than reported as a clean first run.
- The exact landed commit, normal gate result and ancestry are recorded in task
  #746's completion receipt after landing, not an app deployment receipt. This
  document makes no runtime improvement claim.

## Undo

Use `VITEST_MAX_WORKERS=1` (or another accepted count) for a diagnostic run.
For permanent rollback, revert this patch through a normal gated worktree land.
If another task has since raised the shared launcher above four, restore its
compatible setting first: the old seal cannot accept ten. No app restart needed.
