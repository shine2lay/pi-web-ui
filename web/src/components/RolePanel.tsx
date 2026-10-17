/**
 * roles-panel (owner, 2026-10-16): one role's panel on the Roles page, a modal window over the cards.
 * It shows only the closed projection of roles-panel-model.ts. Status words come from closed keys; agent text
 * (focus, goals, task names, what a task waits on, TL;DR lines, the 6 am report, a request's first line, a
 * project's or initiative's name) is a quoted text node of its own, never an i18n variable or attribute.
 * Chat targets stay in memory and only reach the app's existing open path (onOpen), after the panel closes.
 */
import { useLayoutEffect, useRef } from "react";
import { useT, type Translate } from "../i18n";
import type {
	InitiativeGroup,
	PanelLead,
	PanelLine,
	PanelReport,
	PanelTask,
	ReportState,
	RolePanel,
	WorkSource,
	WorkView,
} from "../roles-panel-model";
import type { UsefulOpenTarget } from "../roles-useful-model";

type Key = Parameters<Translate>[0];

const STATUS_KEYS = {
	"needs-you": "rpStatusNeedsYou",
	busy: "rpStatusBusy",
	paused: "rpStatusPaused",
	idle: "rpStatusIdle",
	"nothing-yet": "rpStatusNothingYet",
	unknown: "rpStatusUnknown",
} as const satisfies Record<RolePanel["status"], Key>;
const WORK_STATUS_KEYS = {
	active: "rpWorkActive",
	done: "rpWorkDone",
	dropped: "rpWorkDropped",
} as const satisfies Record<NonNullable<WorkView["status"]>, Key>;
const WORK_SOURCE_KEYS = {
	"not-sent": "rpWorkNotSent",
	unreadable: "rpWorkUnreadable",
	"too-big": "rpWorkTooBig",
	"unknown-change": "rpWorkUnknownChange",
	partial: "rpWorkPartial",
} as const satisfies Record<Exclude<WorkSource, "ok" | "none">, Key>;
const ROW_KEYS = {
	ready: "ruRowReady",
	"ready-after": "ruRowWaitsOn",
	working: "ruRowWorking",
	"asking-ops": "ruRowAskingOps",
	"asking-main": "ruRowAskingMain",
	asking: "ruRowAsking",
	"needs-decision": "ruRowNeedsDecision",
	"on-hold": "ruRowOnHold",
	blocked: "ruRowBlocked",
	done: "ruRowDone",
	unknown: "ruRowUnknown",
} as const satisfies Record<PanelTask["state"], Key>;
const REPORT_KEYS = {
	pending: "rpReportPending",
	failed: "rpReportFailed",
	"no-answer": "rpReportNoAnswer",
	unavailable: "rpReportUnavailable",
	first: "rpReportFirst",
	"not-active": "rpReportNotActive",
	"not-in-job": "rpReportNotInJob",
	unknown: "rpReportUnknown",
} as const satisfies Record<Exclude<ReportState, "report">, Key>;

function pad2(n: number): string {
	return String(n).padStart(2, "0");
}
/** A goal's day, "2026-10-04" or "2026-10-04T22:20" (the time left out), as "Oct 4" ("Oct 4, 2025" in
 *  another year), in this browser's language; as written when it isn't a real day. */
export function dayText(value: string, now: number): string {
	const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
	if (!m) return value;
	const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
	const date = new Date(y, mo - 1, d);
	if (date.getFullYear() !== y || date.getMonth() !== mo - 1 || date.getDate() !== d) return value;
	const sameYear = y === new Date(now).getFullYear();
	return date.toLocaleDateString(
		undefined,
		sameYear ? { month: "short", day: "numeric" } : { month: "short", day: "numeric", year: "numeric" },
	);
}

/** "14:05" today, else "Oct 3, 14:05" (this browser's clock). */
function clockText(ms: number, now: number): string {
	const d = new Date(ms);
	const hm = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
	if (d.toDateString() === new Date(now).toDateString()) return hm;
	return `${d.toLocaleDateString(undefined, { month: "short", day: "numeric" })}, ${hm}`;
}

