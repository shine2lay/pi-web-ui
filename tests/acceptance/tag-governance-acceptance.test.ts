// Tag governance acceptance (ops #963, Rule 18 Task 1; ops #964 builds it and may not weaken or delete these).
// Owner 2026-11-15, Design home chat (via rm-ae23a75e): "also i see the tags being used freely, like i saw 2 for open
// viking work". Run: npm run test:tag-governance-acceptance (outside the land gate's tests/unit until ops #964 makes
// it pass). The cross-repo parity check reads pi-queue's copy from TAG_GOVERNANCE_PEER (default ~/projects/pi-queue).
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { IdentityDef } from "../../server/identities.js";
import { makeMessageRoleTool } from "../../server/role-message-tool.js";
import {
	RoleMessages,
	type RoleMessageHost,
	type RoleMessageSender,
	type RoleMessageSendInput,
} from "../../server/role-messages.js";
import {
	CANONICAL_TAG_ALIASES,
	canonicalizeTagList,
	CONFIRM_NEW_TAG_DESCRIPTION,
	governTags,
	type TagGovernanceContext,
	type TagGovernanceHost,
	type WorkerTaskTags,
} from "../../server/shared/task-tag-governance.js";
import { checkTags, normTags } from "../../server/shared/task-tags.js";
import { TASK_QUEUE_ENTRY_TYPE, taskQueueFromEntries, type TaskQueueEntryLike } from "../../server/task-queue.js";

let dir = "";
const stops: Array<{ stop(): void }> = [];
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "tag-governance-"));
	mkdirSync(join(dir, "data"), { recursive: true });
});
afterEach(() => {
	for (const s of stops.splice(0)) s.stop();
	rmSync(dir, { recursive: true, force: true });
});

const role = (id: string, homeChat: string): IdentityDef =>
	({ id, title: id, homeChat, pastHomeChats: [], raw: {}, dir: join(dir, id) }) as unknown as IdentityDef;
function chat(name: string): string {
	const file = join(dir, `${name}.jsonl`);
	writeFileSync(file, `${JSON.stringify({ type: "session", version: 3, id: name, cwd: dir })}\n`);
	return file;
}
const governance: TagGovernanceContext = {
	knownCanonicalTags: new Set(["openviking-v2", "openviking-dashboard", "roles-page", "qa-setup", "tattoo-assistant"]),
	activeProjectIds: ["roles-page", "posting-app"],
	aliases: CANONICAL_TAG_ALIASES,
};
/** A RoleMessages store whose host knows the governance facts and one worker task (Queue ops #7). */
function messages(task: WorkerTaskTags | undefined) {
	const A = chat("ops-task-7");
	const B = chat("design-home");
	const O = chat("ops-home");
	const host: RoleMessageHost & TagGovernanceHost = {
		roles: () => [role("ops", O), role("design", B)],
		chatState: () => "closed",
		deliver: async () => ({ ok: true }),
		note: async () => ({ ok: true }),
		tagGovernance: () => governance,
		workerTaskTags: (t) => (t.queueId === "ops" && t.taskId === 7 ? task : undefined),
	};
	const s = new RoleMessages(join(dir, "data", "role-messages.json"), host, () => 1_000_000);
	stops.push(s);
	const worker: RoleMessageSender = {
		role: "ops",
		title: "ops",
		chat: "Queue #7",
		file: A,
		handling: 0,
		guard: { bindingId: "c-7", isHome: false, task: { queueId: "ops", taskId: 7 }, lastUserText: "" },
	};
	const home: RoleMessageSender = { role: "ops", title: "ops", chat: "home chat", file: O, handling: 0 };
	return { s, worker, home };
}
const draftTags = (
	s: RoleMessages,
	from: RoleMessageSender,
	input: RoleMessageSendInput & { confirmNewTag?: boolean },
) => {
	const r = s.prepare(from, input);
	if (!r.ok) throw new Error(r.error);
	return r.draft.tags;
};
const queueEntry = (data: Record<string, unknown>): TaskQueueEntryLike => ({
	type: "custom",
	customType: TASK_QUEUE_ENTRY_TYPE,
	data: { v: 1, ts: 1000, ...data },
});
const plan = (title: string) => ({
	title,
	goal: "g",
	done_when: "d",
	decided: "x",
	steps: "s",
	verify: "v",
	must_not: "m",
});

describe("the shared seam, as pi-web-ui imports it", () => {
	it("rewrites aliases and refuses a near new tag, as pi-queue's copy does", () => {
		expect(canonicalizeTagList(["openviking-fixes", "openviking-v2", "inkflow"])).toEqual([
			"openviking-v2",
			"tattoo-assistant",
		]);
		const r = governTags(["openviking-memory"], governance);
		expect(r.ok).toBe(false);
		expect(governTags(["openviking-memory"], { ...governance, confirmNewTag: true })).toEqual({
			ok: true,
			value: ["openviking-memory"],
			rewritten: [],
		});
	});
});

describe("historical read folding (no chat file or role-messages.json edited)", () => {
	it("normTags folds aliases", () => {
		expect(normTags(["openviking-fixes", "openviking-v2", "memory-explorer"])).toEqual([
			"openviking-v2",
			"openviking-dashboard",
		]);
	});

	it("the task queue replay folds a saved task's tags and its inherited origin tags", () => {
		const origin = {
			v: 1,
			inputs: [{ kind: "role", role: "design", id: "rm-12345678", message: "request", tags: ["inkflow"] }],
		};
		const queue = taskQueueFromEntries(
			[
				queueEntry({ op: "add", id: 1, plan: plan("Old"), tags: ["claim-check", "checked-research"] }),
				queueEntry({ op: "add", id: 2, plan: plan("Inherited"), origin }),
			],
			true,
		);
		expect(queue.tasks.map((t) => t.tags)).toEqual([["checked-research"], ["tattoo-assistant"]]);
	});
});

