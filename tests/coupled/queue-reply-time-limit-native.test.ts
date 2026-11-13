/**
 * Ops #863: queue_reply under pi-web-ui's 2-minute limit, with the real pi-queue (opt-in coupled proof).
 *
 * A lead's decision relay hangs (the host command to the task's chat never comes back). The limit ends the
 * call with an error that says it may still have gone through; the lead then retries. Whether the late relay
 * arrives before the retry or not, the task's chat gets the decision exactly once and the retry is refused as
 * a duplicate. Proves pi-queue's own duplicate refusal holds under the limit; pi-queue itself is not changed.
 */
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TOOL_TIME_LIMITS, toolTimeLimitMs, withTimeLimit } from "../../server/tool-time-limit.js";
import type { AnyToolDefinition } from "../../server/tool-overrides.js";
import { latch, queueRecords } from "../fixtures/question-commit-host.js";
import { nativeQueueWorld, NATIVE_TASK_ID, type NativeTool } from "./native-queue-world.js";

type World = Awaited<ReturnType<typeof nativeQueueWorld>>;
const worlds: World[] = [];
const releases: Array<() => void> = [];
const LIMIT_MS = toolTimeLimitMs("queue_reply", {})!;
const WORDS = TOOL_TIME_LIMITS.queue_reply!.words;

/** The world with pi-web-ui's limit laid over queue_reply, exactly as the server lays it. */
const world = async () => {
	const limited = (tool: NativeTool): NativeTool =>
		tool.name === "queue_reply"
			? (withTimeLimit(tool as unknown as AnyToolDefinition, LIMIT_MS, WORDS) as unknown as NativeTool)
			: tool;
	const value = await nativeQueueWorld({ wrapTool: limited });
	worlds.push(value);
	return value;
};
/** Hangs the next "/queue decide" command to the task's chat until released. */
const hangNextDecide = (w: World) => {
	const entered = latch(),
		release = latch();
	releases.push(release.open);
	w.control.beforeCommand = async (line) => {
		if (!line.startsWith("/queue decide ")) return;
		w.control.beforeCommand = undefined;
		entered.open();
		await release.promise;
	};
	return { entered, release };
};
const resumes = (w: World) =>
	queueRecords(SessionManager.open(w.worker.file)).filter((row) => row.op === "resume" && row.by === "ops");
/** The decisions the task's chat was sent (its user messages from the queue). */
const sent = (w: World) => w.sends.get(w.worker.file) ?? 0;
/** The lead's queue_reply under the question's tag; settles with its result details or its error. */
const reply = (w: World, tag: string, answer: string) =>
	w.lead.tool("queue_reply", { id: NATIVE_TASK_ID, ask: tag, answer }).then(
		(details) => ({ details: details as Record<string, unknown> | undefined, text: undefined as string | undefined }),
		(err: Error) => ({ details: undefined, text: err.message }),
	);

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(new Date("2026-01-05T12:00:00.000Z"));
});
afterEach(async () => {
	for (const release of releases.splice(0)) release();
	try {
		for (const w of worlds.splice(0).reverse()) await w.close();
	} finally {
		vi.restoreAllMocks();
		vi.useRealTimers();
	}
});

async function askLead(w: World) {
	vi.setSystemTime(Date.now() + 1);
	await w.worker.tool("ask_lead", {
		question: "Which synthetic port should we use?",
		choices: ["Use 8080", "Use 9090"],
		progress: "Both ports are free in the fixture.",
		recommendation: "Use 8080 within scope.",
		constraints: "No deployment.",
	});
	await w.drain();
	expect(w.task(w.worker).status).toBe("asking");
}

/** The lead's first reply hangs in the relay; past the limit it ends with the honest error. */
async function timedOutReply(w: World) {
	const hang = hangNextDecide(w);
	const tag = w.freshTag();
	let settled: Awaited<ReturnType<typeof reply>> | undefined;
	const call = reply(w, tag, "Use 8080.").then((r) => (settled = r));
	await hang.entered.promise;
	await vi.advanceTimersByTimeAsync(LIMIT_MS - 1);
	expect(settled).toBeUndefined();
	await vi.advanceTimersByTimeAsync(1);
	await call;
	return { hang, tag, settled: settled! };
}

describe("queue_reply under the 2-minute limit (real pi-queue)", () => {
	it("a hung relay ends at the limit; the late relay lands once and the retry is refused as a duplicate", async () => {
		const w = await world();
		await askLead(w);
		const before = sent(w);
		const { hang, tag, settled } = await timedOutReply(w);
		// pi-web-ui's error result (its words are checked in the unit test and the sealed e2e).
		expect(settled.details).toMatchObject({ timedOut: true, limitMs: LIMIT_MS });
		expect(resumes(w)).toHaveLength(0);
		// The relay was only slow: it lands after the limit.
		hang.release.open();
		await w.drain();
		expect(resumes(w)).toHaveLength(1);
		expect(w.task(w.worker).status).toBe("working");
		// The lead follows the error's advice too late, or retries anyway: refused, nothing more delivered.
		const again = await reply(w, tag, "Use 9090.");
		expect(again.details).toMatchObject({ again: true, delivered: true });
		await w.drain();
		expect(resumes(w)).toHaveLength(1);
		expect(sent(w) - before).toBe(1);
	});

	it("a retry while the hung relay is still out sends the same decision, never a second one", async () => {
		const w = await world();
		await askLead(w);
		const before = sent(w);
		const { hang, tag, settled } = await timedOutReply(w);
		expect(settled.details).toMatchObject({ timedOut: true });
		// Retry with a different answer while the first relay still hangs: pi-queue sends its recorded decision
		// again (the same record, never the new words); that send may wait behind the hung one, so the retry can
		// itself end at the limit.
		let again: Awaited<ReturnType<typeof reply>> | undefined;
		const retry = reply(w, tag, "Use 9090.").then((r) => (again = r));
		await vi.advanceTimersByTimeAsync(LIMIT_MS);
		await retry;
		expect(again?.details?.again === true || again?.details?.timedOut === true).toBe(true);
		expect(resumes(w).length).toBeLessThanOrEqual(1);
		// Now the late first relay lands too: still one decision, and it is the first one.
		hang.release.open();
		await w.drain();
		expect(resumes(w)).toHaveLength(1);
		expect(sent(w) - before).toBe(1);
		expect((w.task(w.worker) as { answered?: number }).answered).toBe(1);
	});
});
