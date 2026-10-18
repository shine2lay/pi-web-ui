// initiatives-exact: TEST-ONLY fixture. The supplied design's own 4 sample initiatives (its data()), converted
// into InitiativesExactInput, so tests and the sealed screenshot show the design as drawn. Never imported by
// shipped code (a unit test checks the shipped files hold none of it).
import type { InitiativesExactInitiative, InitiativesExactInput } from "../../web/src/initiatives-exact-model";

type Step = [string, "done" | "active" | "wait" | "failed" | "paused" | "pending" | "unproven", string?];
const steps = (list: Step[]) =>
	list.map(([label, kind, at]) => (at === undefined ? { label, kind } : { label, kind, at }));

const reliability: InitiativesExactInitiative = {
	id: "reliability",
	name: "Reliability",
	status: "moving",
	statusNote: "2 roles working · 1 on hold",
	lead: "COO",
	goal: "Answers you send and receive always reach your chat, and the live system checks its own health.",
	started: "Wed Oct 7",
	roles: [
		{
			name: "COO",
			lead: true,
			part: "Plans the work, hands tasks to roles, reports to you",
			task: "#112",
			taskTitle: "Health check handed to Ops",
			note: "Not started. Ops is busy with #98.",
			kind: "queued",
			wait: "a free Ops slot",
			at: "12:46",
		},
		{
			name: "Ops",
			part: "Installs fixes on the live server and runs the health check",
			task: "#98",
			taskTitle: "Install the answer-visibility fix",
			note: "Dry-run install passed on a staging copy",
			kind: "working",
			at: "12:41",
		},
		{
			name: "Frontend",
			part: "Writes the UI repair plans",
			task: "#1",
			taskTitle: "Write repair plans",
			note: "First of 2 plans drafted",
			kind: "working",
			unblocks: "Architecture #62",
			at: "13:05",
		},
		{
			name: "Architecture",
			part: "Reviews and signs off repair plans",
			task: "#62",
			taskTitle: "Review the repair plans",
			note: "Review checklist prepared",
			kind: "onhold",
			wait: "Frontend #1",
			at: "Sat 17:20",
		},
		{
			name: "QA",
			part: "Checks every fix independently before it ships",
			task: "#77",
			taskTitle: "Independent check of Ops #98",
			note: "Passed at 12:20",
			kind: "done",
			at: "12:20",
		},
	],
	outcomes: [
		{
			title: "Answer-visibility fix is live and works for you",
			owner: "Ops #98",
			steps: steps([
				["Built", "done", "12:02"],
				["Checked", "done", "12:20 · QA"],
				["Installed", "active", "in progress"],
				["Live", "pending"],
				["Confirmed by you", "pending"],
			]),
		},
		{
			title: "Health check runs on the live server",
			owner: "Ops #112 · after #98",
			steps: steps([
				["Approved by you", "done", "12:46"],
				["Handed to Ops", "done", "12:46"],
				["Installed", "pending"],
				["Running", "pending"],
			]),
		},
		{
			title: "Repair plans reviewed and signed off",
			owner: "Frontend #1 → Architecture #62",
			steps: steps([
				["Drafted", "active", "1 of 2"],
				["Sent to Architecture", "pending"],
				["Reviewed", "pending"],
				["Signed off", "pending"],
			]),
		},
		{
			title: "Answer-visibility fix independently checked",
			owner: "QA #77",
			steps: steps([
				["Requested", "done", "12:05"],
				["Passed", "done", "12:20"],
			]),
		},
		{
			title: "Report fix confirmed",
			owner: "QA #74",
			steps: steps([
				["Built", "done", "Wed 17:02"],
				["Checked", "done", "Wed 19:40"],
				["Live", "done", "Wed 20:15"],
				["Confirmed by you", "wait", "waiting on you"],
			]),
		},
	],
	handoffs: [
		{
			from: "Frontend",
			fromTask: "#1",
			to: "Architecture",
			toTask: "#62",
			what: "Repair plans",
			state: "In progress · Architecture on hold until they arrive",
			kind: "wait",
		},
		{
			from: "Ops",
			fromTask: "#98",
			to: "Ops",
			toTask: "#112",
			what: "Frees the task slot",
			state: "#112 is first in Ops’ ready list",
			kind: "wait",
		},
		{
			from: "QA",
			fromTask: "#77",
			to: "Ops",
			toTask: "#98",
			what: "Independent check",
			state: "Delivered 12:20",
			kind: "done",
		},
	],
	gaps: [
		"Architecture: request R-14 is unfinished and no next task is recorded.",
		"No finish date. The lead hasn’t promised one.",
		"Architecture’s spend isn’t reported.",
	],
	onYou: [
		{
			id: "i2",
			kind: "Approval",
			from: "Frontend",
			age: "18 h",
			title: "Add 2 extra working sessions per day?",
			context:
				"Would speed up the repair plans Architecture is waiting on. Cost estimate: not reported. Frontend’s own work stays paused either way.",
			choices: ["Approve", "Decline"],
		},
		{
			id: "i3",
			kind: "Confirmation",
			from: "QA",
			age: "3 d 16 h",
			title: "Does the report fix work for you?",
			context: "Built, independently checked and live since Wed 20:15. Only your confirmation is missing.",
			choices: ["Yes, it works", "Something’s wrong"],
		},
	],
	design: {
		version: "v2",
		by: "COO (lead)",
		updatedAt: "Oct 8 10:15",
		lastSeen: "Oct 9 09:40 (v2)",
		changes: [],
		sections: [
			{
				heading: "What it is",
				body: "Make sure every answer a role writes actually reaches your chat, and that the live system checks its own health every hour.",
			},
			{
				heading: "How a fix goes live",
				body: "A role builds the fix, QA checks it independently, Ops installs it, and then you confirm it works. Nothing skips the QA check.",
			},
			{ heading: "Not decided yet", body: "When the initiative is finished: no date has been promised." },
		],
	},
	leadNext: "Confirm the health check runs on the live server once Ops installs it",
	leadReport: "3 dependencies open across roles; health check was awaiting your approval.",
	leadReportAt: "06:00",
	spend: [
		{ role: "COO", value: "$58.30" },
		{ role: "Ops", value: "$41.20" },
		{ role: "Frontend", value: "$22.00" },
		{ role: "QA", value: "$3.40" },
		{ role: "Architecture" },
	],
	spendTotal: "$124.90",
	spendNote: "· 1 role not reported",
	decisions: [
		{
			title: "Roll out the health check",
			body: "Ops installs an hourly health check on the live server once #98 is done.",
			at: "Oct 11 12:46",
			who: "You",
			how: "approved in a dialog",
			verdict: "You approved",
			by: "you",
			impact: "One more task in Ops’ queue. It starts after #98.",
			source: "COO task chat #112",
		},
		{
			title: "Nothing goes live without an independent check",
			body: "Every fix in this initiative is checked by QA before Ops installs it.",
			at: "Oct 8 10:15",
			who: "COO",
			how: "lead’s call, within its remit",
			verdict: "Lead decided",
			by: "lead",
			impact: "Adds a QA step before each install; nothing reaches you unchecked.",
			options: "Skip checks for small fixes: faster, but not chosen",
			until: "End of the initiative",
			source: "COO home chat",
		},
		{
			title: "Repair plans before repairs",
			body: "Frontend writes the repair plans first; Architecture reviews them before any repair starts.",
			at: "Oct 10 17:10",
			who: "Architecture",
			how: "asked Frontend in request R-14",
			verdict: "Role decided · lead not asked",
			by: "role",
			impact: "Repairs wait until both plans are reviewed.",
			source: "Architecture request R-14",
		},
	],
	activity: [
		{ at: "13:05", role: "Frontend", text: "#1 first repair plan drafted" },
		{ at: "12:46", role: "COO", text: "Handed the approved health check to Ops (#112). Not started." },
		{ at: "12:46", role: "You", text: "Approved the health check" },
		{ at: "12:41", role: "Ops", text: "#98 dry-run install passed on a staging copy" },
		{ at: "12:20", role: "QA", text: "Independent check of Ops #98 passed" },
		{ at: "12:02", role: "Ops", text: "#98 fix built" },
		{ at: "Sat 18:40", role: "Frontend", text: "Proposed 2 extra working sessions per day" },
		{ at: "Sat 17:20", role: "Architecture", text: "#62 review checklist prepared; put on hold" },
	],
};

