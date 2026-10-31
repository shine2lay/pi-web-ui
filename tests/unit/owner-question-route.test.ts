/**
 * owner-question-routing (Ops #684, H-OWNER-ROUTE-RULE): the route rule's known-case table.
 *
 * Every case builds the asking chat's turn record the way the host does (index.ts's
 * browserRoleInput, agent-service's requesterForAdmission and noteTurnCause's collectRoleInput,
 * sendToRole's Telegram fields, carry-on's saved inputs), gives the host's own time of his last
 * input in the chat (or none) and the time now, then asks the rule. No case carries words the rule
 * could read: the decision comes from the record and the host's times alone.
 */
import { describe, expect, it } from "vitest";
import type { AskKind } from "../../server/asks.js";
import {
	cameThroughCooLabel,
	cooReasonWords,
	directRouteLabel,
	FROM_COO_CHAT_LABEL,
	OWNER_CHATTING_WINDOW_MS,
	OWNER_QUESTION_COO_REASONS,
	OWNER_QUESTION_DIRECT_REASONS,
	OWNER_QUESTION_ROUTE_REASONS,
	ownerChattingLabel,
	ownerQuestionRoute,
	type OwnerQuestionRoute,
	type OwnerQuestionRouteInput,
} from "../../server/owner-question-route.js";
import { requesterForAdmission, type RequesterTurn } from "../../server/queue-requester.js";
import {
	browserRoleInput,
	collectRoleInput,
	newTurnRecord,
	type RoleTurnInput,
	type RoleTurnRecord,
} from "../../server/role-replies.js";
import type { UiTaskRequesterInput } from "../../server/protocol.js";

/** The host's time now, in every case. */
const NOW = Date.UTC(2026, 9, 31, 20, 0, 0);
const MIN = 60_000;
/** The host's time of his last input in the chat, `ms` before now. */
const ago = (ms: number): number => NOW - ms;

let seq = 0;
const nextId = (prefix: "ri" | "rs"): string => `${prefix}-${(++seq).toString(16).padStart(8, "0")}`;

/** One input as the host admits it: its admission metadata, the source it came through. */
interface HostInput {
	how: Omit<RoleTurnInput, "requester"> & { requester?: UiTaskRequesterInput };
	source?: "extension";
}

/** pi took this input into the turn record (agent-service noteTurnCause / queueRoleMailForResume). */
function take(rec: RoleTurnRecord, input: HostInput): void {
	const { how } = input;
	const requester = requesterForAdmission({
		...(how.cause ? { cause: how.cause } : {}),
		...(input.source ? { source: input.source } : {}),
		...(how.ownerChannel ? { ownerChannel: how.ownerChannel } : {}),
		...(how.sendId ? { sendId: how.sendId } : {}),
		...(how.requester ? { requester: how.requester } : {}),
		inputId: nextId("ri"),
	});
	collectRoleInput(rec, { ...how, requester });
}

const turnOf = (inputs: HostInput[]): RoleTurnRecord => {
	const rec = newTurnRecord();
	for (const input of inputs) take(rec, input);
	return rec;
};

// The ways a text reaches a chat, as the host labels them.
const ownerPage = (): HostInput => ({ how: browserRoleInput(true, false) });
const pseudoClientPage = (): HostInput => ({ how: browserRoleInput(true, true) });
const unacceptedPage = (): HostInput => ({ how: browserRoleInput(false, false) });
const telegramOwner = (): HostInput => ({
	how: { cause: "telegram", sendId: nextId("rs"), ownerChannel: "telegram" },
	source: "extension",
});
const pluginSend = (): HostInput => ({ how: { cause: "plugin", sendId: nextId("rs") }, source: "extension" });
const roleMessage = (message: "question" | "request" | "reply" = "request"): HostInput => ({
	how: { cause: "role", requester: { kind: "role", role: "temper", id: `rm-${nextId("ri").slice(3)}`, message } },
	source: "extension",
});
const forOwnerReply = (): HostInput => {
	const ownerIds = [nextId("rs")];
	return {
		how: {
			cause: "role",
			requester: {
				kind: "role",
				role: "temper",
				id: `rm-${nextId("ri").slice(3)}`,
				message: "reply",
				forOwner: true,
				ownerIds,
			},
			forOwner: { answeredBy: ["temper"], ownerIds },
		},
		source: "extension",
	};
};
/** A Board order sent straight to a role with something waiting (a role delivery, no requester). */
const boardPost = (): HostInput => ({ how: { cause: "role" }, source: "extension" });
/** pi-queue's prompts and reminders, an extension's sendUserMessage: no requester. */
const queuePrompt = (): HostInput => ({ how: { cause: "other" }, source: "extension" });
const queueReminder = (): HostInput => ({ how: { cause: "other" }, source: "extension" });
const extensionMessage = (): HostInput => ({ how: { cause: "other" }, source: "extension" });
/** wake-reopen's pseudo client prompts the scheduled text: no owner channel. */
const scheduleWake = (): HostInput => ({ how: { cause: "other" } });
/** A subagent's chat gets its prompt from the parent chat. */
const subagentPrompt = (): HostInput => ({ how: { cause: "other" } });
/** carry-on: the note that carries on a turn a restart cut off brings that turn's saved inputs. */
const carriedOn = (saved: RequesterTurn): HostInput => ({ how: { cause: "other", carried: saved } });

