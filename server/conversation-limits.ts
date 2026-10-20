/** Open regular chats per project (both engines), not a work/queue concurrency limit. Blank chats don't take
 *  a slot (chat-slots, server/chat-slots.ts countsTowardCap). Owner, 2026-10-19: "raise it to 40". */
export const MAX_OPEN_CONVERSATIONS = 40;
