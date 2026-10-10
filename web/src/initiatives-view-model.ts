/**
 * initiatives-page (task #84): plain helpers for the Initiatives tab (components/InitiativesView.tsx).
 *
 * Who decided is two facts side by side, never merged (Data rm-3bbf8e94): the role that wrote the record
 * (writerLabel) and how it was approved (approvalLabel). "You" shows only where the server found one of the
 * owner's own records behind the point (UiDecisionSource.you); a role's wording never makes it "you", and
 * the flags say so in plain words.
 */
import type { Translate, en } from "./i18n";
import type {
	UiApprovalKind,
	UiDecision,
	UiDecisionChange,
	UiDecisionChangeType,
	UiDecisionSource,
	UiInitiativeRow,
	UiWhoFlag,
} from "./types";

type Key = keyof typeof en;

/** Role ids read as names: "architecture" -> "Architecture"; short ones in capitals. */
const CAPITALS = new Set(["coo", "qa"]);

export function roleName(id: string | undefined): string {
	const s = (id ?? "").trim();
	if (!s) return "A role";
	if (CAPITALS.has(s.toLowerCase())) return s.toUpperCase();
	return s.charAt(0).toUpperCase() + s.slice(1);
}

/** The first fact: who wrote the record ("You" only for his own words). */
export function writerLabel(t: Translate, src: Pick<UiDecisionSource, "writer">): string {
	return src.writer === "owner" ? t("ivYou") : roleName(src.writer);
}

const APPROVAL: Record<UiApprovalKind, Key> = {
	"auto-plan": "ivApAutoPlan",
	"dialog-plan": "ivApDialogPlan",
	"dialog-pick": "ivApDialogPick",
	"dialog-question": "ivApDialogQuestion",
	order: "ivApOrder",
	message: "ivApMessage",
	"board-news": "ivApBoardNews",
	"task-report": "ivApTaskReport",
	"role-entry": "ivApRoleEntry",
};

/** The second fact: how it was approved. */
export function approvalLabel(t: Translate, kind: UiApprovalKind): string {
	return t(APPROVAL[kind] ?? "ivApMessage");
}

/** "You decided ..." for a source backed by one of his own records; null otherwise. */
export function youLabel(t: Translate, src: UiDecisionSource): string | null {
	if (!src.you) return null;
	if (src.approval === "dialog-plan") return t("ivYouPlan", { role: roleName(src.role ?? src.writer) });
	if (src.approval === "dialog-pick") return t("ivYouPick");
	if (src.approval === "order") return t("ivYouOrder");
	return t("ivYouOther");
}

/** The role whose choice a rider was: the one that asked the question (else the writer). */
function riderRole(src: UiDecisionSource | undefined): string {
	if (!src) return roleName(undefined);
	return roleName(src.role ?? (src.writer === "owner" ? undefined : src.writer));
}

/** A credit flag in plain words. */
export function flagText(t: Translate, flag: UiWhoFlag, src: UiDecisionSource | undefined): string {
	if (flag === "rider") return t("ivFlagRider", { role: riderRole(src) });
	if (flag === "claims-owner") return t("ivFlagClaims");
	return t("ivFlagQuote");
}

/** The source whose labels head an entry. */
export function headSource(
	entry: Pick<UiDecision | UiDecisionChange, "sources" | "head">,
): UiDecisionSource | undefined {
	return entry.sources[entry.head] ?? entry.sources[0];
}

/** An entry's flags, each with the plain words of the source that carries it. */
export function entryFlags(
	t: Translate,
	entry: Pick<UiDecision | UiDecisionChange, "sources" | "head" | "flags">,
): { flag: UiWhoFlag; text: string }[] {
	return entry.flags.map((flag) => {
		const src = entry.sources.find((s) => s.flags.includes(flag)) ?? headSource(entry);
		return { flag, text: flagText(t, flag, src) };
	});
}

