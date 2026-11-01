/**
 * grant-card-brief (Ops #683; owner, 2026-10-31 via COO rm-d2c1f9b2: every card that reaches him opens with plain
 * context): the plain brief a continuation-grant card opens with. A role asks to keep messaging another role past
 * the chain's free limit and the request climbs to the owner; the brief says who asks and to whom, what for, why it
 * needs more messages, what happens next if he allows it, and what each answer does.
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
	GIVES_SECOND,
	GIVES_THIRD,
	plainSentence,
	plainWords,
	shown,
} from "./owner-card-brief.js";
import type { UiOwnerCardBriefLine } from "./protocol.js";

export interface GrantCardBriefInput {
	/** The asking role, by the name the owner knows it by. */
	requester: string;
	/** The roles it wants to keep messaging, by name. */
	recipients: readonly string[];
	/** How many messages the chain has had: the request is to go past this one. */
	pastMessage: number;
	/** How many more sends "Allow N" gives. */
	quantity: number;
	/** The requester's own words (only these three are used). */
	context: { goal?: string; whyNeeded?: string; nextStepAndOutcome?: string };
}

const LABEL = {
	who: "Who asks",
	what: "What for",
	why: "Why more messages",
	next: "If you allow it",
	answers: "Your answers",
} as const;

/** A part the requester gave no plain sentence for (only ids or paths, or a word or two). */
const NOT_SAID = "Not said in plain words.";
/** How many recipients are named before "and N more". */
const NAMED = 3;

/** The lines of a continuation-grant card's plain brief, at most BRIEF_MAX characters as "Label: text" lines. */
export function grantCardBrief(input: GrantCardBriefInput): UiOwnerCardBriefLine[] {
	const requester = flex(plainWords(input.requester) || "A role", 12, GIVES_THIRD);
	const recipients = input.recipients.map((r) => flex(plainWords(r) || "another role", 12, GIVES_THIRD));
	const goal = flex(plainSentence(input.context.goal, 2), 24, GIVES_SECOND);
	const why = flex(plainSentence(input.context.whyNeeded, 2), 24, GIVES_SECOND);
	const next = flex(plainSentence(input.context.nextStepAndOutcome, 2), 24, GIVES_FIRST);
	const quantity = Math.max(1, Math.floor(input.quantity));
	const past = Math.max(0, Math.floor(input.pastMessage));

	const said = (f: typeof goal) => (f.text ? closed(shown(f)) : NOT_SAID);
	const whom = (): string => {
		const names = recipients.slice(0, NAMED).map(shown);
		const more = recipients.length - names.length;
		if (more > 0) return `${names.join(", ")} and ${more} more`;
		return names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}` : (names[0] ?? "another role");
	};
	const lines = (): UiOwnerCardBriefLine[] => [
		{
			label: LABEL.who,
			text: `${shown(requester)} wants to keep messaging ${whom()}, past message ${past} of one chain of messages.`,
		},
		{ label: LABEL.what, text: said(goal) },
		{ label: LABEL.why, text: said(why) },
		{ label: LABEL.next, text: said(next) },
		{
			label: LABEL.answers,
			// Named as the card's buttons are (role-message-guard-approvals.ts); the grant lasts one hour (the contract).
			text:
				"\u201CDeny\u201D: no more messages in this chain. \u201CAllow one send\u201D: one more message. " +
				`\u201CAllow up to ${quantity} sends\u201D: up to ${quantity} more, for the hour the grant lasts.`,
		},
	];
	return fitBrief([goal, why, next, requester, ...recipients], lines);
}
