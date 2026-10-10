/**
 * initiatives-page (task #84): the Initiatives tab. Per initiative, every decision in the roles' records
 * with its later changes, who decided as two facts side by side (the writing role and the approval kind),
 * credit flags in plain words, and the three things the owner needs (impact for him, other options and
 * their cost, until when), each shown or marked "not given". Each source opens in a dialog, with its chat.
 *
 * Task #85 adds the lead's Progress section above Decisions (see the marked place below).
 * Theme tokens only (dark default and White); every class is prefixed iv- and scoped to .initiatives-view.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { FiAlertTriangle, FiCheckCircle, FiExternalLink, FiFileText, FiRefreshCw, FiX } from "react-icons/fi";
import { useT, type Translate } from "../i18n";
import {
	reloadInitiatives,
	selectInitiative,
	showMoreDecisions,
	useDecisionRecord,
	useInitiatives,
} from "../initiatives-state";
import {
	addedBy,
	alsoInText,
	approvalLabel,
	changeLabel,
	count,
	entryFlags,
	filedText,
	headSource,
	perDayRows,
	roleName,
	rowCounts,
	safeLink,
	shownChanges,
	sourceLabel,
	writerLabel,
	youLabel,
} from "../initiatives-view-model";
import { clockOf } from "../roles-view-model";
import type {
	UiDecision,
	UiDecisionChange,
	UiDecisionRecordView,
	UiDecisionSource,
	UiDecisionsPage,
	UiInitiativeRow,
	UiOwnerField,
	UiReaderStatus,
} from "../types";
import type { RolesOpenTarget } from "./RolesView";
import "../initiatives-view.css";

export interface InitiativesViewProps {
	/** The tab is shown (it watches the server only then). */
	active: boolean;
	phone: boolean;
	/** Opens a chat (the Roles page's way: switch to it, at that time). */
	onOpen: (target: RolesOpenTarget) => void;
}

/** Sources shown on a card before "N more". */
const SOURCES_SHOWN = 3;

function useNow(active: boolean): number {
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		if (!active) return;
		setNow(Date.now());
		const id = window.setInterval(() => setNow(Date.now()), 60_000);
		return () => window.clearInterval(id);
	}, [active]);
	return now;
}

function When({ at, now }: { at: number; now: number }) {
	return <time dateTime={new Date(at).toISOString()}>{clockOf(at, now)}</time>;
}

export function InitiativesView({ active, phone, onOpen }: InitiativesViewProps) {
	const t = useT();
	const s = useInitiatives(active);
	const now = useNow(active);
	const [open, setOpen] = useState<UiDecisionSource | null>(null);
	const opener = useRef<HTMLElement | null>(null);
	const page = s.page;
	const names = useMemo(() => new Map((page?.initiatives ?? []).map((i) => [i.id, i.name])), [page]);

	const openSource = (src: UiDecisionSource, from: HTMLElement) => {
		opener.current = from;
		setOpen(src);
	};
	const closeSource = () => {
		setOpen(null);
		const back = opener.current;
		opener.current = null;
		if (back?.isConnected) back.focus();
	};

	return (
		<div className={`initiatives-view${phone ? " iv-phone" : ""}`}>
			<div className="iv-page">
				<header className="iv-phead">
					<h1>{t("ivTitle")}</h1>
					<p className="iv-intro">{t("ivIntro")}</p>
					{page && <ReaderLine t={t} reader={page.reader} perDay={page.perDay} now={now} />}
				</header>
				{!page && s.status !== "error" && (
					<p className="iv-note" role="status">
						{t("ivLoading")}
					</p>
				)}
				{!page && s.status === "error" && (
					<div className="iv-errbox" role="alert">
						<p>{t("ivError", { error: s.error ?? "" })}</p>
						<button type="button" className="iv-btn" onClick={reloadInitiatives}>
							<FiRefreshCw aria-hidden="true" /> {t("ivReload")}
						</button>
					</div>
				)}
				{page && s.error && s.failedAt !== undefined && (
					<p className="iv-note iv-warn" role="status">
						{t("ivStale", { time: clockOf(s.heardAt ?? s.failedAt, now), error: s.error })}
					</p>
				)}
				{page && (
					<div className="iv-layout">
						<InitiativeList t={t} page={page} />
						<Initiative t={t} page={page} names={names} now={now} onSource={openSource} />
					</div>
				)}
			</div>
			{open && <SourceDialog t={t} src={open} now={now} onClose={closeSource} onOpen={onOpen} />}
		</div>
	);
}

