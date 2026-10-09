/**
 * identities: Settings -> Identities.
 *
 * Lists each identity (pi-identity, ~/.pi/agent/memory/identities/<id>/) with its home chat (a link
 * that opens it) and its notebook size against the cap, and opens about.md / notebook.md in a plain
 * text editor. Saving writes the whole file (the server writes it atomically and refuses a notebook
 * over its cap, or a file that changed after it was opened). Chats get a changed notebook before their
 * next reply (pi-identity notices it by its hash); an about page edit reaches them at their next new
 * session or compaction — the page says so. The chat's own Notebook tab (NotebookPanel.tsx) shows and
 * edits the same notebook live.
 *
 * identity-config: each row also shows the role's prompt, skills, tool limits and `unique`, and what
 * pi-identity leaves out of its identity.json; its prompt and its settings open in the same editor (the
 * server refuses settings pi-identity wouldn't read, and says why). A draft waiting for the owner
 * (role-drafts/<id>/) shows as "Draft waiting": view and edit it, then accept it (an app save into the
 * role's folder) or discard it. about-drafts: a draft can also suggest a new about page: it shows editable,
 * and "What changes" shows it line by line against the role's page now (accepting keeps the old page in the
 * role's archive/). A role's own skills live in its private folder, so the identity list
 * every window gets only counts them: this page asks for them (identity_skills_get) when it opens and
 * whenever the list changes.
 *
 * role-messages: below the list, "Role messages": the owner's switch (on / paused: held, not dropped)
 * and the last 100 messages role chats sent each other (time, from, to, kind, state, first line).
 *
 * roles-overview: each row also has "How it works": the owner's work mode and approved goals for the role
 * (identity.json workMode / goals), or the every-chat rules' default where they aren't set. "Change"
 * opens a small form over the same identity.json (owner-fields.ts): it changes only those two fields and
 * saves through the same hash-checked save, so the server's pi-identity parser decides. A draft can't
 * set them. The Roles page's "About & rules" opens this page at the role's row (focusRole).
 *
 * State: identity-state.ts (the list, the open file, the open draft, the own skills, the role
 * messages); the texts being typed live here.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { FiPlus, FiTrash2, FiUser } from "react-icons/fi";
import { appSend } from "../app-globals";
import { useT } from "../i18n";
import {
	closeIdentityDraft,
	closeIdentityFile,
	openIdentityDraft,
	openIdentityFile,
	requestIdentities,
	requestOwnSkills,
	requestRoleMessages,
	saveOpenIdentityFile,
	setRoleMessagesPaused,
	sendIdentityDraftAction,
	shortChatName,
	useIdentityDraft,
	useIdentityFile,
	useIdentityList,
	useOwnSkills,
	useRoleMessages,
	utf8Bytes,
	type IdentityDraftState,
	type IdentityFileState,
} from "../identity-state";
import type {
	ConversationSummary,
	IdentityDraftAction,
	IdentityFileName,
	IdentitySaveError,
	SessionSummary,
	UiIdentityInfo,
	UiRoleGoal,
	UiRoleMessageRow,
	UiRoleSkill,
	UiRoleWorkMode,
} from "../types";
import { diffCounts, foldDiff, lineDiff } from "../line-diff";
import {
	ownerFieldsProblems,
	ownerGoalTime,
	readOwnerFields,
	todayStamp,
	writeOwnerFields,
	OWNER_GOAL_NAME_MAX,
	OWNER_GOAL_SCOPE_MAX,
	OWNER_GOALS_MAX,
	type OwnerGoalDraft,
} from "../owner-fields";
import { HintTip } from "./HintTip";

/** role-messages: a row's state -> its word. */
const ROLE_MESSAGE_STATE_KEY: Record<
	UiRoleMessageRow["state"],
	| "roleMessageStateWaiting"
	| "roleMessageStateDelivered"
	| "roleMessageStateReplied"
	| "roleMessageStateFailed"
	| "roleMessageStateHeld"
> = {
	waiting: "roleMessageStateWaiting",
	delivered: "roleMessageStateDelivered",
	replied: "roleMessageStateReplied",
	failed: "roleMessageStateFailed",
	held: "roleMessageStateHeld",
};

/** The file a button / editor opens (identity-config: the prompt's name comes from identity.json). */
function fileLabel(file: IdentityFileName, identity?: UiIdentityInfo): string {
	if (file === "prompt") return identity?.promptFile || "prompt.md";
	if (file === "config") return "identity.json";
	return file === "about" ? "about.md" : "notebook.md";
}

/** The saved-answer codes -> their message key. */
const SAVE_ERROR_KEY: Record<
	IdentitySaveError,
	| "identitySaveOverCap"
	| "identitySaveChanged"
	| "identitySaveTooBig"
	| "identitySaveUnknown"
	| "identitySaveIo"
	| "identitySaveInvalid"
> = {
	over_cap: "identitySaveOverCap",
	changed: "identitySaveChanged",
	too_big: "identitySaveTooBig",
	unknown: "identitySaveUnknown",
	io: "identitySaveIo",
	invalid: "identitySaveInvalid",
};

/** identity-config: what a draft action said when it worked. */
const DRAFT_DONE_KEY: Record<
	IdentityDraftAction,
	"identityDraftSaved" | "identityDraftAccepted" | "identityDraftDiscarded"
