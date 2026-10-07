/**
 * roles-overview: the Roles page, a top bar view beside Chat, Terminal and Git.
 *
 * One look at every role: what it is doing (its status and newest line), what waits on the owner (the
 * "Waiting on you" strip, oldest first), its queue and its 6 am report. It only shows and opens: every
 * target opens an existing chat (at the item: `?chat=<file>&focus=...`), Settings -> Identities at the
 * role, or a part of the page in place. Nothing here starts, stops or answers anything.
 *
 * Layout (owner, 2026-10-05: "show less, tap for more"): every role is a tile in a grid, coloured by its
 * status, with its newest line and a few words on its queue. Tapping a tile opens that role's details
 * (every TL;DR line, the queue, its goals and the start of its 6 am report) in a side panel, full screen
 * on the phone. Tiles sit in two groups, alphabetical, so a role is always in the same place. A "Now | 6 am
 * reports" switch shows every report's start at once. A click on a report (its card, or its part of the
 * panel) opens the whole report in a big window, at least 80% of the screen (owner, 2026-10-05), its
 * Markdown drawn like a chat message's.
 *
 * board (task #76): a third view, "Board", shows the roles' shared board: news and the owner's orders,
 * who got each order directly, who has read each post and who has done each order (with its note). It
 * is the one place on this page that changes something: the owner posts and closes posts there.
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
	type FormEvent,
	type MouseEvent,
	type ReactNode,
} from "react";
import {
	FiCheckCircle,
	FiChevronDown,
	FiChevronRight,
	FiCircle,
	FiInfo,
	FiMaximize2,
	FiMessageSquare,
	FiPlus,
	FiSettings,
	FiX,
} from "react-icons/fi";
import { useAppField } from "../app-globals";
import { parseFocus, type ChatFocusKind } from "../chat-focus";
import { useT, type Translate } from "../i18n";
import { boardRequest, reloadRoles, useRoles } from "../roles-state";
import { Markdown } from "./Markdown";
import {
	ageOf,
	agoOf,
	askWhere,
	BOARD_CLOSE_NOTE_MAX,
	BOARD_ROLES_SHOWN,
	BOARD_TEXT_MAX,
	BOARD_TITLE_MAX,
	boardClosedText,
	boardCounts,
	boardFromText,
	boardMarks,
	boardOpenCount,
	boardPostedText,
	boardSplit,
	boardToText,
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
	queuePausedText,
	queueStopped,
	readStripOpen,
	reportDay,
	reportLead,
	reportReason,
	reportRoles,
	rolesSummary,
	saveStripOpen,
	STALE_MS,
	taskLook,
	taskWord,
	whereTag,
	type BoardRoleMark,
	type NowLine,
	type RolesLayout,
	type TaskLook,
} from "../roles-view-model";
import type {
	UiBoard,
	UiBoardPost,
	UiBoardPostKind,
	UiRoleAsk,
	UiRoleOverview,
	UiRoleReport,
	UiRoleStatus,
	UiRoleTask,
	UiRoleTldrLine,
} from "../types";
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
	paused: "paused",
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

export const RolesView = memo(function RolesView({ active, phone, focusRole, onOpen, onAbout }: RolesViewProps) {
	const t = useT();
	const roles = useRoles(active ? "full" : "off");
	const conn = useAppField("status");
	const now = useNow(active);
	const layout: RolesLayout = phone ? "phone" : "desktop";
	// Whether the strip is open is remembered per layout (phone / desktop). Switching layout reads the
	// other layout's memory while rendering, so no frame shows one layout's fold on the other.
	const [fold, setFold] = useState(() => ({ layout, open: readStripOpen(layout) }));
	let stripOpen = fold.open;
	if (fold.layout !== layout) {
		stripOpen = readStripOpen(layout);
		setFold({ layout, open: stripOpen });
	}
	const toggleStrip = useCallback(() => {
		setFold((prev) => {
			saveStripOpen(prev.layout, !prev.open);
			return { ...prev, open: !prev.open };
		});
	}, []);
	// board (task #76): "Board" is the third view, beside Now and the 6 am reports.
	const [mode, setMode] = useState<"now" | "reports" | "board">("now");
	const nav = useMemo<Nav>(() => ({ open: onOpen, about: onAbout }), [onOpen, onAbout]);
	// board: a post to scroll to in the Board view (a role panel's open order); seq grows with each.
	const [boardFocus, setBoardFocus] = useState<{ id: string; seq: number } | null>(null);

	const pageRef = useRef<HTMLElement>(null);
	const stripRef = useRef<HTMLDivElement>(null);
	const headRef = useRef<HTMLHeadingElement>(null);
	const o = roles.overview;

	// The role whose details are open (one at a time).
	const [shown, setShown] = useState<string | null>(null);
	const shownRef = useRef<string | null>(null);
	shownRef.current = shown;
	const showDetails = useCallback((id: string) => setShown(id), []);
	const closeDetails = useCallback((back: boolean) => {
		const id = shownRef.current;
		setShown(null);
		if (!back || !id) return;
		// Back to the tile it was opened from.
		requestAnimationFrame(() =>
			pageRef.current?.querySelector<HTMLElement>(`[data-role-id="${CSS.escape(id)}"] .rv-tbtn`)?.focus(),
		);
	}, []);
	const detailsRole = shown && o ? o.roles.find((r) => r.id === shown) : undefined;
	// board: an open order in a role's panel opens the Board view at that post.
	const showPost = useCallback((id: string) => {
		setShown(null);
		setMode("board");
		setBoardFocus((prev) => ({ id, seq: (prev?.seq ?? 0) + 1 }));
	}, []);
	// Leaving the page, or the role going away, closes its details.
	useEffect(() => {
		if (shown && (!active || (o && !detailsRole))) setShown(null);
	}, [active, o, shown, detailsRole]);

	// The role whose 6 am report is open in the big window (over its details, when opened from there).
	const [reading, setReading] = useState<string | null>(null);
	const readFrom = useRef<HTMLElement | null>(null);
	const showReport = useCallback((id: string, from: HTMLElement) => {
		readFrom.current = from;
		setReading(id);
	}, []);
	const closeReport = useCallback((back: boolean) => {
		const from = readFrom.current;
		readFrom.current = null;
		setReading(null);
		// Back to the button it was opened with (a card, or the panel, which stays open).
		if (back && from) requestAnimationFrame(() => from.focus());
	}, []);
	const readingRole = reading && o ? o.roles.find((r) => r.id === reading) : undefined;
	useEffect(() => {
		if (reading && (!active || (o && readingRole?.report.state !== "report"))) setReading(null);
	}, [active, o, reading, readingRole]);
	// "Report in chat" in the window closes it and the details first: the chat shows instead.
	const readNav = useMemo<Nav>(
		() => ({
			open: (target) => {
				readFrom.current = null;
				setReading(null);
				setShown(null);
				onOpen(target);
			},
			about: (id) => {
				readFrom.current = null;
				setReading(null);
				setShown(null);
				onAbout(id);
			},
		}),
		[onOpen, onAbout],
	);

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
		setMode("now");
		setShown(null);
		setReading(null);
		requestAnimationFrame(() => {
			const row = pageRef.current?.querySelector(`[data-role-id="${CSS.escape(focusRole.id)}"]`);
			if (!(row instanceof HTMLElement)) return;
			row.scrollIntoView?.({ block: "start" });
			row.querySelector<HTMLElement>("a, button")?.focus({ preventScroll: true });
		});
	}, [active, o, focusRole]);

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
	const roleIds = useMemo(() => (o?.roles ?? []).map((r) => r.id).sort(), [o]);

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
					{o && (
						<div className="rv-switch" role="group" aria-label={t("rolesShow")}>
							<button type="button" aria-pressed={mode === "now"} onClick={() => setMode("now")}>
								{t("rolesViewNow")}
							</button>
							<button type="button" aria-pressed={mode === "reports"} onClick={() => setMode("reports")}>
								{t("rolesViewReports", { n: reportList.filter((r) => r.report.state === "report").length })}
							</button>
							{o.board && (
								<button type="button" aria-pressed={mode === "board"} onClick={() => setMode("board")}>
									{t("rolesViewBoard", { n: boardOpenCount(o.board) })}
								</button>
							)}
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

				{loading && <Skeleton />}

				{o && (
					<>
						<div className="rv-strip" ref={stripRef}>
							<Strip asks={o.asks} open={stripOpen} onToggle={toggleStrip} phone={phone} now={now} nav={nav} />
						</div>
						{o.roles.length === 0 ? (
							<p className="rv-empty rv-meta">{t("rolesNoRoles")}</p>
						) : mode === "board" ? (
							o.board ? (
								<BoardView board={o.board} roleIds={roleIds} now={now} focus={boardFocus} />
							) : (
								<p className="rv-empty rv-meta">{t("boardUnavailable")}</p>
							)
						) : mode === "reports" ? (
							<ReportList roles={reportList} tz={tz} nav={nav} onRead={showReport} />
						) : (
							<>
								<TileGroup
									first
									title={t("rolesGroupSelf", { n: groups.selfStart.length })}
									roles={groups.selfStart}
									now={now}
									onShow={showDetails}
								/>
								<TileGroup
									title={t("rolesGroupRequest", { n: groups.onRequest.length })}
									roles={groups.onRequest}
									now={now}
									onShow={showDetails}
								/>
							</>
						)}
					</>
				)}
			</div>
			{/* Distinct keys: with one key for both (the role's id), React lost the panel when both closed
			    at once and it stayed open, invisible, over a hidden page (found by roles-page). */}
			{active && detailsRole && (
				<RoleDetails
					key={`details:${detailsRole.id}`}
					role={detailsRole}
					now={now}
					tz={tz}
					nav={nav}
					onClose={closeDetails}
					onRead={showReport}
					onPost={o?.board ? showPost : undefined}
				/>
			)}
			{active && readingRole?.report.state === "report" && (
				<ReportWindow key={`report:${readingRole.id}`} role={readingRole} tz={tz} nav={readNav} onClose={closeReport} />
			)}
		</section>
	);
});