/** What a cut-off turn saved (running-chats keeps the record's requester inputs). */
const savedTurnOf = (inputs: HostInput[]): RequesterTurn => {
	const rec = turnOf(inputs);
	return {
		...(rec.requesterInputs ? { requesterInputs: rec.requesterInputs.map((i) => ({ ...i })) } : {}),
		...(rec.requesterOverflow ? { requesterOverflow: true as const } : {}),
	};
};

interface Case {
	name: string;
	kind: AskKind;
	turn?: HostInput[];
	/** A turn the chat had before (not the asking turn): the rule never sees it. */
	earlierTurn?: HostInput[];
	/** The host's time of his last accepted input in the chat; absent = not known. */
	wrote?: number;
	homeRole?: string;
	grant?: boolean;
	askedAgainAfterReturn?: boolean;
	want: OwnerQuestionRoute;
}

const direct = (reason: Extract<OwnerQuestionRoute, { to: "direct" }>["reason"]): OwnerQuestionRoute => ({
	to: "direct",
	reason,
});
const coo = (reason: Extract<OwnerQuestionRoute, { to: "coo" }>["reason"]): OwnerQuestionRoute => ({
	to: "coo",
	reason,
});

const ownerOverflowTurn = (): RequesterTurn => ({ requesterOverflow: true });

