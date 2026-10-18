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

**Result: HIT** (2026-10-18 09:41 PDT, installed d0e58939; pi-web-deploy checks server, page, reply, bigchat and log all passed).

- Look-only live check (`~/kept-from-tmp/2026-10-18/roles-model-live/look.mjs`, own carry-on clients; the Roles page sent only hello and roles_watch). The Ops panel's Model line said "Model: Claude Opus 5.5 (#4)" in readings taken before and after opening the Ops chat, and the Ops chat's own model label (its input bar's model chip) said "Claude Opus 5.5 (#4)": the same.
- The Ops home chat's newest recorded model change is anthropic-4/claude-opus-5-5 (91 recorded), which the app names "Claude Opus 5.5 (#4)". The "(#4)" is the account slot; it shows because the app's own model name includes it.
- All 15 roles have a home chat with a known model right now, and all show "Claude Opus 5.5 (#4)". So "Not recorded" (no home chat, no recorded change, a model the app doesn't know) could not be seen live; the unit tests cover it, and a chat whose model changes later (the newest change wins, read from the added bytes).
- No page errors.
