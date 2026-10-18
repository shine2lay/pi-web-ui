# Roles: how far the owner's messages to roles got

## H-ROLES-TRACKER-1

**Wrong and evidence.** The Roles page's "Your questions" area says "Contact and reply tracking are not connected yet." The owner cannot see whether a message he sent to a role reached its chat, got a reply, or (from Telegram) whether that reply came back to his Telegram. Architecture's source audit (`roles-data-steps-2026-10-17.md`, part D3) found the gap: the role-to-role mail record already proves delivery and reply, but the owner's own messages leave no durable record. The turn that takes one is known only in memory, and the Telegram plugin only logs its send result.

**One change and why.** Record the owner's own messages to a role's home chat as small display-only events in one append-only file: asked (the app admitted it, browser or Telegram), in its chat (pi took it into a turn of that chat), replied (that turn settled with text, without text, or failed) and, for Telegram, sent (the plugin's own send result, through a new optional `host.roles.noteSent`). The app already knows each of these facts at the moment it happens; this keeps them instead of dropping them. No model call and no language reading.

**Meaning.** A stage without a record shows "not recorded", never "didn't happen". "Failed" appears only with a failure record. A browser reply shows "in the chat" with no claim that he read it. A question mark doesn't make a message a question: every owner message to a role is listed. Same-UID files can be forged, so nothing here grants, routes, counts or changes anything.

**Expected and measured.** Fixed cases: every event field is checked and anything malformed is dropped; the first record of each stage wins; a send result counts only for a Telegram message; contacts older than 90 days drop out; stages of unknown contacts and torn lines are skipped; the file is 0600; a restarted store keeps the earlier contacts; the page keeps only well-formed contacts and never invents a stage. Live: after install, a new message from the owner to a role shows asked, then in its chat, then replied (and, from Telegram, sent).

**Falsifier.** Any stage shown that has no record, a "failed" without a failure record, a browser reply claimed as delivered, a non-owner input (another role, the scheduler, a plugin, a carry-on) listed as his, or any change to routing, delivery, queue or permissions disproves it.

## Scope and rollout

- Store `<dataDir>/owner-contacts.jsonl`: append-only, 0600, one event per line; ids and times plus short excerpts (his message at most 280 characters, the reply at most 1,200) for his own Roles page. Compacted to the 90-day window past 4 MB; not read past 32 MB.
- Owner inputs only: the same admitted-input record the requester display uses (browser input of an accepted non-pseudo client; Telegram sends through `host.roles.send`). Other roles' mail stays in its own record.
- `server/plugins.ts` and the Telegram plugin change by additions only; the routing guard is re-pinned with that reason.
- The owner asked for minimal checks: one focused unit file, the build, the landing gate, then one read-only smoke. No end-to-end model trial.
- Undo: revert this patch and deploy the earlier build. The file may remain; nothing reads it then.

## Result

Landed as 8f617039 (landing gate 415 files, 6,044 tests passed, 6 skipped) and live since 2026-10-18 01:25 PDT; all install checks passed. Look-only smoke at 01:37: the overview carries an empty contacts list and "Your messages" shows "No messages from you to a role in the last 90 days." instead of "not connected yet"; no page errors. The scheduler's own prompt (a pseudo client) recorded nothing, as intended. Display wiring: HIT. The live stage sequence waits on the owner's first message to a role after the install.

Follow-up (H-ROLES-TRACKER-1a): the page footer still said "lane and message tracking are not connected yet", which is now false for messages. One change: the footer says only "Missing data is marked as not recorded." Expected: no footer text claims a connected feed is missing. Wrong if any remaining footer text names message tracking as not connected.
