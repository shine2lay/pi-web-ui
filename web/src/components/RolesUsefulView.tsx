import { useCallback, useEffect, useState } from "react";
import { useAppField } from "../app-globals";
import { useT, type Translate } from "../i18n";
import { projectRolePanel } from "../roles-panel-model";
import { useRoles } from "../roles-state";
import {
	projectUsefulRoles,
	type NeedsYou,
	type NeedsYouItem,
	type PauseMarker,
	type ReplayCount,
	type RowState,
	type SourceState,
	type StopReason,
	type TellState,
	type UsefulOpenTarget,
	type UsefulRecord,
	type UsefulRecords,
	type UsefulRole,
	type UsefulRoles,
} from "../roles-useful-model";
import { RolePanelDialog } from "./RolePanel";

type Key = Parameters<Translate>[0];
/** Opens an existing chat (App's openFromRoles: switch_session + maybe one item). */
export type OpenChat = (target: UsefulOpenTarget) => void;
/** roles-panel: opens a role's panel; `from` gets the focus back when it closes by itself. */
export type OpenDetails = (roleId: string, from: HTMLElement) => void;

const SOURCE_KEYS = {
	awaiting: "ruAwaiting",
	error: "ruError",
	"cached-error": "ruCachedError",
	disconnected: "ruDisconnected",
	cached: "ruCached",
	stale: "ruStale",
	partial: "ruPartial",
	unknown: "ruUnknownSource",
	"connected-source-unverified": "ruConnected",
} as const satisfies Record<SourceState, Key>;
const TELL_KEYS = {
	"not-live": "ruWhyNotLive",
	"feed-error": "ruWhyError",
	awaiting: "ruWhyAwaiting",
	partial: "ruWhyPartial",
	decision: "ruWhyDecision",
	unknown: "ruWhyUnknown",
} as const satisfies Record<Exclude<TellState, "can-tell">, Key>;
const ROW_KEYS = {
	ready: "ruRowReady",
	"ready-after": "ruRowWaitsOn",
	working: "ruRowWorking",
	"asking-ops": "ruRowAskingOps",
	"asking-lead": "ruRowAskingLead",
	"asking-main": "ruRowAskingMain",
	asking: "ruRowAsking",
	"needs-decision": "ruRowNeedsDecision",
	"on-hold": "ruRowOnHold",
	blocked: "ruRowBlocked",
	done: "ruRowDone",
	unknown: "ruRowUnknown",
} as const satisfies Record<RowState, Key>;
const STOP_KEYS = {
	user: "ruStopUser",
	stopped: "ruStopStopped",
	error: "ruStopError",
	restart: "ruStopRestart",
	finished: "ruStopFinished",
} as const satisfies Record<StopReason, Key>;
const PAUSE_KEYS = {
	"reported-paused": "ruTaskPaused",
	unknown: "ruPauseUnclear",
} as const satisfies Record<Exclude<PauseMarker, "not-reported">, Key>;

/** Re-render now and then while shown: ages, and a feed that went quiet turns "stale". */
function useNow(active: boolean): number {
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		if (!active) return;
		setNow(Date.now());
		const id = setInterval(() => setNow(Date.now()), 30_000);
		return () => clearInterval(id);
	}, [active]);
	return now;
}

/** The sole store boundary. No raw DTO reaches any of the presentation children (the role panel too gets
 *  only its closed projection). */
export function RolesUsefulView({
	active,
	phone,
	onOpen,
	onAbout,
}: {
	active: boolean;
	phone: boolean;
	onOpen: OpenChat;
	/** roles-panel: Settings, Identities, at this role (its About page and rules). */
	onAbout: (roleId: string) => void;
}) {
	const state = useRoles(active ? "full" : "off");
	const connection = useAppField("status");
	const now = useNow(active);
	const [open, setOpen] = useState<{ id: string; from: HTMLElement } | null>(null);
	const onDetails = useCallback<OpenDetails>((id, from) => setOpen({ id, from }), []);
	const close = useCallback(
		(back: boolean) => {
			const from = open?.from;
			setOpen(null);
			if (back && from) requestAnimationFrame(() => from.focus());
		},
		[open],
	);
	// A role that left the snapshot (or a page you left) has no panel; it stays closed if the role comes back.
	const panel = active && open ? projectRolePanel(state, open.id) : null;
	const gone = open !== null && panel === null;
	useEffect(() => {
		if (gone) setOpen(null);
	}, [gone]);
	return (
		<>
			<RolesUsefulContent
				model={projectUsefulRoles(state, connection, now)}
				phone={phone}
				now={now}
				onOpen={onOpen}
				onDetails={onDetails}
			/>
			{panel && <RolePanelDialog panel={panel} now={now} onOpen={onOpen} onAbout={onAbout} onClose={close} />}
		</>
	);
}

