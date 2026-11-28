// External native setup only. Hypothesis: durable principal/boundary changes refuse before
// archive writes; retained native bytes and projected notes survive an eligible real H/E cut.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { acceptanceFixture, loadExecutor } from "./lead-compaction-acceptance-fixture.mts";
export const supported = new Set([
 "A2-unknown-principal", "A2-worker", "A2-consult", "A2-assigned-queue", "A2-changed-root",
 "A2-changed-file", "A2-worker-acp", "A5-preservation", "A5-crossing-tool-pair", "A5-orphan",
]);
const priorUri = "viking://agent/archive/ops/prior-fixed-fold";
const priorNote = `Prior exact note: preserve spacing  and punctuation.\n${priorUri}`;
export async function runNativeCase(id: string) {
 const boundary = id === "A5-crossing-tool-pair" || id === "A5-orphan";
 let planted = false;
 const f = await acceptanceFixture(id === "A2-changed-file", undefined, undefined, raw => {
  const source = raw.fence().source;
  if (id === "A5-preservation" || id === "A2-worker-acp") {
   const first = raw.sm.getEntries().find((e: any) => e.type === "message").id;
   raw.sm.appendCompaction(priorNote, first, 200000, { openviking: { archiveUris: [priorUri] } });
   raw.sm.appendCustomEntry("current-work", { task: "isolated-work", unread: true });
   raw.dump();
  }
  const rows = readFileSync(source, "utf8").trimEnd().split("\n").map(line => JSON.parse(line));
  const identity = rows.find(e => e.type === "custom" && e.customType === "identity");
  assert.equal(identity.data.id, "ops");
  if (id === "A2-unknown-principal") identity.data = { id: "unknown" };
  if (id === "A2-worker" || id === "A2-worker-acp") identity.data = { id: "ops", via: "queue", specialist: "acceptance" };
  if (id === "A2-consult") identity.data = { id: "ops", via: "consult", specialist: "acceptance",
   consult: { id: "cs-0123456789abcdef", caller: "isolated-caller", callerPrincipal: "ops", callerVia: "home" } };
  if (id === "A2-assigned-queue") {
   // Native append preserves a valid parent chain; the canonical queue reader sees op=assigned.
   raw.sm.appendCustomEntry("queue", { op: "assigned", from: "isolated-home", task: 1 });
   raw.dump();
   planted = readFileSync(source, "utf8").includes('"op":"assigned"');
   return;
  }
  if (boundary) {
   const messages = rows.filter(e => e.type === "message");
   const assistant = messages.find(e => e.message.role === "assistant");
   const first = messages[0];
   // Put the unmatched side FIRST: otherwise the preceding user entry is a legal smaller cut.
   if (id === "A5-crossing-tool-pair") {
    first.message = { ...assistant.message, content: [{ type: "toolCall", id: "crossing-tool", name: "isolated", arguments: {} }] };
    // Pair is complete in the durable journal, but its result is beyond the current checkpoint.
    const last = rows.at(-1);
    rows.push({ type: "message", id: "c0ffee01", parentId: last.id, timestamp: last.timestamp,
     message: { role: "toolResult", toolCallId: "crossing-tool", toolName: "isolated", content: [{ type: "text", text: "retained result" }], isError: false, timestamp: 1 } });
   } else {
    first.message = { role: "toolResult", toolCallId: "missing-call", toolName: "isolated",
     content: [{ type: "text", text: "orphan result" }], isError: false, timestamp: 1 };
   }
  }
  writeFileSync(source, rows.map(e => JSON.stringify(e)).join("\n") + "\n");
  const persisted = readFileSync(source, "utf8");
  planted = persisted.includes(JSON.stringify(identity)) && (!boundary || persisted.includes(id === "A5-orphan" ? "missing-call" : "crossing-tool"));
  if (id === "A2-worker-acp") writeFileSync(join(raw.config.identitiesDir, "ops", "identity.json"), JSON.stringify({ id: "ops", homeChat: join(raw.config.sessionsRoot, "separate-lead.jsonl") }));
 });
 try {
  assert.ok(planted, "native setup must persist before host attachment");
  const source = f.f.fence().source;
  const original = readFileSync(source);
  const before = f.entries();
  const home = join(f.config.identitiesDir, "ops", "identity.json");
  const homeBefore = readFileSync(home);
  const nativeBefore = f.session?.sessionId;
  const checkpoint = f.f.fence().checkpoint.messageEntryId;
  const retained = before.find((e: any) => e.id === checkpoint);
  const cutCount = () => f.entries().filter(e => e.type === "compaction").length;
  const previousCuts = cutCount();
  if (id === "A2-changed-root" || id === "A2-changed-file") {
   const prepared = await f.executor().prepare(f.host.captureFence(f.f.fence().sessionId));
   assert.ok(prepared.originalFence, "drift is planted after a real frozen plan");
   if (id === "A2-changed-root") {
    f.config.sessionsRoot = f.config.identitiesDir;
    await f.restartExecutor();
   } else {
    const rows = original.toString().trimEnd().split("\n").map(line => JSON.parse(line));
    rows[0].id = "replaced-file-session";
    writeFileSync(source, rows.map(e => JSON.stringify(e)).join("\n") + "\n");
    assert.equal(JSON.parse(readFileSync(source, "utf8").split("\n")[0]).id, "replaced-file-session");
   }
   const refused = await f.executor().resume(prepared.planId, prepared.planHash);
   assert.ok("state" in refused && refused.errorCode, "canonical drift must refuse ticket");
   return { archiveWrites: f.server.requests.filter((r: any) => r.method === "POST" && r.path.includes("content/")).length, cuts: cutCount() - previousCuts };
  }
  if (boundary) {
   const { handoffView, pairedPrefix, safePrefix } = await loadExecutor("src/v2/lead-handoff-source.ts");
   const { entries } = handoffView(f.session!.sessionManager.buildSessionProjection().entries);
   const end = safePrefix(entries, f.f.fence().checkpoint);
   assert.ok(end > 0, "tool fixture must expose an otherwise eligible prefix");
   assert.ok(Array.from({ length: end }, (_, index) => index + 1).every(count => !pairedPrefix(entries, count)),
    "canonical pairing must reject every candidate prefix, not just the largest cut");
   if (id === "A5-crossing-tool-pair") assert.ok(pairedPrefix(entries, entries.length), "full crossing group must be complete");
  }
  let ownerBefore: unknown;
  let owner: any;
  if (id === "A2-worker-acp") {
   const { createLeadWindowOwner } = await loadExecutor("src/v2/lead-window-owner.ts");
   owner = createLeadWindowOwner({ ...f.config, roleOf: () => "ops", isWorker: () => true });
   ownerBefore = owner({ sessionManager: f.session!.sessionManager });
   assert.equal(ownerBefore, null, "non-home worker must not grant lead ACP ownership");
  }
  const status = await f.scheduler.requestCheck({ sessionId: f.f.fence().sessionId, trigger: "idle" });
  if (id === "A5-preservation") {
   assert.equal(status.state, "applied");
   assert.equal(cutCount() - previousCuts, 1, "preservation requires a real cut");
   const after = f.entries();
   const latest: any = after.filter(e => e.type === "compaction").at(-1);
   const projected = f.session!.sessionManager.buildSessionProjection().entries;
   const refs = latest.details.openviking.archiveUris;
   const plan: any = f.records().find((r: any) => r.kind === "plan");
   const expectedRefs = [priorUri, plan.fold.uri];
   return {
    originalPrefixUnchanged: readFileSync(source).subarray(0, original.length).equals(original),
    homeUnchanged: readFileSync(home).equals(homeBefore), sessionUnchanged: f.session!.sessionId === nativeBefore,
    workUnchanged: JSON.stringify(after.filter((e: any) => e.customType === "current-work")) === JSON.stringify(before.filter((e: any) => e.customType === "current-work")),
    checkpointUnchanged: JSON.stringify(after.find((e: any) => e.id === checkpoint)) === JSON.stringify(retained),
    tailPreserved: projected.some((e: any) => e.sourceEntry.id === checkpoint),
    priorNotesExact: latest.summary.startsWith(priorNote + "\n") && JSON.stringify(after.find((e: any) => e.type === "compaction")) === JSON.stringify(before.find((e: any) => e.type === "compaction")),
    foldReferencesExactlyOnce: expectedRefs.every(uri => refs.filter((ref: string) => ref === uri).length === 1) && refs.length === expectedRefs.length,
   };
  }
  assert.ok(status.state === "blocked" || status.state === "protected_floor", "planted boundary/authority must refuse");
  return { archiveWrites: f.server.requests.filter((r: any) => r.method === "POST" && r.path.includes("content/")).length,
   cuts: cutCount() - previousCuts, protectedUnchanged: readFileSync(source).equals(original), visibleFailure: !!status.errorCode || status.state === "protected_floor",
   acpUnchanged: id === "A2-worker-acp" ? readFileSync(source).equals(original) && owner({ sessionManager: f.session!.sessionManager }) === ownerBefore : undefined };
 } finally { await f.close(); }
}
