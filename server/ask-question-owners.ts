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
 * A split call's tool result has no `details.answers`: decision-records.ts backfill then makes no record mixing the
 * owners (the live per-owner records stand).
 */
import { stoppedError } from "./ask-abort.js";
import { isQuestionReturned, type QuestionReturned, questionReturnedText } from "./owner-question-router.js";
import { chatPersonOf, DEFAULT_REQUESTER, requesterName } from "./owner-requester.js";
import type { QuestionAnswer, UiQuestion, UiTaskRequester } from "./protocol.js";

/** What one owner's dialog came back with: answers, cancelled (null) or handed back by COO. */
export type OwnerAskResult = QuestionAnswer[] | QuestionReturned | null;

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

/** The tool result handed back to the model. */
export interface AskToolResult {
	content: { type: "text"; text: string }[];
	details?: unknown;
}

const CANCELLED = "User cancelled the question.";
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

const labelOf = (q: UiQuestion | undefined, id: string) => q?.header ?? q?.id ?? id;

function answerLine(q: UiQuestion | undefined, a: QuestionAnswer): string {
	const label = a.selected.join(", ");
	const custom = a.custom?.trim() ? ` (wrote: ${a.custom.trim()})` : "";
	return `${labelOf(q, a.id)}: ${label || "(no selection)"}${custom}`;
}

/** One owner's result as before Ops #1079: cancelled throws, COO's hand-back is its note, answers are lines. */
function singleOwnerResult(questions: readonly UiQuestion[], result: OwnerAskResult): AskToolResult {
	if (result === null) throw new Error(CANCELLED);
	// owner-question routing (Ops #685): COO handed it back; the call ends with that, never as his answer.
	if (isQuestionReturned(result)) return { content: [{ type: "text", text: questionReturnedText(result.returned) }] };
	const lines = result.map((a) =>
		answerLine(
			questions.find((q) => q.id === a.id),
			a,
		),
	);
	return { content: [{ type: "text", text: lines.join("\n") }], details: { answers: result } };
}

type SliceOutcome = { slice: OwnerSlice; result?: OwnerAskResult; error?: Error };

/** Several owners' results, in the call's question order, each line marked with its owner. */
function splitResult(questions: readonly UiQuestion[], outcomes: SliceOutcome[]): AskToolResult {
	const answeredOrReturned = outcomes.some((o) => o.result !== undefined && o.result !== null);
	if (!answeredOrReturned) throw outcomes.find((o) => o.error)?.error ?? new Error(CANCELLED);
	const lines: string[] = [];
	for (const q of questions) {
		const o = outcomes.find((x) => x.slice.questions.includes(q))!;
		const tag = `[For ${o.slice.owner}] ${labelOf(q, q.id)}`;
		if (o.error) lines.push(`${tag}: (not asked: ${o.error.message})`);
		else if (o.result === null) lines.push(`${tag}: (cancelled; ${o.slice.owner}'s dialog was closed)`);
		else if (isQuestionReturned(o.result)) lines.push(`${tag}: (handed back by COO, see below)`);
		else {
			const a = o.result?.find((x) => x.id === q.id);
			if (a) lines.push(`[For ${o.slice.owner}] ${answerLine(q, a)}`);
		}
	}
	for (const o of outcomes)
		if (isQuestionReturned(o.result)) lines.push(`For ${o.slice.owner}: ${questionReturnedText(o.result.returned)}`);
	const owners = outcomes.map((o) => ({
		owner: o.slice.owner,
		questionIds: o.slice.questions.map((q) => q.id),
		...(o.error ? { error: o.error.message } : {}),
		...(o.result === null ? { cancelled: true } : {}),
		...(isQuestionReturned(o.result) ? { returned: o.result.returned } : {}),
		...(Array.isArray(o.result) ? { answers: o.result } : {}),
	}));
	return { content: [{ type: "text", text: lines.join("\n") }], details: { owners } };
}

/**
 * The tool's run after its count checks: each question's owner (refusing before anything is shown), then one dialog
 * per owner, side by side; `ask` shows one owner's dialog under the given tool call id and waits for it. One owner:
 * exactly the old call and result. Several: a cancelled or failed dialog leaves the others' answers standing.
 */
export async function askQuestionsByOwner(
	questions: readonly UiQuestion[],
	data: QuestionOwnerData,
	toolCallId: string,
	ask: (slice: OwnerSlice, toolCallId: string) => Promise<OwnerAskResult>,
): Promise<AskToolResult> {
	const slices = planOwnerSlices(questions, data);
	if (slices.length === 1) return singleOwnerResult(questions, await ask(slices[0]!, toolCallId));
	const settled = await Promise.allSettled(slices.map((s) => ask(s, sliceToolCallId(toolCallId, s.owner))));
	const outcomes = settled.map((r, i): SliceOutcome => {
		const slice = slices[i]!;
		if (r.status === "fulfilled") return { slice, result: r.value };
		return { slice, error: r.reason instanceof Error ? r.reason : new Error(String(r.reason)) };
	});
	// stop-cancels-ask (Ops #1085): Stop closed every owner's open dialog; the call ends as stopped.
	const stopped = stoppedError(outcomes.map((o) => o.error));
	if (stopped) throw stopped;
	return splitResult(questions, outcomes);
}
