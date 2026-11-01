// ---------------------------------------------------------------------------------------------------------------
// owner-question-card.ts — the card COO's home chat gets for owner questions held for it (Ops #686)
// ---------------------------------------------------------------------------------------------------------------
//
// Text only, no state: owner-question-coo.ts decides what goes in a card and when. One card may carry
// several held questions; each says who asks, its kind and why it came to COO first, the question and
// its choices, #682's plain brief, when it goes to the owner unless COO acts, the actions, and the
// package last. Its quote stays intact in the transcript; OwnerQuestionBody folds each package
// independently in the page. COO is never offered a way to answer for the owner.

import { createHash } from "node:crypto";
import type { Ask, AskField } from "./asks.js";
import { briefText } from "./owner-card-brief.js";
import { cooReasonWords, type OwnerQuestionCooReason } from "./owner-question-route.js";
import { boardTime } from "./role-board.js";
import { statusHint } from "./turn-status.js";

/** The tool COO acts with (owner-question-tool.ts). */
export const OWNER_QUESTION_TOOL = "owner_question";
export const OWNER_QUESTION_CARD_HEAD = "[Owner question]";
/** First-line askers named before "and N more". */
const WHO_NAMED_MAX = 3;

/** Who asks: the asking chat's role (when it is a role's chat), which of its chats, and its task. */
export interface OwnerQuestionAsker {
	role?: { id: string; title: string };
	chat: "home" | "task" | "other";
	task?: { id: number; title?: string };
	/** The asking chat's title (defaults to the ask's). */
	title?: string;
}

/** One held question, as the card shows it. */
export interface CardQuestion {
	/** cardHandleOf(hold key): what COO names it by. */
	handle: string;
	ask: Ask;
	asker: OwnerQuestionAsker;
	reason: OwnerQuestionCooReason;
	/** For "owner-away": how long ago he last wrote in the asking chat, if known. */
	lastWroteAgoMs?: number;
	/** When it goes to the owner unless COO acts. */
	goesAt: number;
}

export interface CardOptions {
	/** Time zone of the deadline (the owner's). */
	tz?: string;
}

/** "oq-" and eight hex characters: the same for the same hold key (a queued task's card keeps it across restarts). */
export function cardHandleOf(holdKey: string): string {
	return `oq-${createHash("sha256").update(holdKey).digest("hex").slice(0, 8)}`;
}

const quoted = (t: string): string => `“${t}”`;

/** "Design's home chat", "Design's task #12 “New fonts”", "the chat “Scratch”". */
export function ownerQuestionWho(a: OwnerQuestionAsker): string {
	const title = a.title?.trim();
	if (a.role) {
		const whose = `${a.role.title}'s`;
		if (a.task) return `${whose} task #${a.task.id}${a.task.title ? ` ${quoted(a.task.title)}` : ""}`;
		if (a.chat === "home") return `${whose} home chat`;
		if (a.chat === "task") return `${whose} task chat`;
		return title ? `${whose} chat ${quoted(title)}` : `${whose} chat`;
	}
	if (a.task) return `task #${a.task.id}${a.task.title ? ` ${quoted(a.task.title)}` : ""}`;
	return title ? `the chat ${quoted(title)}` : "a chat";
}

function whoLine(q: CardQuestion): string {
	const a = q.asker;
	const title = (a.title ?? q.ask.conversationTitle)?.trim();
	const parts: string[] = [];
	if (a.role) parts.push(`${a.role.title} (${a.role.id})`);
	if (a.chat === "home") parts.push(title ? `its home chat ${quoted(title)}` : "its home chat");
	else if (a.chat === "task") parts.push("a task chat");
	else parts.push(title ? `the chat ${quoted(title)}` : "a chat");
	if (a.task) parts.push(`task #${a.task.id}${a.task.title ? ` ${quoted(a.task.title)}` : ""}`);
	return parts.join(" · ");
}

const KIND_WORDS: Record<Ask["kind"], string> = {
	question: "a question (ask_user_question)",
	dialog: "a pop-up the chat shows (such as a plan approval)",
	approval: "a tool approval",
	stuck: "a queued task's card (queue_stuck)",
};

