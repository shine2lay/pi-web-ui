# Metadata-only participant routes (local fork capability)

`host.participantRoutes?.()` returns `{ sessionId, conversationId, role, isHome, busy }[]`
for loaded, identified, durable native Pi conversations across clients. Exact Pi
session IDs identify the chat, not browser conversation IDs, process IDs, aliases
or the currently selected chat. `conversationId` is only there so a plugin can
tie a run event to its chat: it is the same value `PluginRunEvent.conversationId`
carries. It is process-local (it changes when the chat is reloaded or the server
restarts), so match it against the current routes only, never store it as an
identity. Transient/ephemeral/unidentified/replaced sessions and
conflicting identities are excluded. Home status compares the trusted identity
registry’s existing home route with the exact session file, without returning
its path. No histories, titles, working directories, prompts, private memories,
transcripts, credentials or files are exposed.

This capability is a read-only route chooser input, not authority to enroll,
start, approve or resume anything. The calling plugin must revalidate the choice
when committing an owner action; absence or ambiguity must fail closed. DSH and
older hosts return no routes. No identity metadata is rewritten or new chat
created by this API.

The Company Team plugin in the separate pi-company repository uses the existing
view, HTTP-route and message-widget APIs. This host patch does not install or
activate it. No composer Plan Board, ordinary user-message behavior or existing
queues are changed.
