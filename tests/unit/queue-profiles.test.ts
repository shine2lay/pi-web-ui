import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { previewExistingQueueLaunch } from "../../server/queue-host.js";
import type { Api, Model as AiModel } from "@earendil-works/pi-ai/compat";
type Model = AiModel<Api>;
import type { UiTaskLaunch, UiTaskProfile } from "../../server/protocol.js";
import {
	checkPatch,
	defaultThinking,
	patchProfile,
	prepareLaunch,
	profileChoices,
	QueueLaunchRefused,
	resolveLaunch,
	validateProfile,
} from "../../server/queue-profile.js";
import { taskQueueFromEntries } from "../../server/task-queue.js";
import {
	consumeOwnerSetting,
	issueOwnerSetting,
	ownerQueueMatches,
	parseOwnerSetting,
} from "../../server/queue-owner.js";
import { FastModeRegistry, fastRefusalReason } from "../../server/fast-mode.js";
import { effectiveProfile } from "../../web/src/components/QueueProfile.js";
const astra = {
	provider: "openai-codex",
	id: "gpt-6-astra",
	reasoning: true,
	thinkingLevelMap: { xhigh: "xhigh", max: "xhigh" },
} as unknown as Model;
const sol = { ...astra, id: "gpt-6.1-sol" } as Model;
const claude = { provider: "anthropic", id: "claude-opus-5-5", reasoning: true } as Model;
const plain = { provider: "fixture", id: "plain", reasoning: false } as Model;
const entry = (data: Record<string, unknown>) => ({
	type: "custom",
	customType: "queue",
	data: { v: 1, ts: 100, ...data },
});
const plan = {
	title: "Fixture",
	goal: "Fixture only",
	doneWhen: "Done",
	decided: "No real tasks",
	steps: "Inspect",
	verify: "Model-free",
	mustNot: "Call a provider",
};
const add = (id: number, profile?: UiTaskProfile) => entry({ op: "add", id, plan, profile });
const state = (entries: ReturnType<typeof entry>[], queue = "q") =>
	taskQueueFromEntries(entries, true, undefined, undefined, queue);
afterEach(() => vi.useRealTimers());

describe("queue launch contract", () => {
	it("approval previews read the exact loaded source without creating a hidden task client", async () => {
		const request = resolveLaunch({ thinking: "high" });
		const launch = { ...request, model: "fixture/plain", speed: "standard" as const };
		const createTaskClient = vi.fn();
		const other = { previewQueueLaunch: vi.fn(async () => undefined), createTaskClient };
		const source = { previewQueueLaunch: vi.fn(async () => launch), createTaskClient };
		expect(await previewExistingQueueLaunch(request, "/fixture", "source-id", [other, source])).toBe(launch);
		expect(source.previewQueueLaunch).toHaveBeenCalledWith(request, "/fixture", "source-id");
		expect(createTaskClient).not.toHaveBeenCalled();
		await expect(previewExistingQueueLaunch(request, "/fixture", "gone", [])).rejects.toThrow(/no longer loaded/);
		const code = readFileSync(new URL("../../server/agent-service.ts", import.meta.url), "utf8");
		const hostPreview = code.slice(
			code.indexOf("previewLaunch:"),
			code.indexOf("startChat:", code.indexOf("previewLaunch:")),
		);
		expect(hostPreview).toContain("previewExistingQueueLaunch");
		expect(hostPreview).not.toContain("withQueueClient");
		expect(code).toContain("if (!queue.available && !queue.from) return queue;");
		expect(code).toContain("if (cached?.key === key) return cached.view;");
	});
	it("inherits each field independently and clears only explicitly given nulls", () => {
		expect(resolveLaunch()).toEqual({ from: { model: "app", thinking: "app", speed: "app" } });
		expect(resolveLaunch({ model: "a/m", speed: "fast" }, { thinking: "low" }, { model: "b/m" })).toEqual({
			model: "a/m",
			thinking: "low",
			speed: "fast",
			from: { model: "queue", thinking: "task", speed: "queue" },
		});
		expect(patchProfile({ model: "a/m", thinking: "high", speed: "fast" }, { model: null })).toEqual({
			thinking: "high",
			speed: "fast",
		});
		expect(patchProfile({ model: "a/m" }, {})).toEqual({ model: "a/m" });
		expect(patchProfile({ model: "a/m" }, { model: null })).toBeUndefined();
		expect(checkPatch({ model: "missing-provider", thinking: "turbo", speed: "priority" }).problems).toHaveLength(3);
	});
	it("offers the existing model capabilities, never inventing tiers", () => {
		expect(profileChoices(astra).speeds).toEqual(["standard", "fast", "ultrafast"]);
		expect(profileChoices(sol).speeds).toEqual(["standard", "fast"]);
		expect(profileChoices(claude).speeds).toEqual(["standard"]);
		expect(profileChoices(plain).thinkingLevels).toEqual(["off"]);
		expect(defaultThinking(plain, "max")).toBe("off");
		expect(() => validateProfile({ thinking: "high" }, plain)).toThrow(/does not support thinking/);
		expect(() => validateProfile({ speed: "fast" }, claude)).toThrow(/does not support fast/);
		expect(() => validateProfile({ speed: "ultrafast" }, sol)).toThrow(/does not support ultrafast/);
		expect(() => validateProfile({}, undefined)).toThrow(QueueLaunchRefused);
	});
	it("UI effective thinking follows the selected model's own default, not the parent's", () => {
		const models = [
			{
				id: "fixture/plain",
				name: "Plain",
				provider: "fixture",
				thinkingDefault: "off",
				thinkingLevels: ["off"],
				speeds: ["standard"] as const,
			},
		];
		const r = effectiveProfile(
			{ model: "fixture/plain" },
			undefined,
			{ model: "parent/reasoner", thinking: "max" },
			models as never,
		);
		expect(r.thinking).toBe("off");
		expect(r.from.thinking).toBe("app");
		expect(effectiveProfile({ model: "fixture/plain" }, { thinking: "high" }, {}, models as never).thinking).toBe(
			"high",
		);
	});
});

