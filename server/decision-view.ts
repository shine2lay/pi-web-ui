/**
 * decision-view (task #84): the Initiatives page's data, built from the decisions store and the records
 * (decision-who works out who decided each time, from the records' metadata).
 */
import type { DecisionRecord } from "./decision-records.js";
import { localDay } from "./decision-records.js";
import type {
	DecisionChange,
	DecisionEntry,
	DecisionSourceRef,
	DecisionStore,
	Initiative,
	OwnerField,
} from "./decision-store.js";
import { entryWho, type WhoFlag, whoOf } from "./decision-who.js";
import type {
	UiDecision,
	UiDecisionChange,
	UiDecisionRecordView,
	UiDecisionSource,
	UiDecisionsPage,
	UiInitiativeRow,
	UiOwnerField,
	UiReaderStatus,
} from "./protocol.js";

export type {
	UiDecision,
	UiDecisionChange,
	UiDecisionRecordView,
	UiDecisionSource,
	UiDecisionsPage,
	UiInitiativeRow,
	UiOwnerField,
	UiReaderStatus,
};

const QUOTE_MAX = 400;

function ownerField(f: OwnerField | undefined): UiOwnerField | undefined {
	return f ? { text: f.text, by: f.by } : undefined;
}

function labelOf(rec: DecisionRecord | undefined): string | undefined {
	if (!rec) return undefined;
	const first = (s: string | undefined) => (s ?? "").replace(/\s+/g, " ").trim().slice(0, 100);
	if (rec.source === "plan") return first(`#${rec.task ?? "?"} ${rec.plan?.title ?? rec.summary ?? ""}`);
	if (rec.source === "board") return first(rec.title);
	if (rec.source === "answer") return first(rec.questions?.map((q) => q.header || q.question).join(" · ") || rec.title);
	return first(rec.text);
}

export function sourceView(
	src: DecisionSourceRef,
	rec: DecisionRecord | undefined,
	was?: DecisionRecord,
): UiDecisionSource {
	const who = whoOf(rec, { quotes: src.quotes, claimsOwner: src.claimsOwner, part: src.part, by: src.by, was });
	return {
		...(src.record ? { record: src.record } : {}),
		...(src.ref ? { ref: src.ref } : {}),
		...(src.link ? { link: src.link } : {}),
		at: src.at,
		kind: rec ? rec.source : "role",
		writer: who.writer,
		approval: who.approval,
		...(who.role ? { role: who.role } : {}),
		...(who.relayer ? { relayer: who.relayer } : {}),
		you: who.you,
		flags: who.flags,
		quotes: src.quotes.map((q) => (q.length > QUOTE_MAX ? `${q.slice(0, QUOTE_MAX)}…` : q)),
		by: src.by,
		...(src.same ? { same: true } : {}),
		...(rec?.file ? { file: rec.file } : {}),
		...(rec?.source === "board" && rec.kind === "order"
			? {
					order: {
						ownerWords: rec.ownerWords ?? "",
						relayerText: rec.text ?? "",
						...(rec.title ? { title: rec.title } : {}),
					},
				}
			: {}),
		...(labelOf(rec) ? { label: labelOf(rec) } : {}),
	};
}

function changeView(c: DecisionChange, recs: Map<string, DecisionRecord>): UiDecisionChange {
	const sources = c.sources.map((s) =>
		sourceView(s, s.record ? recs.get(s.record) : undefined, s.was ? recs.get(s.was) : undefined),
	);
	const ew = entryWho(sources.map((s) => ({ who: { ...s, places: [] }, at: s.at })));
	return {
		id: c.id,
		type: c.type,
		what: c.what,
		at: c.at,
		...(ownerField(c.until) ? { until: ownerField(c.until) } : {}),
		...(ownerField(c.impact) ? { impact: ownerField(c.impact) } : {}),
		sources,
		head: ew.head,
		you: ew.you,
		flags: ew.flags,
		by: c.by,
		...(c.notDecision ? { notDecision: true } : {}),
	};
}

export function decisionView(d: DecisionEntry, recs: Map<string, DecisionRecord>): UiDecision {
	const sources = d.sources.map((s) =>
		sourceView(s, s.record ? recs.get(s.record) : undefined, s.was ? recs.get(s.was) : undefined),
	);
	const ew = entryWho(sources.map((s) => ({ who: { ...s, places: [] }, at: s.at })));
	const changes = d.changes.map((c) => changeView(c, recs));
	return {
		id: d.id,
		initiative: d.initiative,
		filedBy: d.filedBy,
		...(d.alsoIn?.length ? { alsoIn: [...d.alsoIn] } : {}),
		title: d.title,
		what: d.what,
		at: d.at,
		lastAt: Math.max(d.at, ...changes.map((c) => c.at)),
		...(ownerField(d.impact) ? { impact: ownerField(d.impact) } : {}),
		...(ownerField(d.options) ? { options: ownerField(d.options) } : {}),
		...(ownerField(d.until) ? { until: ownerField(d.until) } : {}),
		sources,
		head: ew.head,
		you: ew.you,
		flags: ew.flags,
		changes,
		by: d.by,
		...(d.notDecision ? { notDecision: true } : {}),
	};
}

const CREDIT: WhoFlag[] = ["claims-owner", "rider"];