function ReaderLine({
	t,
	reader,
	perDay,
	now,
}: {
	t: Translate;
	reader: UiReaderStatus;
	perDay: Record<string, number>;
	now: number;
}) {
	const rows = perDayRows(reader.tokensByDay, perDay);
	return (
		<div className="iv-reader">
			<p>
				{reader.enabled
					? t("ivReaderLine", {
							unread: count(reader.unread),
							tokens: count(reader.tokensToday),
							cap: count(reader.dailyTokenCap),
						})
					: t("ivReaderOff")}
				{reader.lastRun ? <> · {t("ivReaderLast", { time: clockOf(reader.lastRun, now) })}</> : null}
			</p>
			{reader.capHit && (
				<p className="iv-warn">
					<FiAlertTriangle aria-hidden="true" /> {t("ivReaderCap")}
				</p>
			)}
			{reader.lastError && (
				<p className="iv-warn">
					<FiAlertTriangle aria-hidden="true" />{" "}
					{t("ivReaderErr", { time: clockOf(reader.lastError.at, now), error: reader.lastError.error })}
				</p>
			)}
			{rows.length > 0 && (
				<details className="iv-perday">
					<summary>{t("ivPerDay")}</summary>
					<table>
						<thead>
							<tr>
								<th scope="col">{t("ivDay")}</th>
								<th scope="col">{t("ivEntries")}</th>
								<th scope="col">{t("ivTokens")}</th>
							</tr>
						</thead>
						<tbody>
							{rows.map((r) => (
								<tr key={r.day}>
									<th scope="row">{r.day}</th>
									<td>{count(r.entries)}</td>
									<td>{count(r.tokens)}</td>
								</tr>
							))}
						</tbody>
					</table>
				</details>
			)}
		</div>
	);
}

function InitiativeList({ t, page }: { t: Translate; page: UiDecisionsPage }) {
	const rows: UiInitiativeRow[] = [...page.initiatives, page.unfiled];
	return (
		<nav className="iv-list" aria-label={t("ivListLabel")}>
			<ul>
				{rows.map((row) => {
					const current = page.selected === row.id;
					return (
						<li key={row.id || "unfiled"}>
							<button
								type="button"
								className={`iv-row${current ? " iv-current" : ""}`}
								aria-current={current ? "true" : undefined}
								onClick={() => selectInitiative(row.id)}
							>
								<span className="iv-rname">{row.id ? row.name : t("ivUnfiled")}</span>
								<span className="iv-rmeta">{rowCounts(t, row)}</span>
								{row.noImpact > 0 && <span className="iv-rmeta">{t("ivNoImpact", { n: row.noImpact })}</span>}
								{row.credit > 0 && (
									<span className="iv-rflag">
										<FiAlertTriangle aria-hidden="true" /> {t("ivCredit", { n: row.credit })}
									</span>
								)}
							</button>
						</li>
					);
				})}
			</ul>
		</nav>
	);
}

function Initiative({
	t,
	page,
	names,
	now,
	onSource,
}: {
	t: Translate;
	page: UiDecisionsPage;
	names: ReadonlyMap<string, string>;
	now: number;
	onSource: (src: UiDecisionSource, from: HTMLElement) => void;
}) {
	const row = page.selected ? page.initiatives.find((i) => i.id === page.selected) : page.unfiled;
	const name = page.selected ? (row?.name ?? page.selected) : t("ivUnfiled");
	return (
		<div className="iv-main">
			<h2 className="iv-iname">{name}</h2>
			{row?.lead && <p className="iv-lead">{t("ivLead", { role: roleName(row.lead) })}</p>}
			{/* Task #85: the lead's Progress section goes here, above Decisions. */}
			<section className="iv-decisions" aria-labelledby="iv-decisions-h">
				<h3 id="iv-decisions-h">
					{t("ivDecisions")} <span className="iv-count">({count(page.total)})</span>
				</h3>
				{page.decisions.length === 0 && <p className="iv-note">{t("ivNoDecisions")}</p>}
				<ol className="iv-cards">
					{page.decisions.map((d) => (
						<li key={d.id}>
							<DecisionCard t={t} d={d} selected={page.selected} names={names} now={now} onSource={onSource} />
						</li>
					))}
				</ol>
				{page.decisions.length < page.total && (
					<p className="iv-more">
						<span>{t("ivShowing", { n: count(page.decisions.length), total: count(page.total) })}</span>
						<button type="button" className="iv-btn" onClick={showMoreDecisions}>
							{t("ivShowMore")}
						</button>
					</p>
				)}
			</section>
		</div>
	);
}