const notebook: InitiativesExactInitiative = {
	id: "notebook",
	name: "Notebook import",
	status: "moving",
	statusNote: "1 blocked · Design is unblocking it",
	lead: "Data",
	goal: "Proposed notebooks show up in the design page, in a format Design has accepted.",
	started: "Thu Oct 8",
	roles: [
		{
			name: "Data",
			lead: true,
			part: "Owns the import and reports to you",
			task: "#8",
			taskTitle: "Import the proposed notebook",
			note: "Import script ready; dry run passed 11:58",
			kind: "blocked",
			wait: "Design #41 acceptance receipt",
			at: "12:22",
		},
		{
			name: "Design",
			part: "Accepts the notebook format the import relies on",
			task: "#41",
			taskTitle: "Accept the notebook import format",
			note: "Checking the format against Data’s import script",
			kind: "working",
			unblocks: "Data #8",
			at: "12:38",
		},
	],
	outcomes: [
		{
			title: "Notebook format accepted",
			owner: "Design #41",
			steps: steps([
				["Reviewed", "done", "Fri 15:40"],
				["Checked against script", "active", "in progress"],
				["Receipt issued", "pending"],
			]),
		},
		{
			title: "Proposed notebook imported",
			owner: "Data #8",
			steps: steps([
				["Script written", "done"],
				["Dry run", "done", "11:58"],
				["Imported", "wait", "after #41"],
				["Visible in design page", "pending"],
			]),
		},
		{
			title: "Notebook cards laid out",
			owner: "Design #44",
			steps: steps([
				["Designed", "paused", "held by your pause"],
				["Built", "pending"],
			]),
		},
	],
	handoffs: [
		{
			from: "Design",
			fromTask: "#41",
			to: "Data",
			toTask: "#8",
			what: "Acceptance receipt",
			state: "Design is working on it now",
			kind: "active",
		},
	],
	gaps: [
		"#44 card layout is held by your pause on Design’s own work. Requested work like #41 still runs.",
		"No finish date. The lead hasn’t promised one.",
	],
	onYou: [],
	leadNext: "Run the import once Design’s acceptance receipt exists",
	leadReport: "#8 still waiting on Design acceptance. No other work queued.",
	leadReportAt: "06:00",
	spend: [
		{ role: "Data", value: "$64.80" },
		{ role: "Design", value: "$97.40" },
	],
	spendTotal: "$162.20",
	spendNote: "",
	decisions: [
		{
			title: "Import only accepted formats",
			body: "Data runs an import only after Design issues an acceptance receipt from the current session.",
			at: "Oct 8 09:30",
			who: "Data",
			how: "lead’s call, within its remit",
			verdict: "Lead decided",
			by: "lead",
			impact: "Imports wait on Design, but nothing half-formatted lands in your design page.",
			source: "Data home chat",
		},
		{
			title: "Pause Design’s own initiatives",
			body: "Design’s own work is paused for the token limit; requested work still runs.",
			at: "Oct 9 16:02",
			who: "You",
			how: "set on the Roles page",
			verdict: "You decided",
			by: "you",
			impact: "#44 card layout waits. #41 continues because Data requested it.",
			until: "Until you resume it",
			source: "Roles page · pause log",
		},
	],
	activity: [
		{ at: "12:38", role: "Design", text: "Started #41, requested by Data" },
		{ at: "12:22", role: "Data", text: "Replied to your question about #8" },
		{ at: "11:58", role: "Data", text: "#8 import dry run passed" },
		{ at: "Fri 16:02", role: "You", text: "Paused Design’s own initiatives (token limit)" },
		{ at: "Fri 15:40", role: "Design", text: "#40 proposed notebook reviewed" },
	],
};

