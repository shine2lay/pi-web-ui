import { describe, expect, it } from "vitest";
import {
	isQueuePseudoClientId,
	QUEUE_HOME_CLIENT_ID,
	QUEUE_TASKS_CLIENT_ID,
	queueHomeClientIdFor,
	queueLaneKey,
	queueTaskIdOf,
	queueTasksClientIdFor,
	resolveQueueLaneRoleKey,
} from "../../server/queue-chat-lane.js";
import {
	ALARM_COOLDOWN_MS,
	isQueueLaneWatchdogError,
	MAX_CONCURRENT_ROLE_OPENS,
	QUEUE_CEILING_WAIT_DEADLINE_MS,
	QUEUE_CLOSE_DEADLINE_MS,
	QUEUE_LANE_DEADLINE_MS,
	QUEUE_START_TURN_DEADLINE_MS,
	type QueueLaneStall,
	QueueLaneWatchdogError,
	queueAlarmSeconds,
	queueChatIsWorking,
	queueLaneStallAlarm,
	queueLaneStallLogLine,
	resolveQueueLaneTuning,
	sampleQueueHeap,
	UNASSIGNED_QUEUE_ROLE,
} from "../../server/queue-lane-watchdog.js";

/**
 * queue-resilience seam (Ops #812, Architecture #516): the pure helpers the per-role lanes, the watchdog and the
 * owner alarm are built on. The behaviour they enable is Q-ASSERT-1..6 (queue-lane-resilience.test.ts).
 */

const stall = (over: Partial<QueueLaneStall> = {}): QueueLaneStall => ({
	role: "architecture",
	lane: "open",
	phase: "preparing_launch",
	elapsedMs: 61_234,
	deadlineMs: 60_000,
	taskId: 510,
	sessionFile: "/s/a b.jsonl",
	conversationId: "c7",
	heapUsedMB: 3686,
	rssMB: 4608,
	...over,
});

describe("queue-resilience seam: deadlines (Q-WATCHDOG-1, Q-ISO-3, Q-ALARM-1)", () => {
	it("has the contract's values, and tuning falls back to them", () => {
		expect([
			QUEUE_LANE_DEADLINE_MS,
			QUEUE_START_TURN_DEADLINE_MS,
			QUEUE_CEILING_WAIT_DEADLINE_MS,
			QUEUE_CLOSE_DEADLINE_MS,
			MAX_CONCURRENT_ROLE_OPENS,
			ALARM_COOLDOWN_MS,
		]).toEqual([60_000, 120_000, 120_000, 900_000, 4, 300_000]);
		expect(resolveQueueLaneTuning(undefined)).toEqual({
			laneDeadlineMs: 60_000,
			startTurnDeadlineMs: 120_000,
			ceilingWaitDeadlineMs: 120_000,
			maxConcurrentOpens: 4,
			alarmCooldownMs: 300_000,
		});
		expect(
			resolveQueueLaneTuning({
				laneDeadlineMs: 50,
				maxConcurrentOpens: 2.7,
				alarmCooldownMs: -1,
				startTurnDeadlineMs: NaN,
			}),
		).toMatchObject({
			laneDeadlineMs: 50,
			maxConcurrentOpens: 2,
			alarmCooldownMs: 300_000,
			startTurnDeadlineMs: 120_000,
		});
	});
});

describe("queue-resilience seam: role lanes and pseudo clients (Q-ISO-1, Q-ISO-1a)", () => {
	it("names each role's pseudo clients and recognises every queue pseudo client", () => {
		expect(queueTasksClientIdFor("ops")).toBe("carry-on:queue:ops");
		expect(queueTasksClientIdFor("architecture", 1)).toBe("carry-on:queue:architecture:g1");
		expect(queueHomeClientIdFor("ops")).toBe("carry-on:queue-home:ops");
		expect(queueHomeClientIdFor(UNASSIGNED_QUEUE_ROLE, 3)).toBe("carry-on:queue-home:__unassigned__:g3");
		expect(queueLaneKey("qa", "close")).toBe("qa/close");
		for (const id of [
			QUEUE_TASKS_CLIENT_ID,
			QUEUE_HOME_CLIENT_ID,
			"carry-on:queue:ops",
			"carry-on:queue:architecture:g12",
			"carry-on:queue-home:__unassigned__",
		])
			expect(isQueuePseudoClientId(id), id).toBe(true);
		for (const id of ["carry-on:wake-reopen", "carry-on:queue:", "carry-on:queue:ops:g0", "desk", "carry-on:queuex"])
			expect(isQueuePseudoClientId(id), id).toBe(false);
		expect(() => queueTasksClientIdFor("a:b")).toThrow(/role key/);
		expect(() => queueTasksClientIdFor("ops", -1)).toThrow(/generation/);
	});

	it("resolves a lane's role in the contract's order, and falls back to __unassigned__", async () => {
		const homes: Record<string, string> = { "/h/arch.jsonl": "architecture", "/h/ops.jsonl": "ops" };
		const lookup = {
			roleOfHomeChat: (f: string) => homes[f],
			roleOfOpenChat: (f: string) => (f === "/t/open.jsonl" ? "design" : undefined),
			queueChatOfTaskFile: async (f: string) => (f === "/t/closed.jsonl" ? "/h/ops.jsonl" : undefined),
		};
		const entries = [{ customType: "queue", data: { op: "assigned", id: 9, from: { file: "/h/arch.jsonl" } } }];
		expect(await resolveQueueLaneRoleKey({ roleId: "qa", entries }, lookup)).toBe("qa");
		expect(await resolveQueueLaneRoleKey({ entries, file: "/t/open.jsonl" }, lookup)).toBe("architecture");
		expect(await resolveQueueLaneRoleKey({ file: "/h/ops.jsonl" }, lookup)).toBe("ops");
		expect(await resolveQueueLaneRoleKey({ file: "/t/open.jsonl" }, lookup)).toBe("design");
		expect(await resolveQueueLaneRoleKey({ file: "/t/closed.jsonl" }, lookup)).toBe("ops");
		expect(await resolveQueueLaneRoleKey({ file: "/t/other.jsonl" }, lookup)).toBe(UNASSIGNED_QUEUE_ROLE);
		expect(await resolveQueueLaneRoleKey({ entries }, undefined)).toBe(UNASSIGNED_QUEUE_ROLE);
		const throwing = {
			roleOfHomeChat: () => {
				throw new Error("registry unreadable");
			},
		};
		expect(await resolveQueueLaneRoleKey({ entries, file: "/h/ops.jsonl" }, throwing)).toBe(UNASSIGNED_QUEUE_ROLE);
		expect(queueTaskIdOf(entries)).toBe(9);
		expect(queueTaskIdOf([{ customType: "identity", data: { id: 3 } }])).toBeNull();
	});
});

