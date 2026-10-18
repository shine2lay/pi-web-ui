# roles-instructions: which instructions each role's home chat loaded (Ops #208)

Owner, 2026-10-18: "create those tasks and queue them" (the Roles page's remaining gaps). Accountable lead: Ops.

## What it shows

Each role's panel, Instructions line:

| State | Label | Text |
|---|---|---|
| every file the home chat loaded is unchanged | Current (green) | Loaded <time> · up to date |
| some changed since (or are gone) | Outdated (amber) | Loaded <time> · <file names> changed since |
| no record for its home chat, an older server, anything unreadable | Not recorded (violet) | what its home chat loaded is not recorded |

`<time>` is when the home chat's entry last changed (its start, or the last time it was given its rules).

## How

- pi-identity writes `<role dir>/loaded.json` (pi-identity `docs/loaded-record.md`): per chat file, a sha256
  of `~/.pi/agent/AGENTS.md`, the role's prompt, about page and notebook as that chat got them. The notebook's
  hash follows the rules re-sent mid-chat and the chat's own writes; AGENTS.md only at a chat's start (pi
  doesn't re-send it), so a chat started before an AGENTS.md change correctly shows Outdated.
- `server/roles-instructions.ts` reads that file for the role's home chat, hashes the same files now and
  compares. It only hashes the every-chat rules file (`agentsFile()` from the host) and `.md` files directly
  in the role's folder, as plain bounded files; anything else leaves the role Not recorded.
- Names, hashes and times only: no instruction text is kept, sent or shown (AGENTS.md rule 11). No chat is
  loaded, no model is called, nothing is written.

## Hypothesis H-ROLES-INSTR-1 (rule 20)

- **Wrong:** the panel can't say which instructions a chat loaded (`web/src/roles-exact-view.ts`, "Loaded
  instructions are not recorded"), because nothing records it.
- **Change:** pi-identity records hashes at load; the overview compares them with the current files.
- **Expect:** right after a role's notebook changes, its panel shows Outdated · notebook.md until that chat's
  next reply re-sends the rules, then Current. A chat started before an AGENTS.md change shows
  Outdated · AGENTS.md.
- **Measure:** one look-only live check of a role whose home chat started after pi-identity's change landed:
  its state against the files' change times and its loaded time.
- **Disproved if** the state disagrees with the file times, or a fresh chat shows Outdated.

## Result

Pending the live look.

## Undo

`pi-web-deploy rollback`, or revert this commit and deploy. Reverting pi-identity's change stops the record;
the page then shows Not recorded.
