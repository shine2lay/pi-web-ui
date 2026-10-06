/**
 * roles-overview: the Roles page, a top bar view beside Chat, Terminal and Git.
 *
 * One look at every role: what it is doing (status, newest TL;DR line), what waits on the owner (the
 * "Waiting on you" strip, oldest first), its queue and its 6 am report. It only shows and opens: every
 * target opens an existing chat (at the item: `?chat=<file>&focus=...`), Settings -> Identities at the
 * role, or a part of the page in place. Nothing here starts, stops or answers anything.
 *
 * Layout (design-lab/roles-page/SPEC.md, final gate): phone (<= 768 px) compact cards that open in place
 * plus a "Now | 6 am reports" switch; desktop a board (Role | Now | Queue | 6 am report | expand). Rows in
 * two groups, alphabetical, so a role is always in the same place. Which rows are open is kept on this
 * device (roles-view-model.ts).
 *
 * Data: roles-state.ts (the server pushes while the page is shown); what to show: roles-view-model.ts.
 */
import {
	memo,
	useCallback,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
	type MouseEvent,
	type ReactNode,
} from "react";
import { FiCheckCircle, FiChevronDown, FiChevronRight, FiInfo, FiMessageSquare, FiSettings } from "react-icons/fi";
import { useAppField } from "../app-globals";
import { parseFocus, type ChatFocusKind } from "../chat-focus";
import { useT, type Translate } from "../i18n";
import { reloadRoles, useRoles } from "../roles-state";
import {
	ageOf,
	agoOf,
	askWhere,
	CARD_LINES_SHOWN,
	chatHref,
	clockOf,
	GOALS_SHOWN,
	goalRest,
	goalsLine,
	groupRoles,
	hasProblem,
	isQuiet,
	leadTask,
	nowLineOf,
	oldestSince,
	queueCounts,
	queueHasWork,
	queueStopped,
	readOpenRoles,
	readStripOpen,
	reportDay,
	reportGoal,
	reportReason,
	reportRoles,
	rolesSummary,
	saveOpenRoles,
	saveStripOpen,
	STALE_MS,
	taskLook,
	taskWord,
	whereTag,
	type NowLine,
	type RolesLayout,
	type TaskLook,
} from "../roles-view-model";
import type { UiRoleAsk, UiRoleOverview, UiRoleReport, UiRoleStatus, UiRoleTask, UiRoleTldrLine } from "../types";
import "../roles-view.css";

/** Where a target of the page leads: a chat, maybe at one item of it. */
export interface RolesOpenTarget {
	file: string;
	focus?: { kind: ChatFocusKind; id: string };
	/** "Report in chat": the answer's time in its chat (the chat scrolls to it). */
	jumpAt?: number;
}

interface Nav {
	open: (target: RolesOpenTarget) => void;
	about: (roleId: string) => void;
}

export interface RolesViewProps {
	/** The view is shown (the page watches the roles only then). */
	active: boolean;
	/** The phone layout (the app's 768 px breakpoint). */
	phone: boolean;
	/** `?view=roles#r-<id>`: scroll to this role (seq grows with every request). */
	focusRole?: { id: string; seq: number } | null;
	/** Open a chat (the app switches to it; the item shows in its right panel or the chat scrolls). */
	onOpen: (target: RolesOpenTarget) => void;
	/** Settings -> Identities at this role. */
	onAbout: (roleId: string) => void;
}

const STATUS_KEY = {
	"needs-you": "rolesStatusNeedsYou",
	busy: "rolesStatusBusy",
	paused: "rolesStatusPaused",
	idle: "rolesStatusIdle",
	"nothing-yet": "rolesStatusNothing",
} as const satisfies Record<UiRoleStatus, Parameters<Translate>[0]>;

type IconKind = "needs" | "busy" | "paused" | "idle" | "nothing" | "hold" | "asking" | "queued";

const STATUS_ICON: Record<UiRoleStatus, IconKind> = {
	"needs-you": "needs",
	busy: "busy",
	paused: "paused",
	idle: "idle",
	"nothing-yet": "nothing",
};

const TASK_ICON: Record<TaskLook, IconKind> = {
	needs: "needs",
	working: "busy",
	hold: "hold",
	asking: "asking",
	queued: "queued",
};

/** The page's own 16 px marks (status is always an icon and a word, never colour alone). */
function Ic({ kind }: { kind: IconKind }) {
	const ring = (dash?: string) => (
		<circle
			cx="8"
			cy="8"
			r="6.25"
			fill="none"
			stroke="currentColor"
			strokeWidth="1.5"
			{...(dash ? { strokeDasharray: dash } : {})}
		/>
	);
	let body: ReactNode;
	switch (kind) {
		case "needs":
			body = (
				<>
					{ring()}
					<path d="M8 4.6v4.1" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
					<circle cx="8" cy="11.3" r="1" fill="currentColor" />
				</>
			);
			break;
		case "busy":
			body = (
				<>
					{ring()}
					<circle className="rv-pulse" cx="8" cy="8" r="2.6" fill="currentColor" />
				</>
			);
			break;
		case "paused":
			body = (
				<>
					<rect x="4.2" y="3.4" width="2.6" height="9.2" rx="0.8" fill="currentColor" />
					<rect x="9.2" y="3.4" width="2.6" height="9.2" rx="0.8" fill="currentColor" />
				</>
			);
			break;
		case "idle":
			body = ring();
			break;
		case "nothing":
			body = ring("2.4 2.2");
			break;
		case "hold":
			body = (
				<>
					{ring("2.4 2.2")}
					<path d="M8 5v3.3l2.1 1.3" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
				</>
			);
			break;
		case "asking":
			body = (
				<path
					d="M2.75 3.75h10.5v6.5H7.4L4.6 12.6v-2.35H2.75z"
					fill="none"
					stroke="currentColor"
					strokeWidth="1.4"
					strokeLinejoin="round"
				/>
			);
			break;
		default:
			body = <rect x="4" y="4" width="8" height="8" rx="2" fill="none" stroke="currentColor" strokeWidth="1.4" />;
	}
	return (
		<svg className="rv-ic" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
			{body}
		</svg>
	);
}

