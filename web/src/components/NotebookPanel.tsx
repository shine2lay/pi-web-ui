/**
 * identity-notebook-tab: the right panel's Notebook tab.
 *
 * Shows the chat identity's memory as pi-identity keeps it, in two layers (identity-notes):
 * - the rules (notebook.md) and the notes index, which go out with every message of the role's chats,
 *   with what both take in characters and estimated tokens;
 * - the notes (unlimited), listed newest first or searched the way the role's chats search them, opened
 *   whole, edited or deleted (the old version goes to the role's removed.md, server side).
 * All of it is raw text: it's written by and for the AI. It's live: the server sends every change,
 * whoever made it (a chat recording a note, the owner, the weekly tidy-up).
 *
 * Edit opens a plain-text editor for the rules; saving writes the whole file (atomically; refused past
 * the rules' cap unless it shrinks). If the rules changed while you were editing, the panel says so at
 * once, and saving is refused instead of overwriting: load the new version, or save yours anyway (the
 * lines that drops are kept in the role's removed.md, server side).
 *
 * State: notebook-state.ts (the notebook on disk, the notes list, the open note, the last answers);
 * drafts live here. SlotTabs mounts only the open tab, so the server watches only while the tab shows.
 */
import { memo, useEffect, useState } from "react";
import { type Translate, useT } from "../i18n";
import { utf8Bytes } from "../identity-state";
import {
	clearNotebookSaved,
	closeNote,
	deleteOpenNote,
	type OpenNote,
	openNote,
	saveNotebook,
	saveOpenNote,
	searchNotes,
	useNotebook,
	watchNotebook,
} from "../notebook-state";
import type { IdentitySaveError, UiChatIdentity, UiNoteHit, UiRoleMemory } from "../types";

/** The rules' cap when the server hasn't said (pi-identity: notebookCap 8,000 minus indexBudget 2,000). */
const DEFAULT_CAP = 6_000;

/** How long "Saved." stays after a save. */
const SAVED_NOTE_MS = 3_000;

const SAVE_ERROR_KEY: Record<IdentitySaveError, Parameters<Translate>[0]> = {
	over_cap: "identitySaveOverCap",
	changed: "notebookSaveChanged",
	too_big: "identitySaveTooBig",
	unknown: "identitySaveUnknown",
	io: "identitySaveIo",
	invalid: "identitySaveInvalid", // identity-config: settings only; a notebook save never gets it
};

function fmt(n: number): string {
	return n.toLocaleString("en-US");
}

