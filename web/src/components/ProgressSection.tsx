/**
 * progress-feed (task #85): the Initiatives tab's Progress section, its lead picker and the list badges.
 *
 * One running progress feed per initiative, written by its lead (only the owner names one, here) from the
 * roles' own records: what changed, what's next, what needs him, and the three things he needs on a decision
 * (impact for him, other options and their cost, until when; "not given" when missing). Each update's
 * sources are one click away, and the decisions it links carry their writer and approval labels. A sentence
 * that says more than its sources is flagged in plain words; only a newer update from the lead clears it.
 * With no lead: the roles' own updates, unsummarized, under "No lead yet". Classes iv-*, theme tokens only.
 */
import { useEffect, useId, useState } from "react";
import { FiAlertTriangle, FiCheckCircle, FiFileText, FiSend } from "react-icons/fi";
import type { Translate } from "../i18n";
import {
	askForUpdate,
	feedAction,
	markInitiativeSeen,
	requestUpdateLinks,
	setInitiativeLead,
	updateLinksState,
} from "../initiatives-state";
import {
	approvalLabel,
	checkLine,
	count,
	flagKindText,
	leadSetText,
	roleName,
	sourceLabel,
	unlinkedText,
	writerLabel,
} from "../initiatives-view-model";
import { agoOf, clockOf } from "../roles-view-model";
import type {
	UiDecisionSource,
	UiFeedRow,
	UiProgress,
	UiProgressUpdate,
	UiUpdateDecision,
	UiUpdateFields,
	UiUpdateLink,
} from "../types";

/** Linked decisions and sources shown on an update before "Show all". */
const DECISIONS_SHOWN = 5;
const LINKS_SHOWN = 6;

type OnSource = (src: UiDecisionSource, from: HTMLElement) => void;

/** The list row's feed badges: lead, last update's age, Needs-you count, "new since you looked". */
export function FeedBadges({
	t,
	lead,
	feed,
	now,
}: {
	t: Translate;
	lead: string | null;
	feed: UiFeedRow | undefined;
	now: number;
}) {
	return (
		<>
			<span className="iv-rmeta">{lead ? t("ivLead", { role: roleName(lead) }) : t("ivLeadNone")}</span>
			{feed?.on && (
				<span className="iv-rmeta iv-rfeed">
					{feed.lastUpdateAt ? t("ivLastUpdate", { age: agoOf(feed.lastUpdateAt, now) }) : t("ivNoUpdateYet")}
					{feed.needsYou > 0 && (
						<span className="iv-badge iv-badge-needs">{t("ivNeedsYouCount", { n: feed.needsYou })}</span>
					)}
					{feed.newSinceSeen && (
						<span className="iv-dot" title={t("ivNewSinceLooked")}>
							<span className="iv-sr">{t("ivNewSinceLooked")}</span>
						</span>
					)}
				</span>
			)}
		</>
	);
}

/** "Lead: Architecture · Set by you, Oct 9", and the owner's picker. */
export function LeadPicker({ t, progress }: { t: Translate; progress: UiProgress }) {
	const id = useId();
	const current = progress.lead ?? "";
	const [want, setWant] = useState(current);
	useEffect(() => setWant(current), [current]);
	const action = feedAction("lead", progress.initiative);
	const sending = action?.status === "sending";
	const set = leadSetText(t, progress.leadSet);
	return (
		<div className="iv-leadbox">
			<p className="iv-lead">
				{progress.lead ? t("ivLead", { role: progress.leadName ?? roleName(progress.lead) }) : t("ivLeadNone")}
				{progress.lead && set ? <span className="iv-meta"> · {set}</span> : null}
			</p>
			<form
				className="iv-leadform"
				onSubmit={(e) => {
					e.preventDefault();
					if (want !== current) setInitiativeLead(progress.initiative, want || null);
				}}
			>
				<label htmlFor={`${id}-lead`}>{t("ivLeadLabel")}</label>
				<select id={`${id}-lead`} value={want} onChange={(e) => setWant(e.target.value)} disabled={sending}>
					<option value="">{t("ivLeadNone")}</option>
					{progress.roles.map((r) => (
						<option key={r.id} value={r.id}>
							{r.name}
						</option>
					))}
				</select>
				<button type="submit" className="iv-btn" disabled={sending || want === current}>
					{sending ? t("ivLeadSaving") : t("ivLeadSave")}
				</button>
			</form>
			{action?.status === "error" && (
				<p className="iv-warn" role="alert">
					<FiAlertTriangle aria-hidden="true" /> {t("ivLeadError", { error: action.error ?? "" })}
				</p>
			)}
		</div>
	);
}

