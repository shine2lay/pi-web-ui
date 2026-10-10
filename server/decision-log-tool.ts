// ---------------------------------------------------------------------------
// decision-log-tool.ts — decision_log: roles add and correct the Initiatives page's decisions (task #84)
// ---------------------------------------------------------------------------
// The reader (decision-reader.ts) finds decisions in the kept records; this tool lets a role list them,
// add one that lived only in files, notes or code (with a link), fill the owner's three fields (impact,
// other options and their cost, until when), refile one, mark one "not a decision", and add an
// initiative. Every entry shows who added it. A role's entry never says the owner decided: it can only
// point to one of his records (owner_record), and decision-who then checks that his own words hold the
// point. Registered in every pi-engine chat like message_role; it refuses a chat without a role.
// ---------------------------------------------------------------------------

import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { DecisionRecord } from "./decision-records.js";
import { localDay } from "./decision-records.js";
import {
	CHANGE_TYPES,
	type ChangeType,
	type DecisionEntry,
	type DecisionSourceRef,
	type DecisionStore,
	type Initiative,
	type OwnerField,
} from "./decision-store.js";
import { decisionView, type UiDecisionSource } from "./decision-view.js";
import { type ApprovalKind, textClaimsOwner, whoOf } from "./decision-who.js";
import type { RoleMessageSender } from "./role-messages.js";
import { DECISION_LOG_TOOL_NAME } from "./tool-manager.js";

export { DECISION_LOG_TOOL_NAME };

export interface DecisionLogHost {
	/** The calling chat as the server knows it; a string = why it can't use the tool. */
	sender(): RoleMessageSender | string;
	store(): DecisionStore | undefined;
	/** A kept record by its id (dr-…) or its ref (rm-…, bp-…, ask:…, <chat file>:<line>). */
	record(idOrRef: string): DecisionRecord | undefined;
	/** Kept records by id, for who-decided labels. */
	records(ids: string[]): Map<string, DecisionRecord>;
	/** The page changed. */
	changed(): void;
	now?: () => number;
}

export const FIELD_MAX = 1_000;
const LIST_MAX = 40;

export const APPROVAL_WORDS: Record<ApprovalKind, string> = {
	"auto-plan": "auto-approved plan (the owner didn't see it)",
	"dialog-plan": "plan the owner approved in a dialog",
	"dialog-pick": "the owner's pick in a dialog",
	"dialog-question": "a role's question in a dialog",
	order: "the owner's order",
	message: "message",
	"board-news": "Board news",
	"task-report": "a queued task's done note",
	"role-entry": "added by a role",
};

function whoLine(s: UiDecisionSource): string {
	const writer = s.writer === "owner" ? "the owner" : s.writer || "unknown";
	const parts = [`${writer} · ${APPROVAL_WORDS[s.approval]}`];
	if (s.flags.includes("rider")) parts.push(`${s.role ?? "a role"}'s choice inside the option the owner picked`);
	if (s.flags.includes("claims-owner")) parts.push("a role says the owner decided; not in his words");
	if (s.flags.includes("quote-not-found")) parts.push("quote not found word for word");
	return parts.join("; ");
}

function missing(d: { impact?: unknown; options?: unknown; until?: unknown }, withOptions: boolean): string {
	const out = [!d.impact && "impact", withOptions && !d.options && "options", !d.until && "until"].filter(Boolean);
	return out.length ? ` · not given: ${out.join(", ")}` : "";
}

export function listText(
	store: DecisionStore,
	records: Map<string, DecisionRecord>,
	initiative?: string,
	limit = LIST_MAX,
): string {
	const all = store.decisions();
	const want = initiative?.trim().toLowerCase();
	const picked = all
		.filter((d) =>
			want === undefined || want === "" ? true : want === "unfiled" ? !d.initiative : d.initiative === want,
		)
		.sort((a, b) => Math.max(b.at, ...b.changes.map((c) => c.at)) - Math.max(a.at, ...a.changes.map((c) => c.at)));
	if (!picked.length) return want ? `No decisions under ${want}.` : "No decisions yet.";
	const lines: string[] = [];
	for (const d of picked.slice(0, limit)) {
		const v = decisionView(d, records);
		const head = v.sources[v.head];
		lines.push(
			`${d.id} [${d.initiative ?? "unfiled"}] ${localDay(d.at)} ${d.title}: ${d.what}${d.notDecision ? " (marked not a decision)" : ""}`,
		);
		if (head) lines.push(`   who: ${whoLine(head)}${v.you ? " · counts as the owner's" : ""}${missing(d, true)}`);
		for (const c of v.changes) {
			const ch = c.sources[c.head];
			lines.push(
				`   ${c.id} ${c.type} ${localDay(c.at)}: ${c.what}${c.notDecision ? " (marked not a decision)" : ""}${ch ? ` · ${whoLine(ch)}` : ""}${missing(c, false)}`,
			);
		}
	}
	if (picked.length > limit) lines.push(`(${picked.length - limit} more; give limit to see more.)`);
	return lines.join("\n");
}