/** A note's row, as the role's chats see it in search hits: id, date, [topic], (flags), summary. */
export function noteRowText(h: UiNoteHit): string {
	const topic = h.topic ? ` [${h.topic}]` : "";
	const flags = h.flags.length ? ` (${h.flags.join(", ")})` : "";
	return `${h.ref} ${h.date || "-"}${topic}${flags} ${h.summary}`;
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
	/** identity-notes: the search box. */
	const [query, setQuery] = useState("");

	// Watch while the tab is shown; another identity = another watch.
	useEffect(() => {
		watchNotebook(identity.id);
		setQuery("");
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

	// identity-notes: the notes list loads once the notebook is here.
	const listIdle = mine?.status === "ready" && mine.notes.status === "idle";
	useEffect(() => {
		if (listIdle) searchNotes("");
	}, [listIdle]);

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
	const savedSize = mine.size ?? utf8Bytes(text);
	const size = draft ? utf8Bytes(draft.text) : savedSize;
	const overBy = size - cap;
	// Rules already past the cap (an older notebook) may still be saved if they don't grow.
	const blocked = overBy > 0 && size > savedSize;
	const pct = Math.min(100, Math.round((size / Math.max(1, cap)) * 100));
	// Not while a save of ours is on its way: its own push moves the hash too (no flash of the warning).
	const changedMeanwhile = draft !== null && !saving && !awaiting && draft.base !== mine.hash;
	const dirty = draft !== null && draft.text !== text;
	const canSave = draft !== null && !blocked && !saving && (dirty || changedMeanwhile);
	const save = () => {
		if (!draft || !canSave) return;
		// Already known to have changed: don't send, ask (the server would refuse it anyway).
		if (changedMeanwhile) {
			setConflict(true);
			return;
		}
		send(draft.text, draft.base);
	};

	const mem = mine.memory;
	const head = (
		<div className="notebook-head">
			<span className="notebook-title" title={identity.id}>
				{t("notebookOf", { title: identity.title })}
			</span>
			{mem && (
				<span
					className={`notebook-sent${mem.sent > mem.cap ? " over" : ""}`}
					title={t("notebookSentTip")}
					data-sent={mem.sent}
					data-tokens={mem.tokens}
				>
					{t("notebookSent", { sent: fmt(mem.sent), cap: fmt(mem.cap), tokens: fmt(mem.tokens) })}
				</span>
			)}
		</div>
	);
	const rulesHead = (
		<div className="notebook-section-head">
			<span className="notebook-section-title" title={t("notebookRulesTip")}>
				{t("notebookRules")}
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
				{rulesHead}
				{text.trim() ? (
					<pre className="notebook-raw notebook-rules">{text}</pre>
				) : (
					<p className="notebook-empty">{t("notebookEmpty")}</p>
				)}
				{mem && <IndexSection mem={mem} t={t} />}
				{mem && <NotesSection notes={mine.notes} counts={mem.counts} query={query} setQuery={setQuery} t={t} />}
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
			{rulesHead}
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
								disabled={saving || blocked}
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

/** identity-notes: the notes index as sent, with its size against its budget. */
function IndexSection({ mem, t }: { mem: UiRoleMemory; t: Translate }) {
	const notes = [
		mem.hidden > 0 ? t("notebookIndexHidden", { n: fmt(mem.hidden) }) : "",
		mem.over ? t("notebookIndexOver", { full: fmt(mem.indexFull) }) : "",
	].filter(Boolean);
	return (
		<div className="notebook-section notebook-index-section">
			<div className="notebook-section-head">
				<span className="notebook-section-title" title={t("notebookIndexTip")}>
					{t("notebookIndex")}
				</span>
				<span
					className={`notebook-index-size${mem.over ? " over" : ""}`}
					data-size={mem.indexSize}
					data-full={mem.indexFull}
				>
					{t("notebookIndexSize", { size: fmt(mem.indexSize), budget: fmt(mem.indexBudget) })}
				</span>
			</div>
			{notes.length > 0 && <p className="notebook-index-note">{notes.join("; ")}</p>}
			{mem.index ? (
				<pre className="notebook-raw notebook-index">{mem.index}</pre>
			) : (
				<p className="notebook-empty">{t("notebookIndexEmpty")}</p>
			)}
		</div>
	);
}

/** identity-notes: the notes, listed or searched, and the one open. */
function NotesSection({
	notes,
	counts,
	query,
	setQuery,
	t,
}: {
	notes: NonNullable<ReturnType<typeof useNotebook>>["notes"];
	counts: UiRoleMemory["counts"];
	query: string;
	setQuery: (q: string) => void;
	t: Translate;
}) {
	const shown = notes.hits.length;
	let list: React.ReactNode;
	if (notes.status === "error") {
		list = <p className="notebook-empty">{t("notebookError", { error: notes.error || "?" })}</p>;
	} else if (notes.status !== "ready" && !shown) {
		list = <p className="notebook-empty">{t("notebookLoading")}</p>;
	} else if (!shown) {
		list = (
			<p className="notebook-empty notebook-notes-none">
				{notes.query ? t("notebookSearchNone", { query: notes.query }) : t("notebookNotesNone")}
			</p>
		);
	} else {
		list = (
			<>
				<ul className="notebook-notes" data-query={notes.query} data-status={notes.status}>
					{notes.hits.map((h) => (
						<li key={h.ref}>
							<button type="button" className="notebook-note-row" data-ref={h.ref} onClick={() => openNote(h.ref)}>
								<span className="notebook-note-line">{noteRowText(h)}</span>
								{h.preview && h.preview.toLowerCase() !== h.summary.toLowerCase() && (
									<span className="notebook-note-preview">{h.preview}</span>
								)}
							</button>
						</li>
					))}
				</ul>
				{!notes.query && notes.total > shown && (
					<p className="notebook-hint">{t("notebookNotesMore", { shown: fmt(shown), total: fmt(notes.total) })}</p>
				)}
			</>
		);
	}
	return (
		<div className="notebook-section notebook-notes-section">
			<div className="notebook-section-head">
				<span className="notebook-section-title">{t("notebookNotes")}</span>
				<span className="notebook-notes-counts">
					{t("notebookNotesCounts", {
						notes: fmt(counts.notes),
						digests: fmt(counts.digests),
						outdated: fmt(counts.outdated),
						rules: fmt(counts.rules),
					})}
				</span>
			</div>
			<form
				className="notebook-search"
				onSubmit={(e) => {
					e.preventDefault();
					searchNotes(query);
				}}
			>
				<input
					type="search"
					className="notebook-search-input"
					aria-label={t("notebookSearchLabel")}
					placeholder={t("notebookSearchPlaceholder")}
					maxLength={500}
					value={query}
					onChange={(e) => setQuery(e.target.value)}
				/>
				<button type="submit" className="identity-btn notebook-search-btn">
					{t("notebookSearch")}
				</button>
				{notes.query && (
					<button
						type="button"
						className="identity-btn notebook-search-all"
						onClick={() => {
							setQuery("");
							searchNotes("");
						}}
					>
						{t("notebookSearchAll")}
					</button>
				)}
			</form>
			{notes.deleted && (
				<p className="notebook-note notebook-note-deleted" role="status">
					{t("notebookNoteDeleted", { ref: notes.deleted })}
				</p>
			)}
			{notes.open ? <NoteView key={notes.open.ref} open={notes.open} t={t} /> : list}
		</div>
	);
}

/** identity-notes: one note, whole, raw; edit or delete it (an old archive stretch is read-only). */
function NoteView({ open, t }: { open: OpenNote; t: Translate }) {
	const [draft, setDraft] = useState<string | null>(null);
	const [confirm, setConfirm] = useState(false);
	const done = open.done;
	// Saved: back to the note (read again by the store).
	useEffect(() => {
		if (done?.ok) setDraft(null);
	}, [done]);

	if (open.status === "loading") return <p className="notebook-empty">{t("notebookLoading")}</p>;
	if (open.status === "error") {
		return (
			<div className="notebook-open" data-ref={open.ref}>
				<p className="notebook-empty">{t("notebookNoteError", { ref: open.ref, error: open.error || "?" })}</p>
				<div className="notebook-actions">
					<button type="button" className="identity-btn notebook-note-close" onClick={closeNote}>
						{t("notebookNoteClose")}
					</button>
				</div>
			</div>
		);
	}
	const busy = open.busy !== null;
	const failed = done && !done.ok ? done : null;
	const why = failed
		? failed.code === "changed"
			? t("notebookNoteChanged")
			: failed.code === "invalid"
				? ""
				: t(SAVE_ERROR_KEY[failed.code] ?? "identitySaveIo")
		: "";
	return (
		<div className="notebook-open" data-ref={open.ref} data-hash={open.hash}>
			<div className="notebook-actions">
				{open.editable && draft === null && !confirm && (
					<>
						<button
							type="button"
							className="identity-btn notebook-note-edit"
							disabled={busy}
							onClick={() => setDraft(open.text ?? "")}
						>
							{t("notebookEdit")}
						</button>
						<button
							type="button"
							className="identity-btn notebook-note-delete"
							disabled={busy}
							onClick={() => setConfirm(true)}
						>
							{t("notebookNoteDelete")}
						</button>
					</>
				)}
				{draft === null && (
					<button type="button" className="identity-btn notebook-note-close" disabled={busy} onClick={closeNote}>
						{t("notebookNoteClose")}
					</button>
				)}
				{!open.editable && <span className="notebook-note">{t("notebookNoteOld")}</span>}
				{done?.ok && draft === null && (
					<span className="notebook-note" role="status">
						{t("identitySaved")}
					</span>
				)}
			</div>
			{confirm && (
				<div className="notebook-conflict notebook-delete-confirm" role="alert">
					<p>{t("notebookNoteDeleteConfirm", { ref: open.ref })}</p>
					<div className="notebook-actions">
						<button
							type="button"
							className="identity-btn notebook-note-delete-yes"
							disabled={busy}
							onClick={() => {
								if (deleteOpenNote()) setConfirm(false);
							}}
						>
							{t("notebookNoteDelete")}
						</button>
						<button
							type="button"
							className="identity-btn notebook-note-delete-no"
							disabled={busy}
							onClick={() => setConfirm(false)}
						>
							{t("notebookCancel")}
						</button>
					</div>
				</div>
			)}
			{draft === null ? (
				<pre className="notebook-raw notebook-note-text">{open.text}</pre>
			) : (
				<>
					<textarea
						className="notebook-editor notebook-note-editor"
						aria-label={open.ref}
						spellCheck={false}
						value={draft}
						onChange={(e) => setDraft(e.target.value)}
						onKeyDown={(e) => {
							if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
								e.preventDefault();
								if (!busy && draft !== open.text) saveOpenNote(draft);
							}
						}}
					/>
					{failed?.problems && failed.problems.length > 0 && (
						<ul className="notebook-problems">
							{failed.problems.map((p) => (
								<li key={p}>{p}</li>
							))}
						</ul>
					)}
					<div className="notebook-actions">
						<button
							type="button"
							className="set-save-btn notebook-save notebook-note-save"
							disabled={busy || draft === open.text}
							onClick={() => saveOpenNote(draft)}
						>
							{open.busy === "save" ? t("identitySaving") : t("save")}
						</button>
						<button
							type="button"
							className="identity-btn notebook-note-cancel"
							disabled={busy}
							onClick={() => setDraft(null)}
						>
							{t("notebookCancel")}
						</button>
						<span className="notebook-note" role="status">
							{why || (draft !== open.text ? t("notebookUnsaved") : "")}
						</span>
					</div>
				</>
			)}
			{draft === null && why && <p className="notebook-over">{why}</p>}
		</div>
	);
}
