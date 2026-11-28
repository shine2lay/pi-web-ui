// Hypothesis: joining real E tickets to H native apply and T scheduling proves cuts without
// inference; journal/native observations falsify it on duplicate cuts, drift or missing receipts.
// Startup patch MUST finish before dynamic imports load any SDK consumers.
await import("../../server/patch-lazy-boundary-context.ts");
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executorSource } from "./lead-compaction-executor-source.mjs";
import { pathToFileURL, fileURLToPath } from "node:url";
const sdk = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
for (const [file, hash] of [
 ["core/agent-session.js", "391c32acdd650ef1360dab77e960553b4cbbf271e4e4c733070b9c6a40b60c4b"],
 ["core/extensions/runner.js", "c97124e4a81299386a9260953cd2cfff35631701742d9ebce6c5a0ee72336828"],
]) assert.equal(createHash("sha256").update(readFileSync(join(sdk, "..", file))).digest("hex"), hash);
const sourceRoot = executorSource();
const root = sourceRoot.root;
process.once("exit", sourceRoot.close);
export const loadExecutor = (file: string) => import(pathToFileURL(join(root!, file)).href);
const [{ fixture }, { startFakeOpenViking }, { createLeadExecutor }, { readLeadHandoffRecords },
 { LeadCompactionHost }, { coldNativeApply, nativeSourceVerifier }, { nativeFixture }, { SessionManager },
 { createLeadScheduler }, { createLeadChecks }] = await Promise.all([
 loadExecutor("tests/helpers/lead-executor-fixture.ts"), loadExecutor("tests/helpers/fake-openviking.ts"),
 loadExecutor("src/v2/lead-executor.ts"), loadExecutor("src/v2/lead-handoff-plan.ts"),
 import("../../server/lead-compaction-host.ts"), import("../../server/lead-compaction-cold.ts"),
 import("./lead-compaction-fixture.ts"), import("../../server/lead-compaction-runtime.ts"),
 import("../../server/lead-compaction-scheduler.ts"), import("../../server/lead-compaction-checks.ts"),
]);
export async function acceptanceFixture(cold = false, shape?: "small" | "protected", intercept?: (request: any) => any,
 setup?: (fixture: any) => void) {
 const dir = mkdtempSync(join(tmpdir(), "joined-lead-acceptance-"));
 const server = await startFakeOpenViking({ unknownRead: "404", intercept });
 const f = fixture(dir, server.baseUrl);
 if (shape) {
  const original = readFileSync(f.fence().source, "utf8");
  writeFileSync(f.fence().source, shape === "small" ? original.replaceAll("x".repeat(40000), "x")
   : original.replace('"type":"message"', '"type":"message","protected":true'));
 }
 // Plant native identities, tool groups and prior notes before any cached SDK host exists.
 setup?.(f);
 const config = { ...f.config, openVikingRoot: root };
 // The existing real SDK factory installs a counting, throwing model transport. No bodies read.
 const native = await nativeFixture();
 let tokens: number | undefined = 200000;
 let stale = false;
 let lostAck = false;
 const progress: any[] = [];
 let executor: any;
 const host = new LeadCompactionHost({
  resolveHome: id => id === f.fence().sessionId ? { source: f.fence().source, role: "ops", bindingEpoch: 1 } : undefined,
  busy: () => false, invalidate: () => {}, coldApply: coldNativeApply(config),
  verifySource: nativeSourceVerifier(config),
  reconstruct: async (source, previous) => { previous.dispose(); return native.create(SessionManager.open(source)); },
  acknowledge: async (prepared, result) => {
   if (lostAck) { lostAck = false; throw new Error("external-lost-ack"); }
   await executor.acknowledge(prepared, result);
  },
 });
 const issuedFences: any[] = [];
 const issueTicket = host.issueTicket.bind(host);
 host.issueTicket = verified => {
  const ticket = issueTicket(verified);
  issuedFences.push({ ...verified.fence });
  return ticket;
 };
 const session = cold ? undefined : await native.create(SessionManager.open(f.fence().source));
 if (session) host.attach(session);
 const makeExecutor = () => createLeadExecutor(config, host, {
  observation: () => ({ checkpoint: f.fence().checkpoint, usage: tokens === undefined ? undefined : {
   tokens, mutationRevision: stale ? -1 : host.captureFence(f.fence().sessionId).mutationRevision,
  }}), progress: (s: any) => progress.push(s),
 });
 executor = makeExecutor();
 const apply = async (ticket: any) => {
  const status = await host.tryApply(ticket);
  if (status.errorCode === "native-recovery-required") await host.recover(f.fence().sessionId);
  return status;
 };
 const scheduler = createLeadScheduler({
  discovery: { enumerateCanonicalHomes: () => [{ sessionId: f.fence().sessionId, role: "ops" }] },
  checks: createLeadChecks(host, {
   prepare: fence => executor.prepare(fence), resume: (id, hash) => executor.resume(id, hash),
   acknowledge: (prepared, result) => executor.acknowledge(prepared, result),
  }), publish: () => {},
 });
 return {
  f, config, host, session, scheduler, server, progress, apply, issuedFences,
  executor: () => executor,
  restartExecutor: async () => { await executor.close(); executor = makeExecutor(); },
  usage: (value: number | undefined, old = false) => { tokens = value; stale = old; },
  loseAck: () => { lostAck = true; },
  records: () => readLeadHandoffRecords(config.planPath),
  journal: () => existsSync(config.planPath) ? readFileSync(config.planPath, "utf8") : "",
  entries: () => SessionManager.open(f.fence().source).getEntries(),
  modelCalls: native.modelCalls,
  close: async () => {
   await executor.close();
   const file = host.admission.file(f.fence().source);
   host.admission.owned(file, () => file.session?.dispose());
   native.close(); await server.close(); rmSync(dir, { recursive: true, force: true });
  },
 };
}
