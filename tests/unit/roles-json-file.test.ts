// The Roles feed's small JSON files (the 6 am report's runs, the scheduler's jobs: server/roles-overview.ts
// JsonFile) are read as the registry's log is (server/state-file-read.ts; Security's note on 25db5d49):
// only a regular file, never waited on, never past 8 MiB.
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync, truncateSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { JSON_FILE_MAX, JsonFile } from "../../server/roles-overview.js";

let dir = "";
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "roles-json-file-"));
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

const reader = (file: string) =>
	new JsonFile<unknown>(
		() => file,
		(raw) => raw,
		"empty",
	);

describe("JsonFile", () => {
	it("reads the file, and again only when it changed", async () => {
		const file = join(dir, "jobs.json");
		writeFileSync(file, JSON.stringify({ jobs: [1] }));
		utimesSync(file, 1000, 1000);
		const r = reader(file);
		const first = await r.get();
		expect(first).toEqual({ jobs: [1] });
		expect(await r.get()).toBe(first);
		writeFileSync(file, JSON.stringify({ jobs: [1, 2] }));
		utimesSync(file, 2000, 2000);
		expect(await r.get()).toEqual({ jobs: [1, 2] });
	});

	it("no file, a folder, or text that isn't JSON: empty", async () => {
		expect(await reader(join(dir, "missing.json")).get()).toBe("empty");
		expect(await reader(dir).get()).toBe("empty");
		const file = join(dir, "bad.json");
		writeFileSync(file, "{not json");
		expect(await reader(file).get()).toBe("empty");
	});

	it("a FIFO in the file's place reads as empty at once, never waited on", async () => {
		const file = join(dir, "jobs.json");
		execFileSync("mkfifo", [file]);
		expect(await reader(file).get()).toBe("empty");
	});

	it("a link to a device is refused, never read; a link to a regular file is read", async () => {
		const dev = join(dir, "dev.json");
		symlinkSync("/dev/zero", dev);
		expect(await reader(dev).get()).toBe("empty");
		const real = join(dir, "real.json");
		writeFileSync(real, "[3]");
		const link = join(dir, "link.json");
		symlinkSync(real, link);
		expect(await reader(link).get()).toEqual([3]);
	});

	it("over 8 MiB: empty, without reading it", async () => {
		const file = join(dir, "big.json");
		writeFileSync(file, "[]");
		truncateSync(file, JSON_FILE_MAX + 1);
		expect(await reader(file).get()).toBe("empty");
	});
});
