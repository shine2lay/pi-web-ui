/**
 * home-chat-rename.ts — home-chat-no-rename (Ops #1007). Owner 2026-11-18 (Data home chat m05309): "can you remove
 * the chat renaming tool from leads? i dont like that my lead sometimes change the chat name". A role's home chat
 * is neither taught [[conv:rename:...]] nor renamed by one; the manual rename and every other chat are unchanged.
 */

import { homeChatOf, identityRegistry } from "./identities.js";
import { RENAME_NAMESPACE } from "./markers/builtins/rename.js";

/** Is this transcript a role's home chat? identities.ts homeChatOf: the reader the chat list's homeChat flag uses. */
export function isHomeChatFile(file: string | undefined): boolean {
	return !!homeChatOf(file, identityRegistry().identities);
}

/** Adds the conv marker to a chat's disabled markers when the chat is a home chat. */
export function dropRenameInHomeChat(disabled: Set<string>, sessionFile: string | undefined): void {
	if (isHomeChatFile(sessionFile)) disabled.add(RENAME_NAMESPACE);
}
