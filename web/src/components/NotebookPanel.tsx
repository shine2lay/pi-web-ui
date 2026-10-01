/**
 * identity-notebook-tab: the right panel's Notebook tab.
 *
 * Shows the chat identity's notebook (pi-identity's notebook.md: the role's curated memory, kept to
 * what's still true and useful) as markdown, with its size against the cap. It's live: the server
 * sends every change, whoever made it. No history and no log, just the notebook as it is now.
 *
 * Edit opens a plain-text editor; saving writes the whole file (atomically; refused over the cap). If
 * the notebook changed while you were editing (a chat's notebook tool, another window, the weekly
 * tidy-up), the panel says so at once, and saving is refused instead of overwriting: load the new
 * version, or save yours anyway (the lines that drops are kept in the memory archive, server side).
 *
 * State: notebook-state.ts (the notebook on disk + the last save's answer); the draft lives here.
 * SlotTabs mounts only the open tab, so the server watches the notebook only while the tab shows.
 */
import { memo, useEffect, useState } from "react";
import { type Translate, useT } from "../i18n";
import { utf8Bytes } from "../identity-state";
import { clearNotebookSaved, saveNotebook, useNotebook, watchNotebook } from "../notebook-state";
import type { IdentitySaveError, UiChatIdentity } from "../types";
import { Markdown } from "./Markdown";

/** The notebook's cap when the server hasn't said (pi-identity's NOTEBOOK_CAP). */
const DEFAULT_CAP = 8_000;

/** How long "Saved." stays after a save. */
const SAVED_NOTE_MS = 3_000;

const SAVE_ERROR_KEY: Record<IdentitySaveError, Parameters<Translate>[0]> = {
	over_cap: "identitySaveOverCap",
	changed: "notebookSaveChanged",
	too_big: "identitySaveTooBig",
	unknown: "identitySaveUnknown",
	io: "identitySaveIo",
};

function fmt(n: number): string {
	return n.toLocaleString("en-US");
}

/** The text being edited and the version (hash) it started from. */
interface Draft {
	text: string;
	base: string;
}