> = {
	save: "identityDraftSaved",
	accept: "identityDraftAccepted",
	discard: "identityDraftDiscarded",
};

function fmt(n: number): string {
	return n.toLocaleString("en-US");
}

export function IdentitiesSettings({
	sessions,
	conversations,
	focusRole,
	onOpenChat,
}: {
	/** History + running chats: to show the home chat by its title. */
	sessions?: SessionSummary[];
	conversations?: ConversationSummary[];
	/** roles-overview: scroll to this role's row and mark it (the Roles page's "About & rules"). */
	focusRole?: { id: string; seq: number } | null;
	/** Open a chat by its session file (the home-chat link). */
	onOpenChat: (sessionPath: string) => void;
}) {
	const t = useT();
	const { identities, problems, loaded } = useIdentityList();
	const open = useIdentityFile();
	const draft = useIdentityDraft();
	const ownSkills = useOwnSkills();
	// Fresh sizes whenever the page opens; the editor closes when the page goes away. The History
	// list is loaded lazily by the left panel (not yet on a phone whose drawer stayed shut): ask for
	// it too, so the home chats show by their titles.
	const noSessions = !sessions || sessions.length === 0;
	useEffect(() => {
		requestIdentities();
		requestRoleMessages();
		if (noSessions) appSend({ type: "list_sessions" });
		return () => {
			closeIdentityFile();
			closeIdentityDraft();
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps -- once per opening
	}, []);
	// identity-config: the roles' own skills, asked again with every new list (a draft accepted, a save).
	useEffect(() => {
		if (loaded) requestOwnSkills();
	}, [identities, loaded]);

	const titleOfChat = useMemo(() => {
		const byPath = new Map<string, string>();
		for (const s of sessions ?? []) {
			const title = s.name || s.firstMessage.trim();
			if (title) byPath.set(s.path, title);
		}
		for (const c of conversations ?? []) if (c.sessionFile && c.title) byPath.set(c.sessionFile, c.title);
		return (path: string) => byPath.get(path);
	}, [sessions, conversations]);

	const waiting = identities.filter((i) => i.draft).length;

	// roles-overview: the row asked for comes into view with focus (once its row is there), marked a moment.
	const listRef = useRef<HTMLDivElement>(null);
	const [marked, setMarked] = useState<string | null>(null);
	const doneSeq = useRef(0);
	const focusId = focusRole?.id;
	const focusSeq = focusRole?.seq ?? 0;
	const hasFocusRow = loaded && identities.some((i) => i.id === focusId);
	useEffect(() => {
		if (!focusId || !hasFocusRow || focusSeq <= doneSeq.current) return;
		doneSeq.current = focusSeq;
		const row = listRef.current?.querySelector<HTMLElement>(`[data-identity="${CSS.escape(focusId)}"]`);
		if (!row) return;
		row.scrollIntoView({ block: "start" });
		row.focus({ preventScroll: true });
		setMarked(focusId);
		const timer = setTimeout(() => setMarked(null), 2_500);
		return () => clearTimeout(timer);
	}, [focusId, focusSeq, hasFocusRow]);

	return (
		<div className="set-section identities-settings">
			<div className="set-section-title">
				<FiUser className="set-section-icon" />
				{t("settingsIdentities")}
				<HintTip text={t("identitiesHint")} />
				{identities.length > 0 && <span className="set-count">{identities.length}</span>}
				{waiting > 0 && (
					<span className="identity-drafts-count" data-count={waiting}>
						{t("identityDraftWaiting")}: {waiting}
					</span>
				)}
			</div>
			<p className="set-hint">{t("identitiesRefreshNote")}</p>
			<p className="set-hint identity-role-note">{t("identitiesRoleNote")}</p>
			{problems.length > 0 && (
				<div className="set-hint identity-problems">
					{t("identitiesProblems")}
					<ul>
						{problems.map((p) => (
							<li key={p}>{p}</li>
						))}
					</ul>
				</div>
			)}
			{!loaded ? (
				<p className="set-empty">{t("loading")}</p>
			) : identities.length === 0 ? (
				<p className="set-empty">{t("identitiesEmpty")}</p>
			) : (
				<div className="identity-list" ref={listRef}>
					{identities.map((identity) => (
						<IdentityRow
							key={identity.id}
							identity={identity}
							marked={marked === identity.id}
							open={open && open.id === identity.id ? open : null}
							draft={draft && draft.id === identity.id ? draft : null}
							ownSkills={ownSkills[identity.id]}
							homeTitle={identity.homeChat ? titleOfChat(identity.homeChat) : undefined}
							onOpenChat={onOpenChat}
						/>
					))}
				</div>
			)}
			<RoleMessagesList />
		</div>
	);
}

/** role-messages: the owner's switch and the last messages between role chats (newest first). */
function RoleMessagesList() {
	const t = useT();
	const { enabled, paused, messages, loaded } = useRoleMessages();
	if (loaded && !enabled) return null;
	return (
		<div className="role-messages" data-paused={paused ? "1" : "0"}>
			<div className="set-section-title role-messages-title">
				{t("roleMessagesTitle")}
				<HintTip text={t("roleMessagesHint")} />
				{messages.length > 0 && <span className="set-count">{messages.length}</span>}
			</div>
			<div className="rolemsg-switch" role="group" aria-label={t("roleMessagesSwitch")}>
				<span>{t("roleMessagesSwitch")}:</span>
				<button
					type="button"
					className={`identity-btn rolemsg-on${!paused ? " on" : ""}`}
					aria-pressed={!paused}
					disabled={!loaded}
					onClick={() => paused && setRoleMessagesPaused(false)}
				>
					{t("roleMessagesOn")}
				</button>
				<button
					type="button"
					className={`identity-btn rolemsg-pause${paused ? " on" : ""}`}
					aria-pressed={paused}
					disabled={!loaded}
					onClick={() => !paused && setRoleMessagesPaused(true)}
				>
					{t("roleMessagesPause")}
				</button>
			</div>
			{paused && <p className="set-hint rolemsg-paused-note">{t("roleMessagesPausedNote")}</p>}
			{!loaded ? (
				<p className="set-empty">{t("loading")}</p>
			) : messages.length === 0 ? (
				<p className="set-empty">{t("roleMessagesEmpty")}</p>
			) : (
				<table className="rolemsg-list">
					<thead>
						<tr>
							<th>{t("roleMessagesTime")}</th>
							<th>{t("roleMessagesFrom")}</th>
							<th>{t("roleMessagesTo")}</th>
							<th>{t("roleMessagesKind")}</th>
							<th>{t("roleMessagesState")}</th>
							<th>{t("roleMessagesText")}</th>
						</tr>
					</thead>
					<tbody>
						{messages.map((m) => (
							<tr key={m.id} data-id={m.id} data-state={m.state}>
								<td title={new Date(m.at).toLocaleString()}>{shortTime(m.at)}</td>
								<td>
									{m.from} ({m.fromChat})
								</td>
								<td>{m.toChat ? `${m.to} (${m.toChat})` : m.to}</td>
								<td title={m.replyTo ? t("roleMessageReplyKind", { id: m.replyTo }) : undefined}>
									{m.kind}
									{m.initiative && (
										<span className="rolemsg-init" data-initiative={m.initiative}>
											{" \u00b7 "}
											{t("initiativeTag", { id: m.initiative })}
										</span>
									)}
								</td>
								<td className={`rolemsg-state-${m.state}`} title={m.error}>
									{t(ROLE_MESSAGE_STATE_KEY[m.state])}
								</td>
								<td className="rolemsg-first" title={`${m.id}: ${m.firstLine}`}>
									{m.firstLine}
								</td>
							</tr>
						))}
					</tbody>
				</table>
			)}
		</div>
	);
}

/** role-messages: "14:05" today, "Oct 3 14:05" before. */
function shortTime(at: number): string {
	const d = new Date(at);
	const hm = d.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false });
	if (d.toDateString() === new Date().toDateString()) return hm;
	return `${d.toLocaleDateString("en-US", { month: "short", day: "numeric" })} ${hm}`;
}

