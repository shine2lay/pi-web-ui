/**
 * The OpenViking Memory Dashboard tab (frontend #258, Task 2).
 *
 * The only part of the feature that talks to the network: it polls
 * `/api/openviking/{overview,entries,audit}` while the tab is open and hands the answer to the
 * presentational view. Tab and audit filters live in the URL's search parameters, so a poll (or a
 * reload, or a shared link) never throws the reader back to the first tab.
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
	type OpenVikingTabId,
} from "../openviking-dashboard";
import { OPENVIKING_TABS } from "../openviking-dashboard/text.js";
import "../openviking-dashboard/openviking-dashboard.css";

const POLL_MS = 30_000;
const TAB_PARAM = "ovtab";
const ACTION_PARAM = "ovaction";
const ROLE_PARAM = "ovrole";

export interface OpenVikingDashboardPageProps {
	/** The tab is shown; it polls the server only then. */
	readonly active: boolean;
}

async function getJson<T>(path: string, signal: AbortSignal): Promise<T> {
	const response = await fetch(appUrl(path), { signal, headers: { accept: "application/json" } });
	if (!response.ok) throw new Error(`${path} answered ${response.status}`);
	return (await response.json()) as T;
}

export function OpenVikingDashboardPage({ active }: OpenVikingDashboardPageProps) {
	const [snapshot, setSnapshot] = useState<OpenVikingDashboardSnapshot>({ status: "loading" });
	const [nowMs, setNowMs] = useState(() => Date.now());
	const [search, setSearch] = useState(() => readSearch());
	const generation = useRef(0);

	const load = useCallback(async (signal: AbortSignal) => {
		const mine = ++generation.current;
		try {
			const [overview, entries, audit] = await Promise.all([
				getJson<OpenVikingOverviewResponse>("/api/openviking/overview", signal),
				getJson<OpenVikingEntriesResponse>("/api/openviking/entries", signal),
				getJson<OpenVikingAuditResponse>("/api/openviking/audit", signal),
			]);
			if (signal.aborted || mine !== generation.current) return;
			setSnapshot({ status: "ready", overview, entries, audit });
		} catch (error) {
			if (signal.aborted || mine !== generation.current) return;
			setSnapshot({ status: "fetch-failed", message: error instanceof Error ? error.message : String(error) });
		}
		setNowMs(Date.now());
	}, []);

	useEffect(() => {
		if (!active) return;
		const controller = new AbortController();
		void load(controller.signal);
		const id = window.setInterval(() => void load(controller.signal), POLL_MS);
		return () => {
			controller.abort();
			window.clearInterval(id);
		};
	}, [active, load]);

	useEffect(() => {
		const onPop = () => setSearch(readSearch());
		window.addEventListener("popstate", onPop);
		return () => window.removeEventListener("popstate", onPop);
	}, []);

	const writeParam = useCallback((key: string, value: string | null) => {
		const url = new URL(window.location.href);
		if (value === null) url.searchParams.delete(key);
		else url.searchParams.set(key, value);
		window.history.replaceState(window.history.state, "", url);
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

export default OpenVikingDashboardPage;