function Chevron({ open }: { open: boolean }) {
	return open ? (
		<FiChevronDown className="rv-ic rv-chev open" aria-hidden="true" />
	) : (
		<FiChevronDown className="rv-ic rv-chev" aria-hidden="true" />
	);
}

function StatusWord({ status }: { status: UiRoleStatus }) {
	const t = useT();
	return (
		<span className={`rv-st ${status}`}>
			<Ic kind={STATUS_ICON[status]} />
			{t(STATUS_KEY[status])}
		</span>
	);
}

/** A link to a chat: a plain click opens it here; a middle/modified click opens a new tab at the same place. */
function ChatLink({
	nav,
	target,
	className,
	label,
	children,
}: {
	nav: Nav;
	target: RolesOpenTarget;
	className?: string;
	label?: string;
	children: ReactNode;
}) {
	const href = chatHref(target.file, target.focus ? `${target.focus.kind}:${target.focus.id}` : undefined);
	const onClick = (e: MouseEvent<HTMLAnchorElement>) => {
		if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
		e.preventDefault();
		nav.open(target);
	};
	return (
		<a href={href} className={className} onClick={onClick} {...(label ? { "aria-label": label } : {})}>
			{children}
		</a>
	);
}

function askTarget(ask: UiRoleAsk): RolesOpenTarget {
	const focus = parseFocus(ask.focus);
	return { file: ask.chat.file, ...(focus ? { focus } : {}) };
}

function lineTarget(line: UiRoleTldrLine): RolesOpenTarget {
	return { file: line.chat.file, focus: { kind: "tldr", id: line.id } };
}

/** A task opens its own chat once started, else the home chat at the task (its Queue tab). */
function taskTarget(task: UiRoleTask, role: UiRoleOverview): RolesOpenTarget | null {
	if (task.chat) return { file: task.chat.file };
	if (role.homeChat) return { file: role.homeChat.file, focus: { kind: "task", id: String(task.id) } };
	return null;
}

function reportTarget(report: UiRoleReport): RolesOpenTarget | null {
	if (!report.chat) return null;
	const focus = report.date ? parseFocus(`report:${report.date}`) : null;
	return {
		file: report.chat.file,
		...(focus ? { focus } : {}),
		...(report.messageAt ? { jumpAt: report.messageAt } : {}),
	};
}

/** Re-render now and then while shown (ages, "updated 07:12", staleness). */
function useNow(active: boolean): number {
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		if (!active) return;
		setNow(Date.now());
		const timer = setInterval(() => setNow(Date.now()), 30_000);
		return () => clearInterval(timer);
	}, [active]);
	return now;
}

// ---------------------------------------------------------------------------
// The page
// ---------------------------------------------------------------------------

/** What this device remembers for one layout: its open rows and whether the strip is open. */
function layoutMemory(layout: RolesLayout): { layout: RolesLayout; ids: ReadonlySet<string>; strip: boolean } {
	return { layout, ids: new Set(readOpenRoles(layout)), strip: readStripOpen(layout) };
}

