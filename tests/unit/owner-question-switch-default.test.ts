import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ClientStateStore } from "../../server/client-state.js";

/** Ops #687 (H-OWNER-ROUTE-ON, docs/owner-question-routing.md): the owner's questions go through COO first by
 *  default. The switch `ownerQuestionsViaCoo` is on while nothing is stored (the live settings never stored the
 *  key) and off only once he turns it off in Settings, which stores `false`; that choice survives other settings
 *  saves and a restart. agent-service reads it through `getSettings("")`. */
describe("ownerQuestionsViaCoo is on unless turned off (Ops #687)", () => {
	let dir: string;
	let file: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "pi-owner-question-switch-test-"));
		file = join(dir, "client-state.json");
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	/** The stored settings object, as written to disk. */
	const storedSettings = (): Record<string, unknown> =>
		(JSON.parse(readFileSync(file, "utf8")) as { __settings__: { settings: Record<string, unknown> } }).__settings__
			.settings;

	it("is on when nothing has been stored", () => {
		expect(new ClientStateStore(file).getSettings("").ownerQuestionsViaCoo).toBe(true);
	});

	it("is on for stored settings that never had the key (the live file before #687)", () => {
		writeFileSync(
			file,
			JSON.stringify({ __settings__: { projects: [], settings: { promptMode: "append", quietScheduledWakes: true } } }),
		);
		const store = new ClientStateStore(file);
		expect(store.getSettings("").ownerQuestionsViaCoo).toBe(true);
		expect(store.getSettings("").quietScheduledWakes).toBe(true);
	});

	it("saving another setting keeps it on, and stores it as on", () => {
		const store = new ClientStateStore(file);
		store.saveSettings("c1", { quietStallPokes: true });
		expect(store.getSettings("").ownerQuestionsViaCoo).toBe(true);
		expect(storedSettings().ownerQuestionsViaCoo).toBe(true);
	});

	it("turned off, it stays off through other saves and a restart", () => {
		const store = new ClientStateStore(file);
		store.saveSettings("c1", { ownerQuestionsViaCoo: false });
		expect(store.getSettings("").ownerQuestionsViaCoo).toBe(false);
		store.saveSettings("c1", { quietStallPokes: true });
		expect(store.getSettings("").ownerQuestionsViaCoo).toBe(false);
		expect(storedSettings().ownerQuestionsViaCoo).toBe(false);
		expect(new ClientStateStore(file).getSettings("").ownerQuestionsViaCoo).toBe(false);
	});

	it("turned back on, it is on again after a restart", () => {
		const store = new ClientStateStore(file);
		store.saveSettings("c1", { ownerQuestionsViaCoo: false });
		store.saveSettings("c1", { ownerQuestionsViaCoo: true });
		expect(new ClientStateStore(file).getSettings("").ownerQuestionsViaCoo).toBe(true);
	});
});