describe("queue-resilience seam: stall record, log line and alarm (Q-WATCHDOG-2, Q-ALARM-2, Q-HEAP-2)", () => {
	it("logs the contract's line", () => {
		expect(queueLaneStallLogLine(stall())).toBe(
			'[queue-watchdog] lane stall freed: {"role":"architecture","lane":"open","phase":"preparing_launch",' +
				'"elapsedMs":61234,"deadlineMs":60000,"taskId":510,"sessionFile":"/s/a b.jsonl","conversationId":"c7",' +
				'"heapUsedMB":3686,"rssMB":4608,"action":"lane_freed"}',
		);
	});

	it("builds the owner's telegram_send alarm, naming heap and RSS only from 3072 MB", () => {
		expect(queueLaneStallAlarm(stall())).toEqual({
			text:
				"Queue stall in architecture: open (preparing_launch, task #510) made no progress for 61s (limit 60s). " +
				"Automatic recovery: freed architecture's open lane without closing active chats. (heap 3686MB, rss 4608MB) " +
				"Action: check the chat in pi-web-ui, or run pi-web-deploy restart if turns are not advancing.",
			from: "architecture",
			url: "/?chat=%2Fs%2Fa%20b.jsonl",
			linkLabel: "Open Queue",
		});
		const quiet = queueLaneStallAlarm(
			stall({
				role: UNASSIGNED_QUEUE_ROLE,
				lane: "home",
				phase: "running_home_action",
				taskId: null,
				sessionFile: null,
				heapUsedMB: 3071,
			}),
		);
		expect(quiet.from).toBe("ops");
		expect(quiet.url).toBe("/");
		expect(quiet.text).toContain("home (running_home_action) made no progress");
		expect(quiet.text).not.toContain("heap");
		expect(queueAlarmSeconds(50)).toBe("0.1");
		expect(queueAlarmSeconds(120_000)).toBe("120");
	});

	it("samples heap as whole MB and carries the stall on its error", () => {
		expect(sampleQueueHeap({ heapUsed: 3686 * 1024 * 1024, rss: 4608.4 * 1024 * 1024 })).toEqual({
			heapUsedMB: 3686,
			rssMB: 4608,
		});
		const err = new QueueLaneWatchdogError(stall());
		expect(err.code).toBe("QUEUE_LANE_STALL_TIMEOUT");
		expect(err.stall.role).toBe("architecture");
		expect(err).toBeInstanceOf(Error);
		expect(isQueueLaneWatchdogError(err)).toBe(true);
		expect(isQueueLaneWatchdogError(new Error("x"))).toBe(false);
	});
});

describe("queue-resilience seam: what counts as a working chat (Q-WATCHDOG-3)", () => {
	it("any sign of work keeps a chat from being closed or disposed", () => {
		expect(queueChatIsWorking(null)).toBe(false);
		expect(queueChatIsWorking({})).toBe(false);
		expect(queueChatIsWorking({ isStreaming: false, sendsInFlight: 0, blockingTerminals: 0 })).toBe(false);
		for (const a of [
			{ isStreaming: true },
			{ isCompacting: true },
			{ sendsInFlight: 1 },
			{ blockingTerminals: 2 },
			{ hasActiveSubagentRun: true },
			{ hasPendingWaitSubscription: true },
		])
			expect(queueChatIsWorking(a), JSON.stringify(a)).toBe(true);
	});
});
