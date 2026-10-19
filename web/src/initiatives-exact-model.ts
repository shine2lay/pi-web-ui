// initiatives-exact: the typed input of the supplied Initiatives design (docs/initiatives-exact.md).
// Every field is optional: an absent one shows the design's own empty or "Not recorded" wording, never a
// guess. Pure types, no data: the design's sample initiatives live only in the tests' fixture.

/** The page as a whole. "live" with no initiatives is the design's empty state. */
export type InitiativesExactPageState = "live" | "loading" | "error" | "stale" | "no-access";
export interface InitiativesExactPage {
	state?: InitiativesExactPageState;
	/** When the data was last loaded (live, out of date) or the load failed (error), as shown: "09:30". */
	at?: string;
	/** The date beside the count: "Mon Jan 5". */
	date?: string;
}

export type InitiativesExactStatus = "moving" | "attention" | "paused" | "unknown";
/** The design's state chip kinds ("Working now", "Waiting", … "Done"). */
export type InitiativesExactRoleKind =
	"working" | "waiting" | "blocked" | "onhold" | "queued" | "paused" | "idle" | "error" | "unknown" | "done";
/** "unproven": reported done with no receipt (the design's missing-evidence state). */
export type InitiativesExactStepKind = "done" | "active" | "wait" | "failed" | "paused" | "pending" | "unproven";
export type InitiativesExactHandoffKind = "wait" | "done" | "active" | "unknown" | "paused";
/** Who made a decision: you, the initiative's lead, or another role. */
export type InitiativesExactDecider = "you" | "lead" | "role";
export type InitiativesExactTab = "overview" | "design" | "decisions" | "activity";

/** One "Who's doing what" row. `tasks` are its child task rows: the same row, indented 16 px. */
export interface InitiativesExactRole {
	name?: string;
	lead?: boolean;
	/** The role's part in the initiative. */
	part?: string;
	/** Its current task's number ("#12") and title. */
	task?: string;
	taskTitle?: string;
	note?: string;
	kind?: InitiativesExactRoleKind;
	/** The kind is the last one known, not confirmed now (old data). */
	lastKnown?: boolean;
	/** What it waits on ("Design #3") and what its work unblocks ("QA #4"). */
	wait?: string;
	unblocks?: string;
	/** When it last changed: "12:41". */
	at?: string;
	/** Child task rows; their name defaults to this row's. */
	tasks?: readonly InitiativesExactRole[];
	/** initiatives-page: a plain status chip with this text (a project's registry status) instead of the
	 *  role state chip; `statusTone` "done" draws it in the state chip's Done colours, else a neutral grey. */
	statusLabel?: string;
	statusTone?: "done" | "neutral";
}

export interface InitiativesExactStep {
	label?: string;
	kind?: InitiativesExactStepKind;
	/** Its time or note: "12:20 · QA", "in progress". */
	at?: string;
}
/** An outcome (done-when item) and its steps. */
export interface InitiativesExactOutcome {
	title?: string;
	/** Who owns it, as written: "Ops #12", "Design #3 → QA #4". Roles named here are its roles. */
	owner?: string;
	steps?: readonly InitiativesExactStep[];
}

export interface InitiativesExactHandoff {
	from?: string;
	fromTask?: string;
	to?: string;
	toTask?: string;
	what?: string;
	/** Where it stands, as written: "Delivered 12:20". */
	state?: string;
	kind?: InitiativesExactHandoffKind;
}

/** Something waiting on you. With `answer`, it was answered: "Sent …: “answer”. Not read yet." */
export interface InitiativesExactAsk {
	id: string;
	/** "Approval", "Confirmation". */
	kind?: string;
	from?: string;
	age?: string;
	title?: string;
	context?: string;
	choices?: readonly string[];
	answer?: string;
}

export interface InitiativesExactDesignChange {
	kind?: "changed" | "added" | "removed";
	text?: string;
	before?: string;
	after?: string;
	why?: string;
}
export interface InitiativesExactDesignSection {
	heading?: string;
	body?: string;
	/** Marked until you mark the design as read (`seen`). */
	mark?: "new" | "changed";
}
/** The lead's current design of the initiative. Absent: "No current design written yet." */
export interface InitiativesExactDesign {
	version?: string;
	by?: string;
	updatedAt?: string;
	/** Which version you last read, as shown: "Oct 9 09:40 (v2)". */
	lastSeen?: string;
	/** You have read this version: its changes and marks are not shown. */
	seen?: boolean;
	changes?: readonly InitiativesExactDesignChange[];
	sections?: readonly InitiativesExactDesignSection[];
}

export interface InitiativesExactDecision {
	title?: string;
	body?: string;
	at?: string;
	who?: string;
	/** How it was approved: "approved in a dialog". */
	how?: string;
	verdict?: string;
	by?: InitiativesExactDecider;
	impact?: string;
	options?: string;
	until?: string;
	source?: string;
	/** Opaque to the view: handed back in onOpen when the source is clicked. */
	sourceRef?: string;
	quote?: string;
	filed?: string;
}