const team: InitiativesExactInitiative = {
	id: "team",
	name: "Team in Temper",
	status: "attention",
	statusNote: "220 decisions · 14 changes · 12 with a credit flag",
	lead: "Temper",
	goal: "Build the team into Temper as real code: L2 from Architecture’s queue, the other pieces from the Temper chat.",
	started: "[start date]",
	roles: [
		{
			name: "Temper",
			lead: true,
			part: "Temper chat builds the other pieces of the team",
			task: "",
			taskTitle: "The other pieces (everything except L2)",
			note: "Build progress not reported",
			kind: "unknown",
			at: "Sat 23:03",
		},
		{
			name: "Architecture",
			part: "Builds L2 as real code in Temper, from its own queue",
			task: "L2",
			taskTitle: "L2 built in the architecture queue",
			note: "Your pick Oct 3 19:26: “Keep L2 in my queue”",
			kind: "unknown",
			at: "Sat 23:03",
		},
	],
	outcomes: [
		{
			title: "Where L2 gets built is decided",
			owner: "You · dialog",
			steps: steps([
				["Options raised", "done", "Oct 3"],
				["You picked", "done", "Oct 3 19:26"],
			]),
		},
		{
			title: "L2 built as real code in Temper",
			owner: "Architecture queue",
			steps: steps([
				["Decided", "done", "Oct 3 19:26"],
				["Built", "pending", "not reported"],
				["Live in Temper", "pending"],
			]),
		},
		{
			title: "Other pieces built in Temper",
			owner: "Temper chat",
			steps: steps([
				["Decided", "done", "Oct 3 19:26"],
				["Built", "pending", "not reported"],
				["Live in Temper", "pending"],
			]),
		},
		{
			title: "Credit-flagged decisions reviewed",
			owner: "Temper (lead)",
			steps: steps([
				["Flagged", "wait", "12 decisions"],
				["Reviewed", "pending"],
			]),
		},
		{
			title: "Decision record kept current",
			owner: "Reader",
			steps: steps([
				["Last read", "done", "Sat 23:03"],
				["Reader on", "paused", "switched off"],
			]),
		},
	],
	handoffs: [
		{
			from: "Architecture",
			fromTask: "L2",
			to: "Temper",
			toTask: "code",
			what: "L2 lands in Temper’s code",
			state: "Two chats change Temper’s code",
			kind: "wait",
		},
	],
	gaps: [
		"12 decisions carry a credit flag and haven’t been reviewed.",
		"Two chats change Temper’s code; no one is recorded as owning merges between them.",
		"The reader is switched off, so records since Sat 23:03 aren’t read.",
		"No finish date. The lead hasn’t promised one.",
	],
	onYou: [],
	leadNext: "[not recorded]",
	spend: [{ role: "Temper" }, { role: "Architecture" }],
	spendNote: "",
	design: {
		version: "v4",
		by: "Temper (lead)",
		updatedAt: "Oct 3 19:26",
		lastSeen: "Oct 2 18:10 (v3)",
		changes: [
			{
				kind: "changed",
				text: "L2 is now built by Architecture, not the Temper chat.",
				before: "Temper chat builds every piece",
				after: "Architecture builds L2 from its own queue",
				why: "Your pick in a dialog, Oct 3 19:26: “Keep L2 in my queue”.",
			},
			{
				kind: "added",
				text: "Two chats now change Temper’s code, so their changes can collide.",
				why: "Follows from the L2 change. No one is recorded as owning merges yet.",
			},
			{
				kind: "added",
				text: "Engine fixes only go in for Pi workflows.",
				why: "Decision “Engine fixes only for Pi workflows” · [date]",
			},
		],
		sections: [
			{
				heading: "What it is",
				body: "The team is being built into Temper as real code, so it runs the same way every time instead of depending on chat instructions.",
			},
			{
				heading: "Who builds what",
				mark: "changed",
				body: "Architecture builds L2 as real code, working from its own queue. The Temper chat builds all the other pieces. Temper, as lead, fits the pieces together.",
			},
			{
				heading: "What you’ll notice",
				mark: "new",
				body: "Work started faster because L2 didn’t have to wait for the Temper chat. The trade-off: two chats now edit Temper’s code, so their changes can clash until someone owns merging them.",
			},
			{
				heading: "Limits",
				mark: "new",
				body: "Engine fixes are only made for Pi workflows. Other workflows keep the engine as it is.",
			},
			{
				heading: "Not decided yet",
				body: "Who merges changes between the two chats. When the team is finished: no date has been promised.",
			},
		],
	},
	decisionsTotal: 220,
	decisionsNote: "Showing 2 of 220 decisions · 14 changes · 232 without impact for you · 12 with a credit flag",
	decisions: [
		{
			title: "L2 built in architecture queue",
			body: "L2 is built as real code in Temper from the architecture queue, while the temper chat builds the other pieces.",
			at: "Oct 3 19:26",
			who: "You",
			how: "your pick in a dialog",
			verdict: "You decided: your pick",
			by: "you",
			impact: "Faster to start, but two chats change Temper’s code.",
			source: "Where L2 goes · Bug fixes · Oct 3 19:26",
			quote:
				"“Keep L2 in my queue” · “My queue builds L2 as real code in Temper; the temper chat builds the other pieces.”",
			filed: "Filed by a marker in its record · Added by the reader",
		},
		{
			title: "Engine fixes only for Pi workflows",
			body: "[decision text]",
			at: "[date]",
			who: "[who decided]",
			how: "[how approved]",
			verdict: "[outcome]",
			by: "lead",
			impact: "[impact for you]",
			source: "[source]",
			quote: "",
			filed: "",
		},
	],
	activity: [
		{ at: "Sat 23:03", role: "Reader", text: "Last read of the roles’ records; reader then switched off" },
		{ at: "Oct 3 19:26", role: "You", text: "Picked “Keep L2 in my queue” in a dialog" },
		{ at: "Oct 3 19:26", role: "Architecture", text: "L2 assigned to the architecture queue" },
	],
};