export function RolePanelDialog({
	panel,
	now,
	onOpen,
	onAbout,
	onClose,
}: {
	panel: RolePanel;
	now: number;
	onOpen: (target: UsefulOpenTarget) => void;
	onAbout: (roleId: string) => void;
	/** back: the panel closed by itself (Close, Escape, a click outside): focus goes back to its card. */
	onClose: (back: boolean) => void;
}) {
	const t = useT();
	const ref = useRef<HTMLDialogElement>(null);
	const closeRef = useRef<HTMLButtonElement>(null);
	// A modal (the page behind is inert), shown before the first paint; removing it closes it.
	useLayoutEffect(() => {
		const d = ref.current;
		if (d && !d.open) {
			try {
				d.showModal();
			} catch {
				d.setAttribute("open", "");
			}
		}
		closeRef.current?.focus();
	}, []);
	// A target closes the panel first: the chat or Settings shows instead.
	const go = (target: UsefulOpenTarget) => {
		onClose(false);
		onOpen(target);
	};
	const home = panel.home;
	return (
		<dialog
			ref={ref}
			className="roles-panel"
			aria-labelledby="roles-panel-title"
			onCancel={(e) => {
				e.preventDefault();
				onClose(true);
			}}
			onClick={(e) => {
				// A click on the dimmed page around the window (the dialog itself, outside its content).
				if (e.target === e.currentTarget) onClose(true);
			}}
		>
			<header className="roles-panel-head">
				{/* Status under the name, so a long name never squeezes it into broken words on a phone. */}
				<div className="roles-panel-title">
					<h2 id="roles-panel-title">{panel.roleLabel}</h2>
					<p className="roles-panel-status">{t(STATUS_KEYS[panel.status])}</p>
				</div>
				<button ref={closeRef} type="button" className="roles-panel-close" onClick={() => onClose(true)}>
					{t("rpClose")}
				</button>
			</header>
			{/* A stop of its own so a keyboard can scroll a long panel. */}
			<div className="roles-panel-body" tabIndex={0} aria-label={t("rpBody")}>
				{panel.partial && <p className="roles-useful-note">{t("ruPartialRole")}</p>}
				<div className="roles-panel-actions">
					{home && (
						<button type="button" className="roles-useful-open" onClick={() => go(home)}>
							{t("rpOpenHome")}
						</button>
					)}
					<button
						type="button"
						className="roles-useful-open"
						onClick={() => {
							onClose(false);
							onAbout(panel.roleId);
						}}
					>
						{t("rpAbout")}
					</button>
				</div>
				<AboutSection panel={panel} now={now} />
				<WorkSection panel={panel} now={now} go={go} />
				<UpdatesSection lines={panel.lines} now={now} go={go} />
				<ReportSection report={panel.report} now={now} go={go} />
				<RequestsSection panel={panel} now={now} />
			</div>
		</dialog>
	);
}

function AboutSection({ panel, now }: { panel: RolePanel; now: number }) {
	const t = useT();
	return (
		<section className="roles-panel-section" aria-labelledby="roles-panel-about">
			<h3 id="roles-panel-about">{t("rpAboutHeading")}</h3>
			<dl className="roles-panel-facts">
				<dt>{t("rpFocus")}</dt>
				<dd>{panel.focus === null ? t("rpNotSet") : <q className="roles-useful-agent">{panel.focus}</q>}</dd>
				<dt>{t("rpWorkMode")}</dt>
				<dd>
					{panel.workMode === null
						? t("rpNotSet")
						: t(panel.workMode === "self-start" ? "rpSelfStart" : "rpRequestOnly")}
					{panel.workModeFrom !== null && (
						<span className="roles-panel-from">
							{" · "}
							{t(panel.workModeFrom === "owner" ? "rpFromOwner" : "rpFromRules")}
						</span>
					)}
				</dd>
			</dl>
			{panel.conflict !== null && (
				<p className="roles-panel-warn">
					<span>{t("rpConflict")}</span> <q className="roles-useful-agent">{panel.conflict}</q>
				</p>
			)}
			<h4>{t("rpGoals")}</h4>
			{panel.goals.length === 0 ? (
				<p>{t("rpNoGoals")}</p>
			) : (
				<ul className="roles-panel-goals">
					{panel.goals.map((g, i) => (
						<li key={String(i)}>
							{g.name === null ? t("rpGoalUnreadable") : <q className="roles-useful-agent">{g.name}</q>}
							{g.scope !== null && (
								<>
									{": "}
									<q className="roles-useful-agent">{g.scope}</q>
								</>
							)}
							{(g.approvedAt !== null || g.endsAt !== null) && (
								<span className="roles-panel-from">
									{g.approvedAt !== null && ` · ${t("rpApproved", { day: dayText(g.approvedAt, now) })}`}
									{g.endsAt !== null && ` · ${t("rpEnds", { day: dayText(g.endsAt, now) })}`}
								</span>
							)}
						</li>
					))}
				</ul>
			)}
			{panel.goalsOmitted && <p className="roles-useful-note">{t("rpGoalsOmitted")}</p>}
		</section>
	);
}