function IdentityRow({
	identity,
	marked,
	open,
	draft,
	ownSkills,
	homeTitle,
	onOpenChat,
}: {
	identity: UiIdentityInfo;
	/** roles-overview: the row the Roles page asked for (marked for a moment). */
	marked?: boolean;
	open: IdentityFileState | null;
	draft: IdentityDraftState | null;
	/** identity-config: its own skills, once the server has sent them (undefined = not yet, or off). */
	ownSkills?: UiRoleSkill[];
	homeTitle?: string;
	onOpenChat: (sessionPath: string) => void;
}) {
	const t = useT();
	const cap = identity.notebookCap;
	const over = cap > 0 && identity.notebookSize > cap;
	const pct = cap > 0 ? Math.min(100, Math.round((identity.notebookSize / cap) * 100)) : 0;
	const home = identity.homeChat;
	// identity-config: its own skills first, then the shared ones not named like one of them (as its chats
	// load them); until its own come, the shared ones and "loading".
	const shared = identity.skills ?? [];
	const skills = ownSkills
		? [...ownSkills, ...shared.filter((s) => !ownSkills.some((o) => o.name === s.name))]
		: shared;
	const ownPending = !ownSkills && (identity.ownSkills ?? 0) > 0;
	const configProblems = identity.configProblems ?? [];
	// roles-overview: the owner's form over identity.json (the same open file as its plain editor).
	const [ownerForm, setOwnerForm] = useState(false);
	const formOpen = ownerForm && open?.file === "config";
	const anyOpen = open !== null;
	useEffect(() => {
		if (!anyOpen) setOwnerForm(false);
	}, [anyOpen]);
	return (
		<div
			className={`identity-row${marked ? " identity-row-marked" : ""}`}
			data-identity={identity.id}
			data-draft={identity.draft ? "1" : undefined}
			tabIndex={-1}
			aria-label={identity.title}
		>
			<div className="identity-row-head">
				<span className="identity-tag">{identity.title}</span>
				<code className="identity-id">{identity.id}</code>
				{identity.folder && (
					<span className="identity-folder" title={identity.folder}>
						{identity.folder}
					</span>
				)}
				{identity.draft && (
					<span
						className="identity-draft-badge"
						title={t("identityDraftWaitingTip", {
							about: fmt(identity.draft.aboutSize ?? 0),
							size: fmt(identity.draft.promptSize),
							fields: identity.draft.fields.join(", ") || "-",
						})}
					>
						{t("identityDraftWaiting")}
					</span>
				)}
			</div>
			<div className="identity-row-meta">
				<span className="identity-home">
					{t("identityHomeChat")}:{" "}
					{home ? (
						<button type="button" className="identity-home-link" title={home} onClick={() => onOpenChat(home)}>
							{homeTitle || shortChatName(home)}
						</button>
					) : (
						<span className="identity-muted">{t("identityNoHomeChat")}</span>
					)}
				</span>
				<span className={`identity-notebook-size${over ? " over" : ""}`} data-over={over ? "1" : undefined}>
					{t("identityNotebook")}: {t("identitySizeOfCap", { size: fmt(identity.notebookSize), cap: fmt(cap) })}
					<span className="identity-meter" aria-hidden="true">
						<span className="identity-meter-fill" style={{ width: `${pct}%` }} />
					</span>
				</span>
			</div>
			{/* identity-config: the role's own prompt, skills and tool limits, as its chats get them */}
			<div className="identity-role-meta">
				<span className="identity-role-prompt">
					{t("identityPrompt")}:{" "}
					{identity.promptOff ? (
						<span className="identity-role-muted">{t("identityPromptOff")}</span>
					) : identity.promptSize > 0 ? (
						t("identityPromptSize", { file: identity.promptFile, size: fmt(identity.promptSize) })
					) : (
						<span className="identity-role-muted">{t("identityPromptNone")}</span>
					)}
				</span>
				<span className="identity-role-skills">
					{t("identitySkills")}:{" "}
					{skills.length === 0 && !ownPending ? (
						<span className="identity-role-muted">{t("identitySkillsNone")}</span>
					) : (
						skills.map((s, i) => (
							<span key={s.name} className="identity-role-skill" title={s.description || s.path}>
								{i > 0 ? ", " : ""}
								{s.name}
								{s.shared ? ` (${t("identitySkillShared")})` : ""}
							</span>
						))
					)}
					{ownPending && (
						<span className="identity-role-muted identity-role-skills-pending">
							{skills.length > 0 ? ", " : ""}
							{t("loading")}
						</span>
					)}
				</span>
				<span className="identity-role-tools">
					{t("identityToolLimits")}: {identity.toolLimits || "none"}
				</span>
				{identity.unique && <span className="identity-role-unique">{t("identityUnique")}</span>}
			</div>
			<OwnerSummary
				identity={identity}
				formOpen={formOpen}
				onChange={() => {
					if (formOpen) {
						setOwnerForm(false);
						closeIdentityFile();
					} else {
						setOwnerForm(true);
						openIdentityFile(identity.id, "config");
					}
				}}
			/>
			{configProblems.length > 0 && (
				<div className="set-hint identity-config-problems">
					{t("identityConfigProblems")}
					<ul>
						{configProblems.map((p) => (
							<li key={p}>{p}</li>
						))}
					</ul>
				</div>
			)}
			<div className="identity-row-actions">
				{(["about", "notebook", "prompt", "config"] as const).map((file) => {
					const isOpen = open?.file === file && !formOpen;
					const label = fileLabel(file, identity);
					return (
						<button
							key={file}
							type="button"
							className={`identity-btn identity-open-btn${isOpen ? " on" : ""}`}
							data-file={file}
							aria-pressed={isOpen}
							title={t("identityOpenFile", { file: label })}
							onClick={() => {
								setOwnerForm(false);
								if (isOpen) closeIdentityFile();
								else openIdentityFile(identity.id, file);
							}}
						>
							{file === "config" ? `${t("identitySettingsFile")} (${label})` : label}
						</button>
					);
				})}
				{identity.draft && (
					<button
						type="button"
						className={`identity-btn identity-draft-btn${draft ? " on" : ""}`}
						aria-pressed={draft !== null}
						onClick={() => (draft ? closeIdentityDraft() : openIdentityDraft(identity.id))}
					>
						{t("identityDraftOpen")}
					</button>
				)}
			</div>
			{open && formOpen && (
				<OwnerFieldsEditor
					// A fresh form per loaded/saved version of identity.json.
					key={`${open.status}:${open.hash ?? ""}`}
					file={open}
					identity={identity}
					onClose={() => {
						setOwnerForm(false);
						closeIdentityFile();
					}}
				/>
			)}
			{open && !formOpen && (
				<IdentityFileEditor
					// A fresh editor per loaded/saved version: the draft starts from the file on disk.
					key={`${open.file}:${open.status}:${open.hash ?? ""}`}
					file={open}
					label={fileLabel(open.file, identity)}
					cap={open.file === "notebook" ? (open.cap ?? cap) : open.file === "prompt" ? open.cap : undefined}
				/>
			)}
			{draft && (
				<IdentityDraftEditor
					// A fresh editor per loaded/saved version of the draft.
					key={`${draft.status}:${draft.hash ?? ""}`}
					draft={draft}
					title={identity.title}
				/>
			)}
		</div>
	);
}

