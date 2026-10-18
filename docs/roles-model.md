# Roles: each role's model

Ops #204, second of the owner's "Finish Roles' easy gaps" tasks (2026-10-18). Accountable lead: Ops.

## H-ROLES-MODEL-1

**Wrong, and the evidence.** Every role panel's Model line said "Not connected yet": the view hard-coded it (`web/src/roles-exact-view.ts`, `model: MISSING` in `box()`). Yet the app knows each chat's model: an open chat's header shows its live model, and a chat's file records every model change.

**One change, and why it should fix it.** Project the home chat's current model in the Roles overview and show it:

- An open home chat: its live model (`agent.state.model.name`), the same value its chat header shows (`ClientSession.chatModelName`).
- A home chat that isn't open: the newest `model_change` entry in its file, named from the app's model list as a header would name it (`ClientSession.modelNameOf`, a lookup in an open chat's model list). The overview already reads every home chat through `TranscriptScans` (once, then only the bytes added since), so it now also keeps the newest model change's provider and model id from those lines. No new file read, no message text.
- Sent as an optional `UiRoleOverview.model` (the display name, at most 120 characters, no control characters). No protocol bump.
- The panel's Model line shows it; absent (no home chat, no recorded change, a model the app no longer knows, an older server) it says "Not recorded".
- Only the model name: thinking level and account slot are left out unless the app's name already includes them.

**Expected result, and how it is measured.** The Ops panel's Model line shows the same model as the Ops chat header at the same moment; a role without a home chat says "Not recorded". Measured by unit tests on fixed transcripts (open chat, two changes where the newest wins, a change added later, none) and one look-only live screenshot after install.

**What would prove it wrong.** The panel's model differs from the chat header's, or a chat whose model changed still shows the old one.

**Limits.** The overview loads no chat, calls no model and writes nothing; it reads only model change entries, never message contents. No chat's model is changed. A chat that isn't open shows the newest change in its file; if an "all chats" model press reaches it only when it is next opened, the panel follows once it is open. Minimal checks (owner, Oct 17: "build ship it, only test minimally").

**Result:**
