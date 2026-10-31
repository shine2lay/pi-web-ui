/**
 * telegram-answers: one process-wide list of everything a chat is waiting on you for, so a plugin
 * (the Telegram one) can show it elsewhere and answer it.
 *
 * Four kinds of waiting feed it, each from its own place in the server:
 *  - "question": the model's ask_user_question (ClientSession.askUser);
 *  - "dialog":   an extension's pop-up, ctx.ui.select / confirm / input (ChatDialogs), such as
 *                pi-queue asking you to approve a plan;
 *  - "approval": a permission prompt before a risky tool call (ClientSession.askApproval);
 *  - "stuck":    a queued task that needs you (pi-queue's queue_stuck).
 *
 * Every ask is described the same way (a title, an optional body, and one or more fields with
 * choices), so a plugin shows them all alike. The place that owns an ask adds it, answers it when
 * a plugin asks it to (the `onAnswer` it registered), and settles it whenever it ends, wherever it
 * was answered. Listeners hear "appeared", "answered" (with a short summary and where it came
 * from) and "gone" (cancelled, the chat closed, the server stopping…).
 *
 * The browser keeps working exactly as before; this list only mirrors it. The first answer wins:
 * once an ask is settled, a late answer from elsewhere gets "no longer waiting".
 *
 * owner-question routing (docs/owner-question-routing.md): an ask may be added with a route
 * (owner-question-route.ts). No route, or a direct one, behaves exactly as above (a direct route only
 * adds its line to the ask). One routed to COO is held: kept and answerable on the asking chat's own
 * page, but neither listed nor announced ("held" instead of "appeared") until it is let through
 * (release: "released", then "appeared"), or COO hands a question back (returnToAsker: "returned",
 * and it no longer waits). No caller passes a route yet (Ops #684, inert groundwork).
 */
import {
	cameThroughCooLabel,
	type OwnerQuestionCooReason,
	type OwnerQuestionDirectReason,
} from "./owner-question-route.js";
import type { QuestionAnswer, UiApprovalCategory, UiDialog, UiQuestion, UiQuestionOption } from "./protocol.js";

export type AskKind = "question" | "dialog" | "approval" | "stuck";

/** One choice. `value` is what an answer carries; `label` is what a person sees. */
export interface AskOption {
	value: string;
	label: string;
	description?: string;
	/** ask_user_question's preview for the option (kept for the decision records, task #84). */
	preview?: string;
}

/** One question of an ask. Most asks have exactly one. */
export interface AskField {
	id: string;
	header?: string;
	text: string;
	detail?: string;
	options: AskOption[];
	/** Several choices may be ticked. */
	multi: boolean;
	/** A typed answer is accepted too ("Other" / "Type something"). */
	allowText: boolean;
	/** Shown only when an earlier field was answered (with one of these values, when given). */
	dependsOn?: { questionId: string; value?: string | string[] };
	/** The choices depend on what an earlier field got (keyed by that answer's value). */
	optionsMap?: Record<string, AskOption[]>;
}

export interface Ask {
	id: string;
	kind: AskKind;
	createdAt: number;
	conversationId?: string;
	conversationTitle?: string;
	cwd?: string;
	sessionFile?: string;
	/** One line saying what this is, plain text. */
	title: string;
	/** Longer text shown above the choices (the command, a plan…). May be long. */
	body?: string;
	fields: AskField[];
	/** A queued task that needs you (kind "stuck"): its number and title. */
	task?: { id: number; title: string };
	/** decision-records: kind "question": the ask_user_question tool call it came from. */
	toolCallId?: string;
	/** owner-question routing: where it went and the line it is shown with (absent = no route, as before). */
	route?: AskRoute;
}

/** owner-question routing: who let a held ask through. */
export type AskReleasedBy = "coo" | "safety-net";

