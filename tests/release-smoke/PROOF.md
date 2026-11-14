# Smoke proof

## Hypothesis H-CHAT-SMOKE (written 2026-11-14, before the change)

- Problem and evidence: the chat app sat at level 2 of 4 on the testing standard. No main flows were
  listed, nothing checked the just-built copy before the swap, and only Ops's pi-web-check looked at
  the live app after the restart.
- One change: flow-tagged smoke tests for four main flows, run by `before.mjs` on its own copy of
  the build and by `live.mjs` on the live app, declared on the testing page with this record.
- Expected: 10 of 10 before-runs green, each under 3 minutes, no model tokens; every check red under
  at least one planted break; the live run 5 of 5 green on its own copy and 3 of 3 on the live app
  with no real chat touched.
- What proves it wrong: a check green under every break, a flake in the 10, a run over 3 minutes, or
  a real chat touched.
- Result: HIT (numbers below; the full write-up is QA #161's RESULT.md).

Dated record that the smoke goes red on an app broken on purpose and green when it is not.
`proof.json` beside this file holds the same record for test-check. Redo it whenever a smoke test
file changes (README.md, "Proof that the smoke can fail").

- Smoke-files hash (`node tests/release-smoke/proof-hash.mjs`), 2026-11-14:
  `51d4fd5f0b197e807992f49e98712f256dcc599bd46f1072dc042dae31d80cbe`, over the four flow-tagged files
  `f1-open-app-test.mjs`, `f2-reply-test.mjs`, `f3-big-chat-test.mjs`, `f4-restart-test.mjs`.
- Built worktree of branch qa-task-161 on base `40eae617`, 2026-11-14 12:57 to 13:36 PST, load 3 to 8.

## Unbroken runs

| Run                                                      | Command                                                 | Result                                                | Seconds per run |
| -------------------------------------------------------- | ------------------------------------------------------- | ----------------------------------------------------- | --------------- |
| Before-run, 10 in a row                                  | `node tests/release-smoke/before.mjs`                   | 10 of 10 exit 0, F1-F4 passed each time               | 56.7 to 58.5    |
| Live run on its own copy, 5 in a row                     | `node tests/release-smoke/fixtures/plant.mjs live:none` | 5 of 5 exit 0, F1-F3 passed                           | 66.1 to 67.4    |
| Live run on the live app, 3 in a row, 13:37 to 13:41 PST | `node tests/release-smoke/live.mjs`                     | 3 of 3 exit 0, F1-F3 passed; one tiny real reply each | 69.0 to 71.2    |

Live app, chat list before (12:30 PST) and after (13:41 PST) from the app's own socket: no chat or
file left by the runs (the big-chat copy and its folder gone, each parked blank chat's empty folder
removed); the chats that changed were other work's own open chats.

The before-run uses only the repo's stand-in model, so it spends no model tokens. The live run's
own copy is a fresh server started from the build, reached through `PI_WEB_SMOKE_LOCAL_URL`,
`PI_WEB_SMOKE_PUBLIC_URL` and `PI_WEB_SMOKE_AGENT_DIR` (plain address settings).

## Planted breaks

`node tests/release-smoke/fixtures/plant.mjs <run>:<plant>` builds a temp copy of the built app with
one thing broken (or starts a broken own server for the live run) and runs the unchanged smoke
command against it. No app file and no smoke check holds a test-only branch.

| Run    | Plant                | What it breaks                               | F1   | F2   | F3   | F4   | Exit | Seconds |
| ------ | -------------------- | -------------------------------------------- | ---- | ---- | ---- | ---- | ---- | ------- |
| before | `no-server`          | the server throws at start                   | FAIL | FAIL | FAIL | FAIL | 1    | 0.7     |
| before | `socket-never-ready` | the page bundle dials the wrong socket path  | FAIL | FAIL | FAIL | pass | 1    | 97.8    |
| before | `version-banner`     | the server reports another protocol version  | FAIL | pass | pass | pass | 1    | 57.8    |
| before | `tool-call-hidden`   | the page never draws a tool call's output    | pass | FAIL | pass | pass | 1    | 68.2    |
| before | `picture-missing`    | the server's chat picture route is gone      | pass | pass | FAIL | pass | 1    | 116.0   |
| before | `restart-loses-turn` | the list of working chats is never read back | pass | pass | pass | FAIL | 1    | 115.2   |
| before | `model-silent`       | the model never answers                      | pass | FAIL | pass | FAIL | 1    | 111.1   |
| live   | `no-server`          | nothing listens at either address            | FAIL | FAIL | FAIL | n/a  | 1    | 1.5     |
| live   | `socket-never-ready` | as above                                     | FAIL | FAIL | FAIL | n/a  | 1    | 482.5   |
| live   | `version-banner`     | as above                                     | FAIL | pass | pass | n/a  | 1    | 66.6    |
| live   | `picture-missing`    | as above                                     | pass | pass | FAIL | n/a  | 1    | 126.1   |
| live   | `model-silent`       | as above                                     | pass | FAIL | pass | n/a  | 1    | 247.3   |

Every check is red under at least one plant and no plant ends unsure (exit 3). Sample red lines:

- `F1 FAIL ... own copy: shows the version banner (the page and the server differ)`
- `F2 FAIL ... the reply ended, but its bash tool call with output "smoke-tool-ran" never showed`
- `F3 FAIL ... 0 of 4 pictures loaded when scrolled to; picture requests answered 404`
- `F4 FAIL ... no carry-on note and answer in the cut-off chat after the restart within 60 s`

The live run waits longer (120 s for a ready socket, 180 s for a reply) because an app just
restarted is busy, not broken; that is why its broken-socket plant takes 8 minutes.