function fieldLines(f: AskField, head: string, fields: readonly AskField[]): string[] {
	const out = [`${head}: ${f.text}${f.multi ? " (several may be picked)" : ""}`];
	const dependency = f.dependsOn;
	const prior = dependency ? fields.find((x) => x.id === dependency.questionId) : undefined;
	const priorName = prior ? quoted(prior.text) : quoted(dependency?.questionId ?? "the earlier question");
	if (dependency) {
		const values = dependency.value === undefined ? [] : [dependency.value].flat();
		out.push(
			values.length
				? `Shown when ${priorName} is ${values.map(quoted).join(" or ")}.`
				: `Shown after ${priorName} is answered.`,
		);
	}
	const options = (choices: AskField["options"]) =>
		choices.forEach((o, i) => out.push(`  ${i + 1}. ${o.label}${o.description ? ` (${o.description})` : ""}`));
	options(f.options);
	for (const [value, choices] of Object.entries(f.optionsMap ?? {})) {
		out.push(`When ${priorName} is ${quoted(value)}:`);
		options(choices);
	}
	if (f.allowText)
		out.push(f.options.length || Object.keys(f.optionsMap ?? {}).length ? "Or a typed answer." : "A typed answer.");
	return out;
}

/** The long text the question came with: the ask's body and each question's detail. */
function packageOf(ask: Ask): string {
	const parts = [ask.body, ...ask.fields.map((f) => f.detail)].filter(
		(t): t is string => typeof t === "string" && t.trim() !== "",
	);
	return parts.map((t) => t.trim()).join("\n\n");
}

/** "09:30 PDT". */
function clock(ms: number, tz?: string): string {
	return boardTime(ms, tz).replace(/^\d{4}-\d{2}-\d{2} /, "");
}

function actionLines(q: CardQuestion): string[] {
	const id = `id "${q.handle}"`;
	const out = [
		`Actions (${OWNER_QUESTION_TOOL} tool):`,
		`- release to him: ${OWNER_QUESTION_TOOL} release ${id} note "<plain words for him>" recommendation "<optional>"`,
		`- hold while you gather context: ${OWNER_QUESTION_TOOL} hold ${id} until "<at most 2 hours ahead>" why "<what you wait for>"`,
	];
	if (q.ask.kind === "question") {
		out.push(
			`- return to the chat that asked (only when it is clearly its own call): ${OWNER_QUESTION_TOOL} return ${id} note "<what it should do instead>"`,
		);
	}
	return out;
}

function questionBlock(q: CardQuestion, opts: CardOptions): string[] {
	const out = [`Who asks: ${whoLine(q)}`, `Kind: ${KIND_WORDS[q.ask.kind]}`];
	out.push(`Why it came to you: ${cooReasonWords(q.reason, q.lastWroteAgoMs)}`);
	if (q.ask.brief?.length) out.push("Brief:", briefText(q.ask.brief));
	const fields = q.ask.fields;
	fields.forEach((f, i) => {
		out.push(...fieldLines(f, fields.length > 1 ? `Question ${i + 1} of ${fields.length}` : "Question", fields));
	});
	out.push(`It goes to the owner at ${clock(q.goesAt, opts.tz)} unless you act.`);
	out.push(...actionLines(q));
	const pkg = packageOf(q.ask);
	if (pkg) {
		out.push("Package:");
		out.push(...pkg.split("\n").map((l) => (l ? `> ${l}` : ">")));
	}
	return out;
}

function firstLine(items: readonly CardQuestion[]): string {
	const tags = `[${items.map((q) => q.handle).join(", ")}]`;
	if (items.length === 1) return `${OWNER_QUESTION_CARD_HEAD} from ${ownerQuestionWho(items[0]!.asker)} ${tags}`;
	const names = items.slice(0, WHO_NAMED_MAX).map((q) => ownerQuestionWho(q.asker));
	const more = items.length - names.length;
	const who = more > 0 ? `${names.join("; ")} and ${more} more` : names.join("; ");
	return `${OWNER_QUESTION_CARD_HEAD} ${items.length} questions, from ${who} ${tags}`;
}

const GUIDANCE =
	"Held for you before the owner sees them. Gather the context; never answer for him. " +
	"Always release to him what only he can give: consent, spending, publishing, his pauses and his own stops. " +
	"Prefer release with a plain note (no ids, paths or code) and a recommendation. " +
	"Return a question only when it is clearly the asking chat's own call. Hold to keep one past this turn.";
const TURN_END_RULE = "If this turn ends with one still held and no release, hold or return, it goes to him at once.";

/** The card's whole text: one first line, a block per question, then the guidance. */
export function ownerQuestionCardText(items: readonly CardQuestion[], opts: CardOptions = {}): string {
	const out = [firstLine(items), ""];
	items.forEach((q, i) => {
		if (items.length > 1) out.push(`— ${q.handle} (${i + 1} of ${items.length})`);
		out.push(...questionBlock(q, opts), "");
	});
	out.push(GUIDANCE, TURN_END_RULE, "", statusHint("order"));
	return out.join("\n");
}