function clean(s: unknown, max = FIELD_MAX): string {
	return typeof s === "string" ? s.trim().slice(0, max) : "";
}

export function slugOf(name: string): string {
	return name
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 60);
}

export interface DecisionLogParams {
	action: string;
	initiative?: string;
	id?: string;
	of?: string;
	type?: string;
	title?: string;
	what?: string;
	quotes?: string[];
	link?: string;
	owner_record?: string;
	at?: string;
	impact?: string;
	options?: string;
	until?: string;
	why?: string;
	restore?: boolean;
	name?: string;
	markers?: string[];
	limit?: number;
}

/** The tool's work, without the tool wrapper (tests call it directly). Throws plain-word errors. */
export function runDecisionLog(
	host: DecisionLogHost,
	p: DecisionLogParams,
): { text: string; details: Record<string, unknown> } {
	const store = host.store();
	if (!store) throw new Error("The decision log isn't available in this app.");
	const sender = host.sender();
	if (typeof sender === "string") throw new Error(sender);
	const by = `role:${sender.role}`;
	const now = host.now ? host.now() : Date.now();
	const action = clean(p.action, 40).toLowerCase();
	const initiatives = store.initiatives();
	const knownInitiative = (id: string): Initiative | undefined => initiatives.find((i) => i.id === id);
	const allRecordIds = (): string[] => {
		const ids: string[] = [];
		for (const d of store.decisions()) {
			for (const s of d.sources) if (s.record) ids.push(s.record);
			for (const c of d.changes) for (const s of c.sources) if (s.record) ids.push(s.record);
		}
		return ids;
	};

	if (action === "list") {
		const limit = Math.max(1, Math.min(200, Math.round(Number(p.limit) || LIST_MAX)));
		const text = listText(store, host.records(allRecordIds()), p.initiative, limit);
		const head = `Initiatives: ${initiatives.map((i) => `${i.id} (${i.name})`).join(", ") || "none"}.`;
		return { text: `${head}\n${text}`, details: { action } };
	}

	if (action === "add_initiative") {
		const name = clean(p.name, 80);
		if (!name) throw new Error("add_initiative needs a name.");
		const id = clean(p.id, 60).toLowerCase() || slugOf(name);
		if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id) || id.length > 60)
			throw new Error(
				"The initiative id must be lowercase letters and digits with a dash between words, at most 60 characters.",
			);
		if (knownInitiative(id)) throw new Error(`There is already an initiative ${id}.`);
		const markers = (Array.isArray(p.markers) ? p.markers : [])
			.map((m) => clean(m, 200))
			.filter(Boolean)
			.slice(0, 50);
		store.saveInitiatives([...initiatives, { id, name, markers, lead: null, addedBy: by }]);
		host.changed();
		return { text: `Added initiative ${id} (${name}) with ${markers.length} markers.`, details: { action, id } };
	}

	if (action === "add") {
		const what = clean(p.what, 500);
		if (!what) throw new Error("add needs what: one plain sentence saying what was decided or changed.");
		const link = clean(p.link, 500);
		const ownerRef = clean(p.owner_record, 300);
		if (!link && !ownerRef)
			throw new Error(
				"add needs a link to where it lives (a file, note or commit), or owner_record pointing to one of the owner's records.",
			);
		const quotes = (Array.isArray(p.quotes) ? p.quotes : [])
			.map((q) => clean(q, 400))
			.filter(Boolean)
			.slice(0, 3);
		let at = now;
		if (p.at) {
			const t = Date.parse(p.at);
			if (!Number.isFinite(t)) throw new Error("at must be a date and time, like 2026-10-05T14:30:00-07:00.");
			at = t;
		}
		const source: DecisionSourceRef = { at, quotes, by, ...(link ? { link } : {}) };
		let confirm = "";
		if (ownerRef) {
			const rec = host.record(ownerRef);
			if (!rec)
				throw new Error(
					`No kept record ${ownerRef}. Give its dr-… id or its ref (rm-…, bp-…, ask:…, <chat file>:<line>).`,
				);
			if (!quotes.length)
				throw new Error("owner_record needs quotes: the owner's own words that hold the point, copied word for word.");
			source.record = rec.id;
			source.ref = rec.ref;
			if (!p.at) source.at = rec.at;
			const who = whoOf(rec, { quotes, by });
			confirm = who.you
				? " The owner's own words in that record hold it, so it counts as his."
				: " That record doesn't show the owner's own words holding it, so it doesn't count as his.";
		} else if (textClaimsOwner(`${clean(p.title, 120)} ${what}`)) {
			source.claimsOwner = true;
			confirm = " It says the owner decided without pointing to one of his records, so the page flags it.";
		}
		if (p.of) {
			const target = store.get(clean(p.of, 20));
			if (!target) throw new Error(`No decision ${p.of}. Use list to see the ids.`);
			const type = clean(p.type, 30).toLowerCase() as ChangeType;
			if (!(CHANGE_TYPES as readonly string[]).includes(type))
				throw new Error(`type must be one of: ${CHANGE_TYPES.join(", ")}.`);
			const change = store.addChange(target, { type, what, at: source.at, sources: [source], by });
			store.save();
			host.changed();
			return {
				text: `Added change ${change.id} (${type}) to ${target.id}.${confirm}`,
				details: { action, id: change.id },
			};
		}
		const ini = clean(p.initiative, 60).toLowerCase();
		if (ini && !knownInitiative(ini))
			throw new Error(`No initiative ${ini}. Use add_initiative first, or leave it out for Unfiled.`);
		const entry = store.addDecision({
			initiative: ini || null,
			filedBy: ini ? by : "",
			title: clean(p.title, 120) || what.slice(0, 60),
			what,
			at: source.at,
			sources: [source],
			by,
		});
		store.save();
		host.changed();
		return {
			text: `Added decision ${entry.id}${ini ? ` under ${ini}` : " (Unfiled)"}.${confirm}`,
			details: { action, id: entry.id },
		};
	}

	const id = clean(p.id, 20).toLowerCase();
	const decision = id.startsWith("d") ? store.get(id) : undefined;
	const found = id.startsWith("c") ? store.findChange(id) : undefined;
	if (!decision && !found) throw new Error(`No decision or change ${p.id ?? "(no id)"}. Use list to see the ids.`);

	if (action === "fill") {
		const field = (v: unknown): OwnerField | null | undefined => {
			if (v === undefined) return undefined;
			const text = clean(v);
			return text ? { text, by, at: now } : null;
		};
		const impact = field(p.impact);
		const options = field(p.options);
		const until = field(p.until);
		if (impact === undefined && options === undefined && until === undefined)
			throw new Error('fill needs impact, options or until ("" clears one).');
		const target: { impact?: OwnerField; options?: OwnerField; until?: OwnerField } = decision ?? found!.change;
		if (options !== undefined && !decision) throw new Error("options goes on a decision (d…), not on a change.");
		const set = (k: "impact" | "options" | "until", v: OwnerField | null | undefined) => {
			if (v === undefined) return;
			if (v === null) delete target[k];
			else target[k] = v;
		};
		set("impact", impact);
		set("options", options);
		set("until", until);
		store.save();
		host.changed();
		return { text: `Filled ${id}.`, details: { action, id } };
	}

	if (action === "refile") {
		if (!decision) throw new Error("refile takes a decision id (d…); its changes go with it.");
		const ini = clean(p.initiative, 60).toLowerCase();
		if (ini && !knownInitiative(ini)) throw new Error(`No initiative ${ini}.`);
		decision.initiative = ini || null;
		decision.filedBy = by;
		if (decision.alsoIn) {
			decision.alsoIn = decision.alsoIn.filter((x) => x !== ini);
			if (!decision.alsoIn.length) delete decision.alsoIn;
		}
		store.save();
		host.changed();
		return { text: `Filed ${id} under ${ini || "Unfiled"}.`, details: { action, id } };
	}

	if (action === "not_decision") {
		const target: DecisionEntry | { notDecision?: DecisionEntry["notDecision"] } = decision ?? found!.change;
		if (p.restore) delete target.notDecision;
		else target.notDecision = { by, at: now, ...(clean(p.why, 300) ? { why: clean(p.why, 300) } : {}) };
		store.save();
		host.changed();
		return { text: p.restore ? `${id} is shown again.` : `Marked ${id} not a decision.`, details: { action, id } };
	}

	throw new Error('action must be "list", "add", "fill", "refile", "not_decision" or "add_initiative".');
}