/** The two facts side by side, and "You decided" only where his own record backs it. */
function WhoLine({ t, entry }: { t: Translate; entry: UiDecision | UiDecisionChange }) {
	const src = headSource(entry);
	if (!src) return null;
	const you = entry.you ? youLabel(t, src) : null;
	return (
		<p className="iv-who">
			<span className="iv-chip iv-writer">
				<span className="iv-sr">{t("ivWrittenBy")}: </span>
				{writerLabel(t, src)}
			</span>
			<span className="iv-chip iv-approval">
				<span className="iv-sr">{t("ivApprovedAs")}: </span>
				{approvalLabel(t, src.approval)}
			</span>
			{you && (
				<span className="iv-you">
					<FiCheckCircle aria-hidden="true" /> {you}
				</span>
			)}
		</p>
	);
}

function Flags({ t, entry }: { t: Translate; entry: UiDecision | UiDecisionChange }) {
	const flags = entryFlags(t, entry);
	if (!flags.length) return null;
	return (
		<ul className="iv-flags">
			{flags.map((f) => (
				<li key={f.flag} className={`iv-flag iv-flag-${f.flag}`}>
					<FiAlertTriangle aria-hidden="true" /> {f.text}
				</li>
			))}
		</ul>
	);
}

/** An order: his own words and the relayer's text, two labelled parts. */
function OrderParts({ t, src }: { t: Translate; src: UiDecisionSource }) {
	if (!src.order) return null;
	return (
		<div className="iv-order">
			<div className="iv-part iv-part-owner">
				<p className="iv-plabel">{t("ivYourWords")}</p>
				<p className="iv-ptext">{src.order.ownerWords || t("ivNotGiven")}</p>
			</div>
			{src.order.relayerText && (
				<div className="iv-part">
					<p className="iv-plabel">{t("ivRelayerText", { role: roleName(src.relayer ?? src.writer) })}</p>
					<p className="iv-ptext">{src.order.relayerText}</p>
				</div>
			)}
		</div>
	);
}

function Field({ t, label, field }: { t: Translate; label: string; field: UiOwnerField | undefined }) {
	return (
		<div className="iv-field">
			<dt>{label}</dt>
			<dd>
				{field ? (
					<>
						{field.text}
						{field.by !== "reader" && <span className="iv-by"> ({t("ivGivenBy", { who: addedBy(t, field.by) })})</span>}
					</>
				) : (
					<span className="iv-ng">{t("ivNotGiven")}</span>
				)}
			</dd>
		</div>
	);
}

function Sources({
	t,
	sources,
	now,
	onSource,
}: {
	t: Translate;
	sources: UiDecisionSource[];
	now: number;
	onSource: (src: UiDecisionSource, from: HTMLElement) => void;
}) {
	const sorted = [...sources].sort((a, b) => a.at - b.at);
	const item = (src: UiDecisionSource, i: number): ReactNode => {
		const label = sourceLabel(t, src);
		return (
			<li key={`${src.record ?? src.link ?? ""}-${i}`}>
				<button
					type="button"
					className="iv-src"
					aria-label={t("ivOpenSource", { label })}
					onClick={(e) => onSource(src, e.currentTarget)}
				>
					<FiFileText aria-hidden="true" /> <span className="iv-srclabel">{label}</span>
				</button>{" "}
				<span className="iv-meta">
					<When at={src.at} now={now} />
					{src.same ? ` · ${t("ivSaysAgain")}` : ""}
				</span>
			</li>
		);
	};
	return (
		<div className="iv-sources">
			<p className="iv-slabel">{t("ivSources")}</p>
			<ul>{sorted.slice(0, SOURCES_SHOWN).map(item)}</ul>
			{sorted.length > SOURCES_SHOWN && (
				<details>
					<summary>+{sorted.length - SOURCES_SHOWN}</summary>
					<ul>{sorted.slice(SOURCES_SHOWN).map((s, i) => item(s, i + SOURCES_SHOWN))}</ul>
				</details>
			)}
		</div>
	);
}

