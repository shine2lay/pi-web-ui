# pi-web-ui release smoke tests

QA owns these tests (owner rule 34, 2026-11-13; QA #161). They walk each main user flow of the chat
app once, on the whole app: the built server, the built page in a real browser and the socket
between them. The unit suite (`npm test`) checks the parts one at a time; `tests/run-smoke.mjs` is
upstream's protocol runner and is not part of this.

## When each command runs

| Command                               | When                                                                                                                                  | Against                                                                                                            |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `node tests/release-smoke/before.mjs` | Once per release, in the deploy path, after the build and before the swap. A failure should stop the release. Never in the land gate. | Its own copy of the app, started from the `dist/` and `web/dist/` of the folder it runs in, with a stand-in model. |
| `node tests/release-smoke/live.mjs`   | Right after the install's restart.                                                                                                    | The live app at both addresses (the public site and 127.0.0.1).                                                    |

Both take no arguments and run from the repo or a built worktree of it. Each prints one line per
check, `F<n> PASS|FAIL|UNSURE <flow>: <what it saw> (<seconds>)`, then one summary line. Exit codes:

- 0: every check passed.
- 1: a check failed (the app is broken), including a missing build or a copy that doesn't start.
- 3: nothing failed, but a check could not be made for a reason outside pi-web-ui: the model
  provider is down or rate-limited, the public route doesn't answer, Chrome is missing, or QA's big
  chat fixture is missing. Treat it as unsure, never as green.

Settings (plain configuration, defaults in brackets):

- before-run: `PI_WEB_SMOKE_APP_DIR` (the current folder): another built folder to check.
- live run: `PI_WEB_SMOKE_PUBLIC_URL` (`https://pi.wai2shine.com/`), `PI_WEB_SMOKE_LOCAL_URL`
  (`http://127.0.0.1:8787/`), `PI_WEB_SMOKE_AGENT_DIR` (`~/.pi/agent`, the app's agent folder).
- both: `PI_WEB_SMOKE_FIXTURE_DIR` (`~/.cache/pi-web-check-fixture`): QA's fixed big chat.

## Main user flows and the checks that cover them

Each test file names its flow in its title with `@flow:<id>`; test-check reads the tags.

| Flow                              | Test file              | Before release                                                                                                  | Live                                                                                                 |
| --------------------------------- | ---------------------- | --------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| F1 open the app                   | `f1-open-app-test.mjs` | the page loads, its socket gets ready, the chat list shows, no "page version differs" banner                    | the same, at both addresses                                                                          |
| F2 send a message and get a reply | `f2-reply-test.mjs`    | typed in the composer: the reply streams in, a tool call runs and shows its output when unfolded, the turn ends | one tiny real prompt ("Reply with just OK") in a throwaway chat; the reply arrives and the turn ends |
| F3 open a big chat with pictures  | `f3-big-chat-test.mjs` | a copy of QA's fixed big chat (about 100 MB) opens, scrolls back, and all four of its pictures load             | the same, on a copy made in the live app's folder and deleted after                                  |
| F4 a chat survives a restart      | `f4-restart-test.mjs`  | a turn still streaming when its own copy restarts carries on by itself after the restart                        | none: it would need a turn planted before the install's restart                                      |

Not covered yet (open flows): F5 a queued task runs; F6 a second window or a phone on the same
chat; F7 the add-on pages load (they need add-ons loaded into the copy).

## The before-run copy

- `../lib/own-server.mjs` starts `dist/server/index.js` of the checked folder on a free port with a
  temp data folder and a temp agent folder: no real add-on, chat or setting is read.
- The model is the repo's zero-token stand-in (`../lib/mock-model.mjs`); its answers are in
  `standInReply` in `before.mjs`. No real model, no tokens.
- A missing build fails every check with a plain message; it never builds by itself.
- F4 restarts that copy, the way `tests/carry-on-restart-test.mjs` does.

## The live rules (Ops)

- Every socket the live run opens, the page's included, uses a `carry-on:` client id.
- It never opens, writes or moves a real chat. F2 makes one throwaway chat and closes it again (its
  files are gone); F3 opens a copy of QA's fixed big chat and deletes the copy, and takes out the
  summary the memory add-on may write about that copy. Before closing a chat the window moves to a
  new blank chat; if the server leaves that blank chat's empty folder behind, the run removes it.
- Busy is not broken: right after a restart every check waits on a condition with generous limits
  (2 to 3 minutes), never on a fixed clock.

## What each run cannot catch

- Before-run: real add-ons (none are loaded), the real model and its provider, the public route
  and its sign-in, the live data folder, and the install itself (the swap and the restart).
- Live run: a restart cutting off a turn (F4), the tool-call display (the live prompt asks for no
  tool, to keep it to one tiny reply), and anything only an add-on page shows (F7).
- Both: queued tasks (F5), two windows on one chat (F6), browsers other than Chrome.

## Proof that the smoke can fail

`PROOF.md` records each planted break and which checks went red; `proof.json` holds the same record
for test-check. Redo both whenever a test file with a flow tag changes:

- `node tests/release-smoke/fixtures/plant.mjs before:<plant>` runs the before-run on a temp copy of
  the build with one thing broken (`fixtures/broken-copy.mjs`), or with a stand-in model that never
  answers (`before:model-silent`); `before:none` is the unbroken build.
- `node tests/release-smoke/fixtures/plant.mjs live:<plant>` runs `live.mjs`, unchanged, on its own
  copy of the app reached through the two address settings; `live:none` is the live run's own proof.
- Then `node tests/release-smoke/proof-hash.mjs` for the new `smoke_files_sha256`.