function LeadName({ lead }: { lead: PanelLead | null }) {
	const t = useT();
	if (!lead) return <span>{t("rpLeadUnknown")}</span>;
	if (lead.kind === "owner") return <span>{t("rpYou")}</span>;
	return <span className="roles-panel-lead">{lead.kind === "role" ? lead.label : lead.id}</span>;
}

/** An initiative's or project's heading line: kind, name (or id), lead, status and finish lines met. */
function WorkHead({ kind, view }: { kind: "initiative" | "project"; view: WorkView }) {
	const t = useT();
	return (
		<>
			<span className="roles-panel-kind">{t(kind === "initiative" ? "rpInitiative" : "rpProject")}</span>{" "}
			{view.name === null ? (
				<span className="roles-panel-id">{view.id}</span>
			) : (
				<q className="roles-useful-agent">{view.name}</q>
			)}
			<span className="roles-panel-from">
				{view.name === null && view.items === null ? (
					<>
						{" · "}
						{t("rpNotInRegistry")}
					</>
				) : (
					<>
						{" · "}
						{t("rpLedBy")} <LeadName lead={view.lead} />
						{view.status !== null && ` · ${t(WORK_STATUS_KEYS[view.status])}`}
						{view.items !== null &&
							view.met !== null &&
							view.items > 0 &&
							` · ${t("rpMet", { met: view.met, items: view.items })}`}
					</>
				)}
			</span>
		</>
	);
}

function WorkSection({ panel, now, go }: { panel: RolePanel; now: number; go: (target: UsefulOpenTarget) => void }) {
	const t = useT();
	const leads = panel.leads.initiatives.length + panel.leads.projects.length;
	const any =
		panel.standalone.length +
			panel.unrecorded.length +
			panel.groups.reduce((n, g) => n + g.tasks.length + g.projects.reduce((m, p) => m + p.tasks.length, 0), 0) >
		0;
	return (
		<section className="roles-panel-section" aria-labelledby="roles-panel-work">
			<h3 id="roles-panel-work">{t("rpWork")}</h3>
			{panel.work !== "ok" && panel.work !== "none" && (
				<p className="roles-useful-note">{t(WORK_SOURCE_KEYS[panel.work])}</p>
			)}
			{leads > 0 && (
				<>
					<h4>{t("rpLeads")}</h4>
					<ul className="roles-panel-leads">
						{panel.leads.initiatives.map((w) => (
							<li key={`i:${w.id}`}>
								<WorkHead kind="initiative" view={w} />
							</li>
						))}
						{panel.leads.projects.map((w) => (
							<li key={`p:${w.id}`}>
								<WorkHead kind="project" view={w} />
							</li>
						))}
					</ul>
				</>
			)}
			{!panel.tasksAvailable ? <p>{t("rpTasksUnavailable")}</p> : !any && <p>{t("rpNoOpenTasks")}</p>}
			{panel.groups.map((g) => (
				<Group key={g.initiative ? `i:${g.initiative.id}` : "none"} group={g} now={now} go={go} />
			))}
			{panel.standalone.length > 0 && (
				<section className="roles-panel-group">
					<h4>{t("rpStandalone")}</h4>
					<Tasks tasks={panel.standalone} now={now} go={go} />
				</section>
			)}
			{panel.unrecorded.length > 0 && (
				<section className="roles-panel-group">
					<h4>{t("rpUnrecorded")}</h4>
					<Tasks tasks={panel.unrecorded} now={now} go={go} />
				</section>
			)}
			{panel.tasksOmitted && <p className="roles-useful-note">{t("rpTasksOmitted")}</p>}
			{panel.queuedNotAllShown && <p className="roles-useful-note">{t("rpQueuedNotAll")}</p>}
			{panel.done !== null && <p className="roles-useful-note">{t("ruDoneCount", { n: panel.done })}</p>}
		</section>
	);
}