const budget: InitiativesExactInitiative = {
	id: "budget",
	name: "Budget & tokens",
	status: "paused",
	statusNote: "Both roles’ own work paused Fri 16:02",
	lead: "Product",
	goal: "Keep weekly token spend inside budget without slowing requested work.",
	started: "Tue Oct 6",
	pausedText:
		"You paused Product’s and Backend’s own work Fri 16:02 (token limit), so nothing here moves until you resume it. They still take requests from other roles.",
	roles: [
		{
			name: "Product",
			lead: true,
			part: "Orders the cost-saving work",
			task: "#51",
			taskTitle: "Reorder the backlog for Q4",
			note: "Draft order saved before the pause",
			kind: "paused",
			at: "Fri 14:10",
		},
		{
			name: "Backend",
			part: "Cuts token usage in services",
			task: "#1",
			taskTitle: "Token usage cleanup",
			note: "Usage report drafted before the pause",
			kind: "paused",
			at: "Fri 15:55",
		},
	],
	outcomes: [
		{
			title: "Q4 backlog ordered by cost",
			owner: "Product #51",
			steps: steps([
				["Draft order", "done", "Fri 14:10"],
				["Shared with you", "paused", "held by your pause"],
			]),
		},
		{
			title: "Token usage cut in services",
			owner: "Backend #1",
			steps: steps([
				["Usage report", "done", "Fri 15:55"],
				["Changes made", "paused", "held by your pause"],
				["Checked", "pending"],
			]),
		},
	],
	handoffs: [
		{
			from: "Backend",
			fromTask: "#1",
			to: "Product",
			toTask: "#51",
			what: "Usage figures to order the backlog",
			state: "Paused by you",
			kind: "paused",
		},
	],
	gaps: ["Product’s spend isn’t reported."],
	onYou: [],
	leadNext: "Share the draft order with you when own work resumes",
	leadReport: "Own initiatives paused. No requests received.",
	leadReportAt: "06:00",
	spend: [{ role: "Product" }, { role: "Backend", value: "$18.90" }],
	spendTotal: "$18.90",
	spendNote: "· 1 role not reported",
	decisions: [
		{
			title: "Pause own work at the token limit",
			body: "Product’s and Backend’s own initiatives are paused; requested work still runs.",
			at: "Oct 9 16:02",
			who: "You",
			how: "set on the Roles page",
			verdict: "You decided",
			by: "you",
			impact: "This initiative stops until you resume it.",
			until: "Until you resume it",
			source: "Roles page · pause log",
		},
	],
	activity: [
		{ at: "Fri 16:02", role: "You", text: "Paused Product’s and Backend’s own work (token limit)" },
		{ at: "Fri 15:55", role: "Backend", text: "Usage report drafted" },
		{ at: "Fri 14:10", role: "Product", text: "Draft Q4 order saved" },
	],
};