/** The Progress section of one initiative, above its Decisions. */
export function ProgressSection({
	t,
	progress,
	active,
	now,
	onSource,
}: {
	t: Translate;
	progress: UiProgress;
	active: boolean;
	now: number;
	onSource: OnSource;
}) {
	const latest = progress.updates[0]?.at ?? 0;
	// He looked: the list's "new since you looked" dot clears.
	useEffect(() => {
		if (active && progress.on && latest) markInitiativeSeen(progress.initiative);
	}, [active, progress.on, progress.initiative, latest]);
	if (!progress.on) {
		return (
			<section className="iv-progress iv-off" aria-labelledby="iv-progress-h">
				<h3 id="iv-progress-h">{t("ivProgressOff")}</h3>
				<p className="iv-note">{t("ivProgressOffNote")}</p>
			</section>
		);
	}
	const ask = feedAction("poke", progress.initiative);
	const leadName = progress.leadName ?? (progress.lead ? roleName(progress.lead) : "");
	const unlinked = unlinkedText(t, progress.unlinked);
	return (
		<section className="iv-progress" aria-labelledby="iv-progress-h">
			<h3 id="iv-progress-h">{t("ivProgress")}</h3>
			<div className="iv-pstatus">
				{progress.asked ? (
					<p className="iv-asked" role="status">
						{progress.asked.delivered
							? t("ivAsked", { lead: leadName, time: clockOf(progress.asked.at, now) })
							: t("ivAskedQueued", { lead: leadName, time: clockOf(progress.asked.at, now) })}
					</p>
				) : (
					progress.lead && (
						<button
							type="button"
							className="iv-btn iv-primary"
							disabled={ask?.status === "sending"}
							onClick={() => askForUpdate(progress.initiative)}
						>
							<FiSend aria-hidden="true" /> {ask?.status === "sending" ? t("ivAsking") : t("ivAsk")}
						</button>
					)
				)}
				{ask?.status === "error" && (
					<p className="iv-warn" role="alert">
						<FiAlertTriangle aria-hidden="true" /> {t("ivAskError", { error: ask.error ?? "" })}
					</p>
				)}
				<p className={unlinked ? "iv-unlinked" : "iv-meta"}>{unlinked ?? t("ivAllLinked")}</p>
				{progress.missing > 0 && <p className="iv-meta">{t("ivMissingFields", { n: count(progress.missing) })}</p>}
				{progress.catchUp && (
					<p className="iv-meta">
						{progress.catchUp.done
							? t("ivCatchUpDone", { from: progress.catchUp.from })
							: progress.catchUp.stalled
								? t("ivCatchUpStalled", { from: progress.catchUp.from })
								: t("ivCatchUpGoing", { from: progress.catchUp.from })}
					</p>
				)}
			</div>
			{!progress.lead && <NoLead t={t} progress={progress} now={now} onSource={onSource} />}
			{progress.lead && progress.updates.length === 0 && (
				<p className="iv-note">{t("ivNoUpdates", { lead: leadName })}</p>
			)}
			{progress.updates.length > 0 && (
				<ol className="iv-updates">
					{progress.updates.map((u) => (
						<li key={u.id}>
							<UpdateCard t={t} u={u} now={now} onSource={onSource} />
						</li>
					))}
				</ol>
			)}
			{progress.updates.length < progress.updatesTotal && (
				<p className="iv-meta">
					{t("ivNewestUpdates", { n: count(progress.updates.length), total: count(progress.updatesTotal) })}
				</p>
			)}
		</section>
	);
}

