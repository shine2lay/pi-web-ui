// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { MemoryExplorerPage } from "../../web/src/components/MemoryExplorerPage.js";
import {
	choose,
	click,
	flush,
	mountExplorer,
	oneByRole,
	text,
	typeInto,
	type Mounted,
} from "./memory-explorer/explorer-dom.js";
import { fakeApi } from "./memory-explorer/fake-api.js";

let page: Mounted | null = null;
afterEach(() => {
	page?.unmount();
	page = null;
	sessionStorage.clear();
});
const event = {
	id: "old-edit",
	operation_id: "old-edit",
	action: "owner_edit",
	outcome: "applied",
	uri: "viking://user/default/memories/preferences/private-note.md",
	ts: "2026-11-14T00:00:00Z",
};

// Ops #1080 (owner Shine 2026-11-22, dr-c54a3286d823): no sign-in gates the owner's changes any more.
it("asks for the owner's changes straight away and shows them, with no sign-in", async () => {
	const sent: string[] = [];
	const fetch = vi.fn(async (url: string) => {
		sent.push(url);
		if (url.includes("/audit")) return new Response(JSON.stringify({ events: [event] }), { status: 200 });
		if (url.includes("/overview"))
			return new Response(JSON.stringify({ health_state: "healthy", observer: { checked_at: event.ts } }), {
				status: 200,
			});
		return new Response(JSON.stringify({ roots: [], recent: [], notes_total: 5, roots_partial: false }), {
			status: 200,
		});
	});
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	page = {
		container,
		unmount() {
			act(() => root.unmount());
			container.remove();
		},
	};
	await act(async () => root.render(createElement(MemoryExplorerPage, { active: true, fetch })));
	await flush();
	expect(sent.some((url) => url.includes("/audit"))).toBe(true);
	expect(text(container)).toContain("Changes you made");
	expect(text(container)).toContain("Private note");
});

it("scope keeps draft words and searches those words after a previous search", async () => {
	const api = fakeApi();
	page = await mountExplorer(api);
	const box = oneByRole(page.container, "searchbox") as HTMLInputElement;
	await typeInto(box, "old words");
	await click(oneByRole(page.container, "button", "Search"));
	await typeInto(box, "new typed words");
	await choose(oneByRole(page.container, "combobox") as HTMLSelectElement, "viking://user/design/memories");
	expect(box.value).toBe("new typed words");
	expect(api.search.mock.calls.at(-1)?.[0]).toMatchObject({
		query: "new typed words",
		scope: "viking://user/design/memories",
	});
});

it("scope keeps unsubmitted words without starting a search", async () => {
	const api = fakeApi();
	page = await mountExplorer(api);
	const box = oneByRole(page.container, "searchbox") as HTMLInputElement;
	await typeInto(box, "not searched yet");
	await choose(oneByRole(page.container, "combobox") as HTMLSelectElement, "viking://user/design/memories");
	expect(box.value).toBe("not searched yet");
	expect(api.search).not.toHaveBeenCalled();
});

for (const total of [1234, null]) {
	it(`tree summary uses notes_total ${total}, never an invented zero`, async () => {
		const api = fakeApi();
		const health = await api.health();
		api.health.mockResolvedValue({ ...health, totalNotes: total });
		page = await mountExplorer(api);
		const tree = text(oneByRole(page.container, "navigation", "Where memory keeps things"));
		if (total === null) expect(tree).not.toMatch(/notes in \d+ places/);
		else expect(tree).toContain("1,234 notes in 4 places");
	});
}
