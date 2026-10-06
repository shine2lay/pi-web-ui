/**
 * pi-identity's settings, read from files so a role changes by editing a file, never the code.
 * Plain logic with no pi imports (the tests load it directly).
 *
 * Two places:
 *   ~/.pi/agent/pi-identity.json   what every role shares: the memory's cap, tidy point and index budget,
 *                                  the notes folder's name, the tool groups, the tools an allow list
 *                                  always keeps, and the folder of shared role skills. A missing file
 *                                  means the defaults below.
 *   <role>/identity.json           one role's own settings, next to its id and title: its prompt file,
 *                                  its skills, its tool limits, whether it's one chat at a time, and its
 *                                  own memory limits (memory: notebookCap, tidyAt, indexBudget).
 *
 * Every part is read and checked on its own (a "feature" reads only its own field): a wrong or unknown
 * field is refused with a reason, a "problem", and only that part is left out. Nothing here ever stops
 * a chat: a role with a broken part runs without it.
 *
 * Two identity.json fields are the owner's alone (OWNER_FIELDS): how the role works (workMode) and the
 * goals the owner approved for it (goals). pi-identity checks them but never acts on them: they change
 * no prompt, tool or schedule, and a draft can't suggest them. pi-web-ui's Roles page shows them.
 *
 * A role's Focus line (focusOf) is read here too, so the roster and pi-web-ui cut it the same way.
 *
 * pi-web-ui keeps a byte-identical copy (server/identity-config.ts) to check and show these settings in
 * Settings -> Identities; a test there fails when the two differ, so change this file, then copy it over.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

type Env = Record<string, string | undefined>;

// ---------------------------------------------------------------------------
// Where things are
// ---------------------------------------------------------------------------

const homeOf = (env: Env) => env.HOME || homedir();

/** pi's own folder (PI_CODING_AGENT_DIR, else ~/.pi/agent): the shared settings and template sit in it. */
export function agentDir(env: Env = process.env): string {
	return env.PI_CODING_AGENT_DIR || join(homeOf(env), ".pi", "agent");
}

export const SETTINGS_NAME = "pi-identity.json";
/** The text that tells a role's chats how to use their notebook and skills (see prompt.ts). */
export const TEMPLATE_NAME = "pi-identity-role.md";
/** The text that tells a role's chats how to work with the other roles (see roster.ts). */
export const ROLES_TEMPLATE_NAME = "pi-identity-roles.md";

export const settingsPath = (env: Env = process.env) => join(agentDir(env), SETTINGS_NAME);
export const templatePath = (env: Env = process.env) => join(agentDir(env), TEMPLATE_NAME);
export const rolesTemplatePath = (env: Env = process.env) => join(agentDir(env), ROLES_TEMPLATE_NAME);

function expandTilde(p: string, env: Env): string {
	if (p === "~") return homeOf(env);
	if (p.startsWith("~/")) return join(homeOf(env), p.slice(2));
	return p;
}

const n = (x: number) => x.toLocaleString("en-US");
const quote = (v: unknown) => {
	try {
		const s = JSON.stringify(v);
		return s && s.length > 60 ? `${s.slice(0, 57)}...` : String(s);
	} catch {
		return String(v);
	}
};
const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

// ---------------------------------------------------------------------------
// A role's Focus line (its about page's "Focus:" line, the one part of it others see)
// ---------------------------------------------------------------------------

/** A focus line longer than this is cut on a word. */
export const FOCUS_MAX = 120;
const FOCUS_RE = /^[ \t]*(?:[-*+][ \t]+)?(?:\*\*|__)?focus(?:\*\*|__)?[ \t]*:[ \t]*(?:\*\*|__)?[ \t]*(.*)$/im;
/** Abbreviations whose period doesn't end a sentence. */
const ABBREV_RE = /\b(?:e\.g|i\.e|etc|vs|incl|approx|cf|ca|no|nr|esp)\.$/i;

