// @vitest-environment jsdom
/**
 * Memory explorer (design #316): fixing and deleting a note, written failing-first from design
 * #315's HANDOFF.md (Edit, Delete, confirm naming the note, 10 s Undo, "Changes you made", save
 * fails) and the owner's choice "Also delete or fix entries" (dr-57cc897d32d3). One note per confirm.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
	byRole,
	click,
	flush,
	maybeByRole,
	mountExplorer,
	oneByRole,
	pressKey,
	text,
	typeInto,
	type Mounted,
} from "./memory-explorer/explorer-dom.js";
import { CASE_FULL_TEXT, CASE_URI, NOTES, fakeApi } from "./memory-explorer/fake-api.js";

let page: Mounted | null = null;
afterEach(() => {
	page?.unmount();
	page = null;
	vi.useRealTimers();
});

const openCase = async (c: HTMLElement) =>
	click(byRole(c, "button").find((b) => b.getAttribute("data-note") === CASE_URI) as HTMLElement);
const FULL_TEXT_BOX = /^Full text of /;
const dialog = () => byRole(document.body, "dialog")[0] ?? null;

async function editTo(c: HTMLElement, value: string): Promise<void> {
	await openCase(c);
	await click(oneByRole(c, "button", "Edit"));
	const box = oneByRole(c, "textbox", FULL_TEXT_BOX) as HTMLTextAreaElement;
	expect(box.value).toBe(CASE_FULL_TEXT);
	await typeInto(box, value);
	await click(oneByRole(c, "button", "Save changes"));
}

describe("edit", () => {
	it("asks to confirm, naming the note and what changes, then saves the version that was opened", async () => {
		const api = fakeApi();
		page = await mountExplorer(api);
		await editTo(page.container, "Shorter text");
		const box = dialog();
		expect(box?.getAttribute("aria-modal")).toBe("true");
		expect(text(box)).toContain("Save changes to “Memory redesign”?");
		expect(text(box)).toContain("Chats get the new text from their next start.");
		expect(api.save).not.toHaveBeenCalled();
		await click(oneByRole(box as HTMLElement, "button", "Save"));
		expect(api.save).toHaveBeenCalledWith(CASE_URI, "Shorter text", NOTES[0].changedAt);
		expect(text(oneByRole(page.container, "status", /Saved/))).toContain("Saved “Memory redesign”.");
	});

	it("Cancel in the editor drops the draft and saves nothing", async () => {
		const api = fakeApi();
		page = await mountExplorer(api);
		await openCase(page.container);
		await click(oneByRole(page.container, "button", "Edit"));
		await click(oneByRole(page.container, "button", "Cancel"));
		expect(maybeByRole(page.container, "textbox", FULL_TEXT_BOX)).toBeNull();
		expect(api.save).not.toHaveBeenCalled();
	});

	it("save fails: says so, keeps the text, offers Try again", async () => {
		const api = fakeApi({ fail: { save: "MEMORY_DOWN" } });
		page = await mountExplorer(api);
		await editTo(page.container, "Kept draft");
		await click(oneByRole(dialog() as HTMLElement, "button", "Save"));
		const alert = oneByRole(page.container, "alert");
		expect(text(alert)).toContain("Couldn't save: memory didn't answer. Your text is still here.");
		expect((oneByRole(page.container, "textbox", FULL_TEXT_BOX) as HTMLTextAreaElement).value).toBe("Kept draft");
		await click(oneByRole(alert, "button", "Try again"));
		expect(api.save).toHaveBeenCalledTimes(2);
	});

	it("note changed since it was opened: says so plainly and keeps the text", async () => {
		page = await mountExplorer(fakeApi({ fail: { save: "CHANGED_SINCE_OPENED" } }));
		await editTo(page.container, "Kept draft");
		await click(oneByRole(dialog() as HTMLElement, "button", "Save"));
		expect(text(oneByRole(page.container, "alert"))).toContain("changed since you opened it");
		expect((oneByRole(page.container, "textbox", FULL_TEXT_BOX) as HTMLTextAreaElement).value).toBe("Kept draft");
	});
});

describe("delete", () => {
	it("confirms one note by name and where it lives, Cancel focused; deletes only on yes", async () => {
		const api = fakeApi();
		page = await mountExplorer(api);
		await openCase(page.container);
		await click(oneByRole(page.container, "button", "Delete"));
		const box = dialog() as HTMLElement;
		expect(text(box)).toContain("Delete “Memory redesign”?");
		expect(text(box)).toContain("Design's own notes");
		expect(text(box)).toContain("Chats will no longer get it.");
		expect(text(document.activeElement)).toBe("Cancel");
		expect(api.remove).not.toHaveBeenCalled();
		await click(oneByRole(box, "button", "Delete note"));
		expect(api.remove).toHaveBeenCalledWith(CASE_URI);
		expect(api.remove).toHaveBeenCalledTimes(1);
		expect(text(oneByRole(page.container, "status", /Deleted/))).toContain("Deleted “Memory redesign”.");
		expect(text(page.container)).toContain("This note was deleted");
	});

	it("Escape closes the confirm and returns focus to Delete", async () => {
		const api = fakeApi();
		page = await mountExplorer(api);
		await openCase(page.container);
		const del = oneByRole(page.container, "button", "Delete");
		del.focus();
		await click(del);
		await pressKey(document.activeElement as Element, "Escape");
		expect(dialog()).toBeNull();
		expect(document.activeElement).toBe(oneByRole(page.container, "button", "Delete"));
		expect(api.remove).not.toHaveBeenCalled();
	});

	it("keeps Tab inside the open confirm and makes the page behind inert", async () => {
		page = await mountExplorer(fakeApi());
		await openCase(page.container);
		await click(oneByRole(page.container, "button", "Delete"));
		const box = dialog() as HTMLElement;
		const buttons = byRole(box, "button");
		buttons[buttons.length - 1].focus();
		await pressKey(document.activeElement as Element, "Tab");
		expect(box.contains(document.activeElement)).toBe(true);
		expect(page.container.querySelector("main,[data-explorer-page]")?.closest("[inert]")).not.toBeNull();
	});
});

describe("undo and the change list", () => {
	it("Undo within the window reverts the change and the list marks it undone", async () => {
		const api = fakeApi();
		page = await mountExplorer(api);
		await openCase(page.container);
		await click(oneByRole(page.container, "button", "Delete"));
		await click(oneByRole(dialog() as HTMLElement, "button", "Delete note"));
		const changes = oneByRole(page.container, "region", "Changes you made");
		expect(text(changes)).toContain("Deleted Memory redesign");
		await click(oneByRole(oneByRole(page.container, "status", /Deleted/), "button", "Undo"));
		expect(api.undo).toHaveBeenCalledWith("ch-1");
		expect(text(oneByRole(page.container, "region", "Changes you made"))).toContain("undone");
	});

	it("Undo goes away after 10 seconds", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		page = await mountExplorer(fakeApi());
		await openCase(page.container);
		await click(oneByRole(page.container, "button", "Delete"));
		await click(oneByRole(dialog() as HTMLElement, "button", "Delete note"));
		expect(maybeByRole(page.container, "button", "Undo")).not.toBeNull();
		vi.advanceTimersByTime(9_000);
		await flush();
		expect(maybeByRole(page.container, "button", "Undo")).not.toBeNull();
		vi.advanceTimersByTime(1_100);
		await flush();
		expect(maybeByRole(page.container, "button", "Undo")).toBeNull();
	});

	it("hides Changes you made until the first change", async () => {
		page = await mountExplorer(fakeApi());
		expect(maybeByRole(page.container, "region", "Changes you made")).toBeNull();
	});
});
