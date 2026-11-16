// Ops #964: the live facts message_role's tag guard checks against (server/role-message-tag-facts.ts).
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PI_QUEUE_READERS_KEY } from "../../server/pi-queue-readers.js";
import {
	observedTagsOf,
	readTagAliases,
	registryTagIds,
	rememberWorkerTask,
	roleMessageTagFacts,
	WORKER_TASKS_MAX,
} from "../../server/role-message-tag-facts.js";
import { CANONICAL_TAG_ALIASES } from "../../server/shared/task-tag-governance.js";

const slot = globalThis as Record<symbol, unknown>;
let dir = "";
let reads = 0;
const project = (id: string, status: string): [string, object] => [
	id,
	{ name: id, lead: "ops", status, doneWhen: ["x"], met: [], initiative: null },
];
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "tag-facts-"));
	reads = 0;
	slot[PI_QUEUE_READERS_KEY] = {
		version: 1,
		replay: () => undefined,
		readWork: () => {
			reads++;
			return {
				initiatives: new Map([
					["team-in-temper", { name: "t", lead: "ops", status: "active", doneWhen: ["x"], met: [] }],
				]),
				projects: new Map([
					project("roles-page", "active"),
					project("old-page", "done"),
					project("posting-app", "active"),
				]),
			};
		},
	};
});
afterEach(() => {
	delete slot[PI_QUEUE_READERS_KEY];
	rmSync(dir, { recursive: true, force: true });
});

describe("readTagAliases", () => {
	it("is the seed without a file, adds the file's aliases, and fails loud on a malformed file", () => {
		expect(readTagAliases(dir)).toBe(CANONICAL_TAG_ALIASES);
		writeFileSync(join(dir, "tag-aliases.json"), JSON.stringify({ aliases: { "ov-memory": "openviking-v2" } }));
		expect(readTagAliases(dir)["ov-memory"]).toBe("openviking-v2");
		writeFileSync(join(dir, "tag-aliases.json"), "{ not json");
		expect(() => readTagAliases(dir)).toThrow(/tag-aliases\.json/);
	});
});

describe("registryTagIds", () => {
	it("lists project and initiative ids and the open projects, read again only when the log changes", () => {
		expect(registryTagIds(dir)).toEqual({ ids: [], active: [] });
		expect(reads).toBe(0);
		writeFileSync(join(dir, "events.jsonl"), "{}\n");
		const ids = registryTagIds(dir);
		expect(ids.ids.sort()).toEqual(["old-page", "posting-app", "roles-page", "team-in-temper"]);
		expect(ids.active).toEqual(["posting-app", "roles-page"]);
		registryTagIds(dir);
		expect(reads).toBe(1);
	});

	it("is empty when pi-queue isn't loaded", () => {
		writeFileSync(join(dir, "events.jsonl"), "{}\n");
		delete slot[PI_QUEUE_READERS_KEY];
		expect(registryTagIds(dir)).toEqual({ ids: [], active: [] });
	});
});

describe("roleMessageTagFacts", () => {
	it("knows registry ids, alias targets and observed tags (not alias keys); names the open projects", () => {
		writeFileSync(join(dir, "events.jsonl"), "{}\n");
		const facts = roleMessageTagFacts(
			() => ({
				messages: [{ tags: ["qa-setup", "openviking-fixes"] }, {}],
				overview: {
					tagGroups: [
						{ key: "gpu-cluster", kind: "tag" },
						{ key: "not-a-tag", kind: "project" },
					],
				},
			}),
			dir,
		);
		const g = facts.tagGovernance();
		for (const tag of ["roles-page", "team-in-temper", "qa-setup", "gpu-cluster", "openviking-v2"]) {
			expect(g.knownCanonicalTags.has(tag)).toBe(true);
		}
		expect(g.knownCanonicalTags.has("openviking-fixes")).toBe(false);
		expect(g.knownCanonicalTags.has("not-a-tag")).toBe(false);
		expect(g.activeProjectIds).toEqual(["posting-app", "roles-page"]);
	});

	it("gives back a worker task's project and tags as its sender binding remembered them", () => {
		const facts = roleMessageTagFacts(() => ({}), dir);
		const own = {
			id: 7,
			done: false,
			held: false,
			queueChat: "/q.jsonl",
			project: "roles-page",
			tags: ["roles-rework"],
		};
		expect(rememberWorkerTask(own)).toBe(own);
		expect(facts.workerTaskTags({ queueId: "/q.jsonl", taskId: 7 })).toEqual({
			project: "roles-page",
			tags: ["roles-rework"],
		});
		expect(facts.workerTaskTags({ queueId: "/q.jsonl", taskId: 8 })).toBeUndefined();
		expect(rememberWorkerTask(undefined)).toBeUndefined();
		for (let i = 0; i <= WORKER_TASKS_MAX; i++) rememberWorkerTask({ id: 1000 + i, queueChat: "/q.jsonl" });
		expect(facts.workerTaskTags({ queueId: "/q.jsonl", taskId: 7 })).toBeUndefined();
	});
});

describe("observedTagsOf", () => {
	it("takes message tags and the overview's tag groups only", () => {
		expect(
			observedTagsOf({ messages: [{ tags: ["a-b"] }], overview: { tagGroups: [{ key: "c-d", kind: "tag" }] } }),
		).toEqual(["a-b", "c-d"]);
	});
});