export function RolesUsefulContent({
	model,
	phone,
	now,
	onOpen,
	onDetails,
}: {
	model: UsefulRoles;
	phone: boolean;
	now: number;
	onOpen: OpenChat;
	onDetails?: OpenDetails;
}) {
	const t = useT();
	return (
		<section className={`roles-useful${phone ? " roles-useful-phone" : ""}`} tabIndex={0} aria-label={t("rolesTitle")}>
			<header>
				<h1>{t("rolesTitle")}</h1>
				<p>{t(SOURCE_KEYS[model.source])}</p>
			</header>
			<NeedsYouSection needs={model.needsYou} now={now} onOpen={onOpen} />
			<p className="roles-useful-note">{t("ruQualification")}</p>
			{model.roster === "unavailable" && <p>{t("ruRosterUnavailable")}</p>}
			{model.omitted && <p className="roles-useful-note">{t("ruRolesOmitted")}</p>}
			{model.lastReceived && <p className="roles-useful-stale">{t("ruLastReceived")}</p>}
			<div className="roles-useful-grid">
				{model.roles.map((role) => (
					<RoleCard key={role.roleId} role={role} onOpen={onOpen} onDetails={onDetails} />
				))}
			</div>
		</section>
	);
}

function pad2(n: number): string {
	return String(n).padStart(2, "0");
}
/** "14:05" today, else "Oct 3, 14:05" (this browser's clock). */
function clockText(ms: number, now: number): string {
	const d = new Date(ms);
	const hm = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
	if (d.toDateString() === new Date(now).toDateString()) return hm;
	return `${d.toLocaleDateString(undefined, { month: "short", day: "numeric" })}, ${hm}`;
}
function ageText(since: number, now: number, t: Translate): string {
	const min = Math.floor(Math.max(0, now - since) / 60_000);
	if (min < 1) return t("ruAgeUnderMinute");
	if (min < 60) return t("ruAgeMinutes", { n: min });
	const h = Math.floor(min / 60);
	return h < 48 ? t("ruAgeHours", { n: h }) : t("ruAgeDays", { n: Math.floor(h / 24) });
}

/** "None reported" only while the list is the current one and the feed lists no ask at all. */
function NeedsYouSection({ needs, now, onOpen }: { needs: NeedsYou; now: number; onOpen: OpenChat }) {
	const t = useT();
	const total = needs.total;
	return (
		<section
			className={`roles-useful-needs${total ? " roles-useful-needs-some" : ""}`}
			aria-labelledby="roles-useful-needs-title"
		>
			{/* No count of 0 while the page can't tell (Security R2): a zero there would be a zero on error. */}
			<h2 id="roles-useful-needs-title">
				{total > 0 || needs.tell === "can-tell" ? t("ruNeedsYou", { n: total }) : t("ruNeedsYouTitle")}
			</h2>
			{needs.tell === "can-tell" ? (
				!total &&
				needs.asOf !== null && (
					<p className="roles-useful-clear">{t("ruAllClear", { time: clockText(needs.asOf, now) })}</p>
				)
			) : (
				<p className="roles-useful-cant">
					{t("ruCantTell")} {t(TELL_KEYS[needs.tell])}
				</p>
			)}
			{needs.items.length > 0 && (
				<ol className="roles-useful-asks">
					{needs.items.map((item) => (
						<AskRow key={item.key} item={item} now={now} onOpen={onOpen} />
					))}
				</ol>
			)}
			{needs.more > 0 && <p className="roles-useful-note">{t("ruMoreNotShown", { n: needs.more })}</p>}
			<p className="roles-useful-note">{t("ruNeedsYouCovers")}</p>
		</section>
	);
}

function AskRow({ item, now, onOpen }: { item: NeedsYouItem; now: number; onOpen: OpenChat }) {
	const t = useT();
	const link = item.link;
	const role = item.roleLabel ?? t("ruUnknownRole");
	return (
		<li className="roles-useful-ask">
			<div className="roles-useful-body">
				<p className="roles-useful-ask-text">
					{item.text === null ? t("ruOpenItem") : <q className="roles-useful-agent">{item.text}</q>}
				</p>
				<p className="roles-useful-meta">
					<span>{role}</span>
					{" · "}
					{item.since === null ? t("ruTimeUnknown") : t("ruWaiting", { age: ageText(item.since, now, t) })}
				</p>
			</div>
			{link && (
				<button type="button" className="roles-useful-open" onClick={() => onOpen(link)}>
					{t("ruOpen")}
					<span className="roles-useful-sr">
						{" "}
						{t("ruFrom")} {role}
					</span>
				</button>
			)}
		</li>
	);
}