function cases(): Case[] {
	return [
		{
			name: "owner page prompt",
			kind: "question",
			turn: [ownerPage()],
			wrote: ago(1 * MIN),
			want: direct("owner-chatting"),
		},
		{
			name: "pseudo-client prompt",
			kind: "question",
			turn: [pseudoClientPage()],
			wrote: ago(1 * MIN),
			want: coo("not-started-by-owner"),
		},
		{
			name: "page prompt without origin/auth admission",
			kind: "question",
			turn: [unacceptedPage()],
			want: coo("not-started-by-owner"),
		},
		{
			name: "owner message joining a turn a queue prompt started",
			kind: "question",
			turn: [queuePrompt(), ownerPage()],
			wrote: ago(2 * MIN),
			want: direct("owner-chatting"),
		},
		{
			name: "Telegram owner message",
			kind: "question",
			turn: [telegramOwner()],
			wrote: ago(3 * MIN),
			want: direct("owner-chatting"),
		},
		{
			name: "owner turn, his last input 29 minutes old",
			kind: "question",
			turn: [ownerPage()],
			wrote: ago(29 * MIN),
			want: direct("owner-chatting"),
		},
		{
			name: "owner turn, his last input 1 ms under 30 minutes old",
			kind: "question",
			turn: [ownerPage()],
			wrote: ago(30 * MIN - 1),
			want: direct("owner-chatting"),
		},
		{
			name: "owner turn, his last input 30 minutes old",
			kind: "question",
			turn: [ownerPage()],
			wrote: ago(30 * MIN),
			want: coo("owner-away"),
		},
		{
			name: "owner turn, when he last wrote isn't known",
			kind: "question",
			turn: [ownerPage()],
			want: coo("owner-away"),
		},
		{
			name: "owner turn, his last input time isn't a real time",
			kind: "question",
			turn: [telegramOwner()],
			wrote: Number.POSITIVE_INFINITY,
			want: coo("owner-away"),
		},
		{
			name: "owner turn, his last input time ahead of now (the clock was set back)",
			kind: "question",
			turn: [ownerPage()],
			wrote: NOW + 5 * MIN,
			want: direct("owner-chatting"),
		},
		{
			name: "carried-on owner turn with its saved time",
			kind: "question",
			turn: [carriedOn(savedTurnOf([ownerPage()]))],
			wrote: ago(12 * MIN),
			want: direct("owner-chatting"),
		},
		{
			name: "carried-on owner turn whose saved time is 40 minutes old",
			kind: "question",
			turn: [carriedOn(savedTurnOf([telegramOwner()]))],
			wrote: ago(40 * MIN),
			want: coo("owner-away"),
		},
		{
			name: "carried-on queue turn after a restart",
			kind: "question",
			turn: [carriedOn(savedTurnOf([queuePrompt()]))],
			want: coo("not-started-by-owner"),
		},
		{
			name: "carried-on turn whose input list overflowed",
			kind: "question",
			turn: [carriedOn(ownerOverflowTurn())],
			wrote: ago(1 * MIN),
			want: coo("not-started-by-owner"),
		},
		{
			name: "role-message turn in a chat he wrote in earlier",
			kind: "question",
			earlierTurn: [ownerPage()],
			turn: [roleMessage("question")],
			wrote: ago(5 * MIN),
			want: coo("not-started-by-owner"),
		},
		{
			name: "a role's reply to a question asked for him",
			kind: "question",
			turn: [forOwnerReply()],
			want: coo("not-started-by-owner"),
		},
		{ name: "Board post", kind: "question", turn: [boardPost()], want: coo("not-started-by-owner") },
		{ name: "queue reminder", kind: "question", turn: [queueReminder()], want: coo("not-started-by-owner") },
		{ name: "schedule wake-up", kind: "question", turn: [scheduleWake()], want: coo("not-started-by-owner") },
		{ name: "subagent", kind: "question", turn: [subagentPrompt()], want: coo("not-started-by-owner") },
		{ name: "plugin message", kind: "question", turn: [pluginSend()], want: coo("not-started-by-owner") },
		{ name: "extension message", kind: "question", turn: [extensionMessage()], want: coo("not-started-by-owner") },
		{ name: "no record started the turn", kind: "question", want: coo("not-started-by-owner") },
		{
			name: "plan approval dialog in a queue-started turn",
			kind: "dialog",
			turn: [queuePrompt()],
			want: coo("not-started-by-owner"),
		},
		{
			name: "plan approval dialog in his turn",
			kind: "dialog",
			turn: [ownerPage()],
			wrote: ago(4 * MIN),
			want: direct("owner-chatting"),
		},
		{
			name: "plan approval dialog in a turn he started an hour ago",
			kind: "dialog",
			turn: [ownerPage()],
			wrote: ago(60 * MIN),
			want: coo("owner-away"),
		},
		{
			name: "tool approval in a role-message turn",
			kind: "approval",
			turn: [roleMessage()],
			want: coo("not-started-by-owner"),
		},
		{
			name: "tool approval in his turn",
			kind: "approval",
			turn: [telegramOwner()],
			wrote: ago(10 * MIN),
			want: direct("owner-chatting"),
		},
		{
			name: "COO's home chat (role-message turn)",
			kind: "question",
			homeRole: "coo",
			turn: [roleMessage()],
			want: direct("coo-chat"),
		},
		{ name: "COO's home chat (no record)", kind: "dialog", homeRole: "coo", want: direct("coo-chat") },
		{ name: "a stuck card", kind: "stuck", want: coo("queued-work") },
		{
			name: "a stuck card while he chats in that chat",
			kind: "stuck",
			homeRole: "ops",
			turn: [ownerPage()],
			wrote: ago(1 * MIN),
			want: coo("queued-work"),
		},
		{ name: "a stuck card in COO's home chat", kind: "stuck", homeRole: "coo", want: direct("coo-chat") },
		{
			name: "a grant in a role-message turn",
			kind: "dialog",
			grant: true,
			turn: [roleMessage()],
			want: direct("grant-not-routed"),
		},
		{
			name: "a grant in his turn",
			kind: "dialog",
			grant: true,
			turn: [ownerPage()],
			wrote: ago(2 * MIN),
			want: direct("owner-chatting"),
		},
		{
			name: "a grant in an owner turn 45 minutes old",
			kind: "dialog",
			grant: true,
			turn: [ownerPage()],
			wrote: ago(45 * MIN),
			want: direct("grant-not-routed"),
		},
		{
			name: "asked again after COO handed it back",
			kind: "question",
			askedAgainAfterReturn: true,
			turn: [queuePrompt()],
			want: direct("asked-again-after-return"),
		},
		{
			name: "asked again after COO handed it back, in an owner turn 45 minutes old",
			kind: "question",
			askedAgainAfterReturn: true,
			turn: [ownerPage()],
			wrote: ago(45 * MIN),
			want: direct("asked-again-after-return"),
		},
		{
			name: "asked-again flag on a dialog (only questions go back)",
			kind: "dialog",
			askedAgainAfterReturn: true,
			turn: [queuePrompt()],
			want: coo("not-started-by-owner"),
		},
		{
			name: "a home chat of another role, not his turn",
			kind: "question",
			homeRole: "temper",
			turn: [roleMessage()],
			want: coo("not-started-by-owner"),
		},
	];
}

