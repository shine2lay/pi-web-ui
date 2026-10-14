import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { FilesService } from "../../server/files-service.js";
import type { ServerMessage } from "../../server/protocol.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
	for (const cleanup of cleanups.splice(0)) cleanup();
});

function service() {
	const cwd = mkdtempSync(join(tmpdir(), "file-correlation-"));
	const replies: ServerMessage[] = [];
	const svc = new FilesService({
		emit: (m) => void replies.push(m),
		getCwd: () => cwd,
		getActiveCwd: () => cwd,
		isDisposed: () => false,
	});
	cleanups.push(() => {
		svc.unwatchDir();
		rmSync(cwd, { recursive: true, force: true });
	});
	return { svc, cwd, replies };
}

describe("file-list-correlation: optional short opaque echo", () => {
	it("keeps an untagged caller's complete serialized root reply exactly unchanged", async () => {
		const { svc, cwd, replies } = service();
		await svc.listFiles();
		expect(replies).toHaveLength(1);
		expect(JSON.stringify(replies[0])).toBe(
			JSON.stringify({
				type: "files",
				path: "",
				parent: dirname(cwd).split("\\").join("/"),
				entries: [],
				truncated: false,
			}),
		);
	});
	it.each(["relative", "absolute", "machine"])(
		"echoes unchanged in the %s branch and leaves untagged bytes unchanged",
		async (branch) => {
			const { svc, cwd, replies } = service();
			const path = branch === "relative" ? "" : branch === "absolute" ? cwd : "@root";
			await svc.listFiles(path);
			const legacy = replies.filter((m) => m.type === "files").at(-1)!;
			expect(Object.hasOwn(legacy, "requestId")).toBe(false);
			const wire = JSON.stringify(legacy);
			const token = "opaque-window-α:17";
			await svc.listFiles(path, token);
			const tagged = replies.filter((m) => m.type === "files").at(-1)!;
			expect(tagged).toHaveProperty("requestId", token);
			const { requestId: _token, ...withoutToken } = tagged as typeof tagged & { requestId: string };
			expect(JSON.stringify(withoutToken)).toBe(wire);
			await svc.listFiles(path);
			expect(JSON.stringify(replies.filter((m) => m.type === "files").at(-1))).toBe(wire);
		},
	);

	it("accepts the 64-character boundary and rejects oversized or non-string tokens without reflecting them", async () => {
		const { svc, replies } = service();
		await svc.listFiles("", "x".repeat(64));
		expect(replies.at(-1)).toHaveProperty("requestId", "x".repeat(64));
		for (const invalid of ["x".repeat(65), 17, null, {}, []]) {
			replies.length = 0;
			await svc.listFiles("", invalid as string);
			expect(replies).toHaveLength(1);
			expect(replies[0]).toMatchObject({ type: "notice", level: "error" });
			expect(JSON.stringify(replies)).not.toContain("x".repeat(65));
			expect(replies.some((m) => m.type === "files")).toBe(false);
		}
	});

	it("threads only the optional argument through the router and both engine delegates", () => {
		const source = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
		expect(source("server/index.ts")).toContain("void cs.listFiles(msg.path, msg.requestId)");
		for (const file of ["server/agent-service.ts", "server/dsh/dsh-agent-service.ts"]) {
			expect(source(file)).toContain("this.files.listFiles(relPath, requestId)");
		}
	});
});