describe("model-free first request proof", () => {
	function child() {
		let model: Model | undefined = claude,
			thinking = "medium",
			speed: "standard" | "fast" | "ultrafast" = "fast";
		const calls: string[] = [];
		let record: UiTaskLaunch | undefined;
		return {
			calls,
			get record() {
				return record;
			},
			adapter: {
				selectModel: async (id: string | undefined, strict: boolean) => {
					calls.push(`model:${strict}`);
					if (id === "gone/m") throw new QueueLaunchRefused("Model unavailable: gone/m");
					if (id) model = id === "openai-codex/gpt-6-astra" ? astra : id === "fixture/plain" ? plain : claude;
				},
				model: () => model,
				thinking: () => thinking,
				preferredThinking: () => defaultThinking(model!, "max"),
				setThinking: (level: string) => {
					calls.push(`thinking:${level}`);
					thinking = defaultThinking(model!, level);
				},
				speed: () => speed,
				setSpeed: (s: typeof speed) => {
					calls.push(`speed:${s}`);
					speed = s;
				},
				record: (l: UiTaskLaunch) => {
					calls.push("record");
					record = l;
				},
			},
			request: () => {
				calls.push("request");
				return { model: `${model?.provider}/${model?.id}`, thinking, speed };
			},
		};
	}
	it("sets all settings and records the launch before exactly one simulated request", async () => {
		const c = child(),
			request = resolveLaunch({ model: "openai-codex/gpt-6-astra", thinking: "high", speed: "ultrafast" });
		const l = await prepareLaunch(request, c.adapter);
		expect(c.calls).toEqual(["model:true", "thinking:high", "speed:ultrafast", "record"]);
		expect(c.request()).toEqual({ model: l.model, thinking: "high", speed: "ultrafast" });
		expect(c.calls.filter((v) => v === "request")).toHaveLength(1);
		expect(c.record).toEqual(l);
		// The saved profile is requested, not a claim that the provider accepted its tier.
		expect(l).not.toHaveProperty("confirmedMode");
	});
	it("unspecified thinking uses the new model's app default and speed always starts Standard", async () => {
		const c = child();
		await prepareLaunch(resolveLaunch({ model: "fixture/plain" }), c.adapter);
		expect(c.request()).toEqual({ model: "fixture/plain", thinking: "off", speed: "standard" });
	});
	it("refuses unavailable model, unsupported thinking and tier with zero requests", async () => {
		for (const profile of [
			{ model: "gone/m" },
			{ model: "fixture/plain", thinking: "high" },
			{ model: "anthropic/claude-opus-5-5", speed: "fast" },
		]) {
			const c = child();
			await expect(prepareLaunch(resolveLaunch(profile as UiTaskProfile), c.adapter)).rejects.toBeInstanceOf(
				QueueLaunchRefused,
			);
			expect(c.calls).not.toContain("request");
			expect(c.calls).not.toContain("record");
		}
	});
	it("detects silent SDK model/think/speed substitution instead of accepting it", async () => {
		let c = child();
		c.adapter.selectModel = async () => {};
		await expect(prepareLaunch(resolveLaunch({ model: "openai-codex/gpt-6-astra" }), c.adapter)).rejects.toThrow(
			/model could not/,
		);
		c = child();
		c.adapter.setThinking = () => {};
		await expect(prepareLaunch(resolveLaunch({ thinking: "high" }), c.adapter)).rejects.toThrow(
			/Thinking level could not/,
		);
		c = child();
		c.adapter.setSpeed = () => {};
		await expect(prepareLaunch(resolveLaunch({ speed: "standard" }), c.adapter)).rejects.toThrow(/speed could not/);
	});
	it("request-tier hook isolates transports and leaves real refusal cooldown handling intact", () => {
		const reg = new FastModeRegistry(() => 1000000);
		const sm = (id: string) => ({ getSessionId: () => id, getEntries: () => [] });
		const a = sm("fixture-a"),
			b = sm("fixture-b");
		reg.setMode(a, "ultrafast");
		reg.setMode(b, "standard");
		expect((reg.rewritePayload(a, astra, { model: astra.id }) as { service_tier: string }).service_tier).toBe(
			"ultrafast",
		);
		expect(reg.rewritePayload(b, astra, { model: astra.id })).toBeUndefined();
		expect(reg.view(a, astra)?.confirmedMode).toBeUndefined();
		expect(fastRefusalReason(400, "Unsupported service_tier")).toBeTruthy();
	});
});

