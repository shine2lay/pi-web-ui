/**
 * A fake memory store behind the explorer's seam, for the Memory explorer's tests only (rule 29).
 *
 * Small, but shaped like the real snapshot design #315 read: three kinds of place (shared, project
 * documents, department notes), raw markdown in stored summaries, a setup file, folders without a
 * summary. Every call is a vi.fn so a test can see what the page asked for, and each can be made to
 * hang (loading) or fail (memory down, save fails).
 */

import { vi } from "vitest";
import {
	ExplorerApiError,
	type ChangeRecord,
	type FolderListing,
	type MemoryExplorerApi,
	type MemoryHealth,
	type MemoryItem,
	type MemoryRoot,
	type NoteDetail,
	type SearchHit,
	type SearchRequest,
} from "../../../web/src/memory-explorer/explorer-api.js";

export const NOW = "2026-11-14T01:25:00.000Z";
export const NOW_MS = Date.parse(NOW);
const minutesAgo = (m: number) => new Date(NOW_MS - m * 60_000).toISOString();

export const SHARED = "viking://user/default/memories";
export const PROJECTS = "viking://resources";
export const DESIGN = "viking://user/design/memories";
export const OPS = "viking://user/ops/memories";

export const RULE_URI = `${SHARED}/preferences/ui_ux_design.md`;
export const EVENT_URI = `${SHARED}/events/2026/11/12/marketing_copy_assigned.md`;
export const CASE_URI = `${DESIGN}/cases/c12-memory-redesign.md`;
export const SETUP_URI = `${DESIGN}/identity.md`;
export const DOC_URI = `${PROJECTS}/pi-web-ui/README.md`;

/** A stored one-line summary exactly as the store keeps it: markdown marks and all. */
export const RAW_CASE_SUMMARY =
	"# Case: memory page redesign\n**Role:** design. Owner wants a `search-first` explorer.";
export const CASE_FULL_TEXT =
	"# Case: memory page redesign\n\n**Role:** design\n\n- Owner asked to find things\n- Picked P";

function note(uri: string, minutes: number, size: number, summary: string | null): MemoryItem {
	return { uri, isFolder: false, size, changedAt: minutesAgo(minutes), summary };
}
function folder(uri: string, minutes: number, noteCount: number, summary: string | null): MemoryItem {
	return { uri, isFolder: true, size: null, changedAt: minutesAgo(minutes), summary, noteCount, kindCounts: {} };
}

export const NOTES: readonly MemoryItem[] = [
	note(CASE_URI, 4, 2400, RAW_CASE_SUMMARY),
	note(EVENT_URI, 30, 600, "On 2026-11-12, Marketing task #26 was assigned landing-page copy."),
	note(RULE_URI, 90, 5200, "# Shared Craft Preferences: ui_ux_design\n- **Owner** wants findings rated 0-4"),
	note(DOC_URI, 600, 9000, "pi-web-ui L0 abstract: the fork's architecture and patches."),
	note(`${OPS}/preferences/deploy.md`, 1500, 800, null),
	note(SETUP_URI, 3000, 1200, null),
];

export const ROOTS: readonly MemoryRoot[] = [
	{ uri: SHARED, group: "shared", noteCount: 2, kindCounts: { rule: 1, event: 1 } },
	{ uri: PROJECTS, group: "projects", noteCount: 1, kindCounts: { doc: 1 } },
	{ uri: DESIGN, group: "department", noteCount: 2, kindCounts: { case: 1, other: 1 } },
	{ uri: OPS, group: "department", noteCount: 1, kindCounts: { rule: 1 } },
];

const FOLDERS: Record<string, MemoryItem[]> = {
	[SHARED]: [
		folder(`${SHARED}/events`, 30, 1, null),
		folder(`${SHARED}/preferences`, 90, 1, "Rules every chat follows."),
	],
	[`${SHARED}/preferences`]: [NOTES[2]],
	[`${SHARED}/events`]: [],
	[PROJECTS]: [folder(`${PROJECTS}/pi-web-ui`, 600, 1, "pi-web-ui L0 abstract: fork architecture")],
	[`${PROJECTS}/pi-web-ui`]: [NOTES[3]],
	[DESIGN]: [folder(`${DESIGN}/cases`, 4, 1, null), NOTES[5]],
	[`${DESIGN}/cases`]: [NOTES[0]],
	[OPS]: [folder(`${OPS}/preferences`, 1500, 1, null)],
	[`${OPS}/preferences`]: [NOTES[4]],
};

