import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import conformanceFixtures from "/home/shinelay/architecture-dept/work/roles-initiatives-rework/conformance-fixtures.json" with { type: "json" };
import type { IdentityDef } from "../../server/identities.js";
import type { UiTaskQueuePlan } from "../../server/protocol.js";
import { RolesOverviewReader, type RolesOverviewHost } from "../../server/roles-overview.js";
import {
	collectDependsOnRefs,
	computeGroupRollup,
	computeTagGroups,
	computeTouchSystems,
	DeliveryStateCache,
	readLiveDeploySnapshots,
	resolveBlockedState,
	resolveQueuedDetail,
	resolveTaskDeps,
	resolveTaskLifecycleAndDelivery,
	resolveWaitState,
	taskOf,
	warmDeliveryAncestryCache,
} from "../../server/roles-task-next.js";
import { checkTags, resolveInheritedTags } from "../../server/shared/task-tags.js";
import { normalizeTouch, normalizeTouches } from "../../server/shared/touch-normalizer.js";
import { TASK_QUEUE_ENTRY_TYPE, taskQueueFromEntries, type TaskQueueEntryLike } from "../../server/task-queue.js";
import { workFactsFromOverview, workPageFrom } from "../../server/work-page.js";

const samplePlan = (title: string): UiTaskQueuePlan => ({
	title,
	goal: "Implement Roles & Initiatives B2 resolver",
	doneWhen: "All conformance tests pass",
	decided: "Approved contract v4",
	steps: "1. Resolver\n2. Overview & WorkPage",
	verify: "vitest",
	mustNot: "No web/ changes",
});

const queueEntry = (data: Record<string, unknown>): TaskQueueEntryLike => ({
	type: "custom",
	customType: TASK_QUEUE_ENTRY_TYPE,
	data: { v: 1, ...data },
});

