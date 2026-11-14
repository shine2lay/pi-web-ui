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

Request and response bodies: `server/openviking/owner-session-types.ts` (backend #166), the one contract the page (frontend #290) imports. In short:

| Route | Request | Answer |
|---|---|---|
| `POST passkey/code` | `{}` | `202 { sent, rp_id, expires_at }`; the code goes only to the owner's Telegram |
| `POST passkey/enroll/options` | `{ code }` | `200 { challenge_id, expires_at, options }` (WebAuthn creation options) |
| `POST passkey/enroll/verify` | `{ challenge_id, response }` | `201 { passkey: { id, rp_id, created_at } }` |
| `POST session/options` | `{}` | `200 { challenge_id, expires_at, options }` (WebAuthn request options) |
| `POST session/verify` | `{ challenge_id, response }` | `200 { expires_at, idle_ms, passkey_id, passkeys }` + the session cookie |
| `POST write/options` | `{ op }` (session) | `200 { challenge_id, expires_at, options }`, the challenge bound to `op` |
| `POST session/logout` | `{}` | `200 { signed_out: true }`, cookie cleared |
| `DELETE passkey?id=` | write headers | `200 { removed }` |

- The host is the request's `Origin`, exactly one of the two origins; a passkey belongs to its host, so the owner enrolls once per host.
- The session cookie `pi_owner_session`: 256-bit random id, `HttpOnly; Secure; SameSite=Strict; Path=/api/openviking`, memory only (a restart signs out).
- A write sends `X-Owner-Write: 1` and `X-Owner-Assertion`: base64url of the JSON `{ challenge_id, response }` (WebAuthn assertion). `op.body_sha256` is the lowercase hex sha256 of the exact request body bytes (a DELETE: of no bytes).
- Enrollment needs the single-use code (7 words, 10 minutes, memory only) the server sends to the owner's Telegram; with no passkey stored, every explorer route answers `403 OWNER_ONLY`. Every passkey added or removed sends the owner a Telegram notice.
- Options, verify and assertion calls: at most 10 a minute each; codes: 3 per 10 minutes.

## Residual Risks (Security, verbatim, `rm-8841fede`)

- **R1:** same-uid process can edit pi-web-ui code/owner-passkeys.json or call :1933 directly (real fix: own uid, Systems/Ops).
- **R2 (replaced by `rm-3e4885d2`):** a chat driving the owner's Chrome (pi-control-chrome browser_cdp reads any origin's cookies incl. HttpOnly) can read the cookie and ride reads; accepted residual, same class as R1, no new exposure; writes stay safe because each needs the owner's biometric/PIN prompt. Ops' CDP filter = defense in depth, not a deploy gate.
- **R3:** pi-web-ui has no live token and tailnet admits other users' shared devices (security -> ops).

These are recorded, not solved here. R1 means the owner check guards the browser route, not the machine: any process running as the same user reaches the store without it.
