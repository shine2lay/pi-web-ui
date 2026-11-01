/**
 * grant-card-brief (Ops #683; owner, 2026-10-31 via COO rm-d2c1f9b2: every card that reaches him opens with plain
 * context): the plain brief a continuation-grant card opens with. A role asks to keep messaging other roles past
 * the chain's free limit and the request climbs to the owner; the brief says who asks, with whom, who may send
 * under the grant, the requester's goal, reason and plan in its own words, and what each answer does.
 *
 * Built from the stored request alone (its binding and the requester's own context), no model (rule 17), with the
 * plain-words helpers and the fit of the queue cards' brief (owner-card-brief.ts). Display only: it is not part of
 * the owner question, its choices or their digest, and nothing reads it back.
 */
import {
	closed,
	fitBrief,
	flex,
	GIVES_FIRST,
	GIVES_THIRD,
	plainSentence,
	plainWords,
	shown,
} from "./owner-card-brief.js";
import type { UiOwnerCardBriefLine } from "./protocol.js";

/**
 * Who may send under the grant (the binding's task, as the host's grant check reads it): asked from its home chat,
 * any named role's home chat may send to any other named role, sharing one quantity; asked from a task's chat, only
 * that task; asked from another chat, only that chat.
 */
export type GrantSenders = "any named role" | "the asking task" | "the asking chat";

export interface GrantCardBriefInput {
	/** The asking role, by the name the owner knows it by. */
	requester: string;
	/** The other roles named in the request, by name. */
	recipients: readonly string[];
	/** Who may send under the grant. */
	senders: GrantSenders;
	/** How many messages the chain has had: the request is to go past this one. */
	pastMessage: number;
	/** How many more sends it asks for (what "Allow up to N sends" gives). */
	quantity: number;
	/** The requester's own words (only these three are used). */
	context: { goal?: string; whyNeeded?: string; nextStepAndOutcome?: string };
}

/** The parts of a stored request's binding the brief reads (role-message-guard-contract.ts GuardApprovalBinding). */
export interface GrantRequestFacts {
	requester: { role: string };
	scope: { recipients: readonly string[]; task: { kind: "home" | "task" | "other" } };
	causal: { nextHop: number };
	quantity: number;
}

const LABEL = {
	who: "Who asks",
	goal: "Its goal",
	reason: "Its reason",
	plan: "Its plan if allowed",
	answers: "Your answers",
} as const;

/** A part the requester gave no plain sentence for (only ids or paths, or a word or two). */
const NOT_SAID = "Not said in plain words.";
/** How many roles are named before "and N more". */
const NAMED = 3;

/**
 * The brief of a stored request: its binding (who asks, the other named roles, who may send, past which message,
 * how many) and the requester's context. `name` gives a role's display name.
 */
export function grantRequestBrief(
	binding: GrantRequestFacts,
	context: GrantCardBriefInput["context"],
	name: (role: string) => string,
): UiOwnerCardBriefLine[] {
	const requester = binding.requester.role;
	// The scope names the requester too (so answers can come back); the brief names the others.
	const others = binding.scope.recipients.filter((r) => r !== requester);
	const kind = binding.scope.task.kind;
	return grantCardBrief({
		requester: name(requester),
		recipients: (others.length ? others : binding.scope.recipients).map(name),
		senders: kind === "home" ? "any named role" : kind === "task" ? "the asking task" : "the asking chat",
		pastMessage: binding.causal.nextHop - 1,
		quantity: binding.quantity,
		context,
	});
}

/** The lines of a continuation-grant card's plain brief, at most BRIEF_MAX characters as "Label: text" lines. */
export function grantCardBrief(input: GrantCardBriefInput): UiOwnerCardBriefLine[] {
	const requester = flex(plainWords(input.requester) || "A role", 12, GIVES_THIRD);
	const recipients = input.recipients.map((r) => flex(plainWords(r) || "another role", 12, GIVES_THIRD));
	// Its goal, reason and plan give in the same turn, so the longest is cut first and each keeps a fair share.
	const goal = flex(plainSentence(input.context.goal, 2), 24, GIVES_FIRST);
	const reason = flex(plainSentence(input.context.whyNeeded, 2), 24, GIVES_FIRST);
	const plan = flex(plainSentence(input.context.nextStepAndOutcome, 2), 24, GIVES_FIRST);
	const quantity = Math.max(1, Math.floor(input.quantity));
	const past = Math.max(0, Math.floor(input.pastMessage));

	const said = (f: typeof goal) => (f.text ? closed(shown(f)) : NOT_SAID);
	const whom = (): string => {
		const names = recipients.slice(0, NAMED).map(shown);
		const more = recipients.length - names.length;
		if (more > 0) return `${names.join(", ")} and ${more} more`;
		return names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}` : (names[0] ?? "another role");
	};
	const howMany = quantity === 1 ? "one more message" : `up to ${quantity} more messages`;
	// Says exactly who may send under it (Security rm-51d83b8e, L3): from home chats, any of the named roles.
	const who = (): string => {
		const asker = shown(requester);
		const chain = `a chain with ${whom()} past message ${past}`;
		if (input.senders === "any named role")
			return `${asker} asks to continue ${chain}: ${howMany} among them, sent by any of them.`;
		if (input.senders === "the asking task")
			return `${asker} asks from one of its tasks to continue ${chain}: ${howMany}, sent only by that task.`;
		return `${asker} asks from one of its chats to continue ${chain}: ${howMany}, sent only from that chat.`;
	};
	const lines = (): UiOwnerCardBriefLine[] => [
		{ label: LABEL.who, text: who() },
		// The requester's own words, labelled as its (Security rm-112648e9, L2), not stated as facts.
		{ label: LABEL.goal, text: said(goal) },
		{ label: LABEL.reason, text: said(reason) },
		{ label: LABEL.plan, text: said(plan) },
		{
			label: LABEL.answers,
			// Named as the card's buttons are (role-message-guard-approvals.ts); the grant lasts one hour (the contract).
			text:
				"\u201CDeny\u201D: no more messages in this chain. \u201CAllow one send\u201D: one more message. " +
				`\u201CAllow up to ${quantity} sends\u201D: up to ${quantity} more, for the hour the grant lasts.`,
		},
	];
	return fitBrief([plan, goal, reason, requester, ...recipients], lines);
}