describe("Roles & Initiatives Rework Contract Conformance (conformance-fixtures.json)", () => {
	describe("Suite 1: tagValidationFixtures", () => {
		for (const fixture of conformanceFixtures.tagValidationFixtures) {
			it(`validates ${fixture.id}`, () => {
				const rawInput = fixture.omitted ? undefined : fixture.input;
				const result = checkTags(rawInput);
				expect(result.ok).toBe(fixture.expected.ok);
				if (fixture.expected.ok) {
					if (fixture.omitted) {
						expect(result).toEqual({ ok: true, value: undefined });
					} else {
						expect(result).toEqual({ ok: true, value: fixture.expected.value });
					}
				} else if (!result.ok && fixture.expected.errorSubstring) {
					expect(result.error).toContain(fixture.expected.errorSubstring);
				}
			});
		}
	});

	describe("Suite 2: tagPropagationFixtures", () => {
		for (const fixture of conformanceFixtures.tagPropagationFixtures) {
			it(`propagates tags for ${fixture.id}`, () => {
				if ("queueAddParams" in fixture && fixture.queueAddParams) {
					const explicitRaw = (fixture.queueAddParams as { tags?: unknown }).tags;
					const checked = checkTags(explicitRaw);
					expect(checked.ok).toBe(true);
					if (!checked.ok) return;
					const resolved = resolveInheritedTags(checked.value, fixture.originInputs);
					expect(resolved ?? []).toEqual(fixture.expectedStoredTags);

					const queue = taskQueueFromEntries(
						[
							queueEntry({
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
					expect(queue.tasks[0]?.tags ?? []).toEqual(fixture.expectedStoredTags);
				} else if ("queueAddUpdateParams" in fixture && fixture.queueAddUpdateParams) {
					const updateRaw = (fixture.queueAddUpdateParams as { tags?: unknown }).tags;
					const checked = checkTags(updateRaw);
					expect(checked.ok).toBe(true);
					if (!checked.ok) return;

					const queue = taskQueueFromEntries(
						[
							queueEntry({
								op: "add",
								id: fixture.queueAddUpdateParams.id,
								text: "Initial title",
								plan: samplePlan("Initial title"),
								tags: fixture.existingTaskTags,
								ts: 1000,
							}),
							queueEntry({
								op: "update",
								id: fixture.queueAddUpdateParams.id,
								text: fixture.queueAddUpdateParams.title ?? "Initial title",
								plan: samplePlan(fixture.queueAddUpdateParams.title ?? "Initial title"),
								...(fixture.queueAddUpdateParams.tags !== undefined ? { tags: fixture.queueAddUpdateParams.tags } : {}),
								ts: 2000,
							}),
						],
						true,
					);
					expect(queue.tasks[0]?.tags ?? []).toEqual(fixture.expectedStoredTags);
				}
			});
		}
	});

	describe("Suite 3: touchNormalizationFixtures", () => {
		for (const fixture of conformanceFixtures.touchNormalizationFixtures) {
			it(`normalizes "${fixture.raw}"`, () => {
				expect(normalizeTouch(fixture.raw)).toEqual(fixture.expected);
			});
		}

		it("normalizes and deduplicates lists via normalizeTouches", () => {
			const allRaws = conformanceFixtures.touchNormalizationFixtures.map((f) => f.raw);
			const allExpected = conformanceFixtures.touchNormalizationFixtures.map((f) => f.expected);
			expect(normalizeTouches([...allRaws, allRaws[0]])).toEqual(allExpected);
		});
	});

	describe("Suite 4: lifecycleResolutionFixtures", () => {
		for (const fixture of conformanceFixtures.lifecycleResolutionFixtures) {
			it(`resolves lifecycle for ${fixture.id}`, () => {
				const wtLandRecords = fixture.wtLandRecord ? [fixture.wtLandRecord] : [];
				const wtDeployRecords = fixture.wtDeployRecord ? { [fixture.wtDeployRecord.repo]: fixture.wtDeployRecord } : {};
				const isAncestor =
					"isLandedCommitAncestorOfLive" in fixture && typeof fixture.isLandedCommitAncestorOfLive === "boolean"
						? () => fixture.isLandedCommitAncestorOfLive as boolean
						: undefined;

				const resolved = resolveTaskLifecycleAndDelivery(fixture.task, {
					wtLandRecords: wtLandRecords as never,
					wtDeployRecords: wtDeployRecords as never,
					isCommitAncestor: isAncestor,
				});

				expect(resolved.lifecycleStatus).toBe(fixture.expectedLifecycleStatus);
				if ("expectedDeployPendingReason" in fixture && fixture.expectedDeployPendingReason) {
					expect(resolved.delivery?.deployPendingReason).toBe(fixture.expectedDeployPendingReason);
				}
				if ("expectedStatusTone" in fixture && fixture.expectedStatusTone) {
					expect(resolved.statusTone).toBe(fixture.expectedStatusTone);
				}
			});
		}
	});

	describe("Suite 5: groupRollupFixtures", () => {
		for (const fixture of conformanceFixtures.groupRollupFixtures) {
			it(`computes group rollup for ${fixture.id}`, () => {
				const tasks = fixture.memberLifecycleStatuses.map((ls, idx) => ({
					id: idx + 1,
					role: idx % 2 === 0 ? "backend" : "frontend",
					lifecycleStatus: ls as never,
					updatedAt: 1762540000000 + idx * 1000,
					touches: ["pi-web-ui repo"],
				}));
				const rollup = computeGroupRollup("roles-rework", "tag", tasks);
				expect(rollup.rollupStatus).toBe(fixture.expectedRollupStatus);
				expect(rollup.statusTone).toBe(fixture.expectedStatusTone);
				if ("expectedHasBlockedPeers" in fixture && typeof fixture.expectedHasBlockedPeers === "boolean") {
					expect(rollup.hasBlockedPeers).toBe(fixture.expectedHasBlockedPeers);
				}
				expect(rollup.totalTasks).toBe(fixture.memberLifecycleStatuses.length);
				// Verify all 12 lifecycle status keys exist on countsByStatus
				expect(Object.keys(rollup.countsByStatus).sort()).toEqual(
					[
						"paused",
						"stuck",
						"asking",
						"blocked",
						"waiting",
						"queued",
						"working",
						"landing",
						"landed",
						"deploying",
						"live",
						"done",
						"dropped",
					].sort(),
				);
			});
		}
	});

	describe("Suite 6: blockerAndWaitResolutionFixtures", () => {
		for (const fixture of conformanceFixtures.blockerAndWaitResolutionFixtures) {
			it(`resolves cross-queue blockers and deadlock for ${fixture.id}`, () => {
				const res = resolveBlockedState(fixture.blocked, {
					currentRole: fixture.currentRole,
					currentTaskId: 300,
					queuesByRole: fixture.queuesSnapshot,
					now: fixture.now,
				});

				expect(res.blocked.resolvedOn).toEqual(fixture.expectedResolvedOn);
				expect(res.blocked.unsatisfiedCount).toBe(fixture.expectedUnsatisfiedCount);
				expect(res.blocked.checkpointOverdue).toBe(fixture.expectedCheckpointOverdue);
				expect(res.dependsOnRefs).toEqual(fixture.expectedDependsOnRefs);
				expect(res.blocked.howToUnblock).toBe(fixture.expectedHowToUnblock);
			});
		}
	});
});

describe("Track B2 Additional Lifecycle, Blocker, and Overview/WorkPage Integration", () => {
	it("covers all 12 lifecycle states, Source 2/3 fallbacks, and pi-web-deploy joins", () => {
		// 1. Paused overrides active states
		expect(
			resolveTaskLifecycleAndDelivery({
				id: 1,
				role: "backend",
				status: "working",
				paused: true,
			}),
		).toMatchObject({
			lifecycleStatus: "paused",
			statusTone: "paused",
		});

		// 2. Stuck vs Asking
		expect(
			resolveTaskLifecycleAndDelivery({
				id: 2,
				role: "backend",
				status: "stuck",
			}),
		).toMatchObject({
			lifecycleStatus: "stuck",
			statusTone: "needs_you",
		});
		expect(
			resolveTaskLifecycleAndDelivery({
				id: 3,
				role: "backend",
				status: "asking",
			}),
		).toMatchObject({
			lifecycleStatus: "asking",
			statusTone: "needs_lead",
		});

		// 3. Waiting on pi-web-deploy result while deploy is running -> deploying (lime-green tone)
		expect(
			resolveTaskLifecycleAndDelivery(
				{
					id: 4,
					role: "backend",
					status: "waiting",
					touches: ["pi-web-ui repo", "pi-web-deploy"],
					wait: {
						what: "pi-web-deploy result aabbccdd",
						check: "pi-web-deploy result aabbccdd",
						since: 1000,
					},
				},
				{
					piWebDeployRecord: {
						status: "running",
						targetCommit: "aabbccdd11223344",
					},
				},
			),
		).toMatchObject({
			lifecycleStatus: "deploying",
			statusTone: "deploying",
			delivery: {
				repo: "pi-web-ui",
				deployableService: true,
				landedCommit: "aabbccdd",
				deployStatus: "deploying",
			},
		});

		// 4. Waiting overdue -> statusTone "needs_lead"
		expect(
			resolveTaskLifecycleAndDelivery(
				{
					id: 5,
					role: "backend",
					status: "waiting",
					wait: {
						what: "external check",
						check: "test -f /tmp/ready",
						overdue: true,
					},
				},
				{},
			),
		).toMatchObject({
			lifecycleStatus: "waiting",
			statusTone: "needs_lead",
		});

		// 5. Done with Source 3 doneSummary fallback + non-deployable repo (agent-tools) -> landed
		expect(
			resolveTaskLifecycleAndDelivery({
				id: 6,
				role: "systems",
				status: "done",
				touches: ["agent-tools repo"],
				doneSummary: "Landed commit 123456789abcdef in agent-tools.",
			}),
		).toMatchObject({
			lifecycleStatus: "done",
			statusTone: "live",
			delivery: {
				repo: "agent-tools",
				deployableService: false,
				landedCommit: "123456789abcdef",
			},
		});

		// 6. Done with failed deploy -> landed with deployPendingReason: "last_deploy_failed"
		expect(
			resolveTaskLifecycleAndDelivery(
				{
					id: 7,
					role: "backend",
					status: "done",
					touches: ["inkflow repo"],
					delivery: {
						repo: "inkflow",
						landedCommit: "deadbeef1234567",
					},
				},
				{
					wtDeployRecords: {
						inkflow: {
							repo: "inkflow",
							status: "failed",
							commit: "deadbeef1234567",
							error: "health check timed out",
						},
					},
				},
			),
		).toMatchObject({
			lifecycleStatus: "landed",
			statusTone: "landed",
			delivery: {
				repo: "inkflow",
				deployStatus: "failed",
				deployPendingReason: "last_deploy_failed",
				error: "health check timed out",
			},
		});
	});

	it("detects dependency cycles, paused/dropped/stuck targets, and queued lane conflicts", () => {
		const queues = {
			backend: {
				queueRunning: true,
				lanesAtOnce: 2,
				tasks: [
					{
						id: 10,
						title: "Task A",
						status: "blocked",
						block: { on: ["frontend #20"] },
					},
					{
						id: 11,
						title: "Hold standee",
						status: "working",
						touches: ["standee"],
					},
					{
						id: 12,
						title: "Queued behind standee",
						status: "ready",
						touches: ["standee"],
					},
				],
			},
			frontend: {
				queueRunning: true,
				tasks: [
					{
						id: 20,
						title: "Task B",
						status: "blocked",
						block: { on: ["backend #10"] },
					},
					{
						id: 21,
						title: "Dropped dep",
						status: "dropped",
					},
					{
						id: 22,
						title: "Paused dep",
						status: "working",
						paused: true,
					},
				],
			},
		};

		// Mutual cycle backend #10 <-> frontend #20
		const cycleRes = resolveTaskDeps(["frontend #20"], "backend", queues, 10);
		expect(cycleRes.resolved[0]?.deadlockReason).toBe("cycle_detected");

		// Dropped and paused targets
		const dpRes = resolveTaskDeps(["frontend #21", "frontend #22"], "backend", queues, 15);
		expect(dpRes.resolved[0]?.deadlockReason).toBe("target_dropped");
		expect(dpRes.resolved[1]?.deadlockReason).toBe("target_paused");

		// Queued behind non-shareable touch "standee"
		const queuedRes = resolveQueuedDetail(queues.backend.tasks[2], {
			currentRole: "backend",
			queueRunning: true,
			lanesAtOnce: 2,
			queueTasks: queues.backend.tasks,
			queuesByRole: queues,
		});
		expect(queuedRes.queuedDetail).toEqual({
			reason: "lane_busy",
			conflictingTasks: [{ id: 11, title: "Hold standee", touch: "standee" }],
			summary: "Lane busy: standee held by #11",
		});

		// Wait state formatting
		const waitNormal = resolveWaitState(
			{
				what: "temper restart",
				check: "curl -sf http://127.0.0.1:8420/health",
				since: 1_000_000,
				expectMinutes: 10,
			},
			1_120_000,
		);
		expect(waitNormal.overdue).toBe(false);
		expect(waitNormal.howToUnblock).toBe("Automatic once temper restart check passes (~8m left)");

		const waitOverdue = resolveWaitState(
			{
				what: "temper restart",
				check: "curl -sf http://127.0.0.1:8420/health",
				since: 1_000_000,
				expectMinutes: 10,
				lastExitCode: 1,
			},
			2_440_000,
		);
		expect(waitOverdue.overdue).toBe(true);
		expect(waitOverdue.howToUnblock).toContain("Check is overdue by 14m (last exit 1)");

		expect(collectDependsOnRefs("backend", ["#5", "frontend #20"], [6], [{ name: "ops", id: 9 }])).toEqual([
			"backend #5",
			"frontend #20",
			"backend #6",
			"ops #9",
		]);
	});

	it("wires queuesByRole, tagGroups, touchSystems, and task fields through RolesOverviewReader and WorkPage", async () => {
		const dir = mkdtempSync(join(tmpdir(), "ri-b2-overview-"));
		try {
			const backendHome = join(dir, "backend-home.jsonl");
			const designHome = join(dir, "design-home.jsonl");
			const runsFile = join(dir, "runs.json");
			const jobsFile = join(dir, "jobs.json");
			writeFileSync(runsFile, "[]\n");
			writeFileSync(jobsFile, "{}\n");

			const writeQueueEntries = (
				file: string,
				entries: Array<{ id: string; ts: number; data: Record<string, unknown> }>,
			) => {
				const lines = [
					JSON.stringify({ type: "session", id: `sess-${file}`, timestamp: new Date(1000).toISOString() }),
					...entries.map((e) =>
						JSON.stringify({
							type: "custom",
							customType: TASK_QUEUE_ENTRY_TYPE,
							id: e.id,
							timestamp: new Date(e.ts).toISOString(),
							data: { v: 1, ts: e.ts, ...e.data },
						}),
					),
				];
				writeFileSync(file, `${lines.join("\n")}\n`);
			};

			writeQueueEntries(designHome, [
				{
					id: "d1",
					ts: 1000,
					data: {
						op: "add",
						id: 205,
						text: "Design Roles prototype",
						plan: samplePlan("Design Roles prototype"),
						parent: { initiative: "system-arch-in-temper" },
						tags: ["roles-rework"],
						touches: ["pi-web-ui repo"],
					},
				},
				{
					id: "d2",
					ts: 1500,
					data: {
						op: "pause",
						reason: "stopped",
					},
				},
			]);

			writeQueueEntries(backendHome, [
				{
					id: "b1",
					ts: 2000,
					data: {
						op: "add",
						id: 120,
						text: "Implement B2 resolver",
						plan: samplePlan("Implement B2 resolver"),
						parent: { initiative: "system-arch-in-temper" },
						tags: ["roles-rework", "b2-resolver"],
						touches: ["pi-web-ui repo", "pi-web-deploy"],
					},
				},
				{
					id: "b2",
					ts: 2100,
					data: {
						op: "start",
						id: 120,
						lane: true,
						running: true,
					},
				},
				{
					id: "b3",
					ts: 2200,
					data: {
						op: "block",
						id: 120,
						on: [{ file: designHome, name: "design", id: 205 }],
						lead: "design",
						owes: "Show&Tell prototype link",
						checkpoint: 2500,
					},
				},
			]);

			const identities: IdentityDef[] = [
				{
					id: "backend",
					title: "Backend engineering",
					dir: join(dir, "id-backend"),
					homeChat: backendHome,
					role: { config: {} },
				} as unknown as IdentityDef,
				{
					id: "design",
					title: "Design",
					dir: join(dir, "id-design"),
					homeChat: designHome,
					role: { config: {} },
				} as unknown as IdentityDef,
			];

			const host: RolesOverviewHost = {
				identities: () => identities,
				chatState: () => "idle",
				asks: () => [],
				openRequestsTo: () => ({ open: 0 }),
				latestReportTo: () => undefined,
				rolePaused: () => false,
				sessionRoots: () => [dir],
				reportRunsFile: () => runsFile,
				schedulerJobsFile: () => jobsFile,
				now: () => 3000,
			};

			const reader = new RolesOverviewReader(host);
			const overview = await reader.read();

			const backendRole = overview.roles.find((r) => r.id === "backend");
			const bTask = backendRole?.queue?.active[0];
			expect(bTask).toBeDefined();
			expect(bTask?.tags).toEqual(["roles-rework", "b2-resolver"]);
			expect(bTask?.touches).toEqual(["pi-web-ui repo", "pi-web-deploy"]);
			expect(bTask?.normalizedTouches).toHaveLength(2);
			expect(bTask?.lifecycleStatus).toBe("blocked");
			expect(bTask?.statusTone).toBe("blocked");
			expect(bTask?.dependsOnRefs).toEqual(["design #205"]);
			expect(bTask?.blocked?.resolvedOn?.[0]).toMatchObject({
				ref: "design #205",
				role: "design",
				taskId: 205,
				lifecycleStatus: "queued",
				queueStopped: true,
				deadlockReason: "queue_stopped",
			});
			expect(bTask?.howToUnblock).toBe(
				"How to unblock: Resume design's queue so design #205 can run, and have design lead provide Show&Tell prototype link",
			);

			// Verify tagGroups and touchSystems on UiRolesOverview
			expect(overview.tagGroups).toBeDefined();
			const rolesReworkGroup = overview.tagGroups?.find((g) => g.key === "roles-rework");
			expect(rolesReworkGroup).toMatchObject({
				key: "roles-rework",
				kind: "tag",
				rollupStatus: "stalled",
				statusTone: "blocked",
				totalTasks: 2,
				roles: ["backend", "design"],
				appsOrSystems: ["pi-web-ui"],
			});
			expect(overview.touchSystems).toEqual([
				{
					appOrSystem: "pi-web-ui",
					repo: "pi-web-ui",
					activeTaskCount: 2,
					totalTaskCount: 2,
					tags: ["b2-resolver", "roles-rework"],
				},
			]);

			// Verify WorkPage assembly via workFactsFromOverview + workPageFrom
			const workLog =
				[
					JSON.stringify({
						v: 1,
						op: "initiative.create",
						ts: 500,
						by: "architecture",
						id: "system-arch-in-temper",
						name: "System Architecture in Temper",
						outcome: "Unified roles & initiatives",
						doneWhen: ["All conformance tests pass"],
						lead: "architecture",
					}),
					JSON.stringify({
						v: 1,
						op: "task.link",
						ts: 2000,
						by: "backend",
						queue: backendHome,
						queueName: "backend",
						task: 120,
						added: 2000,
						title: "Implement B2 resolver",
						parent: { initiative: "system-arch-in-temper" },
					}),
					JSON.stringify({
						v: 1,
						op: "task.state",
						ts: 2200,
						by: "backend",
						queue: backendHome,
						task: 120,
						added: 2000,
						status: "blocked",
						block: {
							on: ["design #205"],
							lead: "design",
							owes: "Show&Tell prototype link",
							reminders: 0,
							since: 2200,
						},
					}),
				].join("\n") + "\n";

			const facts = workFactsFromOverview(overview);
			const workPage = workPageFrom(workLog, facts, 3000);
			expect(workPage.tasks).toHaveLength(1);
			expect(workPage.tasks[0]).toMatchObject({
				task: 120,
				tags: ["roles-rework", "b2-resolver"],
				touches: ["pi-web-ui repo", "pi-web-deploy"],
				lifecycleStatus: "blocked",
				statusTone: "blocked",
				dependsOnRefs: ["design #205"],
				howToUnblock:
					"How to unblock: Resume design's queue so design #205 can run, and have design lead provide Show&Tell prototype link",
			});
			expect(workPage.tagGroups).toEqual(overview.tagGroups);
			expect(workPage.touchSystems).toEqual(overview.touchSystems);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("reads dist/.pi-web-deploy.json in readLiveDeploySnapshots and DeliveryStateCache when deploy-status.json and state.json are absent", async () => {
		const dir = mkdtempSync(join(tmpdir(), "ri-pi-web-deploy-marker-"));
		try {
			const wtState = join(dir, "state", "wt");
			const deployLive = join(dir, "pi-web-ui");
			mkdirSync(join(wtState, "deploy"), { recursive: true });
			mkdirSync(join(deployLive, "dist"), { recursive: true });

			const markerCommit = "3844a8cf061d7cc3f507846fa7358ab6c1bc0f44";
			const deployedAt = "2026-11-09T04:16:59.708Z";
			writeFileSync(
				join(deployLive, "dist", ".pi-web-deploy.json"),
				JSON.stringify({
					commit: markerCommit,
					short: "3844a8cf",
					action: "deploy",
					deployedAt,
				}),
			);

			const snapshots = readLiveDeploySnapshots({
				landQueueDir: join(dir, "state", "wt-land-queue"),
				wtDeployStateDir: join(dir, "state", "wt-deploy"),
				wtDeployNestedDir: join(wtState, "deploy"),
				piWebDataDir: join(dir, "pi-web-data"),
				piWebDeployStateDir: join(dir, "state", "pi-web-deploy"),
				piWebDeployLiveDir: deployLive,
			});

			expect(snapshots.piWebDeployRecord).toEqual({
				repo: "pi-web-ui",
				status: "succeeded",
				commit: markerCommit,
				liveCommit: markerCommit,
				healthCommit: markerCommit,
				healthOk: true,
				finishedAt: deployedAt,
			});
			const mapRecord = (snapshots.wtDeployRecords as ReadonlyMap<string, unknown>)?.get("pi-web-ui");
			expect(mapRecord).toEqual(snapshots.piWebDeployRecord);

			const cache = new DeliveryStateCache(() => ({
				wtState,
				deployLive,
				deployStage: join(dir, "stage"),
				deployStatusFile: join(dir, "pi-web-data", "deploy-status.json"),
			}));
			const cachedSnapshots = await cache.loadSnapshots();
			expect(cachedSnapshots.piWebDeployRecord).toEqual(snapshots.piWebDeployRecord);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("resolves done tasks with options.evidence.live === true to live with deployedAt, and wires done-task evidence in RolesOverviewReader", async () => {
		const installedAt = 1_762_559_123_000;
		const resolved = resolveTaskLifecycleAndDelivery(
			{
				id: 121,
				role: "backend",
				status: "done",
				touches: ["pi-web-ui repo"],
				delivery: {
					repo: "pi-web-ui",
					landedCommit: "fc4288fc",
				},
			},
			{
				evidence: {
					repo: "pi-web-ui",
					commit: "fc4288fc",
					checkedAt: installedAt - 5_000,
					installedAt,
					live: true,
				},
			},
		);
		expect(resolved).toMatchObject({
			lifecycleStatus: "live",
			statusTone: "live",
			delivery: {
				repo: "pi-web-ui",
				deployableService: true,
				landedCommit: "fc4288fc",
				liveCommit: "fc4288fc",
				deployStatus: "succeeded",
				deployedAt: installedAt,
			},
		});

		// Verify RolesOverviewReader.read() passes evidence for done tasks to taskOf
		const dir = mkdtempSync(join(tmpdir(), "ri-done-evidence-"));
		try {
			const opsHome = join(dir, "ops-home.jsonl");
			const taskChatId = "12345678-aaaa-bbbb-cccc-1234567890ab";
			const taskChatFile = join(dir, `2026-11-08T10-00-00_${taskChatId}.jsonl`);
			const runsFile = join(dir, "runs.json");
			const jobsFile = join(dir, "jobs.json");
			const wtState = join(dir, "state", "wt");
			const deployLive = join(dir, "pi-web-ui");
			const deployStage = join(dir, "pi-web-ui-stage");
			mkdirSync(wtState, { recursive: true });
			mkdirSync(join(deployLive, "dist"), { recursive: true });
			mkdirSync(deployStage, { recursive: true });
			writeFileSync(runsFile, "[]\n");
			writeFileSync(jobsFile, "{}\n");
			writeFileSync(
				taskChatFile,
				`${JSON.stringify({ type: "session", id: taskChatId, timestamp: "2026-11-08T10:00:00.000Z" })}\n`,
			);

			const landedSha = "5b090006bdb27472a44ab81a47b3a56e083c540b";
			writeFileSync(
				join(wtState, "branches.jsonl"),
				`${JSON.stringify({
					v: 1,
					at: "2026-11-08T10:01:00.000Z",
					repo: deployLive,
					branch: "ops-task-794",
					chat: taskChatId,
				})}\n`,
			);
			writeFileSync(
				join(wtState, "lands.jsonl"),
				`${JSON.stringify({
					v: 1,
					at: "2026-11-08T10:05:00.000Z",
					committedAt: "2026-11-08T10:04:00.000Z",
					repo: deployLive,
					branch: "ops-task-794",
					commit: landedSha,
				})}\n`,
			);
			writeFileSync(
				join(deployStage, "history.jsonl"),
				`${JSON.stringify({
					commit: landedSha,
					startedAt: "2026-11-08T10:06:00.000Z",
					endedAt: "2026-11-08T10:07:00.000Z",
					result: "swapped",
					up: true,
					restart: "ok",
					checks: {
						at: "2026-11-08T10:07:05.000Z",
						results: [{ name: "health", status: "pass" }],
					},
				})}\n`,
			);
			writeFileSync(
				join(deployLive, "dist", ".pi-web-deploy.json"),
				JSON.stringify({
					commit: landedSha,
					short: "5b090006",
					action: "deploy",
					deployedAt: "2026-11-08T10:07:05.000Z",
				}),
			);

			const homeLines = [
				JSON.stringify({ type: "session", id: "sess-ops", timestamp: "2026-11-08T10:00:00.000Z" }),
				JSON.stringify({
					type: "custom",
					customType: TASK_QUEUE_ENTRY_TYPE,
					id: "q1",
					timestamp: "2026-11-08T10:00:00.000Z",
					data: {
						v: 1,
						ts: Date.parse("2026-11-08T10:00:00.000Z"),
						op: "add",
						id: 794,
						text: "Default effort switch",
						plan: samplePlan("Default effort switch"),
						tags: ["roles-rework"],
						touches: ["pi-web-ui repo"],
					},
				}),
				JSON.stringify({
					type: "custom",
					customType: TASK_QUEUE_ENTRY_TYPE,
					id: "q2",
					timestamp: "2026-11-08T10:00:10.000Z",
					data: {
						v: 1,
						ts: Date.parse("2026-11-08T10:00:10.000Z"),
						op: "start",
						id: 794,
						lane: true,
						running: true,
					},
				}),
				JSON.stringify({
					type: "custom",
					customType: TASK_QUEUE_ENTRY_TYPE,
					id: "q3",
					timestamp: "2026-11-08T10:00:11.000Z",
					data: {
						v: 1,
						ts: Date.parse("2026-11-08T10:00:11.000Z"),
						op: "chat",
						id: 794,
						file: taskChatFile,
						title: "Task #794",
					},
				}),
				JSON.stringify({
					type: "custom",
					customType: TASK_QUEUE_ENTRY_TYPE,
					id: "q4",
					timestamp: "2026-11-08T10:08:00.000Z",
					data: {
						v: 1,
						ts: Date.parse("2026-11-08T10:08:00.000Z"),
						op: "done",
						id: 794,
						summary: "Deployed via pi-web-deploy",
					},
				}),
			];
			writeFileSync(opsHome, `${homeLines.join("\n")}\n`);

			const host: RolesOverviewHost = {
				identities: () => [
					{
						id: "ops",
						title: "Ops",
						dir: join(dir, "id-ops"),
						homeChat: opsHome,
						role: { config: {} },
					} as unknown as IdentityDef,
				],
				chatState: () => "idle",
				asks: () => [],
				openRequestsTo: () => ({ open: 0 }),
				latestReportTo: () => undefined,
				rolePaused: () => false,
				sessionRoots: () => [dir],
				reportRunsFile: () => runsFile,
				schedulerJobsFile: () => jobsFile,
				evidencePaths: () => ({ wtState, deployLive, deployStage }),
				now: () => Date.parse("2026-11-08T10:10:00.000Z"),
			};

			const reader = new RolesOverviewReader(host);
			const overview = await reader.read();
			const group = overview.tagGroups?.find((g) => g.key === "roles-rework");
			expect(group?.countsByStatus.live).toBe(1);
			expect(group?.countsByStatus.landed).toBe(0);
			expect(group?.rollupStatus).toBe("live");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("resolves done tasks in show-and-tell, inkflow, and temper-ai without a deploy state file to done instead of landed (not_deployed_yet)", () => {
		for (const repo of ["show-and-tell", "inkflow", "temper-ai"]) {
			const res = resolveTaskLifecycleAndDelivery(
				{
					id: 50,
					role: "backend",
					status: "done",
					touches: [`${repo} repo`],
					doneSummary: `Landed commit aabbccddeeff0011 in ${repo}.`,
					delivery: {
						repo,
						landedCommit: "aabbccddeeff0011",
					},
				},
				{
					wtDeployRecords: {},
				},
			);
			expect(res).toMatchObject({
				lifecycleStatus: "done",
				statusTone: "live",
				delivery: {
					repo,
					deployableService: false,
					landedCommit: "aabbccddeeff0011",
				},
			});
			expect(res.delivery?.deployPendingReason).toBeUndefined();
		}
	});

	it("warms git ancestry cache via warmDeliveryAncestryCache before taskOf so first-load calls do not falsely return commit_behind", async () => {
		// fc4288fc is an ancestor of 3844a8cf061d7cc3f507846fa7358ab6c1bc0f44 in pi-web-ui
		const ancestorSha = "fc4288fc";
		const liveSha = "3844a8cf061d7cc3f507846fa7358ab6c1bc0f44";
		const deploySnapshots = {
			piWebDeployRecord: {
				repo: "pi-web-ui",
				status: "succeeded",
				commit: liveSha,
				liveCommit: liveSha,
				healthCommit: liveSha,
				healthOk: true,
			},
		};
		const queueTask = {
			id: 793,
			status: "done" as const,
			addedAt: 1_000,
			doneAt: 2_000,
			plan: samplePlan("Prompt audit part 2"),
			touches: ["pi-web-ui repo"],
			summary: `Landed commit ${ancestorSha} and deployed.`,
			delivery: {
				repo: "pi-web-ui",
				landedCommit: ancestorSha,
			},
		};

		await warmDeliveryAncestryCache([{ role: "ops", task: queueTask }], {
			...deploySnapshots,
			repoRoots: { "pi-web-ui": process.cwd() },
		});

		const row = taskOf(queueTask, "ops", undefined, {
			deploySnapshots,
			now: 3_000,
		});
		expect(row.lifecycleStatus).toBe("live");
		expect(row.statusTone).toBe("live");
		expect(row.delivery?.deployPendingReason).toBeUndefined();
	});
});