/** roles-overview: a goal's line: "approved 2026-10-04 · until 2026-12-31 · ended". */
function goalWhen(t: ReturnType<typeof useT>, g: UiRoleGoal, now: number): string {
	const ended = g.endsAt !== undefined && ownerGoalTime(g.endsAt, true) <= now;
	return [
		t("rolesGoalApproved", { day: g.approvedAt }),
		...(g.endsAt ? [t("rolesGoalUntil", { day: g.endsAt })] : []),
		...(ended ? [t("identityOwnerEnded")] : []),
	].join(" \u00b7 ");
}

const MODE_KEY = {
	"self-start": "identityOwnerSelfStart",
	"request-only": "identityOwnerRequestOnly",
} as const satisfies Record<UiRoleWorkMode, Parameters<ReturnType<typeof useT>>[0]>;

/**
 * roles-overview: "How it works": the owner's work mode and approved goals for the role, or the every-chat
 * rules' default (read-only) where identity.json doesn't set them. Only the owner changes them ("Change").
 */
function OwnerSummary({
	identity,
	formOpen,
	onChange,
}: {
	identity: UiIdentityInfo;
	formOpen: boolean;
	onChange: () => void;
}) {
	const t = useT();
	const now = Date.now();
	const modeSet = identity.workMode !== undefined;
	const mode: UiRoleWorkMode = identity.workMode ?? identity.rules?.workMode ?? "request-only";
	const goalsSet = identity.goals !== undefined;
	const goals = identity.goals ?? identity.rules?.goals ?? [];
	return (
		<div className="identity-owner" data-owner-set={modeSet || goalsSet ? "1" : undefined}>
			<div className="identity-owner-head">
				<span className="identity-owner-title">{t("identityOwnerHeading")}</span>
				<span className="identity-owner-badge">{t("identityOwnerOnly")}</span>
				<button
					type="button"
					className={`identity-btn identity-owner-change${formOpen ? " on" : ""}`}
					aria-expanded={formOpen}
					onClick={onChange}
				>
					{t("identityOwnerChange")}
				</button>
			</div>
			<div className="identity-owner-line" data-field="workMode">
				<span className="identity-owner-label">{t("identityOwnerWorkMode")}:</span> {t(MODE_KEY[mode])}{" "}
				<span className="identity-role-muted">({t(modeSet ? "identityOwnerSetHere" : "identityOwnerFromRules")})</span>
			</div>
			<div className="identity-owner-line" data-field="goals">
				<span className="identity-owner-label">{t("identityOwnerGoals")}:</span>{" "}
				{goals.length === 0 && <span className="identity-role-muted">{t("identityOwnerNoGoals")} </span>}
				<span className="identity-role-muted">({t(goalsSet ? "identityOwnerSetHere" : "identityOwnerFromRules")})</span>
				{goals.length > 0 && (
					<ul className="identity-owner-goals">
						{goals.map((g) => (
							<li key={g.name}>
								<b>{g.name}</b>: {g.scope}{" "}
								<span className="identity-role-muted">{`\u00b7 ${goalWhen(t, g, now)}`}</span>
							</li>
						))}
					</ul>
				)}
			</div>
			<p className="identity-owner-note">{t("identityOwnerNote")}</p>
		</div>
	);
}

