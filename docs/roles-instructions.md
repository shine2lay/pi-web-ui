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

**Hit** (2026-10-18). Two look-only live looks of the Ops panel; the Ops home chat started (resumed)
after pi-identity's record landed at 09:26:

| Look | Live build | Home chat's entry | Files now | Panel |
|---|---|---|---|---|
| 09:50 | 3ab4bac9 | 09:46:12 (resumed at the 09:46 restart) | AGENTS.md 09:21:13, notebook.md 09:21:19, prompt.md 10-11, about.md 09-30; each hash equal to the entry's | Current · Loaded 09:46 · up to date |
| 10:05 | ca613762 | 10:00:07 (resumed at the 09:59 restart) | the same, before and after the look | Current · Loaded 10:00 · up to date |

- Every role with a record showed Current (8: architecture, backend, design, frontend, marketing, ops,
  product, temper; all written at the 09:46-10:00 restarts). The 7 whose home chats hadn't started since
  showed Not recorded. No state disagreed with the file times and no fresh chat showed Outdated: the
  disproof conditions weren't met.
- Not seen live yet: Outdated (no instruction file changed between a load and a look). The unit tests cover
  it (outdated with names, a file gone since); it is the same comparison with unequal hashes.
- The line's contrast, measured in the page: label 11:1, text 12.56:1 on rgb(22, 24, 27). axe can't be
  loaded into the Roles frame (its script never defines `axe` there; evaluating its source hung).
  Desktop dark and light screenshots; on a phone the line's text was read from the page (same words).
- Look-only: the page sent only hello and roles_watch; 0 page errors.
- Seen in the record: the deploy check's throwaway chat copy (`pi-web-check-copy.jsonl`) gets an entry of
  its own; harmless, it ages out with the newest-50 rule.
- Receipts: `~/kept-from-tmp/2026-10-18/roles-instructions-live/` (look.mjs, out/run3.json, screenshots).

## Undo

`pi-web-deploy rollback`, or revert this commit and deploy. Reverting pi-identity's change stops the record;
the page then shows Not recorded.