function rowOf(id: string, name: string, lead: string | null, list: UiDecision[]): UiInitiativeRow {
	let changes = 0;
	let noImpact = 0;
	let credit = 0;
	let lastAt = 0;
	for (const d of list) {
		if (d.notDecision) continue;
		lastAt = Math.max(lastAt, d.lastAt);
		if (!d.impact) noImpact++;
		if (d.flags.some((f) => CREDIT.includes(f))) credit++;
		for (const c of d.changes) {
			if (c.notDecision) continue;
			changes++;
			if (!c.impact) noImpact++;
			if (c.flags.some((f) => CREDIT.includes(f))) credit++;
		}
	}
	return { id, name, lead, decisions: list.filter((d) => !d.notDecision).length, changes, noImpact, credit, lastAt };
}

export function buildDecisionsPage(
	store: DecisionStore,
	recs: Map<string, DecisionRecord>,
	reader: UiReaderStatus,
	opts: { initiative?: string; limit?: number } = {},
): UiDecisionsPage {
	const initiatives: Initiative[] = store.initiatives();
	const decisions = store
		.decisions()
		.map((d) => decisionView(d, recs))
		// Newest activity first; a tie goes to the newer decision, then by id (the same order every time).
		.sort((a, b) => b.lastAt - a.lastAt || b.at - a.at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
	const perDay: Record<string, number> = {};
	for (const d of decisions) {
		if (d.notDecision) continue;
		perDay[localDay(d.at)] = (perDay[localDay(d.at)] ?? 0) + 1;
		for (const c of d.changes) if (!c.notDecision) perDay[localDay(c.at)] = (perDay[localDay(c.at)] ?? 0) + 1;
	}
	const known = new Set(initiatives.map((i) => i.id));
	const sel = opts.initiative;
	// An initiative lists its own decisions and those its records changed or restated (alsoIn).
	const under = (d: UiDecision, id: string) => d.initiative === id || !!d.alsoIn?.includes(id);
	const picked =
		sel === undefined
			? decisions
			: decisions.filter(
					(d) => !d.notDecision && (sel === "" ? !d.initiative || !known.has(d.initiative) : under(d, sel)),
				);
	const limit = opts.limit && opts.limit > 0 ? opts.limit : picked.length;
	return {
		initiatives: initiatives.map((i) =>
			rowOf(
				i.id,
				i.name,
				i.lead,
				decisions.filter((d) => under(d, i.id)),
			),
		),
		unfiled: rowOf(
			"",
			"Unfiled",
			null,
			decisions.filter((d) => !d.initiative || !known.has(d.initiative)),
		),
		...(sel !== undefined ? { selected: sel } : {}),
		decisions: picked.slice(0, limit),
		total: picked.length,
		reader,
		perDay,
	};
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);

/** One kept record as the source dialog shows it: what it says, not the store's own fields. */
export function recordView(rec: DecisionRecord, chat?: { path?: string; title?: string }): UiDecisionRecordView {
	const to = Array.isArray(rec.to) ? rec.to.join(", ") : str(rec.to);
	const plan = rec.plan;
	return {
		id: rec.id,
		source: rec.source,
		at: rec.at,
		from: rec.from,
		...(to ? { to } : {}),
		ref: rec.ref,
		...(str(rec.kind) ? { kind: str(rec.kind) } : {}),
		...(str(rec.title) ? { title: str(rec.title) } : {}),
		...(str(rec.text) ? { text: str(rec.text) } : {}),
		...(str(rec.ownerWords) ? { ownerWords: str(rec.ownerWords) } : {}),
		...(str(rec.via) ? { via: str(rec.via) } : {}),
		...(str(rec.chat) ? { chat: str(rec.chat) } : {}),
		...(typeof rec.task === "number" ? { task: rec.task } : {}),
		...(str(rec.op) ? { op: str(rec.op) } : {}),
		...(str(rec.approval) ? { approval: str(rec.approval) } : {}),
		...(plan
			? {
					plan: {
						...(plan.title ? { title: plan.title } : {}),
						...(plan.goal ? { goal: plan.goal } : {}),
						...(plan.doneWhen ? { doneWhen: plan.doneWhen } : {}),
						...(plan.decided ? { decided: plan.decided } : {}),
						...(plan.steps ? { steps: plan.steps } : {}),
						...(plan.verify ? { verify: plan.verify } : {}),
						...(plan.mustNot ? { mustNot: plan.mustNot } : {}),
					},
				}
			: {}),
		...(str(rec.summary) ? { summary: str(rec.summary) } : {}),
		...(rec.questions?.length
			? {
					questions: rec.questions.map((q) => ({
						id: q.id,
						...(q.header ? { header: q.header } : {}),
						question: q.question,
						...(q.detail ? { detail: q.detail } : {}),
						options: (q.options ?? []).map((o) => ({
							label: o.label,
							...(o.description ? { description: o.description } : {}),
							...(o.preview ? { preview: o.preview } : {}),
						})),
						picked: q.picked ?? [],
						...(q.typed ? { typed: q.typed } : {}),
					})),
				}
			: {}),
		...(chat?.path ? { chatPath: chat.path } : {}),
		...(chat?.title ? { chatTitle: chat.title } : {}),
	};
}

/** The records a set of decisions cite, by id. */
export function citedRecords(store: DecisionStore, all: DecisionRecord[]): Map<string, DecisionRecord> {
	const want = new Set<string>();
	for (const d of store.decisions()) {
		for (const s of [...d.sources, ...d.changes.flatMap((c) => c.sources)]) {
			if (s.record) want.add(s.record);
			if (s.was) want.add(s.was);
		}
	}
	const out = new Map<string, DecisionRecord>();
	for (const r of all) if (want.has(r.id)) out.set(r.id, r);
	return out;
}
