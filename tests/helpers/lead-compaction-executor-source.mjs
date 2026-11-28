// External dependency mount only: never installs into or edits either source repository.
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
export function executorSource() {
 const source = process.env.PI_OPENVIKING_ROOT;
 assert.ok(source && isAbsolute(source), "PI_OPENVIKING_ROOT must explicitly name the OV worktree");
 const dependencies = process.env.PI_OPENVIKING_DEPENDENCIES;
 if (!dependencies) return { root: source, mirrored: false, close() {} };
 assert.ok(isAbsolute(dependencies), "explicit absolute dependency directory required");
 const root = mkdtempSync(join(tmpdir(), "lead-executor-source-"));
 const close = () => rmSync(root, { recursive: true, force: true });
 try {
  cpSync(join(source, "src"), join(root, "src"), { recursive: true });
  cpSync(join(source, "tests", "helpers"), join(root, "tests", "helpers"), { recursive: true });
  cpSync(join(source, "package.json"), join(root, "package.json"));
  symlinkSync(dependencies, join(root, "node_modules"), "dir");
  return { root, mirrored: true, close };
 } catch (error) { close(); throw error; }
}