function NoLead({
	t,
	progress,
	now,
	onSource,
}: {
	t: Translate;
	progress: UiProgress;
	now: number;
	onSource: OnSource;
}) {
	const list = progress.roleUpdates ?? [];
	return (
		<div className="iv-nolead">
			<h4>{t("ivNoLeadYet")}</h4>
			<p className="iv-note">{t("ivNoLeadNote")}</p>
			{list.length === 0 ? (
				<p className="iv-note">{t("ivNoRoleUpdates")}</p>
			) : (
				<ol className="iv-roleupdates">
					{list.map((r) => (
						<li key={r.id}>
							<p className="iv-meta">
								<span className="iv-chip">{r.roleName}</span> {r.kind === "tldr" ? t("ivKindTldr") : t("ivTaskDone")} ·{" "}
								<time dateTime={new Date(r.at).toISOString()}>{clockOf(r.at, now)}</time>
								{r.needsYou && <span className="iv-badge iv-badge-needs"> {t("ivNeedsYou")}</span>}
							</p>
							<p className="iv-ptext">{r.text}</p>
							<button
								type="button"
								className="iv-src"
								aria-label={t("ivOpenSource", { label: sourceLabel(t, r.source) })}
								onClick={(e) => onSource(r.source, e.currentTarget)}
							>
								<FiFileText aria-hidden="true" /> <span className="iv-srclabel">{sourceLabel(t, r.source)}</span>
							</button>
						</li>
					))}
				</ol>
			)}
		</div>
	);
}

const FIELDS: [keyof UiUpdateFields, "ivChanged" | "ivNext" | "ivNeedsYou" | "ivImpact" | "ivOptions" | "ivUntil"][] = [
	["changed", "ivChanged"],
	["next", "ivNext"],
	["needsYou", "ivNeedsYou"],
	["impact", "ivImpact"],
	["options", "ivOptions"],
	["until", "ivUntil"],
];

function UpdateCard({ t, u, now, onSource }: { t: Translate; u: UiProgressUpdate; now: number; onSource: OnSource }) {
	const check = checkLine(t, u.check);
	const flagged = u.check.sentences.filter((s) => s.flags.length);
	const [all, setAll] = useState(false);
	const more = all ? updateLinksState(u.id) : undefined;
	const decisions = more?.status === "ready" && more.decisions ? more.decisions : u.decisions;
	const links = more?.status === "ready" && more.links ? more.links : u.links;
	const hidden = !all && (u.decisionsTotal > DECISIONS_SHOWN || u.linksTotal > LINKS_SHOWN);
	const headId = `iv-u-${u.id}`;
	return (
		<article className={`iv-card iv-update${flagged.length ? " iv-flagged" : ""}`} aria-labelledby={headId}>
			<h4 id={headId} className="iv-uhead">
				<span className="iv-chip iv-writer">{u.byName}</span>{" "}
				<time dateTime={new Date(u.at).toISOString()}>{clockOf(u.at, now)}</time>
			</h4>
			<p className={check.warn ? "iv-warn iv-check" : "iv-meta iv-check"}>
				{check.warn ? <FiAlertTriangle aria-hidden="true" /> : <FiCheckCircle aria-hidden="true" />} {check.text}
			</p>
			<dl className="iv-ufields">
				{FIELDS.map(([key, label]) => {
					const text = u.fields[key]?.trim();
					return (
						<div key={key} className={`iv-field iv-f-${key}`}>
							<dt>{t(label)}</dt>
							<dd>
								{text ? (
									<span className="iv-ptext">{text}</span>
								) : (
									<span className="iv-ng">{key === "needsYou" ? t("ivNeedsYouNothing") : t("ivNotGiven")}</span>
								)}
							</dd>
						</div>
					);
				})}
			</dl>
			{flagged.length > 0 && (
				<div className="iv-uflags">
					<p className="iv-plabel">{t("ivNotInSources")}</p>
					<ul>
						{flagged.map((s, i) => (
							<li key={i} className="iv-flag">
								<FiAlertTriangle aria-hidden="true" /> <q>{s.text}</q>
								<ul>
									{s.flags.map((f, k) => (
										<li key={k}>
											{flagKindText(t, f.kind)}
											{f.claim && f.claim !== s.text ? (
												<>
													{" "}
													(<q>{f.claim}</q>)
												</>
											) : null}
											{/* A script's reason only restates the kind; the reader's says why in its own words. */}
											{f.by !== "code" && f.why ? (
												<>
													{": "}
													<span className="iv-why">{f.why}</span>
												</>
											) : null}{" "}
											<span className="iv-meta">({f.by === "code" ? t("ivFlagByCode") : t("ivFlagByReader")})</span>
										</li>
									))}
								</ul>
							</li>
						))}
					</ul>
					{u.later && <p className="iv-meta">{t("ivFlagsStay")}</p>}
				</div>
			)}
			{u.check.readerError && <p className="iv-meta">{t("ivCheckReaderError", { error: u.check.readerError })}</p>}
			{u.decisionsTotal > 0 && (
				<div className="iv-ulinked">
					<p className="iv-plabel">{t("ivLinkedDecisions", { n: count(u.decisionsTotal) })}</p>
					<ul>
						{decisions.slice(0, all ? decisions.length : DECISIONS_SHOWN).map((d) => (
							<LinkedDecision key={d.id} t={t} d={d} />
						))}
					</ul>
				</div>
			)}
			<div className="iv-sources">
				<p className="iv-slabel">{t("ivLinkedSources", { n: count(u.linksTotal) })}</p>
				<ul>
					{links.slice(0, all ? links.length : LINKS_SHOWN).map((l, i) => (
						<LinkItem key={`${l.id}-${i}`} t={t} l={l} now={now} onSource={onSource} />
					))}
				</ul>
			</div>
			{hidden && (
				<button
					type="button"
					className="iv-btn"
					onClick={() => {
						setAll(true);
						requestUpdateLinks(u.id);
					}}
				>
					{t("ivShowAllLinks")}
				</button>
			)}
			{all && more?.status === "loading" && (
				<p className="iv-note" role="status">
					{t("ivRecordLoading")}
				</p>
			)}
			{all && more?.status === "error" && (
				<p className="iv-warn" role="alert">
					{t("ivRecordError", { error: more.error ?? "" })}
				</p>
			)}
		</article>
	);
}

