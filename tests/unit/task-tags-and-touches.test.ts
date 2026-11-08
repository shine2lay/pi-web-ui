import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ROLE_MESSAGE_HEADER } from "../../server/decision-records.js";
import type { IdentityDef } from "../../server/identities.js";
import type { UiTaskQueuePlan } from "../../server/protocol.js";
import { requesterInputOf } from "../../server/queue-requester.js";
import { starterOf } from "../../server/quiet-turns.js";
import { GUARD_POLICY_V1 } from "../../server/role-message-limits.js";
import { makeMessageRoleTool } from "../../server/role-message-tool.js";
import { RoleMessages, roleMessageHeader, type RoleMessageHost } from "../../server/role-messages.js";
import {
	MAX_TAGS_PER_ITEM,
	TAG_SLUG_RE,
	checkTags,
	normTags,
	resolveInheritedTags,
} from "../../server/shared/task-tags.js";
import { normalizeTouch, normalizeTouches } from "../../server/shared/touch-normalizer.js";
import { TASK_QUEUE_ENTRY_TYPE, taskQueueFromEntries, type TaskQueueEntryLike } from "../../server/task-queue.js";

const CONFORMANCE_FIXTURES_PATH =
	"/home/shinelay/architecture-dept/work/roles-initiatives-rework/conformance-fixtures.json";
const conformanceFixtures = JSON.parse(fs.readFileSync(CONFORMANCE_FIXTURES_PATH, "utf8"));

const ROLES: IdentityDef[] = [
	{
		id: "coo",
		title: "COO",
		homeChat: "/tmp/coo/main.jsonl",
		pastHomeChats: [],
		folder: undefined,
		raw: {},
		role: undefined,
		dir: "/tmp/coo",
	} as unknown as IdentityDef,
	{
		id: "backend",
		title: "Backend engineering",
		homeChat: "/tmp/backend/main.jsonl",
		pastHomeChats: [],
		folder: undefined,
		raw: {},
		role: undefined,
		dir: "/tmp/backend",
	} as unknown as IdentityDef,
];

const samplePlan = (title: string): UiTaskQueuePlan => ({
	title,
	goal: "Implement Roles & Initiatives B1a seam",
	doneWhen: "All unit and conformance tests pass",
	decided: "Approved contract v4",
	steps: "1. Add validators\n2. Wire protocol & replay",
	verify: "vitest",
	mustNot: "No web/ changes",
});

const entry = (data: Record<string, unknown>): TaskQueueEntryLike => ({
	type: "custom",
	customType: TASK_QUEUE_ENTRY_TYPE,
	data: { v: 1, ...data },
});

let tmpDirs: string[] = [];
const activeStores: RoleMessages[] = [];
afterEach(() => {
	for (const s of activeStores.splice(0)) s.stop();
	for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
	tmpDirs = [];
});

function makeTmpDir(prefix: string): string {
	const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	tmpDirs.push(d);
	return d;
}