export const RolesView = memo(function RolesView({ active, phone, focusRole, onOpen, onAbout }: RolesViewProps) {
	const t = useT();
	const roles = useRoles(active ? "full" : "off");
	const conn = useAppField("status");
	const now = useNow(active);
	const layout: RolesLayout = phone ? "phone" : "desktop";
	// Open rows and the strip are remembered per layout (phone / desktop). Switching layout reads the
	// other layout's memory while rendering, so no frame shows one layout's open rows on the other.
	const [memory, setMemory] = useState(() => layoutMemory(layout));
	let mem = memory;
	if (memory.layout !== layout) {
		mem = layoutMemory(layout);
		setMemory(mem);
	}
	const openIds = mem.ids;
	const stripOpen = mem.strip;
	const [mode, setMode] = useState<"now" | "reports">("now");
	const toggleRow = useCallback((id: string) => {
		setMemory((prev) => {
			const next = new Set(prev.ids);
			if (next.has(id)) next.delete(id);
			else next.add(id);
			saveOpenRoles(prev.layout, next);
			return { ...prev, ids: next };
		});
	}, []);
	const toggleStrip = useCallback(() => {
		setMemory((prev) => {
			saveStripOpen(prev.layout, !prev.strip);
			return { ...prev, strip: !prev.strip };
		});
	}, []);
	const nav = useMemo<Nav>(() => ({ open: onOpen, about: onAbout }), [onOpen, onAbout]);

	const pageRef = useRef<HTMLElement>(null);
	const stripRef = useRef<HTMLDivElement>(null);
	const headRef = useRef<HTMLHeadingElement>(null);
	const o = roles.overview;

	// The sticky strip must not cover the focused element: scroll-padding-top follows its height.
	useLayoutEffect(() => {
		const page = pageRef.current;
		const strip = stripRef.current;
		if (!page || !strip || typeof ResizeObserver === "undefined") return;
		const apply = () => page.style.setProperty("--rv-strip-h", `${strip.offsetHeight}px`);
		apply();
		const ro = new ResizeObserver(apply);
		ro.observe(strip);
		return () => ro.disconnect();
	}, [o !== null, phone]);

	// `?view=roles#r-<id>`: scroll to that role once the roles are in.
	const shownRole = useRef(0);
	useEffect(() => {
		if (!active || !o || !focusRole || shownRole.current === focusRole.seq) return;
		shownRole.current = focusRole.seq;
		if (phone) setMode("now");
		requestAnimationFrame(() => {
			const row = pageRef.current?.querySelector(`[data-role-id="${CSS.escape(focusRole.id)}"]`);
			if (!(row instanceof HTMLElement)) return;
			row.scrollIntoView?.({ block: "start" });
			row.querySelector<HTMLElement>("a, button")?.focus({ preventScroll: true });
		});
	}, [active, o, focusRole, phone]);

	const reload = () => {
		reloadRoles();
		headRef.current?.focus();
	};

	const tz = o?.reportTz ?? "America/Los_Angeles";
	const checkedAt = roles.checkedAt;
	const stale = !!o && (conn !== "open" || (roles.heardAt !== undefined && Date.now() - roles.heardAt > STALE_MS));
	const loading = !o && roles.status !== "error";
	const groups = useMemo(() => groupRoles(o?.roles ?? []), [o]);
	const withProblems = useMemo(() => (o?.roles ?? []).filter((r) => (r.problems?.length ?? 0) > 0), [o]);
	const reportList = useMemo(() => reportRoles([...groups.selfStart, ...groups.onRequest]), [groups]);

	let liveText = "";
	if (loading) liveText = t("rolesLoading");
	else if (checkedAt)
		liveText =
			stale || roles.error
				? t("rolesUpdatedAt", { time: clockOf(checkedAt, now) })
				: t("rolesLive", { time: clockOf(checkedAt, now) });

	return (
		<section className={`roles-view${phone ? " rv-phone" : " rv-desk"}`} ref={pageRef} aria-labelledby="rv-title">
			<div className="rv-page">
				<header className="rv-phead">
					<h1 id="rv-title" ref={headRef} tabIndex={-1}>
						{t("rolesTitle")}
					</h1>
					{phone && o && (
						<div className="rv-switch" role="group" aria-label={t("rolesShow")}>
							<button type="button" aria-pressed={mode === "now"} onClick={() => setMode("now")}>
								{t("rolesViewNow")}
							</button>
							<button type="button" aria-pressed={mode === "reports"} onClick={() => setMode("reports")}>
								{t("rolesViewReports", { n: reportList.filter((r) => r.report.state === "report").length })}
							</button>
						</div>
					)}
					{!phone && o && <span className="rv-sum rv-meta">{rolesSummary(t, o.roles)}</span>}
					{liveText && <span className="rv-upd rv-meta">{liveText}</span>}
				</header>

				{stale && checkedAt && (
					<p className="rv-note" role="status">
						<FiInfo className="rv-ic" aria-hidden="true" />
						{t("rolesStale", { ago: agoOf(checkedAt, now), time: clockOf(checkedAt, now) })}
					</p>
				)}
				{!stale && o && roles.error && checkedAt && (
					<p className="rv-note" role="status">
						<FiInfo className="rv-ic" aria-hidden="true" />
						{t("rolesRefreshFailed", { ago: agoOf(checkedAt, now), time: clockOf(checkedAt, now) })}
					</p>
				)}
				{withProblems.length > 0 && (
					<p className="rv-note">
						<FiInfo className="rv-ic" aria-hidden="true" />
						{withProblems.length === 1
							? t("rolesPartialOne", { names: withProblems[0].id })
							: t("rolesPartial", { n: withProblems.length, names: withProblems.map((r) => r.id).join(", ") })}
					</p>
				)}
				{o?.paused && (
					<p className="rv-note">
						<FiInfo className="rv-ic" aria-hidden="true" />
						{t("rolesPausedNote")}
					</p>
				)}

				{!o && roles.status === "error" && (
					<div className="rv-errbox" role="alert">
						<p className="rv-et">
							<FiInfo className="rv-ic" aria-hidden="true" />
							{t("rolesError")}
							{roles.failedAt ? ` ${t("rolesLastTry", { time: clockOf(roles.failedAt, now) })}` : ""}
						</p>
						<button type="button" className="rv-reload" onClick={reload}>
							{t("rolesReload")}
						</button>
					</div>
				)}

				{loading && <Skeleton phone={phone} />}

				{o && (
					<>
						<div className="rv-strip" ref={stripRef}>
							<Strip asks={o.asks} open={stripOpen} onToggle={toggleStrip} phone={phone} now={now} nav={nav} />
						</div>
						{o.roles.length === 0 ? (
							<p className="rv-empty rv-meta">{t("rolesNoRoles")}</p>
						) : phone && mode === "reports" ? (
							<ReportList roles={reportList} tz={tz} nav={nav} />
						) : phone ? (
							<>
								<PhoneGroup
									first
									title={t("rolesGroupSelf", { n: groups.selfStart.length })}
									roles={groups.selfStart}
									openIds={openIds}
									onToggle={toggleRow}
									now={now}
									tz={tz}
									nav={nav}
								/>
								<PhoneGroup
									title={t("rolesGroupRequest", { n: groups.onRequest.length })}
									roles={groups.onRequest}
									openIds={openIds}
									onToggle={toggleRow}
									now={now}
									tz={tz}
									nav={nav}
								/>
							</>
						) : (
							<section className="rv-board" aria-label={t("rolesBoardLabel")}>
								<div className="rv-bhead" aria-hidden="true">
									<div>{t("rolesColRole")}</div>
									<div>{t("rolesColNow")}</div>
									<div>{t("rolesColQueue")}</div>
									<div>{t("rolesColReport")}</div>
									<div />
								</div>
								<h2 className="rv-bgrp">{t("rolesGroupSelf", { n: groups.selfStart.length })}</h2>
								{groups.selfStart.map((r) => (
									<BoardRow
										key={r.id}
										role={r}
										open={openIds.has(r.id)}
										onToggle={toggleRow}
										now={now}
										tz={tz}
										nav={nav}
									/>
								))}
								<h2 className="rv-bgrp">{t("rolesGroupRequest", { n: groups.onRequest.length })}</h2>
								{groups.onRequest.map((r) => (
									<BoardRow
										key={r.id}
										role={r}
										open={openIds.has(r.id)}
										onToggle={toggleRow}
										now={now}
										tz={tz}
										nav={nav}
									/>
								))}
							</section>
						)}
					</>
				)}
			</div>
		</section>
	);
});