/** owner-question routing: an ask's route as AskHub keeps it. */
export type AskRoute =
	| { to: "direct"; reason: OwnerQuestionDirectReason; label?: string }
	| {
			to: "coo";
			reason: OwnerQuestionCooReason;
			/** When it was held (kept across a restart). */
			heldAt: number;
			/** Set once it is let through; until then it is held. */
			releasedBy?: AskReleasedBy;
			releasedAt?: number;
			label?: string;
			note?: string;
			recommendation?: string;
	  };

/** add()'s route. A COO route is held from now, or from `heldAt`; one already let through (after a restart) appears at once. */
export type AskRouteInput =
	| { to: "direct"; reason: OwnerQuestionDirectReason; label?: string }
	| {
			to: "coo";
			reason: OwnerQuestionCooReason;
			heldAt?: number;
			releasedBy?: AskReleasedBy;
			releasedAt?: number;
			note?: string;
			recommendation?: string;
	  };

type CooRoute = Extract<AskRoute, { to: "coo" }>;

/** The answer to one field: the chosen values, and/or a typed text. */
export interface AskFieldAnswer {
	id: string;
	selected: string[];
	text?: string;
}

export type AskEvent =
	| { type: "appeared"; ask: Ask }
	| { type: "answered"; ask: Ask; summary: string; from: string; answers?: AskFieldAnswer[] }
	| { type: "gone"; ask: Ask; reason: string }
	/** owner-question routing: kept for COO, not shown to the owner (no "appeared"). */
	| { type: "held"; ask: Ask }
	/** owner-question routing: let through; "appeared" follows. */
	| { type: "released"; ask: Ask; by: AskReleasedBy }
	/** owner-question routing: handed back to the chat that asked it, which should do `note` instead; it no longer waits. */
	| { type: "returned"; ask: Ask; note: string };

export interface AskResult {
	ok: boolean;
	error?: string;
}

export type AskAnswerFn = (answers: AskFieldAnswer[], from: string) => AskResult | Promise<AskResult>;

/** decision-records: `answers` = what was picked and typed, per field (when the settler knows it). */
export type AskOutcome =
	{ how: "answered"; summary: string; from: string; answers?: AskFieldAnswer[] } | { how: "gone"; reason: string };

/** Who answered in the browser (the default for every answer that comes over the page socket). */
export const FROM_BROWSER = "browser";

export const NOT_WAITING = "no longer waiting";

/** owner-question routing: release / returnToAsker on an ask that isn't held for COO. */
export const NOT_HELD = "not held for COO";

const ONLY_QUESTIONS_GO_BACK = "only a question can go back to the chat that asked it";
const RETURN_NEEDS_NOTE = "say what the chat should do instead";

/** owner-question routing: routed to COO and not let through yet. */
const isHeld = (ask: Ask): boolean => ask.route?.to === "coo" && ask.route.releasedBy === undefined;

/** A COO route let through, with its line: COO's words, or that COO added nothing and how long it took. */
function letThrough(route: CooRoute, by: AskReleasedBy, at: number, note?: string, recommendation?: string): CooRoute {
	const n = typeof note === "string" ? note.trim() : "";
	const r = typeof recommendation === "string" ? recommendation.trim() : "";
	return {
		...route,
		releasedBy: by,
		releasedAt: at,
		label: cameThroughCooLabel(Boolean(n || r), at - route.heldAt),
		...(n ? { note: n } : {}),
		...(r ? { recommendation: r } : {}),
	};
}

export class AskHub {
	private readonly asks = new Map<string, { ask: Ask; onAnswer: AskAnswerFn }>();
	private readonly listeners = new Set<(ev: AskEvent) => void>();

	/** `now`: when an ask is held and let through (owner-question routing). */
	constructor(private readonly now: () => number = Date.now) {}

	/** Someone (a plugin) is listening, so a chat with no browser open can still get an answer. */
	get listening(): boolean {
		return this.listeners.size > 0;
	}

