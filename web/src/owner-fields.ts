/**
 * roles-overview: the owner's two fields of a role's identity.json (pi-identity's OWNER_FIELDS), as the
 * Settings -> Identities form edits them: how the role works (workMode) and the goals the owner
 * approved for it (goals). Only the owner sets them, in Settings; a draft can't (they aren't FEATURES).
 *
 * The form edits the file's text: everything else in it stays as it was (other fields, unknown keys,
 * their order, the indent, the last newline). The save goes through the same atomic, hash-checked
 * `identity_file_save` as the settings editor, and the server checks the whole file with pi-identity's
 * own parser (server/identity-config.ts), refusing it with its problems. The checks here mirror that
 * parser so the form can say what's wrong before saving; the server's answer decides.
 */

export const OWNER_WORK_MODES = ["self-start", "request-only"] as const;
export type OwnerWorkMode = (typeof OWNER_WORK_MODES)[number];

/** Mirrors pi-identity config.ts (GOALS_MAX, GOAL_NAME_MAX, GOAL_SCOPE_MAX). */
export const OWNER_GOALS_MAX = 12;
export const OWNER_GOAL_NAME_MAX = 80;
export const OWNER_GOAL_SCOPE_MAX = 160;

/** A goal as the form holds it (strings as typed; endsAt "" = none). */
export interface OwnerGoalDraft {
	name: string;
	scope: string;
	approvedAt: string;
	endsAt: string;
}

/** What the form shows and saves. null: not set in the file (the rules' default applies). */
export interface OwnerFields {
	workMode: OwnerWorkMode | null;
	goals: OwnerGoalDraft[] | null;
}

export type OwnerFieldsRead =
	{ ok: true; fields: OwnerFields; problems: string[] } | { ok: false; reason: "not-json" | "not-object" };

const WHEN_RE = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{3}))?)?(Z|[+-]\d{2}:\d{2})?)?$/;
const hasControl = (t: string) => [...t].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127);

