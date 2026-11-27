/**
 * Ops #1107: a backend lead (its role denies subagents) steers its own running task with the real pi-queue
 * (opt-in coupled proof, PI_QUEUE_NATIVE_SOURCE = a pi-queue worktree; contract pi-queue docs/queue-steer.md).
 *
 * The tool reaches the lead chat through pi-web-ui's gating and pi-identity's always-allowed list (this repo's
 * copy, C-PARITY-1); the note reaches the task's chat through this host's real "/queue" dispatch. A task that
 * asks, is blocked, or waits on a check (without wake) is refused and its chat gets nothing.
 */
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { applyAgentToolsGating } from "../../server/tool-manager.js";
import { defaultSettings, resolveToolLimits, toolPermitted } from "../../server/identity-config.js";
import { queueRecords } from "../fixtures/question-commit-host.js";
import { nativeQueueWorld, NATIVE_TASK_ID } from "./native-queue-world.js";

type World = Awaited<ReturnType<typeof nativeQueueWorld>>;
const worlds: World[] = [];
const NOTE = "Use the existing retry helper; skip the new one.";

const world = async () => {
	const w = await nativeQueueWorld({ role: "backend", homeAt: "parent" });
	worlds.push(w);
	return w;
};
const sent = (w: World) => w.sends.get(w.worker.file) ?? 0;
const steered = (w: World) => queueRecords(SessionManager.open(w.worker.file)).filter((r) => r.op === "steered");
const steer = (w: World, params: Record<string, unknown>) =>
	w.parent.tool("queue_steer", { id: NATIVE_TASK_ID, message: NOTE, ...params }).then(
		(details) => ({ details, error: undefined as string | undefined }),
		(err: Error) => ({ details: undefined, error: err.message }),
	);

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(new Date("2026-01-05T12:00:00.000Z"));
});
afterEach(async () => {
	try {
		for (const w of worlds.splice(0).reverse()) await w.close();
	} finally {
		vi.restoreAllMocks();
		vi.useRealTimers();
	}
});

it("a backend lead chat is offered queue_steer; its task chat and coo are not", () => {
	const limits = resolveToolLimits({ allow: null, deny: ["subagents"] }, defaultSettings({ HOME: "/h" }));
	expect(toolPermitted("queue_steer", limits)).toBe(true);
	expect(toolPermitted("subagent_steer", limits)).toBe(false);
	const active = (taskChat: boolean, role: string) => {
		let got: string[] = [];
		const session = {
			getAllTools: () => ["queue_steer", "queue_reply", "subagent_steer"].map((name) => ({ name })),
			getActiveToolNames: () => [],
			setActiveToolsByName: (names: Iterable<string>) => {
				got = [...names];
			},
		};
		applyAgentToolsGating(session as never, [], undefined, "linux", taskChat, role);
		return got;
	};
	expect(active(false, "backend")).toContain("queue_steer");
	expect(active(true, "backend")).not.toContain("queue_steer");
	expect(active(false, "coo")).not.toContain("queue_steer");
});

it("working: the note reaches the task's chat once, as a prompt when idle and a steer mid-turn", async () => {
	const w = await world();
	expect(w.task(w.worker).status).toBe("working");
	const idle = await steer(w, {});
	await w.drain();
	expect(idle.error).toBeUndefined();
	expect(idle.details).toEqual({ id: NATIVE_TASK_ID, n: 1, delivered: "prompt" });
	expect(sent(w)).toBe(1);
	w.worker.busy = true;
	const busy = await steer(w, {});
	await w.drain();
	expect(busy.details).toEqual({ id: NATIVE_TASK_ID, n: 2, delivered: "steer" });
	expect(steered(w).map((r) => [r.n, r.via])).toEqual([
		[1, "prompt"],
		[2, "steer"],
	]);
	expect(sent(w)).toBe(2);
	expect(w.model).not.toHaveBeenCalled();
});

it("asking: refused naming queue_reply; the ask stays open and the task's chat gets nothing", async () => {
	const w = await world();
	vi.setSystemTime(Date.now() + 1);
	await w.worker.tool("ask_lead", {
		question: "Which synthetic port should we use?",
		choices: ["Use 8080", "Use 9090"],
		progress: "Both ports are free in the fixture.",
		recommendation: "Use 8080 within scope.",
	});
	await w.drain();
	expect(w.task(w.worker).status).toBe("asking");
	const before = sent(w);
	const r = await steer(w, { wake: true });
	await w.drain();
	expect(r.error).toMatch(/asking.*queue_reply/s);
	expect(w.task(w.worker).status).toBe("asking");
	expect(sent(w)).toBe(before);
	expect(steered(w)).toEqual([]);
});

it("blocked: refused pointing to queue_reply; it stays blocked", async () => {
	const w = await world();
	await w.worker.tool("queue_blocked", { need: "the synthetic schema" });
	await w.drain();
	expect(w.task(w.worker).status).toBe("blocked");
	const before = sent(w);
	const r = await steer(w, {});
	await w.drain();
	expect(r.error).toMatch(/blocked.*queue_reply/s);
	expect(w.task(w.worker).status).toBe("blocked");
	expect(sent(w)).toBe(before);
	expect(steered(w)).toEqual([]);
});

it("waiting: refused without wake; wake: true delivers and the task works again", async () => {
	const w = await world();
	await w.worker.tool("queue_wait", { what: "a synthetic install", check: "false", expect_minutes: 30 });
	await w.drain();
	expect(w.task(w.worker).status).toBe("waiting");
	const before = sent(w);
	const no = await steer(w, {});
	await w.drain();
	expect(no.error).toMatch(/waiting on a synthetic install.*wake: true/s);
	expect(w.task(w.worker).status).toBe("waiting");
	expect(sent(w)).toBe(before);
	const yes = await steer(w, { wake: true });
	await w.drain();
	expect(yes.details).toEqual({ id: NATIVE_TASK_ID, n: 1, delivered: "prompt" });
	expect(w.task(w.worker).status).toBe("working");
	expect(sent(w)).toBe(before + 1);
});