export interface InitiativesExactActivity {
	at?: string;
	role?: string;
	text?: string;
}
export interface InitiativesExactSpend {
	role?: string;
	/** "$58.30", or absent: "Not reported". */
	value?: string;
}

export interface InitiativesExactInitiative {
	id: string;
	name?: string;
	status?: InitiativesExactStatus;
	statusNote?: string;
	/** The lead role's name. */
	lead?: string;
	goal?: string;
	started?: string;
	/** Absent: "Not set by the lead". */
	finish?: string;
	/** Shown when the status is paused. */
	pausedText?: string;
	/** Old data: last confirmed then ("Mon 08:15"); its status reads Unknown and its rows "Last known". */
	oldSince?: string;
	roles?: readonly InitiativesExactRole[];
	outcomes?: readonly InitiativesExactOutcome[];
	handoffs?: readonly InitiativesExactHandoff[];
	gaps?: readonly string[];
	onYou?: readonly InitiativesExactAsk[];
	design?: InitiativesExactDesign;
	/** When asking the lead to write the design last failed ("09:30"): the design's button-failed line. */
	askFailedAt?: string;
	leadNext?: string;
	leadReport?: string;
	leadReportAt?: string;
	spend?: readonly InitiativesExactSpend[];
	spendTotal?: string;
	spendNote?: string;
	decisions?: readonly InitiativesExactDecision[];
	/** All decisions, when more exist than are listed. */
	decisionsTotal?: number;
	decisionsNote?: string;
	activity?: readonly InitiativesExactActivity[];
	// initiatives-page (docs/initiatives-page-exact.md): what the live page knows before every section is
	// connected. Each is optional; absent keeps the behaviour above.
	/** With no `status`: the chip shows this text in a neutral grey (the registry's status). */
	statusLabel?: string;
	/** With no `outcomes`: how many done-when items there are and how many are met ("x of y"). */
	outcomeCount?: { done: number; total: number };
	/** A line in Outcomes and Done when instead of their list ("Not connected yet"). */
	outcomesNote?: string;
	/** A line in Who's doing what ("No projects in this initiative yet."). */
	rowsNote?: string;
	/** Latest updates in place of the newest three activity lines; `latestNote` when there are none. */
	latest?: readonly InitiativesExactActivity[];
	latestNote?: string;
	/** A line in Hand-offs, Gaps or Activity instead of their list; their counts read "\u2014". */
	handoffsNote?: string;
	gapsNote?: string;
	activityNote?: string;
	/** The Roles line and the card's role marks, in place of what `roles` gives. */
	rolesLine?: string;
	members?: readonly string[];
	/** Shown when `lead` is absent ("No one"); its mark stays "\u2014". */
	leadName?: string;
	/** False hides that lead button for this initiative even when its handler is given. */
	canMessageLead?: boolean;
	canChangeLead?: boolean;
}

/** One item of the "in no initiative" box (the wiring task: projects in no initiative). */
export interface InitiativesExactLooseItem {
	id: string;
	name?: string;
	/** The two-letter mark; absent: the name's first two letters. */
	mono?: string;
	note?: string;
	/** It asks you something: ON YOU, and its choices while unanswered. */
	onYou?: boolean;
	choices?: readonly string[];
	answer?: string;
}
export interface InitiativesExactLoose {
	/** Absent: the design's "Roles in no initiative · N". */
	heading?: string;
	items?: readonly InitiativesExactLooseItem[];
	/** initiatives-page: the box opens like an initiative, with this as its detail. Its id must not be an
	 *  initiative's. */
	detail?: InitiativesExactInitiative;
}

export interface InitiativesExactInput {
	page?: InitiativesExactPage;
	initiatives?: readonly InitiativesExactInitiative[];
	loose?: InitiativesExactLoose;
	/** A sentence after the count of things waiting on you, in the page's summary line. */
	summaryNote?: string;
	/** initiatives-page: the whole summary line while the page is live, out of date or empty, in place of
	 *  the count ("Not connected yet: \u2026"), so it never says nothing is waiting when that isn't known. */
	summary?: string;
	/** initiatives-page: Needs you, Needs attention and Paused by you aren't known: their counts read
	 *  "\u2014", and picking one shows this line instead of a list. */
	filtersNote?: string;
	/** Selected and tab first shown; the owner's own clicks win after that. */
	selected?: string;
	tab?: InitiativesExactTab;
}

/** What the view hands back when something is opened. */
export type InitiativesExactTarget = { kind: "source"; initiative: string; ref: string };
/** Which ask an answer is for: one in an initiative, or a loose item's. */
export type InitiativesExactAnswerTarget = { initiative: string; ask: string } | { loose: string };