	/**
	 * Add a waiting ask. False (and nothing happens) when one with this id is already waiting.
	 * With a route (owner-question routing), it is kept as a copy carrying the route: a COO route that
	 * isn't let through yet is held ("held", not "appeared"); the caller's object is never changed.
	 */
	add(ask: Ask, onAnswer: AskAnswerFn, route?: AskRouteInput): boolean {
		if (this.asks.has(ask.id)) return false;
		const kept: Ask = route ? { ...ask, route: this.routeOf(route) } : ask;
		this.asks.set(ask.id, { ask: kept, onAnswer });
		this.emit(isHeld(kept) ? { type: "held", ask: kept } : { type: "appeared", ask: kept });
		return true;
	}

	/**
	 * owner-question routing: let a held ask through, by COO (with its note and recommendation) or by
	 * the safety net. It is listed again in its first place, and "released" then "appeared" go out.
	 */
	release(id: string, by: AskReleasedBy, note?: string, recommendation?: string): AskResult {
		const e = this.asks.get(id);
		if (!e) return { ok: false, error: NOT_WAITING };
		const route = e.ask.route;
		if (route?.to !== "coo" || route.releasedBy !== undefined) return { ok: false, error: NOT_HELD };
		const ask: Ask = { ...e.ask, route: letThrough(route, by, this.now(), note, recommendation) };
		this.asks.set(id, { ask, onAnswer: e.onAnswer });
		this.emit({ type: "released", ask, by });
		if (this.asks.get(id)?.ask === ask) this.emit({ type: "appeared", ask });
		return { ok: true };
	}

	/**
	 * owner-question routing: COO hands a held question back to the chat that asked it, saying what
	 * it should do instead (`note`). It no longer waits; "returned" goes out. Questions only.
	 */
	returnToAsker(id: string, note: string): AskResult {
		const e = this.asks.get(id);
		if (!e) return { ok: false, error: NOT_WAITING };
		if (e.ask.kind !== "question") return { ok: false, error: ONLY_QUESTIONS_GO_BACK };
		if (!isHeld(e.ask)) return { ok: false, error: NOT_HELD };
		const text = typeof note === "string" ? note.trim() : "";
		if (!text) return { ok: false, error: RETURN_NEEDS_NOTE };
		this.asks.delete(id);
		this.emit({ type: "returned", ask: e.ask, note: text });
		return { ok: true };
	}

	private routeOf(route: AskRouteInput): AskRoute {
		if (route.to === "direct") {
			return { to: "direct", reason: route.reason, ...(route.label ? { label: route.label } : {}) };
		}
		const held: CooRoute = { to: "coo", reason: route.reason, heldAt: route.heldAt ?? this.now() };
		if (!route.releasedBy) return held;
		return letThrough(held, route.releasedBy, route.releasedAt ?? this.now(), route.note, route.recommendation);
	}

	/** It ended (answered anywhere, cancelled, gone). A no-op for an id that isn't waiting. */
	settle(id: string, outcome: AskOutcome): void {
		const e = this.asks.get(id);
		if (!e) return;
		this.asks.delete(id);
		if (outcome.how === "answered") {
			this.emit({
				type: "answered",
				ask: e.ask,
				summary: outcome.summary,
				from: outcome.from,
				...(outcome.answers ? { answers: outcome.answers } : {}),
			});
		} else {
			this.emit({ type: "gone", ask: e.ask, reason: outcome.reason });
		}
	}

	/** Answer an ask from elsewhere. The owner turns the answer into its own kind and settles the ask. */
	async answer(id: string, answers: AskFieldAnswer[], from: string): Promise<AskResult> {
		const e = this.asks.get(id);
		if (!e) return { ok: false, error: NOT_WAITING };
		const bad = checkAnswers(e.ask, answers);
		if (bad) return { ok: false, error: bad };
		try {
			const r = await e.onAnswer(answers, from);
			return r && typeof r.ok === "boolean" ? r : { ok: false, error: "no result" };
		} catch (err) {
			return { ok: false, error: (err as Error)?.message ?? String(err) };
		}
	}