function Skeleton({ phone }: { phone: boolean }) {
	const rows = phone ? 6 : 8;
	return (
		<div className="rv-skeleton" aria-hidden="true">
			<span className="rv-skel rv-skel-strip" />
			<span className="rv-skel rv-skel-h" />
			{Array.from({ length: rows }, (_, i) => (
				<span key={i} className="rv-skel rv-skel-row" />
			))}
		</div>
	);
}

// ---------------------------------------------------------------------------
// "Waiting on you"
// ---------------------------------------------------------------------------

function Strip({
	asks,
	open,
	onToggle,
	phone,
	now,
	nav,
}: {
	asks: UiRoleAsk[];
	open: boolean;
	onToggle: () => void;
	phone: boolean;
	now: number;
	nav: Nav;
}) {
	const t = useT();
	if (asks.length === 0) {
		return (
			<div className="rv-calm">
				<FiCheckCircle className="rv-ic" aria-hidden="true" />
				{t("rolesCalm")}
			</div>
		);
	}
	const oldest = oldestSince(asks);
	const first = asks[0];
	return (
		<div className="rv-wbox">
			<button type="button" className="rv-wbtn" aria-expanded={open} aria-controls="rv-wlist" onClick={onToggle}>
				<Ic kind="needs" />
				<b>{t("rolesWaitingOnYou", { n: asks.length })}</b>
				<span className="rv-meta rv-wold">
					{oldest !== undefined ? t("rolesOldest", { age: ageOf(oldest, now) }) : ""}
				</span>
				<Chevron open={open} />
				{phone && !open && (
					<span className="rv-wprev rv-cl1">
						{first.role} · {first.text}
					</span>
				)}
			</button>
			{open && (
				<ul className="rv-wlist" id="rv-wlist">
					{asks.map((a) => (
						<li key={a.key}>
							<ChatLink nav={nav} target={askTarget(a)} className="rv-witem">
								<span className="rv-w1">
									<b>{a.role}</b>
									<span className="rv-meta">
										{askWhere(t, a)}
										{a.since !== undefined ? ` · ${ageOf(a.since, now)}` : ""}
									</span>
								</span>
								<span className="rv-wask rv-cl2">{a.text}</span>
								<span className="rv-wgo">
									{t("rolesAnswerInChat")}
									<FiChevronRight className="rv-ic" aria-hidden="true" />
								</span>
							</ChatLink>
						</li>
					))}
				</ul>
			)}
		</div>
	);
}

// ---------------------------------------------------------------------------
// Shared pieces
// ---------------------------------------------------------------------------

/** The "now" line's content (phone card and desktop cell). */
function NowContent({ line, now, wide }: { line: NowLine; now: number; wide?: boolean }) {
	const t = useT();
	switch (line.kind) {
		case "ask":
			return (
				<>
					<span className="rv-lb">
						<Ic kind="needs" />
						{t("rolesNeedsYou")}
					</span>{" "}
					<span className="rv-lt">
						{askWhere(t, line.ask)}
						{line.ask.since !== undefined ? ` · ${ageOf(line.ask.since, now)}` : ""}
					</span>{" "}
					<span className={wide ? "rv-tx rv-cl2" : "rv-tx"}>{line.ask.text}</span>
				</>
			);
		case "line":
			return (
				<>
					<span className="rv-lt">
						{clockOf(line.line.ts, now)} · {whereTag(t, line.line.chat.where)}
					</span>{" "}
					{line.line.answered && <span className="rv-lb rv-ans">{t("rolesAnswered")} </span>}
					<span className={wide ? "rv-tx rv-cl2" : "rv-tx"}>{line.line.text}</span>
				</>
			);
		case "request":
			return <span className="rv-tx rv-dim">{t("rolesAsked", { from: line.from, text: line.text })}</span>;
		case "waiting":
			return <span className="rv-tx rv-dim">{t("rolesWaitingRequests")}</span>;
		default:
			return <span className="rv-tx rv-dim">{t("rolesNothingYet")}</span>;
	}
}

function lineClass(base: string, line: UiRoleTldrLine, newest: boolean): string {
	let cls = base;
	if (line.needsYou && !line.answered) cls += " needs";
	else if (line.answered) cls += " answered";
	else if (newest) cls += " newest";
	return cls;
}