describe("message_role", () => {
	it("offers confirmNewTag with the shared description", () => {
		const { s, home } = messages(undefined);
		const tool = makeMessageRoleTool({ service: () => s, sender: () => home });
		const params = (tool.parameters as { properties: Record<string, { description?: string }> }).properties;
		expect(params.confirmNewTag?.description).toBe(CONFIRM_NEW_TAG_DESCRIPTION);
	});

	it("rewrites old tags to the canonical ones", () => {
		const { s, home } = messages(undefined);
		expect(
			draftTags(s, home, { to: "design", kind: "fyi", text: "x", tags: ["openviking-fixes", "openviking-v2"] }),
		).toEqual(["openviking-v2"]);
	});

	it("refuses a tag near a canonical one, naming it, the near tags, the projects and confirmNewTag", () => {
		const { s, home } = messages(undefined);
		const r = s.prepare(home, { to: "design", kind: "fyi", text: "x", tags: ["openviking-memory"] });
		expect(r.ok).toBe(false);
		if (r.ok) return;
		for (const word of [
			"openviking-memory",
			"openviking-v2",
			"openviking-dashboard",
			"roles-page",
			"posting-app",
			"confirmNewTag: true",
		]) {
			expect(r.error).toContain(word);
		}
	});

	it("lets the near tag through with confirmNewTag through the tool; an unrelated new tag needs nothing", async () => {
		const { s, home } = messages(undefined);
		const tool = makeMessageRoleTool({ service: () => s, sender: () => home });
		const run = tool.execute as unknown as (
			id: string,
			p: Record<string, unknown>,
		) => Promise<{ details: { tags?: string[] } }>;
		await expect(run("a", { to: "design", kind: "fyi", text: "one", tags: ["openviking-memory"] })).rejects.toThrow(
			/confirmNewTag: true/,
		);
		const ok = await run("b", {
			to: "design",
			kind: "fyi",
			text: "two",
			tags: ["openviking-memory"],
			confirmNewTag: true,
		});
		expect(ok.details.tags).toEqual(["openviking-memory"]);
		expect(draftTags(s, home, { to: "design", kind: "fyi", text: "three", tags: ["gpu-cluster"] })).toEqual([
			"gpu-cluster",
		]);
	});

	it("a worker task's message that omits tags inherits [project, ...task tags], canonicalized", () => {
		const { s, worker } = messages({ project: "roles-page", tags: ["roles-rework", "inkflow", "roles-page"] });
		expect(draftTags(s, worker, { to: "design", kind: "question", text: "Which?" })).toEqual([
			"roles-page",
			"roles-rework",
			"tattoo-assistant",
		]);
		const sent = s.send(worker, { to: "design", kind: "fyi", text: "Stored." });
		expect(sent.ok && sent.record.tags).toEqual(["roles-page", "roles-rework", "tattoo-assistant"]);
	});

	it("inherits a task's tags without a project, and its project without tags", () => {
		const tagsOnly = messages({ tags: ["openviking-fixes"] });
		expect(draftTags(tagsOnly.s, tagsOnly.worker, { to: "design", kind: "fyi", text: "x" })).toEqual(["openviking-v2"]);
		const projectOnly = messages({ project: "roles-page" });
		expect(draftTags(projectOnly.s, projectOnly.worker, { to: "design", kind: "fyi", text: "x" })).toEqual([
			"roles-page",
		]);
	});

	it("explicit tags [] from a worker clears; a home chat that omits tags gets none", () => {
		const { s, worker, home } = messages({ project: "roles-page", tags: ["roles-rework"] });
		expect(draftTags(s, worker, { to: "design", kind: "fyi", text: "x", tags: [] })).toBeUndefined();
		expect(draftTags(s, home, { to: "design", kind: "fyi", text: "x" })).toBeUndefined();
	});

	it("invalid tags fail exactly as checkTags", () => {
		const { s, home } = messages(undefined);
		const bad = checkTags(["Bad Tag"]);
		expect(bad.ok).toBe(false);
		expect(s.prepare(home, { to: "design", kind: "fyi", text: "x", tags: ["Bad Tag"] })).toEqual(bad);
	});
});

describe("cross-repo parity", () => {
	it("pi-queue's tag-governance.ts is this copy's bytes except the import line", () => {
		const imports = /^import \{ checkTags, MAX_TAGS_PER_ITEM \} from "\.\/(queue-tags\.ts|task-tags\.js)";$/m;
		const own = readFileSync(
			fileURLToPath(new URL("../../server/shared/task-tag-governance.ts", import.meta.url)),
			"utf8",
		);
		const peerRoot = process.env.TAG_GOVERNANCE_PEER || join(homedir(), "projects", "pi-queue");
		const peer = readFileSync(join(peerRoot, "tag-governance.ts"), "utf8");
		expect(own).toMatch(imports);
		expect(peer).toMatch(imports);
		expect(peer.replace(imports, "IMPORT")).toBe(own.replace(imports, "IMPORT"));
	});
});