	get(id: string): Ask | undefined {
		return this.asks.get(id)?.ask;
	}

	/** Everything waiting for the owner now, oldest first (not what is held for COO). */
	list(): Ask[] {
		return [...this.asks.values()].filter((e) => !isHeld(e.ask)).map((e) => e.ask);
	}

	/** owner-question routing: everything held for COO now, oldest first. */
	heldList(): Ask[] {
		return [...this.asks.values()].filter((e) => isHeld(e.ask)).map((e) => e.ask);
	}

	/** Hear every change. Returns the way to stop. */
	on(fn: (ev: AskEvent) => void): () => void {
		this.listeners.add(fn);
		return () => {
			this.listeners.delete(fn);
		};
	}

	private emit(ev: AskEvent): void {
		for (const fn of [...this.listeners]) {
			try {
				fn(ev);
			} catch (err) {
				console.error("[asks] listener failed:", err);
			}
		}
	}
}

/** The process-wide list. */
export const askHub = new AskHub();

/** Why these answers don't fit the ask (null = they do). */
export function checkAnswers(ask: Ask, answers: AskFieldAnswer[]): string | null {
	if (!Array.isArray(answers) || answers.length === 0) return "no answer";
	let any = false;
	for (const a of answers) {
		const f = ask.fields.find((x) => x.id === a?.id);
		if (!f) return `unknown field: ${String(a?.id)}`;
		const selected = Array.isArray(a.selected) ? a.selected : [];
		const text = typeof a.text === "string" ? a.text.trim() : "";
		if (!f.multi && selected.length > 1) return `pick one for ${f.id}`;
		if (text && !f.allowText) return `a typed answer isn't accepted for ${f.id}`;
		const allowed = new Set([...f.options, ...Object.values(f.optionsMap ?? {}).flat()].map((o) => o.value));
		for (const v of selected) if (!allowed.has(v)) return `not a choice: ${v}`;
		if (selected.length > 0 || text) any = true;
	}
	return any ? null : "no answer";
}

// ---------------------------------------------------------------------------
// Describing each kind
// ---------------------------------------------------------------------------

export interface AskMeta {
	conversationId?: string;
	conversationTitle?: string;
	cwd?: string;
	sessionFile?: string;
}

const optionOf = (o: UiQuestionOption): AskOption => ({
	value: o.label,
	label: o.label,
	...(o.description ? { description: o.description } : {}),
	...(typeof o.preview === "string" && o.preview ? { preview: o.preview } : {}),
});

/** ask_user_question: one field per question; the answer values are the option labels (as the page sends them). */
export function questionAsk(id: string, questions: UiQuestion[], meta: AskMeta, now = Date.now()): Ask {
	const fields: AskField[] = questions.map((q) => ({
		id: q.id,
		...(q.header ? { header: q.header } : {}),
		text: q.question,
		...(q.detail ? { detail: q.detail } : {}),
		options: (q.options ?? []).map(optionOf),
		multi: q.multiSelect === true,
		allowText: true,
		...(q.dependsOn ? { dependsOn: q.dependsOn } : {}),
		...(q.optionsMap
			? { optionsMap: Object.fromEntries(Object.entries(q.optionsMap).map(([k, v]) => [k, v.map(optionOf)])) }
			: {}),
	}));
	const first = questions[0];
	const title = questions.length === 1 && first ? first.header || "Question" : `${questions.length} questions`;
	return { id, kind: "question", createdAt: now, ...meta, title, fields };
}

/** The page's answer shape (every question listed; skipped ones with nothing chosen). */
export function questionAnswersFrom(questions: UiQuestion[], answers: AskFieldAnswer[]): QuestionAnswer[] {
	return questions.map((q) => {
		const a = answers.find((x) => x.id === q.id);
		const text = a?.text?.trim();
		return { id: q.id, selected: a?.selected ?? [], ...(text ? { custom: text } : {}) };
	});
}