type ModeChoice = "default" | UiRoleWorkMode;

/**
 * roles-overview: the owner's form over the role's identity.json: work mode (the rules' default, or set
 * here) and approved goals (the rules' default, or a list set here). Saving writes the file with only
 * those two fields changed, through the same hash-checked save as the plain editor; the server's
 * pi-identity parser decides (its problems show here).
 */
function OwnerFieldsEditor({
	file,
	identity,
	onClose,
}: {
	file: IdentityFileState;
	identity: UiIdentityInfo;
	onClose: () => void;
}) {
	const t = useT();
	const read = useMemo(() => (file.status === "ready" ? readOwnerFields(file.text ?? "") : null), [file]);
	const start = read?.ok ? read.fields : null;
	const [mode, setMode] = useState<ModeChoice>(start?.workMode ?? "default");
	const [ownGoals, setOwnGoals] = useState(start?.goals !== null && start?.goals !== undefined);
	const [goals, setGoals] = useState<OwnerGoalDraft[]>(() => start?.goals ?? []);
	if (file.status === "loading") return <p className="set-empty identity-editor-status">{t("loading")}</p>;
	if (file.status === "error")
		return <p className="set-hint identity-editor-error">{t("identityFileError", { error: file.error || "?" })}</p>;
	if (!read || !read.ok || !start) {
		return (
			<div className="identity-owner-form">
				<p className="set-hint identity-editor-error">{t("identityOwnerBadFile")}</p>
				<div className="identity-editor-actions">
					<button type="button" className="identity-btn identity-close" onClick={onClose}>
						{t("close")}
					</button>
				</div>
			</div>
		);
	}
	const fields = { workMode: mode === "default" ? null : mode, goals: ownGoals ? goals : null };
	const problems = ownerFieldsProblems(fields);
	const dirty =
		fields.workMode !== start.workMode || JSON.stringify(fields.goals) !== JSON.stringify(start.goals ?? null);
	const canSave = dirty && problems.length === 0 && !file.saving;
	const refused = file.saved?.ok === false ? file.saved : null;
	const rulesMode = identity.rules?.workMode ?? "request-only";
	const setGoal = (i: number, patch: Partial<OwnerGoalDraft>) =>
		setGoals((gs) => gs.map((g, j) => (j === i ? { ...g, ...patch } : g)));
	const save = () => {
		if (!canSave) return;
		saveOpenIdentityFile(writeOwnerFields(file.text ?? "", fields));
	};
	const name = `owner-mode-${identity.id}`;
	return (
		<form
			className="identity-owner-form"
			aria-label={`${t("identityOwnerHeading")}: ${identity.title}`}
			onSubmit={(e) => {
				e.preventDefault();
				save();
			}}
		>
			{read.problems.length > 0 && (
				<ul className="identity-editor-problems">
					{read.problems.map((p) => (
						<li key={p}>{p}</li>
					))}
				</ul>
			)}
			<fieldset className="identity-owner-set">
				<legend>{t("identityOwnerWorkMode")}</legend>
				{(
					[
						["default", t("identityOwnerDefault", { mode: t(MODE_KEY[rulesMode]) })],
						["self-start", t("identityOwnerSelfStart")],
						["request-only", t("identityOwnerRequestOnly")],
					] as const
				).map(([value, label]) => (
					<label key={value} className="identity-owner-choice">
						<input type="radio" name={name} value={value} checked={mode === value} onChange={() => setMode(value)} />
						{label}
					</label>
				))}
			</fieldset>
			<fieldset className="identity-owner-set">
				<legend>{t("identityOwnerGoals")}</legend>
				<label className="identity-owner-choice">
					<input type="radio" name={`${name}-goals`} checked={!ownGoals} onChange={() => setOwnGoals(false)} />
					{t("identityOwnerGoalsDefault")}
					{(identity.rules?.goals.length ?? 0) > 0 && (
						<span className="identity-role-muted"> ({identity.rules?.goals.map((g) => g.name).join(", ")})</span>
					)}
				</label>
				<label className="identity-owner-choice">
					<input
						type="radio"
						name={`${name}-goals`}
						checked={ownGoals}
						onChange={() => {
							setOwnGoals(true);
							// Start from what applies now: the rules' goals, so changing one keeps the others.
							if (start.goals === null && goals.length === 0) {
								setGoals(
									(identity.rules?.goals ?? []).map((g) => ({
										name: g.name,
										scope: g.scope,
										approvedAt: g.approvedAt,
										endsAt: g.endsAt ?? "",
									})),
								);
							}
						}}
					/>
					{t("identityOwnerGoalsOwn")}
				</label>
				{ownGoals && (
					<div className="identity-owner-goal-list">
						{goals.length === 0 && <p className="identity-role-muted">{t("identityOwnerNoGoals")}</p>}
						{goals.map((g, i) => (
							// biome-ignore lint/suspicious/noArrayIndexKey: rows are edited in place; a name may repeat while typed
							<div key={i} className="identity-owner-goal" data-goal={i + 1}>
								<label>
									<span>{t("identityOwnerGoalName")}</span>
									<input
										type="text"
										value={g.name}
										maxLength={OWNER_GOAL_NAME_MAX}
										onChange={(e) => setGoal(i, { name: e.target.value })}
									/>
								</label>
								<label className="identity-owner-goal-scope">
									<span>{t("identityOwnerGoalScope")}</span>
									<input
										type="text"
										value={g.scope}
										maxLength={OWNER_GOAL_SCOPE_MAX}
										onChange={(e) => setGoal(i, { scope: e.target.value })}
									/>
								</label>
								<label>
									<span>{t("identityOwnerGoalApproved")}</span>
									<input
										type="text"
										value={g.approvedAt}
										placeholder={todayStamp()}
										title={t("identityOwnerGoalWhenHint")}
										onChange={(e) => setGoal(i, { approvedAt: e.target.value })}
									/>
								</label>
								<label>
									<span>{t("identityOwnerGoalEnds")}</span>
									<input
										type="text"
										value={g.endsAt}
										title={t("identityOwnerGoalWhenHint")}
										onChange={(e) => setGoal(i, { endsAt: e.target.value })}
									/>
								</label>
								<button
									type="button"
									className="identity-btn identity-owner-remove"
									aria-label={t("identityOwnerRemoveGoal", { n: i + 1 })}
									title={t("identityOwnerRemoveGoal", { n: i + 1 })}
									onClick={() => setGoals((gs) => gs.filter((_, j) => j !== i))}
								>
									<FiTrash2 aria-hidden="true" />
								</button>
							</div>
						))}
						{goals.length < OWNER_GOALS_MAX && (
							<button
								type="button"
								className="identity-btn identity-owner-add"
								onClick={() => setGoals((gs) => [...gs, { name: "", scope: "", approvedAt: todayStamp(), endsAt: "" }])}
							>
								<FiPlus aria-hidden="true" /> {t("identityOwnerAddGoal")}
							</button>
						)}
					</div>
				)}
			</fieldset>
			{dirty && problems.length > 0 && (
				<div className="identity-editor-problems identity-owner-problems">
					{t("identityOwnerFix")}
					<ul>
						{problems.map((p) => (
							<li key={p}>{p}</li>
						))}
					</ul>
				</div>
			)}
			{refused?.problems && refused.problems.length > 0 && (
				<ul className="identity-editor-problems">
					{refused.problems.map((p) => (
						<li key={p}>{p}</li>
					))}
				</ul>
			)}
			<div className="identity-editor-actions">
				<button type="submit" className="set-save-btn identity-save" disabled={!canSave}>
					{file.saving ? t("identityOwnerSaving") : t("identityOwnerSave")}
				</button>
				<button type="button" className="identity-btn identity-close" onClick={onClose}>
					{dirty ? t("identityOwnerCancel") : t("close")}
				</button>
				<span className="identity-editor-note" role="status">
					{refused
						? t(SAVE_ERROR_KEY[refused.code] ?? "identitySaveIo")
						: dirty
							? t("identityUnsaved")
							: file.saved?.ok
								? t("identitySaved")
								: ""}
				</span>
			</div>
			<p className="identity-owner-note">{t("identityOwnerNote")}</p>
		</form>
	);
}

