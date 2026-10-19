// initiatives-page-exact (docs/initiatives-page-exact.md, Ops #225): a fixed work registry page, decision log
// and lead update for the live Initiatives page's core model. Shared by tests/unit/initiatives-page-model.test.ts
// and the sealed look (scripts/initiatives-exact-shot.mjs --page). The names are made up (none of the design's
// sample).
import { en, type Translate } from "../../web/src/i18n";
import type { InitiativesPageArgs } from "../../web/src/initiatives-page/model";
import type {
	UiDecision,
	UiDecisionsPage,
	UiProgress,
	UiReaderStatus,
	UiWorkPage,
	UiWorkPageRecord,
} from "../../web/src/types";

export const t: Translate = (key, vars) => {
	let s: string = en[key];
	for (const [k, v] of Object.entries(vars ?? {})) s = s.replaceAll(`{${k}}`, String(v));
	return s;
};
/** Sun Oct 18 2026, 09:40 on this machine's clock. */
export const AT = new Date(2026, 9, 18, 9, 40).getTime();
export const NOW = AT + 5 * 60_000;

const items = (met: number, total: number) =>
	Array.from({ length: total }, (_, k) => ({
		item: `item ${k + 1}`,
		...(k < met ? { met: { proof: "checked", by: "ops", at: AT } } : {}),
	}));
const rec = (
	id: string,
	name: string,
	lead: string,
	status: UiWorkPageRecord["status"],
	met: number,
	total: number,
	initiative?: string | null,
): UiWorkPageRecord => ({
	id,
	name,
	outcome: "",
	lead,
	status,
	createdAt: AT - 86_400_000,
	createdBy: "owner",
	updatedAt: AT,
	doneWhen: items(met, total),
	...(initiative !== undefined ? { initiative } : {}),
});

/** Registry order: dropped, done, active (the page shows active first). */
export const PAGE: UiWorkPage = {
	at: AT,
	initiatives: [
		rec("gamma", "Gamma archive", "ops", "dropped", 0, 1),
		rec("beta", "Beta cleanup", "qa", "done", 2, 2),
		rec("alpha", "Alpha launch", "architecture", "active", 1, 3),
	],
	projects: [
		rec("p-search", "Search box", "backend", "done", 1, 1, "alpha"),
		rec("p-login", "Login form", "frontend", "active", 1, 2, "alpha"),
		rec("p-lane", "Old lane", "ops", "done", 1, 1, "no-such-initiative"),
		rec("p-docs", "Docs sweep", "docs", "active", 0, 3, null),
	],
	tasks: [],
	activity: [],
};

const reader: UiReaderStatus = {
	enabled: false,
	model: "",
	lastModel: null,
	dailyTokenCap: 0,
	tokensToday: 0,
	capHit: false,
	tokensByDay: {},
	unread: 0,
	reads: [],
	lastRun: null,
	lastError: null,
};
const decision: UiDecision = {
	id: "d1",
	initiative: "alpha",
	filedBy: "architecture",
	title: "Ship the small form first",
	what: "The login form ships before the search box.",
	at: AT,
	lastAt: AT,
	sources: [
		{
			record: "dr-1",
			at: AT,
			kind: "plan",
			writer: "architecture",
			approval: "dialog-plan",
			you: false,
			flags: [],
			quotes: ["small first"],
			by: "architecture",
		},
	],
	head: 0,
	you: false,
	flags: [],
	changes: [],
	by: "architecture",
};
const progress: UiProgress = {
	initiative: "alpha",
	on: true,
	lead: "architecture",
	leadName: "Architecture",
	roles: [{ id: "architecture", name: "Architecture" }],
	updates: [
		{
			id: "u1",
			at: AT,
			by: "architecture",
			byName: "Architecture",
			fields: { changed: "Form landed.", next: "Wire the search box.", needsYou: "" },
			links: [],
			linksTotal: 0,
			decisions: [],
			decisionsTotal: 0,
			check: { state: "off", sentences: [], flagged: 0 },
		},
	],
	updatesTotal: 1,
	unlinked: { decisions: 0, changes: 0 },
	missing: 0,
};
const row = { decisions: 1, changes: 0, noImpact: 0, credit: 0, lastAt: AT };
export const DECISIONS: UiDecisionsPage = {
	initiatives: [{ id: "alpha", name: "Alpha launch", lead: "architecture", ...row }],
	unfiled: { id: "", name: "Unfiled", lead: null, ...row, decisions: 0 },
	selected: "alpha",
	decisions: [decision],
	total: 1,
	reader,
	perDay: {},
	progress,
};

/** The core model's arguments on the fixture; `over` replaces any of them. */
export function pageArgs(over: Partial<InitiativesPageArgs> = {}): InitiativesPageArgs {
	return {
		work: { page: PAGE, status: "ready" },
		decisions: DECISIONS,
		homeChats: { architecture: "/chats/architecture-home.jsonl" },
		now: NOW,
		t,
		open: () => {},
		...over,
	};
}
