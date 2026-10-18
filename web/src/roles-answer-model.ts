/** roles-answer: a closed, complete plain-text form. No truncation and no arbitrary DTO reaches the dialog. */
import { object, UNSAFE } from "./roles-useful-model";
import type { UiRoleAskAnswer, UiRoleAskField, UiRoleAskOption, UiRoleAskView } from "./types";

const CHAT_PATH = /(?:\/|[a-z]:\\)[^\n\r]*?\.jsonl\b/i;
function text(v: unknown, max: number): v is string {
	return typeof v === "string" && v.length <= max && !UNSAFE.test(v.replace(/[\t\n\r]/g, "")) && !CHAT_PATH.test(v);
}
function optional(v: unknown, max: number): boolean {
	return v === undefined || text(v, max);
}
function options(value: unknown): UiRoleAskOption[] | null {
	if (!Array.isArray(value) || value.length > 30) return null;
	const seen = new Set<string>();
	const out: UiRoleAskOption[] = [];
	for (const raw of value) {
		const o = object(raw);
		if (
			!o ||
			!text(o.value, 2_000) ||
			!o.value ||
			seen.has(o.value) ||
			!text(o.label, 500) ||
			!optional(o.description, 2_000) ||
			!optional(o.preview, 4_000)
		)
			return null;
		seen.add(o.value);
		out.push({
			value: o.value,
			label: o.label,
			...(typeof o.description === "string" ? { description: o.description } : {}),
			...(typeof o.preview === "string" ? { preview: o.preview } : {}),
		});
	}
	return out;
}
export function projectRoleAsk(value: unknown): UiRoleAskView | null {
	const a = object(value);
	if (
		!a ||
		!text(a.id, 200) ||
		!a.id ||
		typeof a.revision !== "string" ||
		!/^[a-f0-9]{64}$/.test(a.revision) ||
		(a.kind !== "question" && a.kind !== "dialog" && a.kind !== "stuck") ||
		!text(a.title, 500) ||
		!optional(a.body, 64_000) ||
		a.cut === true ||
		!Array.isArray(a.fields) ||
		!a.fields.length ||
		a.fields.length > 10
	)
		return null;
	const fields: UiRoleAskField[] = [];
	const ids = new Set<string>();
	for (const raw of a.fields) {
		const f = object(raw);
		if (
			!f ||
			!text(f.id, 200) ||
			!f.id ||
			ids.has(f.id) ||
			!text(f.text, 4_000) ||
			!optional(f.header, 500) ||
			!optional(f.detail, 20_000) ||
			typeof f.multi !== "boolean" ||
			typeof f.allowText !== "boolean"
		)
			return null;
		const choices = options(f.options);
		if (!choices) return null;
		let dependsOn: UiRoleAskField["dependsOn"];
		if (f.dependsOn !== undefined) {
			const d = object(f.dependsOn);
			if (!d || typeof d.questionId !== "string" || !ids.has(d.questionId)) return null;
			const v = d.value;
			if (
				v !== undefined &&
				!(typeof v === "string" ? text(v, 2_000) : Array.isArray(v) && v.length <= 30 && v.every((s) => text(s, 2_000)))
			)
				return null;
			dependsOn = {
				questionId: d.questionId,
				...(v !== undefined ? { value: Array.isArray(v) ? ([...v] as string[]) : (v as string) } : {}),
			};
		}
		let optionsMap: UiRoleAskField["optionsMap"];
		if (f.optionsMap !== undefined) {
			const map = object(f.optionsMap);
			if (!map || !dependsOn || Object.keys(map).length > 30) return null;
			const entries: [string, UiRoleAskOption[]][] = [];
			for (const [k, v] of Object.entries(map)) {
				const list = options(v);
				if (!text(k, 2_000) || !list) return null;
				entries.push([k, list]);
			}
			optionsMap = Object.fromEntries(entries);
		}
		fields.push({
			id: f.id,
			text: f.text,
			options: choices,
			multi: f.multi,
			allowText: f.allowText,
			...(typeof f.header === "string" ? { header: f.header } : {}),
			...(typeof f.detail === "string" ? { detail: f.detail } : {}),
			...(dependsOn ? { dependsOn } : {}),
			...(optionsMap ? { optionsMap } : {}),
		});
		ids.add(f.id);
	}
	let task: UiRoleAskView["task"];
	if (a.task !== undefined) {
		const t = object(a.task);
		if (!t || typeof t.id !== "number" || !Number.isSafeInteger(t.id) || t.id <= 0 || !text(t.title, 500)) return null;
		task = { id: t.id, title: t.title };
	}
	const view: UiRoleAskView = {
		id: a.id,
		revision: a.revision,
		kind: a.kind,
		title: a.title,
		fields,
		...(typeof a.body === "string" ? { body: a.body } : {}),
		...(task ? { task } : {}),
	};
	return JSON.stringify(view).length <= 256_100 ? view : null;
}

export type RoleAnswerDrafts = ReadonlyMap<string, { selected: string[]; text: string }>;
/** Clear answers whose conditional branch disappeared, and choices from a previous optionsMap branch. */
export function roleAnswerForm(view: UiRoleAskView, drafts: RoleAnswerDrafts) {
	const shown: { field: UiRoleAskField; index: number; options: UiRoleAskOption[]; answer: UiRoleAskAnswer }[] = [];
	const answers: UiRoleAskAnswer[] = [];
	const effective = new Map<string, string[]>();
	let complete = true;
	view.fields.forEach((field, index) => {
		const d = field.dependsOn;
		const previous = d ? (effective.get(d.questionId) ?? []) : [];
		const expected = d?.value === undefined ? undefined : Array.isArray(d.value) ? d.value : [d.value];
		if (d && !(expected ? previous.some((v) => expected.includes(v)) : previous.length)) {
			answers.push({ id: field.id, selected: [] });
			return;
		}
		const mapped = field.optionsMap && previous.find((v) => Object.hasOwn(field.optionsMap!, v));
		const choices = mapped !== undefined ? field.optionsMap![mapped] : field.options;
		const draft = drafts.get(field.id);
		const selected = (draft?.selected ?? []).filter((v) => choices.some((o) => o.value === v));
		const words = field.allowText ? (draft?.text ?? "") : "";
		const answer = { id: field.id, selected, ...(words.trim() ? { text: words } : {}) };
		if (
			(!selected.length && !words.trim()) ||
			(!field.multi && selected.length + (words.trim() ? 1 : 0) > 1) ||
			words.length > 20_000
		)
			complete = false;
		effective.set(field.id, [...selected, ...(words.trim() ? [words.trim()] : [])]);
		answers.push(answer);
		shown.push({ field, index, options: choices, answer });
	});
	return { shown, answers, complete: complete && shown.length > 0 };
}

/** Server errors are never shown verbatim (they may contain paths or agent-controlled values). */
export function roleAnswerError(error: unknown) {
	if (error === "no longer waiting") return "raGone" as const;
	if (error === "it changed since you opened it: open it again") return "raChanged" as const;
	if (error === "open this question in its chat" || error === "it can only be answered in its chat")
		return "raOpenInChat" as const;
	if (error === "offline") return "raOffline" as const;
	if (error === "uncertain" || error === "an answer is already on its way") return "raUncertain" as const;
	if (error === "check each visible question before sending") return "raCheckAnswers" as const;
	return "raUnavailable" as const;
}
