/**
 * The OpenViking Memory Dashboard tab (frontend #258, Task 2).
 *
 * The only part of the feature that talks to the network: it polls
 * `/api/openviking/{overview,entries,audit}` while the tab is open and hands the answers to the
 * presentational view. Each call is its own slice (frontend #273, M4 / #269 F2): overview paints the
 * header and cards the moment it answers, and a slow or failed entries or audit call holds or errors only
 * its own panel. A call still out when the next poll comes is left to finish, never restarted.
 *
 * The view, tab, open row and audit filters live in the URL's search parameters (#269 F6): while the tab
 * is shown the address carries `view=openviking`, which the shell reads at startup, so a reload or a
 * shared link opens the Memory tab on the same tab and row; leaving the tab takes `view` off again.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { appUrl } from "../base-url";
import type {
	OpenVikingAuditResponse,
	OpenVikingEntriesResponse,
	OpenVikingOverviewResponse,
} from "../../../server/openviking/types.js";
import {
	OpenVikingDashboardView,
	type OpenVikingAuditFilterSelection,
	type OpenVikingDashboardSnapshot,
	type OpenVikingEntryContent,
	type OpenVikingTabId,
} from "../openviking-dashboard";
import { OPENVIKING_TABS } from "../openviking-dashboard/text.js";
import "../openviking-dashboard/openviking-dashboard.css";

const POLL_MS = 30_000;
const VIEW_PARAM = "view";
const VIEW_VALUE = "openviking";
const TAB_PARAM = "ovtab";
const ROW_PARAM = "ovrow";
const ACTION_PARAM = "ovaction";
const ROLE_PARAM = "ovrole";

type SliceName = keyof OpenVikingDashboardSnapshot;
interface SliceData {
	readonly overview: OpenVikingOverviewResponse;
	readonly entries: OpenVikingEntriesResponse;
	readonly audit: OpenVikingAuditResponse;
}
const SLICE_PATHS: Record<SliceName, string> = {
	overview: "/api/openviking/overview",
	entries: "/api/openviking/entries",
	audit: "/api/openviking/audit",
};
const SLICES = Object.keys(SLICE_PATHS) as SliceName[];
const LOADING: OpenVikingDashboardSnapshot = {
	overview: { status: "loading" },
	entries: { status: "loading" },
	audit: { status: "loading" },
};

export interface OpenVikingDashboardPageProps {
	/** The tab is shown; it polls the server only then. */
	readonly active: boolean;
}

async function getJson<T>(path: string, signal: AbortSignal): Promise<T> {
	const response = await fetch(appUrl(path), { signal, headers: { accept: "application/json" } });
	if (!response.ok) throw await httpError(path, response);
	return (await response.json()) as T;
}

/** The server's `{ error: { code, message } }` body, so a 403 reads as isolation and not as "empty". */
async function httpError(path: string, response: Response): Promise<ContentFetchError> {
	let code = `HTTP_${response.status}`;
	let message = `${path} answered ${response.status}`;
	try {
		const body = (await response.json()) as { error?: { code?: string; message?: string } };
		if (body.error?.code) code = body.error.code;
		if (body.error?.message) message = body.error.message;
	} catch {
		/* a non-JSON body keeps the status-code fallback above */
	}
	return new ContentFetchError(code, message);
}

class ContentFetchError extends Error {
	constructor(
		readonly code: string,
		message: string,
	) {
		super(message);
		this.name = "ContentFetchError";
	}
}

