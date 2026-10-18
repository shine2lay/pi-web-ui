# Roles: each role's settings history

Ops #209, one of the owner's Roles tasks ("create those tasks and queue them", 2026-10-18). Accountable lead: Ops.

## H-ROLES-CONFIG-1

**Wrong, and the evidence.** Each role's Config tab said "Configuration history is not connected yet." (`web/src/roles-exact-view.ts`, the Config tab's empty acts list): nothing recorded a role's settings over time, so there was no history to show. identity.json and the queue's settings are changed by hand and by add-ons, and only their current values are kept.

**One change, and why it should fix it.** A small recorder that snapshots every role's settings every 5 minutes and keeps the differences:

- `server/roles-config-history.ts`, separate from the Roles overview, which stays read-only. AgentService starts it after the restart's carry-on: one run then, then every 5 minutes (an unref'd timer).
- Each run takes, per role, the settings the Roles page shows (`RolesOverviewReader.configSettings()`):
  - from identity.json: title, work mode, goals by name and scope, home chat (its file name); and the about page's Focus line;
  - its home chat's queue: lanes at once, Auto approve, Auto start, default model, thinking and speed, the owner's pause;
  - its home chat's model, as roles-model (#204) names it.
- It compares them with the last snapshot (`~/.pi-web-ui/roles-config-snapshot.json`) and appends one line per changed setting to `~/.pi-web-ui/roles-config-history.jsonl`: `{"v":1,"at":<ms>,"role":"ops","field":"lanesAtOnce","from":"4","to":"8"}`.
- A role's first snapshot is its baseline: shown as the "since" date, never as changes. A setting that can't be read in a run (home chat unreadable, model unknown) keeps its last value, so it can't show up as a change.
- Both files 0600, the snapshot replaced atomically, lines older than 90 days dropped, values cut at 200 characters.
- The overview sends each role's newest 20 changes as `UiRoleOverview.configHistory`. The Config tab lists them as "<time> · <setting>: <old> → <new>", newest first, then "Who changed it isn't recorded."; with none, "No changes recorded since <date>."

**Expected result, and how it is measured.** A settings change shows in the role's Config tab within 5 minutes, with its old and new values and the time of the run that saw it. Measured by unit tests on fixed snapshots (baseline only, one change, no change, an unreadable setting, value cap, retention, the tab's text) and a look-only live check after install: the baseline file exists, then a real change appears.

**What would prove it wrong.** A real change missing from the tab after 5 minutes, a line for something that didn't change, or the baseline shown as changes.

**Limits.** Setting values only: no message text, prompts or chat contents. Who made a change isn't known for file edits, so the tab says so and nothing guesses it. The time shown is when the recorder saw the change (at most 5 minutes after it was made). No settings are changed to test it, no model calls; identity.json isn't written. Minimal checks (owner, Oct 17: "build ship it, only test minimally").

**Undo.** `pi-web-deploy rollback`, or revert the commit and deploy. The two files are inert; deleting both starts a new baseline.

**Result:** pending (live check after install).
