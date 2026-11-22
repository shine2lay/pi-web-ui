# proof-check on QA's messages: no pass sent without an allowed proof (H-PROOF-MSG-WIRE-1)

Ops #1073. The app side of part (b) of the wiring contract (in the agent-tools repo: the proof-check wiring
doc and the proof-check messages contract from QA #222's seam; Ops #1072 builds the tool's message mode). Owner Shine picked the check ("Top 4",
Board bp-52e3bfe7 item 2); QA's wiring contract rm-125f428a.

## Hypothesis (written before the change)

- **What's wrong, with evidence.** QA's pass verdicts reach other roles and the owner by message, where the
  task-close gate (pi-queue, Ops #1071) never looks. Miss M12, the Follow mid sign-off, was two messages
  (rm-b176aa65 to backend, rm-02b6c6ed to rollcall, 2026-11-20): "SIGNED OFF ... Rule 33: PASS", while its
  proof listed untested parts. Of QA's 81 sent messages on 2026-11-21, 18 claim a pass and none names a proof
  `proof-check` allows; of 19 pass-like messages QA found, only 9 carried the `final-check` tag, so the
  check can't key on a tag.
- **The change.** One shared module (`server/proof-check-messages.ts`) runs `proof-check --message <file>
  --json` on every `message_role` text and every `telegram_send` text from a chat whose role, as the server
  knows it, is `qa`. Refused (exit 1 or 2) or the tool can't run: not sent, with the reason and the next
  step. Allowed with a stamp: the stamp goes out as the message's last line. No flag, tag or setting skips
  it; other roles' messages never run the tool.
- **Expected result.** From the install on, 0 QA messages that claim a pass reach another role or the owner
  without the stamp line. Each judged send leaves one numbers line in `<data dir>/proof-check-messages.jsonl`
  (no message text): refusals per week, and what followed (proof fixed, claim lowered, reworded).
- **What would prove it wrong.** Within 2 weeks a QA pass about a feature reaches another role or the owner
  without a stamp; a non-QA message is held or slowed; a QA message is sent while the tool can't run; or more
  than half of the refusals are false alarms that end in rewording (QA's baseline: 6 of 24).

## The rule as built

- Who: the sender role `qa` from the server's own binding of the chat (`roleMessageHost` sender for
  `message_role`; the plugin caller context's role for `telegram_send`, a helper chat counting as its parent).
  Every QA chat (home, task, own turn), every kind, any tag. `message_role` approval calls (no text) are
  not judged.
- How: the text goes to a 0600 file in a fresh temp folder; `execFile` with an argument list (no shell),
  30 s timeout; the binary is the first `proof-check` on the server's PATH, else `~/.local/bin/proof-check`;
  the folder is removed after each run. Only an answer whose JSON says `mode` "message" with the same exit
  code counts; anything else is "can't run".
- Exit 0 with a stamp: text + newline + stamp. For `message_role` the stamp counts inside the 4,000-character
  limit; over it, refused with "shorten it by N characters". Exit 0 without a stamp: sent unchanged.
- Exit 1 or 2: not sent; the refusal lists the tool's findings with their next steps.
- Can't run (missing, timeout, unreadable answer, another exit code): held (not sent; fail closed); the
  answer says "the tool could not run" (never "refused", QA rm-848cfb08) and that Ops is told, and one script notice goes to Ops's home chat at most every 30 minutes (kept in
  memory, so a restart may send one more). At start the server logs whether `proof-check --message` works.
- Sender-typed `proof-check:` lines are the tool's to refuse; the host never strips or rewrites them.

## Numbers

One JSON line per judged send: `at`, `surface`, `chat` (session id), `exit`, `status`, `outcome` (sent,
refused, too_long, held), `claimed_verdict`, `proofs_named`, the tool's `pass_claim_lines`, `proof_lines`,
`proofs_allowed`, `proofs_refused`, `send_allowed`, `ms`, and for a held message a short `why`. Never the
text. The lead reads the first day's lines.

## Undo

`git revert` of this change on `mine`, `wt land`, `pi-web-deploy`; or `pi-web-deploy rollback` right after
the install. The numbers file can stay; nothing reads it then.