export function OpenVikingDashboardPage({ active }: OpenVikingDashboardPageProps) {
	const [snapshot, setSnapshot] = useState<OpenVikingDashboardSnapshot>(LOADING);
	const [nowMs, setNowMs] = useState(() => Date.now());
	const [search, setSearch] = useState(() => readSearch());
	const [deepReadUri, setDeepReadUri] = useState<string | null>(null);
	const [entryContent, setEntryContent] = useState<OpenVikingEntryContent | null>(null);
	/** One AbortController per request still out, by slice; a slice with one out is not asked again. */
	const inFlight = useRef(new Map<SliceName, AbortController>());

	const loadSlice = useCallback(async (name: SliceName) => {
		if (inFlight.current.has(name)) return;
		const controller = new AbortController();
		inFlight.current.set(name, controller);
		try {
			const data = await getJson<SliceData[SliceName]>(SLICE_PATHS[name], controller.signal);
			if (controller.signal.aborted) return;
			setSnapshot((current) => ({ ...current, [name]: { status: "ready", data } }));
		} catch (error) {
			if (controller.signal.aborted) return;
			const message = error instanceof Error ? error.message : String(error);
			setSnapshot((current) => ({ ...current, [name]: { status: "failed", message } }));
		} finally {
			if (inFlight.current.get(name) === controller) inFlight.current.delete(name);
		}
		setNowMs(Date.now());
	}, []);

	useEffect(() => {
		if (!active) return;
		const requests = inFlight.current;
		const poll = () => {
			for (const name of SLICES) void loadSlice(name);
		};
		poll();
		const id = window.setInterval(poll, POLL_MS);
		return () => {
			window.clearInterval(id);
			for (const controller of requests.values()) controller.abort();
			requests.clear();
		};
	}, [active, loadSlice]);

	// While the tab is shown the address names it, so a reload lands here (#269 F6); leaving takes it off.
	const activeRef = useRef(active);
	activeRef.current = active;
	useEffect(() => {
		if (!active) return;
		setUrlParams({ [VIEW_PARAM]: VIEW_VALUE });
		return () => {
			if (readSearch().get(VIEW_PARAM) === VIEW_VALUE) setUrlParams({ [VIEW_PARAM]: null });
		};
	}, [active]);

	// The open row's L1/L2 (#259): the list request carries L0 only, so the drawer's deeper tiers are
	// read per URI while the row is open, and dropped again when it closes.
	useEffect(() => {
		if (deepReadUri === null) {
			setEntryContent(null);
			return;
		}
		const uri = deepReadUri;
		const controller = new AbortController();
		setEntryContent({ uri, status: "loading" });
		void (async () => {
			try {
				const path = `/api/openviking/entries?uri=${encodeURIComponent(uri)}&include_content=true`;
				const answer = await getJson<OpenVikingEntriesResponse>(path, controller.signal);
				const entry = answer.entries[0];
				if (controller.signal.aborted) return;
				if (!entry) throw new ContentFetchError("NOT_FOUND", `${uri} was not in the answer.`);
				setEntryContent({ uri, status: "ready", entry });
			} catch (error) {
				if (controller.signal.aborted) return;
				setEntryContent({
					uri,
					status: "failed",
					error: {
						code: error instanceof ContentFetchError ? error.code : "FETCH_FAILED",
						message: error instanceof Error ? error.message : String(error),
					},
				});
			}
		})();
		return () => controller.abort();
	}, [deepReadUri]);

	useEffect(() => {
		const onPop = () => setSearch(readSearch());
		window.addEventListener("popstate", onPop);
		return () => window.removeEventListener("popstate", onPop);
	}, []);

	const writeParam = useCallback((key: string, value: string | null) => {
		setUrlParams({ ...(activeRef.current ? { [VIEW_PARAM]: VIEW_VALUE } : {}), [key]: value });
		setSearch(readSearch());
	}, []);

	const activeTab = useMemo<OpenVikingTabId>(() => {
		const wanted = search.get(TAB_PARAM);
		return OPENVIKING_TABS.some((tab) => tab.tab === wanted) ? (wanted as OpenVikingTabId) : "mount-map";
	}, [search]);

	const auditFilter = useMemo<OpenVikingAuditFilterSelection>(
		() => ({
			action: (search.get(ACTION_PARAM) ?? "all") as OpenVikingAuditFilterSelection["action"],
			role: search.get(ROLE_PARAM) ?? "all",
		}),
		[search],
	);

	return (
		<OpenVikingDashboardView
			snapshot={snapshot}
			nowMs={nowMs}
			activeTab={activeTab}
			onActiveTabChange={(tab) => writeParam(TAB_PARAM, tab === "mount-map" ? null : tab)}
			entryContent={entryContent}
			onDeepReadUriChange={setDeepReadUri}
			openRow={search.get(ROW_PARAM)}
			onOpenRowChange={(row) => writeParam(ROW_PARAM, row)}
			auditFilter={auditFilter}
			onAuditFilterChange={(next) => {
				writeParam(ACTION_PARAM, next.action === "all" ? null : next.action);
				writeParam(ROLE_PARAM, next.role === "all" ? null : next.role);
			}}
		/>
	);
}

function readSearch(): URLSearchParams {
	return new URLSearchParams(window.location.search);
}

/** Set (or, for null, delete) search parameters in place; the shell keeps its own history entry. */
function setUrlParams(values: Record<string, string | null>): void {
	const url = new URL(window.location.href);
	for (const [key, value] of Object.entries(values)) {
		if (value === null) url.searchParams.delete(key);
		else url.searchParams.set(key, value);
	}
	if (url.href !== window.location.href) window.history.replaceState(window.history.state, "", url);
}

export default OpenVikingDashboardPage;
