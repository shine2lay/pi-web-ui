/** roles-answer: complete, bounded plain-text asks for the owner's Roles page. No partial consent forms.
 * AgentService checks current Needs-you membership; AskHub delivers and records through the existing path.
 * Internal paths, tool metadata and arbitrary extra properties never enter the view.
 */
import { createHash, randomUUID } from "node:crypto";
import type { Ask, AskFieldAnswer, AskOption } from "./asks.js";
import type { UiRoleAskField, UiRoleAskOption, UiRoleAskView } from "./protocol.js";

export const ROLE_ASK_KEY_MAX = 400;
export const ROLE_ASK_FIELDS_MAX = 10;
export const ROLE_ASK_OPTIONS_MAX = 30;
export const ROLE_ASK_VIEW_MAX = 256_000;
export const ROLE_ANSWER_TEXT_MAX = 20_000;
const ID_MAX = 200;
const VALUE_MAX = 2_000;
const UNSAFE = /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}\u2028\u2029]/u;
// Chat targets belong only in the existing in-memory Open chat link, never in the answer form.
const CHAT_PATH = /(?:\/|[a-z]:\\)[^\n\r]*?\.jsonl\b/i;
const epoch = randomUUID();

function text(value: unknown, max: number): value is string {
	return (
		typeof value === "string" &&
		value.length <= max &&
		!UNSAFE.test(value.replace(/[\t\r\n]/g, "")) &&
		!CHAT_PATH.test(value)
	);
}
function optional(value: unknown, max: number): boolean {
	return value === undefined || text(value, max);
}

/** Kind/shape policy only; membership and complete-form checks still apply.
 * Generic dialogs carry no producer tag, so only the native queue-plan titles are allowed, and only in
 * pi-queue's confirm shape (roles-small-fixes N1): one Yes/No field, no typed answer, a body starting
 * "### Task #". An MCP form elicitation can build the same title, but only as a select or input pop-up,
 * which has no body and other options, so it stays Open chat.
 */
export function roleAnswerKindAllowed(
	ask: Pick<Ask, "kind" | "title"> & Partial<Pick<Ask, "body" | "fields">>,
): ask is Pick<Ask, "kind" | "title"> & { kind: UiRoleAskView["kind"] } {
	if (ask.kind === "question" || ask.kind === "stuck") return true;
	if (ask.kind !== "dialog" || typeof ask.title !== "string" || ask.title.length > 500) return false;
	const planTitle = ask.title === "Add to the queue?" || /^Change task #[1-9]\d*\?$/.exec(ask.title)?.[0] === ask.title;
	return planTitle && planConfirmShape(ask);
}

/** pi-queue's plan pop-up is ctx.ui.confirm(title, "### Task #..."): exactly the native Yes/No field. */
function planConfirmShape(ask: Partial<Pick<Ask, "body" | "fields">>): boolean {
	if (typeof ask.body !== "string" || !ask.body.startsWith("### Task #")) return false;
	if (!Array.isArray(ask.fields) || ask.fields.length !== 1) return false;
	const f = ask.fields[0];
	if (!f || f.id !== "value" || f.allowText !== false || f.multi !== false || f.dependsOn || f.optionsMap) return false;
	const o = f.options;
	return (
		Array.isArray(o) &&
		o.length === 2 &&
		o[0]?.value === "yes" &&
		o[0]?.label === "Yes" &&
		o[1]?.value === "no" &&
		o[1]?.label === "No" &&
		o.every((x) => x.description === undefined && x.preview === undefined)
	);
}