function isObject(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Same as pi-identity's goalTime: ms of a day (local midnight; end: the next one) or a time; NaN if not a date. */
export function ownerGoalTime(when: string, end = false): number {
	const m = WHEN_RE.exec(when);
	if (!m) return Number.NaN;
	const [y, mo, d] = [Number(m[1]), Number(m[2]) - 1, Number(m[3])];
	const day = new Date(Date.UTC(y, mo, d));
	if (day.getUTCFullYear() !== y || day.getUTCMonth() !== mo || day.getUTCDate() !== d) return Number.NaN;
	if (m[4] === undefined) return new Date(y, mo, d + (end ? 1 : 0)).getTime();
	const [h, mi, s, ms] = [Number(m[4]), Number(m[5]), Number(m[6] ?? 0), Number(m[7] ?? 0)];
	if (h > 23 || mi > 59 || s > 59) return Number.NaN;
	if (!m[8]) return new Date(y, mo, d, h, mi, s, ms).getTime();
	if (m[8] === "Z") return Date.UTC(y, mo, d, h, mi, s, ms);
	const [zh, zm] = [Number(m[8].slice(1, 3)), Number(m[8].slice(4, 6))];
	if (zh > 23 || zm > 59) return Number.NaN;
	return Date.UTC(y, mo, d, h, mi, s, ms) - (m[8][0] === "-" ? -1 : 1) * (zh * 60 + zm) * 60_000;
}

/** The owner's fields in identity.json's text. A field the file has but can't hold is shown empty, with a problem. */
export function readOwnerFields(text: string): OwnerFieldsRead {
	let raw: unknown;
	try {
		raw = text.trim() === "" ? {} : JSON.parse(text);
	} catch {
		return { ok: false, reason: "not-json" };
	}
	if (!isObject(raw)) return { ok: false, reason: "not-object" };
	const problems: string[] = [];
	let workMode: OwnerWorkMode | null = null;
	if (raw.workMode !== undefined) {
		if (typeof raw.workMode === "string" && (OWNER_WORK_MODES as readonly string[]).includes(raw.workMode)) {
			workMode = raw.workMode as OwnerWorkMode;
		} else problems.push(`"workMode" is ${JSON.stringify(raw.workMode)}`);
	}
	let goals: OwnerGoalDraft[] | null = null;
	if (raw.goals !== undefined) {
		goals = [];
		if (!Array.isArray(raw.goals)) problems.push(`"goals" is not a list`);
		else {
			for (const g of raw.goals) {
				if (!isObject(g)) {
					problems.push("a goal is not an object");
					continue;
				}
				const str = (v: unknown) => (typeof v === "string" ? v : v === undefined ? "" : JSON.stringify(v));
				goals.push({ name: str(g.name), scope: str(g.scope), approvedAt: str(g.approvedAt), endsAt: str(g.endsAt) });
			}
		}
	}
	return { ok: true, fields: { workMode, goals }, problems };
}

/** What's wrong with the form's values, one line each (the same rules as pi-identity's parser). */
export function ownerFieldsProblems(fields: OwnerFields): string[] {
	const problems: string[] = [];
	if (fields.workMode !== null && !(OWNER_WORK_MODES as readonly string[]).includes(fields.workMode)) {
		problems.push(`work mode must be "self-start" or "request-only"`);
	}
	const goals = fields.goals ?? [];
	if (goals.length > OWNER_GOALS_MAX) problems.push(`at most ${OWNER_GOALS_MAX} goals`);
	const names = new Set<string>();
	goals.forEach((g, i) => {
		const where = `goal ${i + 1}`;
		const name = g.name.trim();
		const scope = g.scope.trim();
		if (!name || name.length > OWNER_GOAL_NAME_MAX || hasControl(name)) {
			problems.push(`${where}: the name must be one line of 1 to ${OWNER_GOAL_NAME_MAX} characters`);
		} else if (names.has(name.toLowerCase())) problems.push(`${where}: an earlier goal has the same name`);
		else names.add(name.toLowerCase());
		if (!scope || scope.length > OWNER_GOAL_SCOPE_MAX || hasControl(scope)) {
			problems.push(`${where}: the scope must be one line of 1 to ${OWNER_GOAL_SCOPE_MAX} characters`);
		}
		const start = ownerGoalTime(g.approvedAt.trim());
		if (Number.isNaN(start)) problems.push(`${where}: "approved" must be a date like 2026-10-04 or 2026-10-04T22:20`);
		const endsAt = g.endsAt.trim();
		if (endsAt) {
			const end = ownerGoalTime(endsAt, true);
			if (Number.isNaN(end)) problems.push(`${where}: "ends" must be a date like 2026-12-31 or 2026-12-31T18:00`);
			else if (!Number.isNaN(start) && end <= start) problems.push(`${where}: "ends" must be after "approved"`);
		}
	});
	return problems;
}

/** The file's indent (its first indented line), else a tab. */
function indentOf(text: string): string {
	const m = /\n([ \t]+)\S/.exec(text);
	return m ? m[1] : "\t";
}

/**
 * identity.json's text with the owner's fields set to `fields` and nothing else changed: other keys keep
 * their values and order, a field set to null is removed (the rules' default applies again), a new one
 * goes last. Throws when the text isn't a JSON object (the form doesn't offer saving then).
 */
export function writeOwnerFields(text: string, fields: OwnerFields): string {
	const raw: unknown = text.trim() === "" ? {} : JSON.parse(text);
	if (!isObject(raw)) throw new Error("identity.json is not an object");
	const out: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(raw)) {
		if (key === "workMode") {
			if (fields.workMode !== null) out.workMode = fields.workMode;
		} else if (key === "goals") {
			if (fields.goals !== null) out.goals = goalsOut(fields.goals);
		} else out[key] = value;
	}
	if (fields.workMode !== null && !("workMode" in raw)) out.workMode = fields.workMode;
	if (fields.goals !== null && !("goals" in raw)) out.goals = goalsOut(fields.goals);
	const body = JSON.stringify(out, null, indentOf(text));
	return text.endsWith("\n") || text.trim() === "" ? `${body}\n` : body;
}

function goalsOut(goals: OwnerGoalDraft[]): Array<Record<string, string>> {
	return goals.map((g) => {
		const endsAt = g.endsAt.trim();
		return {
			name: g.name.trim(),
			scope: g.scope.trim(),
			approvedAt: g.approvedAt.trim(),
			...(endsAt ? { endsAt } : {}),
		};
	});
}

/** Today as a local day (the form's default "approved"). */
export function todayStamp(now: Date = new Date()): string {
	const p = (n: number) => String(n).padStart(2, "0");
	return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
}
