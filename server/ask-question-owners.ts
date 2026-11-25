/**
 * ask-question-owners (Ops #1079; Wai 2026-11-22 via Backend rm-8b704195, decision dr-1452e9e255d8): each
 * ask_user_question question goes to its own owner, read from data, and one dialog never carries two owners' questions.
 *
 * Before this, a call made one ask stamped with its chat's person, and a turn holding typed messages from both Shine and
 * Wai took the newest one's (owner-requester.ts requesterPersonOf, kept as is): "Shine: RollCall cleanup" went to Wai.
 * Now:
 * - a question's owner is its optional `owner` (Shine, or a person people.json lists), else the turn's one owner
 *   (owner-requester.ts chatPersonOf over the server-stamped turn and task records), never a guess in a mixed turn;
 * - refused before anything is shown: an unknown `owner`; an untagged question in a turn with work for several owners;
 *   a question that addresses another owner by name ("Wai: ...", "For Shine:") than the one it is for; a `dependsOn`
 *   across owners (each owner's dialog is separate);
 * - questions for several owners become one ask per owner, asked side by side: each with its owner's requester (its
 *   own windows; Telegram only for Shine's, owner-requester.ts reachesOwnerChannels), and its own decision record (the
 *   ask's tool call id gets `#<owner>`, so decision-records.ts answerRef differs per owner).
 * nonblocking-ask (Ops #1087): each owner's card is posted and the call returns at once (pending-questions-runtime.ts);
 * its result has no `details.answers`, each answer reaches the chat later as that owner's message.
 */
import { chatPersonOf, DEFAULT_REQUESTER, requesterName } from "./owner-requester.js";
import type { UiQuestion, UiTaskRequester } from "./protocol.js";

/** What a chat's question owners are read from: its running turn's and own task's requester records (server-stamped,
 *  never the model's words) and the names people.json lists besides the default owner. */
export interface QuestionOwnerData {
	turn?: UiTaskRequester;
	taskOrigin?: UiTaskRequester;
	listed: ReadonlySet<string>;
}

/** One owner's dialog: that owner's questions in call order, and the ask's requester (none for the default owner). */
export interface OwnerSlice {
	owner: string;
	requester?: string;
	questions: UiQuestion[];
}

const SLICE_MARK = "#";

/** The owners a question may name: the default owner, then people.json's other names. */
export function knownOwnerNames(listed: ReadonlySet<string>): string[] {
	return [DEFAULT_REQUESTER, ...[...listed].filter((name) => name !== DEFAULT_REQUESTER).sort()];
}

/** The distinct owners a turn carries work for: its owner and role inputs (else its task's), unknown ones skipped. */
export function turnOwnersOf(turn: UiTaskRequester | undefined, taskOrigin: UiTaskRequester | undefined): string[] {
	const knownInputs = (r: UiTaskRequester | undefined) =>
		r?.inputs.flatMap((input) => (input.kind === "unknown" ? [] : [input])) ?? [];
	const inputs = knownInputs(turn).length ? knownInputs(turn) : knownInputs(taskOrigin);
	return [...new Set(inputs.map((input) => requesterName(input.person)))];
}

function refused(why: string): Error {
	return new Error(`ask_user_question refused, nothing was shown: ${why}`);
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

/** Owners a question's header or text opens by addressing: "Wai: ...", "**Shine,** ...", "For Wai: ...". */
export function addressedOwners(q: Pick<UiQuestion, "header" | "question">, known: readonly string[]): string[] {
	return known.filter((name) => {
		const opener = new RegExp(`^[\\s*_#>]*(?:for\\s+)?${escapeRe(name)}[\\s*_]*[:,]`, "iu");
		return [q.header, q.question].some((text) => !!text && opener.test(text));
	});
}

/** Each question's owner, checked; throws (before anything is shown) on anything that leaves it in doubt. */
export function questionOwnersOf(questions: readonly UiQuestion[], data: QuestionOwnerData): string[] {
	const known = knownOwnerNames(data.listed);
	const turnOwners = turnOwnersOf(data.turn, data.taskOrigin);
	const turnOwner = requesterName(chatPersonOf(data.turn, data.taskOrigin));
	const owners = questions.map((q) => {
		let owner: string;
		if (q.owner !== undefined) {
			if (!known.includes(q.owner))
				throw refused(
					`question "${q.id}" has owner ${JSON.stringify(q.owner)}, who is not an owner. Use one of: ${known.join(", ")}.`,
				);
			owner = q.owner;
		} else if (turnOwners.length > 1) {
			throw refused(
				`question "${q.id}" has no owner, and this turn carries work for ${turnOwners.join(", ")}. Set "owner" on ` +
					`every question (one of: ${known.join(", ")}); questions for different owners become separate dialogs.`,
			);
		} else owner = turnOwner;
		const other = addressedOwners(q, known).find((name) => name !== owner);
		if (other)
			throw refused(
				`question "${q.id}" is addressed to ${other} but would go to ${owner}` +
					`${q.owner === undefined ? " (this turn's owner)" : ""}. Set owner: "${other}" if it is ${other}'s.`,
			);
		return owner;
	});
	questions.forEach((q, i) => {
		const dep = q.dependsOn?.questionId;
		const j = dep === undefined ? -1 : questions.findIndex((p) => p.id === dep);
		if (j >= 0 && owners[j] !== owners[i])
			throw refused(
				`question "${q.id}" (for ${owners[i]}) depends on "${dep}" (for ${owners[j]}); each owner gets a separate ` +
					"dialog, so a question can depend only on one for the same owner.",
			);
	});
	return owners;
}

/** The call's dialogs: one per owner, in order of each owner's first question. Throws as questionOwnersOf does. */
export function planOwnerSlices(questions: readonly UiQuestion[], data: QuestionOwnerData): OwnerSlice[] {
	const owners = questionOwnersOf(questions, data);
	const slices = new Map<string, OwnerSlice>();
	questions.forEach((q, i) => {
		const owner = owners[i]!;
		let slice = slices.get(owner);
		if (!slice) {
			slice = { owner, ...(owner === DEFAULT_REQUESTER ? {} : { requester: owner }), questions: [] };
			slices.set(owner, slice);
		}
		slice.questions.push(q);
	});
	return [...slices.values()];
}

/** A split call's per-owner tool call id (its ask's decision-record ref is `ask:<id>#<owner>`). */
export function sliceToolCallId(toolCallId: string, owner: string): string {
	return `${toolCallId}${SLICE_MARK}${owner}`;
}

/** The transcript's tool call id of an ask's (possibly per-owner) tool call id. */
export function toolCallIdOfSlice(id: string): string {
	const at = id.indexOf(SLICE_MARK);
	return at < 0 ? id : id.slice(0, at);
}
