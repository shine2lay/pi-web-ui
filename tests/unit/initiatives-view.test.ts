/**
 * initiatives-page (task #84): the Initiatives tab's helpers and what the page shows. Who decided is two
 * facts side by side (never merged); "You decided" only where his own record backs it; credit flags,
 * an order's two parts and "not given" fields are on the card itself.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import type {
	UiDecision,
	UiDecisionChange,
	UiDecisionSource,
	UiDecisionsPage,
	UiInitiativeRow,
	UiReaderStatus,
} from "../../server/protocol.js";
import { setAppSend } from "../../web/src/app-globals.js";
import { InitiativesView } from "../../web/src/components/InitiativesView.js";
import { en, LanguageProvider, type Translate } from "../../web/src/i18n.js";
import { receiveInitiatives, resetInitiativesState } from "../../web/src/initiatives-state.js";
import {
	alsoInText,
	approvalLabel,
	changeLabel,
	entryFlags,
	perDayRows,
	roleName,
	writerLabel,
	youLabel,
} from "../../web/src/initiatives-view-model.js";

const t: Translate = (key, vars) => {
	let s: string = en[key];
	for (const [k, v] of Object.entries(vars ?? {})) s = s.replaceAll(`{${k}}`, String(v));
	return s;
};
const AT = Date.parse("2026-10-07T18:00:00Z");

const src = (over: Partial<UiDecisionSource>): UiDecisionSource => ({
	record: "dr-1",
	at: AT,
	kind: "plan",
	writer: "architecture",
	approval: "auto-plan",
	you: false,
	flags: [],
	quotes: ["one watched team"],
	by: "reader",
	label: "Plan #37: first trial",
	...over,
});

const decision = (over: Partial<UiDecision>): UiDecision => ({
	id: "d1",
	initiative: "team-in-temper",
	filedBy: "marker",
	title: "One watched team",
	what: "The first trial runs one team, watched.",
	at: AT,
	lastAt: AT,
	sources: [src({})],
	head: 0,
	you: false,
	flags: [],
	changes: [],
	by: "reader",
	...over,
});

const row = (over: Partial<UiInitiativeRow>): UiInitiativeRow => ({
	id: "team-in-temper",
	name: "Team in Temper",
	lead: null,
	decisions: 3,
	changes: 1,
	noImpact: 3,
	credit: 2,
	lastAt: AT,
	...over,
});

const READER: UiReaderStatus = {
	enabled: true,
	model: "auto",
	lastModel: "claude-haiku",
	dailyTokenCap: 2_000_000,
	tokensToday: 123_456,
	capHit: false,
	tokensByDay: { "2026-10-09": 900_000, "2026-10-10": 123_456 },
	unread: 4,
	reads: ["team-in-temper"],
	lastRun: AT,
	lastError: null,
};

describe("initiatives-page: who decided, in plain words", () => {
	it("gives the writer and the approval kind as two separate facts", () => {
		const s = src({ writer: "architecture", approval: "auto-plan" });
		expect(writerLabel(t, s)).toBe("Architecture");
		expect(approvalLabel(t, s.approval)).toBe("auto-approved plan (you didn't see it)");
		expect(writerLabel(t, src({ writer: "owner", approval: "dialog-pick" }))).toBe("You");
		expect(roleName("coo")).toBe("COO");
	});

	it("says 'you decided' only for a source his own record backs", () => {
		expect(youLabel(t, src({ you: false, approval: "dialog-pick" }))).toBeNull();
		expect(youLabel(t, src({ you: true, approval: "dialog-pick", writer: "owner" }))).toBe("You decided: your pick");
		expect(youLabel(t, src({ you: true, approval: "dialog-plan", writer: "temper", role: "temper" }))).toBe(
			"Temper proposed, you approved",
		);
		expect(youLabel(t, src({ you: true, approval: "order", writer: "owner" }))).toBe("You decided: in your words");
	});

	it("names whose choice a rider was, and says when a role claims he decided", () => {
		const rider = src({ writer: "owner", approval: "dialog-pick", role: "temper", flags: ["rider"] });
		const claim = src({ writer: "coo", approval: "message", flags: ["claims-owner"] });
		const entry = decision({ sources: [rider, claim], flags: ["rider", "claims-owner"] });
		expect(entryFlags(t, entry).map((f) => f.text)).toEqual([
			"Temper's choice, inside the option you picked",
			"A role says you decided; not in your words",
		]);
	});

	it("labels changes and lists tokens and entries per day, newest first", () => {
		expect(changeLabel(t, "re-recorded")).toBe("Re-recorded as yours");
		expect(changeLabel(t, "limit-raised")).toBe("Limit raised");
		expect(perDayRows({ "2026-10-09": 5, "2026-10-10": 7 }, { "2026-10-08": 2, "2026-10-10": 3 })).toEqual([
			{ day: "2026-10-10", tokens: 7, entries: 3 },
			{ day: "2026-10-09", tokens: 5, entries: 0 },
			{ day: "2026-10-08", tokens: 0, entries: 2 },
		]);
	});

	it("says where a decision listed under another initiative is filed", () => {
		const names = new Map([["team-in-temper", "Team in Temper"]]);
		expect(alsoInText(t, { initiative: null }, "team-in-temper", names)).toBe(
			"Filed under Unfiled; a record of this initiative changed it or said it again",
		);
		expect(alsoInText(t, { initiative: "team-in-temper" }, "team-in-temper", names)).toBeNull();
	});
});

describe("initiatives-page: the page", () => {
	afterEach(() => {
		resetInitiativesState();
		setAppSend(() => false);
	});

	function page(): UiDecisionsPage {
		const claimed = decision({
			id: "d-claim",
			title: "Serial turns",
			sources: [
				src({
					writer: "architecture",
					approval: "board-news",
					kind: "board",
					flags: ["claims-owner"],
					label: "Board: first trial terms",
				}),
			],
			flags: ["claims-owner"],
		});
		const order = decision({
			id: "d-order",
			title: "Message roles with message_role",
			sources: [
				src({
					writer: "coo",
					approval: "order",
					kind: "board",
					relayer: "coo",
					flags: ["claims-owner"],
					order: { ownerWords: "use message_role from now on", relayerText: "Owner decided: no tell_chat copies." },
				}),
			],
			flags: ["claims-owner"],
			impact: { text: "Fewer copies to read.", by: "reader" },
		});
		const change: UiDecisionChange = {
			id: "c1",
			type: "reversed",
			what: "Members work at the same time.",
			at: AT + 60_000,
			sources: [src({ writer: "owner", approval: "dialog-plan", role: "temper", you: true, kind: "answer" })],
			head: 0,
			you: true,
			flags: [],
			by: "reader",
		};
		const picked = decision({
			id: "d-pick",
			title: "Turns one at a time",
			sources: [src({ writer: "owner", approval: "dialog-pick", role: "temper", kind: "answer", flags: ["rider"] })],
			flags: ["rider"],
			changes: [change],
		});
		return {
			initiatives: [row({})],
			unfiled: row({ id: "", name: "Unfiled", decisions: 1, changes: 0, noImpact: 1, credit: 0 }),
			selected: "team-in-temper",
			decisions: [order, claimed, picked],
			total: 4,
			reader: READER,
			perDay: { "2026-10-07": 4 },
		};
	}

	const render = (phone: boolean) =>
		renderToStaticMarkup(
			createElement(LanguageProvider, null, createElement(InitiativesView, { active: true, phone, onOpen: () => {} })),
		);

	it("shows each card's two who labels apart, its flags, an order's two parts and what isn't given", () => {
		setAppSend(() => true);
		receiveInitiatives({ type: "initiatives", page: page() });
		for (const phone of [false, true]) {
			const html = render(phone);
			// The two facts, each its own label (never one merged "who").
			expect(html).toContain(
				'<span class="iv-chip iv-writer"><span class="iv-sr">Written by: </span>Architecture</span>',
			);
			expect(html).toContain(
				'<span class="iv-chip iv-approval"><span class="iv-sr">Approval: </span>Board news</span>',
			);
			// A role's wording never makes it his.
			expect(html).toContain("A role says you decided; not in your words");
			expect(html).toContain("Temper&#x27;s choice, inside the option you picked");
			// The order's own words and the relayer's text, labelled apart.
			expect(html).toContain("Your words");
			expect(html).toContain("use message_role from now on");
			expect(html).toContain("COO&#x27;s text");
			// The owner fields: given, or "not given".
			expect(html).toContain("Fewer copies to read.");
			expect(html).toContain('<span class="iv-ng">not given</span>');
			// A change under its decision: its type and its own who labels.
			expect(html).toContain('<span class="iv-type">Reversed</span>');
			expect(html).toContain("Temper proposed, you approved");
			// The initiative list, its counts and flags; the selected one is marked.
			expect(html).toContain('aria-current="true"');
			expect(html).toContain("3 without impact for you");
			expect(html).toContain("2 with a credit flag");
			// More than shown: say so, offer more.
			expect(html).toContain("Showing 3 of 4");
			// The reader's tokens today, against the cap.
			expect(html).toContain("4 records not read yet · 123,456 tokens today of 2,000,000");
		}
	});

	it("says which initiatives the reader reads, and which are off (task #98)", () => {
		setAppSend(() => true);
		const p = page();
		p.initiatives = [row({}), row({ id: "decisions-page", name: "Decisions page" })];
		receiveInitiatives({ type: "initiatives", page: p });
		let html = render(false);
		expect(html).toContain("Reads: Team in Temper");
		expect(html).toContain("off: Decisions page");
		receiveInitiatives({ type: "initiatives", page: { ...p, reader: { ...READER, reads: [] } } });
		html = render(false);
		expect(html).toContain("Reads: no initiative, so nothing is read");
		// Switched off: it says so, and no reads line.
		receiveInitiatives({ type: "initiatives", page: { ...p, reader: { ...READER, enabled: false } } });
		html = render(false);
		expect(html).toContain("The reader is switched off");
		expect(html).not.toContain("Reads:");
	});

	it("shows no 'You decided' on a card that only a role's words credit to him", () => {
		setAppSend(() => true);
		const p = page();
		p.decisions = [p.decisions[1]];
		p.total = 1;
		receiveInitiatives({ type: "initiatives", page: p });
		const html = render(false);
		expect(html).toContain("A role says you decided; not in your words");
		expect(html).not.toContain("You decided");
		expect(html).not.toContain("Show more");
	});
});
