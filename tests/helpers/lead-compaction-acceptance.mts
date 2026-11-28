// External Ops1154 adapter. Hypothesis and SDK startup ordering live in the fixture module.
// Missing cases throw, rather than inheriting unrelated isolated proofs as joined acceptance.
import { acceptanceFixture, loadExecutor } from "./lead-compaction-acceptance-fixture.mts";
import { supported as nativeCases, runNativeCase } from "./lead-compaction-authority-preservation.mts";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const hostCases = new Set(["A2-sends-in-flight", "A3-generation", "A3-branch", "A3-post-validation-append"]);
const executorRefusals = new Set(["A4-corrupt-receipt", "A4-same-id-new-hash", "A4-truncated-journal"]);
const joined = new Set([
 "A1-below", "A1-settled", "A1-cold-unopened", "A1-idle", "A1-home-open", "A1-missing-usage", "A1-stale-usage",
 "A3-growth", "A3-selected-content", "A3-checkpoint", "A3-protected-metadata",
 "A4-plan", "A4-refresh", "A4-applied-status", "A4-applied-below-threshold", "A5-floor",
 "A2-changed-home", "A4-readback-failure", "A4-missing-receipt",
 "A4-readback", "A4-native-append", "A5-protected-first",
]);
export async function runCase(id: string, input: Readonly<Record<string, unknown>>): Promise<Record<string, unknown>> {
 if (nativeCases.has(id)) return runNativeCase(id);
 if (hostCases.has(id)) return (await import("./lead-compaction-host-acceptance.ts")).runCase(id, input);
 if (executorRefusals.has(id)) {
  const result = await (await loadExecutor("tests/helpers/lead-executor-acceptance.ts")).runExecutorCase(id, input);
  assert.equal(result.needsHostApply, false, "refusal must not leave an unapplied commit");
  return result;
 }
 if (!joined.has(id)) {
  const reasons: Record<string, string> = {
   "A2-tool": "requires a held real tool lifecycle",
   "A2-retry": "requires a held real retry lifecycle",
   "A2-continuation": "requires a held real continuation lifecycle",
   "A2-queued-input": "requires actual pending-message delivery observation",
   "A3-opening-race": "requires native cold writer/open coordination instrumentation",
   "A4-partial-content": "requires interruption after partial archive writes",
   "A4-receipt": "requires interruption after durable receipt before readback",
  };
  throw new Error(`ACTUAL_HET_ACCEPTANCE_UNSUPPORTED:${id}:${reasons[id] ?? "outside A1-A5 scope"}`);
 }
 const cold = id === "A1-cold-unopened" || ["A3-selected-content", "A3-checkpoint", "A3-protected-metadata"].includes(id);
 let faultHits = 0;
 let faultEnabled = ["A4-readback", "A4-readback-failure", "A4-missing-receipt"].includes(id);
 const f = await acceptanceFixture(cold, id === "A1-stale-usage" ? "small" : ["A5-floor", "A5-protected-first"].includes(id) ? "protected" : undefined,
  request => {
   if (!faultEnabled || request.path !== "/api/v1/content/read" ||
    (id === "A4-missing-receipt" && !request.uri.endsWith("receipt.json"))) return;
   // Fail only existing objects: planning's missing-object probes are not readback.
   if (!f.server.store.has(request.uri)) return;
   faultHits++;
   return { status: id === "A4-missing-receipt" ? 404 : 503,
    body: { status: "error", error: { code: id === "A4-missing-receipt" ? "NOT_FOUND" : "UNAVAILABLE", message: "external readback fault" } } };
  });
 try {
  const source = f.f.fence().source;
  const before = readFileSync(source);
  if (id === "A1-below") f.usage(Number(input.tokens));
  if (id === "A1-missing-usage") f.usage(undefined);
  if (id === "A1-stale-usage") f.usage(200000, true);
  if (id === "A2-changed-home") {
   const identity = join(f.config.identitiesDir, "ops", "identity.json");
   writeFileSync(identity, JSON.stringify({ id: "ops", homeChat: join(f.config.sessionsRoot, "not-this-home.jsonl") }));
   const status = await f.scheduler.requestCheck({ sessionId: f.f.fence().sessionId, trigger: "idle" });
   assert.equal(status.state, "blocked", "authority fault must be observed");
   return { archiveWrites: f.server.requests.filter((r: any) => r.method === "POST" && r.path.includes("content/")).length,
    cuts: f.entries().filter(e => e.type === "compaction").length };
  }
  if (["A5-floor", "A5-protected-first"].includes(id)) {
   f.usage(undefined);
   const status = await f.scheduler.requestCheck({ sessionId: f.f.fence().sessionId, trigger: "idle" });
   return { state: status.state, cuts: f.entries().filter(e => e.type === "compaction").length,
    visibleFailure: status.state === "protected_floor" || !!status.errorCode, protectedUnchanged: readFileSync(source).equals(before),
    spinRetries: f.records().filter((r: any) => r.kind === "attempt").length };
  }
  if (id.startsWith("A1-")) {
   const trigger = input.trigger === "cold-unopened" ? "startup" : input.trigger ?? "settled";
   if (trigger === "startup" || trigger === "idle") await f.scheduler.scan(trigger);
   else await f.scheduler.requestCheck({ sessionId: f.f.fence().sessionId, trigger: trigger as "settled" | "home-open" });
   return {
    plans: f.records().filter((r: any) => r.kind === "plan").length,
    cuts: f.entries().filter(e => e.type === "compaction").length, modelCalls: f.modelCalls(),
    measurement: f.progress.findLast((s: any) => s.measurementSource)?.measurementSource,
   };
  }
  const prepared = await f.executor().prepare(f.host.captureFence(f.f.fence().sessionId));
  assert.ok(prepared.originalFence, "real executor must produce a plan");
  const journalBefore = f.journal();
  if (id === "A3-growth") f.session!.sessionManager.appendMessage({ role: "user", content: "APPENDED TAIL", timestamp: 2 });
  const mutations: Record<string, [string, string]> = {
   "A3-selected-content": ["owner request 0", "changed request"],
   "A3-checkpoint": ["CURRENT CHECKPOINT", "CHANGED CHECKPOINT"],
   "A3-protected-metadata": ['"customType":"identity"', '"protected":true,"customType":"identity"'],
  };
  if (mutations[id]) {
   const [old, replacement] = mutations[id];
   const changed = before.toString().replace(old, replacement);
   assert.notEqual(changed, before.toString(), "fault must fire");
   writeFileSync(source, changed);
  }
  if (id === "A4-plan") await f.restartExecutor();
  let ticket = await f.executor().resume(prepared.planId, prepared.planHash);
  if (["A4-readback", "A4-readback-failure", "A4-missing-receipt"].includes(id)) {
   assert.ok(faultHits > 0, "readback fault must fire on a stored object");
   assert.ok("state" in ticket && !!ticket.errorCode, "readback failure must refuse native ticket");
   if (id !== "A4-readback") return { cuts: f.entries().filter(e => e.type === "compaction").length, visibleFailure: !!ticket.errorCode };
   faultEnabled = false;
   await f.restartExecutor();
   ticket = await f.executor().resume(prepared.planId, prepared.planHash);
  }
  if (mutations[id]) {
   assert.ok("state" in ticket, "changed canonical source must refuse ticket issuance");
   return { staleTicketCuts: f.entries().filter(e => e.type === "compaction").length, refusalRecorded: !!ticket.errorCode };
  }
  assert.ok(!("state" in ticket), "actual archive/readback must yield a host ticket");
  let refreshFaults = 0;
  if (id === "A4-refresh") {
   f.session!.refreshContext = () => { refreshFaults++; throw new Error("external-refresh-crash"); };
  }
  if (id === "A4-native-append") {
   const manager = f.session!.sessionManager;
   const append = manager.appendCompaction.bind(manager);
   manager.appendCompaction = (...args: Parameters<typeof append>) => {
    append(...args);
    refreshFaults++;
    throw new Error("external-after-native-append");
   };
  }
  if (["A4-applied-status", "A4-applied-below-threshold"].includes(id)) f.loseAck();
  // Lost ack leaves a native fact plus a pending immutable plan; do not auto-recover it.
  const status = id === "A4-applied-below-threshold" ? await f.host.tryApply(ticket) : await f.apply(ticket);
  if (id === "A4-applied-below-threshold") {
   assert.equal(f.entries().filter(e => e.type === "compaction").length, 1);
   assert.equal(f.records().filter((r: any) => r.kind === "applied").length, 0);
  }
  if (["A4-refresh", "A4-native-append"].includes(id)) assert.equal(refreshFaults, 1, "native fault must fire");
  if (["A4-refresh", "A4-native-append", "A4-applied-status", "A4-applied-below-threshold"].includes(id)) assert.equal(status.errorCode, "native-recovery-required");
  else assert.equal(status.state, "applied");
  const cutsBeforeReplay = f.entries().filter(e => e.type === "compaction").length;
  if (id.startsWith("A4-")) await f.restartExecutor();
  if (id === "A4-applied-below-threshold") f.usage(Number(input.tokens));
  const replay = id === "A4-applied-below-threshold"
   ? await f.executor().prepare(f.host.captureFence(f.f.fence().sessionId))
   : await f.executor().resume(prepared.planId, prepared.planHash);
  const rows = f.records();
  const plans = rows.filter((r: any) => r.kind === "plan");
  const cursors = rows.filter((r: any) => typeof r.cursor === "number").map((r: any) => r.cursor);
  const cuts = f.entries().filter(e => e.type === "compaction").length;
  return {
   cuts, newCuts: cuts - cutsBeforeReplay, reconciled: replay.state === "applied",
   replayState: replay.state, replayErrorCode: replay.errorCode,
   planHashUnchanged: plans.length === 1 && plans[0].executor.planHash === prepared.planHash,
   tailPreserved: f.entries().some((e: any) => e.type === "message" && e.message.content === "APPENDED TAIL"),
   freshTicket: f.issuedFences.some(fence =>
    fence.mutationRevision > prepared.originalFence.mutationRevision || fence.leafId !== prepared.originalFence.leafId),
   archiveIdentities: new Set([...f.server.store.keys()].filter((k: string) => k.endsWith("receipt.json")).map((k: string) => k.replace(/\/[^/]+$/, ""))).size,
   attemptsAppendOnly: f.journal().startsWith(journalBefore),
   cursorRegressions: cursors.filter((n: number, i: number) => i > 0 && n < cursors[i - 1]).length,
  };
 } finally { await f.close(); }
}