function IdentityFileEditor({ file, label, cap }: { file: IdentityFileState; label: string; cap?: number }) {
	const t = useT();
	const [draft, setDraft] = useState(file.text ?? "");
	if (file.status === "loading") return <p className="set-empty identity-editor-status">{t("loading")}</p>;
	if (file.status === "error")
		return <p className="set-hint identity-editor-error">{t("identityFileError", { error: file.error || "?" })}</p>;
	const size = utf8Bytes(draft);
	const overBy = cap !== undefined && cap > 0 ? size - cap : 0;
	const dirty = draft !== (file.text ?? "");
	const canSave = dirty && overBy <= 0 && !file.saving;
	const save = () => {
		if (canSave) saveOpenIdentityFile(draft);
	};
	const refused = file.saved?.ok === false ? file.saved : null;
	return (
		<div className="identity-editor" data-file={file.file}>
			<div className="identity-editor-head">
				<code>{label}</code>
				<span className={`identity-editor-size${overBy > 0 ? " over" : ""}`}>
					{cap !== undefined
						? t("identitySizeOfCap", { size: fmt(size), cap: fmt(cap) })
						: t("identitySize", { size: fmt(size) })}
				</span>
			</div>
			<textarea
				className="identity-editor-text"
				aria-label={label}
				spellCheck={false}
				value={draft}
				rows={16}
				onChange={(e) => setDraft(e.target.value)}
				onKeyDown={(e) => {
					if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
						e.preventDefault();
						save();
					}
				}}
			/>
			{overBy > 0 && (
				<p className="identity-editor-over">
					{overBy === 1 ? t("identityOverCapOne") : t("identityOverCap", { n: fmt(overBy) })}
				</p>
			)}
			{refused?.problems && refused.problems.length > 0 && (
				// identity-config: why pi-identity would refuse these settings, one line each.
				<ul className="identity-editor-problems">
					{refused.problems.map((p) => (
						<li key={p}>{p}</li>
					))}
				</ul>
			)}
			<div className="identity-editor-actions">
				<button type="button" className="set-save-btn identity-save" disabled={!canSave} onClick={save}>
					{file.saving ? t("identitySaving") : t("save")}
				</button>
				<button
					type="button"
					className="identity-btn identity-reload"
					disabled={file.saving}
					onClick={() => openIdentityFile(file.id, file.file)}
				>
					{t("identityReload")}
				</button>
				<button type="button" className="identity-btn identity-close" onClick={() => closeIdentityFile()}>
					{t("close")}
				</button>
				<span className="identity-editor-note" role="status">
					{refused
						? t(SAVE_ERROR_KEY[refused.code] ?? "identitySaveIo")
						: dirty
							? t("identityUnsaved")
							: file.saved?.ok
								? t("identitySaved")
								: ""}
				</span>
			</div>
		</div>
	);
}

