// Browser-only fixed cases for the ACTUAL Memory explorer view (design #316). Never part of the app
// bundle (rule 29): `memory-explorer-ui-check.mjs` bundles this with the tests' fake store and serves
// it so ui-check can measure every state at 320/390/1440 in light and dark.
//
// `?state=` picks the case: live (default), loading, empty, error, down, degraded, results, reader,
// confirm; and on the actual page with a fake server (no sign-in, Ops #1080): page, passkeys (the
// Passkeys box), add-passkey (a Save on an address with no passkey opens Add a passkey); specialists (Design's
// Specialists node open, with search hits that say whose notes they are).
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
	specialists: { specialists: true },
};
const PAGE_STATES = ["page", "passkeys", "add-passkey"];

const host = document.createElement("div");
host.className = "view-pane openviking-pane";
host.style.cssText = "height:100vh;width:100%;";
document.body.style.cssText = "margin:0;height:100vh;display:flex;background:var(--bg)";
document.body.append(host);

// Page cases exercise the actual page and owner hook against a fake server: reads always answer.
const AT = new Date(NOW_MS).toISOString();
const SHARED = "viking://user/default/memories";
const NOTE = `${SHARED}/preferences/ui_ux_design.md`;
const KINDS = { rule: 1, case: 0, fact: 0, event: 0, document: 0, other: 0 };
const PASSKEY = { id: "pk-1", rp_id: "pi.wai2shine.com", created_at: AT };
const READS: Record<string, unknown> = {
	"/overview": { health_state: "healthy", observer: { checked_at: AT, last_commit_at: AT, last_reachable_at: AT } },
	"/tree/roots": {
		checked_at: AT,
		health_state: "healthy",
		notes_total: 1,
		unread_count: 0,
		roots_partial: false,
		roots: [{ uri: SHARED, group: "shared", role: null, read: true, notes: 1, folders: 1, kinds: KINDS }],
		recent: [{ uri: NOTE, root: SHARED, kind: "rule", size: 120, mod_time: AT, locked: false }],
	},
	"/tree": {
		uri: SHARED,
		root: SHARED,
		notes: 1,
		folders: 1,
		counts_reason: null,
		last_change: AT,
		abstract: null,
		abstract_reason: "not_ready",
		total: 1,
		children: [{ uri: `${SHARED}/preferences`, name: "preferences", is_folder: true, size: 0, mod_time: AT }],
	},
	"/audit": { panel_updated_at: AT, health_state: "healthy", stale_badge: null, events: [], owner_events: "included" },
	"/note": {
		uri: NOTE,
		root: SHARED,
		kind: "rule",
		is_folder: false,
		size: 120,
		mod_time: AT,
		level: "full",
		text: "Body 16 px or more.",
		text_reason: null,
		text_of: NOTE,
		last_write: null,
	},
	"/owner/passkeys": { rp_id: PASSKEY.rp_id, passkeys: state === "add-passkey" ? [] : [PASSKEY] },
};
const ownerFetch = async (url: string): Promise<Response> => {
	const path = url.replace(/^.*\/api\/openviking/, "").replace(/\?.*$/, "");
	const body = READS[path];
	if (body === undefined) return new Response(JSON.stringify({ error: { code: "OWNER_ONLY" } }), { status: 403 });
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
	PAGE_STATES.includes(state) ? (
		<MemoryExplorerPage active fetch={ownerFetch} />
	) : (
		<MemoryExplorerView api={api} now={() => NOW_MS} />
	),
);

const settle = () => new Promise((r) => setTimeout(r, 150));
const click = (el: Element | null | undefined) => (el as HTMLElement | null | undefined)?.click();
const button = (name: string, scope: ParentNode = document) =>
	[...scope.querySelectorAll("button")].find((b) => b.textContent?.trim() === name);

/** Interactive cases: drive the real view the way the owner would, then leave it for measuring. */
async function drive(): Promise<void> {
	await settle();
	if (state === "passkeys") {
		click(button("Passkeys"));
		await settle();
	}
	if (state === "add-passkey") {
		click(host.querySelector(".mx-row"));
		await settle();
		click(button("Edit"));
		await settle();
		click(button("Save changes"));
		await settle();
		const dialog = document.querySelector("[role=dialog]");
		click(dialog ? button("Save", dialog) : null);
		await settle();
	}
	if (state === "results" || state === "specialists") {
		const input = host.querySelector<HTMLInputElement>(".mx-find-box input");
		if (!input) return;
		const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
		setValue?.call(input, "memory redesign");
		input.dispatchEvent(new Event("input", { bubbles: true }));
		click(host.querySelector(".mx-find-box .mx-btn-solid"));
	}
	if (state === "reader" || state === "confirm" || state === "down-after-load") click(host.querySelector(".mx-row"));
	await settle();
	if (state === "specialists") {
		// Design's place open, its Specialists node open, and each specialist open (v2 §5l.15).
		for (const name of ["Design", "Specialists", "a11y-reviewer", "motion-2", "brand-old"]) {
			click(host.querySelector(`[aria-label="Open ${name}"]`));
			// Short: ui-check shoots once the network is quiet, not when this drive ends.
			await new Promise((r) => setTimeout(r, 30));
		}
	}
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