describe("server/shared/task-tags", () => {
	it("exports TAG_SLUG_RE and MAX_TAGS_PER_ITEM matching contract", () => {
		expect(TAG_SLUG_RE.source).toBe("^[a-z0-9][a-z0-9-]{0,59}$");
		expect(MAX_TAGS_PER_ITEM).toBe(16);
	});

	describe("conformance: tagValidationFixtures", () => {
		for (const fixture of conformanceFixtures.tagValidationFixtures) {
			it(`${fixture.id}`, () => {
				const rawInput = fixture.omitted ? undefined : fixture.input;
				const actual = checkTags(rawInput);
				expect(actual.ok).toBe(fixture.expected.ok);
				if (fixture.expected.ok) {
					expect(actual).toEqual({ ok: true, value: fixture.expected.value });
				} else {
					expect(!actual.ok && actual.error).toContain(fixture.expected.errorSubstring);
				}
			});
		}
	});

	describe("conformance: tagPropagationFixtures", () => {
		for (const fixture of conformanceFixtures.tagPropagationFixtures) {
			it(`${fixture.id}`, () => {
				if (fixture.queueAddParams) {
					const inherited = resolveInheritedTags(fixture.queueAddParams.tags, fixture.originInputs);
					expect(inherited ?? []).toEqual(fixture.expectedStoredTags);

					// Also verify taskQueueFromEntries replay of op="add" matches expectedStoredTags
					const q = taskQueueFromEntries(
						[
							entry({
								op: "add",
								id: 1,
								text: fixture.queueAddParams.title,
								plan: samplePlan(fixture.queueAddParams.title),
								origin: { v: 1, inputs: fixture.originInputs },
								...(fixture.queueAddParams.tags !== undefined ? { tags: fixture.queueAddParams.tags } : {}),
								ts: 1000,
							}),
						],
						true,
					);
					expect(q.tasks[0]?.tags ?? []).toEqual(fixture.expectedStoredTags);
				} else if (fixture.queueAddUpdateParams) {
					const q = taskQueueFromEntries(
						[
							entry({
								op: "add",
								id: fixture.queueAddUpdateParams.id,
								text: "Initial title",
								plan: samplePlan("Initial title"),
								tags: fixture.existingTaskTags,
								ts: 1000,
							}),
							entry({
								op: "update",
								id: fixture.queueAddUpdateParams.id,
								text: fixture.queueAddUpdateParams.title ?? "Initial title",
								plan: samplePlan(fixture.queueAddUpdateParams.title ?? "Initial title"),
								...(fixture.queueAddUpdateParams.tags !== undefined ? { tags: fixture.queueAddUpdateParams.tags } : {}),
								ts: 1001,
							}),
						],
						true,
					);
					expect(q.tasks[0]?.tags ?? []).toEqual(fixture.expectedStoredTags);
				}
			});
		}
	});

	it("normTags filters, trims, lowercases, and deduplicates without throwing", () => {
		expect(normTags(undefined)).toBeUndefined();
		expect(normTags("not-an-array")).toBeUndefined();
		expect(normTags(["  Roles-Rework ", "bad slug!", "roles-rework", "track-b1"])).toEqual([
			"roles-rework",
			"track-b1",
		]);
		expect(normTags([])).toBeUndefined();
	});
});

describe("server/shared/touch-normalizer", () => {
	describe("conformance: touchNormalizationFixtures", () => {
		for (const fixture of conformanceFixtures.touchNormalizationFixtures) {
			it(`${fixture.raw} -> ${fixture.expected.appOrSystem} (${fixture.expected.kind})`, () => {
				expect(normalizeTouch(fixture.raw)).toEqual(fixture.expected);
			});
		}
	});

	it("handles additional contract table patterns and normalizeTouches deduplication", () => {
		expect(normalizeTouch("show-and-tell repo")).toEqual({
			raw: "show-and-tell repo",
			appOrSystem: "show-and-tell",
			repo: "show-and-tell",
			kind: "repo",
			shareable: true,
		});
		expect(normalizeTouch("showtell-deploy")).toEqual({
			raw: "showtell-deploy",
			appOrSystem: "show-and-tell",
			repo: "show-and-tell",
			kind: "deploy",
			shareable: true,
		});
		expect(normalizeTouch("agent-tools repo")).toEqual({
			raw: "agent-tools repo",
			appOrSystem: "agent-tools",
			repo: "agent-tools",
			kind: "repo",
			shareable: true,
		});
		expect(normalizeTouch("temper-ai repo")).toEqual({
			raw: "temper-ai repo",
			appOrSystem: "temper",
			repo: "temper-ai",
			kind: "repo",
			shareable: true,
		});
		expect(normalizeTouch("temper-deploy")).toEqual({
			raw: "temper-deploy",
			appOrSystem: "temper",
			repo: "temper-ai",
			kind: "deploy",
			shareable: true,
		});
		expect(normalizeTouch("scheduler")).toEqual({
			raw: "scheduler",
			appOrSystem: "scheduler",
			kind: "service",
			shareable: false,
		});
		expect(normalizeTouch("wt.yaml")).toEqual({
			raw: "wt.yaml",
			appOrSystem: "agent-tools",
			kind: "config",
			shareable: false,
		});

		expect(normalizeTouches(undefined)).toEqual([]);
		expect(normalizeTouches(["pi-web-ui repo", "  PI-WEB-UI   repo ", "", "pi-web-deploy"])).toEqual([
			{
				raw: "pi-web-ui repo",
				appOrSystem: "pi-web-ui",
				repo: "pi-web-ui",
				kind: "repo",
				shareable: true,
			},
			{
				raw: "pi-web-deploy",
				appOrSystem: "pi-web-ui",
				repo: "pi-web-ui",
				kind: "deploy",
				shareable: true,
			},
		]);
	});
});

