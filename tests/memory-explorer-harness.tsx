// Browser-only fixed cases for the ACTUAL Memory explorer view (design #316). Never part of the app
// bundle (rule 29): `memory-explorer-ui-check.mjs` bundles this with the tests' fake store and serves
// it so ui-check can measure every state at 320/390/1440 in light and dark.
//
// `?state=` picks the case: live (default), loading, empty, error, down, degraded, signed-out,
// results, reader, confirm.
import { createRoot } from "react-dom/client";
import { MemoryExplorerView } from "../web/src/memory-explorer/MemoryExplorerView";
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
createRoot(host).render(<MemoryExplorerView api={fakeApi(OPTIONS[state] ?? {})} now={() => NOW_MS} signIn={signIn} />);

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
	if (state === "reader" || state === "confirm") click(host.querySelector(".mx-row"));
	await settle();
	if (state === "confirm") {
		click(document.querySelector(".mx-btn-danger"));
	}
	await settle();
	document.documentElement.dataset.harnessReady = "1";
}
void drive();