/** Markdown taken out of one line: emphasis, code marks, links (their text stays), extra spaces. */
function plain(text: string): string {
	return text
		.replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
		.replace(/\*\*|__|`/g, "")
		.replace(/(^|\s)[*_]([^*_\s][^*_]*?)[*_](?=\s|[.,;:!?)]|$)/g, "$1$2")
		.replace(/\s+/g, " ")
		.trim();
}

/** The first sentence of a text (an abbreviation's period doesn't end one). */
export function firstSentence(text: string): string {
	const re = /[.!?](?=\s|$)/g;
	for (let m = re.exec(text); m; m = re.exec(text)) {
		const upTo = text.slice(0, m.index + 1);
		if (ABBREV_RE.test(upTo)) continue;
		return upTo.trim();
	}
	return text.trim();
}

/** Cut a text to at most max characters, on a word, marking the cut with "…". */
export function cutAt(text: string, max: number): string {
	if (text.length <= max) return text;
	if (max <= 1) return "…";
	const head = text.slice(0, max - 1);
	// The head ends on a whole word when a space follows it; else back to the last space (when not too far).
	const space = /\s/.test(text[max - 1] ?? "") ? head.length : head.lastIndexOf(" ");
	const cut = (space >= max / 2 ? head.slice(0, space) : head).replace(/[\s,;:(\-–—]+$/, "");
	return `${cut}…`;
}

/**
 * A role's focus from its about page: the first sentence of its "Focus:" line ("**Focus:** ...",
 * "Focus: ..." or a bullet of either), markdown taken out, the final period dropped, cut at FOCUS_MAX.
 * null when there's no such line or it's empty.
 */
export function focusOf(about: string): string | null {
	const m = FOCUS_RE.exec(about);
	if (!m) return null;
	const sentence = firstSentence(plain(m[1] ?? "")).replace(/\.$/, "").trim();
	return sentence ? cutAt(sentence, FOCUS_MAX) : null;
}

// ---------------------------------------------------------------------------
// The shared settings file
// ---------------------------------------------------------------------------

export interface Settings {
	/**
	 * What a role's chats get with every message, in bytes (what `wc -c` shows): its rules (notebook.md) and
	 * the index of its notes together.
	 */
	notebookCap: number;
	/** Past this size (rules and index) an add to the rules is held once per reply and the chat is asked to tidy first. */
	tidyAt: number;
	/** The index's share of notebookCap; the rules get the rest. */
	indexBudget: number;
	/** The notes folder's name in each role's folder. */
	notesDir: string;
	/**
	 * Names a role's tool limits may use for several tools at once; `*` matches any characters. The file's
	 * groups are added to the default ones (one of the same name replaces the default).
	 */
	toolGroups: Record<string, string[]>;
	/** Tools an allow list always keeps (a role's notebook, its queue answers), unless denied by name. */
	alwaysAllow: string[];
	/** The folder of shared role skills (one folder per skill, with a SKILL.md); roles opt in by name. */
	roleSkillsDir: string;
	/** The file they came from (it may not exist). */
	path: string;
	/** What was refused in the file, each with its reason. */
	problems: string[];
}

export const DEFAULT_TOOL_GROUPS: Readonly<Record<string, readonly string[]>> = {
	shell: ["bash", "powershell", "terminal_*"],
	edit: ["edit", "write", "patch"],
	web: ["web_search", "fetch_content"],
	subagents: ["subagent", "subagent_*", "delegate_task"],
	browser: ["browser_*"],
};

export const DEFAULT_ALWAYS_ALLOW: readonly string[] = ["notebook", "tldr", "queue_done", "queue_stuck", "queue_wait", "message_role"];

export const SETTINGS_FIELDS = ["notebookCap", "tidyAt", "indexBudget", "notesDir", "toolGroups", "alwaysAllow", "roleSkillsDir"] as const;

/** A notes folder's name: a plain folder name that isn't one of a role's other files or folders. */
const NOTES_DIR_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const NOT_NOTES = new Set(["archive", "skills"]);

/** The defaults, as a missing settings file gives them. */
export function defaultSettings(env: Env = process.env): Settings {
	return {
		notebookCap: 8_000,
		tidyAt: 6_000,
		indexBudget: 2_000,
		notesDir: "notes",
		toolGroups: Object.fromEntries(Object.entries(DEFAULT_TOOL_GROUPS).map(([k, v]) => [k, [...v]])),
		alwaysAllow: [...DEFAULT_ALWAYS_ALLOW],
		roleSkillsDir: join(agentDir(env), "role-skills"),
		path: settingsPath(env),
		problems: [],
	};
}

/** A tool name or pattern: letters, digits, _ . : - and * (any characters). */
const TOOL_RE = /^[A-Za-z0-9_.:*-]{1,64}$/;
const GROUP_RE = /^[a-z][a-z0-9_-]{0,31}$/;

/** A list of tool names or patterns: the good entries, and a problem for each bad one. */
function toolList(v: unknown, where: string, problems: string[]): string[] | null {
	if (!Array.isArray(v)) {
		problems.push(`"${where}" must be a list of tool names; got ${quote(v)}`);
		return null;
	}
	const out: string[] = [];
	for (const x of v) {
		if (typeof x === "string" && TOOL_RE.test(x.trim())) out.push(x.trim());
		else problems.push(`"${where}" holds ${quote(x)}, which isn't a tool name (letters, digits, _ . : - and * only)`);
	}
	return out;
}