function Group({ group, now, go }: { group: InitiativeGroup; now: number; go: (target: UsefulOpenTarget) => void }) {
	const t = useT();
	return (
		<section className="roles-panel-group">
			<h4>{group.initiative ? <WorkHead kind="initiative" view={group.initiative} /> : t("rpNoInitiative")}</h4>
			{group.tasks.length > 0 && (
				<section className="roles-panel-project">
					<h5>{t("rpNoProject")}</h5>
					<Tasks tasks={group.tasks} now={now} go={go} />
				</section>
			)}
			{group.projects.map((p) => (
				<section key={p.project.id} className="roles-panel-project">
					<h5>
						<WorkHead kind="project" view={p.project} />
					</h5>
					<Tasks tasks={p.tasks} now={now} go={go} />
				</section>
			))}
		</section>
	);
}

function Tasks({ tasks, now, go }: { tasks: PanelTask[]; now: number; go: (target: UsefulOpenTarget) => void }) {
	return (
		<ul className="roles-useful-tasks">
			{tasks.map((task) => (
				<TaskItem key={task.taskId} task={task} now={now} go={go} />
			))}
		</ul>
	);
}

function TaskItem({ task, now, go }: { task: PanelTask; now: number; go: (target: UsefulOpenTarget) => void }) {
	const t = useT();
	const link = task.link;
	const owing = task.owing;
	return (
		<li className="roles-useful-task">
			<div className="roles-useful-body">
				<p className="roles-useful-task-name">
					<span>{t("ruTaskNumber", { id: task.taskId })}</span>{" "}
					{task.name === null ? t("rpUnnamed") : <q className="roles-useful-agent">{task.name}</q>}
				</p>
				<p className="roles-useful-task-state">
					<span className="roles-useful-status">{t(ROW_KEYS[task.state])}</span>
					{/* "Waits on" is the state word itself here: what it waits on follows it, as on the card. */}
					{task.state === "ready-after" &&
						(task.waitsOn === null ? (
							<span> {t("ruOtherTasks")}</span>
						) : (
							<>
								{" "}
								<q className="roles-useful-agent">{task.waitsOn}</q>
							</>
						))}
					{task.state !== "ready-after" && task.waitsOn !== null && !owing && (
						<>
							{" · "}
							<span className="roles-useful-status">{t("ruWaitsOn")}</span>{" "}
							<q className="roles-useful-agent">{task.waitsOn}</q>
						</>
					)}
					{task.pause === "reported-paused" && (
						<>
							{" · "}
							<span className="roles-useful-status">{t("ruTaskPaused")}</span>
						</>
					)}
				</p>
				{owing && (
					<p className="roles-panel-owing">
						<span>{t("rpWaitsOnLead")}</span> <LeadName lead={owing.lead} />
						{owing.owes !== null && (
							<>
								{" "}
								<span>{t("rpFor")}</span> <q className="roles-useful-agent">{owing.owes}</q>
							</>
						)}
						{owing.due !== null &&
							` · ${t(owing.due < now ? "rpWasDue" : "rpDue", { time: clockText(owing.due, now) })}`}
						{owing.reminders !== null && ` · ${t("rpReminders", { n: owing.reminders })}`}
						{owing.next !== null && (
							<>
								{" · "}
								<span>{t("rpNextUp")}</span>{" "}
								{owing.next.map((lead, i) => (
									<span key={String(i)}>
										<LeadName lead={lead} />
										{", "}
									</span>
								))}
								<span>{t("rpThenYou")}</span>
							</>
						)}
					</p>
				)}
			</div>
			{link && (
				<button type="button" className="roles-useful-open" onClick={() => go(link)}>
					{t(task.started ? "ruOpenChat" : "ruOpenQueue")}
					<span className="roles-useful-sr"> {t("ruForTask", { id: task.taskId })}</span>
				</button>
			)}
		</li>
	);
}