/** A TL;DR line that opens its chat at the line. */
function TldrLink({
	line,
	newest,
	now,
	nav,
	desk,
}: {
	line: UiRoleTldrLine;
	newest: boolean;
	now: number;
	nav: Nav;
	desk?: boolean;
}) {
	const t = useT();
	const needs = !!line.needsYou && !line.answered;
	return (
		<ChatLink nav={nav} target={lineTarget(line)} className={lineClass(desk ? "rv-dline" : "rv-line", line, newest)}>
			<span className="rv-lt">
				{clockOf(line.ts, now)} · {whereTag(t, line.chat.where)}
			</span>{" "}
			{needs && (
				<span className="rv-lb">
					<Ic kind="needs" />
					{t("rolesNeedsYou")}{" "}
				</span>
			)}
			{line.answered && <span className="rv-lb">{t("rolesAnswered")} </span>}
			{line.kind === "blocked" && !needs && <span className="rv-lb rv-dim">{t("rolesBlockedLine")} </span>}
			<span className={desk && !needs ? "rv-tx rv-cl1" : "rv-tx"}>{line.text}</span>
		</ChatLink>
	);
}

/** An ask that isn't a TL;DR line (a question waiting in a chat), as a needs line. */
function AskLink({ ask, now, nav, desk }: { ask: UiRoleAsk; now: number; nav: Nav; desk?: boolean }) {
	const t = useT();
	return (
		<ChatLink nav={nav} target={askTarget(ask)} className={desk ? "rv-dline needs rv-wrap" : "rv-line needs"}>
			<span className="rv-lt">
				{askWhere(t, ask)}
				{ask.since !== undefined ? ` · ${ageOf(ask.since, now)}` : ""}
			</span>{" "}
			<span className="rv-lb">
				<Ic kind="needs" />
				{t("rolesNeedsYou")}{" "}
			</span>
			<span className="rv-tx">{ask.text}</span>
		</ChatLink>
	);
}

function Goals({ role, full }: { role: UiRoleOverview; full?: boolean }) {
	const t = useT();
	const [all, setAll] = useState(false);
	if (role.goals.length === 0) return null;
	const shown = all ? role.goals : role.goals.slice(0, GOALS_SHOWN);
	const more = role.goals.length - shown.length;
	return (
		<div className="rv-goals">
			{full && <h4 className="rv-sech">{t("rolesGoalsHeading")}</h4>}
			<ul aria-label={full ? undefined : t("rolesGoalsHeading")}>
				{shown.map((g) => (
					<li key={g.name}>
						<span>
							<b>{g.name}</b>
							{full && <span className="rv-meta"> · {goalRest(t, g)}</span>}
						</span>
					</li>
				))}
			</ul>
			{more > 0 && (
				<button type="button" className="rv-more" onClick={() => setAll(true)}>
					{t("rolesMoreN", { n: more })}
				</button>
			)}
		</div>
	);
}

function ReportText({ report, clamp }: { report: UiRoleReport; clamp?: boolean }) {
	const t = useT();
	return (
		<div className="rv-rep">
			{report.sections?.length ? (
				report.sections.map((s) => (
					<p key={s.heading} className={clamp ? "rv-cl2" : undefined}>
						<span className="rv-rl">{s.heading}:</span> {s.text}
					</p>
				))
			) : (
				<p className={clamp ? "rv-cl2" : undefined}>{report.text}</p>
			)}
			{!clamp && report.cut && <p className="rv-meta">{t("rolesReportCut")}</p>}
		</div>
	);
}

function ReportInChat({ report, nav }: { report: UiRoleReport; nav: Nav }) {
	const t = useT();
	const target = reportTarget(report);
	if (!target) return null;
	return (
		<ChatLink nav={nav} target={target} className="rv-act">
			<FiMessageSquare className="rv-ic" aria-hidden="true" />
			{t("rolesReportInChat")}
		</ChatLink>
	);
}

// ---------------------------------------------------------------------------
// Phone: cards
// ---------------------------------------------------------------------------

function PhoneGroup({
	title,
	roles,
	first,
	openIds,
	onToggle,
	now,
	tz,
	nav,
}: {
	title: string;
	roles: UiRoleOverview[];
	first?: boolean;
	openIds: ReadonlySet<string>;
	onToggle: (id: string) => void;
	now: number;
	tz: string;
	nav: Nav;
}) {
	return (
		<>
			<h2 className={first ? "rv-grp first" : "rv-grp"}>{title}</h2>
			<div className="rv-rows">
				{roles.map((r) => (
					<PhoneCard key={r.id} role={r} open={openIds.has(r.id)} onToggle={onToggle} now={now} tz={tz} nav={nav} />
				))}
			</div>
		</>
	);
}

function QueueLine({ role }: { role: UiRoleOverview }) {
	const t = useT();
	if (hasProblem(role, "queue")) {
		return <span className="rv-qs">{t("rolesNotAvailable", { what: t("rolesPartQueue") })}</span>;
	}
	const queue = role.queue;
	if (!queueHasWork(queue)) return null;
	const lead = leadTask(queue);
	return (
		<span className="rv-qs">
			<span className="rv-qt rv-cl1">
				{lead
					? `#${lead.id} ${taskWord(t, lead)} · ${lead.title}`
					: queueStopped(queue)
						? t("rolesQueueStopped")
						: t("rolesNoActiveTask")}
			</span>
			<span className="rv-qc">{queueCounts(t, queue, !!lead, false)}</span>
		</span>
	);
}