export const NotebookPanel = memo(function NotebookPanel({
	identity,
	onOpenAbout,
}: {
	identity: UiChatIdentity;
	/** Open Settings -> Identities (the about pages are edited there). */
	onOpenAbout?: () => void;
}) {
	const t = useT();
	const nb = useNotebook();
	const [draft, setDraft] = useState<Draft | null>(null);
	/** The save was refused because the notebook changed (or Save found it changed): ask what to do. */
	const [conflict, setConflict] = useState(false);
	/** A save this panel sent is on its way. */
	const [awaiting, setAwaiting] = useState(false);

	// Watch while the tab is shown; another identity = another watch.
	useEffect(() => {
		watchNotebook(identity.id);
		return () => watchNotebook(null);
	}, [identity.id]);

	// The save's answer: ok -> back to the view; "changed" -> the conflict choices; else the note says why.
	const saving = nb?.saving === true;
	const saved = nb?.saved;
	useEffect(() => {
		if (!awaiting || saving) return;
		setAwaiting(false);
		if (saved?.ok) {
			setDraft(null);
			setConflict(false);
		} else if (saved && !saved.ok && saved.code === "changed") {
			setConflict(true);
		}
	}, [awaiting, saving, saved]);

	// "Saved." goes away after a moment.
	useEffect(() => {
		if (!saved?.ok || draft) return;
		const timer = setTimeout(() => clearNotebookSaved(), SAVED_NOTE_MS);
		return () => clearTimeout(timer);
	}, [saved, draft]);

	const mine = nb && nb.id === identity.id ? nb : null;
	const cap = mine?.cap ?? DEFAULT_CAP;
	const ready = mine?.status === "ready" && typeof mine.text === "string" && typeof mine.hash === "string";

	const startEdit = () => {
		if (!ready || !mine?.hash) return;
		clearNotebookSaved();
		setConflict(false);
		setDraft({ text: mine.text ?? "", base: mine.hash });
	};
	const cancel = () => {
		setDraft(null);
		setConflict(false);
	};
	const send = (text: string, base: string) => {
		if (saveNotebook(text, base)) setAwaiting(true);
	};

	if (!mine || mine.status === "loading") {
		return (
			<div className="notebook-panel" data-notebook={identity.id} data-status="loading">
				<p className="notebook-empty">{t("notebookLoading")}</p>
			</div>
		);
	}
	if (mine.status === "error") {
		return (
			<div className="notebook-panel" data-notebook={identity.id} data-status="error">
				<p className="notebook-empty">{t("notebookError", { error: mine.error || "?" })}</p>
			</div>
		);
	}

	const text = mine.text ?? "";
	const size = draft ? utf8Bytes(draft.text) : (mine.size ?? utf8Bytes(text));
	const overBy = size - cap;
	const pct = Math.min(100, Math.round((size / Math.max(1, cap)) * 100));
	// Not while a save of ours is on its way: its own push moves the hash too (no flash of the warning).
	const changedMeanwhile = draft !== null && !saving && !awaiting && draft.base !== mine.hash;
	const dirty = draft !== null && draft.text !== text;
	const canSave = draft !== null && overBy <= 0 && !saving && (dirty || changedMeanwhile);
	const save = () => {
		if (!draft || !canSave) return;
		// Already known to have changed: don't send, ask (the server would refuse it anyway).
		if (changedMeanwhile) {
			setConflict(true);
			return;
		}
		send(draft.text, draft.base);
	};

	const head = (
		<div className="notebook-head">
			<span className="notebook-title" title={identity.id}>
				{t("notebookOf", { title: identity.title })}
			</span>
			<span
				className={`notebook-size${overBy > 0 ? " over" : ""}`}
				title={t("notebookSizeTip", { size: fmt(size), cap: fmt(cap) })}
				data-size={size}
			>
				{t("notebookSize", { size: fmt(size), cap: fmt(cap) })}
				<span className="identity-meter" aria-hidden="true">
					<span className="identity-meter-fill" style={{ width: `${pct}%` }} />
				</span>
			</span>
		</div>
	);

	if (!draft) {
		return (
			<div className="notebook-panel" data-notebook={identity.id} data-status="ready" data-hash={mine.hash}>
				{head}
				<div className="notebook-actions">
					<button type="button" className="identity-btn notebook-edit" onClick={startEdit}>
						{t("notebookEdit")}
					</button>
					{onOpenAbout && (
						<button
							type="button"
							className="notebook-about-link"
							title={t("notebookAboutPageTip")}
							onClick={onOpenAbout}
						>
							{t("notebookAboutPage")}
						</button>
					)}
					{saved?.ok && (
						<span className="notebook-note" role="status">
							{t("identitySaved")}
						</span>
					)}
				</div>
				<p className="notebook-hint">{t("notebookHint")}</p>
				{text.trim() ? (
					<div className="notebook-view">
						<Markdown text={text} />
					</div>
				) : (
					<p className="notebook-empty">{t("notebookEmpty")}</p>
				)}
			</div>
		);
	}

	const note = saving
		? t("identitySaving")
		: saved && !saved.ok && saved.code !== "changed"
			? t(SAVE_ERROR_KEY[saved.code] ?? "identitySaveIo")
			: dirty
				? t("notebookUnsaved")
				: "";
	return (
		<div className="notebook-panel editing" data-notebook={identity.id} data-status="editing" data-hash={mine.hash}>
			{head}
			{(changedMeanwhile || conflict) && (
				<div className="notebook-conflict" role="alert">
					<p>{conflict ? t("notebookSaveChanged") : t("notebookChangedWhileEditing")}</p>
					<div className="notebook-actions">
						<button
							type="button"
							className="identity-btn notebook-load-new"
							disabled={saving}
							onClick={() => {
								setDraft({ text, base: mine.hash ?? "" });
								setConflict(false);
							}}
						>
							{t("notebookLoadNew")}
						</button>
						{conflict && (
							<button
								type="button"
								className="identity-btn notebook-save-mine"
								disabled={saving || overBy > 0}
								onClick={() => {
									setConflict(false);
									send(draft.text, mine.hash ?? "");
								}}
							>
								{t("notebookSaveMine")}
							</button>
						)}
					</div>
				</div>
			)}
			<textarea
				className="notebook-editor"
				aria-label={t("notebookOf", { title: identity.title })}
				spellCheck={false}
				value={draft.text}
				onChange={(e) => setDraft({ ...draft, text: e.target.value })}
				onKeyDown={(e) => {
					if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
						e.preventDefault();
						save();
					}
				}}
			/>
			{overBy > 0 && (
				<p className="notebook-over">
					{overBy === 1 ? t("identityOverCapOne") : t("identityOverCap", { n: fmt(overBy) })}
				</p>
			)}
			<div className="notebook-actions">
				<button type="button" className="set-save-btn notebook-save" disabled={!canSave} onClick={save}>
					{saving ? t("identitySaving") : t("save")}
				</button>
				<button type="button" className="identity-btn notebook-cancel" disabled={saving} onClick={cancel}>
					{t("notebookCancel")}
				</button>
				<span className="notebook-note" role="status">
					{note}
				</span>
			</div>
		</div>
	);
});