/** The design as first drawn: Team in Temper first and selected, Overview tab. */
export const DESIGN_FIXTURE: InitiativesExactInput = {
	page: { state: "live", at: "13:05", date: "Sun Oct 11" },
	initiatives: [team, reliability, notebook, budget],
	loose: {
		heading: "Roles in no initiative · 1",
		items: [
			{
				id: "marketing",
				name: "Marketing",
				note: "Asked you 4 d ago which initiative to join. Still handles requests meanwhile.",
				onYou: true,
				choices: ["Reliability", "Team setup", "Not now"],
			},
		],
	},
	summaryNote: "Team in Temper has 12 decisions with a credit flag; Budget & tokens is paused by you.",
	selected: "team",
};

/** The design's 8 drawn states, as input (its drawnState() switch, converted). */
export function drawnState(state: string): InitiativesExactInput {
	const base = DESIGN_FIXTURE;
	const map = (id: string, f: (i: InitiativesExactInitiative) => InitiativesExactInitiative) => ({
		...base,
		initiatives: (base.initiatives ?? []).map((i) => (i.id === id ? f(i) : i)),
	});
	switch (state) {
		case "empty":
			return { page: { state: "live", at: "13:05", date: "Sun Oct 11" }, initiatives: [] };
		case "loading":
			return { page: { state: "loading" } };
		case "server-error":
			return { page: { state: "error", at: "13:05" } };
		case "no-access":
			return { page: { state: "no-access" } };
		case "out-of-date":
			return { ...base, page: { state: "stale", at: "13:05", date: "Sun Oct 11" } };
		case "old-data":
			return {
				...map("team", (i) => ({
					...i,
					oldSince: "Sat 23:03",
					roles: (i.roles ?? []).map((r) => ({ ...r, kind: r.lead ? ("working" as const) : ("queued" as const) })),
				})),
				summaryNote:
					"Team in Temper had 12 decisions with a credit flag when last confirmed Sat 23:03; Budget & tokens is paused by you.",
			};
		case "missing-evidence":
			return {
				...map("notebook", (i) => ({
					...i,
					roles: (i.roles ?? []).map((r) =>
						r.name === "Data" ? { ...r, note: "Says the dry run passed at 11:58; no receipt found" } : r,
					),
					outcomes: (i.outcomes ?? []).map((oc) => ({
						...oc,
						steps: (oc.steps ?? []).map((s) =>
							s.label === "Dry run"
								? { label: "Dry run", kind: "unproven" as const, at: "reported 11:58 · no receipt" }
								: s,
						),
					})),
					gaps: ["Data says the dry run passed at 11:58, but no receipt backs it. It isn’t counted as done."].concat(
						i.gaps ?? [],
					),
					activity: (i.activity ?? []).map((a) =>
						/dry run passed/i.test(a.text ?? "") ? { ...a, text: "Said the dry run passed; no receipt attached" } : a,
					),
				})),
				selected: "notebook",
				tab: "overview",
			};
		case "button-failed":
			return { ...map("notebook", (i) => ({ ...i, askFailedAt: "13:05" })), selected: "notebook", tab: "design" };
		default:
			return base;
	}
}