const PhoneCard = memo(function PhoneCard({
	role,
	open,
	onToggle,
	now,
	tz,
	nav,
}: {
	role: UiRoleOverview;
	open: boolean;
	onToggle: (id: string) => void;
	now: number;
	tz: string;
	nav: Nav;
}) {
	const t = useT();
	const quiet = isQuiet(role, now);
	const line = nowLineOf(role, now);
	const needs = role.status === "needs-you";
	const panelId = `rv-p-${role.id}`;
	const gl = goalsLine(t, role);
	const head = (
		<>
			<span className="rv-r1">
				<h3 className="rv-name">{role.id}</h3>
				{role.homeChat && (
					<span className="rv-go" aria-hidden="true">
						<FiMessageSquare className="rv-ic" />
					</span>
				)}
				<span className="rv-stg">
					<StatusWord status={role.status} />
					{role.lastActivity ? <span className="rv-meta"> · {agoOf(role.lastActivity, now)}</span> : null}
				</span>
			</span>
			{gl && !quiet && <span className="rv-gl">{gl}</span>}
			<span className={`rv-now rv-cl2${line.kind === "ask" ? " needs" : ""}`}>
				<NowContent line={line} now={now} />
			</span>
			{!quiet && <QueueLine role={role} />}
		</>
	);
	let cls = "rv-role";
	if (needs) cls += " needs";
	if (role.status === "busy") cls += " busy";
	if (quiet) cls += " quiet";
	return (
		<article className={cls} data-role-id={role.id}>
			<div className="rv-rhead">
				{role.homeChat ? (
					<ChatLink nav={nav} target={{ file: role.homeChat.file }} className="rv-rmain">
						{head}
					</ChatLink>
				) : (
					<div className="rv-rmain">{head}</div>
				)}
				<button
					type="button"
					className="rv-rexp"
					aria-expanded={open}
					aria-controls={panelId}
					aria-label={open ? t("rolesCloseRow", { role: role.id }) : t("rolesOpenCard", { role: role.id })}
					onClick={() => onToggle(role.id)}
				>
					<Chevron open={open} />
				</button>
			</div>
			{open && <CardPanel id={panelId} role={role} now={now} tz={tz} nav={nav} />}
		</article>
	);
});

function CardPanel({
	id,
	role,
	now,
	tz,
	nav,
}: {
	id: string;
	role: UiRoleOverview;
	now: number;
	tz: string;
	nav: Nav;
}) {
	const t = useT();
	const [allLines, setAllLines] = useState(false);
	const [queuedOpen, setQueuedOpen] = useState(false);
	const [reportOpen, setReportOpen] = useState(false);
	const questions = role.asks.filter((a) => a.kind === "question");
	const lines = role.tldr;
	const shownLines = allLines ? lines : lines.slice(0, CARD_LINES_SHOWN);
	const moreLines = lines.length - shownLines.length;
	const queue = role.queue;
	const reason = reportReason(t, role.report, tz);
	const day = reportDay(role.report, tz);
	const goal = reportGoal(role.report);
	return (
		<div className="rv-panel" id={id}>
			{role.conflict && (
				<p className="rv-note rv-in">
					<FiInfo className="rv-ic" aria-hidden="true" />
					{t("rolesConflict", { text: role.conflict })}
				</p>
			)}
			{role.goals.length > 0 && <Goals role={role} full />}
			<section className="rv-sec">
				<h4 className="rv-sech">{t("rolesTldrHeading")}</h4>
				{questions.map((a) => (
					<AskLink key={a.key} ask={a} now={now} nav={nav} />
				))}
				{hasProblem(role, "tldr") && <p className="rv-meta">{t("rolesNotAvailable", { what: t("rolesPartTldr") })}</p>}
				{lines.length === 0 && !hasProblem(role, "tldr") && questions.length === 0 && (
					<p className="rv-meta rv-pad">{t("rolesNoTldr")}</p>
				)}
				{shownLines.map((l, i) => (
					<TldrLink key={`${l.chat.file}:${l.id}`} line={l} newest={i === 0} now={now} nav={nav} />
				))}
				{(moreLines > 0 || allLines) && lines.length > CARD_LINES_SHOWN && (
					<button type="button" className="rv-more" aria-expanded={allLines} onClick={() => setAllLines((v) => !v)}>
						{allLines ? t("rolesFewerLines") : t("rolesMoreLines", { n: moreLines })}
					</button>
				)}
			</section>
			<section className="rv-sec">
				<h4 className="rv-sech">{t("rolesQueueHeading")}</h4>
				{hasProblem(role, "queue") ? (
					<p className="rv-meta rv-pad">{t("rolesNotAvailable", { what: t("rolesPartQueue") })}</p>
				) : !queue ? (
					<p className="rv-meta rv-pad">{t("rolesNoQueue")}</p>
				) : (
					<>
						{queueStopped(queue) && <p className="rv-meta">{t("rolesQueueStopped")}</p>}
						{queue.active.map((task) => (
							<PhoneTask key={task.id} task={task} role={role} nav={nav} />
						))}
						{queue.active.length === 0 && <p className="rv-meta rv-pad">{t("rolesNoActiveTask")}</p>}
						{queue.counts.queued + queue.counts.done > 0 && (
							<button
								type="button"
								className="rv-more"
								aria-expanded={queuedOpen}
								onClick={() => setQueuedOpen((v) => !v)}
								disabled={queue.counts.queued === 0}
							>
								{[t("rolesQueued", { n: queue.counts.queued }), t("rolesDone", { n: queue.counts.done })].join(" · ")}
							</button>
						)}
						{queuedOpen && <QueuedList queue={queue} />}
					</>
				)}
			</section>
			<section className="rv-sec">
				{reason ? (
					<p className="rv-repnone">
						<FiInfo className="rv-ic" aria-hidden="true" />
						{reason}
					</p>
				) : (
					<>
						<button
							type="button"
							className="rv-rep-btn"
							aria-expanded={reportOpen}
							onClick={() => setReportOpen((v) => !v)}
						>
							<span className="rv-rh">{t("rolesReportHead", { day })}</span>
							{!reportOpen && goal && <span className="rv-rgl rv-cl2">{goal}</span>}
							<Chevron open={reportOpen} />
						</button>
						{reportOpen && (
							<>
								<ReportText report={role.report} />
								<div className="rv-acts">
									<ReportInChat report={role.report} nav={nav} />
								</div>
							</>
						)}
					</>
				)}
			</section>
			<div className="rv-pfoot">
				{role.homeChat ? (
					<ChatLink nav={nav} target={{ file: role.homeChat.file }} className="rv-act">
						<FiMessageSquare className="rv-ic" aria-hidden="true" />
						{t("rolesOpenChatOf", { role: role.id })}
					</ChatLink>
				) : (
					<span className="rv-meta rv-pad">{t("rolesNoHomeChat")}</span>
				)}
				<button type="button" className="rv-act" onClick={() => nav.about(role.id)}>
					<FiSettings className="rv-ic" aria-hidden="true" />
					{t("rolesAboutRules")}
				</button>
			</div>
		</div>
	);
}

