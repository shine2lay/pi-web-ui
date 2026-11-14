// @vitest-environment jsdom
import { act } from "react";
import { afterEach, expect, it } from "vitest";
import { ExplorerApiError } from "../../web/src/memory-explorer/explorer-api.js";
import { createHttpExplorerApi } from "../../web/src/memory-explorer/explorer-http.js";
import {
	click,
	flush,
	mountExplorer,
	oneByRole,
	text,
	typeInto,
	type Mounted,
} from "./memory-explorer/explorer-dom.js";
import { fakeApi, NOW_MS } from "./memory-explorer/fake-api.js";

let page: Mounted | null = null;
afterEach(() => {
	page?.unmount();
	page = null;
});

for (const view of ["recent", "results", "note"] as const) {
	it(`loaded ${view} survives memory down with age and disabled search/writes`, async () => {
		const api = fakeApi();
		page = await mountExplorer(api);
		if (view === "results") {
			await typeInto(oneByRole(page.container, "searchbox") as HTMLInputElement, "memory");
			await click(oneByRole(page.container, "button", "Search"));
		}
		if (view === "note") await click(page.container.querySelector(".mx-row")!);
		const work = text(oneByRole(page.container, "region", "What you're looking at"));
		const tree = text(oneByRole(page.container, "navigation", "Where memory keeps things"));
		const health = await api.health();
		api.health.mockResolvedValue({ ...health, state: "down", lastSeenUpAt: new Date(NOW_MS - 180000).toISOString() });
		api.roots.mockRejectedValue(new ExplorerApiError("MEMORY_DOWN", "offline"));
		api.recent.mockRejectedValue(new ExplorerApiError("MEMORY_DOWN", "offline"));
		await act(async () => window.dispatchEvent(new Event("focus")));
		await flush();
		expect(text(page.container)).toContain("Memory isn't answering · last seen 3 min ago");
		expect(
			text(oneByRole(page.container, "region", "What you're looking at")).replace(
				"Editing and deleting are off while memory is down.",
				"",
			),
		).toBe(work);
		expect(text(oneByRole(page.container, "navigation", "Where memory keeps things"))).toBe(tree);
		expect((oneByRole(page.container, "searchbox") as HTMLInputElement).disabled).toBe(true);
		if (view === "note") {
			for (const name of ["Edit", "Delete"])
				expect((oneByRole(page.container, "button", name) as HTMLButtonElement).disabled).toBe(true);
			expect(text(page.container)).toContain("Editing and deleting are off while memory is down.");
		}
	});
}

it("first load failure still says Couldn't load memory", async () => {
	page = await mountExplorer(fakeApi({ fail: { recent: "MEMORY_DOWN", roots: "MEMORY_DOWN" }, health: "down" }));
	expect(text(page.container)).toContain("Couldn't load memory");
});

it("withheld audit shows sign-in instead of No changes", async () => {
	const api = fakeApi();
	api.changes.mockImplementation(
		createHttpExplorerApi({ fetch: async () => new Response(JSON.stringify({ owner_events: "withheld", events: [] })) })
			.changes,
	);
	page = await mountExplorer(api);
	expect(text(page.container)).toContain("Sign in to see your changes");
	expect(text(page.container)).not.toContain("No changes");
});