/** Check settings already parsed from JSON: every good field is kept, every bad one falls back to its default. */
export function checkSettings(raw: unknown, env: Env = process.env, path = settingsPath(env)): Settings {
	const s = defaultSettings(env);
	s.path = path;
	if (raw === undefined) return s;
	if (!isObject(raw)) {
		s.problems.push("the file must hold one JSON object; using the defaults");
		return s;
	}
	for (const key of Object.keys(raw)) {
		if (!(SETTINGS_FIELDS as readonly string[]).includes(key)) {
			s.problems.push(`unknown field "${key}" (known: ${SETTINGS_FIELDS.join(", ")})`);
		}
	}
	const int = (key: "notebookCap" | "tidyAt" | "indexBudget", min: number, max: number) => {
		const v = raw[key];
		if (v === undefined) return;
		if (typeof v === "number" && Number.isInteger(v) && v >= min && v <= max) s[key] = v;
		else s.problems.push(`"${key}" must be a whole number from ${n(min)} to ${n(max)}; got ${quote(v)}, so it stays ${n(s[key])}`);
	};
	int("notebookCap", 500, 1_000_000);
	int("tidyAt", 100, 1_000_000);
	if (s.tidyAt >= s.notebookCap) {
		const fallback = Math.floor(s.notebookCap * 0.75);
		s.problems.push(`"tidyAt" (${n(s.tidyAt)}) must be under "notebookCap" (${n(s.notebookCap)}), so it's ${n(fallback)}`);
		s.tidyAt = fallback;
	}
	int("indexBudget", 0, 1_000_000);
	if (s.indexBudget >= s.notebookCap) {
		const fallback = Math.floor(s.notebookCap / 4);
		s.problems.push(`"indexBudget" (${n(s.indexBudget)}) must be under "notebookCap" (${n(s.notebookCap)}), so it's ${n(fallback)}`);
		s.indexBudget = fallback;
	}
	if (raw.notesDir !== undefined) {
		const v = typeof raw.notesDir === "string" ? raw.notesDir.trim() : "";
		if (NOTES_DIR_RE.test(v) && !NOT_NOTES.has(v.toLowerCase())) s.notesDir = v;
		else s.problems.push(`"notesDir" must be a plain folder name (letters, digits, _ and -; not archive or skills); got ${quote(raw.notesDir)}, so it stays ${s.notesDir}`);
	}
	if (raw.toolGroups !== undefined) {
		if (!isObject(raw.toolGroups)) {
			s.problems.push(`"toolGroups" must be an object of group names, each a list of tool names; got ${quote(raw.toolGroups)}, so the default groups apply`);
		} else {
			const groups: Record<string, string[]> = {};
			for (const [name, list] of Object.entries(raw.toolGroups)) {
				if (!GROUP_RE.test(name)) {
					s.problems.push(`tool group "${name}" isn't a group name (lowercase letters, digits, _ and -, starting with a letter): left out`);
					continue;
				}
				const tools = toolList(list, `toolGroups.${name}`, s.problems);
				if (tools) groups[name] = tools;
			}
			// Added to the default groups, a group of the same name replacing the default one: adding a group never
			// takes another away (a role denying "subagents" mustn't lose that limit because a group was added).
			s.toolGroups = { ...s.toolGroups, ...groups };
		}
	}
	if (raw.alwaysAllow !== undefined) {
		const list = toolList(raw.alwaysAllow, "alwaysAllow", s.problems);
		if (list) s.alwaysAllow = list;
	}
	if (raw.roleSkillsDir !== undefined) {
		if (typeof raw.roleSkillsDir === "string" && raw.roleSkillsDir.trim()) {
			const p = expandTilde(raw.roleSkillsDir.trim(), env);
			s.roleSkillsDir = isAbsolute(p) ? resolve(p) : resolve(dirname(path), p);
		} else {
			s.problems.push(`"roleSkillsDir" must be a folder's path; got ${quote(raw.roleSkillsDir)}, so it stays ${s.roleSkillsDir}`);
		}
	}
	return s;
}