export function makeDecisionLogTool(host: DecisionLogHost): ToolDefinition {
	return defineTool({
		name: DECISION_LOG_TOOL_NAME,
		label: "Decision log",
		description:
			'Correct the Initiatives page\'s decision log: each initiative\'s design decisions, their changes, who decided and what they cost the owner (a small model fills it from the records). list: an initiative\'s decisions (or "unfiled"). add: a decision, or with of + type a change, that lived only in files, notes or code, with a link. Never say the owner decided: to show it as his, give owner_record (his dialog answer or order) and quotes of his own words; the code checks them. fill: impact, options (and their cost), until; "" clears one. refile: another initiative ("" = Unfiled). not_decision: hide one (restore: true undoes). add_initiative: name, id, markers. Entries show which role added them.',
		promptSnippet:
			"decision_log: list and correct the Initiatives page's decisions (add with a link, fill impact/options/until, refile, not_decision, add_initiative)",
		parameters: Type.Object({
			action: Type.String({ description: '"list", "add", "fill", "refile", "not_decision" or "add_initiative".' }),
			initiative: Type.Optional(
				Type.String({
					description: 'list: an initiative id or "unfiled"; add, refile: the initiative id ("" = Unfiled).',
				}),
			),
			id: Type.Optional(
				Type.String({
					description: "fill, refile, not_decision: the decision (d…) or change (c…) id; add_initiative: the new id.",
				}),
			),
			of: Type.Optional(
				Type.String({ description: "add: the decision (d…) this changes; leave out for a new decision." }),
			),
			type: Type.Optional(Type.String({ description: `add with of: ${CHANGE_TYPES.join(", ")}.` })),
			title: Type.Optional(Type.String({ description: "add: a few plain words naming the decision." })),
			what: Type.Optional(Type.String({ description: "add: one plain sentence saying what was decided or changed." })),
			quotes: Type.Optional(
				Type.Array(Type.String(), { description: "add: 1-3 quotes of the point, word for word from where it lives." }),
			),
			link: Type.Optional(Type.String({ description: "add: where it lives (a file path, note id, commit or URL)." })),
			owner_record: Type.Optional(
				Type.String({
					description:
						"add: one of the owner's records that holds it (dr-…, ask:…, bp-…); the code checks his own words.",
				}),
			),
			at: Type.Optional(
				Type.String({ description: "add: when it was decided (ISO date and time); default now or the record's time." }),
			),
			impact: Type.Optional(Type.String({ description: "fill: what it costs or changes for the owner." })),
			options: Type.Optional(Type.String({ description: "fill: the other options and what each would cost." })),
			until: Type.Optional(Type.String({ description: "fill: until when it holds, or what ends it." })),
			why: Type.Optional(Type.String({ description: "not_decision: why." })),
			restore: Type.Optional(Type.Boolean({ description: "not_decision: true shows it again." })),
			name: Type.Optional(Type.String({ description: "add_initiative: its name." })),
			markers: Type.Optional(
				Type.Array(Type.String(), { description: "add_initiative: words that file records under it." }),
			),
			limit: Type.Optional(Type.Number({ description: "list: how many decisions (default 40)." })),
		}),
		execute: async (_id, p, _signal, _onUpdate, _ctx) => {
			const res = runDecisionLog(host, p as DecisionLogParams);
			return { content: [{ type: "text", text: res.text }], details: res.details };
		},
	});
}
