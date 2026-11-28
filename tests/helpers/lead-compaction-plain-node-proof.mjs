// Hypothesis: Node 22's native TS loader can execute the E worker dependency graph
// without tsx inherited from the builder. A worker import error falsifies deployment readiness.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { executorSource } from "./lead-compaction-executor-source.mjs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

if (process.argv.includes("--child")) {
 let dir, source, server, transport;
 let stage = "bootstrap";
 try {
  assert.equal(process.execArgv.length, 0, "plain Node child must not inherit loaders");
  assert.equal(process.env.NODE_OPTIONS, undefined);
  assert.equal(process.versions.node.split(".")[0], "22");
  source = executorSource();
  const { root } = source;
  const load = file => import(pathToFileURL(join(root, file)).href);
  stage = "fixture-import";
  const { fixture } = await load("tests/helpers/lead-executor-fixture.ts");
  const { startFakeOpenViking } = await load("tests/helpers/fake-openviking.ts");
  dir = mkdtempSync(join(tmpdir(), "lead-plain-node-"));
  server = await startFakeOpenViking({ unknownRead: "404" });
  const f = fixture(dir, server.baseUrl);
  stage = "transport-import";
  const { createLeadExecutorTransport } = await load("src/v2/lead-executor-transport.ts");
  transport = createLeadExecutorTransport(f.config);
  stage = "worker-prepare";
  const prepared = await transport.prepare(f.fence());
  assert.ok(prepared.prepared, "canonical fixture must prepare a real plan");
  stage = "worker-resume-archive-readback";
  const resumed = await transport.resume(prepared.prepared.planId, prepared.prepared.planHash, f.fence());
  assert.ok(resumed.commit, "canonical archive/readback must yield a commit");
  console.log(JSON.stringify({ result: "PASS", stage, node: process.versions.node,
   execArgvCount: process.execArgv.length, privateDependencyMount: source.mirrored, prepared: !!prepared.prepared,
   commitPrepared: !!resumed.commit, archiveObjects: server.store.size }));
 } catch (error) {
  // Never print arbitrary worker messages, source excerpts, transcript or transport bodies.
  console.log(JSON.stringify({ result: "FAIL", stage, node: process.versions.node,
   errorCode: typeof error?.code === "string" && /^[A-Z_0-9]+$/.test(error.code) ? error.code : "STAGE_ASSERTION_OR_RUNTIME_ERROR",
   errorType: error?.name === "SyntaxError" ? "SyntaxError" : "Error",
   missingModule: error?.code === "ERR_MODULE_NOT_FOUND"
    ? String(error.message).match(/Cannot find (?:package|module) '([^']+)'/)?.[1] : undefined,
   importedFrom: error?.code === "ERR_MODULE_NOT_FOUND"
    ? String(error.message).match(/ imported from ([^\n]+)/)?.[1] : undefined }));
  process.exitCode = 1;
 } finally {
  await transport?.close();
  await server?.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
  source?.close();
 }
} else {
 const env = { ...process.env };
 delete env.NODE_OPTIONS;
 delete env.TSX_TSCONFIG_PATH;
 delete env.TSX_DISABLE_CACHE;
 // No inherited execArgv, --import, or loader; workers inherit this clean process.
 const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "--child"], {
  env, stdio: ["ignore", "pipe", "ignore"],
 });
 child.stdout.pipe(process.stdout);
 child.once("error", () => { process.exitCode = 1; });
 child.once("exit", code => { process.exitCode = code ?? 1; });
}
