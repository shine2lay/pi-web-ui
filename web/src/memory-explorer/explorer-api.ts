/**
 * The Memory explorer's one seam to the server (design #316).
 *
 * Every screen part reads memory through this interface only, so the page is bound to what the
 * owner sees and not to a route's shape. The routes behind it are Architecture's contract
 * (`.temper/features/openviking-dashboard/spec-explorer*.md`); `explorer-http.ts` implements this
 * interface against them. Fixtures implement it in tests only (rule 29): no sample branch here.
 */

import type { OpenVikingExplorerKind, OpenVikingExplorerRootGroup } from "../../../server/openviking/explorer-types.js";

/** What a note is, read by the server from where it is kept (`preferences/` = rules, ...). */
export type NoteKind = OpenVikingExplorerKind;
export const NOTE_KINDS: readonly NoteKind[] = ["rule", "case", "fact", "event", "document", "other"];
export type KindCounts = Partial<Record<NoteKind, number>>;

/** The three groups of places in the tree: shared by every chat, project documents, each department's own. */
export type RootGroup = OpenVikingExplorerRootGroup;

/** One top-level place memory keeps notes (one of the roots the server lists). */
export interface MemoryRoot {
	readonly uri: string;
	readonly group: RootGroup;
	/** The department, for a department's place; else null. */
	readonly role: string | null;
	/** false: the place didn't answer, so it isn't counted (its counts are null, never 0). */
	readonly read: boolean;
	/** Notes (files) inside, the same count the health line sums (G1); null = not counted. */
	readonly noteCount: number | null;
	readonly kindCounts: KindCounts | null;
}

/** Why a summary is missing: not written yet, never written, or a locked setup file. */
export type TextReason = "not_ready" | "none" | "locked";

/** A note or a folder as it appears in a list: tree, results, folder contents, recent changes. */
export interface MemoryItem {
	readonly uri: string;
	readonly isFolder: boolean;
	readonly kind: NoteKind;
	/** A department's setup file (identity.md, soul.md): not opened or changed here (G8). */
	readonly locked: boolean;
	/** Stored length in bytes; null when the store did not say. */
	readonly size: number | null;
	/** ISO time of the last change; for a folder, the newest change inside. */
	readonly changedAt: string | null;
	/** The stored one-line summary (level 1), raw as stored (may hold markdown marks); null = none. */
	readonly summary: string | null;
	/** Folders only: notes inside at any depth; null = too many to count. */
	readonly noteCount?: number | null;
	/** Places only: notes inside by kind. */
	readonly kindCounts?: KindCounts | null;
}

/** A folder opened in the reader. */
export interface FolderListing {
	readonly folder: MemoryItem;
	/** Level 2: the folder's overview page; null = none written. */
	readonly overview: string | null;
	/** Direct children, newest first. */
	readonly items: readonly MemoryItem[];
	/** Direct children in all, so the page can offer "Show more". */
	readonly total: number;
	/** Pass back to read the next page of children; null = no more. */
	readonly nextCursor: string | null;
}

/** A note opened in the reader: the levels memory keeps. */
export interface NoteDetail {
	readonly item: MemoryItem;
	/** Whose one-line summary `item.summary` is: the note's own, or the folder it sits in (D1); null = none. */
	readonly summaryOf: string | null;
	/** A department's setup file (identity.md, soul.md): text not shown, no edit or delete (G8). */
	readonly locked: boolean;
	/** Level 2: the overview of the folder the note sits in; null = none written. */
	readonly overview: string | null;
	/** Level 3: the note itself; null when locked. */
	readonly fullText: string | null;
	/** Who last saved it, from memory's change record ("design", "owner"); null = not recorded. */
	readonly changedBy: string | null;
}

export type SearchMode = "meaning" | "words";
/** "all" or one root's uri. */
export type SearchScope = string;

export interface SearchRequest {
	readonly mode: SearchMode;
	readonly query: string;
	readonly scope: SearchScope;
	readonly limit: number;
}

export interface SearchHit {
	readonly item: MemoryItem;
	/** By meaning: the store's closeness score. */
	readonly score?: number;
	/** By meaning: the score against this answer's best hit (0-1), worked out once by the server. */
	readonly relative?: number;
	/** Exact words: the matching line and its number. */
	readonly line?: string;
	readonly lineNumber?: number;
}

export interface SearchAnswer {
	readonly hits: readonly SearchHit[];
	/** Places that couldn't be searched (didn't answer, or need the owner's sign-in); 0 = all searched. */
	readonly missedPlaces: number;
}

export type HealthState = "up" | "degraded" | "down";

export interface MemoryHealth {
	readonly state: HealthState;
	readonly checkedAt: string;
	/** Newest save anywhere in memory. */
	readonly lastSaveAt: string | null;
	/** Notes (files) in the tree (G1); null = not counted. */
	readonly totalNotes: number | null;
	/** Down only: when memory was last seen up. */
	readonly lastSeenUpAt: string | null;
}

export type ChangeAction = "edit" | "delete";

/** One owner change, as memory's change record keeps it (G7). */
export interface ChangeRecord {
	readonly id: string;
	readonly action: ChangeAction;
	readonly uri: string;
	readonly at: string;
	readonly undone: boolean;
	/** Until when Undo still works; null once it can't. */
	readonly undoUntil: string | null;
}

export type ExplorerErrorCode =
	| "MEMORY_DOWN"
	| "OWNER_ONLY"
	| "CHANGED_SINCE_OPENED"
	| "LOCKED"
	| "OUTSIDE_ROOTS"
	| "NOT_FOUND"
	| "UNDO_EXPIRED"
	| "FAILED";

export class ExplorerApiError extends Error {
	constructor(
		readonly code: ExplorerErrorCode,
		message: string,
	) {
		super(message);
		this.name = "ExplorerApiError";
	}
}

export interface MemoryExplorerApi {
	health(signal?: AbortSignal): Promise<MemoryHealth>;
	roots(signal?: AbortSignal): Promise<readonly MemoryRoot[]>;
	/** A folder's direct children (tree on open, folder reader). */
	folder(uri: string, cursor: string | null, signal?: AbortSignal): Promise<FolderListing>;
	/** Notes changed most recently, newest first. */
	recent(scope: SearchScope, limit: number, signal?: AbortSignal): Promise<readonly MemoryItem[]>;
	read(uri: string, signal?: AbortSignal): Promise<NoteDetail>;
	search(request: SearchRequest, signal?: AbortSignal): Promise<SearchAnswer>;
	/**
	 * Replace a note's full text; refused with CHANGED_SINCE_OPENED when `changedAt` is no longer current.
	 * null: the text was already this, so nothing was written.
	 */
	save(uri: string, fullText: string, changedAt: string | null): Promise<ChangeRecord | null>;
	/** Held for the undo window, then deleted by the server. */
	remove(uri: string): Promise<ChangeRecord>;
	undo(changeId: string): Promise<void>;
	/** The owner's own changes, newest first, read back from memory's change record. */
	changes(signal?: AbortSignal): Promise<readonly ChangeRecord[]>;
}

export function errorCode(error: unknown): ExplorerErrorCode {
	return error instanceof ExplorerApiError ? error.code : "FAILED";
}
