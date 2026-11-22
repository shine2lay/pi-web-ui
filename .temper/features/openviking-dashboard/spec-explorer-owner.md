# Memory Explorer: The Owner Check (`openviking-dashboard`, OI-1)

Part of [spec.md](spec.md), for [spec-explorer.md](spec-explorer.md) and [spec-explorer-writes.md](spec-explorer-writes.md). Named by Security (`rm-8841fede`, write rule replaced by `rm-3e4885d2`), built by backend #166 (#165 dropped), recorded at Backend's request (`rm-857576cc`, `rm-b581d680`). Deploy gate for #166: Security's review of its SHA. Reads opened to everyone who reaches pi-web-ui by owner Shine 2026-11-22 (`dr-c54a3286d823`, Ops #1080): "if they can reach pi they can ask for all of it anyways, no reason to guard it"; scope picked: "Remove sign-in only, keep for edits".

## Why a Check on Writes

What guards pi-web-ui as a whole refuses by network position, not by person: the Host allowlist on every HTTP route (`httpHostAllowed` in `server/index.ts`), a token check that only runs when a token is configured (the live unit sets none), and an origin check on WebSocket owner answers. Anyone who reaches pi-web-ui can ask a chat to read any memory, so reading needs nothing more. Changing a note is the owner's alone, so each change needs a check that names the owner: his passkey.

## Rules

- **R-OWNER-GATE-1 (one gate):** every explorer route passes through `owner-gate.ts`. No route carries its own check.
- **R-OWNER-READ-2 (reads are open, Shine 2026-11-22):** the read routes (`tree/roots`, `tree`, `note` GET, `search`) and the owner events in `audit` answer any request whose `Host` and `Origin` pass `ownerAddressAllowed` (valid, host not ending in "."). No session, no cookie. With no owner check wired the gate is `ownerCheckMissing` and still refuses everything (fail closed).
- **R-OWNER-WRITE-1 (one fresh confirmation per write, no step-up window):** each write (`note` PUT, `note` DELETE, `undo`, `DELETE passkey`) needs all three:
  1. its own user-verification assertion from a passkey of the request's host, bound to that exact operation (below);
  2. an `Origin` header that is exactly `https://pi.wai2shine.com` or `https://spark.tailbb5055.ts.net:8787`;
  3. the header `X-Owner-Write: 1`.
- **R-OWNER-WRITE-2 (the assertion is bound to the operation):** `POST /api/openviking/owner/write/options` takes `op` = `{ method, uri, opened_mod_time (PUT only), body_sha256 }`, or `{ method, operation_id }` for undo. It returns a challenge: 32 random bytes, single use, 60 s lifetime, stored with `op` and the host. The write carries `X-Owner-Assertion` (base64url JSON including the challenge id). Before executing, the server compares the stored `op` and host with the actual request byte for byte; any difference is `403 OWNER_ONLY`. In `owner-gate.ts` this is gate access `{ kind: "write", op }`.
- **R-OWNER-UNDO-1 (a confirmation prompt must never let a held delete run):** see Undo in [spec-explorer-writes.md](spec-explorer-writes.md). Asking `write/options` for the undo of a held delete freezes that delete.
- **R-OWNER-REFUSE-1:** any failure of a write rule or an owner route answers `403 OWNER_ONLY` with the same body, so a caller cannot learn which condition failed. A host with no passkey learns that from `GET passkeys` (an empty list), never from a refusal.

## Passkey Routes

All under `/api/openviking/owner/`. Request and response bodies: `server/openviking/owner-session-types.ts`, the one contract the page imports.

| Route | Request | Answer |
|---|---|---|
| `GET passkeys` | none | `200 { rp_id, passkeys: [{ id, rp_id, created_at }] }` for the request's host; never a public key |
| `POST passkey/code` | `{}` | `202 { sent, rp_id, expires_at }`; the code goes only to the owner's Telegram |
| `POST passkey/enroll/options` | `{ code }` | `200 { challenge_id, expires_at, options }` (WebAuthn creation options) |
| `POST passkey/enroll/verify` | `{ challenge_id, response }` | `201 { passkey: { id, rp_id, created_at } }` |
| `POST write/options` | `{ op }`, `X-Owner-Write: 1` | `200 { challenge_id, expires_at, options }`, the challenge bound to `op` and the host |
| `DELETE passkey?id=` | write headers | `200 { removed }` |

- The host is the request's `Origin`, exactly one of the two origins (`GET passkeys`: the `Origin` when sent, else the `Host` naming one of them); a passkey belongs to its host, so the owner enrolls once per host.
- A write sends `X-Owner-Write: 1` and `X-Owner-Assertion`: base64url of the JSON `{ challenge_id, response }` (WebAuthn assertion). `op.body_sha256` is the lowercase hex sha256 of the exact request body bytes (a DELETE: of no bytes).
- Enrollment needs the single-use code (7 words, 10 minutes, memory only) the server sends to the owner's Telegram; with no passkey on the host, `write/options` refuses and every write answers `403 OWNER_ONLY`. The page then offers "Add a passkey" and, once added, finishes the write. Every passkey added or removed sends the owner a Telegram notice.
- Options, verify and assertion calls: at most 10 a minute each; codes: 3 per 10 minutes.

## Residual Risks (Security, verbatim, `rm-8841fede`)

- **R1:** same-uid process can edit pi-web-ui code/owner-passkeys.json or call :1933 directly (real fix: own uid, Systems/Ops).
- **R3:** pi-web-ui has no live token and tailnet admits other users' shared devices (security -> ops).
- **R4 (Ops #1080):** `write/options` needs no session, so anyone who reaches pi-web-ui can ask for an undo's confirmation and freeze (unconfirmed: cancel) a held delete. Safe direction (the note is kept); needs the operation id.

These are recorded, not solved here. R1 means the owner check guards the browser route, not the machine: any process running as the same user reaches the store without it.

## Obsolete / deleted (owner dr-c54a3286d823, 2026-11-22)

Deleted by Ops #1080 with their code and tests (Rule 23, no shims):

- **R-OWNER-READ-1:** reads needed a passkey owner session (15 minutes idle, 4 hours in total). Replaced by R-OWNER-READ-2.
- **R-OWNER-FAIL-CLOSED-1:** write routes refused everyone until backend #166 deployed. Done; `ownerCheckMissing` keeps the fail-closed default.
- `POST session/options`, `POST session/verify` (opened a session, set the cookie), `POST session/logout`; the `pi_owner_session` cookie (`HttpOnly; Secure; SameSite=Strict; Path=/api/openviking`, memory only).
- **R2** (`rm-3e4885d2`): a chat driving the owner's Chrome could read the session cookie and ride reads. No cookie remains; reads are open by decision.
- Page: the "Sign in to see memory" box and empty state, the Sign in / Sign out header buttons, the "Signed out · memory opens with your passkey" health line ([signedout-honest.md](signedout-honest.md) is superseded).
