/**
 * Unit tests never use the real pi folders, even when vitest is run directly (not through
 * scripts/check.sh, which runs sealed). A test that makes a pi session without naming a folder
 * (e.g. SessionManager.create(cwd)) would otherwise write into the real ~/.pi/agent/sessions, and
 * server modules default to the real ~/.pi-web-ui. Each test file gets its own temp folders, removed
 * after it. A sealed run also needs this per-file isolation: its ten workers otherwise share
 * one disposable agent folder, and one suite's cleanup deletes another suite's active fixtures.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "vitest";

const root = mkdtempSync(join(tmpdir(), "pi-unit-"));
process.env.PI_CODING_AGENT_DIR = join(root, "agent");
process.env.PI_WEB_DATA_DIR = join(root, "web-data");
afterAll(() => rmSync(root, { recursive: true, force: true }));