function PhoneTask({ task, role, nav }: { task: UiRoleTask; role: UiRoleOverview; nav: Nav }) {
	const t = useT();
	const look = taskLook(task);
	const target = taskTarget(task, role);
	const inner = (
		<>
			<span className="rv-num">#{task.id}</span>
			<span className="rv-tb">
				<span className="rv-tt1 rv-cl1">{task.title}</span>
				<span className="rv-ts">
					<span className={`rv-st ${look}`}>
						<Ic kind={TASK_ICON[look]} />
						{taskWord(t, task)}
					</span>
					{task.latest && <span className="rv-tsl rv-cl1">{task.latest.text}</span>}
				</span>
			</span>
		</>
	);
	return target ? (
		<ChatLink nav={nav} target={target} className={`rv-task ${look}`}>
			{inner}
		</ChatLink>
	) : (
		<div className={`rv-task ${look}`}>{inner}</div>
	);
}

function QueuedList({ queue }: { queue: NonNullable<UiRoleOverview["queue"]> }) {
	const t = useT();
	const more = queue.counts.queued - queue.queued.length;
	return (
		<ul className="rv-qlist">
			{queue.queued.map((task) => (
				<li key={task.id}>
					<span className="rv-num">#{task.id}</span> {t("rolesTaskQueued")} · {task.title}
				</li>
			))}
			{more > 0 && <li>{t("rolesMoreQueued", { n: more })}</li>}
		</ul>
	);
}

// ---------------------------------------------------------------------------
// Phone: the 6 am reports view
// ---------------------------------------------------------------------------

function ReportList({ roles, tz, nav }: { roles: UiRoleOverview[]; tz: string; nav: Nav }) {
	const t = useT();
	if (roles.length === 0) return <p className="rv-empty rv-meta">{t("rolesNoReports")}</p>;
	return (
		<div className="rv-rows rv-reports">
			{roles.map((r) => (
				<ReportCard key={r.id} role={r} tz={tz} nav={nav} />
			))}
		</div>
	);
}

function ReportCard({ role, tz, nav }: { role: UiRoleOverview; tz: string; nav: Nav }) {
	const t = useT();
	const [full, setFull] = useState(false);
	const reason = reportReason(t, role.report, tz);
	return (
		<article className="rv-role rv-r6" data-role-id={role.id}>
			<div className="rv-rmain">
				<span className="rv-r1">
					<h3 className="rv-name">{role.id}</h3>
					{!reason && (
						<span className="rv-stg rv-meta">{t("rolesReportShort", { day: reportDay(role.report, tz) })}</span>
					)}
				</span>
				{reason ? (
					<p className="rv-repnone">
						<FiInfo className="rv-ic" aria-hidden="true" />
						{reason}
					</p>
				) : (
					<>
						<ReportText report={role.report} clamp={!full} />
						<div className="rv-acts">
							<button type="button" className="rv-act" aria-expanded={full} onClick={() => setFull((v) => !v)}>
								{full ? t("rolesShowLess") : t("rolesShowFullReport")}
							</button>
							<ReportInChat report={role.report} nav={nav} />
						</div>
					</>
				)}
			</div>
		</article>
	);
}

// ---------------------------------------------------------------------------
// Desktop: the board
// ---------------------------------------------------------------------------

function DeskTask({ task, role, nav }: { task: UiRoleTask; role: UiRoleOverview; nav: Nav }) {
	const t = useT();
	const look = taskLook(task);
	const target = taskTarget(task, role);
	const hold = look === "hold";
	const inner = (
		<>
			<Ic kind={TASK_ICON[look]} />
			<span className="rv-num">#{task.id}</span>
			<span className="rv-ttl rv-cl1">{task.title}</span>
			<span className={hold ? "rv-stw full" : "rv-stw rv-cl1"}>{taskWord(t, task)}</span>
		</>
	);
	const cls = `rv-dtask ${look}${hold ? " rv-wrap" : ""}`;
	return target ? (
		<ChatLink nav={nav} target={target} className={cls}>
			{inner}
		</ChatLink>
	) : (
		<div className={cls}>{inner}</div>
	);
}