describe("queue-requester tags support", () => {
	it("accepts and normalizes valid tags on kind='role', omits empty tags, and rejects invalid tags", () => {
		expect(
			requesterInputOf({
				kind: "role",
				role: "coo",
				id: "rm-12345678",
				message: "request",
				tags: ["  roles-rework  ", "glanceability", "roles-rework"],
			}),
		).toEqual({
			kind: "role",
			role: "coo",
			id: "rm-12345678",
			message: "request",
			tags: ["roles-rework", "glanceability"],
		});

		expect(
			requesterInputOf({
				kind: "role",
				role: "coo",
				id: "rm-12345678",
				message: "request",
				tags: [],
			}),
		).toEqual({
			kind: "role",
			role: "coo",
			id: "rm-12345678",
			message: "request",
		});

		expect(
			requesterInputOf({
				kind: "role",
				role: "coo",
				id: "rm-12345678",
				message: "request",
				tags: ["Bad_Tag"],
			}),
		).toBeUndefined();
	});
});

describe("role-messages and role-message-tool tags propagation", () => {
	function makeStore() {
		const dir = makeTmpDir("role-msg-tags-");
		let now = 1_700_000_000_000;
		const host: RoleMessageHost = {
			roles: () => ROLES,
			chatState: () => "idle",
			deliver: async () => ({ ok: true }),
			note: async () => ({ ok: true }),
			log: () => {},
		};
		const store = new RoleMessages(path.join(dir, "role-messages.jsonl"), host, () => now, GUARD_POLICY_V1);
		activeStores.push(store);
		return { store, advance: (ms: number) => (now += ms) };
	}

	it("validates tags on send, inherits on reply when omitted, clears on reply with [], and formats roleMessageHeader", () => {
		const { store } = makeStore();
		const cooSender = {
			role: "coo",
			title: "COO",
			chat: "home chat",
			file: "/tmp/coo/main.jsonl",
			handling: 0,
		};
		const beSender = {
			role: "backend",
			title: "Backend engineering",
			chat: "home chat",
			file: "/tmp/backend/main.jsonl",
			handling: 0,
		};

		const bad = store.send(cooSender, {
			to: "backend",
			kind: "request",
			text: "Build B1a",
			tags: ["Invalid_Tag"],
		});
		expect(bad.ok).toBe(false);
		if (!bad.ok) expect(bad.error).toContain("lowercase letters, digits, and dashes");

		const sent = store.send(cooSender, {
			to: "backend",
			kind: "request",
			text: "Build B1a",
			tags: ["  roles-rework ", "track-b1", "roles-rework"],
		});
		expect(sent.ok).toBe(true);
		if (!sent.ok) return;
		expect(sent.record.tags).toEqual(["roles-rework", "track-b1"]);

		const header = roleMessageHeader(sent.record);
		expect(header).toBe(
			`[Role message ${sent.record.id} from coo (COO), sent from its home chat · request] [tags: roles-rework, track-b1]`,
		);
		expect(ROLE_MESSAGE_HEADER.test(header)).toBe(true);
		expect(starterOf({ role: "user", text: `${header}\n\nBuild B1a` })).toEqual({ kind: "role" });

		// Reply with tags omitted -> inherits original's tags
		const replyInherited = store.send(beSender, {
			to: "coo",
			kind: "reply",
			replyTo: sent.record.id,
			text: "Queued as backend #118",
		});
		expect(replyInherited.ok).toBe(true);
		if (replyInherited.ok) {
			expect(replyInherited.record.tags).toEqual(["roles-rework", "track-b1"]);
		}

		// Second request to test clearing tags with [] on reply
		const sent2 = store.send(cooSender, {
			to: "backend",
			kind: "question",
			text: "Status?",
			tags: ["roles-rework"],
		});
		expect(sent2.ok).toBe(true);
		if (!sent2.ok) return;

		const replyCleared = store.send(beSender, {
			to: "coo",
			kind: "reply",
			replyTo: sent2.record.id,
			text: "Done",
			tags: [],
		});
		expect(replyCleared.ok).toBe(true);
		if (replyCleared.ok) {
			expect(replyCleared.record.tags).toBeUndefined();
		}
	});

	it("exposes tags in makeMessageRoleTool parameters and result details", async () => {
		const { store } = makeStore();
		const tool = makeMessageRoleTool({
			service: () => store,
			sender: () => ({
				role: "coo",
				title: "COO",
				chat: "home chat",
				file: "/tmp/coo/main.jsonl",
				handling: 0,
			}),
		});
		const res = await tool.execute(
			"call-1",
			{
				to: "backend",
				kind: "request",
				text: "Implement B1a",
				tags: ["roles-rework", "glanceability"],
			},
			undefined,
			undefined,
			{} as never,
		);
		expect(res.details).toMatchObject({
			to: "backend",
			kind: "request",
			tags: ["roles-rework", "glanceability"],
		});
	});
});