function countText(value: ReplayCount, t: Translate): string {
	return typeof value === "number" ? String(value) : t("ruCouldntRead");
}
function queueText(role: UsefulRole, t: Translate): string {
	if (role.counts.done === "no-queue") return t("ruNoQueue");
	if (role.queueEnabled === true) return t("ruQueueRunning");
	if (role.queueEnabled === null) return t("ruQueueUnknown");
	return role.stopReason === null
		? t("ruQueueStopped")
		: t("ruQueueStoppedWhy", { why: t(STOP_KEYS[role.stopReason]) });
}
function RoleCard({ role, onOpen, onDetails }: { role: UsefulRole; onOpen: OpenChat; onDetails?: OpenDetails }) {
	const t = useT();
	const noQueue = role.counts.done === "no-queue";
	return (
		<article className="roles-useful-card">
			<div className="roles-useful-card-head">
				<h2>{role.roleLabel}</h2>
				{onDetails && (
					<button
						type="button"
						className="roles-useful-open roles-useful-details"
						onClick={(e) => onDetails(role.roleId, e.currentTarget)}
					>
						{t("rpDetails")}
						<span className="roles-useful-sr">
							{" "}
							{t("rpOfRole")} {role.roleLabel}
						</span>
					</button>
				)}
			</div>
			{role.labelTruncated && <p className="roles-useful-note">{t("ruLabelClipped")}</p>}
			{role.partial && <p className="roles-useful-note">{t("ruPartialRole")}</p>}
			<p className="roles-useful-queue">
				{queueText(role, t)}
				{role.hold !== "not-reported" &&
					` · ${t(role.hold === "reported-paused" ? "ruQueuePaused" : "ruQueuePauseUnclear")}`}
				{/* Agent pause records relay the owner's words; the app can't show that he acted. */}
			</p>
			{!noQueue && (
				<>
					<RecordList
						heading={t("ruStarted", { n: countText(role.counts.active, t) })}
						list={role.active}
						count={role.counts.active}
						onOpen={onOpen}
					/>
					<RecordList
						heading={t("ruWaitingToStart", { n: countText(role.counts.queued, t) })}
						list={role.queued}
						count={role.counts.queued}
						onOpen={onOpen}
					/>
					<p className="roles-useful-note">{t("ruDoneCount", { n: countText(role.counts.done, t) })}</p>
				</>
			)}
		</article>
	);
}
function RecordList({
	heading,
	list,
	count,
	onOpen,
}: {
	heading: string;
	list: UsefulRecords;
	count: ReplayCount;
	onOpen: OpenChat;
}) {
	const t = useT();
	return (
		<section className="roles-useful-records">
			<h3>{heading}</h3>
			{/* An empty list says nothing more: zero reads like any other count (no "none" wording). */}
			{!list.available ? (
				<p>{t("ruCouldntRead")}</p>
			) : (
				list.records.length > 0 && (
					<ul className="roles-useful-tasks">
						{list.records.map((record) => (
							<TaskRow key={record.taskId} record={record} onOpen={onOpen} />
						))}
					</ul>
				)
			)}
			{list.omitted && <p className="roles-useful-note">{t("ruRecordsOmitted")}</p>}
			{list.notAllShown && (
				<p className="roles-useful-note">
					{typeof count === "number" && count > list.records.length
						? t("ruShownOf", { shown: list.records.length, total: count })
						: t("ruNotAllShown")}
				</p>
			)}
		</section>
	);
}

/** Status words come from closed fields only. Agent text (name, blocker, latest line) is a quoted
 *  text node of its own, never an i18n variable or attribute. */
function TaskRow({ record, onOpen }: { record: UsefulRecord; onOpen: OpenChat }) {
	const t = useT();
	const link = record.link;
	const waitsInline = record.state !== "ready-after" && record.waitsOn !== null;
	return (
		<li className="roles-useful-task">
			<div className="roles-useful-body">
				<p className="roles-useful-task-name">
					{record.name === null ? (
						t("ruTask", { id: record.taskId })
					) : (
						<>
							<span>{t("ruTaskNumber", { id: record.taskId })}</span>{" "}
							<q className="roles-useful-agent">{record.name}</q>
						</>
					)}
				</p>
				<p className="roles-useful-task-state">
					<span className="roles-useful-status">
						{record.askLead === null ? t(ROW_KEYS[record.state]) : t("ruRowAskingLead", { lead: record.askLead })}
					</span>
					{record.state === "ready-after" &&
						(record.waitsOn === null ? (
							<span> {t("ruOtherTasks")}</span>
						) : (
							<>
								{" "}
								<q className="roles-useful-agent">{record.waitsOn}</q>
							</>
						))}
					{waitsInline && (
						<>
							{" · "}
							<span className="roles-useful-status">{t("ruWaitsOn")}</span>{" "}
							<q className="roles-useful-agent">{record.waitsOn}</q>
						</>
					)}
					{record.busy && record.state !== "working" && (
						<>
							{" · "}
							<span className="roles-useful-status">{t("ruRowWorking")}</span>
						</>
					)}
					{record.pause !== "not-reported" && (
						<>
							{" · "}
							<span className="roles-useful-status">{t(PAUSE_KEYS[record.pause])}</span>
						</>
					)}
				</p>
				{record.latest !== null && (
					<p className="roles-useful-meta">
						<span>{t("ruLatest")}</span> <q className="roles-useful-agent">{record.latest}</q>
					</p>
				)}
			</div>
			{link && (
				<button type="button" className="roles-useful-open" onClick={() => onOpen(link)}>
					{t(link.focus?.kind === "task" ? "ruOpenQueue" : "ruOpenChat")}
					<span className="roles-useful-sr"> {t("ruForTask", { id: record.taskId })}</span>
				</button>
			)}
		</li>
	);
}
