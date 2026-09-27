/**
 * Unit tests never use the real pi folders, even when vitest is run directly (not through
 * scripts/check.sh, which runs sealed). A test that makes a pi session without naming a folder
 * (e.g. SessionManager.create(cwd)) would otherwise write into the real ~/.pi/agent/sessions, and
 * server modules default to the real ~/.pi-web-ui. Each test file gets its own temp folders, removed
 * after it. Inside a sealed run (scripts/sealed.sh) the folders are temp ones already.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "vitest";

if (!process.env.PI_SEALED) {
	const root = mkdtempSync(join(tmpdir(), "pi-unit-"));
	process.env.PI_CODING_AGENT_DIR = join(root, "agent");
	process.env.PI_WEB_DATA_DIR = join(root, "web-data");
	afterAll(() => rmSync(root, { recursive: true, force: true }));
}