function UpdatesSection({
	lines,
	now,
	go,
}: {
	lines: PanelLine[];
	now: number;
	go: (target: UsefulOpenTarget) => void;
}) {
	const t = useT();
	return (
		<section className="roles-panel-section" aria-labelledby="roles-panel-updates">
			<h3 id="roles-panel-updates">{t("rpUpdates")}</h3>
			{lines.length === 0 ? (
				<p>{t("rpNoUpdates")}</p>
			) : (
				<ol className="roles-panel-lines">
					{lines.map((line) => (
						<li key={line.key} className="roles-panel-line">
							<p>
								<span className="roles-panel-time">
									{line.ts === null ? t("ruTimeUnknown") : clockText(line.ts, now)}
								</span>{" "}
								{line.needsYou && <span className="roles-panel-mark">{t("rpMarkNeedsYou")}</span>}
								{line.answered && <span className="roles-panel-mark">{t("rpMarkAnswered")}</span>}
								{line.blocked && <span className="roles-panel-mark">{t("rpMarkBlocked")}</span>}{" "}
								<q className="roles-useful-agent">{line.text}</q>
								{typeof line.where === "number" && (
									<span className="roles-panel-from"> · {t("rpFromTask", { id: line.where })}</span>
								)}
							</p>
							{line.link && (
								<button type="button" className="roles-useful-open" onClick={() => go(line.link as UsefulOpenTarget)}>
									{t("ruOpenChat")}
								</button>
							)}
						</li>
					))}
				</ol>
			)}
		</section>
	);
}

function ReportSection({
	report,
	now,
	go,
}: {
	report: PanelReport;
	now: number;
	go: (target: UsefulOpenTarget) => void;
}) {
	const t = useT();
	const link = report.link;
	return (
		<section className="roles-panel-section" aria-labelledby="roles-panel-report">
			<h3 id="roles-panel-report">
				{t("rpReport")}
				{report.date !== null && ` · ${t("rpReportFor", { day: report.date })}`}
			</h3>
			{report.state !== "report" ? (
				<p>
					{report.state === "pending" && report.askedAt !== null
						? t("rpReportPendingAt", { time: clockText(report.askedAt, now) })
						: report.state === "first" && report.next !== null
							? t("rpReportFirstAt", { time: clockText(report.next, now) })
							: t(REPORT_KEYS[report.state])}
				</p>
			) : (
				<>
					{report.sections.map((s, i) => (
						<section key={String(i)} className="roles-panel-report-part">
							<h4>
								<q className="roles-useful-agent">{s.heading}</q>
							</h4>
							{s.text !== null && <p className="roles-panel-report-text">{s.text}</p>}
						</section>
					))}
					{report.sections.length === 0 &&
						(report.text === null ? (
							<p>{t("rpReportUnreadable")}</p>
						) : (
							<p className="roles-panel-report-text">{report.text}</p>
						))}
					{report.cut && <p className="roles-useful-note">{t("rpReportCut")}</p>}
					{link && (
						<button type="button" className="roles-useful-open" onClick={() => go(link)}>
							{t("rpReportInChat")}
						</button>
					)}
				</>
			)}
		</section>
	);
}

function RequestsSection({ panel, now }: { panel: RolePanel; now: number }) {
	const t = useT();
	const r = panel.requests;
	const newest = r.newest;
	return (
		<section className="roles-panel-section" aria-labelledby="roles-panel-requests">
			<h3 id="roles-panel-requests">{t("rpRequests")}</h3>
			<p>{r.open === null ? t("ruCouldntRead") : t("rpRequestsOpen", { n: r.open })}</p>
			{newest && newest.text !== null && (
				<p className="roles-useful-meta">
					<span>{t("rpNewest")}</span> <q className="roles-useful-agent">{newest.text}</q>
					{newest.from !== null && (
						<>
							{" · "}
							<span>{t("rpFrom")}</span> <span className="roles-panel-lead">{newest.from}</span>
						</>
					)}
					{newest.at !== null && ` · ${clockText(newest.at, now)}`}
				</p>
			)}
		</section>
	);
}