/** The shared settings, read now. A missing file gives the defaults; a broken one gives them with a problem. */
export function loadSettings(env: Env = process.env): Settings {
	const path = settingsPath(env);
	if (!existsSync(path)) return checkSettings(undefined, env, path);
	let raw: unknown;
	try {
		raw = JSON.parse(readFileSync(path, "utf8"));
	} catch (err) {
		const s = defaultSettings(env);
		s.problems.push(`${path} isn't valid JSON (${(err as Error).message.split("\n")[0]}); using the defaults`);
		return s;
	}
	return checkSettings(raw, env, path);
}

// ---------------------------------------------------------------------------
// A role's own settings (identity.json)
// ---------------------------------------------------------------------------

export interface RoleConfig {
	/** The prompt file's name in the role's folder (default prompt.md), or null when it's switched off. */
	prompt: string | null;
	/** prompt was written in identity.json: then a missing file is a problem (a missing prompt.md isn't). */
	promptSet: boolean;
	skills: {
		/** The role's own skills folder (<role>/skills/), which its chats keep. */
		own: boolean;
		/** Shared role skills it opts into, by name (folders in roleSkillsDir). */
		shared: string[];
	};
	/** Tool limits as written: tool names and group names. allow null: no allow list. */
	tools: { allow: string[] | null; deny: string[] };
	/** One chat at a time for this role. */
	unique: boolean;
	/** The role's own memory limits, where it has any (the shared settings' otherwise). */
	memory: Partial<MemoryLimits>;
	/** The owner's word on how the role works (an owner field); null: not set. */
	workMode: WorkMode | null;
	/** The goals the owner approved for it (an owner field), ended ones too; null: not set. */
	goals: RoleGoal[] | null;
}

/** What a role's chats get with every message (rules and index), and when to tidy; see notes.ts. */
export interface MemoryLimits {
	notebookCap: number;
	tidyAt: number;
	indexBudget: number;
}

const MEMORY_FIELDS = ["notebookCap", "tidyAt", "indexBudget"] as const;

/** A role's memory limits: its own (identity.json's memory) over the shared ones, kept consistent. */
export function roleCaps(settings: Settings, config?: RoleConfig | null): MemoryLimits {
	const m = config?.memory ?? {};
	const notebookCap = m.notebookCap ?? settings.notebookCap;
	let tidyAt = m.tidyAt ?? settings.tidyAt;
	if (tidyAt >= notebookCap) tidyAt = Math.floor(notebookCap * 0.75);
	let indexBudget = m.indexBudget ?? settings.indexBudget;
	if (indexBudget >= notebookCap) indexBudget = Math.floor(notebookCap / 4);
	return { notebookCap, tidyAt, indexBudget };
}

export const DEFAULT_PROMPT = "prompt.md";
/** A prompt larger than this isn't loaded (it would crowd out the chat). */
export const PROMPT_MAX = 32_000;
/** Files in a role's folder a prompt may not be: they have their own jobs. */
const RESERVED = new Set(["about.md", "notebook.md", "removed.md", "identity.json"]);
const PROMPT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*\.md$/;
const SKILL_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export function defaultRoleConfig(): RoleConfig {
	return {
		prompt: DEFAULT_PROMPT,
		promptSet: false,
		skills: { own: true, shared: [] },
		tools: { allow: null, deny: [] },
		unique: false,
		memory: {},
		workMode: null,
		goals: null,
	};
}