/**
 * about-drafts: "What changes": the role's about page now against the page its draft suggests (as edited
 * so far), line by line in the app's diff look, long unchanged stretches folded away.
 */
function DraftChanges({ before, after }: { before: string; after: string }) {
	const t = useT();
	const lines = useMemo(() => lineDiff(before, after), [before, after]);
	const rows = useMemo(() => foldDiff(lines), [lines]);
	const { added, removed } = diffCounts(lines);
	if (!added && !removed) return <p className="set-hint identity-draft-change-count">{t("identityDraftSame")}</p>;
	return (
		<div className="identity-draft-changes">
			<p className="set-hint identity-draft-change-count">
				{before.trim() ? t("identityDraftChangeCount", { added, removed }) : t("identityDraftAllNew")}
			</p>
			<pre className="scm-diff-pre identity-draft-diff">
				{rows.map((r, i) =>
					r.kind === "skip" ? (
						<div key={i} className="scm-diff-line hunk">
							{t("identityDraftUnchanged", { count: r.count })}
						</div>
					) : (
						<div key={i} className={`scm-diff-line${r.kind === "same" ? "" : ` ${r.kind}`}`}>
							{`${r.kind === "add" ? "+" : r.kind === "del" ? "-" : " "} ${r.text}`}
						</div>
					),
				)}
			</pre>
		</div>
	);
}

/**
 * identity-config: a role's waiting draft: its suggested prompt and settings (editable), and why.
 * about-drafts: and its suggested about page (editable), with "What changes" against the role's page now.
 * A draft with an about page but no prompt shows no prompt box (an empty prompt changes nothing).
 */
