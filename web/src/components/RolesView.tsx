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
 * (every TL;DR line, the queue, its goals and the full 6 am report) in a side panel, full screen on the
 * phone. Tiles sit in two groups, alphabetical, so a role is always in the same place. A "Now | 6 am
 * reports" switch shows every report at once.
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
import { FiCheckCircle, FiChevronDown, FiChevronRight, FiInfo, FiMessageSquare, FiSettings, FiX } from "react-icons/fi";
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
	readStripOpen,
	reportDay,
	reportReason,
	reportRoles,
	rolesSummary,
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
	const [mode, setMode] = useState<"now" | "reports">("now");
	const nav = useMemo<Nav>(() => ({ open: onOpen, about: onAbout }), [onOpen, onAbout]);

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
	// Leaving the page, or the role going away, closes its details.
	useEffect(() => {
		if (shown && (!active || (o && !detailsRole))) setShown(null);
	}, [active, o, shown, detailsRole]);

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
						) : mode === "reports" ? (
							<ReportList roles={reportList} tz={tz} nav={nav} />
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
			{active && detailsRole && (
				<RoleDetails key={detailsRole.id} role={detailsRole} now={now} tz={tz} nav={nav} onClose={closeDetails} />
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

/** Where and when the tile's line is from ("Task #3 · 2h", "07:12 · Home"), else the role's last activity. */
function tileWhen(t: Translate, line: NowLine, role: UiRoleOverview, now: number): string {
	if (line.kind === "ask") {
		return `${askWhere(t, line.ask)}${line.ask.since !== undefined ? ` · ${ageOf(line.ask.since, now)}` : ""}`;
	}
	if (line.kind === "line") {
		const when = `${clockOf(line.line.ts, now)} · ${whereTag(t, line.line.chat.where)}`;
		return line.line.answered ? `${when} · ${t("rolesAnswered")}` : when;
	}
	return role.lastActivity ? agoOf(role.lastActivity, now) : "";
}

/** The tile's queue in a few words: "#20 Working ·" and "2 queued" (the counts stay on one line). */
function tileQueue(t: Translate, role: UiRoleOverview): { head: string; counts: string } | null {
	if (hasProblem(role, "queue")) return { head: t("rolesNotAvailable", { what: t("rolesPartQueue") }), counts: "" };
	const queue = role.queue;
	if (!queueHasWork(queue)) return null;
	const lead = leadTask(queue);
	const head = lead
		? `#${lead.id} ${taskWord(t, lead)}`
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
				{(when || queue) && (
					<span className="rv-tfoot">
						{when && <span className="rv-twhen">{when}</span>}
						{queue && (
							<span className="rv-tq">
								{queue.head}
								{queue.counts && (
									<>
										{" "}
										<span className="rv-tqc">{queue.counts}</span>
									</>
								)}
							</span>
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
}: {
	role: UiRoleOverview;
	now: number;
	tz: string;
	nav: Nav;
	/** `back`: focus goes back to the role's tile (not when a target in the panel opened something). */
	onClose: (back: boolean) => void;
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
					{role.goals.length > 0 && (
						<section className="rv-sec">
							<Goals role={role} />
						</section>
					)}
					<section className="rv-sec">
						<h3 className="rv-sech">
							{reason ? t("rolesColReport") : t("rolesReportHead", { day: reportDay(role.report, tz) })}
						</h3>
						{reason ? (
							<p className="rv-repnone">
								<FiInfo className="rv-ic" aria-hidden="true" />
								{reason}
							</p>
						) : (
							<>
								{role.report.sections?.length ? (
									<dl className="rv-dl">
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
								<div className="rv-acts rv-racts">
									<ReportInChat report={role.report} nav={inner} />
								</div>
							</>
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
// The 6 am reports view
// ---------------------------------------------------------------------------

function ReportList({ roles, tz, nav }: { roles: UiRoleOverview[]; tz: string; nav: Nav }) {
	const t = useT();
	if (roles.length === 0) return <p className="rv-empty rv-meta">{t("rolesNoReports")}</p>;
	return (
		<div className="rv-reports">
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