describe("server/task-queue replay of tags and delivery", () => {
	it("replays explicit and inherited tags on add, updates/clears tags on update, and replays delivery on done", () => {
		const q = taskQueueFromEntries(
			[
				entry({
					op: "add",
					id: 1,
					text: "Explicit tags task",
					plan: samplePlan("Explicit tags task"),
					origin: {
						v: 1,
						inputs: [{ kind: "role", role: "coo", id: "rm-11112222", message: "request", tags: ["from-origin"] }],
					},
					tags: ["Explicit-Tag", "second-tag"],
					ts: 1000,
				}),
				entry({
					op: "add",
					id: 2,
					text: "Inherited tags task",
					plan: samplePlan("Inherited tags task"),
					origin: {
						v: 1,
						inputs: [
							{
								kind: "role",
								role: "coo",
								id: "rm-33334444",
								message: "request",
								tags: ["roles-rework", "glanceability"],
							},
						],
					},
					ts: 1001,
				}),
				entry({
					op: "update",
					id: 1,
					text: "Explicit tags task",
					plan: samplePlan("Explicit tags task"),
					tags: ["updated-tag"],
					ts: 1002,
				}),
				entry({
					op: "done",
					id: 1,
					summary: "Landed B1a",
					delivery: {
						repo: "pi-web-ui",
						landId: "land-1762541000-a1b2c3",
						landedCommit: "A1B2C3D4E5F60718293A4B5C6D7E8F9012345678",
					},
					ts: 1003,
				}),
				entry({
					op: "update",
					id: 2,
					text: "Inherited tags task",
					plan: samplePlan("Inherited tags task"),
					tags: [],
					ts: 1004,
				}),
				entry({
					op: "done",
					id: 2,
					summary: "Landed via flat fields",
					repo: "pi-web-ui",
					land_id: "345-c1e6f3",
					landed_commit: "deadbeef1234",
					ts: 1005,
				}),
			],
			true,
		);

		const t1 = q.tasks.find((t) => t.id === 1);
		const t2 = q.tasks.find((t) => t.id === 2);

		expect(t1?.tags).toEqual(["updated-tag"]);
		expect(t1?.delivery).toEqual({
			repo: "pi-web-ui",
			landId: "land-1762541000-a1b2c3",
			landedCommit: "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678",
		});

		expect(t2?.tags).toBeUndefined();
		expect(t2?.origin?.inputs[0]).toMatchObject({
			kind: "role",
			role: "coo",
			tags: ["roles-rework", "glanceability"],
		});
		expect(t2?.delivery).toEqual({
			repo: "pi-web-ui",
			landId: "345-c1e6f3",
			landedCommit: "deadbeef1234",
		});
	});
});
