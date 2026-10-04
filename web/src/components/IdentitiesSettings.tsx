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
 * role's folder) or discard it. A role's own skills live in its private folder, so the identity list
 * every window gets only counts them: this page asks for them (identity_skills_get) when it opens and
 * whenever the list changes.
 *
 * role-messages: below the list, "Role messages": the owner's switch (on / paused: held, not dropped)
 * and the last 100 messages role chats sent each other (time, from, to, kind, state, first line).
 *
 * State: identity-state.ts (the list, the open file, the open draft, the own skills, the role
 * messages); the texts being typed live here.
 */
import { useEffect, useMemo, useState } from "react";
import { FiUser } from "react-icons/fi";
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
	UiRoleMessageRow,
	UiRoleSkill,
} from "../types";
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
	onOpenChat,
}: {
	/** History + running chats: to show the home chat by its title. */
	sessions?: SessionSummary[];
	conversations?: ConversationSummary[];
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
				<div className="identity-list">
					{identities.map((identity) => (
						<IdentityRow
							key={identity.id}
							identity={identity}
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
								<td title={m.replyTo ? t("roleMessageReplyKind", { id: m.replyTo }) : undefined}>{m.kind}</td>
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
	open,
	draft,
	ownSkills,
	homeTitle,
	onOpenChat,
}: {
	identity: UiIdentityInfo;
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
	return (
		<div className="identity-row" data-identity={identity.id} data-draft={identity.draft ? "1" : undefined}>
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
					const isOpen = open?.file === file;
					const label = fileLabel(file, identity);
					return (
						<button
							key={file}
							type="button"
							className={`identity-btn identity-open-btn${isOpen ? " on" : ""}`}
							data-file={file}
							aria-pressed={isOpen}
							title={t("identityOpenFile", { file: label })}
							onClick={() => (isOpen ? closeIdentityFile() : openIdentityFile(identity.id, file))}
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
			{open && (
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

/** identity-config: a role's waiting draft: its suggested prompt and settings (editable), and why. */
function IdentityDraftEditor({ draft, title }: { draft: IdentityDraftState; title: string }) {
	const t = useT();
	const [prompt, setPrompt] = useState(draft.prompt ?? "");
	const [config, setConfig] = useState(draft.config ?? "");
	if (draft.status === "loading") return <p className="set-empty identity-draft-status">{t("loading")}</p>;
	if (draft.status === "error")
		return <p className="set-hint identity-draft-error">{t("identityDraftError", { error: draft.error || "?" })}</p>;
	const done = draft.done;
	// Accepted or discarded: the draft is gone; only the answer stays until the row's button closes it.
	const finished = done?.ok === true && done.action !== "save";
	const dirty = prompt !== (draft.prompt ?? "") || config !== (draft.config ?? "");
	const busy = draft.busy !== undefined;
	const act = (action: IdentityDraftAction) => {
		if (!busy && !finished) sendIdentityDraftAction(action, prompt, config);
	};
	return (
		<div className="identity-draft" data-identity={draft.id}>
			<div className="identity-editor-head">
				<strong>{t("identityDraftTitle", { title })}</strong>
			</div>
			<p className="set-hint identity-draft-hint">{t("identityDraftHint")}</p>
			{!finished && (
				<>
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
