/**
 * The Memory explorer's one seam to the server (design #316).
 *
 * Every screen part reads memory through this interface only, so the page is bound to what the
 * owner sees and not to a route's shape. Shapes follow design #315's HANDOFF.md (gaps G1-G8);
 * Architecture's contract in `.temper/features/openviking-dashboard/spec.md` is the authority, and
 * the HTTP client that implements this interface is written against it.
 *
 * Fixtures implement it in tests only (rule 29): production code has no sample branch.
 */

/** What a note is, read from where it is kept (`preferences/` = rules, `events/` = events, ...). */
export type NoteKind = "rule" | "case" | "fact" | "event" | "doc" | "other";
export const NOTE_KINDS: readonly NoteKind[] = ["rule", "case", "fact", "event", "doc", "other"];
export type KindCounts = Partial<Record<NoteKind, number>>;

/** The three groups of places in the tree: shared by every chat, project documents, each department's own. */
export type RootGroup = "shared" | "projects" | "department";

/** One top-level place memory keeps notes (one of the roots the server lists). */
export interface MemoryRoot {
	readonly uri: string;
	readonly group: RootGroup;
	/** Notes (files) inside, the same count the health line sums (G1). */
	readonly noteCount: number;
	readonly kindCounts: KindCounts;
}

/** A note or a folder as it appears in a list: tree, results, folder contents, recent changes. */
export interface MemoryItem {
	readonly uri: string;
	readonly isFolder: boolean;
	/** Stored length in bytes; null when the store did not say. */
	readonly size: number | null;
	/** ISO time of the last change; for a folder, the newest change inside. */
	readonly changedAt: string | null;
	/** The stored one-line summary (level 1), raw as stored (may hold markdown marks); null = none written. */
	readonly summary: string | null;
	/** Folders only: notes inside, at any depth. */
	readonly noteCount?: number;
	/** Folders only: notes inside by kind. */
	readonly kindCounts?: KindCounts;
}

/** A folder opened in the reader. */
export interface FolderListing {
	readonly folder: MemoryItem;
	/** Level 2: the folder's overview page; null = none written. */
	readonly overview: string | null;
	/** Direct children: folders first, then notes, newest first. */
	readonly items: readonly MemoryItem[];
	/** Direct children in all, so the page can offer "Show more". */
	readonly total: number;
	/** Pass back to read the next page of children; null = no more. */
	readonly nextCursor: string | null;
}

/** A note opened in the reader: the three levels memory keeps. */
export interface NoteDetail {
	readonly item: MemoryItem;
	/** A department's setup file (identity.md, soul.md): text not shown, no edit or delete (G8). */
	readonly locked: boolean;
	/** Level 2: the overview of the folder the note sits in; null = none written. */
	readonly overview: string | null;
	/** Level 3: the note itself; null when locked. */
	readonly fullText: string | null;
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
	/** Exact words: the matching line and its number. */
	readonly line?: string;
	readonly lineNumber?: number;
}

export type HealthState = "up" | "degraded" | "down";

export interface MemoryHealth {
	readonly state: HealthState;
	readonly checkedAt: string;
	/** Newest save anywhere in memory. */
	readonly lastSaveAt: string | null;
	/** Notes (files) in the tree (G1). */
	readonly totalNotes: number | null;
	/** Down only: when memory was last seen up. */
	readonly lastSeenUpAt: string | null;
}

export type ChangeAction = "edit" | "delete";

/** One owner change, as kept in memory's change record (G7). */
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
	search(request: SearchRequest, signal?: AbortSignal): Promise<readonly SearchHit[]>;
	/** Replace a note's full text; refused with CHANGED_SINCE_OPENED when `changedAt` is no longer current. */
	save(uri: string, fullText: string, changedAt: string | null): Promise<ChangeRecord>;
	remove(uri: string): Promise<ChangeRecord>;
	undo(changeId: string): Promise<ChangeRecord>;
	/** The owner's changes from the change record, newest first. */
	changes(signal?: AbortSignal): Promise<readonly ChangeRecord[]>;
}

export function errorCode(error: unknown): ExplorerErrorCode {
	return error instanceof ExplorerApiError ? error.code : "FAILED";
}
