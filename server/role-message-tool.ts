// ---------------------------------------------------------------------------
// role-message-tool.ts — message_role: a role chat messages another role (role-messages.ts)
// ---------------------------------------------------------------------------
// Registered in every pi-engine chat; pi-identity offers it only in chats that have a role (its
// role-only tools), and this tool refuses a chat without one, and helper chats (subagents). The sender
// is the calling chat's role as the server knows it — the model only says to whom, what kind and what.
// ---------------------------------------------------------------------------

import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { MESSAGE_ROLE_TOOL_NAME } from "./tool-manager.js";
import { ROLE_MESSAGE_TEXT_MAX, type RoleMessages, type RoleMessageSender } from "./role-messages.js";

export { MESSAGE_ROLE_TOOL_NAME };

/** Implemented by ClientSession (the chat this runtime belongs to). */
export interface MessageRoleHost {
	/** The sending chat as the server knows it; a string = why it can't send. */
	sender(): RoleMessageSender | string;
	/** The server's role message service (absent: not wired). */
	service(): RoleMessages | undefined;
}

export function makeMessageRoleTool(host: MessageRoleHost): ToolDefinition {
	return defineTool({
		name: MESSAGE_ROLE_TOOL_NAME,
		label: "Message another role",
		description:
			"Send a message to another role's chat (see the roles list in your role section): ask it a question, ask it to do work in its area (request), tell it something it should know (fyi), or answer a question or request you got (reply, with replyTo). " +
			"The server delivers it to that role's home chat after any running turn there, marked as from your role and this chat; a reply goes back to the chat that asked. " +
			"Answers arrive later as new messages in this chat: don't wait for them. Keep it self-contained (paths, ids; no secrets).",
		promptSnippet: "message another role's chat (question / request / fyi / reply); answers come later as new messages",
		parameters: Type.Object({
			to: Type.String({ description: "The receiving role's id (from the roles list in your role section)." }),
			kind: Type.String({
				description:
					'"question" (you need an answer), "request" (you ask it to do work in its area), "fyi" (no answer needed) or "reply" (your one answer to a question or request you got).',
			}),
			text: Type.String({
				description: `The message, self-contained: what you need or what changed, with paths and ids; at most ${ROLE_MESSAGE_TEXT_MAX} characters. No secrets.`,
			}),
			replyTo: Type.Optional(
				Type.String({
					description: 'kind "reply" only: the id of the message you answer (rm-…, from its first line).',
				}),
			),
		}),
		execute: async (_id, p, _signal, _onUpdate, _ctx) => {
			const service = host.service();
			if (!service) throw new Error("Role messages aren't available in this app.");
			const sender = host.sender();
			if (typeof sender === "string") {
				service.noteRefused(undefined, p.to, p.kind, sender);
				throw new Error(sender);
			}
			const res = service.send(sender, { to: p.to, kind: p.kind, text: p.text, replyTo: p.replyTo });
			if (!res.ok) {
				service.noteRefused(sender, p.to, p.kind, res.error);
				throw new Error(res.error);
			}
			const r = res.record;
			const answerComes =
				r.kind === "question" || r.kind === "request"
					? " The answer comes back to this chat as a new message: don't wait for it, carry on."
					: "";
			const text = res.paused
				? `Held ${r.id} (${r.kind} to ${r.to.role}): the owner has paused role messages. It is delivered once they are resumed.${answerComes}`
				: `Sent ${r.id} (${r.kind} to ${r.to.role}). It arrives in ${res.targetChat} after any running turn there.${answerComes}`;
			return {
				content: [{ type: "text", text }],
				details: { id: r.id, to: r.to.role, kind: r.kind, chain: r.chain, state: res.paused ? "held" : "waiting" },
			};
		},
	});
}