/** The fields pi-identity knows in identity.json; any other is refused. */
export const BASE_FIELDS = ["id", "title", "folder", "homeChat", "pastHomeChats"] as const;

/**
 * A feature reads its own field only, into the config, adding a problem for anything wrong (the field
 * then keeps its default). A new feature is a new entry here, not a rewrite.
 */
type Feature = (value: unknown, config: RoleConfig, problems: string[], settings: Settings) => void;

export const FEATURES: Record<string, Feature> = {
	prompt(value, config, problems) {
		if (value === null || value === false) {
			config.prompt = null;
			config.promptSet = true;
			return;
		}
		if (typeof value !== "string" || !PROMPT_RE.test(value.trim()) || RESERVED.has(value.trim().toLowerCase())) {
			problems.push(`"prompt" must be a file name in the role's folder ending in .md (like prompt.md), or null for none; got ${quote(value)}, so it's ${DEFAULT_PROMPT}`);
			return;
		}
		config.prompt = value.trim();
		config.promptSet = true;
	},
	skills(value, config, problems) {
		if (!isObject(value)) {
			problems.push(`"skills" must be an object like {"own": true, "shared": ["name"]}; got ${quote(value)}`);
			return;
		}
		for (const key of Object.keys(value)) {
			if (key !== "own" && key !== "shared") problems.push(`unknown field "skills.${key}" (known: own, shared)`);
		}
		if (value.own !== undefined) {
			if (typeof value.own === "boolean") config.skills.own = value.own;
			else problems.push(`"skills.own" must be true or false; got ${quote(value.own)}`);
		}
		if (value.shared !== undefined) {
			if (!Array.isArray(value.shared)) {
				problems.push(`"skills.shared" must be a list of shared skill names; got ${quote(value.shared)}`);
			} else {
				for (const x of value.shared) {
					if (typeof x === "string" && SKILL_RE.test(x.trim())) {
						if (!config.skills.shared.includes(x.trim())) config.skills.shared.push(x.trim());
					} else problems.push(`"skills.shared" holds ${quote(x)}, which isn't a skill's folder name`);
				}
			}
		}
	},
	tools(value, config, problems) {
		if (!isObject(value)) {
			problems.push(`"tools" must be an object like {"deny": ["subagents"]} or {"allow": [...]}; got ${quote(value)}`);
			return;
		}
		for (const key of Object.keys(value)) {
			if (key !== "allow" && key !== "deny") problems.push(`unknown field "tools.${key}" (known: allow, deny)`);
		}
		if (value.allow !== undefined) {
			const list = toolList(value.allow, "tools.allow", problems);
			if (list) config.tools.allow = list;
		}
		if (value.deny !== undefined) {
			const list = toolList(value.deny, "tools.deny", problems);
			if (list) config.tools.deny = list;
		}
	},
	unique(value, config, problems) {
		if (typeof value === "boolean") config.unique = value;
		else problems.push(`"unique" must be true or false; got ${quote(value)}`);
	},
	memory(value, config, problems, settings) {
		if (!isObject(value)) {
			problems.push(`"memory" must be an object like {"indexBudget": 1500}; got ${quote(value)}`);
			return;
		}
		for (const key of Object.keys(value)) {
			if (!(MEMORY_FIELDS as readonly string[]).includes(key)) problems.push(`unknown field "memory.${key}" (known: ${MEMORY_FIELDS.join(", ")})`);
		}
		const range: Record<(typeof MEMORY_FIELDS)[number], [number, number]> = {
			notebookCap: [500, 1_000_000],
			tidyAt: [100, 1_000_000],
			indexBudget: [0, 1_000_000],
		};
		for (const key of MEMORY_FIELDS) {
			const v = value[key];
			if (v === undefined) continue;
			const [min, max] = range[key];
			if (typeof v === "number" && Number.isInteger(v) && v >= min && v <= max) config.memory[key] = v;
			else problems.push(`"memory.${key}" must be a whole number from ${n(min)} to ${n(max)}; got ${quote(v)}, so the shared one applies`);
		}
		const cap = config.memory.notebookCap ?? settings.notebookCap;
		for (const key of ["tidyAt", "indexBudget"] as const) {
			const v = config.memory[key];
			if (v !== undefined && v >= cap) {
				problems.push(`"memory.${key}" (${n(v)}) must be under the cap (${n(cap)}): left out`);
				delete config.memory[key];
			}
		}
	},
};