/** "Colour: Red, Blue; Size: something typed" — what the answer was, in one line. */
export function summarizeQuestionAnswers(questions: UiQuestion[], answers: QuestionAnswer[]): string {
	const parts: string[] = [];
	for (const q of questions) {
		const a = answers.find((x) => x.id === q.id);
		if (!a) continue;
		const bits = [...a.selected, ...(a.custom ? [a.custom] : [])];
		if (bits.length === 0) continue;
		const label = questions.length > 1 ? `${q.header || q.question}: ` : "";
		parts.push(label + bits.join(", "));
	}
	return parts.join("; ");
}

const dialogField = (id: string, text: string, rest: Omit<AskField, "id" | "text">): AskField => ({
	id,
	text,
	...rest,
});

/** An extension's pop-up. select = its options; confirm = Yes / No; input = a typed answer only. */
export function dialogAsk(id: string, ui: UiDialog, meta: AskMeta, now = Date.now()): Ask {
	const title = ui.title || "The chat asks";
	const base = { id, kind: "dialog" as const, createdAt: now, ...meta, title };
	if (ui.kind === "select") {
		const list = Array.isArray(ui.args?.[0]) ? (ui.args[0] as unknown[]).map(String) : [];
		return {
			...base,
			fields: [
				dialogField("value", title, {
					options: list.map((v) => ({ value: v, label: v })),
					multi: false,
					allowText: false,
				}),
			],
		};
	}
	if (ui.kind === "confirm") {
		const message = typeof ui.args?.[0] === "string" ? (ui.args[0] as string) : "";
		return {
			...base,
			...(message ? { body: message } : {}),
			fields: [
				dialogField("value", title, {
					options: [
						{ value: "yes", label: "Yes" },
						{ value: "no", label: "No" },
					],
					multi: false,
					allowText: false,
				}),
			],
		};
	}
	const placeholder = typeof ui.args?.[0] === "string" ? (ui.args[0] as string) : "";
	return {
		...base,
		fields: [
			dialogField("value", title, {
				...(placeholder ? { detail: placeholder } : {}),
				options: [],
				multi: false,
				allowText: true,
			}),
		],
	};
}

/** The pop-up's raw answer (what the page would send), or undefined when the answer doesn't fit. */
export function dialogValueFrom(ui: UiDialog, answers: AskFieldAnswer[]): string | boolean | undefined {
	const a = answers.find((x) => x.id === "value");
	if (!a) return undefined;
	if (ui.kind === "confirm") {
		if (a.selected[0] === "yes") return true;
		if (a.selected[0] === "no") return false;
		return undefined;
	}
	if (ui.kind === "select") return a.selected[0];
	const text = a.text ?? a.selected[0];
	return typeof text === "string" ? text : undefined;
}

/** decision-records: a pop-up's answer, per field (the inverse of dialogValueFrom). */
export function dialogAnswersOf(ui: UiDialog, value: string | boolean): AskFieldAnswer[] {
	if (ui.kind === "confirm") return [{ id: "value", selected: [value === true ? "yes" : "no"] }];
	if (ui.kind === "select") return [{ id: "value", selected: [String(value)] }];
	return [{ id: "value", selected: [], text: String(value) }];
}

export function summarizeDialogValue(ui: UiDialog, value: string | boolean): string {
	if (ui.kind === "confirm") return value === true ? "Yes" : "No";
	return String(value);
}

/** The approval choices, in the page's words. */
export const APPROVAL_CHOICES = {
	approve: "Approve",
	category: "Allow this kind here",
	all: "Allow all here",
	deny: "Deny",
} as const;

export type ApprovalChoice = keyof typeof APPROVAL_CHOICES;

