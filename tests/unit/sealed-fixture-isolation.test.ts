import { basename, dirname, join } from "node:path";
import { homedir, tmpdir } from "node:os";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { expect, it } from "vitest";

it("each test file owns disposable pi folders even inside a shared sealed run", () => {
	const agent = getAgentDir();
	const root = dirname(agent);
	expect(agent).not.toBe(join(homedir(), ".pi", "agent"));
	expect(dirname(root)).toBe(tmpdir());
	expect(basename(root)).toMatch(/^pi-unit-/);
	expect(process.env.PI_WEB_DATA_DIR).toBe(join(root, "web-data"));
});