/** A role's own memory limits in words, or "" when it has none. */
export function memoryText(config: RoleConfig): string {
	return MEMORY_FIELDS.filter((k) => config.memory[k] !== undefined)
		.map((k) => `${k} ${n(config.memory[k] as number)}`)
		.join(", ");
}

// ---------------------------------------------------------------------------
// The owner's fields: how a role works, and the goals the owner approved
// ---------------------------------------------------------------------------

/**
 * Fields only the owner sets (Settings -> Identities), which pi-identity checks and never acts on: no
 * prompt, tool or schedule changes with them, and a draft can't suggest them (they aren't FEATURES).
 *   "workMode": "self-start" | "request-only"       whether the role starts its own work or works on request
 *   "goals": [{"name", "scope", "approvedAt", "endsAt"?}]   work the owner approved it to take on by itself;
 *                                                    a goal past its endsAt has ended
 */
export const OWNER_FIELDS = ["workMode", "goals"] as const;

export const WORK_MODES = ["self-start", "request-only"] as const;
export type WorkMode = (typeof WORK_MODES)[number];

/** A goal the owner approved: what, how far, since when, and (maybe) until when. */
export interface RoleGoal {
	name: string;
	scope: string;
	/** A day (2026-10-04) or a time (2026-10-04T22:20, maybe with seconds and Z or +hh:mm). */
	approvedAt: string;
	/** The same kinds; the goal has ended after it (a day ends at its midnight). None: it runs on. */
	endsAt?: string;
}

/** At most this many goals, each a short line: name and scope. */
export const GOALS_MAX = 12;
export const GOAL_NAME_MAX = 80;
export const GOAL_SCOPE_MAX = 160;
const GOAL_FIELDS: readonly string[] = ["name", "scope", "approvedAt", "endsAt"];
const WHEN_RE = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{3}))?)?(Z|[+-]\d{2}:\d{2})?)?$/;
/** A line break, tab or other control character (a goal's name and scope are one plain line). */
const hasControl = (t: string) => [...t].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127);

/**
 * The time a goal's date stands for, in ms; NaN when it isn't a real date. A day alone is a local day:
 * it starts at its midnight, and (end = true) ends at the next one. A time without a zone is local.
 */