/** What the tool is about to do, in one short text (the command for bash, the path for file tools). */
export function describeToolCall(toolName: string, params: unknown): string {
	const p = (params && typeof params === "object" ? params : {}) as Record<string, unknown>;
	if (typeof p.command === "string") return p.command;
	const path = p.path ?? p.file_path ?? p.filePath;
	if (typeof path === "string") return path;
	try {
		return JSON.stringify(params, null, 1) ?? "";
	} catch {
		return "";
	}
}

export interface ApprovalAskInput {
	toolName: string;
	params: unknown;
	reason?: string;
	reasonEn?: string;
	category?: UiApprovalCategory;
}

/** A permission prompt: the same allow / deny choices as the page ("Edit & Run" stays in the page). */
export function approvalAsk(id: string, a: ApprovalAskInput, meta: AskMeta, now = Date.now()): Ask {
	const options: AskOption[] = [{ value: "approve", label: APPROVAL_CHOICES.approve }];
	if (a.category) {
		const kind = a.category.labelEn || a.category.label;
		options.push({ value: "category", label: APPROVAL_CHOICES.category, ...(kind ? { description: kind } : {}) });
	}
	options.push({ value: "all", label: APPROVAL_CHOICES.all }, { value: "deny", label: APPROVAL_CHOICES.deny });
	const reason = a.reasonEn || a.reason;
	const action = describeToolCall(a.toolName, a.params);
	return {
		id,
		kind: "approval",
		createdAt: now,
		...meta,
		title: `Allow ${a.toolName}?`,
		...(action ? { body: action } : {}),
		fields: [
			{
				id: "decision",
				text: reason ? `Allow ${a.toolName}? ${reason}` : `Allow ${a.toolName}?`,
				options,
				multi: false,
				allowText: false,
			},
		],
	};
}

/** The approval an answer means (undefined = not one of the choices). */
export function approvalFrom(
	answers: AskFieldAnswer[],
): { decision: "approve" | "deny"; scope?: "once" | "category" | "all" } | undefined {
	const v = answers.find((x) => x.id === "decision")?.selected[0];
	if (v === "approve") return { decision: "approve", scope: "once" };
	if (v === "category") return { decision: "approve", scope: "category" };
	if (v === "all") return { decision: "approve", scope: "all" };
	if (v === "deny") return { decision: "deny" };
	return undefined;
}

export function summarizeApproval(decision: string, scope?: string): string {
	if (decision === "deny") return "Denied";
	if (decision === "edit") return "Edited and approved";
	if (scope === "category") return "Approved (this kind, from now on in this chat)";
	if (scope === "all") return "Approved (everything, from now on in this chat)";
	return "Approved";
}

export interface StuckAskInput {
	taskId: number;
	taskTitle: string;
	question: string;
	choices?: string[];
	/** task-question decisions (rule 21): the whole package the question came with (Markdown). */
	detail?: string;
}

/** A queued task that needs you: its question, its choices, its package (rule 21), and always a typed answer. */
export function stuckAsk(id: string, s: StuckAskInput, meta: AskMeta, now = Date.now()): Ask {
	const choices = (s.choices ?? []).filter((c) => typeof c === "string" && c.trim());
	return {
		id,
		kind: "stuck",
		createdAt: now,
		...meta,
		title: `Task #${s.taskId} needs you: ${s.taskTitle}`,
		task: { id: s.taskId, title: s.taskTitle },
		fields: [
			{
				id: "answer",
				text: s.question,
				...(typeof s.detail === "string" && s.detail.trim() ? { detail: s.detail } : {}),
				options: choices.map((c) => ({ value: c, label: c })),
				multi: false,
				allowText: true,
			},
		],
	};
}

/** The text that goes into the task's chat. */
export function stuckTextFrom(answers: AskFieldAnswer[]): string {
	const a = answers.find((x) => x.id === "answer");
	return (a?.text?.trim() || a?.selected[0] || "").trim();
}
