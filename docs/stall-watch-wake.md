# stall-watch: waking the chain (H-STALL-WAKE-1)

Part of [stall-watch.md](stall-watch.md) (what the watch is, its rules, how to switch it off, and its parts).
Retention, the page, the locales fix and the 24 h verdict are in [stall-watch-wake-checks.md](stall-watch-wake-checks.md).

## H-STALL-WAKE-1 (Ops #284, written before delivery changes)

- **Wrong, with evidence:** a finding nobody hears moves nothing. Overnight four Team projects sat empty and
  no lead was woken (rm-8fb841ab). The progress feed asks for updates, not next work.
- **One change:** wake the chain in turn, batched per recipient, with ledger dedupe and caps. The leads still
  decide what happens; the check only sends wakes. No models or registry/queue writes.
- **Expected, measured from the ledger, role message store and registry:** the first live round creates exactly
  one step-1 message per due recipient and none for quiet items; a normal restart creates zero duplicates;
  within 24 h at least half of the flagged stretches end with a lead action (task queued under it, done or
  dropped, or a wait); no owner step without all earlier steps at least `gapHours` apart.
- **Disproof:** any duplicate step, message for a quiet item, exceeded cap, or fewer than half acted on in 24 h.
  A miss gets a new hypothesis about the wake text or chain, not an unmeasured tweak.
- **Result so far (Oct 20): HIT** on the fixed fixtures, the first live delivery (12:27 PDT) and the first
  normal restart (15:31 PDT), below. All 11 flagged stretches had a lead action within 9 minutes. The 24 h
  verdict (task-9x7fkl) is still due, so this is not a full 24 h HIT yet.

## Waking the chain (Ops #284)

The code default remains **dry**. With `"mode":"on"` in `~/.pi-web-ui/stall-watch.json`, each round hands
its findings to `StallWake.act` (`server/stall-wake.ts`) instead of the dry log. `"mode":"dry"` returns to
logging only; `"mode":"off"` stops at the next round. Settings are read each round. After **off** has stopped
the timer, starting it again needs the next normal `pi-web-deploy` restart; changing dry/on does not.

Step 1 goes when the stretch is first found. Each later step goes `gapHours` (default 2) after the preceding
step, only while the same stretch is still found. An action that clears or changes the finding ends it: a task
appears, done/dropped, a wait, recorded progress, a lead change. A later stretch starts at step 1.

The owner's step goes **only through COO**, once per stretch: the rule and since time, roles woken and times,
and “Put it to the owner as one dialog with the full package (rule 21): drop it, pause it, reassign it, or name
the next work.” When COO was an earlier step the text says “COO (you)”. An owner-led item goes straight to
COO. After the owner's step nothing further is sent automatically; the finding stays visible on the page.

### Delivery, dedupe and quiet cases

`RoleMessages.requestStall` is modelled on `requestPoke`: sender
`{role:"app",title:"the work check",chat:"Work check",file:""}`, kind report, its own chain (outside role
chains' caps), normal delivery after a running turn, normal retries. It carries
`stall:{items:[{kind,id,name,rule,since,step,owner?}]}`. Header:
`[Role message rm-… from the work check · stalled work · <names>]`.

Hint: “(The work check found work you lead that isn't moving. Act with your tools: queue the next task under
it (queue_add with its project or initiative), close it (work_project or work_initiative change, status done
or dropped), or record a wait with its end (work_project or work_initiative wait). Nothing starts by itself.
No reply is needed: the check sees what you do. Write nothing for the owner in this chat.)” The owner's step
has its own hint telling COO to put it to the owner. Its chat turn is folded like a role's, not an owner report.

One message per recipient per round holds all due items. Each item is about 600 characters: name/kind/id,
plain rule and time, last done task/title/summary, open tasks and waits, who comes next and when, and the three
ways to clear it. Essential action and next-step text is never truncated to fit context.

Ledger `~/.pi-web-ui/stall-watch.jsonl`: `{stretch,step,to,at,id?,state,owner?}`, one line per step/status
transition. `sent`, `held`, `wakes-off`, `no-chat`, `capped`. Historical detail is kept for 30 days. Compact consumed-step
markers (`sent`, `wakes-off`, `no-chat`, with original step times) are kept for every unresolved stretch,
including partially advanced chains. A verified stretch end adds `endedAt`; its markers then stay for 30 more
days. No extra file or registry write. Absence from a round is **not** an end: suppression, pauses or failed /
incomplete reads retain markers conservatively. The role message store also identifies a sent step if a crash
lost its ledger line. Dedupe persists across installs/restarts with no hard horizon.

This is **Ops's technical retention clarification** (rm-8b9b535a), not new owner consent.

Caps: **6 messages per recipient per local day; 20 total in any rolling hour**, counting a batch once.
`capped` waits for the next round with room. While role messages are paused nothing is created (`held`);
on resume only findings still present go. A held or capped state is recorded once until it changes.

The disabled-wakes switch is **`wakeOnDone` in `~/.pi/agent/pi-queue.json`**, absent/true = on, false = off.
It is global, not per-home-chat: this is the same switch pi-queue's wake-on-done and queue-block lead reminders
honour. False suppresses **every** stall message, including the COO owner step; there is no per-chat override
or bypass. With it off the step is `wakes-off`, sends nothing and the chain moves on after the gap. A role without
a home chat is `no-chat` and moves on likewise. Ordinary role messages do not otherwise read this switch.
Paused, needs-you, done, dropped and actively waiting items are filtered out by the rules before delivery.

The check never starts, unpauses, approves, completes or changes work; no queue/registry writes; no model;
no message straight to the owner. The Roles page stays unchanged. Its record reader recognises wait/resume
as known events without adding any fields there.