const CHANGE: Record<UiDecisionChangeType, Key> = {
	reversed: "ivChReversed",
	widened: "ivChWidened",
	"limit-raised": "ivChLimitRaised",
	"limit-moved": "ivChLimitMoved",
	"re-recorded": "ivChReRecorded",
	"end-added": "ivChEndAdded",
	"end-changed": "ivChEndChanged",
	"end-dropped": "ivChEndDropped",
	other: "ivChOther",
};

export function changeLabel(t: Translate, type: UiDecisionChangeType): string {
	return t(CHANGE[type] ?? "ivChOther");
}

/** Who added an entry: the reader, the starting list, or a role (decision_log). */
export function addedBy(t: Translate, by: string): string {
	if (by === "reader") return t("ivTheReader");
	if (by === "seed") return t("ivTheSeed");
	return roleName(by.replace(/^role:/, ""));
}

/** How a decision was filed. */
export function filedText(t: Translate, filedBy: string, initiative: string | null): string {
	if (!initiative) return t("ivFiledNone");
	if (filedBy === "tag") return t("ivFiledTag");
	if (filedBy === "marker") return t("ivFiledMarker");
	if (filedBy === "reader") return t("ivFiledReader");
	return t("ivFiledRole", { role: roleName(filedBy.replace(/^role:/, "")) });
}

/** Shown under another initiative than its own (a record there changed it or said it again): where it is filed. */
export function alsoInText(
	t: Translate,
	d: Pick<UiDecision, "initiative">,
	selected: string | undefined,
	names: ReadonlyMap<string, string>,
): string | null {
	if (selected === undefined || selected === "" || d.initiative === selected) return null;
	const where = d.initiative ? (names.get(d.initiative) ?? d.initiative) : t("ivUnfiled");
	return t("ivAlsoIn", { where });
}

/** One line naming a source, for its link. */
export function sourceLabel(t: Translate, src: UiDecisionSource): string {
	if (src.label) return src.label;
	const kind: Record<UiDecisionSource["kind"], Key> = {
		message: "ivKindMessage",
		board: "ivKindBoard",
		answer: "ivKindAnswer",
		plan: "ivKindPlan",
		role: "ivKindRole",
	};
	return t(kind[src.kind] ?? "ivKindMessage");
}

/** The initiative row's counts line. */
export function rowCounts(t: Translate, row: UiInitiativeRow): string {
	const d = row.decisions === 1 ? t("ivDecisionOne") : t("ivDecisionMany", { n: row.decisions });
	const c = row.changes === 1 ? t("ivChangeOne") : t("ivChangeMany", { n: row.changes });
	return t("ivCounts", { d, c });
}

/** Tokens and entries per day, newest first, at most `days` days. */
export function perDayRows(
	tokensByDay: Record<string, number>,
	entriesByDay: Record<string, number>,
	days = 14,
): { day: string; tokens: number; entries: number }[] {
	const all = new Set([...Object.keys(tokensByDay), ...Object.keys(entriesByDay)]);
	return [...all]
		.sort((a, b) => (a < b ? 1 : a > b ? -1 : 0))
		.slice(0, days)
		.map((day) => ({ day, tokens: tokensByDay[day] ?? 0, entries: entriesByDay[day] ?? 0 }));
}

/** 1234567 -> "1,234,567". */
export function count(n: number): string {
	return Math.round(n).toLocaleString("en-US");
}

/** Changes worth showing (a change marked "not a decision" is left out), oldest first. */
export function shownChanges(d: Pick<UiDecision, "changes">): UiDecisionChange[] {
	return d.changes.filter((c) => !c.notDecision).sort((a, b) => a.at - b.at);
}

/** A role entry's link, when it is a web address the page may open. */
export function safeLink(link: string | undefined): string | null {
	if (!link) return null;
	return /^https?:\/\//i.test(link.trim()) ? link.trim() : null;
}
