import { useAppField } from "../app-globals";
import { useT, type Translate } from "../i18n";
import { useRoles } from "../roles-state";
import {
	projectUsefulRoles,
	type PauseMarker,
	type ReplayCount,
	type ReportedStatus,
	type SourceState,
	type StopReason,
	type UsefulRecords,
	type UsefulRole,
	type UsefulRoles,
} from "../roles-useful-model";

const SOURCE_KEYS = {
	awaiting: "ruAwaiting",
	error: "ruError",
	"cached-error": "ruCachedError",
	disconnected: "ruDisconnected",
	cached: "ruCached",
	partial: "ruPartial",
	unknown: "ruUnknownSource",
	"connected-source-unverified": "ruConnected",
} as const satisfies Record<SourceState, Parameters<Translate>[0]>;
const STATUS_KEYS = {
	ready: "ruReady",
	working: "ruWorking",
	asking: "ruAsking",
	stuck: "ruStuck",
	waiting: "ruWaiting",
	blocked: "ruBlocked",
	done: "ruDone",
} as const satisfies Record<ReportedStatus, Parameters<Translate>[0]>;
const STOP_KEYS = {
	user: "ruStopUser",
	stopped: "ruStopStopped",
	error: "ruStopError",
	restart: "ruStopRestart",
	finished: "ruStopFinished",
} as const satisfies Record<StopReason, Parameters<Translate>[0]>;
const MARKER_KEYS = {
	"reported-paused": "ruPaused",
	"not-reported": "ruNotReported",
	unknown: "ruUnknown",
} as const satisfies Record<PauseMarker, Parameters<Translate>[0]>;

/** The sole store boundary. No raw DTO reaches any of the new presentation children. */
export function RolesUsefulView({ active, phone }: { active: boolean; phone: boolean }) {
	const state = useRoles(active ? "full" : "off");
	const connection = useAppField("status");
	return <RolesUsefulContent model={projectUsefulRoles(state, connection)} phone={phone} />;
}

export function RolesUsefulContent({ model, phone }: { model: UsefulRoles; phone: boolean }) {
	const t = useT();
	return (
		<section className={`roles-useful${phone ? " roles-useful-phone" : ""}`}>
			<header>
				<h1>{t("rolesTitle")}</h1>
				<p>{t(SOURCE_KEYS[model.source])}</p>
				<p className="roles-useful-note">{t("ruQualification")}</p>
			</header>
			{model.roster === "unavailable" && <p>{t("ruRosterUnavailable")}</p>}
			{model.omitted && <p className="roles-useful-note">{t("ruRolesOmitted")}</p>}
			<div className="roles-useful-grid">
				{model.roles.map((role) => (
					<RoleCard key={role.roleId} role={role} />
				))}
			</div>
		</section>
	);
}

function replayCount(value: ReplayCount, t: Translate): string {
	return typeof value === "number"
		? String(value)
		: t(value === "not-established" ? "ruNotEstablished" : "ruUnavailable");
}
function RoleCard({ role }: { role: UsefulRole }) {
	const t = useT();
	return (
		<article className="roles-useful-card">
			<h2>{role.roleLabel}</h2>
			<p>{t("ruRoleId", { id: role.roleId })}</p>
			{role.labelTruncated && <p className="roles-useful-note">{t("ruLabelClipped")}</p>}
			{role.partial && <p className="roles-useful-note">{t("ruPartialRole")}</p>}
			<dl>
				<dt>{t("ruQueueEnabled")}</dt>
				<dd>{t(role.queueEnabled === null ? "ruUnknown" : role.queueEnabled ? "ruEnabled" : "ruStopped")}</dd>
				<dt>{t("ruStopReason")}</dt>
				<dd>{role.stopReason === null ? t("ruUnknown") : t(STOP_KEYS[role.stopReason])}</dd>
				<dt>{t("ruQueueHold")}</dt>
				<dd>{t(MARKER_KEYS[role.hold])}</dd>
				<dt>{t("ruActiveCount")}</dt>
				<dd>{replayCount(role.counts.active, t)}</dd>
				<dt>{t("ruQueuedCount")}</dt>
				<dd>{replayCount(role.counts.queued, t)}</dd>
				<dt>{t("ruDoneCount")}</dt>
				<dd>{replayCount(role.counts.done, t)}</dd>
			</dl>
			<p className="roles-useful-note">{t("ruCountsQualification")}</p>
			<RecordList heading="ruActive" list={role.active} />
			<RecordList heading="ruQueued" list={role.queued} />
		</article>
	);
}
function RecordList({ heading, list }: { heading: "ruActive" | "ruQueued"; list: UsefulRecords }) {
	const t = useT();
	return (
		<section className="roles-useful-records">
			<h3>{t(heading)}</h3>
			{!list.available ? (
				<p>{t("ruUnavailable")}</p>
			) : !list.records.length ? (
				<p>{t("ruNoDisplayed")}</p>
			) : (
				<ul>
					{list.records.map((record) => (
						<li key={record.taskId}>
							{t("ruTask", { id: record.taskId })}
							{" — "}
							{record.reportedStatus === null ? t("ruStatusUnavailable") : t(STATUS_KEYS[record.reportedStatus])}
							{"; "}
							{t("ruTaskPause")}
							{": "}
							{t(MARKER_KEYS[record.pause])}
						</li>
					))}
				</ul>
			)}
			{list.omitted && <p className="roles-useful-note">{t("ruRecordsOmitted")}</p>}
			{list.notAllShown && <p className="roles-useful-note">{t("ruNotAllShown")}</p>}
		</section>
	);
}
