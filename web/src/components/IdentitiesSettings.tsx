/**
 * identities: Settings -> Identities.
 *
 * Lists each identity (pi-identity, ~/.pi/agent/memory/identities/<id>/) with its home chat (a link
 * that opens it) and its notebook size against the cap, and opens about.md / notebook.md in a plain
 * text editor. Saving writes the whole file (the server writes it atomically and refuses a notebook
 * over its cap, or a file that changed after it was opened). Chats pick an edit up at their next
 * refresh point (a new session, a compaction or a notebook write) — the page says so.
 *
 * State: identity-state.ts (the list + the open file); the draft lives here.
 */
import { useEffect, useMemo, useState } from "react";
import { FiUser } from "react-icons/fi";
import { appSend } from "../app-globals";
import { useT } from "../i18n";
import {
	closeIdentityFile,
	openIdentityFile,
	requestIdentities,
	saveOpenIdentityFile,
	shortChatName,
	useIdentityFile,
	useIdentityList,
	utf8Bytes,
	type IdentityFileState,
} from "../identity-state";
import type {
	ConversationSummary,
	IdentityFileName,
	IdentitySaveError,
	SessionSummary,
	UiIdentityInfo,
} from "../types";
import { HintTip } from "./HintTip";

const FILE_NAMES: Record<IdentityFileName, string> = { about: "about.md", notebook: "notebook.md" };

/** The saved-answer codes -> their message key. */
const SAVE_ERROR_KEY: Record<
	IdentitySaveError,
	"identitySaveOverCap" | "identitySaveChanged" | "identitySaveTooBig" | "identitySaveUnknown" | "identitySaveIo"
> = {
	over_cap: "identitySaveOverCap",
	changed: "identitySaveChanged",
	too_big: "identitySaveTooBig",
	unknown: "identitySaveUnknown",
	io: "identitySaveIo",
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
	// Fresh sizes whenever the page opens; the editor closes when the page goes away. The History
	// list is loaded lazily by the left panel (not yet on a phone whose drawer stayed shut): ask for
	// it too, so the home chats show by their titles.
	const noSessions = !sessions || sessions.length === 0;
	useEffect(() => {
		requestIdentities();
		if (noSessions) appSend({ type: "list_sessions" });
		return () => closeIdentityFile();
		// eslint-disable-next-line react-hooks/exhaustive-deps -- once per opening
	}, []);

	const titleOfChat = useMemo(() => {
		const byPath = new Map<string, string>();
		for (const s of sessions ?? []) {
			const title = s.name || s.firstMessage.trim();
			if (title) byPath.set(s.path, title);
		}
		for (const c of conversations ?? []) if (c.sessionFile && c.title) byPath.set(c.sessionFile, c.title);
		return (path: string) => byPath.get(path);
	}, [sessions, conversations]);

	return (
		<div className="set-section identities-settings">
			<div className="set-section-title">
				<FiUser className="set-section-icon" />
				{t("settingsIdentities")}
				<HintTip text={t("identitiesHint")} />
				{identities.length > 0 && <span className="set-count">{identities.length}</span>}
			</div>
			<p className="set-hint">{t("identitiesRefreshNote")}</p>
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
							homeTitle={identity.homeChat ? titleOfChat(identity.homeChat) : undefined}
							onOpenChat={onOpenChat}
						/>
					))}
				</div>
			)}
		</div>
	);
}

function IdentityRow({
	identity,
	open,
	homeTitle,
	onOpenChat,
}: {
	identity: UiIdentityInfo;
	open: IdentityFileState | null;
	homeTitle?: string;
	onOpenChat: (sessionPath: string) => void;
}) {
	const t = useT();
	const cap = identity.notebookCap;
	const over = cap > 0 && identity.notebookSize > cap;
	const pct = cap > 0 ? Math.min(100, Math.round((identity.notebookSize / cap) * 100)) : 0;
	const home = identity.homeChat;
	return (
		<div className="identity-row" data-identity={identity.id}>
			<div className="identity-row-head">
				<span className="identity-tag">{identity.title}</span>
				<code className="identity-id">{identity.id}</code>
				{identity.folder && (
					<span className="identity-folder" title={identity.folder}>
						{identity.folder}
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
			<div className="identity-row-actions">
				{(["about", "notebook"] as const).map((file) => {
					const isOpen = open?.file === file;
					return (
						<button
							key={file}
							type="button"
							className={`identity-btn identity-open-btn${isOpen ? " on" : ""}`}
							data-file={file}
							aria-pressed={isOpen}
							title={t("identityOpenFile", { file: FILE_NAMES[file] })}
							onClick={() => (isOpen ? closeIdentityFile() : openIdentityFile(identity.id, file))}
						>
							{FILE_NAMES[file]}
						</button>
					);
				})}
			</div>
			{open && (
				<IdentityFileEditor
					// A fresh editor per loaded/saved version: the draft starts from the file on disk.
					key={`${open.file}:${open.status}:${open.hash ?? ""}`}
					file={open}
					cap={open.file === "notebook" ? (open.cap ?? cap) : undefined}
				/>
			)}
		</div>
	);
}

function IdentityFileEditor({ file, cap }: { file: IdentityFileState; cap?: number }) {
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
	return (
		<div className="identity-editor" data-file={file.file}>
			<div className="identity-editor-head">
				<code>{FILE_NAMES[file.file]}</code>
				<span className={`identity-editor-size${overBy > 0 ? " over" : ""}`}>
					{cap !== undefined
						? t("identitySizeOfCap", { size: fmt(size), cap: fmt(cap) })
						: t("identitySize", { size: fmt(size) })}
				</span>
			</div>
			<textarea
				className="identity-editor-text"
				aria-label={FILE_NAMES[file.file]}
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
					{file.saved?.ok === false
						? t(SAVE_ERROR_KEY[file.saved.code] ?? "identitySaveIo")
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
