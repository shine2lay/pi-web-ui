agreed_with_qa: 2026-11-17

# Done list: openviking-dashboard

QA's done list for pi-web-ui (QA rm-4ab04824, 2026-11-17), word for word. An item is ticked only when this feature's records prove it.

- [ ] A failing-first test exists for the change or fix (red before, green after).
- [ ] `TZ=UTC scripts/sealed.sh` (`scripts/check.sh --fast` / selected unit & sealed browser tests) passes with 0 live `~/.pi`, `~/.pi-web-ui`, `~/.pi-scheduler`, or live-port reads/writes.
- [ ] `npm run typecheck` and `prettier-scope --check` pass.
- [ ] `wt check` (`WT-SIZE-500`, `WT-NO-FIXTURE-BRANCH`, `WT-SINGLE-OWNER`, `WT-DELETE-NO-SHIM`) passes, and obsolete tests for replaced code are deleted or retargeted (Rule 23).
- [ ] `pi-web-deploy` runs both `smoke:before` and `smoke:live` with all checks `✓`.
- [ ] For any UI/page change: `ui-check` `@2x` on `320/390/1440` (`light` + `dark`, plus `states` manifest for multi-state screens) exits `0` (`0` overlap, `0` clipped scrollbars, `0` console/page errors, `0` prototype chrome), and Chromium + WebKit live-SSE update check preserves scroll/focus/open state where live data refreshes.
- [ ] For feature/redesign work: `.temper/features/<feature>/spec*.md` acceptance cases mapped, QA's one blind final check + Design `@2x` live look sign-off pass (Rule 33).
- [ ] Cross-repo copies (`task-tag-governance`, `identity-role` / `v2-readers`, `chat-id`) pass their cross-repo parity test.
