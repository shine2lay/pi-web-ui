/**
 * Ops #871: the OpenViking state folder comes from the app's home (HOME), never a literal path.
 * A sealed run (scripts/sealed.sh, temp HOME) must read the sandbox's `.pi/openviking`, not the owner's real
 * memory log; the live app (HOME = the owner's home) keeps reading the same real files.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createOpenVikingClient } from "../../server/openviking/index.js";

const savedHome = process.env.HOME;
const made: string[] = [];

afterEach(() => {
	if (savedHome === undefined) delete process.env.HOME;
	else process.env.HOME = savedHome;
	for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("OpenViking state folder follows HOME (ops #871)", () => {
	it("resolves every state file inside the current HOME when no stateDir is given", () => {
		const home = mkdtempSync(join(tmpdir(), "ov-home-"));
		made.push(home);
		process.env.HOME = home;

		const client = createOpenVikingClient({ fetchImpl: async () => new Response("{}") });

		expect(client.stateDir).toBe(join(home, ".pi", "openviking"));
		expect(client.statePaths.changelogJsonlPath).toBe(join(home, ".pi", "openviking", "memory-changelog.jsonl"));
		for (const path of Object.values(client.statePaths)) expect(path.startsWith(`${home}/`)).toBe(true);
	});

	it("keeps an explicit stateDir as given", () => {
		const client = createOpenVikingClient({ stateDir: "/srv/ov", fetchImpl: async () => new Response("{}") });
		expect(client.stateDir).toBe("/srv/ov");
	});
});