function LinkedDecision({ t, d }: { t: Translate; d: UiUpdateDecision }) {
	const flags = d.flags.length > 0;
	return (
		<li className={flags ? "iv-ldec iv-flagged" : "iv-ldec"}>
			<span className="iv-ldtitle">{d.title}</span>{" "}
			<span className="iv-chip iv-writer">
				<span className="iv-sr">{t("ivWrittenBy")}: </span>
				{d.writer === "owner" ? t("ivYou") : roleName(d.writer)}
			</span>{" "}
			<span className="iv-chip iv-approval">
				<span className="iv-sr">{t("ivApprovedAs")}: </span>
				{approvalLabel(t, d.approval)}
			</span>
			{d.you && (
				<span className="iv-you">
					{" "}
					<FiCheckCircle aria-hidden="true" /> {t("ivYouDecided")}
				</span>
			)}
			{flags && (
				<span className="iv-rflag">
					{" "}
					<FiAlertTriangle aria-hidden="true" /> {t("ivCreditFlag")}
				</span>
			)}
		</li>
	);
}

function LinkItem({ t, l, now, onSource }: { t: Translate; l: UiUpdateLink; now: number; onSource: OnSource }) {
	if (!l.source) {
		return (
			<li>
				<span className="iv-meta">{t("ivLinkMissing", { id: l.id })}</span>
			</li>
		);
	}
	const src = l.source;
	const label = l.kind === "record" ? sourceLabel(t, src) : `${l.title ?? l.id}`;
	return (
		<li>
			<button
				type="button"
				className="iv-src"
				aria-label={t("ivOpenSource", { label })}
				onClick={(e) => onSource(src, e.currentTarget)}
			>
				<FiFileText aria-hidden="true" /> <span className="iv-srclabel">{label}</span>
			</button>{" "}
			<span className="iv-meta">
				{writerLabel(t, src)} · <time dateTime={new Date(src.at).toISOString()}>{clockOf(src.at, now)}</time>
				{l.kind === "record" && l.title ? ` · ${l.title}` : ""}
			</span>
		</li>
	);
}
