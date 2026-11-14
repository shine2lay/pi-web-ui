/**
 * The Memory explorer's seam over HTTP (design #316): `MemoryExplorerApi` against the explorer routes
 * of Architecture's contract (`.temper/features/openviking-dashboard/spec-explorer*.md`, G1-G7):
 * `/api/openviking/{overview,tree/roots,tree,note,search,undo,audit}`.
 *
 * Health, the places and the recent list come from one `tree/roots` answer, shared for a few seconds
 * so the first screen asks the server once. Reads ride the owner's passkey session cookie; each write
 * carries `X-Owner-Write: 1` and a passkey assertion bound to that exact operation, which the page's
 * owner sign-in supplies (`ownerAssertion`, spec-explorer-owner.md); the browser adds the `Origin`.
 */

import type {
	OpenVikingAuditResponse,
	OpenVikingOverviewResponse,
} from "../../../server/openviking/types.js";
import type {
	OpenVikingNoteDeleteResponse,
	OpenVikingNoteEditResponse,
	OpenVikingNoteResponse,
	OpenVikingSearchHit,
	OpenVikingSearchResponse,
	OpenVikingTreeChild,
	OpenVikingTreeFolderResponse,
	OpenVikingTreeRootsResponse,
} from "../../../server/openviking/explorer-types.js";
import {
	OWNER_ASSERTION_HEADER,
	OWNER_WRITE_HEADER,
	type OwnerWriteOp,
} from "../../../server/openviking/owner-session-types.js";
import { appUrl } from "../base-url";
import {
	type ChangeRecord,
	ExplorerApiError,
	type ExplorerErrorCode,
	type FolderListing,
	type MemoryExplorerApi,
	type MemoryHealth,
	type MemoryItem,
	type MemoryRoot,
	type NoteDetail,
	type SearchAnswer,
	type SearchHit,
	type SearchRequest,
} from "./explorer-api.js";

const API = "/api/openviking";
/** One `tree/roots` answer serves health, the places and the recent list asked within this time. */
const ROOTS_SHARED_MS = 5_000;
const FOLDER_PAGE = 30;
const CHANGES_LIMIT = 50;

/** The server's refusal codes, in the page's words (spec-explorer.md "Errors", explorer-types.ts). */
const CODES: Readonly<Record<string, ExplorerErrorCode>> = {
	MEMORY_UNREACHABLE: "MEMORY_DOWN",
	OWNER_ONLY: "OWNER_ONLY",
	NOTE_CHANGED: "CHANGED_SINCE_OPENED",
	UNDO_REFUSED: "CHANGED_SINCE_OPENED",
	SETUP_FILE_LOCKED: "LOCKED",
	URI_INVALID: "OUTSIDE_ROOTS",
	URI_OUTSIDE_ROOTS: "OUTSIDE_ROOTS",
	NOT_FOUND: "NOT_FOUND",
	UNDO_WINDOW_CLOSED: "UNDO_EXPIRED",
	OPERATION_UNKNOWN: "UNDO_EXPIRED",
};

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

export interface HttpExplorerOptions {
	/** The browser's `fetch` unless given. */
	readonly fetch?: Fetch;
	/** The browser's clock unless given. */
	readonly now?: () => number;
	/**
	 * The owner confirms one write with his passkey: asks `owner/write/options` for a challenge bound
	 * to `op`, runs the browser's passkey prompt, and answers the `X-Owner-Assertion` value. Without
	 * it every write is refused before anything is sent.
	 */
	readonly ownerAssertion?: (op: OwnerWriteOp) => Promise<string>;
}

/** Lowercase hex sha256 of the exact body bytes a write sends (the op's `body_sha256`). */
export async function sha256Hex(body: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body));
	return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

async function refusal(response: Response): Promise<ExplorerApiError> {
	let code = "";
	let message = `Memory answered ${response.status}.`;
	try {
		const body = (await response.json()) as { error?: { code?: string; message?: string } };
		code = body.error?.code ?? "";
		if (body.error?.message) message = body.error.message;
	} catch {
		/* not JSON: the status line above stands */
	}
	return new ExplorerApiError(CODES[code] ?? "FAILED", message);
}

export function rootFromRow(row: OpenVikingTreeRootsResponse["roots"][number]): MemoryRoot {
	return {
		uri: row.uri,
		group: row.group,
		role: row.role,
		read: row.read,
		noteCount: row.notes,
		kindCounts: row.kinds,
	};
}

export function itemFromChild(child: OpenVikingTreeChild): MemoryItem {
	return {
		uri: child.uri,
		isFolder: child.is_folder,
		kind: child.kind,
		locked: child.locked,
		size: child.size,
		changedAt: child.mod_time,
		summary: child.abstract,
		...(child.is_folder ? { noteCount: child.notes } : {}),
	};
}