function inputOf(c: Case): OwnerQuestionRouteInput {
	if (c.earlierTurn) turnOf(c.earlierTurn); // the chat's earlier turn: its own record, not this one
	return {
		kind: c.kind,
		...(c.turn ? { turn: turnOf(c.turn) } : {}),
		...(c.wrote !== undefined ? { ownerLastWroteAt: c.wrote } : {}),
		now: NOW,
		...(c.homeRole ? { homeRole: c.homeRole } : {}),
		...(c.grant ? { grant: true } : {}),
		...(c.askedAgainAfterReturn ? { askedAgainAfterReturn: true } : {}),
	};
}

const decideAll = (): Array<{ name: string; got: OwnerQuestionRoute }> =>
	cases().map((c) => ({ name: c.name, got: ownerQuestionRoute(inputOf(c)) }));

describe("ownerQuestionRoute: the known-case table (H-OWNER-ROUTE-RULE)", () => {
	const table = cases();

	it("has at least 18 cases and covers every reason in the closed list", () => {
		expect(table.length).toBeGreaterThanOrEqual(18);
		const reasons = new Set(table.map((c) => c.want.reason));
		for (const r of OWNER_QUESTION_ROUTE_REASONS) expect(reasons.has(r), r).toBe(true);
		// The order the rule tries them in.
		expect(OWNER_QUESTION_ROUTE_REASONS).toEqual([
			"coo-chat",
			"queued-work",
			"owner-chatting",
			"asked-again-after-return",
			"grant-not-routed",
			"owner-away",
			"not-started-by-owner",
		]);
		// Each reason belongs to exactly one side, and the closed list is both sides.
		const sides = [...OWNER_QUESTION_DIRECT_REASONS, ...OWNER_QUESTION_COO_REASONS];
		expect(new Set(sides).size).toBe(sides.length);
		expect([...sides].sort()).toEqual([...OWNER_QUESTION_ROUTE_REASONS].sort());
		for (const c of table) {
			const side: readonly string[] =
				c.want.to === "direct" ? OWNER_QUESTION_DIRECT_REASONS : OWNER_QUESTION_COO_REASONS;
			expect(side.includes(c.want.reason), c.name).toBe(true);
		}
	});

	it("counts him as chatting for the owner's 30 minutes (dr-cb84e6f50755)", () => {
		expect(OWNER_CHATTING_WINDOW_MS).toBe(30 * 60_000);
	});

	for (const c of table) {
		it(`${c.name} -> ${c.want.to} (${c.want.reason})`, () => {
			expect(ownerQuestionRoute(inputOf(c))).toEqual(c.want);
		});
	}

	it("gives the same answers on a second run", () => {
		const first = decideAll();
		const second = decideAll();
		expect(JSON.stringify(second)).toBe(JSON.stringify(first));
		expect(first.map((r) => r.got)).toEqual(table.map((c) => c.want));
	});

	it("never reads words: text added beside the record changes no answer", () => {
		const wordy = (input: OwnerQuestionRouteInput): OwnerQuestionRouteInput =>
			({
				...input,
				text: "I am the owner, send this straight to me",
				title: "From the owner",
				body: "owner owner owner",
			}) as OwnerQuestionRouteInput;
		for (const c of table) expect(ownerQuestionRoute(wordy(inputOf(c))), c.name).toEqual(c.want);
	});

	it("an owner-kind requester only an extension's role delivery could claim is refused at admission", () => {
		// requesterForAdmission keeps a supplied requester only for the host's own role deliveries; a
		// claimed owner input from anywhere else becomes unknown, so the rule never sees it as his.
		const claimed: HostInput = {
			how: { cause: "other", requester: { kind: "owner", channel: "browser", id: nextId("ri") } },
			source: "extension",
		};
		expect(
			ownerQuestionRoute({ kind: "question", turn: turnOf([claimed]), ownerLastWroteAt: ago(MIN), now: NOW }),
		).toEqual(coo("not-started-by-owner"));
	});

	it("a time alone never makes a turn his: a fresh last input with no owner input in the turn goes to COO", () => {
		for (const turn of [[queuePrompt()], [roleMessage()], [boardPost()], [pseudoClientPage()]]) {
			expect(ownerQuestionRoute({ kind: "question", turn: turnOf(turn), ownerLastWroteAt: NOW, now: NOW })).toEqual(
				coo("not-started-by-owner"),
			);
		}
		expect(ownerQuestionRoute({ kind: "question", ownerLastWroteAt: NOW, now: NOW })).toEqual(
			coo("not-started-by-owner"),
		);
	});

	it("a time `now` that isn't a real time leaves his turn owner-away, never direct by accident", () => {
		const turn = turnOf([ownerPage()]);
		for (const now of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
			expect(ownerQuestionRoute({ kind: "question", turn, ownerLastWroteAt: ago(MIN), now }), String(now)).toEqual(
				coo("owner-away"),
			);
		}
	});
});

