/**
 * Lazy turn-end / boundary context startup patch tests (Ops #697).
 *
 * Verifies:
 *  1. The installed @earendil-works/pi-coding-agent files (`dist/core/extensions/runner.js`
 *     and `dist/core/agent-session.js`) match the expected source and take the patch
 *     (fails if an SDK upgrade changes either file).
 *  2. The rewrite is idempotent (`patched` once, `already` thereafter).
 *  3. On a source mismatch or missing file, the guard warns and leaves the file unchanged.
 *  4. When no boundary handler reads `event.context` (and continuation is not requested),
 *     `_buildBoundaryContext` and `SessionManager.buildSessionProjection` are never called
 *     (whereas the unpatched SDK builds them eagerly on every boundary).
 *  5. When a handler reads `event.context`, the returned value deep-equals the eager build
 *     at that handler's emit point, even after an earlier or current handler appends entries
 *     (both via returned `{ entries }` drafts and via `sessionManager.append*`), and covers
 *     both `turn_end` and `agent_before_settle` plus the `boundary.continue` path.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
	AGENT_SESSION_BOUNDARY_REPLACEMENTS,
	agentSessionBoundaryFile,
	applyLazyBoundaryContextPatch,
	patchAgentSessionBoundarySource,
	patchRunnerBoundarySource,
	RUNNER_BOUNDARY_REPLACEMENTS,
	runnerBoundaryFile,
} from "../../server/patch-lazy-boundary-context.js";
import type { SourceReplacement } from "../../server/sdk-file-patch.js";

function unpatchSource(source: string, replacements: ReadonlyArray<SourceReplacement>): string {
	let prev = source;
	for (const r of replacements) {
		if (prev.includes(r.new)) {
			prev = prev.replace(r.new, r.old);
		}
	}
	return prev;
}

describe("patch-lazy-boundary-context", () => {
	it("takes the installed pi SDK runner.js and agent-session.js (fails when pi changed them)", () => {
		const runnerFile = runnerBoundaryFile();
		const sessionFile = agentSessionBoundaryFile();
		expect(runnerFile).toBeTruthy();
		expect(sessionFile).toBeTruthy();

		// Importing patch-lazy-boundary-context.ts above already applied the patch at module load.
		const result = applyLazyBoundaryContextPatch({ warn: null, log: null });
		expect(result.status).toBe("already");
		expect(result.files["extensions/runner.js"]).toBe("already");
		expect(result.files["agent-session.js"]).toBe("already");

		const runnerSource = readFileSync(runnerFile!, "utf8");
		for (const r of RUNNER_BOUNDARY_REPLACEMENTS) {
			expect(runnerSource).toContain(r.new);
		}
		const sessionSource = readFileSync(sessionFile!, "utf8");
		for (const r of AGENT_SESSION_BOUNDARY_REPLACEMENTS) {
			expect(sessionSource).toContain(r.new);
		}
	});

	it("rewrites pristine SDK sources once and is idempotent on subsequent runs", () => {
		const pristineRunner = unpatchSource(readFileSync(runnerBoundaryFile()!, "utf8"), RUNNER_BOUNDARY_REPLACEMENTS);
		const pristineSession = unpatchSource(
			readFileSync(agentSessionBoundaryFile()!, "utf8"),
			AGENT_SESSION_BOUNDARY_REPLACEMENTS,
		);

		const runnerFirst = patchRunnerBoundarySource(pristineRunner);
		expect(runnerFirst.status).toBe("patched");
		expect(patchRunnerBoundarySource(runnerFirst.source).status).toBe("already");

		const sessionFirst = patchAgentSessionBoundarySource(pristineSession);
		expect(sessionFirst.status).toBe("patched");
		expect(patchAgentSessionBoundarySource(sessionFirst.source).status).toBe("already");

		const tempDir = mkdtempSync(join(tmpdir(), "pi-lazy-boundary-patch-"));
		try {
			const tempRunner = join(tempDir, "runner.js");
			const tempSession = join(tempDir, "agent-session.js");
			writeFileSync(tempRunner, pristineRunner, "utf8");
			writeFileSync(tempSession, pristineSession, "utf8");

			const logs: string[] = [];
			const firstBatch = applyLazyBoundaryContextPatch({
				runnerFile: tempRunner,
				agentSessionFile: tempSession,
				warn: null,
				log: (msg) => logs.push(msg),
			});
			expect(firstBatch.status).toBe("patched");
			expect(logs).toEqual(["[patch-lazy-boundary-context] applied (patched)"]);

			const secondBatch = applyLazyBoundaryContextPatch({
				runnerFile: tempRunner,
				agentSessionFile: tempSession,
				warn: null,
				log: (msg) => logs.push(msg),
			});
			expect(secondBatch.status).toBe("already");
			expect(logs).toEqual([
				"[patch-lazy-boundary-context] applied (patched)",
				"[patch-lazy-boundary-context] applied (already)",
			]);
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("warns and leaves files unchanged on a source mismatch or missing file", () => {
		const [firstReplacement, secondReplacement, thirdReplacement] = AGENT_SESSION_BOUNDARY_REPLACEMENTS;
		const partialChanged = [
			firstReplacement!.old,
			secondReplacement!.old.replace("buildSessionProjection()", "buildChangedProjection()"),
			thirdReplacement!.old,
		].join("\n");

		const mismatch = patchAgentSessionBoundarySource(partialChanged);
		expect(mismatch.status).toBe("mismatch");
		expect(mismatch.source).toBe(partialChanged);
		if (mismatch.status === "mismatch") {
			expect(mismatch.missing).toEqual([secondReplacement!.old]);
		}

		const tempDir = mkdtempSync(join(tmpdir(), "pi-lazy-boundary-mismatch-"));
		try {
			const tempRunner = join(tempDir, "runner.js");
			const tempSession = join(tempDir, "agent-session.js");
			const brokenRunner = "export class ExtensionRunner { async emitBoundary() { return null; } }\n";
			writeFileSync(tempRunner, brokenRunner, "utf8");
			writeFileSync(tempSession, partialChanged, "utf8");

			const warnings: string[] = [];
			const res = applyLazyBoundaryContextPatch({
				runnerFile: tempRunner,
				agentSessionFile: tempSession,
				warn: (msg) => warnings.push(msg),
				log: null,
			});
			expect(res.status).toBe("mismatch");
			expect(res.files["extensions/runner.js"]).toBe("mismatch");
			expect(res.files["agent-session.js"]).toBe("mismatch");
			expect(warnings).toHaveLength(2);
			expect(warnings[0]).toContain("extensions/runner.js no longer matches");
			expect(warnings[1]).toContain("agent-session.js no longer matches");
			expect(readFileSync(tempRunner, "utf8")).toBe(brokenRunner);
			expect(readFileSync(tempSession, "utf8")).toBe(partialChanged);

			const missingWarnings: string[] = [];
			const missingRes = applyLazyBoundaryContextPatch({
				runnerFile: join(tempDir, "nope-runner.js"),
				agentSessionFile: tempSession,
				warn: (msg) => missingWarnings.push(msg),
				log: null,
			});
			expect(missingRes.status).toBe("missing");
			expect(missingWarnings.some((w) => w.includes("was not found"))).toBe(true);
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("never builds boundary context when no handler reads it, and deep-equals eager build when read", async () => {
		const runnerPath = runnerBoundaryFile()!;
		const sessionPath = agentSessionBoundaryFile()!;
		const sessionManagerPath = join(sessionPath, "..", "session-manager.js");

		const [{ ExtensionRunner }, { AgentSession }, { SessionManager }] = await Promise.all([
			import(pathToFileURL(runnerPath).href),
			import(pathToFileURL(sessionPath).href),
			import(pathToFileURL(sessionManagerPath).href),
		]);

		type ExtensionEntry = {
			path: string;
			resolvedPath: string;
			handlers: Map<string, Array<(event: any, ctx: any) => any>>;
			tools: Map<string, any>;
			commands: Map<string, any>;
			shortcuts: Map<string, any>;
			flags: Map<string, any>;
			messageRenderers: Map<string, any>;
		};

		function makeExtension(
			path: string,
			eventType: string,
			handlers: Array<(event: any, ctx: any) => any>,
		): ExtensionEntry {
			return {
				path,
				resolvedPath: path,
				handlers: new Map([[eventType, handlers]]),
				tools: new Map(),
				commands: new Map(),
				shortcuts: new Map(),
				flags: new Map(),
				messageRenderers: new Map(),
			};
		}

		function makeHarness(extensions: ExtensionEntry[]) {
			const sm = SessionManager.inMemory("/tmp/test-cwd");
			sm.fileEntries[0].id = "session-header";
			sm.fileEntries[0].timestamp = "2026-10-31T00:00:00.000Z";
			sm.appendMessage({
				role: "user",
				content: [{ type: "text", text: "Hello from user" }],
				timestamp: 1000,
			});
			const assistantMsg = {
				role: "assistant",
				content: [{ type: "text", text: "Assistant reply" }],
				api: "messages",
				provider: "anthropic",
				model: "claude",
				usage: {
					input: 10,
					output: 5,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 15,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: 2000,
			};
			sm.appendMessage(assistantMsg);

			const runner = new ExtensionRunner(extensions, {}, "/tmp/test-cwd", sm, {} as any);

			const queuedMessages: any[] = [];
			const fakeSession: any = Object.create(AgentSession.prototype);
			fakeSession._cwd = "/tmp/test-cwd";
			fakeSession.sessionManager = sm;
			fakeSession._extensionRunner = runner;
			fakeSession._turnIndex = 0;
			fakeSession._lastActivityOutcome = "succeeded";
			fakeSession._pendingCustomMessages = [];
			fakeSession._isBeforeSettle = false;
			fakeSession._abortDuringBeforeSettle = false;
			fakeSession._emitted = [];
			fakeSession._invalidContinuations = [];
			fakeSession._emit = (ev: any) => fakeSession._emitted?.push(ev);
			fakeSession._reportInvalidBoundaryContinuation = (ev: string) => fakeSession._invalidContinuations.push(ev);
			fakeSession._refreshFinalizedContext = () => {};
			fakeSession._flushPendingCustomMessages = () => {};
			fakeSession._findPersistedMessageEntryId = () => sm.getLeafId();
			fakeSession.agent = {
				peekQueuedMessages: () => [...queuedMessages],
				hasQueuedMessages: () => queuedMessages.length > 0,
			};
			return { sm, runner, fakeSession, assistantMsg, queuedMessages };
		}

		// 1. Unread turn_end and agent_before_settle: zero projection builds!
		{
			let handlerCalls = 0;
			const ext = makeExtension("ext-unread", "turn_end", [
				(event) => {
					handlerCalls++;
					expect(event.type).toBe("turn_end");
					return {
						entries: [
							{
								type: "custom",
								customType: "tldr-state",
								data: { ok: true },
							},
						],
					};
				},
				(event) => {
					handlerCalls++;
					expect(event.entries).toHaveLength(1);
					return undefined;
				},
			]);
			const settleExt = makeExtension("ext-settle-unread", "agent_before_settle", [
				(event) => {
					handlerCalls++;
					expect(event.outcome).toBe("succeeded");
					return undefined;
				},
			]);
			const { fakeSession } = makeHarness([ext, settleExt]);
			const projectionSpy = vi.spyOn(SessionManager.prototype, "buildSessionProjection");
			const buildContextSpy = vi.spyOn(fakeSession, "_buildBoundaryContext");
			try {
				const turnEndContinue = await fakeSession._dispatchTurnEndBoundary(
					fakeSession.sessionManager.getLeafEntry().message,
					[],
				);
				expect(turnEndContinue).toBe(false);
				expect(handlerCalls).toBe(2);
				expect(projectionSpy).toHaveBeenCalledTimes(0);
				expect(buildContextSpy).toHaveBeenCalledTimes(0);

				const settleContinue = await fakeSession._runBeforeSettleBoundary();
				expect(settleContinue).toBe(false);
				expect(handlerCalls).toBe(3);
				expect(projectionSpy).toHaveBeenCalledTimes(0);
				expect(buildContextSpy).toHaveBeenCalledTimes(0);
			} finally {
				projectionSpy.mockRestore();
				buildContextSpy.mockRestore();
			}
		}

		// 2. Prove the unpatched emitBoundary logic WOULD have built eagerly on the same unread handlers.
		{
			const pristineRunnerSrc = unpatchSource(readFileSync(runnerPath, "utf8"), RUNNER_BOUNDARY_REPLACEMENTS);
			const match = pristineRunnerSrc.match(
				/async emitBoundary\(baseEvent, buildContext\) \{[\s\S]*?\n    \}\n    isSessionBeforeEvent/,
			);
			expect(match).toBeTruthy();
			const eagerFnBody = match![0]
				.replace(/^async emitBoundary\(baseEvent, buildContext\) \{/, "")
				.replace(/\n    \}\n    isSessionBeforeEvent$/, "");
			// Evaluate the unpatched method body with a minimal snapshotEventHandlers helper.
			const eagerEmitBoundary = new Function(
				"snapshotEventHandlers",
				`return async function(baseEvent, buildContext) { ${eagerFnBody} };`,
			)((extensions: ExtensionEntry[], type: string) =>
				extensions
					.map((ext) => ({ ext, handlers: ext.handlers.get(type) ?? [] }))
					.filter((item) => item.handlers.length > 0),
			);

			const ext = makeExtension("ext-unread", "turn_end", [() => undefined, () => undefined]);
			const { runner, fakeSession } = makeHarness([ext]);
			let eagerCalls = 0;
			await eagerEmitBoundary.call(runner, { type: "turn_end" }, (entries: any[]) => {
				eagerCalls++;
				return fakeSession._buildBoundaryContext(entries, "turn_end");
			});
			// Unpatched SDK called buildContext before loop + after each of 2 handlers = 3 times!
			expect(eagerCalls).toBe(3);
		}

		// 3. Exact deep-equality when read: including after an earlier handler or current handler appends entries.
		{
			const origProtoAppend = SessionManager.prototype._appendEntry;
			SessionManager.prototype._appendEntry = function (entry: any) {
				entry.id = `entry-${this.fileEntries.length}`;
				entry.timestamp = "2026-10-31T00:00:00.000Z";
				return origProtoAppend.call(this, entry);
			};
			try {
				function runScenario(mode: "lazy" | "eager") {
					const snapshots: Record<string, any> = {};
					let savedHandler1Event: any;

					const ext = makeExtension("ext-chain", "turn_end", [
						(event) => {
							savedHandler1Event = event;
							// Append directly to sessionManager mid-handler before reading event.context
							harness.sm.appendCustomEntry("direct-during-h1", { v: 1 });
							if (mode === "lazy") {
								snapshots.h1First = event.context;
								snapshots.h1Second = event.context;
								expect(snapshots.h1First).toBe(snapshots.h1Second);
							}
							return {
								entries: [
									{
										type: "custom",
										customType: "draft-from-h1",
										data: { step: 1 },
									},
									{
										type: "custom_message",
										customType: "msg-from-h1",
										content: "Follow-up prompt from h1",
										display: true,
									},
								],
								continue: true,
							};
						},
						(event) => {
							// Also mutate sessionManager in handler 2 before reading handler 1's saved event or handler 2's event
							harness.sm.appendCustomEntry("direct-during-h2", { v: 2 });
							if (mode === "lazy") {
								snapshots.h2Context = event.context;
								snapshots.h1ReadDuringH2 = savedHandler1Event.context;
							}
							return {
								entries: [
									...event.entries,
									{
										type: "custom",
										customType: "draft-from-h2",
										data: { step: 2 },
									},
								],
							};
						},
					]);

					const harness = makeHarness([ext]);
					return { harness, snapshots };
				}

				// Compute eager reference snapshots at each step on an identical session
				const eagerH = makeHarness([]);
				const eagerH1Context = eagerH.fakeSession._buildBoundaryContext([], "turn_end");
				eagerH.sm.appendCustomEntry("direct-during-h1", { v: 1 });
				const h1Drafts = [
					{
						type: "custom",
						customType: "draft-from-h1",
						data: { step: 1 },
					},
					{
						type: "custom_message",
						customType: "msg-from-h1",
						content: "Follow-up prompt from h1",
						display: true,
					},
				];
				const eagerH2Context = eagerH.fakeSession._buildBoundaryContext(h1Drafts, "turn_end");
				eagerH.sm.appendCustomEntry("direct-during-h2", { v: 2 });
				const h2Drafts = [
					...h1Drafts,
					{
						type: "custom",
						customType: "draft-from-h2",
						data: { step: 2 },
					},
				];
				const eagerFinalContext = eagerH.fakeSession._buildBoundaryContext(h2Drafts, "turn_end");

				const { harness: lazyH, snapshots } = runScenario("lazy");
				const boundaryResult = await lazyH.runner.emitBoundary(
					{ type: "turn_end", turnIndex: 0 },
					lazyH.fakeSession._createBoundaryContextBuilder("turn_end"),
				);

				expect(snapshots.h1First).toEqual(eagerH1Context);
				expect(snapshots.h1ReadDuringH2).toEqual(eagerH1Context);
				expect(snapshots.h2Context).toEqual(eagerH2Context);
				expect(boundaryResult.context).toEqual(eagerFinalContext);
				expect(boundaryResult.continue).toBe(true);
				expect(boundaryResult.valid).toBe(true);
			} finally {
				SessionManager.prototype._appendEntry = origProtoAppend;
			}
		}

		// 4. Continuation check on turn_end and agent_before_settle (valid vs invalid continuation)
		{
			const invalidExt = makeExtension("ext-invalid-continue", "turn_end", [() => ({ continue: true })]);
			const { fakeSession } = makeHarness([invalidExt]);
			const cont = await fakeSession._dispatchTurnEndBoundary(fakeSession.sessionManager.getLeafEntry().message, []);
			expect(cont).toBe(false);
			expect(fakeSession._invalidContinuations).toEqual(["turn_end"]);

			const validExt = makeExtension("ext-valid-continue", "turn_end", [
				() => ({
					entries: [
						{
							type: "custom_message",
							customType: "followup",
							content: "keep going",
							display: false,
						},
					],
					continue: true,
				}),
			]);
			const { fakeSession: validSession } = makeHarness([validExt]);
			const validCont = await validSession._dispatchTurnEndBoundary(
				validSession.sessionManager.getLeafEntry().message,
				[],
			);
			expect(validCont).toBe(true);
			expect(validSession._invalidContinuations).toEqual([]);
		}

		// 5. Invalid boundary draft entry (e.g. context_edit targeting unknown id) still fails validation even when unread
		{
			const badDraftExt = makeExtension("ext-bad-draft", "turn_end", [
				() => ({
					entries: [
						{
							type: "context_edit",
							targetId: "non-existent-entry-id",
							replacement: "replaced",
						},
					],
					continue: true,
				}),
			]);
			const { runner, fakeSession } = makeHarness([badDraftExt]);
			const errors: any[] = [];
			runner.onError((err: any) => errors.push(err));

			const result = await runner.emitBoundary(
				{ type: "turn_end", turnIndex: 0 },
				fakeSession._createBoundaryContextBuilder("turn_end"),
			);
			expect(result.valid).toBe(false);
			expect(result.entries).toEqual([]);
			expect(result.continue).toBe(false);
			expect(errors).toHaveLength(1);
			expect(errors[0].error).toContain("Invalid boundary entries:");
		}
	});
});