export function listingFromFolder(
	answer: OpenVikingTreeFolderResponse,
	overview: string | null,
	offset: number,
	root: MemoryRoot | undefined,
): FolderListing {
	const next = offset + answer.children.length;
	return {
		folder: {
			uri: answer.uri,
			isFolder: true,
			kind: "other",
			locked: false,
			size: null,
			changedAt: answer.last_change,
			summary: answer.abstract,
			noteCount: answer.notes,
			kindCounts: root?.uri === answer.uri ? root.kindCounts : null,
		},
		overview,
		items: answer.children.map(itemFromChild),
		total: answer.total,
		nextCursor: next < answer.total && answer.children.length > 0 ? String(next) : null,
	};
}

export function hitFromSearch(hit: OpenVikingSearchHit): SearchHit {
	const item: MemoryItem = {
		uri: hit.uri,
		isFolder: false,
		kind: hit.kind,
		locked: false,
		size: hit.size,
		changedAt: hit.mod_time,
		summary: hit.abstract,
	};
	return hit.line_text === null
		? { item, score: hit.score ?? undefined, relative: hit.relative ?? undefined }
		: { item, line: hit.line_text, lineNumber: hit.line_number ?? undefined };
}

/** Memory's own health word, plus places that didn't answer, as the page's three states. */
export function healthOf(
	overview: OpenVikingOverviewResponse,
	roots: OpenVikingTreeRootsResponse | null,
): MemoryHealth {
	const down = overview.health_state === "server-unreachable";
	const degraded = overview.health_state === "stale" || roots === null || roots.roots_partial;
	return {
		state: down ? "down" : degraded ? "degraded" : "up",
		checkedAt: overview.observer.checked_at,
		lastSaveAt: overview.observer.last_commit_at,
		totalNotes: roots?.notes_total ?? null,
		lastSeenUpAt: overview.observer.last_reachable_at,
	};
}

/** The owner's changes from the change record; `owner_undo` lines are not events (G7). */
export function changesFromAudit(answer: OpenVikingAuditResponse): ChangeRecord[] {
	return answer.events.flatMap((event): ChangeRecord[] => {
		if (event.action !== "owner_edit" && event.action !== "owner_delete") return [];
		// A delete the owner took back never happened; one cut off by a restart didn't either.
		if (event.action === "owner_delete" && event.outcome !== "applied" && event.outcome !== "cancelled") return [];
		return [
			{
				id: event.operation_id ?? event.id,
				action: event.action === "owner_edit" ? "edit" : "delete",
				uri: event.uri,
				at: event.ts,
				undone: event.undone === true || event.outcome === "cancelled",
				undoUntil: null,
			},
		];
	});
}