const BoardRow = memo(function BoardRow({
	role,
	open,
	onToggle,
	now,
	tz,
	nav,
}: {
	role: UiRoleOverview;
	open: boolean;
	onToggle: (id: string) => void;
	now: number;
	tz: string;
	nav: Nav;
}) {
	const t = useT();
	const needs = role.status === "needs-you";
	const expId = `rv-x-${role.id}`;
	const line = nowLineOf(role, now);
	const queue = role.queue;
	const lead = leadTask(queue);
	const reason = reportReason(t, role.report, tz);
	const gl = goalsLine(t, role, true);
	const questions = role.asks.filter((a) => a.kind === "question");

	let nowCell: ReactNode;
	if (hasProblem(role, "tldr") && role.tldr.length === 0 && role.asks.length === 0) {
		nowCell = <span className="rv-meta">{t("rolesNotAvailable", { what: t("rolesPartTldr") })}</span>;
	} else if (open) {
		nowCell = (
			<>
				{questions.map((a) => (
					<AskLink key={a.key} ask={a} now={now} nav={nav} desk />
				))}
				{role.tldr.map((l, i) => (
					<TldrLink key={`${l.chat.file}:${l.id}`} line={l} newest={i === 0} now={now} nav={nav} desk />
				))}
				{role.tldr.length === 0 && questions.length === 0 && (
					<span className="rv-dline rv-plain">
						<NowContent line={line} now={now} wide />
					</span>
				)}
			</>
		);
	} else if (line.kind === "ask") {
		nowCell = (
			<ChatLink nav={nav} target={askTarget(line.ask)} className="rv-dline needs rv-wrap">
				<NowContent line={line} now={now} wide />
			</ChatLink>
		);
	} else if (line.kind === "line") {
		nowCell = (
			<ChatLink nav={nav} target={lineTarget(line.line)} className={lineClass("rv-dline rv-wrap", line.line, true)}>
				<NowContent line={line} now={now} wide />
			</ChatLink>
		);
	} else {
		nowCell = (
			<span className="rv-dline rv-plain rv-wrap">
				<NowContent line={line} now={now} wide />
			</span>
		);
	}

	let queueCell: ReactNode;
	if (hasProblem(role, "queue")) {
		queueCell = <span className="rv-meta">{t("rolesNotAvailable", { what: t("rolesPartQueue") })}</span>;
	} else if (!queue) {
		queueCell = <span className="rv-meta rv-dcount">{t("rolesNoQueue")}</span>;
	} else {
		const tasks = open ? queue.active : lead ? [lead] : [];
		const counts = queueCounts(t, queue, !open && !!lead, true);
		queueCell = (
			<>
				{tasks.map((task) => (
					<DeskTask key={task.id} task={task} role={role} nav={nav} />
				))}
				{open && queue.queued.length > 0 && <QueuedList queue={queue} />}
				<span className="rv-dcount">
					{tasks.length === 0
						? `${queueStopped(queue) ? t("rolesQueueStopped") : t("rolesNoActiveTask")} · ${counts}`
						: open
							? `${t("rolesActive", { n: queue.counts.active })} · ${counts}`
							: counts}
				</span>
			</>
		);
	}

	const day = reportDay(role.report, tz);
	const reportCell = reason ? (
		<span className="rv-meta">{reason}</span>
	) : (
		<span className="rv-rg rv-cl2">
			<span className="rv-rh">{t("rolesReportShort", { day })}</span> {reportGoal(role.report)}
		</span>
	);

	return (
		<div className="rv-brow-wrap" data-role-id={role.id}>
			<div className={needs ? "rv-brow needs" : "rv-brow"}>
				<div className="rv-bc">
					<div className="rv-bn">
						<h3 className="rv-bh">
							{role.homeChat ? (
								<ChatLink
									nav={nav}
									target={{ file: role.homeChat.file }}
									className="rv-bname"
									label={t("rolesHomeChatOf", { role: role.id })}
								>
									{role.id}
								</ChatLink>
							) : (
								<span className="rv-bname">{role.id}</span>
							)}
						</h3>
						<button
							type="button"
							className="rv-dabout"
							aria-label={t("rolesAboutRulesOf", { role: role.id })}
							data-tip={t("rolesAboutRules")}
							onClick={() => nav.about(role.id)}
						>
							<FiSettings className="rv-ic" aria-hidden="true" />
						</button>
					</div>
					<div className="rv-dcnt">
						<StatusWord status={role.status} />
						{role.lastActivity ? <span className="rv-meta">{agoOf(role.lastActivity, now)}</span> : null}
					</div>
					{gl && <span className="rv-gl">{gl}</span>}
					{role.goals.length > 0 && <Goals role={role} full={open} />}
					{open && role.conflict && (
						<p className="rv-note rv-in">
							<FiInfo className="rv-ic" aria-hidden="true" />
							{t("rolesConflict", { text: role.conflict })}
						</p>
					)}
				</div>
				<div className="rv-bc">{nowCell}</div>
				<div className="rv-bc">{queueCell}</div>
				<div className="rv-bc">{reportCell}</div>
				<div className="rv-bc rv-bxc">
					<button
						type="button"
						className="rv-bx"
						aria-expanded={open}
						aria-controls={expId}
						aria-label={open ? t("rolesCloseRow", { role: role.id }) : t("rolesOpenRow", { role: role.id })}
						onClick={() => onToggle(role.id)}
					>
						<Chevron open={open} />
					</button>
				</div>
			</div>
			{open && (
				<div className={needs ? "rv-bexp needs" : "rv-bexp"} id={expId}>
					{reason ? (
						<p className="rv-repnone">
							<FiInfo className="rv-ic" aria-hidden="true" />
							{reason}
						</p>
					) : (
						<>
							<p className="rv-bexph">{t("rolesReportHead", { day })}</p>
							{role.report.sections?.length ? (
								<dl>
									{role.report.sections.map((s) => (
										<div key={s.heading} className="rv-dlrow">
											<dt>{s.heading}</dt>
											<dd>{s.text}</dd>
										</div>
									))}
								</dl>
							) : (
								<p className="rv-rtext">{role.report.text}</p>
							)}
							{role.report.cut && <p className="rv-meta">{t("rolesReportCut")}</p>}
							<div className="rv-acts">
								<ReportInChat report={role.report} nav={nav} />
							</div>
						</>
					)}
				</div>
			)}
		</div>
	);
});