function IdentityDraftEditor({ draft, title }: { draft: IdentityDraftState; title: string }) {
	const t = useT();
	const [about, setAbout] = useState(draft.about ?? "");
	const [aboutView, setAboutView] = useState<"page" | "changes">("page");
	const [prompt, setPrompt] = useState(draft.prompt ?? "");
	const [config, setConfig] = useState(draft.config ?? "");
	if (draft.status === "loading") return <p className="set-empty identity-draft-status">{t("loading")}</p>;
	if (draft.status === "error")
		return <p className="set-hint identity-draft-error">{t("identityDraftError", { error: draft.error || "?" })}</p>;
	const done = draft.done;
	// Accepted or discarded: the draft is gone; only the answer stays until the row's button closes it.
	const finished = done?.ok === true && done.action !== "save";
	const hasAbout = (draft.about ?? "") !== "";
	const showPrompt = (draft.prompt ?? "") !== "" || !hasAbout;
	const dirty = about !== (draft.about ?? "") || prompt !== (draft.prompt ?? "") || config !== (draft.config ?? "");
	const busy = draft.busy !== undefined;
	const act = (action: IdentityDraftAction) => {
		if (!busy && !finished) sendIdentityDraftAction(action, prompt, config, about);
	};
	return (
		<div className="identity-draft" data-identity={draft.id}>
			<div className="identity-editor-head">
				<strong>{t("identityDraftTitle", { title })}</strong>
			</div>
			<p className="set-hint identity-draft-hint">{t("identityDraftHint")}</p>
			{!finished && (
				<>
					{hasAbout && (
						<div className="identity-draft-label identity-draft-about-box">
							<div className="identity-draft-about-head">
								<span>
									{t("identityDraftAbout")}{" "}
									<span className="identity-editor-size">{t("identitySize", { size: fmt(utf8Bytes(about)) })}</span>
								</span>
								<span className="identity-draft-views">
									<button
										type="button"
										className={`identity-btn identity-draft-view-page${aboutView === "page" ? " on" : ""}`}
										aria-pressed={aboutView === "page"}
										onClick={() => setAboutView("page")}
									>
										{t("identityDraftShowPage")}
									</button>
									<button
										type="button"
										className={`identity-btn identity-draft-view-changes${aboutView === "changes" ? " on" : ""}`}
										aria-pressed={aboutView === "changes"}
										onClick={() => setAboutView("changes")}
									>
										{t("identityDraftShowChanges")}
									</button>
								</span>
							</div>
							{aboutView === "page" ? (
								<textarea
									className="identity-editor-text identity-draft-about"
									aria-label={t("identityDraftAbout")}
									spellCheck={false}
									value={about}
									rows={18}
									onChange={(e) => setAbout(e.target.value)}
								/>
							) : (
								<DraftChanges before={draft.currentAbout ?? ""} after={about} />
							)}
						</div>
					)}
					{showPrompt && (
						<label className="identity-draft-label">
							{t("identityDraftPrompt")}{" "}
							<span className="identity-editor-size">{t("identitySize", { size: fmt(utf8Bytes(prompt)) })}</span>
							<textarea
								className="identity-editor-text identity-draft-prompt"
								spellCheck={false}
								value={prompt}
								rows={14}
								onChange={(e) => setPrompt(e.target.value)}
							/>
						</label>
					)}
					<label className="identity-draft-label">
						{t("identityDraftConfig")}
						<textarea
							className="identity-editor-text identity-draft-config"
							spellCheck={false}
							value={config}
							rows={6}
							onChange={(e) => setConfig(e.target.value)}
						/>
					</label>
					{draft.notes ? (
						<details className="identity-draft-notes" open>
							<summary>{t("identityDraftNotes")}</summary>
							<pre>{draft.notes}</pre>
						</details>
					) : null}
				</>
			)}
			{done?.ok === false && done.problems && done.problems.length > 0 && (
				<ul className="identity-editor-problems">
					{done.problems.map((p) => (
						<li key={p}>{p}</li>
					))}
				</ul>
			)}
			<div className="identity-editor-actions">
				{!finished && (
					<>
						<button
							type="button"
							className="set-save-btn identity-draft-accept"
							disabled={busy}
							onClick={() => act("accept")}
						>
							{draft.busy === "accept" ? t("identityDraftWorking") : t("identityDraftAccept")}
						</button>
						<button
							type="button"
							className="identity-btn identity-draft-save"
							disabled={busy || !dirty}
							onClick={() => act("save")}
						>
							{draft.busy === "save" ? t("identityDraftWorking") : t("identityDraftSave")}
						</button>
						<button
							type="button"
							className="identity-btn identity-draft-discard"
							disabled={busy}
							onClick={() => act("discard")}
						>
							{draft.busy === "discard" ? t("identityDraftWorking") : t("identityDraftDiscard")}
						</button>
					</>
				)}
				<button type="button" className="identity-btn identity-close" onClick={() => closeIdentityDraft()}>
					{t("close")}
				</button>
				<span className="identity-editor-note identity-draft-note" role="status">
					{done
						? done.ok
							? t(DRAFT_DONE_KEY[done.action])
							: t(SAVE_ERROR_KEY[done.code ?? "io"] ?? "identitySaveIo")
						: dirty
							? t("identityUnsaved")
							: ""}
				</span>
			</div>
		</div>
	);
}