function Skeleton() {
	return (
		<div className="rv-skeleton" aria-hidden="true">
			<span className="rv-skel rv-skel-strip" />
			<span className="rv-skel rv-skel-h" />
			<div className="rv-skel-tiles">
				{Array.from({ length: 8 }, (_, i) => (
					<span key={i} className="rv-skel rv-skel-tile" />
				))}
			</div>
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
// Tiles
// ---------------------------------------------------------------------------

function TileGroup({
	title,
	roles,
	first,
	now,
	onShow,
}: {
	title: string;
	roles: UiRoleOverview[];
	first?: boolean;
	now: number;
	onShow: (id: string) => void;
}) {
	return (
		<>
			<h2 className={first ? "rv-grp first" : "rv-grp"}>{title}</h2>
			{roles.length > 0 && (
				<ul className="rv-tiles">
					{roles.map((r) => (
						<Tile key={r.id} role={r} now={now} onShow={onShow} />
					))}
				</ul>
			)}
		</>
	);
}

/** A tile's one line: the newest ask, else TL;DR line, else the open request (nowLineOf), as plain text. */
function tileText(t: Translate, line: NowLine): { text: string; dim: boolean } {
	switch (line.kind) {
		case "ask":
			return { text: line.ask.text, dim: false };
		case "line":
			return { text: line.line.text, dim: false };
		case "request":
			return { text: t("rolesAsked", { from: line.from, text: line.text }), dim: true };
		case "waiting":
			return { text: t("rolesWaitingRequests"), dim: true };
		default:
			return { text: t("rolesNothingYet"), dim: true };
	}
}

/** When the tile's line is from ("07:12"; an ask also where: "Task #3 · 2h"), else the role's last activity.
 *  Which chat a line came from is in the panel. */
function tileWhen(t: Translate, line: NowLine, role: UiRoleOverview, now: number): string {
	if (line.kind === "ask") {
		return `${askWhere(t, line.ask)}${line.ask.since !== undefined ? ` · ${ageOf(line.ask.since, now)}` : ""}`;
	}
	if (line.kind === "line") {
		const when = clockOf(line.line.ts, now);
		return line.line.answered ? `${when} · ${t("rolesAnswered")}` : when;
	}
	return role.lastActivity ? agoOf(role.lastActivity, now) : "";
}

/** The tile's queue in a few words: "#20 Working ·" and "2 queued" (the counts stay on one line).
 *  A hold is named in a word; what it waits on is in the panel. */
function tileQueue(t: Translate, role: UiRoleOverview): { head: string; counts: string } | null {
	if (hasProblem(role, "queue")) return { head: t("rolesNotAvailable", { what: t("rolesPartQueue") }), counts: "" };
	const queue = role.queue;
	if (!queueHasWork(queue)) return null;
	const lead = leadTask(queue);
	// queue-paused: the owner's pause on the whole queue says more than any one task's state.
	const head = queue?.hold
		? t("rolesQueuePausedByYou")
		: lead
			? `#${lead.id} ${taskWord(t, lead, true)}`
			: queueStopped(queue)
				? t("rolesQueueStopped")
				: t("rolesNoActiveTask");
	const counts = queueCounts(t, queue, !!lead, false);
	return counts ? { head: `${head} ·`, counts } : { head, counts: "" };
}

const Tile = memo(function Tile({
	role,
	now,
	onShow,
}: {
	role: UiRoleOverview;
	now: number;
	onShow: (id: string) => void;
}) {
	const t = useT();
	const quiet = isQuiet(role, now);
	const line = nowLineOf(role, now);
	const body = tileText(t, line);
	const when = tileWhen(t, line, role, now);
	const queue = tileQueue(t, role);
	return (
		<li className={`rv-tile ${role.status}${quiet ? " quiet" : ""}`} data-role-id={role.id}>
			<button type="button" className="rv-tbtn" aria-haspopup="dialog" onClick={() => onShow(role.id)}>
				<span className="rv-thead">
					<span className="rv-tname">{role.id}</span>
					<StatusWord status={role.status} />
				</span>
				<span className={body.dim || quiet ? "rv-ttext rv-dim" : "rv-ttext"}>{body.text}</span>
				{/* one item, so every tile keeps one footer line: the queue when it has work, else when */}
				{(queue || when) && (
					<span className="rv-tfoot">
						{queue ? (
							<span className="rv-tq">
								{queue.head}
								{queue.counts && (
									<>
										{" "}
										<span className="rv-tqc">{queue.counts}</span>
									</>
								)}
							</span>
						) : (
							<span className="rv-twhen">{when}</span>
						)}
					</span>
				)}
			</button>
		</li>
	);
});

// ---------------------------------------------------------------------------
// One role's details: a side panel (full screen on the phone)
// ---------------------------------------------------------------------------

function RoleDetails({
	role,
	now,
	tz,
	nav,
	onClose,
	onRead,
	onPost,
}: {
	role: UiRoleOverview;
	now: number;
	tz: string;
	nav: Nav;
	/** `back`: focus goes back to the role's tile (not when a target in the panel opened something). */
	onClose: (back: boolean) => void;
	/** Open the role's 6 am report in the big window (over the panel, which stays open). */
	onRead: (id: string, from: HTMLElement) => void;
	/** board: open the Board view at this post (absent: no board). */
	onPost?: (id: string) => void;
}) {
	const t = useT();
	const ref = useRef<HTMLDialogElement>(null);
	const closeRef = useRef<HTMLButtonElement>(null);
	const [allLines, setAllLines] = useState(false);
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
	// A target in the panel closes it first: the chat or Settings shows instead.
	const inner = useMemo<Nav>(
		() => ({
			open: (target) => {
				onClose(false);
				nav.open(target);
			},
			about: (id) => {
				onClose(false);
				nav.about(id);
			},
		}),
		[nav, onClose],
	);
	const gl = goalsLine(t, role);
	const questions = role.asks.filter((a) => a.kind === "question");
	const lines = role.tldr;
	const shownLines = allLines ? lines : lines.slice(0, CARD_LINES_SHOWN);
	const moreLines = lines.length - shownLines.length;
	const queue = role.queue;
	const reason = reportReason(t, role.report, tz);
	return (
		<dialog
			ref={ref}
			className="rv-drawer"
			aria-labelledby="rv-d-title"
			onCancel={(e) => {
				e.preventDefault();
				onClose(true);
			}}
			onClick={(e) => {
				// A click on the dimmed page beside the panel (the dialog itself, outside its content).
				if (e.target === e.currentTarget) onClose(true);
			}}
		>
			<div className="rv-dwrap">
				<header className="rv-dhead">
					<div className="rv-dh1">
						<h2 id="rv-d-title" className="rv-dname">
							{role.id}
						</h2>
						<button
							ref={closeRef}
							type="button"
							className="rv-dclose"
							aria-label={t("close")}
							onClick={() => onClose(true)}
						>
							<FiX className="rv-ic" aria-hidden="true" />
						</button>
					</div>
					<div className="rv-dstat">
						<StatusWord status={role.status} />
						{role.lastActivity ? <span className="rv-meta">{agoOf(role.lastActivity, now)}</span> : null}
						{gl && <span className="rv-meta">{gl}</span>}
					</div>
					<div className="rv-acts">
						{role.homeChat ? (
							<ChatLink nav={inner} target={{ file: role.homeChat.file }} className="rv-act">
								<FiMessageSquare className="rv-ic" aria-hidden="true" />
								{t("rolesOpenChatOf", { role: role.id })}
							</ChatLink>
						) : (
							<span className="rv-meta rv-pad">{t("rolesNoHomeChat")}</span>
						)}
						<button type="button" className="rv-act" onClick={() => inner.about(role.id)}>
							<FiSettings className="rv-ic" aria-hidden="true" />
							{t("rolesAboutRules")}
						</button>
					</div>
				</header>
				<div className="rv-dbody">
					{role.conflict && (
						<p className="rv-note rv-in">
							<FiInfo className="rv-ic" aria-hidden="true" />
							{t("rolesConflict", { text: role.conflict })}
						</p>
					)}
					<section className="rv-sec">
						<h3 className="rv-sech">{t("rolesTldrHeading")}</h3>
						{questions.map((a) => (
							<AskLink key={a.key} ask={a} now={now} nav={inner} />
						))}
						{hasProblem(role, "tldr") && (
							<p className="rv-meta">{t("rolesNotAvailable", { what: t("rolesPartTldr") })}</p>
						)}
						{lines.length === 0 && !hasProblem(role, "tldr") && questions.length === 0 && (
							<p className="rv-meta rv-pad">{t("rolesNoTldr")}</p>
						)}
						{shownLines.map((l, i) => (
							<TldrLink key={`${l.chat.file}:${l.id}`} line={l} newest={i === 0} now={now} nav={inner} />
						))}
						{lines.length > CARD_LINES_SHOWN && (
							<button type="button" className="rv-more" aria-expanded={allLines} onClick={() => setAllLines((v) => !v)}>
								{allLines ? t("rolesFewerLines") : t("rolesMoreLines", { n: moreLines })}
							</button>
						)}
					</section>
					<section className="rv-sec">
						<h3 className="rv-sech">{t("rolesQueueHeading")}</h3>
						{hasProblem(role, "queue") ? (
							<p className="rv-meta rv-pad">{t("rolesNotAvailable", { what: t("rolesPartQueue") })}</p>
						) : !queue ? (
							<p className="rv-meta rv-pad">{t("rolesNoQueue")}</p>
						) : (
							<>
								<p className="rv-meta">
									{[
										t("rolesActive", { n: queue.counts.active }),
										t("rolesQueued", { n: queue.counts.queued }),
										t("rolesDone", { n: queue.counts.done }),
										...(queueStopped(queue) ? [t("rolesQueueStopped")] : []),
										// queue-paused: the owner paused the whole queue.
										...(queue.hold ? [queuePausedText(t, queue, Date.now())] : []),
									].join(" · ")}
								</p>
								{queue.active.map((task) => (
									<TaskLink key={task.id} task={task} role={role} nav={inner} />
								))}
								{queue.active.length === 0 && <p className="rv-meta rv-pad">{t("rolesNoActiveTask")}</p>}
								{queue.queued.length > 0 && <QueuedList queue={queue} />}
							</>
						)}
					</section>
					{onPost && role.boardOrders && role.boardOrders.length > 0 && (
						// board: the open orders this role hasn't marked done.
						<section className="rv-sec">
							<h3 className="rv-sech">{t("boardRoleOrders", { n: role.boardOrders.length })}</h3>
							{role.boardOrders.map((order) => (
								<button key={order.id} type="button" className="rv-line rv-bord" onClick={() => onPost(order.id)}>
									<span className="rv-lt">{`${clockOf(order.at, now)} · ${boardFromText(t, order)}`}</span>{" "}
									<span className="rv-tx">{order.title}</span>
								</button>
							))}
						</section>
					)}
					{role.goals.length > 0 && (
						<section className="rv-sec">
							<Goals role={role} />
						</section>
					)}
					<section className="rv-sec rv-dreport">
						<h3 className="rv-sech">
							{reason ? t("rolesColReport") : t("rolesReportHead", { day: reportDay(role.report, tz) })}
						</h3>
						{reason ? (
							<p className="rv-repnone">
								<FiInfo className="rv-ic" aria-hidden="true" />
								{reason}
							</p>
						) : (
							<ReportStart role={role} nav={inner} onRead={onRead} />
						)}
					</section>
				</div>
			</div>
		</dialog>
	);
}

function lineClass(base: string, line: UiRoleTldrLine, newest: boolean): string {
	let cls = base;
	if (line.needsYou && !line.answered) cls += " needs";
	else if (line.answered) cls += " answered";
	else if (newest) cls += " newest";
	return cls;
}

/** A TL;DR line that opens its chat at the line. */
function TldrLink({ line, newest, now, nav }: { line: UiRoleTldrLine; newest: boolean; now: number; nav: Nav }) {
	const t = useT();
	const needs = !!line.needsYou && !line.answered;
	return (
		<ChatLink nav={nav} target={lineTarget(line)} className={lineClass("rv-line", line, newest)}>
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
			<span className="rv-tx">{line.text}</span>
		</ChatLink>
	);
}

/** An ask that isn't a TL;DR line (a question waiting in a chat), as a needs line. */
function AskLink({ ask, now, nav }: { ask: UiRoleAsk; now: number; nav: Nav }) {
	const t = useT();
	return (
		<ChatLink nav={nav} target={askTarget(ask)} className="rv-line needs">
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

function Goals({ role }: { role: UiRoleOverview }) {
	const t = useT();
	const [all, setAll] = useState(false);
	if (role.goals.length === 0) return null;
	const shown = all ? role.goals : role.goals.slice(0, GOALS_SHOWN);
	const more = role.goals.length - shown.length;
	return (
		<div className="rv-goals">
			<h3 className="rv-sech">{t("rolesGoalsHeading")}</h3>
			<ul>
				{shown.map((g) => (
					<li key={g.name}>
						<span>
							<b>{g.name}</b>
							<span className="rv-meta"> · {goalRest(t, g)}</span>
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

function TaskLink({ task, role, nav }: { task: UiRoleTask; role: UiRoleOverview; nav: Nav }) {
	const t = useT();
	const look = taskLook(task);
	const target = taskTarget(task, role);
	const inner = (
		<>
			<span className="rv-num">#{task.id}</span>
			<span className="rv-tb">
				<span className="rv-tt1">{task.title}</span>
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

type OnRead = (id: string, from: HTMLElement) => void;

/** The start of a role's report and its buttons. A click anywhere on the box around it (a report card,
 *  the panel's report part) opens the whole report in the big window: the button's hit area is
 *  stretched over that box in CSS, and "Report in chat" stays a target of its own above it. */
function ReportStart({ role, nav, onRead }: { role: UiRoleOverview; nav: Nav; onRead: OnRead }) {
	const t = useT();
	const lead = reportLead(role.report);
	return (
		<div className="rv-rstart">
			{lead && <p className="rv-rlead">{lead}</p>}
			<div className="rv-acts">
				<button
					type="button"
					className="rv-act rv-rread"
					aria-haspopup="dialog"
					onClick={(e) => onRead(role.id, e.currentTarget)}
				>
					<FiMaximize2 className="rv-ic" aria-hidden="true" />
					{t("rolesShowFullReport")}
				</button>
				<ReportInChat report={role.report} nav={nav} />
			</div>
		</div>
	);
}

/** A role's whole 6 am report in a big window: at least 80% of the screen, all of it on a phone (owner,
 *  2026-10-05). Each part under its heading, its Markdown drawn as in a chat message, the parts side by
 *  side when the window is wide enough. Esc, the close button or a click beside the window closes it. */
function ReportWindow({
	role,
	tz,
	nav,
	onClose,
}: {
	role: UiRoleOverview;
	tz: string;
	nav: Nav;
	/** `back`: focus goes back to the button that opened it. */
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
	const report = role.report;
	return (
		<dialog
			ref={ref}
			className="rv-rwin"
			aria-labelledby="rv-r-title"
			onCancel={(e) => {
				e.preventDefault();
				onClose(true);
			}}
			onClick={(e) => {
				// A click on the dimmed page around the window (the dialog itself, outside its content).
				if (e.target === e.currentTarget) onClose(true);
			}}
		>
			<header className="rv-rwhead">
				<h2 id="rv-r-title" className="rv-rwtitle">
					<span className="rv-rwname">{role.id}</span>
					<span className="rv-rwday">{t("rolesReportHead", { day: reportDay(report, tz) })}</span>
				</h2>
				<ReportInChat report={report} nav={nav} />
				<button
					ref={closeRef}
					type="button"
					className="rv-dclose"
					aria-label={t("close")}
					onClick={() => onClose(true)}
				>
					<FiX className="rv-ic" aria-hidden="true" />
				</button>
			</header>
			{/* A stop of its own so a keyboard can scroll a long report: a report without links has no
			    other stop inside (axe scrollable-region-focusable, found on the live reports). */}
			<div className="rv-rwbody" role="region" aria-labelledby="rv-r-title" tabIndex={0}>
				{report.sections?.length ? (
					<div className="rv-rwgrid">
						{report.sections.map((s) => (
							<section key={s.heading} className="rv-rwsec">
								<h3 className="rv-rwh">{s.heading}</h3>
								<div className="rv-md msg-text">
									<Markdown text={s.text} />
								</div>
							</section>
						))}
					</div>
				) : (
					<div className="rv-md rv-rwtext msg-text">
						<Markdown text={report.text ?? ""} />
					</div>
				)}
				{report.cut && <p className="rv-meta rv-rwcut">{t("rolesReportCut")}</p>}
			</div>
		</dialog>
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
// The 6 am reports view
// ---------------------------------------------------------------------------

function ReportList({ roles, tz, nav, onRead }: { roles: UiRoleOverview[]; tz: string; nav: Nav; onRead: OnRead }) {
	const t = useT();
	if (roles.length === 0) return <p className="rv-empty rv-meta">{t("rolesNoReports")}</p>;
	return (
		<div className="rv-reports">
			{roles.map((r) => (
				<ReportCard key={r.id} role={r} tz={tz} nav={nav} onRead={onRead} />
			))}
		</div>
	);
}

function ReportCard({ role, tz, nav, onRead }: { role: UiRoleOverview; tz: string; nav: Nav; onRead: OnRead }) {
	const t = useT();
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
					<ReportStart role={role} nav={nav} onRead={onRead} />
				)}
			</div>
		</article>
	);
}

// ---------------------------------------------------------------------------
// board (task #76): the Board view, the roles' shared board
// ---------------------------------------------------------------------------

/** The Board view: open posts, then the closed ones (folded). The owner posts and closes here; what each
 *  role did with a post (got an order directly or on the board, read it, done it) shows on its card.
 *  Exported for tests/unit/roles-view.test.ts (the page itself opens on Now). */
export function BoardView({
	board,
	roleIds,
	now,
	focus,
}: {
	board: UiBoard;
	roleIds: string[];
	now: number;
	/** A post to show (a role panel's open order); seq grows with each. */
	focus: { id: string; seq: number } | null;
}) {
	const t = useT();
	const ref = useRef<HTMLDivElement>(null);
	const newRef = useRef<HTMLButtonElement>(null);
	const [writing, setWriting] = useState(false);
	const [said, setSaid] = useState("");
	const [showClosed, setShowClosed] = useState(false);
	const { open, closed } = useMemo(() => boardSplit(board.posts), [board.posts]);
	// After the form closes, focus goes back to "New post".
	const refocus = useRef(false);
	useEffect(() => {
		if (writing || !refocus.current) return;
		refocus.current = false;
		newRef.current?.focus();
	}, [writing]);
	// A role panel's open order: open the closed list if it is there, then scroll to the post and focus it.
	const shownSeq = useRef(0);
	useEffect(() => {
		if (!focus || focus.seq === shownSeq.current) return;
		if (!showClosed && closed.some((p) => p.id === focus.id)) {
			setShowClosed(true);
			return;
		}
		const el = [...(ref.current?.querySelectorAll<HTMLElement>("[data-post-id]") ?? [])].find(
			(e) => e.dataset.postId === focus.id,
		);
		if (!el) return;
		shownSeq.current = focus.seq;
		el.scrollIntoView({ block: "start" });
		el.focus({ preventScroll: true });
	}, [focus, showClosed, closed]);
	const done = useCallback((text: string) => {
		refocus.current = true;
		setWriting(false);
		if (text) setSaid(text);
	}, []);
	return (
		<div className="rv-board" ref={ref}>
			<div className="rv-bbar">
				<p className="rv-meta rv-bintro">{t("boardIntro")}</p>
				{!writing && (
					<button
						ref={newRef}
						type="button"
						className="rv-act"
						onClick={() => {
							setSaid("");
							setWriting(true);
						}}
					>
						<FiPlus className="rv-ic" aria-hidden="true" />
						{t("boardNewPost")}
					</button>
				)}
			</div>
			{writing && <BoardForm roleIds={roleIds} onDone={done} />}
			<p className="rv-meta rv-bsaid" role="status">
				{said}
			</p>
			<h2 className="rv-sech">{t("boardOpenHead", { n: open.length })}</h2>
			{open.length === 0 ? (
				<p className="rv-empty rv-meta">{t("boardNoOpen")}</p>
			) : (
				<div className="rv-bposts">
					{open.map((p) => (
						<BoardPostCard key={p.id} post={p} roleIds={roleIds} now={now} />
					))}
				</div>
			)}
			{closed.length > 0 && (
				<>
					<h2 className="rv-sech rv-bclosedh">
						<button
							type="button"
							className="rv-more"
							aria-expanded={showClosed}
							onClick={() => setShowClosed((v) => !v)}
						>
							<Chevron open={showClosed} />
							{t("boardClosedHead", { n: closed.length })}
						</button>
					</h2>
					{showClosed && (
						<div className="rv-bposts">
							{closed.map((p) => (
								<BoardPostCard key={p.id} post={p} roleIds={roleIds} now={now} />
							))}
						</div>
					)}
				</>
			)}
		</div>
	);
}

/** One post: kind, title, from/via, to, time, its text (folded after about 6 lines), and per role whether
 *  it got an order directly or on the board, read it and did it (with its note). Close on open posts. */
function BoardPostCard({ post, roleIds, now }: { post: UiBoardPost; roleIds: string[]; now: number }) {
	const t = useT();
	const [closing, setClosing] = useState(false);
	const [allRoles, setAllRoles] = useState(false);
	const closeRef = useRef<HTMLButtonElement>(null);
	const marks = useMemo(() => boardMarks(post, roleIds), [post, roleIds]);
	const counts = useMemo(() => boardCounts(post, roleIds), [post, roleIds]);
	const order = post.kind === "order";
	const shown = allRoles || marks.length <= BOARD_ROLES_SHOWN ? marks : marks.slice(0, BOARD_ROLES_SHOWN);
	const titleId = `rv-bp-${post.id}`;
	const endClose = useCallback((back: boolean) => {
		setClosing(false);
		if (back) requestAnimationFrame(() => closeRef.current?.focus());
	}, []);
	return (
		<article
			className={`rv-role rv-bpost${post.closed ? " rv-bclosed" : ""}`}
			data-post-id={post.id}
			data-kind={post.kind}
			tabIndex={-1}
			aria-labelledby={titleId}
		>
			<div className="rv-rmain">
				<div className="rv-r1">
					<span className={`rv-bkind rv-bkind-${post.kind}`}>{order ? t("boardKindOrder") : t("boardKindNews")}</span>
					<h3 id={titleId} className="rv-btitle">
						{post.title}
					</h3>
				</div>
				<p className="rv-meta">
					{`${boardFromText(t, post)} · ${boardToText(t, post)} · `}
					<time dateTime={new Date(post.at).toISOString()}>{clockOf(post.at, now)}</time>
				</p>
				{post.ownerWords && <p className="rv-meta rv-bwords">{t("boardOwnerWords", { words: post.ownerWords })}</p>}
				<BoardText text={post.text} />
				<p className="rv-bsum">
					{order ? (
						<>
							{counts.of > 0 && counts.done === counts.of && (
								<FiCheckCircle className="rv-ic rv-btick" aria-hidden="true" />
							)}
							<span className="rv-bcount">{t("boardDoneCount", { n: counts.done, m: counts.of })}</span>
							<span className="rv-meta">{t("boardDirectCount", { n: counts.direct })}</span>
						</>
					) : (
						<span className="rv-bcount">{t("boardReadCount", { n: counts.read, m: counts.of })}</span>
					)}
				</p>
				{marks.length > 0 && (
					<ul className="rv-bmarks" aria-label={order ? t("boardMarksOrder") : t("boardMarksNews")}>
						{shown.map((m) => (
							<BoardMark key={m.role} mark={m} order={order} now={now} />
						))}
					</ul>
				)}
				{marks.length > BOARD_ROLES_SHOWN && (
					<button type="button" className="rv-more" aria-expanded={allRoles} onClick={() => setAllRoles((v) => !v)}>
						<Chevron open={allRoles} />
						{allRoles ? t("boardFewerRoles") : t("boardAllRoles", { n: marks.length })}
					</button>
				)}
				{post.closed ? (
					<p className="rv-meta rv-bend">{boardClosedText(t, post, now)}</p>
				) : closing ? (
					<BoardCloseForm post={post} onDone={endClose} />
				) : (
					<div className="rv-acts">
						<button
							ref={closeRef}
							type="button"
							className="rv-act"
							aria-describedby={titleId}
							onClick={() => setClosing(true)}
						>
							<FiX className="rv-ic" aria-hidden="true" />
							{t("boardClose")}
						</button>
					</div>
				)}
			</div>
		</article>
	);
}

/** One role on a post: for an order, a tick when it is done (with its note), and whether it got the order
 *  directly (into a running turn, or a turn in its home chat) or on the board; for news, whether it read it. */
function BoardMark({ mark, order, now }: { mark: BoardRoleMark; order: boolean; now: number }) {
	const t = useT();
	const got = mark.sent
		? mark.sent.how === "steer"
			? t("boardGotSteer", { time: clockOf(mark.sent.at, now) })
			: t("boardGotTurn", { time: clockOf(mark.sent.at, now) })
		: mark.read !== undefined
			? t("boardGotBoardRead", { time: clockOf(mark.read, now) })
			: t("boardGotBoardUnread");
	const read = mark.read !== undefined ? t("boardMarkRead", { time: clockOf(mark.read, now) }) : t("boardMarkNotRead");
	return (
		<li className={`rv-bmark${mark.done ? " done" : ""}`} data-role={mark.role}>
			{order ? (
				mark.done ? (
					<FiCheckCircle className="rv-ic rv-btick" aria-hidden="true" />
				) : (
					<FiCircle className="rv-ic rv-dim" aria-hidden="true" />
				)
			) : null}
			<span className="rv-bwho">
				<span className="rv-brole">{mark.role}</span>{" "}
				{order ? (
					<>
						<span className="rv-bstate">
							{mark.done ? t("boardMarkDone", { time: clockOf(mark.done.at, now) }) : t("boardMarkNotDone")}
						</span>{" "}
						<span className="rv-meta">{`· ${got}`}</span>
					</>
				) : (
					<span className="rv-meta">{read}</span>
				)}
			</span>
			{mark.done?.note && <span className="rv-bnote">{mark.done.note}</span>}
		</li>
	);
}

/** A post's text, its Markdown drawn as in a chat message, folded after about 6 lines. */
function BoardText({ text }: { text: string }) {
	const t = useT();
	const ref = useRef<HTMLDivElement>(null);
	const [open, setOpen] = useState(false);
	const [long, setLong] = useState(false);
	useLayoutEffect(() => {
		const el = ref.current;
		if (!el || open) return;
		setLong(el.scrollHeight > el.clientHeight + 2);
	}, [text, open]);
	return (
		<>
			<div ref={ref} className={`rv-md msg-text rv-btext${open ? "" : " rv-bfold"}${long && !open ? " rv-bfade" : ""}`}>
				<Markdown text={text} />
			</div>
			{(long || open) && (
				<button type="button" className="rv-more" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
					<Chevron open={open} />
					{open ? t("boardShowLess") : t("boardShowAll")}
				</button>
			)}
		</>
	);
}

/** The owner's new post: kind, to (all roles or picked ones), title and text. */
function BoardForm({ roleIds, onDone }: { roleIds: string[]; onDone: (said: string) => void }) {
	const t = useT();
	const [kind, setKind] = useState<UiBoardPostKind>("news");
	const [toAll, setToAll] = useState(true);
	const [picked, setPicked] = useState<string[]>([]);
	const [title, setTitle] = useState("");
	const [text, setText] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const firstRef = useRef<HTMLInputElement>(null);
	useEffect(() => {
		firstRef.current?.focus();
	}, []);
	const submit = async (e: FormEvent) => {
		e.preventDefault();
		if (busy) return;
		if (!toAll && picked.length === 0) {
			setError(t("boardFormPickRoles"));
			return;
		}
		if (!title.trim() || !text.trim()) {
			setError(t("boardFormNeedText"));
			return;
		}
		setBusy(true);
		setError("");
		const res = await boardRequest({
			type: "board_post",
			kind,
			to: toAll ? "all" : [...picked].sort(),
			title: title.trim(),
			text: text.trim(),
		});
		setBusy(false);
		if (!res.ok) {
			setError(t("boardFormFailed", { error: res.error ?? "" }));
			return;
		}
		onDone(boardPostedText(t, kind, res));
	};
	return (
		<form className="rv-role rv-bform" onSubmit={submit} aria-labelledby="rv-bform-h">
			<h2 id="rv-bform-h" className="rv-sech">
				{t("boardNewPost")}
			</h2>
			<fieldset className="rv-bfs">
				<legend className="rv-blabel">{t("boardFormKind")}</legend>
				<div className="rv-bopts">
					<label className="rv-bopt">
						<input
							ref={firstRef}
							type="radio"
							name="rv-bkind"
							value="news"
							checked={kind === "news"}
							onChange={() => setKind("news")}
						/>
						{t("boardKindNews")}
					</label>
					<label className="rv-bopt">
						<input
							type="radio"
							name="rv-bkind"
							value="order"
							checked={kind === "order"}
							onChange={() => setKind("order")}
						/>
						{t("boardKindOrder")}
					</label>
				</div>
				<p className="rv-meta">{kind === "order" ? t("boardFormOrderHint") : t("boardFormNewsHint")}</p>
			</fieldset>
			<fieldset className="rv-bfs">
				<legend className="rv-blabel">{t("boardFormTo")}</legend>
				<div className="rv-bopts">
					<label className="rv-bopt">
						<input type="radio" name="rv-bto" checked={toAll} onChange={() => setToAll(true)} />
						{t("boardFormToAll")}
					</label>
					<label className="rv-bopt">
						<input type="radio" name="rv-bto" checked={!toAll} onChange={() => setToAll(false)} />
						{t("boardFormToSome")}
					</label>
				</div>
				{!toAll && (
					<div className="rv-bopts rv-broles">
						{roleIds.map((id) => (
							<label key={id} className="rv-bopt">
								<input
									type="checkbox"
									value={id}
									checked={picked.includes(id)}
									onChange={(e) => {
										const on = e.currentTarget.checked;
										setPicked((p) => (on ? [...p, id] : p.filter((x) => x !== id)));
									}}
								/>
								{id}
							</label>
						))}
					</div>
				)}
			</fieldset>
			<label className="rv-bfield">
				<span className="rv-blabel">{t("boardFormTitle")}</span>
				<input
					type="text"
					name="title"
					value={title}
					maxLength={BOARD_TITLE_MAX}
					required
					onChange={(e) => setTitle(e.target.value)}
				/>
			</label>
			<label className="rv-bfield">
				<span className="rv-blabel">{t("boardFormText")}</span>
				<textarea
					name="text"
					value={text}
					maxLength={BOARD_TEXT_MAX}
					rows={6}
					required
					onChange={(e) => setText(e.target.value)}
				/>
				<span className="rv-meta">{t("boardFormCount", { n: text.length, max: BOARD_TEXT_MAX })}</span>
			</label>
			{error && (
				<p className="rv-berr" role="alert">
					{error}
				</p>
			)}
			<div className="rv-acts">
				<button type="submit" className="rv-act rv-bprimary" disabled={busy}>
					{busy ? t("boardFormPosting") : t("boardFormPost")}
				</button>
				<button type="button" className="rv-act" disabled={busy} onClick={() => onDone("")}>
					{t("boardFormCancel")}
				</button>
			</div>
		</form>
	);
}

/** Closing a post: an optional note ("pause lifted"), then Close post. */
function BoardCloseForm({ post, onDone }: { post: UiBoardPost; onDone: (back: boolean) => void }) {
	const t = useT();
	const [note, setNote] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const ref = useRef<HTMLInputElement>(null);
	useEffect(() => {
		ref.current?.focus();
	}, []);
	const submit = async (e: FormEvent) => {
		e.preventDefault();
		if (busy) return;
		setBusy(true);
		setError("");
		const res = await boardRequest({ type: "board_close", id: post.id, ...(note.trim() ? { note: note.trim() } : {}) });
		setBusy(false);
		if (!res.ok) {
			setError(t("boardCloseFailed", { error: res.error ?? "" }));
			return;
		}
		onDone(false);
	};
	return (
		<form className="rv-bclose" onSubmit={submit}>
			<label className="rv-bfield">
				<span className="rv-blabel">{t("boardCloseNote")}</span>
				<input
					ref={ref}
					type="text"
					name="note"
					value={note}
					maxLength={BOARD_CLOSE_NOTE_MAX}
					placeholder={t("boardCloseNoteHint")}
					onChange={(e) => setNote(e.target.value)}
				/>
			</label>
			{error && (
				<p className="rv-berr" role="alert">
					{error}
				</p>
			)}
			<div className="rv-acts">
				<button type="submit" className="rv-act rv-bprimary" disabled={busy}>
					{t("boardCloseConfirm")}
				</button>
				<button type="button" className="rv-act" disabled={busy} onClick={() => onDone(true)}>
					{t("boardFormCancel")}
				</button>
			</div>
		</form>
	);
}