function DecisionCard({
	t,
	d,
	selected,
	names,
	now,
	onSource,
}: {
	t: Translate;
	d: UiDecision;
	selected: string | undefined;
	names: ReadonlyMap<string, string>;
	now: number;
	onSource: (src: UiDecisionSource, from: HTMLElement) => void;
}) {
	const head = headSource(d);
	const order = head?.order ? head : d.sources.find((s) => s.order);
	const changes = shownChanges(d);
	const also = alsoInText(t, d, selected, names);
	const flagged = d.flags.length > 0;
	return (
		<article className={`iv-card${flagged ? " iv-flagged" : ""}`} aria-labelledby={`iv-d-${d.id}`}>
			<h4 id={`iv-d-${d.id}`} className="iv-dtitle">
				{d.title}
			</h4>
			<p className="iv-what">
				{d.what}{" "}
				<span className="iv-meta">
					· <When at={d.at} now={now} />
				</span>
			</p>
			<WhoLine t={t} entry={d} />
			<Flags t={t} entry={d} />
			{order && <OrderParts t={t} src={order} />}
			<dl className="iv-fields">
				<Field t={t} label={t("ivImpact")} field={d.impact} />
				<Field t={t} label={t("ivOptions")} field={d.options} />
				<Field t={t} label={t("ivUntil")} field={d.until} />
			</dl>
			{changes.length > 0 && (
				<div className="iv-changes">
					<p className="iv-slabel">{t("ivChanges")}</p>
					<ol>
						{changes.map((c) => (
							<li key={c.id} className={`iv-change${c.flags.length ? " iv-flagged" : ""}`}>
								<p className="iv-chead">
									<span className="iv-type">{changeLabel(t, c.type)}</span> {c.what}{" "}
									<span className="iv-meta">
										· <When at={c.at} now={now} />
									</span>
								</p>
								<WhoLine t={t} entry={c} />
								<Flags t={t} entry={c} />
								{headSource(c)?.order && <OrderParts t={t} src={headSource(c)!} />}
								{(c.impact || c.until) && (
									<dl className="iv-fields">
										{c.impact && <Field t={t} label={t("ivImpact")} field={c.impact} />}
										{c.until && <Field t={t} label={t("ivUntil")} field={c.until} />}
									</dl>
								)}
								<Sources t={t} sources={c.sources} now={now} onSource={onSource} />
							</li>
						))}
					</ol>
				</div>
			)}
			<Sources t={t} sources={d.sources} now={now} onSource={onSource} />
			<p className="iv-foot">
				{filedText(t, d.filedBy, d.initiative)} · {t("ivAddedBy", { who: addedBy(t, d.by) })}
				{also ? ` · ${also}` : ""}
			</p>
		</article>
	);
}

function SourceDialog({
	t,
	src,
	now,
	onClose,
	onOpen,
}: {
	t: Translate;
	src: UiDecisionSource;
	now: number;
	onClose: () => void;
	onOpen: (target: RolesOpenTarget) => void;
}) {
	const ref = useRef<HTMLDialogElement>(null);
	const rec = useDecisionRecord(src.record ?? null);
	useEffect(() => {
		const d = ref.current;
		if (d && !d.open) d.showModal();
	}, []);
	const link = safeLink(src.link);
	const view = rec?.view;
	return (
		<dialog ref={ref} className="iv-dialog" aria-labelledby="iv-src-h" onClose={onClose}>
			<div className="iv-dhead">
				<h2 id="iv-src-h">
					{t("ivRecordTitle")}: {sourceLabel(t, src)}
				</h2>
				<button type="button" className="iv-x" aria-label={t("ivClose")} onClick={() => ref.current?.close()}>
					<FiX aria-hidden="true" />
				</button>
			</div>
			<p className="iv-meta">
				<When at={src.at} now={now} /> · {writerLabel(t, src)} · {approvalLabel(t, src.approval)}
			</p>
			{src.quotes.length > 0 && (
				<ul className="iv-quotes">
					{src.quotes.map((q, i) => (
						<li key={i}>
							<q>{q}</q>
						</li>
					))}
				</ul>
			)}
			{!src.record &&
				(link ? (
					<p>
						<a className="iv-a" href={link} target="_blank" rel="noreferrer">
							{t("ivRoleEntryNote", { link })} <FiExternalLink aria-hidden="true" />
						</a>
					</p>
				) : (
					<p className="iv-note">{src.link ? t("ivRoleEntryNote", { link: src.link }) : t("ivRoleEntryNoLink")}</p>
				))}
			{src.record && rec?.status === "loading" && (
				<p className="iv-note" role="status">
					{t("ivRecordLoading")}
				</p>
			)}
			{src.record && rec?.status === "error" && (
				<p className="iv-note iv-warn" role="alert">
					{t("ivRecordError", { error: rec.error ?? "" })}
				</p>
			)}
			{view && <RecordBody t={t} view={view} />}
			<div className="iv-dfoot">
				{view?.chatPath && (
					<button
						type="button"
						className="iv-btn iv-primary"
						onClick={() => {
							const file = view.chatPath!;
							ref.current?.close();
							onOpen({ file, jumpAt: view.at });
						}}
					>
						{t("ivOpenChat")}
						{view.chatTitle ? `: ${view.chatTitle}` : ""}
					</button>
				)}
				<button type="button" className="iv-btn" onClick={() => ref.current?.close()}>
					{t("ivClose")}
				</button>
			</div>
		</dialog>
	);
}