/** null means use the original chat: no other dialogs, built-in approvals or unsafe partial forms. */
export function askViewOf(ask: Ask): UiRoleAskView | null {
	if (!roleAnswerKindAllowed(ask)) return null;
	if (!text(ask.id, ID_MAX) || !ask.id || !text(ask.title, 500) || !optional(ask.body, 64_000)) return null;
	if (!Array.isArray(ask.fields) || !ask.fields.length || ask.fields.length > ROLE_ASK_FIELDS_MAX) return null;
	let valid = true;
	const options = (list: AskOption[]): UiRoleAskOption[] => {
		if (!Array.isArray(list) || list.length > ROLE_ASK_OPTIONS_MAX) {
			valid = false;
			return [];
		}
		const values = new Set<string>();
		const out: UiRoleAskOption[] = [];
		for (const o of list) {
			if (
				!o ||
				!text(o.value, VALUE_MAX) ||
				!o.value ||
				values.has(o.value) ||
				!text(o.label, 500) ||
				!optional(o.description, 2_000) ||
				!optional(o.preview, 4_000)
			) {
				valid = false;
				return [];
			}
			values.add(o.value);
			out.push({
				value: o.value,
				label: o.label,
				...(o.description !== undefined ? { description: o.description } : {}),
				...(o.preview !== undefined ? { preview: o.preview } : {}),
			});
		}
		return out;
	};
	const fields: UiRoleAskField[] = [];
	const ids = new Set<string>();
	for (const f of ask.fields) {
		if (
			!f ||
			!text(f.id, ID_MAX) ||
			!f.id ||
			ids.has(f.id) ||
			!text(f.text, 4_000) ||
			!optional(f.header, 500) ||
			!optional(f.detail, 20_000) ||
			typeof f.multi !== "boolean" ||
			typeof f.allowText !== "boolean"
		)
			return null;
		let dependsOn: UiRoleAskField["dependsOn"];
		if (f.dependsOn) {
			if (!ids.has(f.dependsOn.questionId)) return null; // forward references/cycles cannot be answered
			const v = f.dependsOn.value;
			if (
				v !== undefined &&
				!(typeof v === "string"
					? text(v, VALUE_MAX)
					: Array.isArray(v) && v.length <= ROLE_ASK_OPTIONS_MAX && v.every((s) => text(s, VALUE_MAX)))
			)
				return null;
			dependsOn = {
				questionId: f.dependsOn.questionId,
				...(v !== undefined ? { value: Array.isArray(v) ? [...v] : v } : {}),
			};
		}
		let optionsMap: UiRoleAskField["optionsMap"];
		if (f.optionsMap) {
			if (!dependsOn || Object.keys(f.optionsMap).length > ROLE_ASK_OPTIONS_MAX) return null;
			const entries: [string, UiRoleAskOption[]][] = [];
			for (const [k, list] of Object.entries(f.optionsMap)) {
				if (!text(k, VALUE_MAX)) return null;
				entries.push([k, options(list)]);
			}
			optionsMap = Object.fromEntries(entries);
		}
		fields.push({
			id: f.id,
			text: f.text,
			options: options(f.options),
			multi: f.multi,
			allowText: f.allowText,
			...(f.header !== undefined ? { header: f.header } : {}),
			...(f.detail !== undefined ? { detail: f.detail } : {}),
			...(dependsOn ? { dependsOn } : {}),
			...(optionsMap ? { optionsMap } : {}),
		});
		ids.add(f.id);
	}
	if (!valid) return null;
	if (ask.task && (!Number.isSafeInteger(ask.task.id) || ask.task.id <= 0 || !text(ask.task.title, 500))) return null;
	const view = {
		id: ask.id,
		kind: ask.kind,
		title: ask.title,
		fields,
		...(ask.body !== undefined ? { body: ask.body } : {}),
		...(ask.task ? { task: { id: ask.task.id, title: ask.task.title } } : {}),
	};
	const encoded = JSON.stringify(view);
	if (encoded.length > ROLE_ASK_VIEW_MAX) return null;
	// A restarted server or an in-place change of wording, choices, target or package invalidates the open form.
	const revision = createHash("sha256")
		.update(epoch)
		.update(encoded)
		.update(JSON.stringify([ask.createdAt, ask.sessionFile, ask.conversationId]))
		.digest("hex");
	return { ...view, revision };
}

/** Validate the whole form, including conditional branches, before it enters the existing AskHub path. */
export function answersFromPage(
	value: unknown,
	view: UiRoleAskView,
): { answers: AskFieldAnswer[] } | { error: string } {
	const bad = { error: "check each visible question before sending" };
	if (!Array.isArray(value) || !value.length || value.length > ROLE_ASK_FIELDS_MAX) return bad;
	const submitted = new Map<string, AskFieldAnswer>();
	for (const raw of value) {
		if (
			!raw ||
			typeof raw !== "object" ||
			!text(raw.id, ID_MAX) ||
			submitted.has(raw.id) ||
			!view.fields.some((f) => f.id === raw.id) ||
			!Array.isArray(raw.selected) ||
			raw.selected.length > ROLE_ASK_OPTIONS_MAX ||
			raw.selected.some((v: unknown) => !text(v, VALUE_MAX)) ||
			new Set(raw.selected).size !== raw.selected.length ||
			!optional(raw.text, ROLE_ANSWER_TEXT_MAX)
		)
			return bad;
		submitted.set(raw.id, { id: raw.id, selected: [...raw.selected], ...(raw.text?.trim() ? { text: raw.text } : {}) });
	}
	const effective = new Map<string, string[]>();
	const answers: AskFieldAnswer[] = [];
	for (const f of view.fields) {
		const a = submitted.get(f.id) ?? { id: f.id, selected: [] };
		const words = a.text?.trim() ?? "";
		const dep = f.dependsOn;
		const previous = dep ? (effective.get(dep.questionId) ?? []) : [];
		const expected = dep?.value === undefined ? undefined : Array.isArray(dep.value) ? dep.value : [dep.value];
		const visible = !dep || (expected ? previous.some((v) => expected.includes(v)) : previous.length > 0);
		if (!visible) {
			if (a.selected.length || words) return bad;
			answers.push({ id: f.id, selected: [] });
			continue;
		}
		const mapped = f.optionsMap && previous.find((v) => Object.hasOwn(f.optionsMap!, v));
		const allowed = new Set((mapped !== undefined ? f.optionsMap![mapped] : f.options).map((o) => o.value));
		if (
			(!f.multi && a.selected.length + (words ? 1 : 0) > 1) ||
			(words && !f.allowText) ||
			(!a.selected.length && !words) ||
			a.selected.some((s) => !allowed.has(s))
		)
			return bad;
		effective.set(f.id, [...a.selected, ...(words ? [words] : [])]);
		answers.push(a);
	}
	return { answers };
}
