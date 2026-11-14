# Memory Explorer: The Owner Check (`openviking-dashboard`, OI-1)

Part of [spec.md](spec.md), for [spec-explorer.md](spec-explorer.md) and [spec-explorer-writes.md](spec-explorer-writes.md). Named by Security (`rm-8841fede`), built by backend #165, recorded at Backend's request (`rm-857576cc`).

## Why a New Check

Before this, pi-web-ui had no owner session. What existed refuses by network position, not by person: the Host allowlist on every HTTP route (`httpHostAllowed` in `server/index.ts`), a token check that only runs when a token is configured (the live unit sets none), and an origin check on WebSocket owner answers. The explorer shows every role's notes and can change them, so it needs a check that names the owner.

## Rules

- **R-OWNER-GATE-1 (one gate):** every explorer route passes through `owner-gate.ts`. No route carries its own check.
- **R-OWNER-READ-1:** the read routes (`tree/roots`, `tree`, `note` GET, `search`) need a passkey owner session.
- **R-OWNER-WRITE-1:** the write routes (`note` PUT, `note` DELETE, `undo`) need all four:
  1. a passkey owner session;
  2. a user-verification step-up no older than 5 minutes;
  3. an `Origin` header that is exactly `https://pi.wai2shine.com` or `https://spark.tailbb5055.ts.net:8787`;
  4. the header `X-Owner-Write: 1`.
- **R-OWNER-REFUSE-1:** any failure of either rule answers `403 OWNER_ONLY` with the same body, so a caller cannot learn which condition failed.
- **R-OWNER-FAIL-CLOSED-1:** the write routes refuse everyone until backend #165 is deployed. They may be registered before that; they are not usable before that.

## Session and Passkey Routes

All under `/api/openviking/owner/`:

| Route | Purpose |
|---|---|
| `passkey/code` | start enrolling a passkey |
| `passkey/enroll/options`, `passkey/enroll/verify` | enroll a passkey |
| `session/options`, `session/verify` | open an owner session |
| `step-up/options`, `step-up/verify` | the user-verification step-up writes need |
| `session/logout` | end the session |
| `DELETE passkey` | remove a passkey |

Request and response bodies are owned by backend #165 (`owner-session-types.ts`); this file is amended with them when #165 lands. Until then the table above is the route list only, not a body contract.

## Interim, Until Backend #165 Deploys

- **R-OWNER-INTERIM-1 (no new exposure before the session exists):** the read routes go live in backend #162 serving only what `/api/openviking/entries` already shows without a session:
  - `tree/roots`: all 17 rows with counts;
  - `tree`, `note` and `search`: the two shared roots only (`viking://resources`, `viking://user/default/memories`);
  - a role root (`viking://user/<role>/memories`) on `tree`, `note` or `search`: `403 OWNER_ONLY`.
- *Why:* spec.md's cross-role rule withholds another role's note text from `/entries` today. Serving role notes with no session, even briefly, would move that line before the check that justifies moving it. Architecture's earlier note to Backend (`rm-6cbea5da`) said the read routes had "the same exposure as the existing routes"; that was wrong for note text and search hits on role roots, and this rule replaces it.
- When #165 deploys, `R-OWNER-READ-1` applies to all 17 roots and this section is deleted in the same change.

## Residual Risks (Security, verbatim, `rm-8841fede`)

- **R1:** same-uid process can edit pi-web-ui code/owner-passkeys.json or call :1933 directly (real fix: own uid, Systems/Ops).
- **R2:** pi-control-chrome could ride the read session (ops denylist requested).
- **R3:** pi-web-ui has no live token and tailnet admits other users' shared devices (security -> ops).

These are recorded, not solved here. R1 means the owner check guards the browser route, not the machine: any process running as the same user reaches the store without it.