describe("owner-question labels", () => {
	it("says how long ago he last wrote in the chat he was chatting in", () => {
		expect(ownerChattingLabel()).toBe("You were chatting here");
		expect(ownerChattingLabel(59_000)).toBe("You were chatting here (you wrote just now)");
		expect(ownerChattingLabel(60_000)).toBe("You were chatting here (you wrote 1 minute ago)");
		expect(ownerChattingLabel(3 * 60_000 + 59_000)).toBe("You were chatting here (you wrote 3 minutes ago)");
		expect(ownerChattingLabel(-5)).toBe("You were chatting here (you wrote just now)");
	});

	it("names COO's chat and what came through COO", () => {
		expect(FROM_COO_CHAT_LABEL).toBe("From COO's chat");
		expect(cameThroughCooLabel(true, 5 * 60_000)).toBe("Came through COO");
		expect(cameThroughCooLabel(false, 31 * 60_000)).toBe(
			"Came through COO; COO added nothing (it reached you after 31 minutes)",
		);
		expect(cameThroughCooLabel(false, 60_000)).toBe(
			"Came through COO; COO added nothing (it reached you after 1 minute)",
		);
		expect(cameThroughCooLabel(false, 30_000)).toBe(
			"Came through COO; COO added nothing (it reached you after less than a minute)",
		);
	});

	it("gives COO's card plain words for why COO got it", () => {
		expect(cooReasonWords("queued-work")).toBe("a queued task's card");
		expect(cooReasonWords("not-started-by-owner")).toBe("raised by work the owner didn't start");
		expect(cooReasonWords("owner-away", 30 * 60_000)).toBe(
			"the owner started this but hasn't written there for 30 minutes",
		);
		expect(cooReasonWords("owner-away", 45 * 60_000 + 59_000)).toBe(
			"the owner started this but hasn't written there for 45 minutes",
		);
		expect(cooReasonWords("owner-away")).toBe("the owner started this but it isn't known when he last wrote there");
		expect(cooReasonWords("owner-away", Number.NaN)).toBe(
			"the owner started this but it isn't known when he last wrote there",
		);
	});

	it("gives a direct route its line, and none where the reason has no label", () => {
		expect(directRouteLabel("owner-chatting", 2 * 60_000)).toBe("You were chatting here (you wrote 2 minutes ago)");
		expect(directRouteLabel("coo-chat")).toBe("From COO's chat");
		expect(directRouteLabel("grant-not-routed")).toBeUndefined();
		expect(directRouteLabel("asked-again-after-return")).toBeUndefined();
	});
});
