// Browser-only fixed cases for the ACTUAL Memory explorer view (design #316). Never part of the app
// bundle (rule 29): `memory-explorer-ui-check.mjs` bundles this with the tests' fake store and serves
// it so ui-check can measure every state at 320/390/1440 in light and dark.
//
// `?state=` picks the case: live (default), loading, empty, error, down, degraded, signed-out,
// results, reader, confirm.
import { createRoot } from "react-dom/client";
import { MemoryExplorerPage } from "../web/src/components/MemoryExplorerPage";
import { MemoryExplorerView } from "../web/src/memory-explorer/MemoryExplorerView";
import { ExplorerApiError } from "../web/src/memory-explorer/explorer-api";
import { createHttpExplorerApi } from "../web/src/memory-explorer/explorer-http";
import { fakeApi, NOW_MS, type FakeOptions } from "./unit/memory-explorer/fake-api";
import "../web/src/styles.css";
import "../web/src/memory-explorer/memory-explorer.css";

const state = new URLSearchParams(window.location.search).get("state") ?? "live";

const OPTIONS: Record<string, FakeOptions> = {
	live: {},
	results: {},
	reader: {},
	confirm: {},
	loading: { hang: ["health", "roots", "recent"] },
	empty: { empty: true },
	error: { fail: { recent: "FAILED", roots: "FAILED" } },
	down: { health: "down", fail: { recent: "MEMORY_DOWN", roots: "MEMORY_DOWN" } },
	degraded: { health: "degraded", missedPlaces: 1 },
	"signed-out": { fail: { roots: "OWNER_ONLY", recent: "OWNER_ONLY", health: "OWNER_ONLY" } },
};

const host = document.createElement("div");
host.className = "view-pane openviking-pane";
host.style.cssText = "height:100vh;width:100%;";
document.body.style.cssText = "margin:0;height:100vh;display:flex;background:var(--bg)";
document.body.append(host);

const signIn = (
	<button type="button" className="mx-btn mx-btn-solid">
		Sign in
	</button>
);
// Auth cases exercise the actual page and session hook, not a hand-built account slot.
const ownerFetch = async (url: string): Promise<Response> => {
	if (state === "checking") return new Promise(() => {});
	const at = new Date(NOW_MS).toISOString();
	const body = url.includes("/tree/roots")
		? {
				checked_at: at,
				health_state: "healthy",
				notes_total: 0,
				unread_count: 0,
				roots_partial: false,
				roots: [],
				recent: [],
			}
		: url.includes("/audit")
			? { panel_updated_at: at, health_state: "healthy", stale_badge: null, events: [] }
			: { health_state: "healthy", observer: { checked_at: at, last_commit_at: at, last_reachable_at: at } };
	return new Response(JSON.stringify(body), { status: 200 });
};
const api = fakeApi(OPTIONS[state] ?? {});
let offline = false;
const health = api.health;
const roots = api.roots;
const recent = api.recent;
api.health = async () => ({
	...(await health()),
	...(offline ? { state: "down" as const, lastSeenUpAt: new Date(NOW_MS - 180000).toISOString() } : {}),
});
api.roots = async () => {
	if (offline) throw new ExplorerApiError("MEMORY_DOWN", "offline");
	return roots();
};
api.recent = async (...args) => {
	if (offline) throw new ExplorerApiError("MEMORY_DOWN", "offline");
	return recent(...args);
};
if (state === "withheld")
	api.changes = createHttpExplorerApi({
		fetch: async () => new Response(JSON.stringify({ owner_events: "withheld", events: [] })),
	}).changes;
createRoot(host).render(
	state === "checking" || state === "signed-in" ? (
		<MemoryExplorerPage active fetch={ownerFetch} />
	) : (
		<MemoryExplorerView
			api={api}
			ownerState={state === "signed-out" ? "signed-out" : "signed-in"}
			now={() => NOW_MS}
			signIn={signIn}
		/>
	),
);

const settle = () => new Promise((r) => setTimeout(r, 150));
const click = (el: Element | null | undefined) => (el as HTMLElement | null | undefined)?.click();

/** Interactive cases: drive the real view the way the owner would, then leave it for measuring. */
async function drive(): Promise<void> {
	await settle();
	if (state === "results") {
		const input = host.querySelector<HTMLInputElement>(".mx-find-box input");
		if (!input) return;
		const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
		setValue?.call(input, "memory redesign");
		input.dispatchEvent(new Event("input", { bubbles: true }));
		click(host.querySelector(".mx-find-box .mx-btn-solid"));
	}
	if (state === "reader" || state === "confirm" || state === "down-after-load") click(host.querySelector(".mx-row"));
	await settle();
	if (state === "confirm") {
		click(document.querySelector(".mx-btn-danger"));
	}
	await settle();
	if (state === "down-after-load") {
		offline = true;
		window.dispatchEvent(new Event("focus"));
		await settle();
	}
	document.documentElement.dataset.harnessReady = "1";
}
void drive();