export function goalTime(when: string, end = false): number {
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

/** A goal has ended once its endsAt has passed. */
export function goalEnded(goal: RoleGoal, now: number = Date.now()): boolean {
	return goal.endsAt !== undefined && goalTime(goal.endsAt, true) <= now;
}

/** One line of text, 1 to max characters (trimmed), or null. */
function lineOf(v: unknown, max: number): string | null {
	if (typeof v !== "string") return null;
	const t = v.trim();
	return t && t.length <= max && !hasControl(t) ? t : null;
}

/** One goal as written, or null with one problem saying everything wrong with it. */
function goalOf(g: unknown, where: string, problems: string[]): RoleGoal | null {
	if (!isObject(g)) {
		problems.push(`${where} must be an object with name, scope and approvedAt; got ${quote(g)}: left out`);
		return null;
	}
	const wrong: string[] = [];
	for (const key of Object.keys(g)) {
		if (!GOAL_FIELDS.includes(key)) wrong.push(`unknown field "${key}" (known: ${GOAL_FIELDS.join(", ")})`);
	}
	const name = lineOf(g.name, GOAL_NAME_MAX);
	if (!name) wrong.push(`"name" must be one line of 1 to ${GOAL_NAME_MAX} characters; got ${quote(g.name)}`);
	const scope = lineOf(g.scope, GOAL_SCOPE_MAX);
	if (!scope) wrong.push(`"scope" must be one line of 1 to ${GOAL_SCOPE_MAX} characters; got ${quote(g.scope)}`);
	const approvedAt = typeof g.approvedAt === "string" ? g.approvedAt.trim() : "";
	const start = goalTime(approvedAt);
	if (Number.isNaN(start)) wrong.push(`"approvedAt" must be a date like 2026-10-04 or 2026-10-04T22:20; got ${quote(g.approvedAt)}`);
	let endsAt: string | undefined;
	if (g.endsAt !== undefined) {
		endsAt = typeof g.endsAt === "string" ? g.endsAt.trim() : "";
		const end = goalTime(endsAt, true);
		if (Number.isNaN(end)) wrong.push(`"endsAt" must be a date like 2026-12-31 or 2026-12-31T18:00; got ${quote(g.endsAt)}`);
		else if (!Number.isNaN(start) && end <= start) wrong.push(`"endsAt" (${endsAt}) must be after "approvedAt" (${approvedAt})`);
	}
	if (wrong.length || !name || !scope) {
		problems.push(`${where} left out: ${wrong.join("; ")}`);
		return null;
	}
	return { name, scope, approvedAt, ...(endsAt !== undefined ? { endsAt } : {}) };
}

type OwnerFeature = (value: unknown, config: RoleConfig, problems: string[]) => void;

/** The owner fields' readers, like FEATURES: a wrong value is a problem and is left out. */
export const OWNER_FEATURES: Record<(typeof OWNER_FIELDS)[number], OwnerFeature> = {
	workMode(value, config, problems) {
		if (typeof value === "string" && (WORK_MODES as readonly string[]).includes(value)) config.workMode = value as WorkMode;
		else problems.push(`"workMode" must be "self-start" or "request-only"; got ${quote(value)}: left out`);
	},
	goals(value, config, problems) {
		const goals: RoleGoal[] = [];
		config.goals = goals;
		if (!Array.isArray(value)) {
			problems.push(`"goals" must be a list of goals like {"name": ..., "scope": ..., "approvedAt": "2026-10-04"}; got ${quote(value)}: none kept`);
			return;
		}
		const names = new Set<string>();
		value.forEach((g, i) => {
			const where = `goal ${i + 1}`;
			const goal = goalOf(g, where, problems);
			if (!goal) return;
			if (names.has(goal.name.toLowerCase())) problems.push(`${where} left out: an earlier goal has the same name (${quote(goal.name)})`);
			else if (goals.length >= GOALS_MAX) problems.push(`${where} left out: a role has at most ${GOALS_MAX} goals`);
			else {
				names.add(goal.name.toLowerCase());
				goals.push(goal);
			}
		});
	},
};

export const ROLE_FIELDS: readonly string[] = [...BASE_FIELDS, ...Object.keys(FEATURES), ...OWNER_FIELDS];

/** The base fields' types (id, title, folder, homeChat, pastHomeChats): a wrong one is a problem. */
function baseProblems(raw: Record<string, unknown>): string[] {
	const out: string[] = [];
	for (const key of ["title", "folder"] as const) {
		if (raw[key] !== undefined && typeof raw[key] !== "string") out.push(`"${key}" must be text; got ${quote(raw[key])}`);
	}
	if (raw.homeChat !== undefined && raw.homeChat !== null && typeof raw.homeChat !== "string") {
		out.push(`"homeChat" must be a chat's session file, or null; got ${quote(raw.homeChat)}`);
	}
	if (raw.pastHomeChats !== undefined && !(Array.isArray(raw.pastHomeChats) && raw.pastHomeChats.every((x) => typeof x === "string"))) {
		out.push(`"pastHomeChats" must be a list of session files; got ${quote(raw.pastHomeChats)}`);
	}
	return out;
}

/** A role's settings from its identity.json (already parsed), with what was refused. Never touches the disk. */
export function parseRoleConfig(raw: Record<string, unknown>, settings: Settings): { config: RoleConfig; problems: string[] } {
	const config = defaultRoleConfig();
	const problems = baseProblems(raw);
	for (const key of Object.keys(raw)) {
		if (!ROLE_FIELDS.includes(key)) problems.push(`unknown field "${key}" (known: ${ROLE_FIELDS.join(", ")})`);
	}
	for (const [key, feature] of Object.entries(FEATURES)) {
		if (raw[key] !== undefined) feature(raw[key], config, problems, settings);
	}
	for (const [key, feature] of Object.entries(OWNER_FEATURES)) {
		if (raw[key] !== undefined) feature(raw[key], config, problems);
	}
	return { config, problems };
}

/** What's wrong with the files a role's settings name: its prompt file and its shared skills. */
export function roleFileProblems(dir: string, config: RoleConfig, settings: Settings): string[] {
	const problems: string[] = [];
	if (config.prompt) {
		const p = join(dir, config.prompt);
		let size = -1;
		try {
			size = statSync(p).isFile() ? statSync(p).size : -1;
		} catch {
			size = -1;
		}
		if (size < 0) {
			if (config.promptSet) problems.push(`its prompt file ${config.prompt} isn't in the role's folder`);
		} else if (size > PROMPT_MAX) {
			problems.push(`its prompt file ${config.prompt} is ${n(size)} characters, over the ${n(PROMPT_MAX)} a prompt may have: not loaded`);
		}
	}
	for (const name of config.skills.shared) {
		if (!existsSync(join(settings.roleSkillsDir, name, "SKILL.md"))) {
			problems.push(`shared skill "${name}" isn't in ${settings.roleSkillsDir} (a folder ${name}/ with a SKILL.md): left out`);
		}
	}
	return problems;
}

/** The prompt file's path when the role has one that loads (it exists and isn't too big), else null. */
export function promptFileOf(dir: string, config: RoleConfig): string | null {
	if (!config.prompt) return null;
	const p = join(dir, config.prompt);
	try {
		const st = statSync(p);
		return st.isFile() && st.size <= PROMPT_MAX ? p : null;
	} catch {
		return null;
	}
}

// ---------------------------------------------------------------------------
// Tool limits
// ---------------------------------------------------------------------------

/** A role's tool limits with its groups worked out: patterns, lowercase. allow null: everything not denied. */
export interface ToolLimits {
	allow: string[] | null;
	deny: string[];
}

const expand = (names: string[], settings: Settings): string[] => {
	const out: string[] = [];
	for (const name of names) {
		const group = settings.toolGroups[name.toLowerCase()];
		for (const p of group ?? [name]) {
			const low = p.toLowerCase();
			if (!out.includes(low)) out.push(low);
		}
	}
	return out;
};

/** The limits a role's tools part gives, groups expanded; null when it has none. */
export function resolveToolLimits(tools: RoleConfig["tools"], settings: Settings): ToolLimits | null {
	if (tools.allow === null && !tools.deny.length) return null;
	const allow = tools.allow === null ? null : expand([...tools.allow, ...settings.alwaysAllow], settings);
	if (allow?.includes("*") && !tools.deny.length) return null;
	return { allow, deny: expand(tools.deny, settings) };
}

const reCache = new Map<string, RegExp>();
const globRe = (pattern: string): RegExp => {
	let re = reCache.get(pattern);
	if (!re) {
		re = new RegExp(`^${pattern.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`, "i");
		reCache.set(pattern, re);
	}
	return re;
};

/** Does a tool's name match any of the patterns (case aside)? */
export const matchesAny = (tool: string, patterns: readonly string[]): boolean => patterns.some((p) => globRe(p).test(tool));

/** May a chat with these limits use this tool? */
export function toolPermitted(tool: string, limits: ToolLimits | null): boolean {
	if (!limits) return true;
	if (limits.allow && !matchesAny(tool, limits.allow)) return false;
	return !matchesAny(tool, limits.deny);
}

/** Names in the limits that are neither a group nor a pattern and match none of these tools (likely typos). */
export function unknownToolNames(tools: RoleConfig["tools"], settings: Settings, known: readonly string[]): string[] {
	const low = known.map((t) => t.toLowerCase());
	const out: string[] = [];
	for (const name of [...(tools.allow ?? []), ...tools.deny]) {
		if (name.includes("*") || settings.toolGroups[name.toLowerCase()]) continue;
		if (!low.includes(name.toLowerCase()) && !out.includes(name)) out.push(name);
	}
	return out;
}

/** The limits in words, groups by name: "deny subagents, browser" / "allow read, edit (and always notebook, ...)". */
export function limitsText(tools: RoleConfig["tools"], settings: Settings): string {
	const parts: string[] = [];
	if (tools.allow !== null) {
		parts.push(`allow ${tools.allow.join(", ") || "nothing"} (and always ${settings.alwaysAllow.join(", ") || "nothing else"})`);
	}
	if (tools.deny.length) parts.push(`deny ${tools.deny.join(", ")}`);
	return parts.join("; ") || "none";
}