function RecordBody({ t, view }: { t: Translate; view: UiDecisionRecordView }) {
	const from = view.from === "owner" ? t("ivYou") : roleName(view.from);
	const to = view.to ? (view.to === "owner" ? t("ivYou") : roleName(view.to)) : undefined;
	const plan = view.plan;
	const planFields: [string, string | undefined][] = plan
		? [
				[t("ivPlanGoal"), plan.goal],
				[t("ivPlanDecided"), plan.decided],
				[t("ivPlanDoneWhen"), plan.doneWhen],
				[t("ivPlanSteps"), plan.steps],
				[t("ivPlanMustNot"), plan.mustNot],
				[t("ivPlanVerify"), plan.verify],
			]
		: [];
	return (
		<div className="iv-record">
			<p className="iv-meta">
				{to ? t("ivFromTo", { from, to }) : t("ivFrom", { from })}
				{view.kind ? ` · ${view.kind}` : ""}
				{view.task !== undefined ? ` · ${t("ivTask", { n: view.task })}` : ""}
				{view.via ? ` · ${t("ivVia", { role: roleName(view.via) })}` : ""}
			</p>
			{(view.title || plan?.title) && <p className="iv-rtitle">{view.title ?? plan?.title}</p>}
			{view.ownerWords !== undefined && (
				<div className="iv-order">
					<div className="iv-part iv-part-owner">
						<p className="iv-plabel">{t("ivYourWords")}</p>
						<p className="iv-ptext">{view.ownerWords}</p>
					</div>
					{view.text && (
						<div className="iv-part">
							<p className="iv-plabel">{t("ivRelayerText", { role: roleName(view.via ?? view.from) })}</p>
							<p className="iv-ptext">{view.text}</p>
						</div>
					)}
				</div>
			)}
			{view.ownerWords === undefined && view.text && <p className="iv-ptext">{view.text}</p>}
			{view.summary && <p className="iv-ptext">{view.summary}</p>}
			{planFields
				.filter(([, v]) => v && v.trim())
				.map(([k, v]) => (
					<div key={k} className="iv-pfield">
						<p className="iv-plabel">{k}</p>
						<p className="iv-ptext">{v}</p>
					</div>
				))}
			{view.questions?.map((q) => (
				<div key={q.id} className="iv-q">
					<p className="iv-qtext">{q.question}</p>
					{q.detail && <p className="iv-ptext">{q.detail}</p>}
					<ul>
						{q.options.map((o) => {
							const picked = q.picked.includes(o.label);
							return (
								<li key={o.label} className={picked ? "iv-picked" : undefined}>
									<span className="iv-olabel">{o.label}</span>
									{picked && (
										<span className="iv-you">
											<FiCheckCircle aria-hidden="true" /> {t("ivPicked")}
										</span>
									)}
									{o.description && <p className="iv-ptext">{o.description}</p>}
									{o.preview && <pre className="iv-preview">{o.preview}</pre>}
								</li>
							);
						})}
					</ul>
					{q.typed && <p className="iv-ptext">{t("ivTyped", { text: q.typed })}</p>}
				</div>
			))}
		</div>
	);
}
