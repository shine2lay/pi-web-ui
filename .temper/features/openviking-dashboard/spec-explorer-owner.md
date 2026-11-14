# Memory Explorer: The Owner Check (`openviking-dashboard`, OI-1)

Part of [spec.md](spec.md), for [spec-explorer.md](spec-explorer.md) and [spec-explorer-writes.md](spec-explorer-writes.md). Named by Security (`rm-8841fede`, write rule replaced by `rm-3e4885d2`), built by backend #166 (#165 dropped), recorded at Backend's request (`rm-857576cc`, `rm-b581d680`). Deploy gate for #166: Security's review of its SHA.

## Why a New Check

Before this, pi-web-ui had no owner session. What existed refuses by network position, not by person: the Host allowlist on every HTTP route (`httpHostAllowed` in `server/index.ts`), a token check that only runs when a token is configured (the live unit sets none), and an origin check on WebSocket owner answers. The explorer shows every role's notes and can change them, so it needs a check that names the owner.

## Rules

- **R-OWNER-GATE-1 (one gate):** every explorer route passes through `owner-gate.ts`. No route carries its own check.
- **R-OWNER-READ-1:** the read routes (`tree/roots`, `tree`, `note` GET, `search`) need a passkey owner session. A session ends after 15 minutes idle or 4 hours in total.
- **R-OWNER-WRITE-1 (one fresh confirmation per write, no step-up window):** each write (`note` PUT, `note` DELETE, `undo`, `DELETE passkey`) needs all four:
  1. a passkey owner session;
  2. its own user-verification assertion, bound to that exact operation (below);
  3. an `Origin` header that is exactly `https://pi.wai2shine.com` or `https://spark.tailbb5055.ts.net:8787`;
  4. the header `X-Owner-Write: 1`.
- **R-OWNER-WRITE-2 (the assertion is bound to the operation):** `POST /api/openviking/owner/write/options` (needs a session) takes `op` = `{ method, uri, opened_mod_time (PUT only), body_sha256 }`, or `{ method, operation_id }` for undo. It returns a challenge: 32 random bytes, single use, 60 s lifetime, stored with `op` and the session. The write carries `X-Owner-Assertion` (base64url JSON including the challenge id). Before executing, the server compares the stored `op` with the actual request byte for byte; any difference is `403 OWNER_ONLY`. In `owner-gate.ts` this is gate access `{ kind: "write", op }`.
- **R-OWNER-UNDO-1 (a confirmation prompt must never let a held delete run):** see Undo in [spec-explorer-writes.md](spec-explorer-writes.md). Asking `write/options` for the undo of a held delete freezes that delete.
- **R-OWNER-REFUSE-1:** any failure of either rule answers `403 OWNER_ONLY` with the same body, so a caller cannot learn which condition failed.
- **R-OWNER-FAIL-CLOSED-1:** the write routes refuse everyone until backend #166 is deployed. They may be registered before that; they are not usable before that.

## Session and Passkey Routes

All under `/api/openviking/owner/`:

| Route | Purpose |
|---|---|
| `passkey/code` | start enrolling a passkey |
| `passkey/enroll/options`, `passkey/enroll/verify` | enroll a passkey |
| `session/options`, `session/verify` | open an owner session |
| `write/options` | the per-write confirmation challenge (`R-OWNER-WRITE-2`) |
| `session/logout` | end the session |
| `DELETE passkey` | remove a passkey |

Request and response bodies are owned by backend #166 (`owner-session-types.ts`); this file is amended with them when #166 lands. Until then the table above is the route list only, not a body contract.

## Interim, Until Backend #166 Deploys

- **R-OWNER-INTERIM-1 (no new exposure before the session exists):** the read routes go live in backend #162 serving only what `/api/openviking/entries` already shows without a session:
  - `tree/roots`: all 17 rows with counts;
  - `tree`, `note` and `search`: the two shared roots only (`viking://resources`, `viking://user/default/memories`);
  - a role root (`viking://user/<role>/memories`) on `tree`, `note` or `search`: `403 OWNER_ONLY`.
- *Why:* spec.md's cross-role rule withholds another role's note text from `/entries` today. Serving role notes with no session, even briefly, would move that line before the check that justifies moving it. Architecture's earlier note to Backend (`rm-6cbea5da`) said the read routes had "the same exposure as the existing routes"; that was wrong for note text and search hits on role roots, and this rule replaces it.
- When #166 deploys, `R-OWNER-READ-1` applies to all 17 roots and this section is deleted in the same change.

## Residual Risks (Security, verbatim, `rm-8841fede`)

- **R1:** same-uid process can edit pi-web-ui code/owner-passkeys.json or call :1933 directly (real fix: own uid, Systems/Ops).
- **R2 (replaced by `rm-3e4885d2`):** a chat driving the owner's Chrome (pi-control-chrome browser_cdp reads any origin's cookies incl. HttpOnly) can read the cookie and ride reads; accepted residual, same class as R1, no new exposure; writes stay safe because each needs the owner's biometric/PIN prompt. Ops' CDP filter = defense in depth, not a deploy gate.
- **R3:** pi-web-ui has no live token and tailnet admits other users' shared devices (security -> ops).

These are recorded, not solved here. R1 means the owner check guards the browser route, not the machine: any process running as the same user reaches the store without it.
