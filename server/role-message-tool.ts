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
import {
	ROLE_MESSAGE_TEXT_MAX,
	SAME_TEXT_ROLES,
	SAME_TEXT_WINDOW_MS,
	type RoleMessages,
	type RoleMessageSender,
} from "./role-messages.js";
import { BOARD_ROUTING_RULE } from "./board-tool.js";
import type { RoleMessageGuardHost } from "./role-message-guard-host.js";

/** board (task #76): what message_role's result adds when the same text went to several roles. */
export function sameTextHint(roles: readonly string[]): string {
	if (roles.length < SAME_TEXT_ROLES) return "";
	return `\nThe same text went to ${roles.length} roles in the last ${Math.round(SAME_TEXT_WINDOW_MS / 60_000)} minutes (${roles.join(", ")}): to tell several roles the same general info, post it once on the board instead (board, action post, kind news).`;
}

export { MESSAGE_ROLE_TOOL_NAME };

/** Implemented by ClientSession (the chat this runtime belongs to). */
export interface MessageRoleHost {
	/** The sending chat as the server knows it; a string = why it can't send. */
	sender(): RoleMessageSender | string;
	/** The server's role message service (absent: not wired). */
	service(): RoleMessages | undefined;
	/** role-message-ladder: the approval ladder (absent: native depth-6 rule). */
	guard?(): RoleMessageGuardHost | undefined;
}

export function makeMessageRoleTool(host: MessageRoleHost): ToolDefinition {
	return defineTool({
		name: MESSAGE_ROLE_TOOL_NAME,
		label: "Message another role",
		description:
			"Message another role's chat: a question, a request (work in its area), an fyi, or a reply (replyTo) to one you got. " +
			"It lands in that role's home chat after any running turn, marked as from you; a reply goes to the chat that asked. " +
			"A question, request or reply starts a turn there; an fyi doesn't (it is read with that chat's next message). " +
			"Answers come later as new messages. No secrets. " +
			`${BOARD_ROUTING_RULE} ` +
			"So direct messages go here; to tell several roles the same general info, post it on the board. " +
			"Messages 1 to 6 in one chain go freely; 7 to 11 need the COO's grant and 12 or more the owner's " +
			"(the tool says so and how to ask, with the approval parameter).",
		promptSnippet: "message another role's chat (question / request / fyi / reply); answers come later as new messages",
		parameters: Type.Object({
			to: Type.Optional(
				Type.String({ description: "The receiving role's id (from the roles list in your role section)." }),
			),
			kind: Type.Optional(
				Type.String({
					description:
						'"question" (you need an answer), "request" (you ask it to do work in its area), "fyi" (no answer needed) or "reply" (your one answer to a question or request you got).',
				}),
			),
			text: Type.Optional(
				Type.String({
					description: `The message, self-contained: what you need or what changed, with paths and ids; at most ${ROLE_MESSAGE_TEXT_MAX} characters. No secrets.`,
				}),
			),
			replyTo: Type.Optional(
				Type.String({
					description: 'kind "reply" only: the id of the message you answer (rm-…, from its first line).',
				}),
			),
			initiative: Type.Optional(
				Type.String({
					description:
						'Optional: the initiative it belongs to, a short id (lowercase letters, digits, dashes; at most 60; like "team-in-temper"). A reply without one keeps its original\'s.',
				}),
			),
			grant: Type.Optional(
				Type.String({
					description:
						"Only when the tool asks for it: the grant id to use (a single matching grant is used by itself).",
				}),
			),
			approval: Type.Optional(
				Type.Object(
					{
						action: Type.String({
							description: '"request" (ask for a grant), "status" (one request) or "decide" (you are the approver).',
						}),
						requestId: Type.Optional(Type.String({ description: "status/decide: the request id (cr-…)." })),
						generation: Type.Optional(Type.String({ description: 'status/decide: its generation (default "1").' })),
						choice: Type.Optional(
							Type.String({
								description:
									'decide: "deny", "one_send", "requested_quantity", or "escalate_owner" (pass it to the owner, once).',
							}),
						),
						reason: Type.Optional(Type.String({ description: "decide: why, in one sentence." })),
						recipients: Type.Optional(
							Type.Array(Type.String(), { description: "request: the role ids you need to message." }),
						),
						participants: Type.Optional(
							Type.Array(Type.String(), {
								description: "request: other roles that may send in this chain under the grant.",
							}),
						),
						quantity: Type.Optional(
							Type.Number({ description: "request: sends needed, 1 to 5 (capped at message 11 for the COO)." }),
						),
						context: Type.Optional(
							Type.Object(
								{},
								{
									additionalProperties: true,
									description:
										"request: goal, progressAndChanges, whyNeeded, nextStepAndOutcome, timeCostRisk, exactCommunicationAuthority (strings); priorDecisions, declaredClaims (lists); outstandingQuestions (1+), optionsAndTradeoffs (2+), safetyScopeAndHolds (1+) (lists). All needed; at most 16 KB.",
								},
							),
						),
					},
					{ description: "Approvals for messages 7 and above in one chain. With it, to/kind/text aren't needed." },
				),
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
			const guard = host.guard?.();
			if (p.approval) {
				if (!guard || guard.state.status !== "ready") {
					const why =
						"Approvals are unavailable right now (the ladder is off); messages 7 and above can't be sent. Ask the owner how to go on.";
					service.noteRefused(sender, p.to, "approval", why);
					throw new Error(why);
				}
				const out = await guard.approval(sender, p.approval, _id);
				if (!out.ok) {
					service.noteRefused(sender, p.to, "approval", out.text);
					throw new Error(out.text);
				}
				return { content: [{ type: "text", text: out.text }], details: out.details ?? {} };
			}
			const input = { to: p.to, kind: p.kind, text: p.text, replyTo: p.replyTo, initiative: p.initiative };
			const res = guard ? await guard.send(sender, { ...input, grant: p.grant }, _id) : service.send(sender, input);
			if (!res.ok) {
				service.noteRefused(sender, p.to, p.kind, res.error);
				const need = (res as { approvalRequired?: { hop: number; tier: "lower" | "owner"; approver: string } })
					.approvalRequired;
				if (need)
					return { content: [{ type: "text", text: res.error }], details: { state: "approval_required", ...need } };
				throw new Error(res.error);
			}
			const r = res.record;
			const sameText = sameTextHint(service.sameTextRecipients(sender.role, r.text));
			const answerComes =
				r.kind === "question" || r.kind === "request"
					? " The answer comes back to this chat as a new message: don't wait for it, carry on."
					: "";
			const text = res.paused
				? `Held ${r.id} (${r.kind} to ${r.to.role}): the owner has paused role messages. It is delivered once they are resumed.${answerComes}`
				: r.kind === "fyi"
					? `Sent ${r.id} (fyi to ${r.to.role}). It's added to ${res.targetChat} without starting a turn; that chat reads it with its next message.`
					: `Sent ${r.id} (${r.kind} to ${r.to.role}). It arrives in ${res.targetChat} after any running turn there.${answerComes}`;
			return {
				content: [{ type: "text", text: text + sameText }],
				details: {
					id: r.id,
					to: r.to.role,
					kind: r.kind,
					chain: r.chain,
					state: res.paused ? "held" : "waiting",
					...(r.initiative ? { initiative: r.initiative } : {}),
				},
			};
		},
	});
}