describe("replay and queue isolation", () => {
	it("waiting tasks change with defaults but prepared started/resumed tasks do not", () => {
		const launch = resolveLaunch({ model: "a/m", thinking: "high", speed: "fast" });
		const entries = [
			add(1),
			add(2, { thinking: "low" }),
			add(3),
			entry({ op: "profile", queueId: "q", model: "a/m", speed: "fast" }),
			entry({ op: "start", id: 1, lane: true, launch }),
			entry({ op: "prepared", id: 1, launch }),
			entry({ op: "chat", id: 1, file: "/fake/child" }),
			entry({ op: "profile", queueId: "q", model: "b/m", speed: "standard" }),
			entry({ op: "task_profile", queueId: "q", id: 1, thinking: "off" }),
		];
		let s = state(entries)!;
		expect(s.tasks.find((t) => t.id === 1)?.launch).toEqual(launch);
		expect(resolveLaunch(s.profile, s.tasks.find((t) => t.id === 2)?.profile)).toMatchObject({
			model: "b/m",
			thinking: "low",
			speed: "standard",
		});
		entries.push(
			entry({ op: "wait", id: 1, what: "Fixture", check: "true", everyMs: 1000, until: 2000 }),
			entry({ op: "resume", id: 1 }),
		);
		s = state(entries)!;
		expect(s.tasks.find((t) => t.id === 1)?.launch).toEqual(launch);
		expect(state(entries, "fork")?.profile).toBeUndefined();
	});
	it("old entries work; rejected dispatch can correct defaults and starts afresh", () => {
		const es = [
			add(1),
			entry({ op: "start", id: 1, lane: true, launch: resolveLaunch({ model: "gone/m" }) }),
			entry({ op: "requeue", id: 1 }),
			entry({ op: "blocked", id: 1, reason: "Unavailable" }),
		];
		expect(state(es)?.tasks[0]).toMatchObject({ status: "ready", problem: "Unavailable" });
		expect(state(es)?.tasks[0].launch).toBeUndefined();
		es.push(entry({ op: "profile", queueId: "q", model: "a/m" }));
		expect(state(es)?.tasks[0].problem).toBeUndefined();
		expect(state([add(1)])?.profile).toBeUndefined();
	});
});

describe("trusted owner setting fences", () => {
	it("requires exact queue/conversation and accepts only structured patches", () => {
		expect(ownerQueueMatches("c", "q", "c", "q")).toBe(true);
		expect(ownerQueueMatches("c", "fork", "c", "q")).toBe(false);
		expect(parseOwnerSetting("defaults", undefined, { thinking: null })).toEqual({
			setting: "profile",
			patch: { thinking: null },
		});
		expect(parseOwnerSetting("taskProfile", undefined, { model: "a/m" }, 1)).toEqual({
			setting: "profile",
			id: 1,
			patch: { model: "a/m" },
		});
		for (const id of [undefined, 0, -1, 1.5, "1"])
			expect(parseOwnerSetting("taskProfile", undefined, { model: "a/m" }, id)).toBeUndefined();
		expect(parseOwnerSetting("defaults", undefined, { thinking: "turbo" })).toBeUndefined();
	});
	it("rejects reuse, stale task snapshots, expiration and wrong-queue capabilities", () => {
		let current = true;
		const t = issueOwnerSetting("q", { setting: "profile", id: 1, patch: { speed: "fast" } }, () => current);
		expect(consumeOwnerSetting(t.token, "wrong")).toBeUndefined();
		expect(consumeOwnerSetting(t.token, "q")).toBeUndefined();
		const u = issueOwnerSetting("q", { setting: "profile", patch: { model: "a/m" } }, () => current);
		current = false;
		expect(consumeOwnerSetting(u.token, "q")).toBeUndefined();
		current = true;
		const v = issueOwnerSetting("q", { setting: "profile", patch: { speed: null } }, () => current);
		expect(consumeOwnerSetting(v.token, "q")?.setting).toBe("profile");
		expect(consumeOwnerSetting(v.token, "q")).toBeUndefined();
		vi.useFakeTimers();
		const old = issueOwnerSetting("q", { setting: "profile", patch: { speed: "standard" } }, () => true);
		vi.advanceTimersByTime(5001);
		expect(consumeOwnerSetting(old.token, "q")).toBeUndefined();
	});
});
