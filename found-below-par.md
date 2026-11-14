# pi-web-ui: found below par

QA's living checklist for pi-web-ui (rule 24). Each item is one past failure or complaint, written as
a check, with the case and its source. The owner's items are in his words with the date. A reviewer
runs every item that a change touches; at most 20 items.

- dashboard server read the owner's real memory files from a fixed path: the test at `tests/unit/openviking-state-dir.test.ts:22` passes. Case: QA miss log M4 (2026-11-12). Source: /home/shinelay/qa-lab/qa-setup/verdicts/MISS-LOG.md, line 85.
- Owner, 2026-10-18: "make it so that roles and initiatives are always connected when i am on page, i hate that it says reconnecting for along time when i change tabs". Check: after a tab switch the Roles and Initiatives pages show no long "reconnecting". Source: docs/pages-live.md, line 3.
- Owner, 2026-10-18: "if a task is waiting, lets have a waiting status, like testing, if its waiting on another task then it's blocked". Check: a waiting task and a blocked task each show their own status in the left panel. Source: docs/left-task-status.md, line 5.
- A long chat opens and scrolls to a far picture without being pulled back to the bottom: an install of 0b349141 failed pi-web-deploy's big-chat check on this and was rolled back. Check: pi-web-check's bigchat check passes after the install. Source: PATCHES.md, line 92.
- The landing check passes in a worktree that was never built: `tests/unit/systemd-install.test.ts` once failed there with `ERR_MODULE_NOT_FOUND ... dist/server/plugin-updater.js`. Source: PATCHES.md, line 15.
- Escape on one page never cancels a question the owner can't see in another chat. Source: docs/escape-hidden-question.md, line 9.
- No Vitest run ends with `EnvironmentTeardownError: [vitest-worker]: Closing rpc while "onUserConsoleLog" was pending`, the flake that refused lands. Source: docs/gate-plugin-dom-flake.md, line 12.
- After a restart, a role's waiting message reaches its home chat within minutes, not after a long carry-on run (it once took 22.6 minutes). Source: docs/role-mail-restart.md, line 7.
- A hidden browser tab makes no automatic file-panel listings (it once made 12 polls in 120 seconds). Source: docs/files-panel-visibility.md, line 12.
- Sending to a chat that is starting never fails with "Agent is already processing a prompt". Source: docs/prompt-start-race.md, line 11.