export function createHttpExplorerApi(options: HttpExplorerOptions = {}): MemoryExplorerApi {
	const fetchImpl: Fetch = options.fetch ?? ((input, init) => fetch(input, init));
	const now = options.now ?? Date.now;
	let shared: { at: number; answer: Promise<OpenVikingTreeRootsResponse> } | null = null;

	async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
		const response = await fetchImpl(appUrl(`${API}${path}`), {
			...init,
			headers: { accept: "application/json", ...init.headers },
		});
		if (!response.ok) throw await refusal(response);
		return (await response.json()) as T;
	}
	/**
	 * One write: the owner confirms this exact operation with his passkey first (R-OWNER-WRITE-2), then
	 * the request goes with the same bytes the confirmation was bound to.
	 */
	async function write<T>(path: string, op: OwnerWriteOp, body: string | undefined): Promise<T> {
		if (!options.ownerAssertion) throw new ExplorerApiError("OWNER_ONLY", "Owner sign-in isn't set up on this page.");
		const assertion = await options.ownerAssertion(op);
		return call<T>(path, {
			method: op.method,
			headers: {
				"content-type": "application/json",
				[OWNER_WRITE_HEADER]: "1",
				[OWNER_ASSERTION_HEADER]: assertion,
			},
			...(body === undefined ? {} : { body }),
		});
	}

	/** Not tied to one caller's signal: health, places and recent share it. */
	function treeRoots(): Promise<OpenVikingTreeRootsResponse> {
		if (shared && now() - shared.at < ROOTS_SHARED_MS) return shared.answer;
		const answer = call<OpenVikingTreeRootsResponse>("/tree/roots");
		const entry = { at: now(), answer };
		shared = entry;
		answer.catch(() => {
			if (shared === entry) shared = null;
		});
		return answer;
	}
	const roots = async () => (await treeRoots()).roots.map(rootFromRow);
	const note = (uri: string, level: string, signal?: AbortSignal) =>
		call<OpenVikingNoteResponse>(`/note?uri=${encodeURIComponent(uri)}&level=${level}`, { signal });

	async function searchIn(request: SearchRequest, places: readonly string[], signal?: AbortSignal) {
		return call<OpenVikingSearchResponse>("/search", {
			method: "POST",
			signal,
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				mode: request.mode === "words" ? "exact" : "meaning",
				query: request.query,
				roots: places,
				limit: request.limit,
			}),
		});
	}

	return {
		async health(signal) {
			const [overview, tree] = await Promise.allSettled([
				call<OpenVikingOverviewResponse>("/overview", { signal }),
				treeRoots(),
			]);
			if (overview.status === "rejected") throw overview.reason;
			return healthOf(overview.value, tree.status === "fulfilled" ? tree.value : null);
		},
		roots: () => roots(),
		async recent(scope, limit) {
			const { recent } = await treeRoots();
			return recent
				.filter((r) => scope === "all" || r.root === scope)
				.slice(0, limit)
				.map((r) => ({
					uri: r.uri,
					isFolder: false,
					kind: r.kind,
					locked: r.locked,
					size: r.size,
					changedAt: r.mod_time,
					summary: null,
				}));
		},
		async folder(uri, cursor, signal) {
			const offset = cursor === null ? 0 : Number(cursor);
			const query = `uri=${encodeURIComponent(uri)}&offset=${offset}&limit=${FOLDER_PAGE}`;
			const [answer, overview, places] = await Promise.all([
				call<OpenVikingTreeFolderResponse>(`/tree?${query}`, { signal }),
				// Only the first page shows the folder's overview; a missing one never fails the listing.
				offset === 0 ? note(uri, "overview", signal).then((n) => n.text, () => null) : Promise.resolve(null),
				roots().catch(() => []),
			]);
			return listingFromFolder(answer, overview, offset, places.find((r) => r.uri === uri));
		},
		async read(uri, signal): Promise<NoteDetail> {
			try {
				// A note's own one-line summary exists only in search hits; the store answers its folder's (D1).
				const [full, overview, abstract] = await Promise.all([
					note(uri, "full", signal),
					note(uri, "overview", signal).then((n) => n.text, () => null),
					note(uri, "abstract", signal).then(
						(n) => n,
						() => null,
					),
				]);
				return {
					item: {
						uri,
						isFolder: false,
						kind: full.kind,
						locked: false,
						size: full.size,
						changedAt: full.mod_time,
						summary: abstract?.text ?? null,
					},
					summaryOf: abstract?.text_of ?? null,
					locked: false,
					overview,
					fullText: full.text,
					changedBy: full.last_write?.role ?? null,
				};
			} catch (error) {
				if (!(error instanceof ExplorerApiError) || error.code !== "LOCKED") throw error;
				const item: MemoryItem = {
					uri,
					isFolder: false,
					kind: "other",
					locked: true,
					size: null,
					changedAt: null,
					summary: null,
				};
				return { item, summaryOf: null, locked: true, overview: null, fullText: null, changedBy: null };
			}
		},
		async search(request, signal): Promise<SearchAnswer> {
			const places = request.scope === "all" ? (await roots()).map((r) => r.uri) : [request.scope];
			let skipped = 0;
			let answer: OpenVikingSearchResponse;
			try {
				answer = await searchIn(request, places, signal);
			} catch (error) {
				// Department notes need the owner's sign-in; search everywhere else and say what was left out.
				if (request.scope !== "all" || !(error instanceof ExplorerApiError) || error.code !== "OWNER_ONLY") throw error;
				const open = (await roots()).filter((r) => r.group !== "department").map((r) => r.uri);
				skipped = places.length - open.length;
				answer = await searchIn(request, open, signal);
			}
			return { hits: answer.hits.map(hitFromSearch), missedPlaces: answer.unread_count + skipped };
		},
		async save(uri, fullText, changedAt) {
			// Without the time it was opened at, the server can't tell whether someone saved since.
			if (changedAt === null) throw new ExplorerApiError("CHANGED_SINCE_OPENED", "Open the note again first.");
			const body = JSON.stringify({ uri, content: fullText, opened_mod_time: changedAt });
			const op = { method: "PUT", uri, opened_mod_time: changedAt, body_sha256: await sha256Hex(body) } as const;
			const answer = await write<OpenVikingNoteEditResponse>("/note", op, body);
			if (!answer.changed) return null;
			shared = null;
			return {
				id: answer.operation_id,
				action: "edit",
				uri,
				at: answer.mod_time,
				undone: false,
				undoUntil: answer.undo_until,
			};
		},
		async remove(uri) {
			const op = { method: "DELETE", uri, body_sha256: await sha256Hex("") } as const;
			const answer = await write<OpenVikingNoteDeleteResponse>(`/note?uri=${encodeURIComponent(uri)}`, op, undefined);
			shared = null;
			return {
				id: answer.operation_id,
				action: "delete",
				uri,
				at: new Date(now()).toISOString(),
				undone: false,
				undoUntil: answer.applies_at,
			};
		},
		async undo(changeId) {
			const body = JSON.stringify({ operation_id: changeId });
			await write("/undo", { method: "POST", operation_id: changeId }, body);
			shared = null;
		},
		async changes(signal) {
			return changesFromAudit(
				await call<OpenVikingAuditResponse>(`/audit?owner_only=true&limit=${CHANGES_LIMIT}`, { signal }),
			);
		},
	};
}