export const MEANING_HITS: readonly SearchHit[] = [
	{ item: NOTES[0], score: 0.886 },
	{ item: NOTES[2], score: 0.871 },
	{ item: NOTES[1], score: 0.84 },
];
export const WORD_HITS: readonly SearchHit[] = [
	{ item: NOTES[0], line: "- Owner asked to find things", lineNumber: 5 },
];

export interface FakeOptions {
	health?: MemoryHealth["state"];
	/** Calls that never answer (loading). */
	hang?: ReadonlyArray<keyof MemoryExplorerApi>;
	/** Calls that fail with this code. */
	fail?: Partial<Record<keyof MemoryExplorerApi, ExplorerApiError["code"]>>;
	/** No notes anywhere (empty memory). */
	empty?: boolean;
}

export type FakeApi = { [K in keyof MemoryExplorerApi]: ReturnType<typeof vi.fn> & MemoryExplorerApi[K] };

export function fakeApi(options: FakeOptions = {}): FakeApi {
	let changeSeq = 0;
	const changes: ChangeRecord[] = [];
	const guard = <T>(name: keyof MemoryExplorerApi, answer: () => T): Promise<T> => {
		if (options.hang?.includes(name)) return new Promise<T>(() => {});
		const code = options.fail?.[name];
		if (code) return Promise.reject(new ExplorerApiError(code, `${name} failed`));
		return Promise.resolve().then(answer);
	};
	const record = (action: ChangeRecord["action"], uri: string): ChangeRecord => {
		const change: ChangeRecord = {
			id: `ch-${++changeSeq}`,
			action,
			uri,
			at: NOW,
			undone: false,
			undoUntil: new Date(NOW_MS + 10_000).toISOString(),
		};
		changes.unshift(change);
		return change;
	};
	const api: MemoryExplorerApi = {
		health: () =>
			guard("health", () => ({
				state: options.health ?? "up",
				checkedAt: NOW,
				lastSaveAt: minutesAgo(4),
				totalNotes: options.empty ? 0 : 6,
				lastSeenUpAt: options.health === "down" ? minutesAgo(65) : null,
			})),
		roots: () =>
			guard("roots", () => (options.empty ? ROOTS.map((r) => ({ ...r, noteCount: 0, kindCounts: {} })) : ROOTS)),
		folder: (uri) =>
			guard("folder", (): FolderListing => {
				const items = options.empty ? [] : (FOLDERS[uri] ?? []);
				const self = ROOTS.some((r) => r.uri === uri)
					? folder(uri, 4, items.length, null)
					: (Object.values(FOLDERS)
							.flat()
							.find((i) => i.uri === uri) ?? folder(uri, 4, 0, null));
				return { folder: self, overview: null, items, total: items.length, nextCursor: null };
			}),
		recent: (scope, limit) =>
			guard("recent", () =>
				options.empty ? [] : NOTES.filter((n) => scope === "all" || n.uri.startsWith(`${scope}/`)).slice(0, limit),
			),
		read: (uri) =>
			guard("read", (): NoteDetail => {
				const item = NOTES.find((n) => n.uri === uri);
				if (!item) throw new ExplorerApiError("NOT_FOUND", `${uri} not found`);
				const locked = uri === SETUP_URI;
				return {
					item,
					locked,
					overview: uri === CASE_URI ? "## Design cases\nWhat Design learned, one case per file." : null,
					fullText: locked ? null : uri === CASE_URI ? CASE_FULL_TEXT : `Text of ${uri}`,
				};
			}),
		search: (request: SearchRequest) =>
			guard("search", () => {
				if (request.query.includes("nothing")) return [];
				const hits = request.mode === "meaning" ? MEANING_HITS : WORD_HITS;
				return hits.filter((h) => request.scope === "all" || h.item.uri.startsWith(`${request.scope}/`));
			}),
		save: (uri) => guard("save", () => record("edit", uri)),
		remove: (uri) => guard("remove", () => record("delete", uri)),
		undo: (id) =>
			guard("undo", () => {
				const i = changes.findIndex((c) => c.id === id);
				const undone = { ...changes[i], undone: true, undoUntil: null };
				changes[i] = undone;
				return undone;
			}),
	};
	for (const key of Object.keys(api) as (keyof MemoryExplorerApi)[]) {
		(api as unknown as Record<string, unknown>)[key] = vi.fn(api[key]);
	}
	return api as FakeApi;
}
